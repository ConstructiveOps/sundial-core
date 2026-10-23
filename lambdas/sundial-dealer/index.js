// sundial-dealer — the /dealer shell's backend (dealer module, step 3 of 9; 2026-10-23).
//
//   GET /dealer/customers?q=&stage=&limit=&offset=&sort=   the customer list, one row per customer
//   GET /dealer/customers/{id}                              one customer + its solar, ready to render
//
// THE PRODUCT RULE: a Sales Dealer or Sales Rep sees one record per customer — the
// Sundial_Customer__c they can see under their existing row filter, plus the
// Sundial_Solar__c whose Sundial_Customer__c points at it. The Customer is the main
// object; the Solar is visible THROUGH it, whatever the Solar's own Dealer__c /
// Sales_Rep__c say. That is D-086's rule (record_visible_for v4 resolves solar through its
// customer for dealer / own scope), applied here to record reads.
//
// ACCESS, in order, every request:
//   1. resolveIdentity — the tenant and the AccessContext come ONLY from the verified token.
//   2. assertAction("dealer.read") — tenant, dealer and own scope; anyone else 403.
//      ALWAYS ON (alwaysEnforcedAccess), never behind ACCESS_MODEL_MODE: this Lambda has
//      no unenforced past to roll back to, and "mode off" here would mean a rep reading
//      the whole tenant (lib/access-enforce.js explains the asymmetry).
//   3. rowFilter("customer") — ANDed FIRST into the list query and into the detail SOQL, so
//      no request input (?q=, ?stage=, ?sort=) can widen it. A list denial is 403; a
//      record outside it is 404, indistinguishable from one that does not exist.
//   4. The field manifest — list rows through projectRow, records through the shared
//      ?full=true read (lib/full-read.js), picklists to the readable fields. Nothing about
//      fields is decided here or in the client.
//
// THE LIST reads sql/sundial_dealer_customer_view.sql: the customer cache with the solar
// that leads its journey beside it (the most recently created one), so the journey-stage
// filter, the count and the page are ONE PostgREST query. Search, the Service-only
// exclusion, sort and paging are sundial-sf-query's own helpers (lib/cache-read.js,
// lib/caller-filters.js). Rows are served from the cache as it stands — the D-079 sync
// keeps it current; this list does not re-fetch stale rows from Salesforce the way the
// Sales list does (the detail page reads Salesforce live).
//
// THE DETAIL reads Salesforce live: the customer with the row filter, then the customer's
// solar projects by Sundial_Customer__c (the leading one by the view's rule,
// pickLeadingSolar), read with the solar manifest and bound to that customer id.
//
// Value-safety: never logs a token, a search term or record data.

import { resolveIdentity } from "../../lib/identity.js";
import { sfQuery, soqlEscapeString } from "../../lib/salesforce.js";
import { getSupabaseClient } from "../../lib/supabase.js";
import { rowFilter, DENY } from "../../lib/access.js";
import { alwaysEnforcedAccess, assertAction } from "../../lib/access-enforce.js";
import { corsHeaders, normalizeHeaders, jsonResponse, mapIdentityError } from "../../lib/http.js";
import { fieldsFor, projectRow, MANIFEST_VERSION } from "../../lib/field-manifest/index.js";
import {
  SEARCH_FIELDS,
  sanitizeSearchTerm,
  searchOrExpr,
  applyEnforceToQuery,
  fetchCacheRange,
  buildListSelect,
  projectListRow,
  getCacheColumns,
} from "../../lib/cache-read.js";
import { parseSort, applyCallerFiltersToQuery, pgrstQuote } from "../../lib/caller-filters.js";
import { getRawDescribe, getQueryableFields, buildPicklistEntry } from "../../lib/sf-describe.js";
import { readFullRecord } from "../../lib/full-read.js";
import { journeyFor, stageFilterValues } from "../../lib/dealer-journey.js";

export const ACTION = "dealer.read";
export const VIEW = "sundial_dealer_customer_view";
export const CUSTOMER_SF_OBJECT = "Sundial_Customer__c";
export const SOLAR_SF_OBJECT = "Sundial_Solar__c";
export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;
/** The view's own columns — never part of the customer row the caller gets. */
export const JOURNEY_COLUMNS = Object.freeze(["journey_solar_sf_id", "journey_solar_stage", "journey_solar_project_name", "journey_solar_count"]);
/**
 * Which project leads when a customer has several: the first non-empty of these, newest
 * first. The SAME order as the cache's created_date (CREATED_DATE_SOURCE.solar in
 * sundial-sf-query, mirrored by sundial-cache-sync), which is what the view sorts by —
 * test.js pins the two lists together so the list and the detail page cannot pick
 * different projects.
 */
export const SOLAR_CREATED_DATE_SOURCE = Object.freeze(["Sunbase_Created_Date__c", "Contract_Date__c", "CreatedDate"]);
/** A customer is many objects' parent; more projects than this is not a customer. */
const MAX_SOLARS = 200;
/** The picklists the page edits and draws the journey from. */
export const CUSTOMER_PICKLISTS = Object.freeze(["Stage__c", "Status__c"]);
export const SOLAR_PICKLISTS = Object.freeze(["Stage__c"]);

/**
 * The Service-only exclusion, as the Sales page sends it (`not[customer_type]=Service`,
 * D-080): a customer tagged Service and nothing else is the Service module's, not a
 * dealer's lead (CLAUDE.md, 2026-09-28). NULL-safe, so the many untagged customers stay.
 */
export const NOT_SERVICE_ONLY = Object.freeze({
  any: [],
  not: [{ column: "customer_type", value: "Service" }],
  ignored: [],
  active: true,
});

const SF_ID_RE = /^[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?$/;

const ROUTES = [
  [/^\/dealer\/customers\/?$/, "list"],
  [/^\/dealer\/customers\/([^/]+)\/?$/, "detail"],
];

/** Route a path (with or without the API Gateway stage prefix). */
export function matchRoute(path) {
  const p = (path || "").replace(/^\/(?!dealer\/)[^/]+(?=\/dealer\/)/, "");
  for (const [re, name] of ROUTES) {
    const hit = p.match(re);
    if (hit) return { name, params: hit.slice(1).map((s) => decodeURIComponent(s)) };
  }
  return null;
}

/**
 * The journey-stage filter as a PostgREST or-group over the view: on the step when the
 * stage that LEADS is one of its values — the customer's when there is no solar, the
 * solar's when there is (lib/dealer-journey.js stageFilterValues).
 */
export function stageOrExpr(values) {
  const list = values.map(pgrstQuote).join(",");
  return (
    `and(journey_solar_sf_id.is.null,stage.in.(${list})),` +
    `and(journey_solar_sf_id.not.is.null,journey_solar_stage.in.(${list}))`
  );
}

/**
 * One view row → one list row: the customer's columns this role may see (projectRow,
 * after the payload rules), its solar summary through the SOLAR manifest, and the journey
 * computed from what the role can see — a stage the manifest hid would be null here, not
 * leaked through the journey.
 */
export function toListRow(row, access) {
  const customerCols = {};
  for (const [k, v] of Object.entries(row)) if (!JOURNEY_COLUMNS.includes(k)) customerCols[k] = v;
  const customer = projectRow("customer", access, projectListRow(customerCols));
  let solar = null;
  if (row.journey_solar_sf_id) {
    const p = projectRow("solar", access, {
      sf_id: row.journey_solar_sf_id,
      stage: row.journey_solar_stage ?? null,
      project_name: row.journey_solar_project_name ?? null,
    });
    // The id is always kept: the project is visible through this customer by definition.
    solar = { sf_id: row.journey_solar_sf_id, stage: p.stage ?? null, project_name: p.project_name ?? null };
  }
  // The whole journey ({stage, source, index, offPath}), not just stage + source: a list
  // card needs the flag (a Cancelled deal is on no step) and should not ask twice.
  return { ...customer, solar, journey: journeyFor(customer.stage ?? null, solar?.stage ?? null, { hasSolar: !!solar }) };
}

/**
 * The customer's leading project, from Salesforce rows carrying SOLAR_CREATED_DATE_SOURCE:
 * the first non-empty source is its date, newest first, undated last, then Id descending —
 * the view's ORDER BY (created_date DESC NULLS LAST, sf_id DESC), written once more in JS.
 * (Ids tie only when two projects share a creation instant; Postgres then orders by its
 * collation and this by code unit, which can differ in letter case. Accepted.)
 */
export function pickLeadingSolar(records, sources = SOLAR_CREATED_DATE_SOURCE) {
  const dateOf = (r) => {
    for (const name of sources) {
      const v = r?.[name];
      if (v != null && v !== "") {
        const t = Date.parse(v);
        if (Number.isFinite(t)) return t;
      }
    }
    return null;
  };
  let best = null;
  let bestAt = null;
  for (const r of records || []) {
    if (!r?.Id) continue;
    const at = dateOf(r);
    const better =
      best === null ||
      (at !== null && (bestAt === null || at > bestAt || (at === bestAt && r.Id > best.Id))) ||
      (at === null && bestAt === null && r.Id > best.Id);
    if (better) {
      best = r;
      bestAt = at;
    }
  }
  return best;
}

/** The named picklists of one object, limited to the fields this role may read. */
async function picklistsFor(objectKey, sfObject, names, access) {
  const meta = await getRawDescribe(sfObject);
  const readable = fieldsFor(objectKey, access); // null = tenant scope, every field
  const out = {};
  for (const name of names) {
    const def = (meta.fields || []).find((f) => f.name === name);
    if (!def || (def.type !== "picklist" && def.type !== "multipicklist")) continue;
    if (readable && !readable.read.has(name)) continue;
    out[name] = buildPicklistEntry(def, meta);
  }
  return out;
}

const intParam = (v, fallback) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
};

// --- GET /dealer/customers ------------------------------------------------------------
async function handleList({ access, tenantId, cors, qs }) {
  // §3.1: a LIST closed to this scope is 403 — it names a module, not a record.
  const enforce = rowFilter("customer", access);
  if (enforce.deny) return jsonResponse(403, cors, { error: "forbidden", code: enforce.code || DENY.MODULE_FORBIDDEN });

  let stageValues = null;
  if (qs.stage != null && String(qs.stage).trim() !== "") {
    stageValues = stageFilterValues(String(qs.stage).trim());
    if (!stageValues) return jsonResponse(400, cors, { error: "invalid_stage", code: "INVALID_STAGE" });
  }
  let limit = intParam(qs.limit, DEFAULT_LIMIT);
  if (limit <= 0) limit = DEFAULT_LIMIT;
  if (limit > MAX_LIMIT) limit = MAX_LIMIT;
  let offset = intParam(qs.offset, 0);
  if (offset < 0) offset = 0;
  const term = sanitizeSearchTerm(qs.q);

  const columnSet = await getCacheColumns(VIEW);
  if (!JOURNEY_COLUMNS.every((c) => columnSet.has(c))) {
    // The view is not in the database (sql/sundial_dealer_customer_view.sql not run) or
    // PostgREST has not reloaded its schema. Loud, and nothing served around it.
    console.error(`dealer: ${VIEW} is missing or lacks its journey columns — run the SQL file`);
    return jsonResponse(503, cors, { error: "not_configured", code: "DEALER_VIEW_MISSING" });
  }
  const parsedSort = parseSort(qs, "customer", columnSet);
  if (!parsedSort.ok) return jsonResponse(parsedSort.status, cors, parsedSort.body);
  const sort = parsedSort.sort;

  const searchCols = term ? SEARCH_FIELDS.customer.cache.filter((c) => columnSet.has(c)) : [];
  if (term && searchCols.length === 0) {
    return jsonResponse(200, cors, { source: "cache", count: 0, total: 0, limit, offset, hasMore: false, records: [] });
  }
  if (!columnSet.has("customer_type")) console.warn("dealer: customer_type absent from the view — Service-only customers not excluded");

  const supabase = await getSupabaseClient();
  const select = buildListSelect(columnSet);
  const makeQuery = (withCount) => {
    let q = supabase.from(VIEW).select(select, withCount ? { count: "exact" } : {}).eq("client_sf_id", tenantId);
    // ROW FILTER FIRST; everything after it can only narrow.
    q = applyEnforceToQuery(q, enforce);
    if (columnSet.has("customer_type")) q = applyCallerFiltersToQuery(q, NOT_SERVICE_ONLY);
    if (term) q = q.or(searchOrExpr(searchCols, term, SEARCH_FIELDS.customer.phone || []));
    if (stageValues) q = q.or(stageOrExpr(stageValues));
    if (sort) {
      for (const col of sort.columns) q = q.order(col, { ascending: sort.ascending, nullsFirst: false });
      return q.order("sf_id", { ascending: true });
    }
    return q.order("created_date", { ascending: false, nullsFirst: false }).order("sf_id", { ascending: true });
  };

  const started = Date.now();
  const { rows, total, error } = await fetchCacheRange(makeQuery, offset, limit);
  if (error) {
    console.error("dealer: list read error:", error.message);
    return jsonResponse(500, cors, { error: "server_error" });
  }
  const records = rows.map((r) => toListRow(r, access));
  const t = total ?? records.length;
  console.log(JSON.stringify({ dealer: "list", scope: access?.scope ?? null, ms: Date.now() - started, rows: records.length, total: t, offset, stage: stageValues ? String(qs.stage).trim() : null, search: !!term, sort: sort ? sort.column : null }));
  return jsonResponse(200, cors, {
    source: "cache",
    count: records.length,
    total: t,
    limit,
    offset,
    hasMore: offset + records.length < t,
    records,
  });
}

// --- GET /dealer/customers/{id} --------------------------------------------------------
async function handleDetail({ access, tenantId, cors, id }) {
  const notFound = () => jsonResponse(404, cors, { error: "not_found", code: DENY.RECORD_NOT_FOUND });
  if (!SF_ID_RE.test(id || "")) return notFound();
  // A record outside the filter must look exactly like one that does not exist: 404.
  const enforce = rowFilter("customer", access);
  if (enforce.deny) return notFound();

  // The visibility check and the read are ONE SOQL: the shared full read with the row
  // filter ANDed in (what assertRecordVisible would have asked, without a second round
  // trip). Zero rows = missing, another tenant's or another rep's / dealer's → 404.
  const customer = await readFullRecord({
    objectKey: "customer",
    sfObject: CUSTOMER_SF_OBJECT,
    id,
    tenantId,
    access,
    accessClause: enforce.soql,
  });
  if (!customer) return notFound();

  // The customer's projects. Bound to THIS customer and tenant — never to the solar's own
  // dealer / rep (the product rule). Only the date fields are fetched to choose one.
  const { fields } = await getQueryableFields(SOLAR_SF_OBJECT);
  const names = new Set(fields.map((f) => f.name));
  const sources = SOLAR_CREATED_DATE_SOURCE.filter((n) => names.has(n));
  const custClause = `Sundial_Customer__c = '${soqlEscapeString(id)}'`;
  const candidates = await sfQuery(
    `SELECT ${["Id", ...sources].join(", ")} FROM ${SOLAR_SF_OBJECT} ` +
      `WHERE ${custClause} AND Client__c = '${soqlEscapeString(tenantId)}' LIMIT ${MAX_SOLARS}`
  );
  const solarCount = (candidates || []).length;
  const lead = pickLeadingSolar(candidates, sources);
  const solar = lead
    ? await readFullRecord({ objectKey: "solar", sfObject: SOLAR_SF_OBJECT, id: lead.Id, tenantId, access, accessClause: custClause })
    : null;

  const [customerPicklists, solarPicklists] = await Promise.all([
    picklistsFor("customer", CUSTOMER_SF_OBJECT, CUSTOMER_PICKLISTS, access),
    picklistsFor("solar", SOLAR_SF_OBJECT, SOLAR_PICKLISTS, access),
  ]);

  const j = journeyFor(customer.record.Stage__c ?? null, solar?.record?.Stage__c ?? null, { hasSolar: !!solar });
  return jsonResponse(200, cors, {
    customer: customer.record,
    solar: solar?.record ?? null,
    // How many projects point at this customer; `solar` is the most recently created.
    solarCount,
    access: {
      // `visible` / `editable`: null = tenant scope, no restriction (§4.3).
      customer: { visible: customer.access.visible, editable: customer.access.editable },
      // Read-only on this page: the solar is seen through the customer, never edited here.
      solar: solar ? { visible: solar.access.visible } : null,
      manifestVersion: MANIFEST_VERSION,
    },
    picklists: { customer: customerPicklists, solar: solarPicklists },
    journey: j,
  });
}

// --- handler ---------------------------------------------------------------------------
export const handler = async (event) => {
  const method = event?.requestContext?.http?.method || event?.httpMethod || "GET";
  const headers = normalizeHeaders(event?.headers);
  const cors = corsHeaders(headers["origin"]);
  if (method === "OPTIONS") return { statusCode: 204, headers: cors, body: "" };
  if (method !== "GET") return jsonResponse(405, cors, { error: "method_not_allowed", code: "METHOD_NOT_ALLOWED" });

  const path = event?.rawPath || event?.path || "";
  let route = matchRoute(path);
  // API Gateway's REST proxy also hands the {id} over as a path parameter.
  if (!route && event?.pathParameters?.id) route = { name: "detail", params: [event.pathParameters.id] };
  if (!route) return jsonResponse(404, cors, { error: "not_found", code: "ROUTE_NOT_FOUND" });

  let identity;
  try {
    identity = await resolveIdentity(headers["authorization"]);
  } catch (err) {
    const m = mapIdentityError(err?.code);
    if (m) return jsonResponse(m.status, cors, m.body);
    console.error("dealer: identity error:", err?.message || err);
    return jsonResponse(500, cors, { error: "server_error" });
  }
  const tenantId = identity?.tenantId;
  if (!tenantId) return jsonResponse(403, cors, { error: "no_tenant", code: "NO_TENANT" });
  const access = alwaysEnforcedAccess(identity);
  const denied = assertAction(ACTION, access) ?? (access ? null : { status: 403, body: { error: "forbidden", code: DENY.ACTION_FORBIDDEN } });
  if (denied) return jsonResponse(denied.status, cors, denied.body);

  try {
    const ctx = { access, tenantId, cors };
    if (route.name === "list") return await handleList({ ...ctx, qs: event?.queryStringParameters || {} });
    return await handleDetail({ ...ctx, id: route.params[0] });
  } catch (err) {
    console.error(`dealer ${route.name} error:`, err?.message || String(err));
    return jsonResponse(500, cors, { error: "server_error" });
  }
};
