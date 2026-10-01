// verify-fakes.js — test-only stand-ins for verify-isolation.test.js. NOT used by a real run.
//
// The seed's own fakes (fakes.js) are reused for the org, the Supabase project and the
// seeded data. Three things the isolation check needs are added here, because the check
// asks more of the outside world than the seed does — and the check's real queries are NOT
// simplified to suit a fake:
//
//   soqlShim            a fuller SOQL reader over the fake org's records: AND / OR / ( ),
//                       =, !=, IN, NOT IN, LIKE, = null, date-time comparisons, COUNT(Id),
//                       ORDER BY, LIMIT. It rejects unknown fields (against the live metadata
//                       in migration/demo/probe.json) and anything it cannot parse.
//   describeShim        the fake describe plus `keyPrefix` and `childRelationships`, which the
//                       real describe returns and the seed never needed.
//   readOnlySupabase    select-only access to the fake tables with PostgREST's behaviour
//                       (unknown table / column errors, a "Max Rows" ceiling, exact counts).
//                       Every write method throws AND is recorded.
//   createFakeApi       the portal API: /auth/me, /sf/{object}, /sf/{object}/{id}, /sf/users,
//                       /service/board — tenant-scoped from the signed-in user exactly as the
//                       Lambdas are, answering from the fake cache and the fake org. Anything
//                       but GET throws AND is recorded.
//   simulateCacheSync   what lambdas/sundial-cache-sync does: every record with a tenant
//                       becomes a cache row stamped from its own Client__c.

import { CACHE_OBJECTS, id15 } from "./verify-isolation.js";

// ---------------------------------------------------------------------------------------
// SOQL
// ---------------------------------------------------------------------------------------
function sfError(status, errorCode, message) {
  const e = new Error(`Salesforce query failed (${status})`);
  e.sfStatus = status;
  e.sfBody = JSON.stringify([{ message, errorCode }]);
  e.errorCode = errorCode;
  return e;
}
const malformed = (why) => sfError(400, "MALFORMED_QUERY", why);

function tokenize(soql) {
  const tokens = [];
  const re = /\s*(?:('(?:[^'\\]|\\.)*')|(\(|\)|,)|(!=|<>|>=|<=|=|>|<)|([A-Za-z0-9_.:+\-]+))/y;
  let pos = 0;
  while (pos < soql.length) {
    if (/^\s*$/.test(soql.slice(pos))) break;
    re.lastIndex = pos;
    const m = re.exec(soql);
    if (!m) throw malformed(`unexpected character at ${pos}`);
    pos = re.lastIndex;
    if (m[1] !== undefined) tokens.push({ t: "str", v: m[1].slice(1, -1).replace(/\\(.)/g, "$1") });
    else if (m[2] !== undefined) tokens.push({ t: m[2] });
    else if (m[3] !== undefined) tokens.push({ t: "op", v: m[3] === "<>" ? "!=" : m[3] });
    else tokens.push({ t: "word", v: m[4] });
  }
  return tokens;
}

const likeToRegExp = (pattern) => new RegExp(`^${pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*").replace(/_/g, ".")}$`, "i");
const looksLikeId = (v) => typeof v === "string" && /^[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?$/.test(v);

/** Compare one record value with one literal, the way SOQL does. */
function equal(field, value, literal) {
  if (literal === null) return value === null || value === undefined;
  if (value === null || value === undefined) return false;
  if (typeof literal === "boolean" || typeof literal === "number") return value === literal;
  if (field.type === "reference" || field.type === "id") return looksLikeId(literal) && id15(value) === id15(literal);
  return String(value).toLowerCase() === String(literal).toLowerCase(); // SOQL text comparison ignores case
}
function ordered(field, value, op, literal) {
  if (value === null || value === undefined || literal === null) return false;
  const isDate = field.type === "datetime" || field.type === "date";
  const a = isDate ? Date.parse(value) : Number(value);
  const b = isDate ? Date.parse(literal) : Number(literal);
  if (!Number.isFinite(a) || !Number.isFinite(b)) throw malformed(`cannot compare ${field.name} with ${literal}`);
  return op === ">=" ? a >= b : op === ">" ? a > b : op === "<=" ? a <= b : a < b;
}

/**
 * A SOQL reader for the fake org. Returns the same (soql) => rows function shape as
 * lib/salesforce.js sfQuery, and records every query text in `log`.
 */
export function soqlShim(org, log = []) {
  const run = async (soql) => {
    log.push(soql);
    const tokens = tokenize(soql);
    let i = 0;
    const peek = () => tokens[i];
    const isWord = (w) => peek()?.t === "word" && peek().v.toUpperCase() === w;
    const take = () => tokens[i++];
    const expectWord = (w) => { if (!isWord(w)) throw malformed(`expected ${w}`); i++; };

    expectWord("SELECT");
    const select = [];
    while (!isWord("FROM")) {
      const tok = take();
      if (!tok) throw malformed("no FROM");
      if (tok.t === ",") continue;
      if (tok.t !== "word") throw malformed("unexpected token in the select list");
      if (tok.v.toUpperCase() === "COUNT") {
        if (take()?.t !== "(") throw malformed("COUNT needs (");
        const inner = take();
        if (take()?.t !== ")") throw malformed("COUNT needs )");
        let alias = "expr0";
        if (peek()?.t === "word" && !isWord("FROM")) alias = take().v;
        select.push({ count: inner.v, alias });
      } else select.push({ field: tok.v });
    }
    expectWord("FROM");
    const sfObject = take()?.v;
    const meta = org.meta[sfObject];
    if (!meta || meta.absent) throw sfError(400, "INVALID_TYPE", `sObject type '${sfObject}' is not supported`);
    const fieldOf = (name) => {
      const f = meta.fields[name];
      if (!f) throw sfError(400, "INVALID_FIELD", `No such column '${name}' on entity '${sfObject}'`);
      return { ...f, name };
    };
    for (const s of select) fieldOf(s.field ?? s.count);

    const literal = () => {
      const tok = take();
      if (!tok) throw malformed("a value is missing");
      if (tok.t === "str") return tok.v;
      if (tok.t !== "word") throw malformed("unexpected token where a value was expected");
      const w = tok.v;
      if (/^null$/i.test(w)) return null;
      if (/^true$/i.test(w)) return true;
      if (/^false$/i.test(w)) return false;
      if (/^-?\d+(\.\d+)?$/.test(w)) return Number(w);
      if (/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2}))?$/.test(w)) return w;
      throw malformed(`unquoted value ${w}`);
    };
    const list = () => {
      if (take()?.t !== "(") throw malformed("IN needs (");
      const values = [];
      for (;;) {
        values.push(literal());
        const next = take();
        if (next?.t === ")") break;
        if (next?.t !== ",") throw malformed("IN list");
      }
      return values;
    };
    const parseCondition = () => {
      if (peek()?.t === "(") {
        take();
        const inner = parseOr();
        if (take()?.t !== ")") throw malformed("missing )");
        return inner;
      }
      const tok = take();
      if (tok?.t !== "word") throw malformed("a field name was expected");
      const field = fieldOf(tok.v);
      if (peek()?.t === "op") {
        const op = take().v;
        const value = literal();
        if (op === "=") return (r) => equal(field, r[field.name], value);
        // SOQL's != is true for a null field as well (unlike SQL's).
        if (op === "!=") return (r) => !equal(field, r[field.name], value);
        return (r) => ordered(field, r[field.name], op, value);
      }
      if (isWord("IN")) { take(); const values = list(); return (r) => values.some((v) => equal(field, r[field.name], v)); }
      if (isWord("NOT")) { take(); expectWord("IN"); const values = list(); return (r) => !values.some((v) => equal(field, r[field.name], v)); }
      if (isWord("LIKE")) {
        take();
        const pattern = literal();
        if (typeof pattern !== "string") throw malformed("LIKE needs a string");
        const re = likeToRegExp(pattern);
        return (r) => r[field.name] != null && re.test(String(r[field.name]));
      }
      throw malformed(`unsupported condition on ${field.name}`);
    };
    const parseAnd = () => {
      const parts = [parseCondition()];
      while (isWord("AND")) { take(); parts.push(parseCondition()); }
      return (r) => parts.every((p) => p(r));
    };
    function parseOr() {
      const parts = [parseAnd()];
      while (isWord("OR")) { take(); parts.push(parseAnd()); }
      return (r) => parts.some((p) => p(r));
    }

    let where = () => true;
    if (isWord("WHERE")) { take(); where = parseOr(); }
    let order = null;
    if (isWord("ORDER")) {
      take();
      expectWord("BY");
      order = { field: fieldOf(take().v).name, desc: false };
      while (peek() && !isWord("LIMIT") && !isWord("OFFSET")) {
        const w = take();
        if (w.t === "word" && w.v.toUpperCase() === "DESC") order.desc = true;
      }
    }
    let limit = null;
    if (isWord("LIMIT")) { take(); limit = Number(take().v); }
    if (peek()) throw malformed(`unexpected trailing text: ${peek().v ?? peek().t}`);

    let rows = org.all(sfObject).filter((r) => where(r));
    if (order) rows = rows.slice().sort((a, b) => String(a[order.field] ?? "").localeCompare(String(b[order.field] ?? "")) * (order.desc ? -1 : 1));
    if (select.some((s) => s.count)) {
      const out = { attributes: { type: "AggregateResult" } };
      for (const s of select) out[s.alias] = rows.length;
      return [out];
    }
    if (limit !== null) rows = rows.slice(0, limit);
    return rows.map((r) => {
      const out = { attributes: { type: sfObject } };
      for (const s of select) out[s.field] = r[s.field] ?? null;
      return out;
    });
  };
  return run;
}

/** The fake org's 3-character id prefix for an object (FakeOrg.newId). */
export const keyPrefixOf = (org, sfObject) => `a${(Object.keys(org.meta).indexOf(sfObject) + 10).toString(36).toUpperCase()}Z`;

/** describeObject with the two things a real describe has and the seed's fake leaves out. */
export function describeShim(org) {
  return async (sfObject) => {
    const d = await org.describeObject(sfObject);
    const childRelationships = [];
    for (const [child, meta] of Object.entries(org.meta)) {
      if (meta.absent) continue;
      for (const [field, f] of Object.entries(meta.fields)) {
        if (f.type === "reference" && (f.referenceTo || []).includes(sfObject)) childRelationships.push({ childSObject: child, field, relationshipName: null });
      }
    }
    return { ...d, keyPrefix: keyPrefixOf(org, sfObject), childRelationships };
  };
}

// ---------------------------------------------------------------------------------------
// Supabase, read-only
// ---------------------------------------------------------------------------------------
const WRITE_METHODS = ["insert", "upsert", "update", "delete"];

/**
 * @param {import("./fakes.js").FakeSupabase} db
 * @param {{ maxRows?: number, missingTables?: string[], brokenTables?: string[] }} [opts]
 */
export function readOnlySupabase(db, opts = {}) {
  const maxRows = opts.maxRows ?? 1000;
  const state = { writes: [], reads: 0, longestInList: 0 };
  class Query {
    constructor(table) {
      this.table = table;
      this.filters = [];
      this.cols = "*";
      this.wantCount = false;
      this.window = null;
      this.orderBy = null;
      this.used = [];
      for (const m of WRITE_METHODS) {
        this[m] = () => {
          state.writes.push(`${m} on ${table}`);
          throw new Error(`WRITE ATTEMPTED: supabase.from("${table}").${m}()`);
        };
      }
    }
    select(cols = "*", options = {}) { this.cols = cols; this.wantCount = options?.count === "exact"; return this; }
    eq(col, val) { this.used.push(col); this.filters.push((r) => r[col] === val); return this; }
    in(col, vals) {
      this.used.push(col);
      this.inChars = Math.max(this.inChars ?? 0, vals.join(",").length);
      state.longestInList = Math.max(state.longestInList, this.inChars);
      this.filters.push((r) => vals.includes(r[col]));
      return this;
    }
    order(col) { this.used.push(col); this.orderBy = col; return this; }
    range(a, b) { this.window = [a, b]; return this; }
    limit(n) { this.window = [0, n - 1]; return this; }
    then(resolve, reject) { return Promise.resolve(this.run()).then(resolve, reject); }
    run() {
      state.reads++;
      if ((opts.brokenTables || []).includes(this.table)) return { data: null, count: null, error: { code: "57014", message: "canceling statement due to statement timeout" } };
      const rows = db.tables.get(this.table);
      if (!rows || (opts.missingTables || []).includes(this.table)) return { data: null, count: null, error: { code: "PGRST205", message: `Could not find the table 'public.${this.table}' in the schema cache` } };
      const known = db.columns.get(this.table);
      const selected = this.cols === "*" ? [...known] : this.cols.split(",").map((c) => c.trim());
      for (const c of [...selected, ...this.used]) if (!known.has(c)) return { data: null, count: null, error: { code: "42703", message: `column ${this.table}.${c} does not exist` } };
      // The real request is a GET: a filter list that long would not fit in a URL.
      if ((this.inChars ?? 0) > 8000) return { data: null, count: null, error: { code: "414", message: "URI too long" } };
      let out = rows.filter((r) => this.filters.every((f) => f(r)));
      if (this.orderBy) out = out.slice().sort((a, b) => String(a[this.orderBy] ?? "").localeCompare(String(b[this.orderBy] ?? "")));
      const count = this.wantCount ? out.length : null;
      const [a, b] = this.window ?? [0, maxRows - 1];
      out = out.slice(a, Math.min(b + 1, a + maxRows)); // PostgREST's "Max Rows": silently truncated
      return { data: out.map((r) => Object.fromEntries(selected.map((c) => [c, r[c] ?? null]))), count, error: null };
    }
  }
  const client = {
    from: (table) => new Query(table),
    rpc: () => { state.writes.push("rpc"); throw new Error("WRITE ATTEMPTED: supabase.rpc()"); },
    get auth() { state.writes.push("auth"); throw new Error("WRITE ATTEMPTED: supabase.auth"); },
    get storage() { state.writes.push("storage"); throw new Error("WRITE ATTEMPTED: supabase.storage"); },
  };
  return { client, state };
}

// ---------------------------------------------------------------------------------------
// the list cache
// ---------------------------------------------------------------------------------------
/** sfFieldToColumn in lambdas/sundial-sf-query and sundial-cache-sync. */
const columnOf = (name, f) => name.replace(/__c$/i, "").toLowerCase() + (f.type === "reference" ? "_sf_id" : "");

/** One record as the cache row the sync (or a read) writes: stamped with `tenantId` / `tenantSlug`. */
export function cacheRowOf(org, db, key, record, tenantId, tenantSlug, nowIso) {
  const { sfObject, cacheTable } = CACHE_OBJECTS[key];
  const columns = db.columns.get(cacheTable);
  const row = {};
  for (const [name, f] of Object.entries(org.meta[sfObject].fields)) {
    if (name === "Id") continue;
    const v = record[name];
    if (v === undefined || v === null) continue;
    const col = columnOf(name, f);
    if (columns.has(col)) row[col] = v;
  }
  row.sf_id = record.Id;
  row.client_sf_id = tenantId;
  if (columns.has("tenant_id")) row.tenant_id = tenantSlug;
  if (columns.has("created_date")) row.created_date = record.CreatedDate ?? null;
  if (columns.has("last_synced_at")) row.last_synced_at = nowIso;
  if (columns.has("is_stale")) row.is_stale = false;
  return row;
}

/**
 * The cache-sync Lambda: cross-tenant, each row stamped from the record's OWN Client__c.
 * `onlyTenant` limits it to one tenant's records — the state BEFORE the demo is synced is
 * "the primary tenant's cache is warm, the demo's is empty".
 */
export function simulateCacheSync(org, db, { onlyTenant = null, nowIso = "2026-09-29T18:00:00.000Z" } = {}) {
  let written = 0;
  for (const [key, { sfObject, cacheTable }] of Object.entries(CACHE_OBJECTS)) {
    const table = db.tables.get(cacheTable);
    if (!table || !org.meta[sfObject] || org.meta[sfObject].absent) continue;
    for (const record of org.all(sfObject)) {
      if (!record.Client__c) continue; // never a tenant-less cache row
      if (onlyTenant && record.Client__c !== onlyTenant) continue;
      const slug = org.get(record.Client__c)?.Name ?? null;
      const row = cacheRowOf(org, db, key, record, record.Client__c, slug, nowIso);
      const at = table.findIndex((r) => r.sf_id === record.Id);
      if (at >= 0) table[at] = row;
      else table.push(row);
      written++;
    }
  }
  return written;
}

// ---------------------------------------------------------------------------------------
// the portal API
// ---------------------------------------------------------------------------------------
const SEARCH_COLUMNS = { customer: ["first_name", "last_name", "name", "primary_email", "primary_phone", "street", "city"] };
const TRAY_STATUSES = ["New", "Triaging", "Remote Investigation", "Ready to Schedule", "Awaiting Parts"];

/**
 * The portal API over the fake org and the fake cache, with the Lambdas' tenant scoping:
 * the tenant comes only from the signed-in user's Sundial_User__c (found by the auth uuid,
 * with no tenant filter — lib/identity.js), lists read the cache on client_sf_id, single
 * records read the cache and then Salesforce on Client__c.
 *
 * @param {{ org, db, tokens: Map<string,string> }} world   tokens: bearer token -> auth uuid
 */
export function createFakeApi({ org, db, tokens, apiBase = "https://api.example.test/prod" }) {
  const api = {
    apiBase,
    requests: [],
    violations: [],
    /** Cache rows the API itself wrote (the cold-cache fallback of a list read). */
    coldFills: [],
    /** Faults a test can switch on. */
    serveAnyway: new Set(), // record ids served to ANY tenant on a single read
    addToSearch: [], // record ids added to every customer search answer
    failWith: null, // (method, path) => status | null
  };
  const json = (status, body) => ({ status, ok: status >= 200 && status < 300, text: async () => JSON.stringify(body), json: async () => body });
  const notFound = () => json(404, { error: "not_found", code: "RECORD_NOT_FOUND" });
  const identity = (headers) => {
    const auth = headers?.Authorization || headers?.authorization || "";
    const uuid = tokens.get(String(auth).replace(/^Bearer\s+/i, ""));
    if (!uuid) return { error: json(401, { error: "unauthorized", code: "AUTH_INVALID_TOKEN" }) };
    const user = org.all("Sundial_User__c").find((u) => u.Supabase_User_Id__c === uuid); // LIMIT 1, no tenant filter
    if (!user) return { error: json(403, { error: "no_portal_user", code: "NO_SUNDIAL_USER" }) };
    if (!user.Client__c) return { error: json(403, { error: "no_tenant", code: "NO_TENANT" }) };
    return { user, tenantId: user.Client__c, tenantSlug: org.get(user.Client__c)?.Name ?? null };
  };
  const cacheRows = (key, tenantId) => (db.tables.get(CACHE_OBJECTS[key].cacheTable) || []).filter((r) => r.client_sf_id === tenantId && r.sf_id);

  api.fetch = async (url, init = {}) => {
    const method = String(init.method || "GET").toUpperCase();
    const u = new URL(url);
    const path = u.pathname.replace(new URL(apiBase).pathname, "") || "/";
    if (method !== "GET") {
      api.violations.push(`${method} ${path}`);
      throw new Error(`WRITE ATTEMPTED: ${method} ${path}`);
    }
    if (!url.startsWith(apiBase)) throw new Error(`unexpected host: ${u.host}`);
    const who = identity(init.headers);
    api.requests.push({ method, path, query: u.search, tenant: who.tenantId ?? null });
    const forced = api.failWith?.(method, path, u);
    if (forced) return json(forced, forced === 404 ? { message: "Not Found" } : { error: "server_error" });
    if (who.error) return who.error;
    const { tenantId, tenantSlug, user } = who;
    const qs = u.searchParams;

    if (path === "/auth/me") {
      return json(200, {
        user: { id: user.Id, email: user.Email__c ?? null, accessLevel: user.Access_Level__c ?? null, access: { level: user.Access_Level__c ?? null, scope: /^(Executive|Admin|Manager)$/.test(user.Access_Level__c || "") ? "tenant" : "own" } },
        tenant: { clientId: tenantId, slug: tenantSlug },
      });
    }

    if (path === "/sf/users") {
      const users = org.all("Sundial_User__c").filter((r) => r.Client__c === tenantId && r.Active__c !== false);
      return json(200, { users: users.map((r) => ({ id: r.Id, name: [r.First_Name__c, r.Last_Name__c].filter(Boolean).join(" ") || r.Id, supabaseUserId: r.Supabase_User_Id__c ?? null })) });
    }

    if (path === "/service/board") {
      const from = Date.parse(qs.get("from") ?? "");
      const to = Date.parse(qs.get("to") ?? "");
      if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return json(400, { error: "bad_request", code: "WINDOW_INVALID" });
      if (to - from > 42 * 86400000) return json(400, { error: "bad_request", code: "WINDOW_TOO_WIDE" });
      const mine = (o) => org.all(o).filter((r) => r.Client__c === tenantId);
      const call = (c) => ({ id: c.Id, number: c.Name, jobId: c.Sundial_Service_Job__c ?? null, techId: c.Tech__c ?? null, start: c.Scheduled_Start__c ?? null, status: c.Status__c ?? null });
      return json(200, {
        window: { from: qs.get("from"), to: qs.get("to") },
        techs: mine("Sundial_User__c").map((t) => ({ id: t.Id, name: [t.First_Name__c, t.Last_Name__c].filter(Boolean).join(" ") })),
        techsSource: "all",
        calls: mine("Sundial_Service_Call__c").filter((c) => c.Scheduled_Start__c && Date.parse(c.Scheduled_Start__c) >= from && Date.parse(c.Scheduled_Start__c) < to).map(call),
        unscheduled: mine("Sundial_Service_Job__c").filter((j) => TRAY_STATUSES.includes(j.Status__c)).map((j) => ({ id: j.Id, number: j.Name, customerId: j.Sundial_Customer__c ?? null })),
        unscheduledCalls: mine("Sundial_Service_Call__c").filter((c) => c.Status__c === "Unscheduled").map(call),
        defaults: { callMinutes: 120, timeZone: "America/Phoenix" },
      });
    }

    const m = /^\/sf\/([^/]+)(?:\/([^/]+))?\/?$/.exec(path);
    if (!m) return json(404, { message: "Not Found" }); // what API Gateway says for a route it does not have
    const key = m[1];
    const id = m[2] ?? null;
    const entry = CACHE_OBJECTS[key];
    if (!entry) return json(400, { error: "unsupported_object", code: "OBJECT_NOT_ALLOWED" });

    if (id) {
      if (api.serveAnyway.has(id)) return json(200, { source: "salesforce", record: { sf_id: id } });
      const record = org.get(id);
      const inTenant = record && org.objectOfId.get(id) === entry.sfObject && record.Client__c === tenantId;
      if (String(qs.get("full")).toLowerCase() === "true") {
        // Live Salesforce, every field, no cache read and no cache write.
        return inTenant ? json(200, { source: "salesforce", full: true, record: { ...record }, access: { visible: null, editable: null } }) : notFound();
      }
      const cached = cacheRows(key, tenantId).find((r) => r.sf_id === id);
      if (cached) return json(200, { source: "cache", record: { ...cached } });
      return inTenant ? json(200, { source: "salesforce", record: cacheRowOf(org, db, key, record, tenantId, tenantSlug, new Date().toISOString()) }) : notFound();
    }

    // list / search
    let rows = cacheRows(key, tenantId);
    const term = qs.get("q");
    if (term && term.trim().length >= 2) {
      const cols = SEARCH_COLUMNS[key] || ["name"];
      const needle = term.trim().toLowerCase();
      const digits = term.replace(/\D/g, "");
      rows = rows.filter((r) => cols.some((c) => r[c] != null && (String(r[c]).toLowerCase().includes(needle) || (digits.length >= 7 && /^\d+$/.test(term.trim()) && String(r[c]).replace(/\D/g, "").includes(digits)))));
      const records = rows.slice(0, 200).map((r) => ({ ...r }));
      if (key === "customer") for (const extra of api.addToSearch) records.push({ sf_id: extra, name: "leaked" });
      return json(200, { source: "cache", count: records.length, total: rows.length, limit: 200, offset: 0, hasMore: rows.length > records.length, records });
    }
    const limit = Math.min(Math.max(parseInt(qs.get("limit") ?? "", 10) || 500, 1), 5000);
    const offset = Math.max(parseInt(qs.get("offset") ?? "", 10) || 0, 0);
    if (rows.length === 0) {
      // Cold cache: read Salesforce, answer, AND populate the cache (listColdCacheFallback).
      const records = org.all(entry.sfObject).filter((r) => r.Client__c === tenantId);
      const page = records.slice(offset, offset + Math.min(limit, 500)).map((r) => cacheRowOf(org, db, key, r, tenantId, tenantSlug, new Date().toISOString()));
      if (page.length) {
        db.tables.get(entry.cacheTable).push(...page.map((r) => ({ ...r })));
        api.coldFills.push({ key, tenant: tenantId, rows: page.length });
      }
      return json(200, { source: "salesforce", count: page.length, total: records.length, limit, offset, hasMore: offset + page.length < records.length, records: page });
    }
    rows = rows.slice().sort((a, b) => String(a.sf_id).localeCompare(String(b.sf_id)));
    const page = rows.slice(offset, offset + limit).map((r) => ({ ...r }));
    return json(200, { source: "cache", count: page.length, total: rows.length, limit, offset, hasMore: offset + page.length < rows.length, records: page });
  };
  return api;
}
