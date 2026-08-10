// sundial-acumatica-budget-push — Acumatica ProjectBudget population (Layer 2).
//
// STATUS: READ + RECONCILE SCAFFOLDING ONLY. The GUID-write path is still hard-
// guarded off (see writeBudgetLines) — but the DATA BLOCKERS ARE RESOLVED.
//
// Gate 5a (data) — DONE 2026-08-07 via a live harvest of the canonical sandbox
// project R269999 (customer C001311112; see scratchpad/R269999-reconcile.json and
// docs/integrations/acumatica-budget-push.md):
//   (A) InventoryIDs harvested. The sheet's old "AccountGroup" column was actually
//       the InventoryID; the REAL AccountGroup is BILLING/LABOR/OTHER/MATERIAL.
//       MAPPING_ROWS below now carry the full 4-part key verbatim from the scaffold.
//   (B) Geo commission -> APPT COM (LABOR · SALESCOMM · Expense), confirmed from
//       role semantics. Harmon finance sign-off still required before the first
//       PRODUCTION write (PENDING_HARMON_SIGNOFF).
//
// Income is TWO lines — BALANCE (Balance of Contract) and GENM/BILLING (Solar
// Material), both Type=Income, both InventoryID <N/A>. There is NO "BILL" task.
//
// WHAT THIS DOES NOW (safe, read-only): given a Salesforce Sundial_Solar__c record
// (or an Acumatica ProjectID), read the EXISTING scaffolded ProjectBudget lines
// (GET $filter, URL-encoded) and return them keyed by the full natural key + GUID
// `id` — the reconciliation table. It does NOT create, update, or delete anything.
//
// The eventual write path (Layer 2, after Gate 5b sign-off): match each mapping row
// to EXACTLY ONE existing line by ProjectTaskID+AccountGroup+InventoryID+Type, then
// PUT /ProjectBudget/{id} updating OriginalBudgetedAmount (+ OriginalBudgetedQty /
// UOM=HOUR on labor lines). Updates by GUID — never key-upsert, never insert.

import { getAcumaticaEntity, putAcumaticaEntity } from "../../lib/acumatica.js";
import { sfQuery, soqlEscapeString, sfUpdateRecord } from "../../lib/salesforce.js";
import { resolveIdentity } from "../../lib/identity.js";
import {
  corsHeaders,
  normalizeHeaders,
  jsonResponse,
  mapIdentityError,
  httpMethod,
} from "../../lib/http.js";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";

const PROJECT_BUDGET_ENTITY = "ProjectBudget";
const SOLAR_SF_OBJECT = "Sundial_Solar__c";

// The portal "Update Budget" button hits POST /projects/{recordId}/budget/push,
// which returns 202 immediately and hands the work to an async self-invoke of THIS
// same function (InvocationType Event). The runtime always sets these two env vars.
const SELF_FUNCTION_NAME = process.env.AWS_LAMBDA_FUNCTION_NAME;
const lambda = new LambdaClient({ region: process.env.AWS_REGION || "us-west-1" });

// --- The mapping rows (Acumatica Mapping tab, RECONCILED to the live R269999
// scaffold on 2026-08-07) ---------------------------------------------------
// Each row carries the TRUE 4-part natural key: taskId + accountGroup + inventoryId
// + type, taken VERBATIM from the harvested ProjectBudget lines
// (scratchpad/R269999-reconcile.json; table in docs/integrations/acumatica-budget-push.md).
//
// KEY CORRECTION: the sheet's old "AccountGroup" column actually held the
// InventoryID. The REAL AccountGroup is BILLING / LABOR / OTHER / MATERIAL — so the
// commission lines are AccountGroup=LABOR with InventoryID=SALESCOMM (NOT
// AccountGroup=SALESCOMM as the sheet implied). InventoryID is what separates the
// two BURDENEXR lines (SALESCOMM commission-burden vs RESIDENTAL labor-burden).
//
// (!) "RESIDENTAL" IS THE ACUMATICA-SIDE SPELLING (missing the second "I"). It is
// intentionally misspelled here to match the live InventoryID EXACTLY — DO NOT
// "correct" it to RESIDENTIAL, or every RESIDENTAL line will fail to match.
//
// "<N/A>" is a LITERAL InventoryID value on those lines (not null/absent). The
// matcher compares it as the literal string, so it must stay exactly "<N/A>".
//
// 18 rows vs. the sheet's 17: income is split into TWO code rows (BALANCE + GENM/
// BILLING). Intentional SUMS into one scaffold line: the two SLPC rows (Sales Rep +
// Overhead) and the three GENO rows (Other Material + CO Fee + Permit).

// The one item still needing a human YES before the FIRST production write (Gate 5b):
export const PENDING_HARMON_SIGNOFF = {
  // Geo commission -> APPT COM (LABOR · SALESCOMM · Expense). Confirmed from role
  // semantics (appointment-setter flat commission); the code + full key are wired
  // into MAPPING_ROWS below, but Harmon finance must sign off before the first
  // PRODUCTION ProjectBudget push.
  geoCommissionTaskId: "APPT COM",
};

export const MAPPING_ROWS = [
  // line, taskId, accountGroup, type, inventoryId, amountField, hoursField, note.
  // Full 4-part key verbatim from the R269999 harvest.
  { line: "Income - Balance of Contract", taskId: "BALANCE", accountGroup: "BILLING", type: "Income", inventoryId: "<N/A>", amountField: "Contract_Amount__c-Total_Material_Budget__c", hoursField: null, note: "Income 1 of 2. BALANCE/BILLING/Income, InventoryID <N/A>. Amount = contract value net of the material billing (which posts to GENM/BILLING) so the two income lines sum to Contract_Amount__c." },
  { line: "Income - Solar Material", taskId: "GENM", accountGroup: "BILLING", type: "Income", inventoryId: "<N/A>", amountField: "Total_Material_Budget__c", hoursField: null, note: "Income 2 of 2. GENM/BILLING/Income — distinct from GENM/MATERIAL cost via AccountGroup+Type. Material billed to the customer at cost (Total_Material_Budget__c, same value as the GENM/MATERIAL expense line)." },
  { line: "Dealer Fee", taskId: "DLR", accountGroup: "OTHER", type: "Expense", inventoryId: "<N/A>", amountField: "Dealer_Fee__c", hoursField: null, note: "DLR/OTHER/<N/A>. Only send when > 0." },
  { line: "Sales Rep Commission", taskId: "SLPC", accountGroup: "LABOR", type: "Expense", inventoryId: "SALESCOMM", amountField: "Sales_Rep_Commission_Amt__c", hoursField: null, note: "Sums with Overhead Commission into the single SLPC/LABOR/SALESCOMM line." },
  { line: "Sales Manager Commission", taskId: "SLMC", accountGroup: "LABOR", type: "Expense", inventoryId: "SALESCOMM", amountField: "Sales_Mgr_Commission_Amt__c", hoursField: null },
  { line: "Geo Commission", taskId: "APPT COM", accountGroup: "LABOR", type: "Expense", inventoryId: "SALESCOMM", amountField: "Geo_Commission_Amount__c", hoursField: null, note: "Confirmed from role semantics (appointment-setter flat commission); Harmon sign-off required before first PRODUCTION push (PENDING_HARMON_SIGNOFF)." },
  { line: "Overhead Commission", taskId: "SLPC", accountGroup: "LABOR", type: "Expense", inventoryId: "SALESCOMM", amountField: "Overhead_Commission_Amt__c", hoursField: null, note: "Sums with Sales Rep Commission into the single SLPC/LABOR/SALESCOMM line." },
  { line: "Commission Burden", taskId: "BURDENEXR", accountGroup: "LABOR", type: "Expense", inventoryId: "SALESCOMM", amountField: "Commission_Burden_Amt__c", hoursField: null, note: "BURDENEXR/LABOR/SALESCOMM — InventoryID SALESCOMM separates it from Labor Burden (RESIDENTAL)." },
  { line: "Audit + QA Labor", taskId: "GENA", accountGroup: "LABOR", type: "Expense", inventoryId: "RESIDENTAL", amountField: "Audit_Labor_Cost__c+QA_Labor_Cost__c", hoursField: "GENA_Hours__c", note: "Labor line GENA/LABOR/RESIDENTAL, UOM=HOUR, qty from GENA_Hours__c. NOT the GENA/OTHER/AUDIT SVCS outside-services line — this is internal employee audit/QA labor." },
  { line: "Roofing Labor", taskId: "ROOFCOM", accountGroup: "LABOR", type: "Expense", inventoryId: "RESIDENTAL", amountField: "Roofing_Labor_Cost__c", hoursField: null },
  { line: "S1 Install Labor", taskId: "S1", accountGroup: "LABOR", type: "Expense", inventoryId: "RESIDENTAL", amountField: "S1_Labor_Cost__c", hoursField: "S1_Hours__c" },
  { line: "S2 Install Labor", taskId: "S2", accountGroup: "LABOR", type: "Expense", inventoryId: "RESIDENTAL", amountField: "S2_Labor_Cost__c", hoursField: "S2_Hours__c" },
  { line: "S3 Labor (Battery + Adders)", taskId: "S3", accountGroup: "LABOR", type: "Expense", inventoryId: "RESIDENTAL", amountField: "S3_Labor_Cost__c", hoursField: "S3_Hours__c" },
  { line: "Labor Burden", taskId: "BURDENEXR", accountGroup: "LABOR", type: "Expense", inventoryId: "RESIDENTAL", amountField: "Total_Labor_Burden_Budget__c", hoursField: null, note: "BURDENEXR/LABOR/RESIDENTAL — InventoryID RESIDENTAL separates it from Commission Burden (SALESCOMM)." },
  { line: "Total Material", taskId: "GENM", accountGroup: "MATERIAL", type: "Expense", inventoryId: "<N/A>", amountField: "Total_Material_Budget__c", hoursField: null },
  { line: "Other Material", taskId: "GENO", accountGroup: "OTHER", type: "Expense", inventoryId: "<N/A>", amountField: "Total_Other_Budget__c", hoursField: null, note: "Sums with CO Fee + Permit into the single GENO/OTHER/<N/A> line." },
  { line: "Constructive Ops Fee", taskId: "GENO", accountGroup: "OTHER", type: "Expense", inventoryId: "<N/A>", amountField: "Constructive_Ops_Fee__c", hoursField: null, note: "Sums into the GENO/OTHER/<N/A> line." },
  { line: "Permit Pass-Through", taskId: "GENO", accountGroup: "OTHER", type: "Expense", inventoryId: "<N/A>", amountField: "Permit_Pass_Through_Cost__c", hoursField: null, note: "Sums into the GENO/OTHER/<N/A> line." },
];

// Unwrap an Acumatica field value ({ value: x } or scalar).
function av(v) {
  return v && typeof v === "object" && "value" in v ? v.value : v;
}

// The full natural key for a ProjectBudget line/mapping row.
export function naturalKey({ taskId, accountGroup, inventoryId, type }) {
  return [taskId ?? "", accountGroup ?? "", inventoryId ?? "", type ?? ""].join(" | ");
}

// Read the existing scaffolded ProjectBudget lines for a ProjectID (read-only).
// $filter is URL-encoded by lib/acumatica.js (getAcumaticaEntity -> URLSearchParams).
export async function readProjectBudgetLines(acumaticaProjectId) {
  const res = await getAcumaticaEntity(PROJECT_BUDGET_ENTITY, {
    $filter: `ProjectID eq '${String(acumaticaProjectId).replace(/'/g, "''")}'`,
  });
  if (!res.ok) {
    const err = new Error(`ProjectBudget read failed (${res.status})`);
    err.acuStatus = res.status;
    throw err;
  }
  const lines = Array.isArray(res.data) ? res.data : [];
  return lines.map((l) => ({
    id: l.id, // GUID — the write path addresses lines by this
    taskId: av(l.ProjectTaskID),
    accountGroup: av(l.AccountGroup),
    inventoryId: av(l.InventoryID),
    type: av(l.Type),
    description: av(l.Description),
    originalBudgetedAmount: av(l.OriginalBudgetedAmount),
    originalBudgetedQty: av(l.OriginalBudgetedQty),
    uom: av(l.UOM),
    key: naturalKey({
      taskId: av(l.ProjectTaskID),
      accountGroup: av(l.AccountGroup),
      inventoryId: av(l.InventoryID),
      type: av(l.Type),
    }),
  }));
}

// Match mapping rows to existing scaffold lines by the FULL natural key
// (ProjectTaskID + AccountGroup + InventoryID + Type). Two rules:
//  - Several mapping rows sharing ONE key (e.g. the GENO adders: Other Material,
//    CO Fee, Permit) SUM into that single scaffold line — never duplicated.
//  - FAIL LOUDLY (never guess, never merge on a partial key): a row missing any
//    key part (especially InventoryID) is flagged; a key matching 0 or >1 lines
//    is flagged. Only a key matching exactly one line is a match.
export function matchMappingToLines(mappingRows, lines) {
  const matched = [];
  const problems = [];

  // Partition out rows we can't key completely (can't match or group them safely).
  const complete = [];
  for (const row of mappingRows) {
    if (
      row.inventoryId == null ||
      row.taskId == null ||
      row.accountGroup == null ||
      row.type == null
    ) {
      problems.push({
        row: row.line,
        reason:
          "mapping row missing a key part (inventoryId/taskId/accountGroup/type) — cannot match uniquely",
      });
    } else {
      complete.push(row);
    }
  }

  // Group complete rows by full key; each group -> exactly one line (amounts summed).
  const groups = new Map();
  for (const row of complete) {
    const k = naturalKey(row);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(row);
  }

  for (const [key, rows] of groups) {
    const hits = lines.filter((l) => l.key === key);
    if (hits.length !== 1) {
      problems.push({
        key,
        count: hits.length,
        rows: rows.map((r) => r.line),
        reason: hits.length === 0 ? "no scaffolded line matched" : "matched multiple lines",
      });
      continue;
    }
    matched.push({
      key,
      lineId: hits[0].id,
      uom: hits[0].uom, // scaffold line UOM; HOUR lines also get an OriginalBudgetedQty
      type: rows[0].type, // Income lines are ALWAYS written (no skip-zero)
      rows: rows.map((r) => r.line),
      summed: rows.length > 1, // multiple mapping rows -> summed into this one line
      amountFields: rows.map((r) => r.amountField).filter(Boolean),
      hoursFields: rows.map((r) => r.hoursField).filter(Boolean),
    });
  }
  return { matched, problems };
}

// --- Budget field resolution ------------------------------------------------
function numOf(v) {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}
function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

// Evaluate a field expression against record values. Supports + and - across field
// names — e.g. "Audit_Labor_Cost__c+QA_Labor_Cost__c" or
// "Contract_Amount__c-Total_Material_Budget__c" (BALANCE income). Field API names
// contain no + or -, so splitting on them is safe. Missing/blank fields count as 0.
function evalFieldExpr(spec, values) {
  let total = 0;
  for (const term of String(spec).match(/[+-]?[^+-]+/g) || []) {
    const t = term.trim();
    if (!t) continue;
    let sign = 1;
    let name = t;
    if (name[0] === "+") name = name.slice(1).trim();
    else if (name[0] === "-") { sign = -1; name = name.slice(1).trim(); }
    total += sign * numOf(values?.[name]);
  }
  return total;
}

// Every distinct Sundial_Solar__c field referenced by MAPPING_ROWS (amount + hours
// sources; +/- expressions split), so a caller can SELECT exactly these.
export function budgetFieldNames() {
  const names = new Set();
  for (const r of MAPPING_ROWS) {
    if (r.amountField)
      for (const f of r.amountField.split(/[+-]/)) {
        const n = f.trim();
        if (n) names.add(n);
      }
    if (r.hoursField) names.add(r.hoursField.trim());
  }
  return [...names];
}

// Sum a list of amount-field specs (each may be an A+B or A-B expression).
function sumFields(fieldSpecs, values) {
  let total = 0;
  for (const spec of fieldSpecs || []) total += evalFieldExpr(spec, values);
  return round2(total);
}

// PUT one ProjectBudget line, with exponential backoff on 429 / 5xx (transient).
// A non-429 4xx is a real rejection — do not retry. Never retries a success.
const WRITE_MAX_ATTEMPTS = 4;
async function putBudgetLineWithRetry(body) {
  let lastStatus = 0;
  let lastText = "";
  for (let attempt = 1; attempt <= WRITE_MAX_ATTEMPTS; attempt++) {
    const res = await putAcumaticaEntity(PROJECT_BUDGET_ENTITY, body);
    if (res.ok) return { ok: true, status: res.status };
    lastStatus = res.status;
    lastText = (res.text || "").slice(0, 300);
    const transient = res.status === 429 || res.status >= 500;
    if (transient && attempt < WRITE_MAX_ATTEMPTS) {
      await new Promise((r) => setTimeout(r, 500 * 2 ** (attempt - 1))); // 0.5s,1s,2s
      continue;
    }
    break;
  }
  return { ok: false, status: lastStatus, text: lastText };
}

// Write the budget outputs onto the project's EXISTING scaffolded ProjectBudget
// lines. Re-reads the scaffold FRESH in this run (guids never cached/stale),
// re-matches, and ABORTS LOUDLY before any PUT on: 0 scaffold lines, any match
// problem (a key hitting ≠ 1 line), or an income line with no amount source.
//
// Per matched group: amount = sum of its amountField(s) (composites split);
// expense lines whose amount is 0 are SKIPPED (left as-is); income lines are ALWAYS
// written. HOUR lines (per the live scaffold UOM) also write OriginalBudgetedQty
// from their hours source. Re-push is SAFE BY CONSTRUCTION — every write is an
// idempotent update-by-GUID of an existing line (no inserts, deterministic values).
//
// dryRun computes every per-line amount/qty and returns them WITHOUT any PUT.
//
// @param {string} acumaticaProjectId
// @param {object} budgetValues - { <Sundial_Solar__c field>: number } (see budgetFieldNames)
// @param {{ dryRun?: boolean }} [opts]
export async function writeBudgetLines(acumaticaProjectId, budgetValues, opts = {}) {
  const { dryRun = false } = opts;

  // 1) FRESH scaffold read — guids come from THIS run only.
  const lines = await readProjectBudgetLines(acumaticaProjectId);
  if (lines.length === 0) {
    return {
      ok: false,
      aborted: "no_scaffolded_lines",
      acumaticaProjectId,
      message: "ProjectBudget returned 0 lines — never create lines from scratch.",
    };
  }

  // 2) Re-match against the fresh read. Any key not matching exactly one line
  //    aborts BEFORE any PUT.
  const { matched, problems } = matchMappingToLines(MAPPING_ROWS, lines);
  if (problems.length > 0) {
    return { ok: false, aborted: "match_problems", acumaticaProjectId, problems };
  }

  // 3) Income lines are always written, so their amount source must exist. Refuse
  //    a real write that would otherwise post 0 to an income line.
  const incomeNoSource = matched
    .filter((g) => g.type === "Income" && g.amountFields.length === 0)
    .map((g) => g.rows.join(" + "));
  if (incomeNoSource.length > 0 && !dryRun) {
    return {
      ok: false,
      aborted: "income_amount_source_unresolved",
      acumaticaProjectId,
      message:
        "Income line(s) have no amountField in MAPPING_ROWS; refusing to write 0 to income. " +
        "Fill the amount source for: " + incomeNoSource.join(", "),
    };
  }

  // 4) Per group: compute, then (dry-run record | PUT).
  const results = [];
  let written = 0;
  let skipped = 0;
  let failed = 0;
  for (const g of matched) {
    const isIncome = g.type === "Income";
    // Write OriginalBudgetedQty only when the line has an actual hours source in the
    // mapping (GENA/S1/S2/S3). HOUR lines with no source (ROOFCOM piece-rate, Labor
    // Burden) get amount only — we never overwrite the scaffold qty with a bogus 0.
    const hasQty = g.uom === "HOUR" && g.hoursFields.length > 0;
    const amount = sumFields(g.amountFields, budgetValues);
    const qty = hasQty ? sumFields(g.hoursFields, budgetValues) : null;
    // "computed" = the amount is DERIVED, not a plain field/sum — i.e. any spec uses
    // subtraction (BALANCE = Contract_Amount__c - Total_Material_Budget__c). Surfaced
    // in dry-run so a reviewer can see which lines are calculated vs. read straight.
    const computed = g.amountFields.some((s) => s.includes("-"));
    const amountExpr = computed ? g.amountFields.join(" + ") : null;

    // Skip-zero: expense lines at 0 are left as-is; income is always written.
    if (!isIncome && amount === 0) {
      skipped++;
      results.push({ key: g.key, lineId: g.lineId, action: "skip_zero", amount: 0, uom: g.uom, type: g.type, rows: g.rows });
      continue;
    }

    const body = { id: g.lineId, OriginalBudgetedAmount: { value: amount } };
    if (hasQty) body.OriginalBudgetedQty = { value: qty };

    if (dryRun) {
      results.push({
        key: g.key, lineId: g.lineId, action: "would_write",
        amount, ...(hasQty ? { qty } : {}), uom: g.uom, type: g.type, rows: g.rows,
        ...(computed ? { computed: true, amountExpr } : {}),
        ...(isIncome && g.amountFields.length === 0 ? { needsAmountSource: true } : {}),
      });
      continue;
    }

    console.log(
      `budget-push PUT ${g.key} guid=${g.lineId} amount=${amount}` +
        (hasQty ? ` qty=${qty}` : "")
    );
    const put = await putBudgetLineWithRetry(body);
    if (put.ok) {
      written++;
      results.push({ key: g.key, lineId: g.lineId, action: "written", amount, ...(hasQty ? { qty } : {}), uom: g.uom, status: put.status });
    } else {
      failed++;
      results.push({ key: g.key, lineId: g.lineId, action: "failed", amount, status: put.status, error: put.text });
    }
  }

  return {
    ok: failed === 0,
    dryRun,
    acumaticaProjectId,
    summary: { matchedGroups: matched.length, written, skipped, failed },
    results,
  };
}

// Resolve an Acumatica ProjectID from a Sundial_Solar__c record id (read-only).
async function projectIdForRecord(recordId) {
  const soql =
    `SELECT Acumatica_Project_ID__c FROM ${SOLAR_SF_OBJECT} ` +
    `WHERE Id = '${soqlEscapeString(recordId)}' LIMIT 1`;
  const rows = await sfQuery(soql);
  return rows && rows.length ? rows[0].Acumatica_Project_ID__c : null;
}

// --- handler: dispatch by invocation shape ---------------------------------
// Ways this Lambda is entered:
//   1. Async worker self-invoke  -> event.__worker === true    (handleWorker)
//   2. Dry-run write (direct)    -> event.dryRunWrite === true (handleDryRunWrite)
//   3. API Gateway HTTP request  -> event.requestContext etc.  (handleHttp)
//   4. Direct payload (reconcile) -> { recordId | acumaticaProjectId } (handleReconcile)
// The reconcile path is UNCHANGED from before; HTTP + worker are the write path.
function isHttpEvent(event) {
  return !!(
    event &&
    (event.requestContext || event.httpMethod || event.routeKey || event.rawPath)
  );
}

export const handler = async (event) => {
  if (event && event.__worker === true) return handleWorker(event);
  if (event && event.dryRunWrite === true) return handleDryRunWrite(event);
  if (isHttpEvent(event)) return handleHttp(event);
  return handleReconcile(event);
};

// --- Dry-run write (direct invoke, READ-ONLY) ------------------------------
// Payload: { dryRunWrite:true, recordId:"<Sundial_Solar__c Id>" } (preferred — pulls
// the record's real budget values), or { dryRunWrite:true, acumaticaProjectId:"R269999" }
// (project only; values default to 0). Computes every per-line amount/qty exactly as a
// real push would and returns them WITHOUT any PUT and WITHOUT any SF write-back. The
// runbook's pre-push check. No gates — it's a read.
async function handleDryRunWrite(event) {
  try {
    let acumaticaProjectId = event.acumaticaProjectId || null;
    let budgetValues = {};
    if (event.recordId) {
      const fields = budgetFieldNames();
      const soql =
        `SELECT Acumatica_Project_ID__c, ${fields.join(", ")} FROM ${SOLAR_SF_OBJECT} ` +
        `WHERE Id = '${soqlEscapeString(event.recordId)}' LIMIT 1`;
      const rows = await sfQuery(soql);
      if (!rows || rows.length === 0) return { ok: false, error: "record_not_found" };
      budgetValues = rows[0];
      acumaticaProjectId =
        acumaticaProjectId || String(rows[0].Acumatica_Project_ID__c || "").trim();
    }
    if (!acumaticaProjectId) {
      return {
        ok: false,
        error: "no_project_id",
        message: "Provide recordId (with Acumatica_Project_ID__c set) or acumaticaProjectId.",
      };
    }
    const result = await writeBudgetLines(acumaticaProjectId, budgetValues, { dryRun: true });
    return { mode: "dry_run_write", ...result };
  } catch (err) {
    console.error("budget-push dry-run error:", err?.message || String(err));
    return { ok: false, error: "server_error", message: err?.message || String(err) };
  }
}

// --- HTTP: POST /projects/{recordId}/budget/push ---------------------------
// Validates the gates, flips Budget_Push_Status__c to 'Pushing', fires the async
// worker, and returns 202. Never does the Acumatica writes on the HTTP leg (API
// Gateway caps at ~29s; the worker gets the full function timeout).
async function handleHttp(event) {
  const method = httpMethod(event);
  const headers = normalizeHeaders(event?.headers);
  const cors = corsHeaders(headers["origin"]);

  if (method === "OPTIONS") return { statusCode: 204, headers: cors, body: "" };
  if (method !== "POST") {
    return jsonResponse(405, cors, { error: "method_not_allowed", code: "METHOD_NOT_ALLOWED" });
  }

  const pp = event?.pathParameters || {};
  const recordId = pp.recordId ? decodeURIComponent(pp.recordId) : null;
  if (!recordId || !/^[a-zA-Z0-9]{15,18}$/.test(recordId)) {
    return jsonResponse(400, cors, {
      error: "invalid_record_id",
      code: "INVALID_RECORD_ID",
      message: "Path must carry a Sundial_Solar__c record id.",
    });
  }

  // Auth — tenant derived ONLY from the verified token.
  let identity;
  try {
    identity = await resolveIdentity(headers["authorization"]);
  } catch (err) {
    const m = mapIdentityError(err?.code);
    if (m) return jsonResponse(m.status, cors, m.body);
    throw err;
  }
  const tenantId = identity.tenantId;
  if (!tenantId) return jsonResponse(403, cors, { error: "no_tenant", code: "NO_TENANT" });

  // Load the project TENANT-SCOPED with the two gate inputs + the linked customer's
  // Acumatica-sync flag. Not owned / missing is indistinguishable -> 404.
  const soql =
    `SELECT Id, Acumatica_Project_ID__c, Budget_Calc_Status__c, ` +
    `Sundial_Customer__r.Synced_to_Acumatica__c ` +
    `FROM ${SOLAR_SF_OBJECT} ` +
    `WHERE Id = '${soqlEscapeString(recordId)}' ` +
    `AND Client__c = '${soqlEscapeString(tenantId)}' LIMIT 1`;
  const rows = await sfQuery(soql);
  if (!rows || rows.length === 0) {
    return jsonResponse(404, cors, { error: "not_found", code: "RECORD_NOT_FOUND" });
  }
  const rec = rows[0];
  const acumaticaProjectId = String(rec.Acumatica_Project_ID__c || "").trim();
  const calcStatus = rec.Budget_Calc_Status__c;
  const customerSynced = rec.Sundial_Customer__r?.Synced_to_Acumatica__c === true;

  // Gate 1: only push CALCULATED numbers — never Pending/Error/blank.
  if (calcStatus !== "Calculated") {
    return jsonResponse(409, cors, {
      error: "budget_not_calculated",
      code: "BUDGET_NOT_CALCULATED",
      message: `Budget_Calc_Status__c is '${calcStatus || "(blank)"}', must be 'Calculated'.`,
    });
  }
  // Gate 2: the Acumatica project + budget scaffold must already exist (Layer 1).
  if (!customerSynced) {
    return jsonResponse(409, cors, {
      error: "customer_not_synced",
      code: "CUSTOMER_NOT_SYNCED",
      message: "Linked customer is not Synced_to_Acumatica__c=true; the Acumatica project/budget scaffold must exist first.",
    });
  }
  // Gate 3: need the project id to target.
  if (!acumaticaProjectId) {
    return jsonResponse(409, cors, {
      error: "no_acumatica_project",
      code: "NO_ACUMATICA_PROJECT",
      message: "Acumatica_Project_ID__c is blank; cannot target a ProjectBudget.",
    });
  }

  // Flip to 'Pushing' so the UI reflects in-flight state, then fire the worker.
  try {
    await sfUpdateRecord(SOLAR_SF_OBJECT, recordId, { Budget_Push_Status__c: "Pushing" });
  } catch (err) {
    console.error("budget-push: could not set Pushing status:", err?.message || String(err));
    return jsonResponse(502, cors, { error: "sf_update_failed", code: "SF_UPDATE_FAILED" });
  }

  try {
    await lambda.send(
      new InvokeCommand({
        FunctionName: SELF_FUNCTION_NAME,
        InvocationType: "Event", // async, fire-and-forget
        Payload: Buffer.from(
          JSON.stringify({ __worker: true, recordId, acumaticaProjectId, tenantId })
        ),
      })
    );
  } catch (err) {
    console.error("budget-push: self-invoke failed:", err?.message || String(err));
    // Roll the status back so the UI isn't stuck on 'Pushing'.
    try {
      await sfUpdateRecord(SOLAR_SF_OBJECT, recordId, {
        Budget_Push_Status__c: "Failed",
        Budget_Push_Error__c: "Async worker could not be started: " + (err?.message || String(err)),
      });
    } catch {}
    return jsonResponse(502, cors, { error: "worker_invoke_failed", code: "WORKER_INVOKE_FAILED" });
  }

  return jsonResponse(202, cors, {
    status: "Pushing",
    recordId,
    acumaticaProjectId,
    message: "Budget push started.",
  });
}

// --- Async worker: the actual read -> match -> write, then SF write-back -----
// Runs off the API Gateway clock. Reads the budget field values, writes the
// ProjectBudget lines, then records the outcome on the Solar record in ONE PATCH.
// Budget_Finalized__c is set true ONLY on success (idempotent — re-pushes leave it
// true). On any failure/abort it records the reason and leaves Finalized untouched.
async function handleWorker(event) {
  const { recordId, acumaticaProjectId, tenantId } = event;
  try {
    // Pull exactly the fields the mapping references (tenant-scoped defense-in-depth).
    const fields = budgetFieldNames();
    const soql =
      `SELECT ${fields.join(", ")} FROM ${SOLAR_SF_OBJECT} ` +
      `WHERE Id = '${soqlEscapeString(recordId)}'` +
      (tenantId ? ` AND Client__c = '${soqlEscapeString(tenantId)}'` : "") +
      ` LIMIT 1`;
    const rows = await sfQuery(soql);
    if (!rows || rows.length === 0) {
      await markFailed(recordId, "Record not found or not owned by tenant during worker read.");
      return { ok: false, error: "record_not_found" };
    }

    const result = await writeBudgetLines(acumaticaProjectId, rows[0]);

    if (result.ok) {
      await sfUpdateRecord(SOLAR_SF_OBJECT, recordId, {
        Budget_Push_Status__c: "Pushed",
        Budget_Pushed_At__c: new Date().toISOString(),
        Budget_Push_Error__c: null,
        Budget_Finalized__c: true, // first success finalizes; re-push leaves it true
      });
    } else {
      const failedKeys = (result.results || [])
        .filter((r) => r.action === "failed")
        .map((r) => `${r.key}(${r.status})`)
        .join(", ");
      const errMsg = result.aborted
        ? `aborted:${result.aborted} ${result.message || ""}`.trim()
        : `${result.summary?.failed || 0} line(s) failed: ${failedKeys}`;
      await markFailed(recordId, errMsg);
    }
    return result;
  } catch (err) {
    console.error("budget-push worker error:", err?.message || String(err));
    try {
      await markFailed(recordId, "worker exception: " + (err?.message || String(err)));
    } catch {}
    return { ok: false, error: "worker_exception", message: err?.message || String(err) };
  }
}

// Record a failed push. Budget_Finalized__c is deliberately NOT touched here.
async function markFailed(recordId, message) {
  await sfUpdateRecord(SOLAR_SF_OBJECT, recordId, {
    Budget_Push_Status__c: "Failed",
    Budget_Push_Error__c: String(message).slice(0, 32000),
  });
}

// --- RECONCILE (read-only) -------------------------------------------------
// Input: { recordId } (Sundial_Solar__c) or { acumaticaProjectId }. Returns the
// existing lines + the mapping match result for the Gate 5a table. No writes.
async function handleReconcile(event) {
  const body =
    event && typeof event === "object" && !event.Records ? event : {};
  let acumaticaProjectId = body.acumaticaProjectId || null;
  try {
    if (!acumaticaProjectId && body.recordId) {
      acumaticaProjectId = await projectIdForRecord(body.recordId);
    }
    if (!acumaticaProjectId) {
      return { ok: false, error: "no_project_id", message: "Provide acumaticaProjectId or a recordId with Acumatica_Project_ID__c set." };
    }

    const lines = await readProjectBudgetLines(acumaticaProjectId);
    if (lines.length === 0) {
      // Per spec: zero lines means the project wasn't created / scaffold failed.
      return { ok: false, error: "no_scaffolded_lines", acumaticaProjectId, message: "ProjectBudget returned 0 lines — project not created or scaffold failed. Do NOT create lines from scratch." };
    }

    const { matched, problems } = matchMappingToLines(MAPPING_ROWS, lines);
    return {
      ok: true,
      mode: "reconcile_read_only",
      acumaticaProjectId,
      lineCount: lines.length,
      lines, // full existing scaffold, keyed by natural key + GUID (Gate 5a table)
      mappingMatch: { matchedCount: matched.length, matched, problems },
      // Data blockers resolved from the R269999 harvest (2026-08-07). What remains
      // before a PRODUCTION write is Gate 5b sign-off, not more data.
      gate5b: [
        "Confirm this run shows all mapping rows matched with 0 problems.",
        "Harmon finance sign-off on the Geo commission -> APPT COM (LABOR/SALESCOMM) mapping.",
        "Tim approves the hand-proven write plan before writeBudgetLines is implemented.",
      ],
    };
  } catch (err) {
    console.error("acumatica-budget-push reconcile error:", err?.message || String(err));
    return { ok: false, error: "server_error", message: err?.message || String(err) };
  }
}
