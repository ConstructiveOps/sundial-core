// sundial-reports — the report engine's API (D-087 / D-088, R1a; docs/reporting-module.md §6).
//
//   POST /reports/run       a report definition in → { columns, rows, aggregates, truncated, stripped, asOf }
//   GET  /reports/types     the report types (aliases + labels + default columns; no table names)
//   GET  /reports/catalog?type=solar   the fields a report of that type may use, FOR THIS CALLER
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
import { reportType, aliasesOf, describeTypes } from "../../lib/report-types.js";
import { normalizeDefinition, OPERATORS } from "../../lib/report-def.js";

export const ACTION = "reports.read";
export const RPC = "sundial_report_run";
export const MAX_BODY_BYTES = 100_000;

// Every gate any catalog column carries (today: service.costing.read). Derived, so a new gate
// in a regenerated catalog is honoured without a code change here.
export const CATALOG_GATES = Object.freeze([
  ...new Set(Object.values(CATALOG).flatMap((c) => c.fields.map((f) => f.gate).filter(Boolean))),
].sort());

const ROUTES = [
  [/^\/reports\/run\/?$/, "run", "POST"],
  [/^\/reports\/types\/?$/, "types", "GET"],
  [/^\/reports\/catalog\/?$/, "catalog", "GET"],
];

/** The route for a path (an API Gateway stage prefix tolerated), or null. */
export function matchRoute(path) {
  const p = (path || "").replace(/^\/(?!reports\/)[^/]+(?=\/reports\/)/, "");
  for (const [re, name, method] of ROUTES) if (re.test(p)) return { name, method };
  return null;
}

/** The gates this caller holds, from the one table that decides it. */
export function heldGates(access) {
  return CATALOG_GATES.filter((g) => canAction(g, access));
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
      fields: CATALOG[objectKey].fields
        .filter((f) => f.reportable && (!f.gate || holds.has(f.gate)))
        .map((f) => ({
          field: `${alias}.${f.column}`,
          label: f.label,
          section: f.section,
          type: f.type,
          ...(f.picklistValues ? { picklistValues: f.picklistValues } : {}),
          description: f.description,
          longText: f.longText,
          operators: OPERATORS[f.type],
          // Long text: a filter, never a column, group or sort (R1b: selectable for CSV only).
          selectable: !f.longText,
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

async function handleRun({ event, tenantId, access, cors }) {
  const body = parseBody(event);
  if (body.error) return jsonResponse(400, cors, { error: "invalid_report", code: body.error, field: "", message: "Send the report definition as a JSON body." });
  const n = normalizeDefinition(body.value, { heldGates: heldGates(access) });
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
    type: body.value.type,
    columns: n.output,
    rows: data?.rows ?? [],
    aggregates: n.totals.map((t) => ({ ...t, value: totals[t.field] ?? null })),
    truncated: data?.truncated === true,
    limit: n.wire.limit,
    stripped: n.stripped,
    asOf,
  });
  console.log(JSON.stringify({
    report: body.value.type,
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

// --- handler ---------------------------------------------------------------------------
export const handler = async (event) => {
  const method = event?.requestContext?.http?.method || event?.httpMethod || "GET";
  const headers = normalizeHeaders(event?.headers);
  const cors = corsHeaders(headers["origin"]);
  if (method === "OPTIONS") return { statusCode: 204, headers: cors, body: "" };

  const route = matchRoute(event?.rawPath || event?.path || "");
  if (!route) return jsonResponse(404, cors, { error: "not_found", code: "ROUTE_NOT_FOUND" });
  if (method !== route.method) return jsonResponse(405, cors, { error: "method_not_allowed", code: "METHOD_NOT_ALLOWED" });

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

  try {
    if (route.name === "types") return jsonResponse(200, cors, { types: describeTypes() });
    if (route.name === "catalog") {
      const typeKey = event?.queryStringParameters?.type;
      const cat = catalogFor(typeKey, heldGates(access));
      if (!cat) return jsonResponse(400, cors, { error: "invalid_report", code: "UNKNOWN_TYPE", field: "type", message: "type: name a report type (GET /reports/types)." });
      return jsonResponse(200, cors, cat);
    }
    return await handleRun({ event, tenantId, access, cors });
  } catch (err) {
    console.error(`reports ${route.name} error:`, err?.message || String(err));
    return jsonResponse(500, cors, { error: "server_error" });
  }
};
