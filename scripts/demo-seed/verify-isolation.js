// verify-isolation.js — the work behind scripts/verify-demo-isolation.mjs.
//
// THE QUESTION IT ANSWERS: a DEMO tenant was seeded into the production org that a paying
// client (the primary tenant, "harmon") lives in. Can any seeded record show up in the
// primary tenant's portal — and can any of the client's records show up in the demo?
//
// STRICTLY READ-ONLY. This module is handed its whole outside world as `io`:
//
//   io.sfQuery(soql)              Salesforce SELECT          (never create / update / delete)
//   io.describeObject(name)       Salesforce describe
//   io.getSupabase()              service-role client; only .from(t).select(…) is ever called
//   io.getSecret(name)            Secrets Manager get
//   io.fetch(url, init)           the portal API, GET only
//   io.loginAs(email, password)   the Supabase password grant the portal's login page does
//   io.loginAsTestUser(slug, pw)  (optional) scripts/portal-login.mjs — the ZZ TEST login
//   io.resolveSupabasePublic()    the publishable key pair, only to say early that it is missing
//   io.readIdMap()                migration/demo/id-map.json, parsed (or null)
//   io.now()                      Date
//   io.log(line)                  (optional) where the lines go
//
// so the tests run the real checks against a fake org / Supabase / API with injected
// faults (verify-isolation.test.js), and nothing here imports a write function.
//
// TWO THINGS A PORTAL LOGIN DOES ON ITS OWN, and therefore happen here too (they are the
// portal's behaviour, not a write this script makes): signing in is a POST to Supabase's
// login endpoint, and GET /auth/me makes the API refresh the signed-in user's own
// `profiles` row. Both only ever concern the ZZ TEST user and the demo user.
//
// VALUE-SAFETY (CLAUDE.md): never prints a password, a token, a key or an API / Salesforce
// response body. A DEMO record may be named by id (and demo customer names, which are
// fictional, appear in the search paths). A record that is NOT a demo record is only ever
// named by its id and its object.
//
// HOW A WRONG ASSUMPTION BEHAVES: every check that cannot be carried out the way it was
// meant (a table that is not there, a route that answers something unexpected, a login that
// fails) ends as SKIP or ERROR — never as PASS. ERROR fails the run like FAIL does.

import { DEFAULT_TENANT_SLUG, HARMON_TENANT_ID, HARMON_TENANT_SLUG, DEMO_USERS_SECRET, demoUserEmail, objectOfKey } from "./policy.js";
import { loginEntries } from "./run-record.js";

export const API_BASE_DEFAULT = "https://5sktfwldh1.execute-api.us-west-1.amazonaws.com/prod";
export const TEST_USERS_SECRET = "sundial/test-users";
export const TENANT_OBJECT = "Sundial_Tenant__c";
/** The demo login used for section C — the Executive, so no sales-role filter narrows what it sees. */
export const DEMO_LOGIN_SLUG = "avery";
/** Harmon-tenant ZZ TEST accounts with tenant scope, in the order they are tried. */
export const PRIMARY_TEST_USER_SLUGS = Object.freeze(["exec", "admin"]);
const zzEmail = (slug) => `tim+zz-${slug}@constructiveoperations.com`;

/** Hard ceiling for one SOQL string (the REST query is a GET; the whole text travels in the URL). */
export const MAX_SOQL_CHARS = 10000;
/** Ids per `IN (…)` in SOQL — about 3,200 characters. */
export const SOQL_ID_CHUNK = 150;
/** Record ids per Supabase `.in()` — sent in both their 18- and 15-character form. */
export const SUPABASE_ID_CHUNK = 100;
const SUPABASE_PAGE = 1000;
const PRINT_IDS = 40;

/**
 * Every Sundial object the portal reads or writes. `Sundial_Tenant__c` is handled apart
 * (it IS the tenant). Anything else named Sundial_*__c that these objects point at, or that
 * points at them, is discovered from the live describes and checked as well.
 */
export const KNOWN_OBJECTS = Object.freeze([
  "Sundial_User__c", "Sundial_Dealer__c", "Sundial_Customer__c", "Sundial_Solar__c", "Sundial_Roofing__c",
  "Sundial_Commercial__c", "Sundial_Estimate__c", "Sundial_Service_Job__c", "Sundial_Service_Call__c",
  "Sundial_Service_Line__c", "Sundial_Price_Book_Item__c", "Sundial_Service_Invoice__c", "Sundial_Service_Payment__c",
  "Sundial_Service_Plan__c", "Sundial_Membership__c", "Sundial_Tech_Day__c", "Sundial_PO__c",
]);
const SUNDIAL_OBJECT_RE = /^Sundial_\w+__c$/;
const MAX_DESCRIBED_OBJECTS = 40;
const SYSTEM_REFERENCE_FIELDS = new Set(["OwnerId", "CreatedById", "LastModifiedById"]);

/**
 * The portal's object keys and their list-cache tables — a copy of OBJECT_ALLOWLIST in
 * lambdas/sundial-sf-query/index.js (the cache-sync Lambda carries the same map and fills
 * every one of them). The test reads both Lambdas' source and fails if this copy drifts.
 */
export const CACHE_OBJECTS = Object.freeze({
  solar: { sfObject: "Sundial_Solar__c", cacheTable: "sundial_solar_cache" },
  customer: { sfObject: "Sundial_Customer__c", cacheTable: "sundial_customer_cache" },
  roofing: { sfObject: "Sundial_Roofing__c", cacheTable: "sundial_roofing_cache" },
  po: { sfObject: "Sundial_PO__c", cacheTable: "sundial_po_cache" },
  user: { sfObject: "Sundial_User__c", cacheTable: "sundial_user_cache" },
  estimate: { sfObject: "Sundial_Estimate__c", cacheTable: "sundial_estimate_cache" },
  job: { sfObject: "Sundial_Service_Job__c", cacheTable: "sundial_service_job_cache" },
  servicecall: { sfObject: "Sundial_Service_Call__c", cacheTable: "sundial_service_call_cache" },
  pricebookitem: { sfObject: "Sundial_Price_Book_Item__c", cacheTable: "sundial_price_book_item_cache" },
  serviceline: { sfObject: "Sundial_Service_Line__c", cacheTable: "sundial_service_line_cache" },
  serviceinvoice: { sfObject: "Sundial_Service_Invoice__c", cacheTable: "sundial_service_invoice_cache" },
  servicepayment: { sfObject: "Sundial_Service_Payment__c", cacheTable: "sundial_service_payment_cache" },
  serviceplan: { sfObject: "Sundial_Service_Plan__c", cacheTable: "sundial_service_plan_cache" },
  membership: { sfObject: "Sundial_Membership__c", cacheTable: "sundial_membership_cache" },
});

/**
 * The Supabase tables that hold rows ABOUT records (not the list cache).
 *   tenantCol  the column that holds the tenant RECORD id (the isolation key of that table)
 *   slugCol    a column that holds the tenant slug, where the table has one
 *   refs       columns that hold a Salesforce record id
 *   auth       columns that hold a login's auth uuid
 * Column names were checked against sql/*.sql, migration/demo/probe.json and the code that
 * writes each table (lib/service-activity.js, lib/notify.js, lib/file-access.js,
 * scripts/demo-seed/plan-supabase.js).
 */
export const RECORD_TABLES = Object.freeze([
  { table: "comments", pk: "id", tenantCol: "tenant_id", slugCol: null, refs: ["record_id"], auth: ["author_id"] },
  { table: "sundial_service_activity", pk: "id", tenantCol: "client_sf_id", slugCol: "tenant_id", refs: ["record_sf_id", "job_sf_id", "estimate_sf_id", "actor_user_sf_id"], auth: [] },
  { table: "sundial_sms_messages", pk: "id", tenantCol: "client_sf_id", slugCol: "tenant_id", refs: ["job_sf_id", "customer_sf_id", "sent_by_user_sf_id"], auth: [] },
  { table: "sundial_notifications", pk: "id", tenantCol: "client_sf_id", slugCol: null, refs: ["record_sf_id", "user_sf_id"], auth: ["profile_id"] },
  { table: "sundial_file_metadata", pk: "id", tenantCol: "tenant_id", slugCol: null, refs: ["sf_record_id"], auth: [] },
]);

/** GET /sf/{key}/{id} as the primary tenant's test user: every demo id of these… */
export const C2_EVERY = Object.freeze(["customer", "solar", "roofing", "estimate", "job", "user"]);
/** …and a fixed sample of these. */
export const C2_SAMPLED = Object.freeze(["servicecall", "serviceline", "serviceinvoice", "servicepayment", "pricebookitem"]);
const C2_SAMPLE_SIZE = 10;
const C2_QUICK_SIZE = 5;
const C2_FULL_KEYS = Object.freeze(["customer", "solar"]);
const C2_FULL_SIZE = 5;
/** Lists small enough to read whole as the primary tenant's test user. */
const C3_SMALL_LISTS = Object.freeze(["roofing", "user", "pricebookitem"]);
const C3_ROW_CAP = 2000;
const C5_LISTS = Object.freeze(["customer", "solar", "roofing", "job", "estimate"]);
const LIST_PAGE = 500;
/** The dispatch board refuses a window wider than this (DEFAULTS.maxWindowDays in sundial-service-board). */
const BOARD_MAX_DAYS = 42;
/** A 403 with one of these codes says "this login is not a portal user" — it proves nothing about a record. */
const IDENTITY_CODES = new Set(["NO_SUNDIAL_USER", "USER_INACTIVE", "NO_TENANT", "AUTH_NO_TOKEN", "AUTH_INVALID_TOKEN"]);

export const HELP = `
Check that the seeded DEMO tenant is isolated from the primary tenant. READ-ONLY: it
queries Salesforce, reads Supabase, calls the portal API with GET, and writes nothing.

  node scripts/verify-demo-isolation.mjs                 before the cache sync
  node scripts/verify-demo-isolation.mjs --after-sync    after it: the cache must now hold every demo record,
                                                         and the demo login's lists are read too

Options
  --after-sync     the cache sync has run: cache counts must match Salesforce, and section C5 runs
  --quick          5 records per object in the API section instead of every customer / project / job
  --skip-api       sections A and B only (no login, no portal API call)
  --json           print one JSON report on stdout instead of the lines
  --id-map <path>  the id-map to check (default migration/demo/id-map.json)
  --help           this text

Exit code 0: no check failed. 1: at least one FAIL or ERROR (or the run was refused). 2: bad command line.
`;

export function parseVerifyArgs(argv) {
  const a = { afterSync: false, quick: false, skipApi: false, json: false, help: false, idMapPath: null, problems: [] };
  for (let i = 0; i < argv.length; i++) {
    const f = argv[i];
    if (f === "--after-sync") a.afterSync = true;
    else if (f === "--quick") a.quick = true;
    else if (f === "--skip-api") a.skipApi = true;
    else if (f === "--json") a.json = true;
    else if (f === "--help" || f === "-h") a.help = true;
    else if (f === "--id-map") {
      const v = argv[++i];
      if (!v || v.startsWith("--")) a.problems.push("--id-map needs a path");
      else a.idMapPath = v;
    } else a.problems.push(`unknown option ${f}`);
  }
  return a;
}

// ---------------------------------------------------------------------------------------
// small pure helpers (exported for the tests)
// ---------------------------------------------------------------------------------------
const SF_ID_RE = /^[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const id15 = (v) => String(v ?? "").slice(0, 15);
export const isSfId = (v) => typeof v === "string" && SF_ID_RE.test(v);
const lower = (v) => String(v ?? "").toLowerCase();
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const num = (n) => Number(n).toLocaleString("en-US");
const chunk = (arr, n) => {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
};
const soqlQuote = (v) => `'${String(v).replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
const inList = (values) => values.map(soqlQuote).join(", ");

/** A fixed, evenly spread sample: the same ids on every run. */
export function sampleIds(ids, n) {
  const sorted = [...new Set(ids)].sort();
  if (sorted.length <= n) return sorted;
  if (n <= 1) return sorted.slice(0, 1);
  const out = new Set();
  for (let i = 0; i < n; i++) out.add(sorted[Math.floor((i * (sorted.length - 1)) / (n - 1))]);
  return [...out];
}

/**
 * Every demo record id that appears anywhere in a response body. `demo15` is the set of
 * 15-character demo ids. Every run of letters and digits long enough to hold an id is
 * looked at, window by window, so an id is found inside a URL, a key or a longer token too.
 */
export function findDemoIds(text, demo15) {
  const found = new Set();
  if (!text || !demo15?.size) return [];
  const re = /[A-Za-z0-9]{15,}/g;
  let m;
  while ((m = re.exec(text))) {
    const run = m[0];
    if (run.length === 15 || run.length === 18) {
      if (demo15.has(run.slice(0, 15))) found.add(run.slice(0, 15));
      continue;
    }
    for (let i = 0; i + 15 <= run.length; i++) {
      const w = run.slice(i, i + 15);
      if (demo15.has(w)) found.add(w);
    }
  }
  return [...found];
}

/** One printable line for something that went wrong. Never a response body, never a stack. */
export function safeError(e) {
  if (e?.sfStatus) {
    let codes = "";
    try {
      const body = typeof e.sfBody === "string" ? JSON.parse(e.sfBody) : e.sfBody;
      codes = (Array.isArray(body) ? body : body ? [body] : []).map((x) => x?.errorCode || x?.error).filter(Boolean).join(", ");
    } catch {
      codes = "";
    }
    return `Salesforce HTTP ${e.sfStatus}${codes ? ` ${codes}` : ""}`;
  }
  const text = String(e?.message || e?.name || e || "error").replace(/\s+/g, " ");
  return text.length > 180 ? `${text.slice(0, 180)}…` : text;
}

const isAbsentObject = (e) => e?.sfStatus === 404 || /NOT_FOUND|INVALID_TYPE|does not exist/i.test(`${e?.errorCode || ""} ${e?.sfBody || ""}`);
const isMissingTable = (error) =>
  ["42P01", "PGRST205"].includes(String(error?.code || "")) ||
  (/could not find the table|relation .* does not exist/i.test(String(error?.message || "")) && !/column/i.test(String(error?.message || "")));
const dbError = (error) => `${error?.code ? `${error.code} ` : ""}${String(error?.message || "error").replace(/\s+/g, " ").slice(0, 140)}`;

// ---------------------------------------------------------------------------------------
// the report
// ---------------------------------------------------------------------------------------
function createReport(log) {
  const results = [];
  const add = (level, check, message, details = []) => {
    const shown = details.slice(0, PRINT_IDS);
    const more = details.length - shown.length;
    results.push({ level, check, message, details });
    log(`${level.padEnd(5)} ${check.padEnd(4)} ${message}`);
    for (const d of shown) log(`             - ${d}`);
    if (more > 0) log(`             … and ${num(more)} more`);
  };
  return {
    results,
    pass: (check, message, details) => add("PASS", check, message, details),
    fail: (check, message, details) => add("FAIL", check, message, details),
    info: (check, message, details) => add("INFO", check, message, details),
    skip: (check, message, details) => add("SKIP", check, message, details),
    error: (check, message, details) => add("ERROR", check, message, details),
    count: (level) => results.filter((r) => r.level === level).length,
    of: (check) => results.filter((r) => r.check === check),
  };
}

// ---------------------------------------------------------------------------------------
// verify
// ---------------------------------------------------------------------------------------

/**
 * @param {object} io    see the header
 * @param {object} [opts]
 *   afterSync, quick, skipApi   the command-line switches
 *   apiBase                     the portal API (default: the production stage)
 *   primary                     { slug, id } of the tenant that must not see the demo (default harmon)
 *   delayMs, concurrency        pacing of the API section (defaults 60 ms, 4 at a time)
 *   retryDelayMs                wait before the one retry of a 5xx / 429 / network failure
 * @returns {Promise<{ exitCode: number, results: object[], verdict: string[], stats: object, refused: string|null }>}
 */
export async function verify(io, opts = {}) {
  const o = {
    afterSync: !!opts.afterSync,
    quick: !!opts.quick,
    skipApi: !!opts.skipApi,
    apiBase: String(opts.apiBase || API_BASE_DEFAULT).replace(/\/+$/, ""),
    primary: { slug: opts.primary?.slug ?? HARMON_TENANT_SLUG, id: opts.primary?.id ?? HARMON_TENANT_ID },
    delayMs: opts.delayMs ?? 60,
    retryDelayMs: opts.retryDelayMs ?? 1500,
    concurrency: Math.max(1, Math.min(4, opts.concurrency ?? 4)),
    testUserEmail: opts.testUserEmail ?? zzEmail,
  };
  const log = io.log ?? ((line) => console.log(line));
  const now = io.now ? io.now() : new Date();
  const sleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());
  const R = createReport(log);
  const stats = { salesforceQueries: 0, salesforceDescribes: 0, sectionAQueries: 0, supabaseReads: 0, apiRequests: 0, logins: 0 };
  const facts = {}; // what the verdict is written from
  let section = "A";

  /** A Salesforce SELECT. Counted, and refused when the text is too long for a GET. */
  const q = async (soql) => {
    if (soql.length > MAX_SOQL_CHARS) throw new Error(`internal: a SOQL string of ${soql.length} characters was built (limit ${MAX_SOQL_CHARS})`);
    stats.salesforceQueries++;
    if (section === "A") stats.sectionAQueries++;
    return (await io.sfQuery(soql)) || [];
  };
  const countOf = (rows) => Number(rows?.[0]?.c ?? rows?.[0]?.expr0 ?? 0) || 0;
  /** Run one check; whatever it throws becomes an ERROR line instead of ending the run. */
  const step = async (check, fn) => {
    try {
      return await fn();
    } catch (e) {
      R.error(check, `could not be completed: ${safeError(e)}`);
      return undefined;
    }
  };
  const finish = (refused = null) => {
    const verdict = buildVerdict({ R, o, facts, refused, stats });
    log("");
    for (const line of verdict) log(line);
    const failed = R.count("FAIL") + R.count("ERROR") > 0 || !!refused;
    return { exitCode: failed ? 1 : 0, results: R.results, verdict, stats, refused, generatedAt: now.toISOString(), mode: o.afterSync ? "after-sync" : "before-sync" };
  };

  log("DEMO TENANT ISOLATION CHECK — READ-ONLY");
  log("  This script changes nothing. Salesforce: SELECT and describe only. Supabase: select only.");
  log("  Portal API: GET only. Secrets Manager: read only. No file is written.");
  log("  (Signing in is a POST to Supabase's login endpoint, exactly what the portal's login page does,");
  log("   and GET /auth/me makes the portal refresh the signed-in TEST user's own profile row, as every login does.)");
  log(`  mode: ${o.afterSync ? "AFTER the cache sync (--after-sync)" : "BEFORE the cache sync"}${o.quick ? " · quick" : ""}${o.skipApi ? " · API section skipped" : ""} · ${now.toISOString()}`);

  // === the id-map ==========================================================================
  let idmap = null;
  try {
    idmap = await io.readIdMap();
  } catch (e) {
    R.fail("A1", `the id-map could not be read: ${safeError(e)}`);
    return finish("the id-map could not be read");
  }
  if (!idmap || typeof idmap.ids !== "object" || !idmap.ids || !idmap.ids.tenant) {
    R.fail("A1", "no usable id-map (migration/demo/id-map.json): it is the record of what the seed created, and without it there is nothing to check.");
    return finish("there is no usable id-map");
  }
  const demoSlug = String(idmap.tenantSlug || DEFAULT_TENANT_SLUG);
  const demoTenantId = String(idmap.ids.tenant);
  const demo15 = id15(demoTenantId);
  const primary15 = id15(o.primary.id);
  const isDemoTenant = (v) => v != null && id15(v) === demo15;
  const seededCount = Object.keys(idmap.ids).length;
  facts.seededCount = seededCount;
  facts.demoSlug = demoSlug;
  facts.demoTenantId = demoTenantId;
  facts.primarySlug = o.primary.slug;

  // =========================================================================================
  // SECTION A — Salesforce, the source of truth
  // =========================================================================================
  log("");
  log("SECTION A — Salesforce (the source of truth)");

  // --- A1: the two tenants --------------------------------------------------------------
  if (demoSlug === o.primary.slug || demo15 === primary15) {
    R.fail("A1", `REFUSED: the id-map names the PRIMARY tenant (${demoSlug}, ${demoTenantId}). This script only checks a demo tenant against the primary one.`);
    return finish("the id-map's tenant is the primary tenant");
  }
  let tenantRows;
  try {
    tenantRows = await q(`SELECT Id, Name FROM ${TENANT_OBJECT}`);
  } catch (e) {
    R.error("A1", `the tenant records could not be read: ${safeError(e)}`);
    return finish("Salesforce could not be read");
  }
  const tenantSlugOf = new Map(tenantRows.map((t) => [id15(t.Id), t.Name]));
  const tenantLabel = (id) => (id == null || id === "" ? "no tenant" : `tenant ${id}${tenantSlugOf.has(id15(id)) ? ` (${tenantSlugOf.get(id15(id))})` : ""}`);
  const demoRow = tenantRows.find((t) => id15(t.Id) === demo15) ?? null;
  const primaryRows = tenantRows.filter((t) => t.Name === o.primary.slug);
  if (demoRow && primaryRows.some((t) => id15(t.Id) === demo15)) {
    R.fail("A1", `REFUSED: the id-map's tenant record ${demoTenantId} IS the primary tenant "${o.primary.slug}".`);
    return finish("the id-map's tenant is the primary tenant");
  }
  {
    const problems = [];
    if (!demoRow) problems.push(`the id-map's tenant ${demoTenantId} does not exist in ${TENANT_OBJECT}`);
    else if (demoRow.Name !== demoSlug) problems.push(`tenant ${demoTenantId} is named "${demoRow.Name}" in Salesforce, the id-map says "${demoSlug}"`);
    const sameName = tenantRows.filter((t) => t.Name === demoSlug);
    if (sameName.length > 1) problems.push(`${sameName.length} tenant records are named "${demoSlug}": ${sameName.map((t) => t.Id).join(", ")}`);
    if (primaryRows.length === 0) problems.push(`no tenant record is named "${o.primary.slug}" (the primary tenant)`);
    if (primaryRows.length > 1) problems.push(`${primaryRows.length} tenant records are named "${o.primary.slug}"`);
    if (primaryRows.length === 1 && id15(primaryRows[0].Id) !== primary15) problems.push(`the tenant named "${o.primary.slug}" is ${primaryRows[0].Id}, not the ${o.primary.id} this script expects`);
    if (problems.length) R.fail("A1", `the tenant records are not as expected`, problems);
    else R.pass("A1", `demo tenant "${demoSlug}" = ${demoRow.Id}; primary tenant "${o.primary.slug}" = ${primaryRows[0].Id} is a different record (${plural(tenantRows.length, "tenant")} in the org)`);
    if (!demoRow) return finish("the demo tenant record does not exist");
  }
  const primaryId = primaryRows.length === 1 ? primaryRows[0].Id : o.primary.id;
  const isPrimaryTenant = (v) => v != null && id15(v) === id15(primaryId);

  // --- describes: the object model, from the live org ---------------------------------------
  /** @type {Map<string, { name, keyPrefix, fields: Map<string, object>, tenantField: boolean, tenantNillable: boolean, links: Array<{field, targets}>, outside: Array<{field, targets}> }>} */
  const objects = new Map();
  const absent = [];
  const describeFailed = [];
  {
    const queue = [TENANT_OBJECT, ...KNOWN_OBJECTS];
    const seen = new Set(queue);
    // A discovered object is described too — up to a ceiling, so a describe loop cannot run away.
    const discover = (name) => {
      if (!SUNDIAL_OBJECT_RE.test(name) || seen.has(name) || seen.size >= MAX_DESCRIBED_OBJECTS) return;
      seen.add(name);
      queue.push(name);
    };
    while (queue.length) {
      const name = queue.shift();
      let d;
      try {
        stats.salesforceDescribes++;
        d = await io.describeObject(name);
      } catch (e) {
        if (isAbsentObject(e)) absent.push(name);
        else describeFailed.push(`${name}: ${safeError(e)}`);
        continue;
      }
      const fields = new Map((d.fields || []).map((f) => [f.name, f]));
      const client = fields.get("Client__c");
      const tenantField = name !== TENANT_OBJECT && client?.type === "reference" && (client.referenceTo || []).includes(TENANT_OBJECT);
      const links = [];
      const outside = [];
      for (const f of d.fields || []) {
        if (f.type !== "reference" || SYSTEM_REFERENCE_FIELDS.has(f.name)) continue;
        if (f.name === "Client__c" && tenantField) continue;
        const targets = (f.referenceTo || []).filter((t) => SUNDIAL_OBJECT_RE.test(t));
        if (targets.length) links.push({ field: f.name, targets });
        // A custom lookup to something that is not a Sundial object (the vendor's own project
        // object, a Salesforce user): reported when filled, as information. Standard fields
        // (record type and the like) are not of interest.
        else if (/__c$/.test(f.name)) outside.push({ field: f.name, targets: f.referenceTo || [] });
        for (const t of targets) discover(t);
      }
      // Objects that point AT this one (the describe lists them): a Sundial object nobody
      // listed above is described and checked too.
      for (const c of d.childRelationships || []) if (c?.childSObject) discover(c.childSObject);
      objects.set(name, { name, keyPrefix: d.keyPrefix ?? null, fields, tenantField, tenantNillable: tenantField && client.nillable !== false, links, outside });
    }
  }
  const prefixToObject = new Map();
  for (const ob of objects.values()) if (ob.keyPrefix) prefixToObject.set(ob.keyPrefix, ob.name);
  const objectOfId = (id) => prefixToObject.get(String(id ?? "").slice(0, 3)) ?? null;
  const naming = (id) => `${id} (${objectOfId(id) ?? "unknown object"})`;
  const tenantObjects = [...objects.values()].filter((ob) => ob.tenantField);
  const untenanted = [...objects.values()].filter((ob) => !ob.tenantField && ob.name !== TENANT_OBJECT);

  // --- A2: every id in the id-map belongs to a Sundial object ---------------------------------
  /** sfObject -> [{ key, id }] */
  const seeded = new Map();
  await step("A2", async () => {
    const problems = [];
    const notes = [];
    if (describeFailed.length) problems.push(...describeFailed.map((x) => `describe failed — ${x}`));
    for (const ob of objects.values()) if (!ob.keyPrefix) problems.push(`${ob.name}: the describe carries no keyPrefix, so its ids cannot be recognised`);
    const seenIds = new Map();
    for (const [key, id] of Object.entries(idmap.ids)) {
      if (!isSfId(id)) { problems.push(`${key}: "${String(id).slice(0, 24)}" is not a Salesforce id`); continue; }
      const sfObject = objectOfId(id);
      if (!sfObject) { problems.push(`${key}: ${id} — its prefix "${String(id).slice(0, 3)}" belongs to no Sundial object`); continue; }
      if (seenIds.has(id15(id))) notes.push(`${id} is recorded under two keys: ${seenIds.get(id15(id))} and ${key}`);
      seenIds.set(id15(id), key);
      const named = objectOfKey(key, idmap.objects || {});
      if (named && named !== sfObject) notes.push(`${key}: the key name says ${named}, the id is a ${sfObject} (the id decides)`);
      if (!seeded.has(sfObject)) seeded.set(sfObject, []);
      seeded.get(sfObject).push({ key, id });
    }
    if (String(objectOfId(demoTenantId)) !== TENANT_OBJECT) problems.push(`the id-map's "tenant" id ${demoTenantId} is not a ${TENANT_OBJECT} id`);
    const perObject = [...seeded].map(([sfObject, list]) => `${sfObject} ${list.length}`);
    if (problems.length) R.fail("A2", `${plural(problems.length, "id-map entry", "id-map entries")} could not be placed on a Sundial object (${seededCount} ids in the id-map)`, problems);
    else R.pass("A2", `all ${num(seededCount)} ids in the id-map belong to a Sundial object, by the live key prefixes (${objects.size} objects described)`, perObject);
    if (notes.length) R.info("A2", `${plural(notes.length, "note")} on the id-map's keys`, notes);
    if (absent.length) R.info("A2", `not in this org (skipped): ${absent.join(", ")}`);
  });

  // --- A3: every seeded record exists and carries the demo tenant ------------------------------
  await step("A3", async () => {
    const missing = [];
    const wrong = [];
    const unstampable = [];
    let ok = 0;
    for (const [sfObject, list] of seeded) {
      if (sfObject === TENANT_OBJECT) continue; // A1
      const ob = objects.get(sfObject);
      if (!ob.tenantField) { unstampable.push(...list.map((x) => `${x.id} (${sfObject}) — this object has no tenant lookup, so the record cannot carry a tenant`)); continue; }
      const found = new Map();
      for (const part of chunk(list, SOQL_ID_CHUNK)) {
        const rows = await q(`SELECT Id, Client__c FROM ${sfObject} WHERE Id IN (${inList(part.map((x) => x.id))})`);
        for (const r of rows) found.set(id15(r.Id), r);
      }
      for (const { key, id } of list) {
        const row = found.get(id15(id));
        if (!row) missing.push(`${id} (${sfObject}, ${key}) — not in Salesforce`);
        else if (!isDemoTenant(row.Client__c)) wrong.push(`${id} (${sfObject}, ${key}) — carries ${tenantLabel(row.Client__c)}, not the demo tenant`);
        else ok++;
      }
    }
    const total = [...seeded].filter(([name]) => name !== TENANT_OBJECT).reduce((n, [, list]) => n + list.length, 0);
    facts.a3 = { ok, total, missing: missing.length, wrong: wrong.length + unstampable.length };
    if (missing.length || wrong.length || unstampable.length) {
      R.fail("A3", `${num(ok)} of ${num(total)} seeded records exist and carry Client__c = the demo tenant — ${wrong.length + unstampable.length} carry another tenant or none, ${missing.length} are missing`, [...wrong, ...unstampable, ...missing]);
    } else {
      R.pass("A3", `all ${num(total)} seeded records exist and carry Client__c = ${demoTenantId} (re-read by id, ${seeded.size - 1} objects)`);
    }
  });

  // --- A4: what the demo tenant holds, compared with the id-map --------------------------------
  /** sfObject -> Map(id15 -> row) — the records Salesforce says are in the demo tenant. */
  const live = new Map();
  const liveFailed = new Set();
  await step("A4", async () => {
    const extras = [];
    const lost = [];
    const perObject = [];
    for (const ob of tenantObjects) {
      const select = ["Id", ...ob.links.map((l) => l.field), ...ob.outside.map((l) => l.field)];
      if (ob.name === "Sundial_User__c" && ob.fields.has("Supabase_User_Id__c")) select.push("Supabase_User_Id__c");
      let rows;
      try {
        rows = await q(`SELECT ${[...new Set(select)].join(", ")} FROM ${ob.name} WHERE Client__c = ${soqlQuote(demoTenantId)}`);
      } catch (e) {
        liveFailed.add(ob.name);
        R.error("A4", `${ob.name}: the demo tenant's records could not be read: ${safeError(e)}`);
        continue;
      }
      const map = new Map(rows.map((r) => [id15(r.Id), r]));
      live.set(ob.name, map);
      const mine = new Set((seeded.get(ob.name) || []).map((x) => id15(x.id)));
      for (const r of rows) if (!mine.has(id15(r.Id))) extras.push(`${r.Id} (${ob.name})`);
      for (const { key, id } of seeded.get(ob.name) || []) if (!map.has(id15(id))) lost.push(`${id} (${ob.name}, ${key})`);
      if (rows.length) perObject.push(`${ob.name} ${rows.length}`);
    }
    live.set(TENANT_OBJECT, new Map([[demo15, { Id: demoTenantId }]]));
    const total = [...live].filter(([name]) => name !== TENANT_OBJECT).reduce((s, [, m]) => s + m.size, 0);
    facts.a4 = { total, extras: extras.length, lost: lost.length };
    if (lost.length) R.fail("A4", `${plural(lost.length, "id-map record is", "id-map records are")} NOT among the demo tenant's records in Salesforce`, lost);
    else if (!liveFailed.size) R.pass("A4", `the demo tenant holds ${num(total)} records in Salesforce and every id-map record is among them`, perObject);
    if (extras.length) R.info("A4", `${plural(extras.length, "record")} in the demo tenant ${extras.length === 1 ? "is" : "are"} not in the id-map (made by hand in the demo portal, or by --freshen with an older id-map) — checked like the rest`, extras);
  });

  /** Everything that must never be seen from another tenant: the id-map's ids and whatever else the demo tenant holds. */
  const demoIds = new Map(); // id15 -> { id, sfObject }
  for (const [sfObject, list] of seeded) for (const { id } of list) demoIds.set(id15(id), { id, sfObject });
  for (const [sfObject, map] of live) for (const r of map.values()) if (!demoIds.has(id15(r.Id))) demoIds.set(id15(r.Id), { id: r.Id, sfObject });
  const demoIdSet = new Set(demoIds.keys());
  const demoIdsOf = (sfObject) => [...demoIds.values()].filter((x) => x.sfObject === sfObject).map((x) => x.id);
  /** The records Salesforce says are in the demo tenant (falls back to the id-map when that read failed). */
  const liveSetOf = (sfObject) => (live.has(sfObject) ? new Set(live.get(sfObject).keys()) : new Set((seeded.get(sfObject) || []).map((x) => id15(x.id))));
  const inLiveDemo = (id) => {
    const sfObject = objectOfId(id);
    return !!sfObject && !!live.get(sfObject)?.has(id15(id));
  };
  facts.demoIdCount = demoIdSet.size;

  /**
   * Ids found where only demo records belong, but which are not in the demo tenant's set:
   * ask Salesforce what they are. "gone" (deleted — a leftover row, not a leak), "other"
   * (a record of another tenant, of no tenant, or of an object that has no tenant),
   * "demo" (it is in the demo tenant after all), "unknown" (not a Sundial record id).
   * Costs no query when there is nothing to look up.
   * @returns {Promise<Map<string, { state: string, tenant?: string|null }>>} by 15-character id
   */
  const lookUp = async (ids) => {
    const out = new Map();
    const byObject = new Map();
    for (const id of new Set(ids.map(String))) {
      const sfObject = objectOfId(id);
      if (!sfObject) { out.set(id15(id), { state: "unknown" }); continue; }
      if (!byObject.has(sfObject)) byObject.set(sfObject, []);
      byObject.get(sfObject).push(id);
    }
    for (const [sfObject, list] of byObject) {
      const ob = objects.get(sfObject);
      const found = new Map();
      for (const part of chunk(list, SOQL_ID_CHUNK)) {
        for (const r of await q(`SELECT ${ob.tenantField ? "Id, Client__c" : "Id"} FROM ${sfObject} WHERE Id IN (${inList(part)})`)) found.set(id15(r.Id), r);
      }
      for (const id of list) {
        const r = found.get(id15(id));
        if (!r) out.set(id15(id), { state: "gone" });
        else if (ob.tenantField && isDemoTenant(r.Client__c)) out.set(id15(id), { state: "demo" });
        else out.set(id15(id), { state: "other", tenant: ob.tenantField ? r.Client__c ?? null : undefined });
      }
    }
    return out;
  };
  const whose = (hit) => (hit.state === "unknown" ? "no Sundial object this script knows" : hit.tenant === undefined ? "an object with no tenant" : tenantLabel(hit.tenant));

  // --- A5: tenant-less records created since the seed ------------------------------------------
  await step("A5", async () => {
    const anchorMs = Date.parse(`${idmap.anchor?.date ?? ""}T00:00:00Z`);
    const fromMs = Number.isFinite(anchorMs) ? anchorMs - 86400000 : now.getTime() - 30 * 86400000;
    const since = new Date(fromMs).toISOString().replace(/\.\d{3}Z$/, "Z");
    const found = [];
    let checked = 0;
    for (const ob of tenantObjects) {
      if (!ob.fields.has("CreatedDate")) continue;
      checked++;
      const where = `Client__c = null AND CreatedDate >= ${since}`;
      const n = countOf(await q(`SELECT COUNT(Id) c FROM ${ob.name} WHERE ${where}`));
      if (!n) continue;
      const rows = await q(`SELECT Id FROM ${ob.name} WHERE ${where} ORDER BY CreatedDate LIMIT 20`);
      found.push(`${ob.name}: ${n} with no tenant${ob.tenantNillable ? "" : " (the field is required — these pre-date that rule or were written around it)"} — ${rows.map((r) => r.Id).join(", ")}${n > rows.length ? ", …" : ""}`);
    }
    facts.a5 = { since, found: found.length };
    if (found.length) R.fail("A5", `records with NO tenant were created since ${since} — a seeded record that lost its tenant would be one of these`, found);
    else R.pass("A5", `no record without a tenant has been created since ${since}${Number.isFinite(anchorMs) ? " (the day before the seed)" : " (the id-map has no anchor date; the last 30 days were checked)"} — ${checked} objects`);
  });

  // --- A6: links across the tenant line, both ways ---------------------------------------------
  await step("A6a", async () => {
    const bad = [];
    const outsideSet = [];
    let lookups = 0;
    let records = 0;
    for (const ob of tenantObjects) {
      const map = live.get(ob.name);
      if (!map) continue;
      for (const r of map.values()) {
        records++;
        for (const l of ob.links) {
          const v = r[l.field];
          if (v == null || v === "") continue;
          lookups++;
          if (!inLiveDemo(v)) bad.push(`${r.Id} (${ob.name}).${l.field} -> ${naming(v)}, which is not a demo-tenant record`);
        }
        for (const l of ob.outside) if (r[l.field] != null && r[l.field] !== "") outsideSet.push(`${r.Id} (${ob.name}).${l.field} is set (a lookup to ${l.targets.join(" / ") || "another object"})`);
      }
    }
    facts.a6a = { lookups, bad: bad.length };
    if (liveFailed.size) R.error("A6a", `not complete: the demo tenant's records of ${[...liveFailed].join(", ")} could not be read (see A4)`);
    if (bad.length) R.fail("A6a", `${plural(bad.length, "lookup")} on a demo record ${bad.length === 1 ? "points" : "point"} OUTSIDE the demo tenant`, bad);
    else if (!liveFailed.size) R.pass("A6a", `every lookup on a demo record points to a demo record or is empty (${num(lookups)} filled lookups on ${num(records)} records)`);
    if (outsideSet.length) R.info("A6a", `${plural(outsideSet.length, "lookup")} to a non-Sundial object ${outsideSet.length === 1 ? "is" : "are"} filled on demo records (the seed never writes these — something else did)`, outsideSet);
  });

  await step("A6b", async () => {
    const bad = [];
    let fieldsChecked = 0;
    let queries = 0;
    for (const ob of objects.values()) {
      for (const l of ob.links) {
        const targetIds = l.targets.flatMap((t) => (t === TENANT_OBJECT ? [demoTenantId] : demoIdsOf(t)));
        if (!targetIds.length) continue; // nothing of the demo's to point at
        fieldsChecked++;
        const outsideTenant = ob.tenantField ? `(Client__c != ${soqlQuote(demoTenantId)} OR Client__c = null) AND ` : "";
        for (const part of chunk(targetIds, SOQL_ID_CHUNK)) {
          queries++;
          const rows = await q(`SELECT Id, ${l.field} FROM ${ob.name} WHERE ${outsideTenant}${l.field} IN (${inList(part)})`);
          for (const r of rows) {
            bad.push(`${r.Id} (${ob.name}${ob.tenantField ? "" : ", an object with no tenant"}).${l.field} -> demo record ${naming(r[l.field])}`);
          }
        }
      }
    }
    facts.a6b = { fieldsChecked, bad: bad.length };
    if (bad.length) R.fail("A6b", `${plural(bad.length, "record")} OUTSIDE the demo tenant ${bad.length === 1 ? "points" : "point"} AT a demo record`, bad);
    else R.pass("A6b", `no record outside the demo tenant points at a demo record (${fieldsChecked} lookup fields, ${queries} queries)`);
    if (untenanted.length) R.info("A6b", `objects with no tenant lookup (any row pointing at a demo record counts as outside): ${untenanted.map((ob) => (ob.fields.has("Client__c") ? `${ob.name} (its Client__c points to ${(ob.fields.get("Client__c").referenceTo || []).join(" / ") || "something else"})` : ob.name)).join(", ")}`);
  });

  // --- B4a (a Salesforce query): the demo logins resolve only into the demo tenant ---------------
  // lib/identity.js finds the signed-in person with
  //   SELECT … FROM Sundial_User__c WHERE Supabase_User_Id__c = '<auth uuid>' LIMIT 1
  // — with NO tenant filter. A second user record carrying a demo login's uuid, in another
  // tenant, could therefore be the one that is picked.
  const authUsers = Object.entries(idmap.supabase?.authUsers || {}).filter(([, uuid]) => typeof uuid === "string" && uuid);
  const demoAuth = new Set(authUsers.map(([, uuid]) => lower(uuid)));
  for (const r of live.get("Sundial_User__c")?.values() || []) if (r.Supabase_User_Id__c) demoAuth.add(lower(r.Supabase_User_Id__c));
  /** The same, as far as they are uuids — a uuid column cannot be asked for anything else. */
  const demoAuthUuids = [...demoAuth].filter((u) => UUID_RE.test(u));
  await step("B4a", async () => {
    const userObject = objects.get("Sundial_User__c");
    if (!userObject?.fields.has("Supabase_User_Id__c")) return R.error("B4a", "Sundial_User__c.Supabase_User_Id__c is not in the describe — the logins could not be checked");
    if (!demoAuth.size) return R.skip("B4a", "the id-map records no demo login and no demo user carries one");
    const bad = [];
    const byUuid = new Map();
    for (const part of chunk([...demoAuth], SOQL_ID_CHUNK)) {
      const rows = await q(`SELECT Id, Client__c, Supabase_User_Id__c FROM Sundial_User__c WHERE Supabase_User_Id__c IN (${inList(part)})`);
      for (const r of rows) {
        const u = lower(r.Supabase_User_Id__c);
        if (!byUuid.has(u)) byUuid.set(u, []);
        byUuid.get(u).push(r);
        if (!isDemoTenant(r.Client__c)) bad.push(`${r.Id} (Sundial_User__c) in ${tenantLabel(r.Client__c)} carries a demo login's id`);
      }
    }
    for (const [key, uuid] of authUsers) {
      const rows = (byUuid.get(lower(uuid)) || []).filter((r) => isDemoTenant(r.Client__c));
      const want = idmap.ids[key];
      if (rows.length === 0) bad.push(`${key}: no demo-tenant user record carries this login's id`);
      else if (rows.length > 1) bad.push(`${key}: ${rows.length} demo user records carry this login's id (${rows.map((r) => r.Id).join(", ")})`);
      else if (want && id15(rows[0].Id) !== id15(want)) bad.push(`${key}: the login is bound to ${rows[0].Id}, the id-map says ${want}`);
    }
    facts.b4a = { logins: authUsers.length, bad: bad.length };
    if (bad.length) R.fail("B4a", `a demo login does not resolve cleanly into the demo tenant`, bad);
    else R.pass("B4a", `${plural(demoAuth.size, "demo login")}: each is on exactly one Sundial_User__c, in the demo tenant, and on no user record of another tenant`);
  });

  // --- A7: the primary tenant's numbers, for the record -----------------------------------------
  await step("A7", async () => {
    const lines = [];
    for (const ob of tenantObjects) {
      const n = countOf(await q(`SELECT COUNT(Id) c FROM ${ob.name} WHERE Client__c = ${soqlQuote(primaryId)}`));
      lines.push(`${ob.name.padEnd(30)} ${o.primary.slug} ${num(n).padStart(8)}   demo ${num(live.get(ob.name)?.size ?? 0).padStart(5)}`);
    }
    R.info("A7", `record counts of the primary tenant, to compare with what you know (the demo's records are not in them)`, lines);
  });
  R.info("A", `section A issued ${stats.sectionAQueries} Salesforce queries and ${stats.salesforceDescribes} describes`);

  // =========================================================================================
  // SECTION B — Supabase (service role, select only)
  // =========================================================================================
  section = "B";
  log("");
  log("SECTION B — Supabase (select only)");
  let supabase = null;
  try {
    supabase = await io.getSupabase();
  } catch (e) {
    R.error("B", `Supabase could not be opened — section B was not run: ${safeError(e)}`);
  }

  /**
   * Read every row a filter matches. The first request asks for the exact count, so a
   * project whose "Max Rows" setting is below the page size cannot end the read early.
   * @returns {Promise<{ rows: object[], error: object|null }>}
   */
  const readAll = async (table, columns, filter, orderBy) => {
    const rows = [];
    let total = null;
    for (let guard = 0; guard < 500; guard++) {
      let qb = supabase.from(table).select(columns, rows.length === 0 ? { count: "exact" } : {});
      qb = filter(qb).order(orderBy, { ascending: true }).range(rows.length, rows.length + SUPABASE_PAGE - 1);
      stats.supabaseReads++;
      const { data, error, count } = await qb;
      if (error) return { rows, error };
      if (rows.length === 0 && typeof count === "number") total = count;
      const batch = data || [];
      rows.push(...batch);
      if (batch.length === 0) break;
      if (total !== null ? rows.length >= total : batch.length < SUPABASE_PAGE) break;
    }
    if (total !== null && rows.length < total) return { rows, error: { code: "SHORT_READ", message: `read ${rows.length} of ${total} rows` } };
    return { rows, error: null };
  };
  /** key -> how many demo records the cache holds under the demo tenant (B2). Unset: not known. */
  const cachedByKey = new Map();
  const bothForms = (ids) => [...new Set(ids.flatMap((id) => [String(id), id15(id)]))];
  const tenantForms = bothForms([demoTenantId]);
  /** Report a table that could not be read: SKIP when it does not exist, ERROR otherwise. @returns true when handled */
  const tableProblem = (check, table, error, skipped) => {
    if (isMissingTable(error)) {
      skipped.push(`${table} (${error.code || "missing"})`);
      return true;
    }
    R.error(check, `${table} could not be read: ${dbError(error)}`);
    return true;
  };

  if (supabase) {
    // --- B1: no cache row for a demo record under another tenant ------------------------------
    // THE check that a demo record cannot be served to another tenant from the list cache:
    // the portal's lists read `… where client_sf_id = <the signed-in user's tenant>`.
    // cache-sync writes sf_id = the record's 18-character Id; both forms are looked up
    // because a row written by something else may hold the 15-character one.
    await step("B1", async () => {
      const bad = [];
      const skipped = [];
      let rowsSeen = 0;
      let tables = 0;
      let failedTables = 0;
      for (const [key, { sfObject, cacheTable }] of Object.entries(CACHE_OBJECTS)) {
        const ids = demoIdsOf(sfObject);
        if (!ids.length) continue;
        let failed = false;
        for (const part of chunk(ids, SUPABASE_ID_CHUNK)) {
          const values = bothForms(part);
          const { rows, error } = await readAll(cacheTable, "sf_id,client_sf_id,tenant_id", (b) => b.in("sf_id", values), "sf_id");
          if (error) { failed = tableProblem("B1", cacheTable, error, skipped); break; }
          for (const r of rows) {
            rowsSeen++;
            if (!isDemoTenant(r.client_sf_id)) bad.push(`${cacheTable}: the row for demo record ${r.sf_id} (${key}) is stamped client_sf_id = ${r.client_sf_id ?? "null"}${tenantSlugOf.has(id15(r.client_sf_id)) ? ` (${tenantSlugOf.get(id15(r.client_sf_id))})` : ""}`);
            else if (r.tenant_id !== demoSlug) bad.push(`${cacheTable}: the row for demo record ${r.sf_id} (${key}) has tenant_id = "${r.tenant_id ?? "null"}", not "${demoSlug}"`);
          }
        }
        if (failed) failedTables++;
        else tables++;
      }
      facts.b1 = { rows: rowsSeen, bad: bad.length, tables };
      if (skipped.length) R.skip("B1", `cache table(s) not there, not checked: ${skipped.join(", ")}`);
      if (bad.length) R.fail("B1", `${plural(bad.length, "cache row")} for a demo record ${bad.length === 1 ? "is" : "are"} NOT stamped with the demo tenant — that row would be served to another tenant`, bad);
      else if (tables) R.pass("B1", `${num(rowsSeen)} cache ${rowsSeen === 1 ? "row exists" : "rows exist"} for demo records in ${tables} cache tables; every one is stamped client_sf_id = demo tenant and tenant_id = "${demoSlug}"${rowsSeen === 0 ? " (none yet — normal before the sync)" : ""}${failedTables ? ` — ${failedTables} table(s) not checked, see above` : ""}`);
    });

    // --- B2: what the cache holds under the demo tenant ---------------------------------------
    await step("B2", async () => {
      const foreign = [];
      const strangers = []; // { cacheTable, sf_id } — rows under the demo tenant for a record that is not in its set
      const short = [];
      const lines = [];
      const skipped = [];
      let total = 0;
      let expectedTotal = 0;
      for (const [key, { sfObject, cacheTable }] of Object.entries(CACHE_OBJECTS)) {
        const { rows, error } = await readAll(cacheTable, "sf_id,client_sf_id,tenant_id", (b) => b.in("client_sf_id", tenantForms), "sf_id");
        if (error) { tableProblem("B2", cacheTable, error, skipped); continue; }
        const expected = liveSetOf(sfObject);
        const have = new Set(rows.map((r) => id15(r.sf_id)));
        total += have.size;
        expectedTotal += expected.size;
        for (const r of rows) {
          if (!expected.has(id15(r.sf_id))) strangers.push({ cacheTable, sf_id: r.sf_id });
          else if (r.tenant_id !== demoSlug) foreign.push(`${cacheTable}: the demo row ${r.sf_id} has tenant_id = "${r.tenant_id ?? "null"}", not "${demoSlug}"`);
        }
        if (rows.length !== have.size) foreign.push(`${cacheTable}: ${rows.length - have.size} duplicate row(s) for the same record under the demo tenant`);
        const missing = [...expected].filter((x) => !have.has(x));
        cachedByKey.set(key, expected.size - missing.length);
        if (o.afterSync && missing.length) short.push(`${cacheTable} (${key}): ${have.size} of ${expected.size} demo records are cached — missing ${missing.slice(0, 8).map((x) => demoIds.get(x)?.id ?? x).join(", ")}${missing.length > 8 ? `, … ${missing.length - 8} more` : ""}`);
        if (have.size || expected.size) lines.push(`${cacheTable.padEnd(32)} cached ${String(have.size).padStart(4)}   in Salesforce ${String(expected.size).padStart(4)}`);
      }
      // A row for a record Salesforce no longer has is a leftover ("ghost"), not another tenant's record.
      const ghosts = [];
      const known = await lookUp(strangers.map((x) => x.sf_id));
      for (const x of strangers) {
        const hit = known.get(id15(x.sf_id));
        if (hit.state === "gone") ghosts.push(`${x.cacheTable}: ${x.sf_id} — the record was deleted in Salesforce`);
        else if (hit.state !== "demo") foreign.push(`${x.cacheTable}: a row stamped with the demo tenant is for ${naming(x.sf_id)}, which belongs to ${whose(hit)}`);
      }
      total -= ghosts.length;
      facts.b2 = { total, expectedTotal, foreign: foreign.length, short: short.length };
      if (skipped.length) R.skip("B2", `cache table(s) not there, not counted: ${skipped.join(", ")}`);
      if (ghosts.length) R.info("B2", `${plural(ghosts.length, "cache row")} under the demo tenant ${ghosts.length === 1 ? "is" : "are"} for a demo record that was since deleted in Salesforce (it shows in the demo's lists until someone opens it; the sync's "reconcile" mode removes it)`, ghosts);
      if (foreign.length) R.fail("B2", `the cache holds ${plural(foreign.length, "row")} under the demo tenant that ${foreign.length === 1 ? "does" : "do"} not belong there — ${foreign.length === 1 ? "it" : "they"} would show in the DEMO portal`, foreign);
      if (o.afterSync) {
        if (short.length) R.fail("B2", `after the sync the cache does not hold every demo record (not a leak: the demo's lists would be incomplete — run the sync again, or a full resync of that object)`, short);
        else if (!foreign.length) R.pass("B2", `the cache holds exactly the demo tenant's ${num(expectedTotal)} cacheable records under the demo tenant`, lines);
      } else {
        R.info("B2", `${num(total)} of ${num(expectedTotal)} cacheable demo records are in the cache under the demo tenant (0 is expected before the sync${total ? "; rows are there already because the demo portal was opened or the sync has run" : ""})`, total ? lines : []);
      }
    });

    // --- B3: notes, activity, texts, notifications, files -------------------------------------
    await step("B3", async () => {
      const bad = [];
      const strangers = []; // { table, row, col, id }
      const skipped = [];
      const counts = [];
      const allIds = [...demoIds.values()].map((x) => x.id);
      for (const t of RECORD_TABLES) {
        const columns = [...new Set([t.pk, t.tenantCol, ...(t.slugCol ? [t.slugCol] : []), ...t.refs, ...t.auth])].join(",");
        let failed = false;
        // (1) every row that names a demo record (or a demo login) must carry the demo tenant
        const naming1 = new Map(); // pk -> row
        for (const col of t.refs) {
          for (const part of chunk(allIds, SUPABASE_ID_CHUNK)) {
            const { rows, error } = await readAll(t.table, columns, (b) => b.in(col, bothForms(part)), t.pk);
            if (error) { failed = tableProblem("B3", t.table, error, skipped); break; }
            for (const r of rows) naming1.set(r[t.pk], r);
          }
          if (failed) break;
        }
        for (const col of failed ? [] : t.auth) {
          for (const part of chunk(demoAuthUuids, SUPABASE_ID_CHUNK)) {
            const { rows, error } = await readAll(t.table, columns, (b) => b.in(col, part), t.pk);
            if (error) { failed = tableProblem("B3", t.table, error, skipped); break; }
            for (const r of rows) naming1.set(r[t.pk], r);
          }
          if (failed) break;
        }
        if (failed) continue;
        for (const r of naming1.values()) {
          if (isDemoTenant(r[t.tenantCol])) continue;
          const what = [...t.refs.filter((c) => demoIdSet.has(id15(r[c]))).map((c) => `${c} = demo record ${r[c]}`), ...t.auth.filter((c) => demoAuth.has(lower(r[c]))).map((c) => `${c} = a demo login`)];
          bad.push(`${t.table} row ${r[t.pk]}: ${what.join(", ")} but ${t.tenantCol} = ${r[t.tenantCol] ?? "null"}${tenantSlugOf.has(id15(r[t.tenantCol])) ? ` (${tenantSlugOf.get(id15(r[t.tenantCol]))})` : ""}`);
        }
        // (2) every row that carries the demo tenant must be about demo records only
        const { rows: mine, error } = await readAll(t.table, columns, (b) => b.in(t.tenantCol, tenantForms), t.pk);
        if (error) { tableProblem("B3", t.table, error, skipped); continue; }
        let odd = 0;
        for (const r of mine) {
          for (const col of t.refs) {
            const v = r[col];
            if (v == null || v === "") continue;
            if (!isSfId(v)) { odd++; continue; }
            if (!demoIdSet.has(id15(v))) strangers.push({ table: t.table, row: r[t.pk], col, id: v });
          }
          for (const col of t.auth) {
            const v = r[col];
            if (v != null && v !== "" && !demoAuth.has(lower(v))) bad.push(`${t.table} row ${r[t.pk]} carries the demo tenant but ${col} is not a demo login`);
          }
          if (t.slugCol && r[t.slugCol] != null && r[t.slugCol] !== demoSlug) bad.push(`${t.table} row ${r[t.pk]} carries the demo tenant but ${t.slugCol} = "${r[t.slugCol]}"`);
        }
        counts.push(`${t.table.padEnd(26)} ${String(mine.length).padStart(5)} rows under the demo tenant, ${String(naming1.size).padStart(5)} naming a demo record or login${odd ? ` (${odd} values that are not record ids were left alone)` : ""}`);
      }
      // A row about a demo record that was since deleted in Salesforce is a leftover, not a leak.
      const known = await lookUp(strangers.map((x) => x.id));
      const leftovers = [];
      const notRecords = [];
      for (const x of strangers) {
        const hit = known.get(id15(x.id));
        if (hit.state === "gone") leftovers.push(`${x.table} row ${x.row}: ${x.col} = ${x.id}`);
        else if (hit.state === "unknown") notRecords.push(`${x.table} row ${x.row}: ${x.col} = ${x.id}`);
        else if (hit.state !== "demo") bad.push(`${x.table} row ${x.row} carries the demo tenant but ${x.col} = ${naming(x.id)}, which belongs to ${whose(hit)}`);
      }
      facts.b3 = { bad: bad.length, tables: counts.length };
      if (skipped.length) R.skip("B3", `table(s) not there, not checked: ${skipped.join(", ")}`);
      if (leftovers.length) R.info("B3", `${plural(leftovers.length, "row")} under the demo tenant ${leftovers.length === 1 ? "names" : "name"} a record that no longer exists in Salesforce (deleted since — not another tenant's record)`, leftovers);
      if (notRecords.length) R.info("B3", `${plural(notRecords.length, "row")} under the demo tenant ${notRecords.length === 1 ? "holds" : "hold"} an id-shaped value that is not the id of any Sundial object (so not a record the portal serves)`, notRecords);
      if (bad.length) R.fail("B3", `${plural(bad.length, "row")} in the notes / activity / text / notification / file tables ${bad.length === 1 ? "crosses" : "cross"} the tenant line`, bad);
      else if (counts.length) R.pass("B3", `notes, activity, texts, notifications, files: every row about a demo record carries the demo tenant, and every row under the demo tenant is about demo records (${counts.length} tables)`, counts);
    });

    // --- B4: the demo logins' profile rows (what Supabase's row-level security reads) ------------
    await step("B4", async () => {
      const bad = [];
      const columns = "id,tenant_id,sundial_user_id";
      const seen = new Map();
      const uuids = demoAuthUuids;
      const demoUsers = demoIdsOf("Sundial_User__c");
      const reads = [
        ...chunk(uuids, SUPABASE_ID_CHUNK).map((part) => (b) => b.in("id", part)),
        ...chunk(demoUsers, SUPABASE_ID_CHUNK).map((part) => (b) => b.in("sundial_user_id", bothForms(part))),
        (b) => b.in("tenant_id", tenantForms),
      ];
      for (const filter of reads) {
        const { rows, error } = await readAll("profiles", columns, filter, "id");
        if (error) {
          if (isMissingTable(error)) return R.skip("B4", `profiles is not there (${error.code || "missing"}) — not checked`);
          return R.error("B4", `profiles could not be read: ${dbError(error)}`);
        }
        for (const r of rows) seen.set(lower(r.id), r);
      }
      let present = 0;
      for (const r of seen.values()) {
        const isDemoLogin = demoAuth.has(lower(r.id));
        if (isDemoLogin) present++;
        if (isDemoLogin && !isDemoTenant(r.tenant_id)) bad.push(`the profile of demo login ${r.id} has tenant_id = ${r.tenant_id ?? "null"}${tenantSlugOf.has(id15(r.tenant_id)) ? ` (${tenantSlugOf.get(id15(r.tenant_id))})` : ""} — row-level security would treat that login as the other tenant's`);
        if (isDemoLogin && r.sundial_user_id && !demoIdSet.has(id15(r.sundial_user_id))) bad.push(`the profile of demo login ${r.id} points at ${naming(r.sundial_user_id)}, which is not a demo user`);
        if (!isDemoLogin && isDemoTenant(r.tenant_id)) bad.push(`profile ${r.id} is NOT a demo login but has tenant_id = the demo tenant — that login would read the demo's notes`);
        if (!isDemoLogin && r.sundial_user_id && demoIdSet.has(id15(r.sundial_user_id))) bad.push(`profile ${r.id} is NOT a demo login but points at demo user ${r.sundial_user_id}`);
      }
      facts.b4 = { present, logins: uuids.length, bad: bad.length };
      if (bad.length) R.fail("B4", `a profile row puts a login in the wrong tenant`, bad);
      else R.pass("B4", `${present} of ${uuids.length} demo logins have a profile row, each with tenant_id = the demo tenant; no other profile carries the demo tenant or a demo user${present < uuids.length ? " (a missing row is created at that person's first login)" : ""}`);
    });
  }

  // =========================================================================================
  // SECTION C — the portal's own API, as real logins
  // =========================================================================================
  section = "C";
  log("");
  log("SECTION C — the portal API, signed in (GET only)");
  if (o.skipApi) {
    R.skip("C", "--skip-api: the portal API was not called. Sections A and B say the data is separated; only section C shows what a signed-in user is actually served.");
    return finish();
  }

  /** One GET. A 5xx, a 429 or a network failure is tried once more. Never throws. */
  const apiGet = async (token, path) => {
    let last = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt) await sleep(o.retryDelayMs);
      stats.apiRequests++;
      try {
        const res = await io.fetch(`${o.apiBase}${path}`, { method: "GET", headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
        const text = await res.text();
        let json = null;
        try { json = JSON.parse(text); } catch { json = null; }
        last = { status: res.status, text, json };
        if (res.status >= 500 || res.status === 429) continue;
        return last;
      } catch (e) {
        last = { status: null, text: "", json: null, failure: e?.name === "TimeoutError" ? "timed out" : "network failure" };
      }
    }
    return last;
  };
  const pooled = async (items, fn) => {
    const out = new Array(items.length);
    let next = 0;
    const worker = async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
        await sleep(o.delayMs);
      }
    };
    await Promise.all(Array.from({ length: Math.min(o.concurrency, items.length) }, worker));
    return out;
  };
  const statusText = (r) => (r.status === null ? r.failure : `HTTP ${r.status}${r.json?.code ? ` ${String(r.json.code).slice(0, 40)}` : ""}`);
  /**
   * What a single-record read said: "served" (200), "refused" (the portal's own "not found",
   * or its own "forbidden"), or "error". A 404 that is not the portal's RECORD_NOT_FOUND —
   * an API Gateway "route not found", a wrong base URL — proves nothing and is an error,
   * as is a 403 that only says the login is not a portal user.
   */
  const verdictOf = (r) => {
    if (r.status === 200) return "served";
    if (r.status === 404 && r.json?.code === "RECORD_NOT_FOUND") return "refused";
    if (r.status === 403 && typeof r.json?.code === "string" && !IDENTITY_CODES.has(r.json.code)) return "refused";
    return "error";
  };
  const signIn = async (check, who, email, password) => {
    if (!password) { R.error(check, `${who}: no password for that login in Secrets Manager`); return null; }
    stats.logins++;
    const r = await io.loginAs(email, password);
    if (!r?.token) { R.error(check, `${who}: the sign-in was refused (HTTP ${r?.status ?? "?"})`); return null; }
    return r.token;
  };
  const whoAmI = async (token) => {
    const r = await apiGet(token, "/auth/me");
    return { r, clientId: r.json?.tenant?.clientId ?? null, slug: r.json?.tenant?.slug ?? null, scope: r.json?.user?.access?.scope ?? null };
  };

  // The primary tenant's designated TEST records (CLAUDE.md: never a live customer). Used as
  // the control for the primary test login, and as what the demo login must be refused.
  const zz = { customer: [], solar: [], roofing: [] };
  await step("C", async () => {
    const customers = await q(`SELECT Id FROM Sundial_Customer__c WHERE Client__c = ${soqlQuote(primaryId)} AND Name LIKE 'ZZ PORTAL TEST%'`);
    zz.customer = customers.map((r) => r.Id);
    for (const part of chunk(zz.customer, SOQL_ID_CHUNK)) {
      zz.solar.push(...(await q(`SELECT Id FROM Sundial_Solar__c WHERE Client__c = ${soqlQuote(primaryId)} AND Sundial_Customer__c IN (${inList(part)})`)).map((r) => r.Id));
      zz.roofing.push(...(await q(`SELECT Id FROM Sundial_Roofing__c WHERE Client__c = ${soqlQuote(primaryId)} AND Sundial_Customer__c IN (${inList(part)})`)).map((r) => r.Id));
    }
  });

  try {
    if (io.resolveSupabasePublic) io.resolveSupabasePublic();
  } catch (e) {
    R.error("C1", `the Supabase URL and publishable key could not be resolved, so nobody can be signed in — section C was not run: ${safeError(e)}`);
    return finish();
  }

  // --- C1: sign in as the primary tenant's ZZ TEST user -----------------------------------------
  let primaryToken = null;
  let primaryWho = null;
  let abortC = false;
  await step("C1", async () => {
    const passwords = (await io.getSecret(TEST_USERS_SECRET)) || {};
    let token = null;
    const tried = [];
    for (const slug of PRIMARY_TEST_USER_SLUGS) {
      const email = o.testUserEmail(slug);
      if (!passwords[email]) { tried.push(`${email}: no password in ${TEST_USERS_SECRET}`); continue; }
      stats.logins++;
      let r;
      try {
        r = io.loginAsTestUser ? await io.loginAsTestUser(slug, passwords) : await io.loginAs(email, passwords[email]);
      } catch (e) {
        tried.push(`${email}: ${safeError(e)}`);
        continue;
      }
      if (r?.token) { token = r.token; primaryWho = email; break; }
      tried.push(`${email}: the sign-in was refused (HTTP ${r?.status ?? "?"})`);
    }
    if (!token) return R.error("C1", `could not sign in as a ${o.primary.slug} ZZ TEST user — the rest of C1–C3 was not run`, tried);
    const me = await whoAmI(token);
    if (me.r.status !== 200) return R.error("C1", `${primaryWho}: GET /auth/me answered ${statusText(me.r)} — the rest of C1–C3 was not run`);
    if (!isPrimaryTenant(me.clientId)) {
      abortC = true;
      return R.fail("C1", `test user is not a Harmon tenant-scope user: ${primaryWho} resolves to ${tenantLabel(me.clientId)}, not the primary tenant "${o.primary.slug}" — the rest of section C was not run`);
    }
    if (me.scope !== null && me.scope !== "tenant") {
      abortC = true;
      return R.fail("C1", `test user is not a Harmon tenant-scope user: ${primaryWho} has scope "${me.scope}" — a refusal would prove nothing about the tenant. The rest of section C was not run`);
    }
    primaryToken = token;
    R.pass("C1", `signed in as the ${o.primary.slug} ZZ TEST user ${primaryWho}; /auth/me says tenant ${me.clientId}${me.slug ? ` (${me.slug})` : ""}${me.scope ? `, scope ${me.scope}` : ""}`);
    // The control: this login CAN read its own tenant's test record, so a "not found"
    // below is a refusal and not a login, a base URL or a route that does not work.
    if (zz.customer.length) {
      const c = await apiGet(token, `/sf/customer/${zz.customer[0]}?full=true`);
      if (c.status !== 200) {
        primaryToken = null;
        return R.error("C1", `control failed: the ${o.primary.slug} test user could not read its OWN test customer ${zz.customer[0]} (${statusText(c)}), so a refusal of a demo record would prove nothing — C2 and C3 were not run`);
      }
      R.info("C1", `control: the same login reads its own tenant's test customer ${zz.customer[0]} (HTTP 200)`);
    } else {
      R.info("C1", `no "ZZ PORTAL TEST" customer was found in the primary tenant, so there is no control read for this login`);
    }
  });

  if (primaryToken) {
    // --- C2: single-record reads of demo records must never be served ---------------------------
    await step("C2", async () => {
      const requests = [];
      const perKey = new Map();
      const plan = (key, size) => {
        const sfObject = CACHE_OBJECTS[key].sfObject;
        const all = demoIdsOf(sfObject);
        const ids = size === null ? [...all].sort() : sampleIds(all, size);
        perKey.set(key, { asked: ids.length, of: all.length, refused: 0, served: [], errors: [] });
        for (const id of ids) requests.push({ key, id, path: `/sf/${key}/${id}`, bucket: key });
      };
      for (const key of C2_EVERY) plan(key, o.quick ? C2_QUICK_SIZE : null);
      for (const key of C2_SAMPLED) plan(key, o.quick ? C2_QUICK_SIZE : C2_SAMPLE_SIZE);
      // ?full=true is a different code path (live Salesforce, every field, no cache).
      for (const key of C2_FULL_KEYS) {
        const bucket = `${key} ?full=true`;
        const ids = sampleIds(demoIdsOf(CACHE_OBJECTS[key].sfObject), C2_FULL_SIZE);
        perKey.set(bucket, { asked: ids.length, of: ids.length, refused: 0, served: [], errors: [] });
        for (const id of ids) requests.push({ key, id, path: `/sf/${key}/${id}?full=true`, bucket });
      }
      await pooled(requests, async (req) => {
        const r = await apiGet(primaryToken, req.path);
        const b = perKey.get(req.bucket);
        const v = verdictOf(r);
        if (v === "refused") b.refused++;
        else if (v === "served") b.served.push(`${req.id} — GET ${req.path} returned 200 to the ${o.primary.slug} user`);
        else b.errors.push(`GET ${req.path}: ${statusText(r)}`);
      });
      const lines = [...perKey].map(([bucket, b]) => `${bucket.padEnd(22)} ${String(b.refused).padStart(4)} of ${String(b.asked).padStart(4)} refused${b.asked < b.of ? ` (a sample of ${b.of})` : ""}`);
      const served = [...perKey.values()].flatMap((b) => b.served);
      const errors = [...perKey.values()].flatMap((b) => b.errors);
      const refused = [...perKey.values()].reduce((s, b) => s + b.refused, 0);
      facts.c2 = { asked: requests.length, refused, served: served.length, errors: errors.length, who: primaryWho };
      if (served.length) R.fail("C2", `the ${o.primary.slug} user WAS SERVED ${plural(served.length, "demo record")}`, served);
      if (errors.length) R.error("C2", `${plural(errors.length, "read")} did not get a clear answer (neither served nor the portal's "not found") — not counted as refused`, errors);
      if (!served.length && !errors.length) R.pass("C2", `the ${o.primary.slug} user was refused ${num(refused)} of ${num(requests.length)} demo records (GET /sf/{object}/{id})`, lines);
      else R.info("C2", `${num(refused)} of ${num(requests.length)} refused`, lines);
    });

    // --- C3: searches, small lists and the dispatch board must hold no demo id -------------------
    await step("C3", async () => {
      const customerObject = objects.get("Sundial_Customer__c");
      const sampleCustomers = sampleIds([...liveSetOf("Sundial_Customer__c")].map((x) => demoIds.get(x)?.id ?? x), 10);
      let named = [];
      if (sampleCustomers.length) {
        const fields = ["Id", "Name", ...(customerObject?.fields.has("Primary_Phone__c") ? ["Primary_Phone__c"] : [])];
        // Tenant-bound on purpose: only a demo customer's (fictional) name and phone are ever read.
        named = await q(`SELECT ${fields.join(", ")} FROM Sundial_Customer__c WHERE Client__c = ${soqlQuote(demoTenantId)} AND Id IN (${inList(sampleCustomers)})`);
      }
      const probes = [];
      // `list`: the key the answer must carry its rows under — an answer without it is not the
      // answer this script expects, and is reported instead of being scanned as "nothing found".
      for (const c of named) if (c.Name && String(c.Name).trim().length >= 2) probes.push({ label: `search "${c.Name}"`, path: `/sf/customer?q=${encodeURIComponent(c.Name)}`, list: "records" });
      // The search matches phone columns on digits when the term is a number (phonePattern in
      // sundial-sf-query). A phone is never printed: a "live demo" customer may carry the owner's own.
      const phones = [];
      for (const c of named) {
        const digits = String(c.Primary_Phone__c ?? "").replace(/\D/g, "");
        if (digits.length >= 10 && phones.length < 3 && !phones.some((x) => x.digits === digits)) phones.push({ digits, id: c.Id });
      }
      for (const ph of phones) probes.push({ label: `search by the phone of demo customer ${ph.id}`, path: `/sf/customer?q=${ph.digits}`, shown: `/sf/customer?q=<the phone of demo customer ${ph.id}>`, list: "records" });
      for (const key of C3_SMALL_LISTS) probes.push({ label: `list ${key}`, path: `/sf/${key}?limit=${LIST_PAGE}`, paged: key, list: "records" });
      probes.push({ label: "users lookup", path: "/sf/users", list: "users" });
      // The board: the fortnight around the seed, and around today if the demo was freshened since.
      const day = 86400000;
      const anchorMs = Date.parse(`${idmap.anchor?.date ?? ""}T00:00:00Z`);
      const windows = [];
      if (Number.isFinite(anchorMs)) windows.push([anchorMs - 10 * day, anchorMs + 8 * day]);
      const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
      if (!windows.length || today + 8 * day > windows[0][1]) windows.push([today - 10 * day, today + 8 * day]);
      for (const [from, to] of windows) {
        if (to - from > BOARD_MAX_DAYS * day) continue;
        const f = new Date(from).toISOString();
        const t = new Date(to).toISOString();
        probes.push({ label: `dispatch board ${f.slice(0, 10)} to ${t.slice(0, 10)}`, path: `/service/board?from=${encodeURIComponent(f)}&to=${encodeURIComponent(t)}`, list: "calls" });
      }
      const leaks = [];
      const errors = [];
      const capped = [];
      let rowsScanned = 0;
      let answered = 0;
      await pooled(probes, async (p) => {
        let path = p.path;
        let got = 0;
        for (let page = 0; page < 10; page++) {
          const r = await apiGet(primaryToken, path);
          const shown = p.shown ?? path;
          if (r.status !== 200) { errors.push(`${p.label}: GET ${shown} answered ${statusText(r)}`); return; }
          for (const id of findDemoIds(r.text, demoIdSet)) leaks.push(`${demoIds.get(id)?.id ?? id} (${demoIds.get(id)?.sfObject ?? "demo record"}) — in the answer to GET ${shown}`);
          if (!Array.isArray(r.json?.[p.list])) { errors.push(`${p.label}: the answer has no "${p.list}" list — the response shape is not what this script expects`); return; }
          const records = p.list === "records" ? r.json.records : null;
          const n = r.json[p.list].length + (p.list === "calls" ? (r.json.unscheduled?.length ?? 0) + (r.json.unscheduledCalls?.length ?? 0) : 0);
          rowsScanned += n;
          got += n;
          // A search answers with its first 200 matches (newest first) and the full count.
          if (!p.paged && records && typeof r.json.total === "number" && r.json.total > records.length) capped.push(`${p.label}: the first ${records.length} of ${num(r.json.total)} matches were returned and scanned`);
          if (p.paged && got >= C3_ROW_CAP && r.json.hasMore === true) capped.push(`${p.label}: the first ${num(got)} rows were scanned, the list has more`);
          if (!p.paged || r.json.hasMore !== true || n === 0 || got >= C3_ROW_CAP) break;
          path = `/sf/${p.paged}?limit=${LIST_PAGE}&offset=${got}`;
        }
        answered++;
      });
      facts.c3 = { probes: probes.length, answered, leaks: leaks.length, errors: errors.length, rows: rowsScanned, searches: named.length + phones.length };
      if (leaks.length) R.fail("C3", `a demo record id came back to the ${o.primary.slug} user in ${plural(leaks.length, "place")}`, leaks);
      if (errors.length) R.error("C3", `${plural(errors.length, "search / list")} did not answer 200, so ${errors.length === 1 ? "it was" : "they were"} not checked`, errors);
      if (!leaks.length && !errors.length) R.pass("C3", `${answered} searches, lists and board reads as the ${o.primary.slug} user returned no demo record id (${named.length} demo customer names, ${phones.length} demo phone numbers, ${C3_SMALL_LISTS.join(" / ")} lists, the users lookup, the dispatch board; ${num(rowsScanned)} rows scanned)`);
      if (capped.length) R.info("C3", `${plural(capped.length, "answer")} held only part of what matched (the portal caps a search at 200 rows)`, capped);
      if (!named.length) R.info("C3", "no demo customer could be read for the name searches, so none was run");
    });
  }

  if (abortC) {
    R.skip("C", "C2–C5 were not run: the primary tenant's test login is not what it should be (see C1)");
    return finish();
  }

  // --- C4: the demo login must not be served the primary tenant's TEST records --------------------
  let demoToken = null;
  const demoEmail = demoUserEmail(DEMO_LOGIN_SLUG);
  await step("C4", async () => {
    const secret = await io.getSecret(DEMO_USERS_SECRET);
    const token = await signIn("C4", `the demo user ${demoEmail}`, demoEmail, loginEntries(secret)[demoEmail]);
    if (!token) return;
    const me = await whoAmI(token);
    if (me.r.status !== 200) return R.error("C4", `${demoEmail}: GET /auth/me answered ${statusText(me.r)} — C4 and C5 were not run`);
    if (!isDemoTenant(me.clientId)) return R.fail("C4", `the demo login ${demoEmail} resolves to ${tenantLabel(me.clientId)}, NOT the demo tenant — C4 and C5 were not run`);
    // The control, on the cache-free path so nothing is written to the list cache before the sync.
    const own = sampleIds(demoIdsOf("Sundial_Customer__c").filter((id) => inLiveDemo(id)), 1)[0];
    if (own) {
      const c = await apiGet(token, `/sf/customer/${own}?full=true`);
      if (c.status !== 200) return R.error("C4", `control failed: the demo login could not read its OWN customer ${own} (${statusText(c)}), so a refusal would prove nothing — C4 and C5 were not run`);
    }
    demoToken = token;
    R.pass("C4", `signed in as the demo user ${demoEmail}; /auth/me says tenant ${me.clientId}${me.slug ? ` (${me.slug})` : ""}${own ? `; control: it reads its own customer ${own}` : ""}`);
    const requests = [
      ...zz.customer.flatMap((id) => [{ id, path: `/sf/customer/${id}` }, { id, path: `/sf/customer/${id}?full=true` }]),
      ...zz.solar.flatMap((id) => [{ id, path: `/sf/solar/${id}` }, { id, path: `/sf/solar/${id}?full=true` }]),
      ...zz.roofing.map((id) => ({ id, path: `/sf/roofing/${id}` })),
    ];
    if (!requests.length) return R.skip("C4", `no "ZZ PORTAL TEST" record was found in the primary tenant, so there was nothing the demo login could safely be tried against (a live customer is never used)`);
    const served = [];
    const errors = [];
    let refused = 0;
    await pooled(requests, async (req) => {
      const r = await apiGet(token, req.path);
      const v = verdictOf(r);
      if (v === "refused") refused++;
      else if (v === "served") served.push(`${naming(req.id)} — GET ${req.path} returned 200 to the DEMO user`);
      else errors.push(`GET ${req.path}: ${statusText(r)}`);
    });
    facts.c4 = { asked: requests.length, refused, served: served.length, errors: errors.length };
    if (served.length) R.fail("C4", `the demo login WAS SERVED ${plural(served.length, "record")} of the primary tenant`, served);
    if (errors.length) R.error("C4", `${plural(errors.length, "read")} did not get a clear answer — not counted as refused`, errors);
    if (!served.length && !errors.length) R.pass("C4", `the demo login was refused ${refused} of ${requests.length} reads of the primary tenant's ZZ TEST records (${zz.customer.length} customers, ${zz.solar.length} solar, ${zz.roofing.length} roofing)`);
  });

  // --- C5: the demo login's own lists (only after the sync) -----------------------------------
  // WHY ONLY AFTER THE SYNC: a list read finds the tenant's cache empty, falls back to
  // Salesforce and WRITES the page it read into the cache (listColdCacheFallback in
  // sundial-sf-query). Before the sync that would make this script the thing that fills the
  // demo tenant's cache — the very step the owner wants verified before it happens.
  if (!o.afterSync) {
    R.skip("C5", "the demo login's lists are read only with --after-sync: before the sync, a list call would itself make the portal fill the demo tenant's cache from Salesforce");
  } else if (demoToken) {
    await step("C5", async () => {
      const foreign = [];
      const strangers = []; // { key, id }
      const short = [];
      const errors = [];
      const lines = [];
      const notRead = [];
      for (const key of C5_LISTS) {
        const sfObject = CACHE_OBJECTS[key].sfObject;
        const expected = liveSetOf(sfObject);
        // Even with --after-sync: a list whose cache is EMPTY would be filled by reading it
        // (the same cold-cache fallback). It is read only when B2 saw demo rows in its cache.
        if (expected.size > 0 && !(cachedByKey.get(key) > 0)) {
          notRead.push(`${key}: ${cachedByKey.has(key) ? "the cache holds no demo row for it (see B2)" : "its cache could not be looked at (see section B)"} — reading the list would make the portal fill it`);
          continue;
        }
        const got = new Set();
        let source = null;
        let total = null;
        let ok = true;
        for (let offset = 0, page = 0; page < 20; page++) {
          const path = `/sf/${key}?limit=${LIST_PAGE}&offset=${offset}`;
          const r = await apiGet(demoToken, path);
          if (r.status !== 200) { errors.push(`list ${key}: GET ${path} answered ${statusText(r)}`); ok = false; break; }
          const records = Array.isArray(r.json?.records) ? r.json.records : null;
          if (!records) { errors.push(`list ${key}: the answer has no "records" list — the response shape is not what this script expects`); ok = false; break; }
          source = source ?? r.json.source ?? null;
          if (typeof r.json.total === "number") total = r.json.total;
          for (const rec of records) {
            const id = rec?.sf_id ?? rec?.Id ?? rec?.id ?? null;
            if (!isSfId(id)) { errors.push(`list ${key}: a row carries no record id — the response shape is not what this script expects`); ok = false; break; }
            got.add(id15(id));
            if (!expected.has(id15(id))) strangers.push({ key, id });
            else if (rec.client_sf_id != null && !isDemoTenant(rec.client_sf_id)) foreign.push(`${id} — in the demo user's ${key} list with client_sf_id = ${rec.client_sf_id}`);
          }
          if (!ok) break;
          offset += records.length;
          if (r.json.hasMore !== true || records.length === 0 || offset >= 5000) break;
          await sleep(o.delayMs);
        }
        if (!ok) continue;
        const missing = [...expected].filter((x) => !got.has(x));
        if (total !== null && total !== got.size) { errors.push(`list ${key}: the API says ${total} records in all but ${got.size} came back — the list was not read whole`); continue; }
        if (missing.length) short.push(`${key}: the list has ${got.size} records, Salesforce has ${expected.size} in the demo tenant — missing ${missing.slice(0, 8).map((x) => demoIds.get(x)?.id ?? x).join(", ")}${missing.length > 8 ? `, … ${missing.length - 8} more` : ""}`);
        lines.push(`${key.padEnd(10)} ${String(got.size).padStart(4)} listed, ${String(expected.size).padStart(4)} in Salesforce${source ? `   (served from ${source})` : ""}`);
      }
      const known = await lookUp(strangers.map((x) => x.id));
      const ghosts = [];
      for (const x of strangers) {
        const hit = known.get(id15(x.id));
        if (hit.state === "gone") ghosts.push(`${x.id} — in the ${x.key} list, deleted in Salesforce`);
        else if (hit.state !== "demo") foreign.push(`${naming(x.id)} — in the demo user's ${x.key} list, and it belongs to ${whose(hit)}`);
      }
      if (notRead.length) R.skip("C5", `${plural(notRead.length, "list")} of the demo login ${notRead.length === 1 ? "was" : "were"} not read`, notRead);
      if (ghosts.length) R.info("C5", `${plural(ghosts.length, "listed record")} no longer ${ghosts.length === 1 ? "exists" : "exist"} in Salesforce (a leftover cache row of a deleted demo record)`, ghosts);
      facts.c5 = { foreign: foreign.length, short: short.length, errors: errors.length };
      if (foreign.length) R.fail("C5", `the demo user's lists hold ${plural(foreign.length, "record")} that ${foreign.length === 1 ? "is" : "are"} NOT the demo tenant's`, foreign);
      if (errors.length) R.error("C5", `${plural(errors.length, "list")} could not be read`, errors);
      // The API returns every row of the tenant to an Executive (the portal's own pages narrow
      // some lists in the browser; the API does not), so the counts are compared exactly.
      if (short.length) R.fail("C5", `the demo user's lists do not hold every demo record (not a leak: the list is incomplete — the sync has not pulled everything)`, short);
      if (!foreign.length && !errors.length && !short.length && lines.length) R.pass("C5", `the demo user's lists hold exactly the demo tenant's records (${lines.length} of ${C5_LISTS.length} lists read: ${C5_LISTS.join(", ")})`, lines);
    });
  } else {
    R.skip("C5", "not run: the demo login could not be used (see C4)");
  }

  return finish();
}

// ---------------------------------------------------------------------------------------
// the verdict
// ---------------------------------------------------------------------------------------
function buildVerdict({ R, o, facts, refused }) {
  const out = ["VERDICT"];
  const fails = R.results.filter((r) => r.level === "FAIL");
  const errors = R.results.filter((r) => r.level === "ERROR");
  const skips = R.results.filter((r) => r.level === "SKIP");
  const passed = (check) => R.of(check).some((r) => r.level === "PASS") && !R.of(check).some((r) => r.level === "FAIL" || r.level === "ERROR");
  const demo = facts.demoSlug ? `the demo tenant (${facts.demoSlug}, ${facts.demoTenantId})` : "the demo tenant";
  const primary = facts.primarySlug ?? "the primary tenant";

  if (refused) {
    out.push(`  NOT RUN: ${refused}. Nothing was verified.`);
    for (const f of fails) out.push(`    - ${f.check}: ${f.message}`);
    out.push("  Do not run the cache sync until this is understood.");
    return out;
  }

  if (passed("A3")) out.push(`  All ${num(facts.a3.total)} seeded records exist in Salesforce and carry ${demo}.`);
  if (passed("A4") && facts.a4) out.push(`  The demo tenant holds ${num(facts.a4.total)} records${facts.a4.extras ? ` — ${facts.a4.extras} of them not from the seed, checked the same way` : ", all of them the seed's"}.`);
  if (passed("A5")) out.push(`  No record without a tenant has been created since ${facts.a5.since}.`);
  if (passed("A6a") && passed("A6b")) out.push(`  No demo record points at a record outside the demo tenant (${num(facts.a6a.lookups)} lookups), and no record outside the demo tenant points at a demo record (${facts.a6b.fieldsChecked} lookup fields).`);
  if (passed("B4a")) out.push(`  The ${facts.b4a.logins} demo logins are bound to demo users only; no user record of another tenant carries one.`);
  if (passed("B1")) {
    out.push(facts.b1.rows
      ? `  The list cache holds ${num(facts.b1.rows)} rows for demo records, every one stamped with the demo tenant${o.afterSync && passed("B2") ? " — and exactly the demo tenant's records are cached under it" : ""}.`
      : `  The list cache holds no row for a demo record yet${o.afterSync ? "" : " (expected before the sync)"}, so none is stamped with another tenant.`);
  }
  if (passed("B3")) out.push(`  Notes, activity, texts, notifications and files: no row crosses the tenant line.`);
  if (passed("B4")) out.push(`  Every demo login's profile row carries the demo tenant; no other login's does.`);
  if (passed("C2")) out.push(`  A ${primary} login (${facts.c2.who}) was refused ${num(facts.c2.refused)} of ${num(facts.c2.asked)} demo records.`);
  if (passed("C3")) out.push(`  ${facts.c3.answered} searches, lists and dispatch-board reads as that ${primary} login returned no demo record.`);
  if (passed("C4") && facts.c4) out.push(`  The demo login was refused ${facts.c4.refused} of ${facts.c4.asked} reads of ${primary}'s ZZ TEST records.`);
  if (passed("C5")) out.push(`  The demo login's lists hold the demo tenant's records and nothing else.`);

  if (fails.length || errors.length) {
    out.push("");
    if (fails.length) {
      out.push(`  ${plural(fails.length, "CHECK")} FAILED:`);
      for (const f of fails) out.push(`    - ${f.check}: ${f.message}${f.details.length ? ` [${f.details.length === 1 ? f.details[0] : `${f.details.length} items, listed above`}]` : ""}`);
    }
    if (errors.length) {
      out.push(`  ${plural(errors.length, "CHECK")} COULD NOT BE COMPLETED (so ${errors.length === 1 ? "it proves" : "they prove"} nothing either way):`);
      for (const e of errors) out.push(`    - ${e.check}: ${e.message}`);
    }
    out.push(o.afterSync
      ? "  The demo tenant is NOT verified as isolated. Do not run the cache sync again, and do not show the demo, until this is understood."
      : "  The demo tenant is NOT verified as isolated. Do not run the cache sync until this is understood.");
  } else {
    out.push("");
    out.push(`  RESULT: nothing was found that lets a demo record show up in ${primary}'s portal, or a ${primary} record in the demo.`);
    out.push(o.afterSync
      ? "  This run was made after the cache sync."
      : "  It is safe to run the cache sync. Run this again afterwards with --after-sync.");
  }
  if (skips.length) {
    out.push("");
    out.push("  NOT CHECKED in this run:");
    for (const s of skips) out.push(`    - ${s.check}: ${s.message}`);
  }
  out.push("");
  out.push("  What this script does not cover: Salesforce's own screens and XFiles, where an admin sees every tenant's records;");
  out.push("  and emails or other outbound messages sent by Salesforce automation (Flows, alerts) about a demo record.");
  return out;
}
