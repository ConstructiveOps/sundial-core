/**
 * handler.js — Sundial Budget Lambda entry point.
 *
 * Two ways in, one code path:
 *   1. API Gateway (portal "Recalculate Budget" button):
 *      POST /projects/{recordId}/budget/recalc  -> synchronous, returns computed outputs
 *   2. Sundial_Budget_Recalc__e platform event, relayed via EventBridge (and/or an
 *      SQS-wrapped envelope) from the field-change record-triggered Flow.
 *
 * Flow: read inputs from Salesforce -> calculate -> upload workbook snapshot to
 *       S3 SUNDIAL/{recordId}/ -> PATCH output + status fields back.
 * The Dropbox mirror + XFiles Pro pick the file up from S3 through the existing sync.
 *
 * SALESFORCE ACCESS is the org-standard path: lib/salesforce.js (Connected App JWT
 * bearer flow for the integration user, private key from Secrets Manager, module-
 * scope token cache). There is NO jsforce and no second SF client — reads use
 * sfQuery, the writeback uses the shared sfUpdateRecord. Same pattern as
 * sundial-acumatica-push / sundial-sf-update.
 *
 * NOTE (incoming auth): the API Gateway button path is authorized in Task 2 by
 * verifying the caller's Supabase token (resolveIdentity), the same as the other
 * portal endpoints. This function is not yet wired to a public route; the platform-
 * event path is internal. See docs/api-endpoints.md when the route is added.
 */
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { sfQuery, soqlEscapeString, sfUpdateRecord } from "../../lib/salesforce.js";
import { resolveIdentity } from "../../lib/identity.js";
import {
  corsHeaders,
  normalizeHeaders,
  jsonResponse,
  mapIdentityError,
  parseJsonBody,
  httpMethod,
} from "../../lib/http.js";
import { getSupabaseClient } from "../../lib/supabase.js";
import { registerFileMetadata } from "../../lib/file-access.js";
// budgetCalc.js / budgetWorkbook.js are CommonJS (pinned calc + workbook writer);
// esbuild provides the named-import interop when bundling.
import { calculateBudget } from "./budgetCalc.js";
import { buildWorkbook, snapshotKey } from "./budgetWorkbook.js";

const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const s3 = new S3Client({});
const BUCKET = process.env.S3_BUCKET || "sfsolproj";
const SF_OBJECT = "Sundial_Solar__c";

// Every input field the calculator reads (kept in one list so the SOQL stays honest)
// Every adder base that carries Price + Qty (§4a + the pre-existing catalog).
// Order mirrors the REVISED sheet's row order, so a diff against the workbook reads
// straight down.
const ADDER_BASES = [
  "Sub_Panel", "Derate", "Heat_Detector", "Upgrade_225", "Upgrade_400",
  "Upgrade_225_UG", "Gateway3", "Site_Audit", "Travel",
  "Conduit_Attic", "Flat_Roof", "Roof_Tile",
  "Structural", "Bird_Blocking",
  "Small_System_10_12", "Small_System_13_15",
  "Software_Fee", "Active_Monitoring", "LR_Battery_Warranty", "Referral_Fee",
];

// The 12 adders that have a COST field (§4c). Site Audit and Travel are labor-only;
// the pass-through rows (Software / Active Monitoring / LR Warranty / Referral) cost
// exactly their price; the small systems are revenue-only (D14). None of those get one.
const ADDER_COST_BASES = [
  "Sub_Panel", "Derate", "Heat_Detector", "Upgrade_225", "Upgrade_400",
  "Upgrade_225_UG", "Gateway3", "Structural",
  "Conduit_Attic", "Flat_Roof", "Roof_Tile", "Bird_Blocking",
];

const INPUT_FIELDS = [
  "Name", "Project_Name__c", "Panel_Type__c", "Contract_Amount__c", "Dealer_Fee__c",
  "System_Size__c", "Module_STC_Wattage__c", "Module_Cost_Per_Watt__c",
  // Commissions — D19 redline model. The REP commission arrives in DOLLARS from the
  // Commission_Total__c formula field and is routed by the sales company; the two
  // rep-PPW inputs (Sales_Rep_Commission_PPW__c, Internal_Rep_Commission_PPW__c) are
  // RETIRED and deliberately NOT selected here. They still exist on the object for
  // history — do not re-add them expecting the calc to read them, because it does not.
  //
  // FLS: the integration user needs READ on Commission_Total__c. Without it SOQL
  // silently omits the field and the calc throws COMMISSION_TOTAL_UNAVAILABLE, which is
  // the intended failure — a missing grant must not read as a $0 commission.
  "Commission_Total__c", "Sales_Company_Harmon_Solar_or_Third__c",
  // Mgr + Overhead are still stored separately and summed by the calc into one SLMC
  // line (D10) — the Acumatica attribute sync splits them apart again.
  "Sales_Mgr_Commission_PPW__c", "Overhead_Commission_PPW__c",
  "Geo_Commission_Amount__c", "Commission_Burden_Rate__c",
  // D17: the setter lives on the CUSTOMER and is deliberately not mirrored onto Solar,
  // so it is read through the relationship. A setter added to the Customer after the
  // project was created therefore lands in the next recalc with no backfill.
  "Sundial_Customer__r.Setter__c",
  // DC rebate toggle (D2), read through the same relationship. The election lives on
  // the CUSTOMER picklist Domestic_Content_Eligible__c and drives BOTH this rebate and
  // the RS/RSDC Acumatica template (sundial-acumatica-push). Solar's free-text
  // Domestic_Content__c is retired as an integration input and deliberately NOT
  // selected — one field, one answer, so template and rebate cannot disagree.
  "Sundial_Customer__r.Domestic_Content_Eligible__c",
  "Combiner_Unit_Cost__c", "Combiner_Qty__c",
  // Gateway_* is REUSED for the Tesla Expansion Pack (§3) — relabel pending.
  "Gateway_Unit_Cost__c", "Gateway_Qty__c",
  "Microinverter_Unit_Cost__c", "Microinverter_Qty__c", "Battery_Unit_Cost__c", "Battery_Qty__c",
  // Storage PRICE fields (D19 amendment). Batteries and Tesla expansion packs sell
  // outside the redline x watts model, so their price is part of the adder total the
  // commission deducts. The COST side above is unaffected. Note the pairing the calc
  // uses: Tesla_Expansion_Pack_Unit_Price__c x Gateway_Qty__c, because Gateway_* is the
  // expansion-pack quantity on this object (§3 reuse, same as the Salesforce formula).
  //
  // FLS: both need Read for the integration user. Unlike Commission_Total__c there is no
  // loud failure if a grant is missing - SOQL omits the field, the price reads 0, and the
  // adder total quietly understates. The describe gate in
  // scripts/probe-battery-adder-fields.mjs is what catches that.
  "Battery_Unit_Price__c", "Tesla_Expansion_Pack_Unit_Price__c",
  "BOS_Solar_Cost_Per_Watt__c", "BOS_Electrical_Cost_Per_Watt__c",
  "Roof_Material_Cost_Per_Pen__c", "Penetrations_Per_Module__c",
  "Blended_Labor_Rate__c", "Labor_Burden_Rate__c", "Audit_Hours__c", "QA_Commissioning_Hours__c",
  "Roofing_Cost_Per_Penetration__c", "Roofing_Pens_Per_Module__c", "Install_Hours_Per_Module__c",
  "Battery_Labor_Rate__c", "Battery_Install_Hours__c",
  "Material_Other_Cost__c", "Constructive_Ops_Fee__c", "Permit_Pass_Through_Cost__c",
  ...ADDER_BASES.flatMap((b) => [`Adder_${b}_Price__c`, `Adder_${b}_Qty__c`]),
  ...ADDER_COST_BASES.map((b) => `Adder_${b}_Cost__c`),
  ...[1, 2, 3, 4, 5].flatMap((n) => [`NS_Adder_${n}_Description__c`, `NS_Adder_${n}_Markup_Percent__c`, `NS_Adder_${n}_Material_Cost__c`, `NS_Adder_${n}_Labor_Hours__c`]),
];

async function recalcOne(recordId, source, tenantId) {
  // Read the single record's input fields (org-standard SF token via lib/salesforce.js).
  // TENANT SCOPING: the portal button path passes the caller's tenantId and we
  // constrain by Client__c, so a user can only recalc their own tenant's record.
  // The internal event path passes no tenantId and reads by Id (integration trust).
  // Client__c is selected either way so the snapshot metadata carries the tenant.
  const tenantFilter = tenantId
    ? ` AND Client__c = '${soqlEscapeString(tenantId)}'`
    : "";
  const soql =
    `SELECT ${INPUT_FIELDS.join(", ")}, Client__c FROM ${SF_OBJECT} ` +
    `WHERE Id = '${soqlEscapeString(recordId)}'${tenantFilter} LIMIT 1`;
  const records = await sfQuery(soql);
  if (!records || records.length === 0) {
    const err = new Error(`Sundial_Solar__c ${recordId} not found`);
    err.code = "RECORD_NOT_FOUND";
    throw err;
  }
  const rec = records[0];

  // Pinned calculation (budgetCalc.js) — unchanged. `fields` is the output field
  // map written back to Salesforce; `cells` fills the workbook snapshot.
  const { fields, cells } = calculateBudget(rec);

  const now = new Date();
  const key = snapshotKey(recordId, rec.Project_Name__c || rec.Name, now);
  const buffer = await buildWorkbook(cells, { recordId, generatedAt: now.toISOString() });

  await s3.send(new PutObjectCommand({
    Bucket: BUCKET, Key: key, Body: buffer, ContentType: XLSX_MIME,
  }));

  // One PATCH: output fields + control fields (same write-back pattern Layer 1 used).
  await sfUpdateRecord(SF_OBJECT, recordId, {
    ...fields,
    Budget_Last_Calculated__c: now.toISOString(),
    Budget_Calc_Status__c: "Calculated",
    Budget_Calc_Error__c: null,
    Latest_Budget_File_Path__c: key,
  });

  // Task 4: register the snapshot in Supabase file metadata (category "Budget").
  // BEST-EFFORT — the file is already in S3 (and the current S3-backed Files tab
  // already shows it), so a metadata failure must NOT fail the recalc. tenant_id
  // is the record's Client__c; uploader is the system/integration.
  try {
    const supabase = await getSupabaseClient();
    await registerFileMetadata(supabase, {
      s3Key: key,
      fileName: key.slice(key.lastIndexOf("/") + 1),
      tenantId: rec.Client__c ?? null,
      sfRecordId: recordId,
      sfObjectType: SF_OBJECT,
      uploadedByUserId: null,
      uploadedByUserName: "Sundial Budget (system)",
      fileSizeBytes: buffer.byteLength,
      mimeType: XLSX_MIME,
      category: "Budget",
      subfolder: null,
    });
  } catch (e) {
    console.error(
      "Budget snapshot metadata registration failed (non-fatal)",
      recordId,
      e?.message || e
    );
  }

  return { recordId, source, s3Key: key, fields };
}

// Best-effort status flip to Error so the portal never shows a stuck Pending.
async function markError(recordId, err) {
  try {
    await sfUpdateRecord(SF_OBJECT, recordId, {
      Budget_Calc_Status__c: "Error",
      Budget_Calc_Error__c: String(err?.message || err).slice(0, 255),
    });
  } catch (e2) {
    console.error("Status writeback failed", recordId, e2?.message || e2);
  }
}

export const handler = async (event) => {
  const isHttp = !!(event.httpMethod || event.requestContext);

  // ---- API Gateway (portal "Recalculate Budget" button) ---------------------
  // Authenticated + tenant-scoped, same as the other portal endpoints.
  if (isHttp) {
    const method = httpMethod(event);
    const headers = normalizeHeaders(event?.headers);
    const cors = corsHeaders(headers["origin"]);

    if (method === "OPTIONS") return { statusCode: 204, headers: cors, body: "" };
    if (method !== "POST") {
      return jsonResponse(405, cors, {
        error: "method_not_allowed",
        code: "METHOD_NOT_ALLOWED",
      });
    }

    // Supabase JWT verification -> tenant. tenant comes ONLY from the token.
    let identity;
    try {
      identity = await resolveIdentity(headers["authorization"]);
    } catch (err) {
      const m = mapIdentityError(err?.code);
      if (m) return jsonResponse(m.status, cors, m.body);
      throw err;
    }
    const tenantId = identity.tenantId;
    if (!tenantId) {
      return jsonResponse(403, cors, { error: "no_tenant", code: "NO_TENANT" });
    }

    const body = parseJsonBody(event);
    const recordId =
      event.pathParameters?.recordId || (body.ok ? body.data.recordId : null);
    if (!recordId) {
      return jsonResponse(400, cors, {
        error: "missing_record_id",
        code: "MISSING_RECORD_ID",
      });
    }

    try {
      const result = await recalcOne(recordId, "Button", tenantId);
      return jsonResponse(200, cors, result);
    } catch (err) {
      // A missing/cross-tenant record is indistinguishable -> 404 (no status write).
      if (err?.code === "RECORD_NOT_FOUND") {
        return jsonResponse(404, cors, {
          error: "not_found",
          code: "RECORD_NOT_FOUND",
        });
      }
      // Bad DATA, not a broken calc — the record is missing something a human has to
      // supply, and the message says exactly what. markError still writes it to
      // Budget_Calc_Error__c, but a 500/"server_error" would send the person who
      // pressed the button looking for an outage instead of at the empty field.
      //
      // This is the common case now, not an edge: D19 rejects a blank sales company,
      // and most Solar records do not have one set yet.
      if (err?.name === "BudgetInputError") {
        await markError(recordId, err);
        return jsonResponse(422, cors, {
          error: "invalid_input",
          code: err.code || "BUDGET_INPUT_ERROR",
          message: err.message,
        });
      }
      console.error(
        "Budget recalc failed (button)",
        recordId,
        err?.message || err,
        err?.sfBody ? `SF: ${err.sfBody}` : ""
      );
      await markError(recordId, err);
      return jsonResponse(500, cors, { error: "server_error" });
    }
  }

  // ---- Platform-event relay (EventBridge and/or SQS-wrapped) ----------------
  // Internal path: no user token; the event was published by a tenant's Flow.
  const jobs = [];
  if (Array.isArray(event.Records)) {
    for (const r of event.Records) {
      let payload = {};
      try {
        payload = JSON.parse(r.body);
      } catch {
        /* non-JSON body -> skipped below (no recordId) */
      }
      const p = payload.detail?.payload || payload.payload || payload;
      jobs.push({ recordId: p.Record_Id__c, source: p.Source__c || "FieldTrigger" });
    }
  } else if (event.detail) {
    jobs.push({
      recordId: event.detail.payload?.Record_Id__c,
      source: event.detail.payload?.Source__c || "FieldTrigger",
    });
  }

  const results = [];
  for (const j of jobs.filter((x) => x.recordId)) {
    try {
      results.push(await recalcOne(j.recordId, j.source)); // no tenantId -> integration trust
    } catch (err) {
      console.error(
        "Budget recalc failed",
        j.recordId,
        err?.message || err,
        err?.sfBody ? `SF: ${err.sfBody}` : ""
      );
      await markError(j.recordId, err);
    }
  }
  return { processed: results.length };
};
