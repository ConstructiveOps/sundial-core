// sundial-reports — the report engine's API (D-087 / D-088 R1a / D-089 R1b; docs/reporting-module.md §6).
//
//   POST /reports/run       a report definition in → { columns, rows, records?, aggregates, truncated, stripped, asOf }
//   GET  /reports/types     the report types (aliases + labels + default columns + recordPath / linkVia; no table names)
//   GET  /reports/catalog?type=solar   the fields a report of that type may use, FOR THIS CALLER
//   GET  /reports/values?type=&field=<alias.column>&q=   a text field's distinct values, for a
//                           filter's picker (D-089 am. 1) → { values, totalDistinct, partial }
//   POST /reports/csv       a definition → 202 { exportId }   (csv.js — asynchronous, see there)
//   GET  /reports/csv/{exportId}       → { status, url, rowCount, truncated, ... }
//   GET  /reports, POST /reports, GET / PATCH / DELETE /reports/{id},
//   GET  /reports/{id}/run, GET /reports/{id}/csv            saved reports (saved.js)
//   GET  /reports/recipients, GET / PUT / DELETE /reports/{id}/schedule,
//   POST /reports/{id}/send-now        scheduled delivery (schedule.js, D-091)
//   GET  /public/reports/download/{token}   NO LOGIN: a delivered report's 7-day link (deliver.js)
//   { task: "csv", exportId }   NOT a route: this Lambda invoking itself to build an export
//                               (and, for a delivery, to email it when it is done — deliver.js).
//   { task: "tick" }            NOT a route: EventBridge every 15 minutes — queue what is due.
//
// Every report reads the Supabase cache (D-087); Salesforce is never queried here.
//
// THE GATES, IN ORDER (each one the same as the other modules'):
//   1. resolveIdentity — the verified Supabase JWT → the Sundial_User__c → the tenant. No
//      tenant = 403 NO_TENANT; the tenant is never request input.
//   2. reports.read — tenant scope (Executive / Admin / Manager). ALWAYS ON
//      (alwaysEnforcedAccess, like sundial-dealer): this Lambda replaces nothing, so there is
//      no "before" for ACCESS_MODEL_MODE to restore. A Sales Rep / Sales Dealer / Technician
//      gets 403 MODULE_FORBIDDEN — the answer a list of a closed module gets (§3.1); no route
//      here names a record, so there is nothing a 404 would hide.
//   3. Column gates — a catalog column with a `gate` (lib/cost-gate.js: cost and markup) is
//      removed from the catalog this caller sees and from any definition they run, unless
//      canAction(gate) — lib/report-def.js does the removing and names it in `stripped`.
//   3b. Saved reports and exports: visible = same tenant AND (owner OR shared); anything else
//      is 404 RECORD_NOT_FOUND (lib/saved-reports.js). reports.write / reports.share (owner only) for writes.
//   4. sundial_report_run re-checks every identifier against public.sundial_report_catalog
//      and RAISES on anything it does not know. The Lambda has already checked the same
//      things, so a RAISE means the deployed catalog and the database disagree (the SQL seed
//      was not re-run after the catalog was regenerated): 500 REPORT_CATALOG_MISMATCH.
//
// NEVER LOGGED: a row, a value, a filter value. The log line is the type, counts and timing.

import { resolveIdentity } from "../../lib/identity.js";
import { getSupabaseClient } from "../../lib/supabase.js";
import { canAction, DENY } from "../../lib/access.js";
import { alwaysEnforcedAccess } from "../../lib/access-enforce.js";
import { corsHeaders, normalizeHeaders, jsonResponse, mapIdentityError } from "../../lib/http.js";
import { CATALOG } from "../../lib/report-catalog/index.js";
import { reportType, aliasesOf, describeTypes, fieldsOf } from "../../lib/report-types.js";
import { normalizeDefinition, OPERATORS, valuesLookupAllowed } from "../../lib/report-def.js";
import { startExport, exportStatus, runExport } from "./csv.js";
import { listReports, createReport, getReport, updateReport, deleteReport, loadVisible } from "./saved.js";
import { isUuid } from "../../lib/saved-reports.js";
import { CATALOG_GATES, heldGates } from "./gates.js";
import { listRecipients, getSchedule, putSchedule, deleteSchedule, sendNow, runTick } from "./schedule.js";
import { deliverExport, publicDownload } from "./deliver.js";

export const ACTION = "reports.read";
export const RPC = "sundial_report_run";
export const VALUES_RPC = "sundial_report_values";
export const MAX_VALUES_SEARCH = 100;
export const MAX_BODY_BYTES = 100_000;

// The gates (CATALOG_GATES / heldGates) live in gates.js, shared with the scheduled delivery.
export { CATALOG_GATES, heldGates };

// Order matters: the fixed words (run, types, catalog, csv) before /reports/{id}.
const ROUTES = [
  [/^\/reports\/run\/?$/, "run", ["POST"]],
  [/^\/reports\/types\/?$/, "types", ["GET"]],
  [/^\/reports\/catalog\/?$/, "catalog", ["GET"]],
  [/^\/reports\/values\/?$/, "values", ["GET"]],
  [/^\/reports\/csv\/?$/, "csv", ["POST"]],
  [/^\/reports\/csv\/([^/]+)\/?$/, "csvStatus", ["GET"]],
  [/^\/reports\/recipients\/?$/, "recipients", ["GET"]],
  [/^\/reports\/?$/, "saved", ["GET", "POST"]],
  [/^\/reports\/([^/]+)\/run\/?$/, "savedRun", ["GET"]],
  [/^\/reports\/([^/]+)\/csv\/?$/, "savedCsv", ["GET"]],
  [/^\/reports\/([^/]+)\/schedule\/?$/, "schedule", ["GET", "PUT", "DELETE"]],
  [/^\/reports\/([^/]+)\/send-now\/?$/, "sendNow", ["POST"]],
  [/^\/reports\/([^/]+)\/?$/, "savedOne", ["GET", "PATCH", "DELETE"]],
];

/** The route for a path (an API Gateway stage prefix tolerated), or null. { name, methods, id } */
export function matchRoute(path) {
  const p = (path || "").replace(/^\/(?!reports(?:\/|$))[^/]+(?=\/reports(?:\/|$))/, "");
  for (const [re, name, methods] of ROUTES) {
    const m = re.exec(p);
    if (m) return { name, methods, id: m[1] ? decodeURIComponent(m[1]) : null };
  }
  return null;
}

/**
 * The one public route (D-091): GET /public/reports/download/{token}, a stage prefix tolerated.
 * Returns the token (as given; deliver.js checks its shape) or null.
 */
export function matchPublicDownload(path) {
  const m = /^(?:\/[^/]+)?\/public\/reports\/download\/([^/]+)\/?$/.exec(path || "");
  return m ? m[1] : null;
}

/** The catalog of one report type, projected for the caller (gated + non-reportable removed). */
export function catalogFor(typeKey, held) {
  const t = reportType(typeKey);
  if (!t) return null;
  const holds = new Set(held);
  const labels = new Map([[t.base.alias, t.base.label], ...t.joins.map((j) => [j.alias, j.label])]);
  return {
    type: t.key,
    label: t.label,
    aliases: [...aliasesOf(t)].map(([alias, objectKey]) => ({
      alias,
      object: objectKey,
      label: labels.get(alias),
      // A rollup alias (D-089) offers its measures; a table alias its catalog.
      fields: fieldsOf(t, alias, CATALOG)
        .filter((f) => f.reportable && (!f.gate || holds.has(f.gate)))
        .map((f) => ({
          field: `${alias}.${f.column}`,
          label: f.label,
          section: f.section,
          type: f.type,
          format: f.format ?? null,
          ...(f.picklistValues ? { picklistValues: f.picklistValues } : {}),
          description: f.description,
          longText: f.longText,
          // The record's name (D-089 am. 1): what a row's link to this alias's record shows.
          ...(f.nameField ? { nameField: true } : {}),
          // GET /reports/values offers this field's distinct values (D-089 am. 1).
          ...(valuesLookupAllowed(f) ? { valuesLookup: true } : {}),
          operators: OPERATORS[f.type],
          // Long text: a filter on screen, a column only in a CSV — never a group or a sort.
          selectable: !f.longText,
          csvSelectable: true,
        })),
    })),
  };
}

/**
 * "Data as of": the OLDEST of each object's newest successful sync — a report joining three
 * objects is only as fresh as its stalest one. Null when any object has no ok run on record,
 * or the lookup fails (best-effort; never a reason to fail the report).
 */
export async function asOfFor(supabase, objects) {
  try {
    const { data, error } = await supabase
      .from("cache_sync_runs")
      .select("object, finished_at")
      .eq("ok", true)
      .in("object", objects)
      .not("finished_at", "is", null)
      .order("finished_at", { ascending: false })
      .limit(500);
    if (error) throw new Error(error.message);
    const newest = new Map();
    for (const r of data || []) if (!newest.has(r.object)) newest.set(r.object, r.finished_at);
    if (objects.some((o) => !newest.has(o))) return null;
    return [...newest.values()].sort()[0];
  } catch (e) {
    console.warn("reports: asOf lookup failed:", e?.message || String(e));
    return null;
  }
}

function parseBody(event) {
  let raw = event?.body ?? "";
  if (event?.isBase64Encoded && raw) raw = Buffer.from(raw, "base64").toString("utf8");
  if (typeof raw !== "string" || raw.length === 0) return { error: "BODY_REQUIRED" };
  if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) return { error: "BODY_TOO_LARGE" };
  try {
    return { value: JSON.parse(raw) };
  } catch {
    return { error: "INVALID_JSON" };
  }
}

const badBody = (cors, code) => jsonResponse(400, cors, { error: "invalid_report", code, field: "", message: "Send the report definition as a JSON body." });

/** Run a definition for this caller (POST /reports/run, GET /reports/{id}/run). */
async function runDefinition({ def, tenantId, access, cors, extra = {} }) {
  const n = normalizeDefinition(def, { heldGates: heldGates(access) });
  if (!n.ok) return jsonResponse(n.status, cors, n.body);

  const supabase = await getSupabaseClient();
  const started = Date.now();
  const [{ data, error }, asOf] = await Promise.all([
    supabase.rpc(RPC, { p_client_sf_id: tenantId, p_def: n.wire }),
    asOfFor(supabase, n.objects),
  ]);
  if (error) {
    const msg = String(error.message || "");
    if (msg.startsWith(`${RPC}:`)) {
      // The function refused what the Lambda accepted: the two catalogs disagree.
      console.error(`reports: ${msg} — re-run sql/2026-11-03_report_catalog.sql (or the newer catalog SQL) and redeploy sundial-reports together.`);
      return jsonResponse(500, cors, { error: "server_error", code: "REPORT_CATALOG_MISMATCH" });
    }
    console.error("reports: rpc error:", msg);
    return jsonResponse(500, cors, { error: "server_error" });
  }
  const totals = data?.aggregates ?? {};
  const res = jsonResponse(200, cors, {
    ...extra,
    type: def.type,
    columns: n.output,
    rows: data?.rows ?? [],
    // Ungrouped only (D-089 am. 1): per row, { <alias>: { sfId, name } | null } for every record
    // alias — GET /reports/types says which page each opens (recordPath / linkVia).
    ...(n.wire.grouped ? {} : { records: data?.records ?? [] }),
    aggregates: n.totals.map((t) => ({ ...t, value: totals[t.field] ?? null })),
    truncated: data?.truncated === true,
    limit: n.wire.limit,
    stripped: n.stripped,
    asOf,
  });
  console.log(JSON.stringify({
    report: def.type,
    saved: !!extra.report,
    ms: Date.now() - started,
    rows: (data?.rows ?? []).length,
    truncated: data?.truncated === true,
    columns: n.output.length,
    filters: n.wire.filters.length,
    grouped: n.wire.grouped,
    stripped: n.stripped.length,
    bytes: res.body.length,
  }));
  return res;
}

const badValues = (cors, code, field, message) => jsonResponse(400, cors, { error: "invalid_report", code, field, message });

/**
 * GET /reports/values?type=&field=<alias.column>&q= — the field resolved through the type's
 * aliases as a run resolves it; a gated field the caller does not hold is unknown to them (the
 * catalog's projection); only a field valuesLookupAllowed() passes reaches the database.
 */
export async function valuesFor({ qs, tenantId, held, cors }) {
  const t = reportType(qs?.type);
  if (!t) return badValues(cors, "UNKNOWN_TYPE", "type", "type: name a report type (GET /reports/types).");
  const ref = typeof qs?.field === "string" ? qs.field : "";
  const dot = ref.indexOf(".");
  const alias = dot > 0 ? ref.slice(0, dot) : "";
  const column = dot > 0 ? ref.slice(dot + 1) : "";
  const objectKey = aliasesOf(t).get(alias);
  const fld = objectKey ? fieldsOf(t, alias, CATALOG)?.find((f) => f.column === column) : null;
  if (!fld || !fld.reportable || (fld.gate && !held.includes(fld.gate))) {
    return badValues(cors, "UNKNOWN_FIELD", "field", `field: ${JSON.stringify(ref)} is not a field of the ${t.key} report type.`);
  }
  if (!valuesLookupAllowed(fld)) {
    return badValues(cors, "VALUES_NOT_AVAILABLE", "field", `field: ${ref} does not offer a list of values (text and picklist fields only, never an id or long text).`);
  }
  const q = qs?.q === undefined || qs?.q === null ? "" : String(qs.q).trim();
  if (q.length > MAX_VALUES_SEARCH) return badValues(cors, "BAD_VALUE", "q", `q: at most ${MAX_VALUES_SEARCH} characters.`);

  const supabase = await getSupabaseClient();
  const started = Date.now();
  const { data, error } = await supabase.rpc(VALUES_RPC, {
    p_client_sf_id: tenantId, p_table: CATALOG[objectKey].table, p_column: column, p_search: q || null,
  });
  if (error) {
    const msg = String(error.message || "");
    if (msg.startsWith(`${VALUES_RPC}:`)) {
      console.error(`reports: ${msg} — re-run the catalog SQL and sql/sundial_report_values.sql, and redeploy sundial-reports together.`);
      return jsonResponse(500, cors, { error: "server_error", code: "REPORT_CATALOG_MISMATCH" });
    }
    console.error("reports: values rpc error:", msg);
    return jsonResponse(500, cors, { error: "server_error" });
  }
  const values = Array.isArray(data?.values) ? data.values : [];
  const totalDistinct = Number(data?.total_distinct ?? values.length);
  // Never logged: a value or the search text.
  console.log(JSON.stringify({ values: t.key, field: ref, searched: q !== "", returned: values.length, totalDistinct, ms: Date.now() - started }));
  return jsonResponse(200, cors, { type: t.key, field: ref, values, totalDistinct, partial: totalDistinct > values.length });
}

// --- handler ---------------------------------------------------------------------------
export const handler = async (event, context) => {
  // The CSV worker (csv.js): this Lambda invoked by itself, never through API Gateway (an API
  // Gateway event's body is a string, so no request can put a top-level "task" here). It runs
  // only an export row the POST already validated and queued.
  if (event && event.task === "csv" && !event.httpMethod && !event.requestContext) {
    return runExport(event.exportId, {
      remainingMs: () => (typeof context?.getRemainingTimeInMillis === "function" ? context.getRemainingTimeInMillis() : Infinity),
      asOfFor,
      // A scheduled delivery (D-091): email the file once it exists. A plain export has no
      // `delivery` block and deliverExport returns at once.
      onFinished: (row) => deliverExport(row),
    });
  }
  // The scheduler (D-091): EventBridge rule sundial-reports-tick, every 15 minutes. Same guard
  // as the worker — a request through API Gateway can never be read as a task.
  if (event && event.task === "tick" && !event.httpMethod && !event.requestContext) {
    return runTick({});
  }

  const method = event?.requestContext?.http?.method || event?.httpMethod || "GET";
  const headers = normalizeHeaders(event?.headers);
  const cors = corsHeaders(headers["origin"]);
  if (method === "OPTIONS") return { statusCode: 204, headers: cors, body: "" };

  // The ONE public route (D-091): a delivered report's download link. No login — the token is
  // the credential, checked (and rate-limited, logged by hash) in deliver.js.
  const publicToken = matchPublicDownload(event?.rawPath || event?.path || "");
  if (publicToken !== null) {
    if (method !== "GET") return jsonResponse(405, cors, { error: "method_not_allowed", code: "METHOD_NOT_ALLOWED" });
    try {
      return await publicDownload(publicToken);
    } catch (err) {
      console.error("reports download error:", err?.message || String(err));
      return jsonResponse(500, cors, { error: "server_error" });
    }
  }

  const route = matchRoute(event?.rawPath || event?.path || "");
  if (!route) return jsonResponse(404, cors, { error: "not_found", code: "ROUTE_NOT_FOUND" });
  if (!route.methods.includes(method)) return jsonResponse(405, cors, { error: "method_not_allowed", code: "METHOD_NOT_ALLOWED" });

  let identity;
  try {
    identity = await resolveIdentity(headers["authorization"]);
  } catch (err) {
    const m = mapIdentityError(err?.code);
    if (m) return jsonResponse(m.status, cors, m.body);
    console.error("reports: identity error:", err?.message || err);
    return jsonResponse(500, cors, { error: "server_error" });
  }
  const tenantId = identity?.tenantId;
  if (!tenantId) return jsonResponse(403, cors, { error: "no_tenant", code: "NO_TENANT" });
  const access = alwaysEnforcedAccess(identity);
  if (!access || !canAction(ACTION, access)) {
    return jsonResponse(403, cors, { error: "forbidden", code: DENY.MODULE_FORBIDDEN });
  }

  const profileId = identity?.authUserId;
  const me = { tenantId, profileId };
  // Saved reports and exports are owned by the profile id (the JWT sub). No id, no ownership.
  if (!["types", "catalog", "values", "run"].includes(route.name) && !isUuid(profileId)) {
    console.error("reports: identity carries no profile id");
    return jsonResponse(500, cors, { error: "server_error" });
  }
  const perms = { canWrite: canAction("reports.write", access), canShare: canAction("reports.share", access) };
  const held = heldGates(access);
  const needsBody = method === "POST" || method === "PATCH" || method === "PUT";
  // send-now's body is optional ({ "toMe": true } or nothing).
  const emptyBody = route.name === "sendNow" && (event?.body === null || event?.body === undefined || event?.body === "");
  let body;
  if (needsBody && !emptyBody) {
    const b = parseBody(event);
    if (b.error) return badBody(cors, b.error);
    body = b.value;
  }

  try {
    switch (route.name) {
      case "types":
        return jsonResponse(200, cors, { types: describeTypes() });
      case "catalog": {
        const typeKey = event?.queryStringParameters?.type;
        const cat = catalogFor(typeKey, held);
        if (!cat) return jsonResponse(400, cors, { error: "invalid_report", code: "UNKNOWN_TYPE", field: "type", message: "type: name a report type (GET /reports/types)." });
        return jsonResponse(200, cors, cat);
      }
      case "values":
        return await valuesFor({ qs: event?.queryStringParameters, tenantId, held, cors });
      case "run":
        return await runDefinition({ def: body, tenantId, access, cors });
      case "csv":
        return await startExport({ def: body, tenantId, tenantSlug: identity?.tenantSlug, profileId, heldGates: held, cors });
      case "csvStatus":
        return await exportStatus({ exportId: route.id, tenantId, profileId, cors });
      case "saved":
        return method === "GET"
          ? await listReports({ me, perms, cors })
          : await createReport({ body, me, perms, heldGates: held, cors });
      case "savedOne":
        if (method === "GET") return await getReport({ id: route.id, me, perms, cors });
        if (method === "PATCH") return await updateReport({ id: route.id, body, me, perms, heldGates: held, cors });
        return await deleteReport({ id: route.id, me, perms, cors });
      case "savedRun":
      case "savedCsv": {
        const supabase = await getSupabaseClient();
        const { row, error } = await loadVisible(supabase, route.id, me);
        if (error) throw new Error(error.message);
        if (!row) return jsonResponse(404, cors, { error: "not_found", code: DENY.RECORD_NOT_FOUND });
        if (route.name === "savedRun") {
          return await runDefinition({ def: row.definition, tenantId, access, cors, extra: { report: { id: row.id, name: row.name } } });
        }
        return await startExport({ def: row.definition, reportId: row.id, tenantId, tenantSlug: identity?.tenantSlug, profileId, heldGates: held, cors });
      }
      // Scheduled delivery (D-091, schedule.js).
      case "recipients":
        return await listRecipients({ me, access, cors });
      case "schedule":
        if (method === "GET") return await getSchedule({ id: route.id, me, cors });
        if (method === "PUT") return await putSchedule({ id: route.id, body, me, perms, access, cors });
        return await deleteSchedule({ id: route.id, me, perms, cors });
      case "sendNow":
        return await sendNow({ id: route.id, body, me, perms, identity, access, cors });
      default:
        return jsonResponse(404, cors, { error: "not_found", code: "ROUTE_NOT_FOUND" });
    }
  } catch (err) {
    console.error(`reports ${route.name} error:`, err?.message || String(err));
    return jsonResponse(500, cors, { error: "server_error" });
  }
};
