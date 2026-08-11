// Tests for sundial-cache-sync RECONCILE mode (delete-detection).
//
// Run with:  npm test        (needs --experimental-test-module-mocks)
//
// Reconcile is the ONLY destructive path in this Lambda, and the failure mode it
// guards against is deleting a LIVE record's cache row. So these tests pin the
// safety properties as hard as the happy path:
//   - a ghost (gone from Salesforce) is removed
//   - a live row is NEVER removed, including when the cache holds a 15-char id and
//     Salesforce answers with the 18-char form (or vice versa)
//   - a Salesforce batch that ERRORS leaves its ids alone rather than treating
//     "we couldn't check" as "it's a ghost"
//   - a suspiciously large ghost set is REFUSED unless explicitly forced

import test from "node:test";
import assert from "node:assert/strict";
import { mock } from "node:test";

// --- Fixtures ---------------------------------------------------------------
// 18-char ids. The trailing 3 chars are the checksum suffix; the first 15 are the
// real key, which is why idKey() compares on those.
const LIVE_18 = "a1Q7y00000JDaQvEAL";
const LIVE_15 = LIVE_18.slice(0, 15);
const GHOST_18 = "a1Q7y00000JDmWvEAL";
const GHOST_15 = GHOST_18.slice(0, 15);

const ctx = {
  tables: {},        // table -> array of row objects
  sfLive: new Set(), // 18-char ids Salesforce still returns
  soqlCalls: [],     // every SOQL string issued
  sfThrowsOnCall: null, // 1-based call index that should throw
  selectError: null,
  deleteError: null,
};

function resetCtx() {
  ctx.tables = { sundial_sync_state: [] };
  ctx.sfLive = new Set();
  ctx.soqlCalls = [];
  ctx.sfThrowsOnCall = null;
  ctx.selectError = null;
  ctx.deleteError = null;
}

// --- Minimal fake supabase-js query builder --------------------------------
// Chainable + thenable, mirroring only the surface reconcile actually uses.
class Q {
  constructor(table) {
    this.table = table;
    this.op = "select";
    this.filters = [];
    this._range = null;
    this._returning = false;
  }
  select() {
    if (this.op === "delete") { this._returning = true; return this; }
    this.op = "select";
    return this;
  }
  delete() { this.op = "delete"; return this; }
  upsert(rows) { this.op = "upsert"; this.rows = rows; return this; }
  in(col, vals) { this.filters.push(["in", col, vals]); return this; }
  eq(col, val) { this.filters.push(["eq", col, val]); return this; }
  limit() { return this; }
  maybeSingle() { this._single = true; return this; }
  range(a, b) { this._range = [a, b]; return this; }
  then(res, rej) { return this._run().then(res, rej); }

  _match(row) {
    return this.filters.every(([kind, col, val]) =>
      kind === "in" ? val.includes(row[col]) : row[col] === val
    );
  }

  async _run() {
    const rows = ctx.tables[this.table] || (ctx.tables[this.table] = []);
    if (this.op === "select") {
      if (ctx.selectError) return { data: null, error: { message: ctx.selectError } };
      let out = rows.filter((r) => this._match(r));
      if (this._range) out = out.slice(this._range[0], this._range[1] + 1);
      if (this._single) return { data: out[0] ?? null, error: null };
      return { data: out, error: null };
    }
    if (this.op === "delete") {
      if (ctx.deleteError) return { data: null, error: { message: ctx.deleteError } };
      const removed = rows.filter((r) => this._match(r));
      ctx.tables[this.table] = rows.filter((r) => !this._match(r));
      return { data: this._returning ? removed : null, error: null };
    }
    return { data: null, error: null }; // upsert
  }
}

mock.module("../../lib/supabase.js", {
  exports: {
    getSupabaseClient: async () => ({ from: (t) => new Q(t) }),
    getSupabaseConfig: async () => ({ url: "https://x.supabase.co", serviceRoleKey: "k" }),
  },
});

mock.module("../../lib/salesforce.js", {
  exports: {
    getSalesforceToken: async () => ({ access_token: "t", instance_url: "https://i" }),
    // Answers "which of these ids still exist" from ctx.sfLive, ALWAYS returning
    // the 18-char form the way Salesforce does.
    sfQuery: async (soql) => {
      ctx.soqlCalls.push(soql);
      if (ctx.sfThrowsOnCall === ctx.soqlCalls.length) {
        throw new Error("SF unavailable");
      }
      const asked = [...soql.matchAll(/'([^']+)'/g)].map((m) => m[1]);
      const out = [];
      for (const id of asked) {
        for (const live of ctx.sfLive) {
          if (live.slice(0, 15) === String(id).slice(0, 15)) { out.push({ Id: live }); break; }
        }
      }
      return out;
    },
    soqlEscapeString: (v) => String(v).replace(/\\/g, "\\\\").replace(/'/g, "\\'"),
  },
});

const { handler } = await import("./index.js");

const solarRows = (...ids) => ids.map((id) => ({ sf_id: id, client_sf_id: "a0Xharmon" }));
const cachedIds = () => (ctx.tables.sundial_solar_cache || []).map((r) => r.sf_id);
const run = (event) => handler(event);

// --- Targeted purge: the ghost goes, the live row stays ---------------------

test("reconcile removes a ghost and leaves the live row untouched", async () => {
  resetCtx();
  ctx.tables.sundial_solar_cache = solarRows(LIVE_18, GHOST_18);
  ctx.sfLive = new Set([LIVE_18]);

  const res = await run({ mode: "reconcile", object: "solar" });
  const r = res.objects.solar;

  assert.equal(r.status, "ok");
  assert.equal(r.ghosts, 1);
  assert.equal(r.deleted, 1);
  assert.deepEqual(cachedIds(), [LIVE_18], "the live row must survive");
});

test("scoping to one object never touches another object's cache table", async () => {
  resetCtx();
  ctx.tables.sundial_solar_cache = solarRows(GHOST_18);
  ctx.tables.sundial_customer_cache = [{ sf_id: "a1P7y00000AAAAAAAA", client_sf_id: "a0Xharmon" }];
  ctx.sfLive = new Set();

  await run({ mode: "reconcile", object: "solar" });

  assert.equal(cachedIds().length, 0, "solar ghost purged");
  assert.equal(ctx.tables.sundial_customer_cache.length, 1, "customer cache untouched");
});

test("purges exactly the five briefed ids and nothing else", async () => {
  resetCtx();
  const briefed = [
    "a1Q7y00000JDaQvEAL", "a1Q7y00000JDmWvEAL", "a1Q7y00000JDnBFEA1",
    "a1Q7y00000JHJGDEA5", "a1Q7y00000JHKNZEA5",
  ];
  const keep = "a1Q7y00000KEEPMEAL";
  ctx.tables.sundial_solar_cache = solarRows(...briefed, keep);
  ctx.sfLive = new Set([keep]); // the five are deleted in SF

  const r = (await run({ mode: "reconcile", object: "solar" })).objects.solar;

  assert.equal(r.deleted, 5);
  assert.deepEqual(cachedIds(), [keep]);
});

// --- 15- vs 18-char id handling (the correctness crux) ---------------------

test("a 15-char cache id matching an 18-char SF id is LIVE, not a ghost", async () => {
  resetCtx();
  ctx.tables.sundial_solar_cache = solarRows(LIVE_15); // cache holds the short form
  ctx.sfLive = new Set([LIVE_18]);                     // Salesforce answers long form

  const r = (await run({ mode: "reconcile", object: "solar" })).objects.solar;

  assert.equal(r.ghosts, 0, "15/18 mismatch must not read as a ghost");
  assert.equal(r.deleted, 0);
  assert.deepEqual(cachedIds(), [LIVE_15]);
});

test("a ghost stored in 15-char form is deleted by its exact stored value", async () => {
  resetCtx();
  ctx.tables.sundial_solar_cache = solarRows(GHOST_15, LIVE_18);
  ctx.sfLive = new Set([LIVE_18]);

  const r = (await run({ mode: "reconcile", object: "solar" })).objects.solar;

  assert.equal(r.deleted, 1);
  assert.deepEqual(cachedIds(), [LIVE_18]);
});

test("mixed 15- and 18-char rows for live records are all preserved", async () => {
  resetCtx();
  const otherLive18 = "a1Q7y00000JDnBFEA1";
  ctx.tables.sundial_solar_cache = solarRows(LIVE_15, otherLive18, GHOST_18);
  ctx.sfLive = new Set([LIVE_18, otherLive18]);

  const r = (await run({ mode: "reconcile", object: "solar" })).objects.solar;

  assert.equal(r.deleted, 1);
  assert.deepEqual(cachedIds().sort(), [LIVE_15, otherLive18].sort());
});

test("id comparison stays case-sensitive on the 15-char key", async () => {
  resetCtx();
  // Same letters, different case -> a DIFFERENT record. Must not be treated as live.
  ctx.tables.sundial_solar_cache = solarRows("a1Q7y00000jdaqv");
  ctx.sfLive = new Set([LIVE_18]); // 'a1Q7y00000JDaQv...'

  const r = (await run({ mode: "reconcile", object: "solar" })).objects.solar;

  assert.equal(r.ghosts, 1, "case difference means a different record");
});

// --- Fail-safe behavior ----------------------------------------------------

test("a failed Salesforce batch leaves those ids alone instead of purging them", async () => {
  resetCtx();
  ctx.tables.sundial_solar_cache = solarRows(LIVE_18, GHOST_18);
  ctx.sfLive = new Set([LIVE_18]);
  ctx.sfThrowsOnCall = 1; // the only batch fails

  const r = (await run({ mode: "reconcile", object: "solar" })).objects.solar;

  assert.equal(r.deleted, 0, "an unverifiable id must never be deleted");
  assert.equal(r.unverified, 2);
  assert.equal(cachedIds().length, 2, "cache untouched when we could not check");
});

test("refuses a mass purge above the ghost-ratio threshold, and force overrides", async () => {
  resetCtx();
  const many = Array.from({ length: 40 }, (_, i) =>
    `a1Q7y00000GHOST${String(i).padStart(2, "0")}A`
  );
  ctx.tables.sundial_solar_cache = solarRows(...many, LIVE_18);
  ctx.sfLive = new Set([LIVE_18]); // 40 of 41 look absent -> ~98%

  const refused = (await run({ mode: "reconcile", object: "solar" })).objects.solar;
  assert.equal(refused.status, "refused_ghost_ratio");
  assert.equal(refused.deleted, 0);
  assert.equal(cachedIds().length, 41, "nothing deleted while refused");

  const forced = (await run({ mode: "reconcile", object: "solar", force: true })).objects.solar;
  assert.equal(forced.status, "ok");
  assert.equal(forced.deleted, 40);
  assert.deepEqual(cachedIds(), [LIVE_18]);
});

test("a small ghost set purges normally even at a high ratio (rail needs volume too)", async () => {
  resetCtx();
  // 1 ghost of 2 rows is 50% — way over the ratio — but is an ordinary purge.
  // This is exactly the shape of the five-id cleanup that prompted this feature.
  ctx.tables.sundial_solar_cache = solarRows(GHOST_18, LIVE_18);
  ctx.sfLive = new Set([LIVE_18]);

  const r = (await run({ mode: "reconcile", object: "solar" })).objects.solar;

  assert.equal(r.status, "ok", "the rail must not block a handful of rows");
  assert.equal(r.deleted, 1);
  assert.deepEqual(cachedIds(), [LIVE_18]);
});

test("the only row in a single-row cache can still be purged when it is a ghost", async () => {
  resetCtx();
  // The roofing cache really does hold one row today — a 100% ratio by construction.
  ctx.tables.sundial_roofing_cache = [{ sf_id: "a1R7y00000GHOSTAAAA", client_sf_id: "a0Xharmon" }];
  ctx.sfLive = new Set();

  const r = (await run({ mode: "reconcile", object: "roofing" })).objects.roofing;

  assert.equal(r.status, "ok");
  assert.equal(r.deleted, 1);
  assert.equal(ctx.tables.sundial_roofing_cache.length, 0);
});

test("dryRun reports ghosts without deleting anything", async () => {
  resetCtx();
  ctx.tables.sundial_solar_cache = solarRows(LIVE_18, GHOST_18);
  ctx.sfLive = new Set([LIVE_18]);

  const r = (await run({ mode: "reconcile", object: "solar", dryRun: true })).objects.solar;

  assert.equal(r.status, "ok_dry_run");
  assert.equal(r.ghosts, 1);
  assert.equal(r.deleted, 0);
  assert.ok(r.sampleGhosts.includes(GHOST_18));
  assert.equal(cachedIds().length, 2, "dry run must not mutate the cache");
});

test("a delete failure reports error and does not claim success", async () => {
  resetCtx();
  ctx.tables.sundial_solar_cache = solarRows(GHOST_18, LIVE_18);
  ctx.sfLive = new Set([LIVE_18]);
  ctx.deleteError = "permission denied";

  const r = (await run({ mode: "reconcile", object: "solar" })).objects.solar;

  assert.equal(r.status, "error");
  assert.equal(r.deleted, 0);
});

// --- Batching / API budget -------------------------------------------------

test("batches the Salesforce existence check at 400 ids per query", async () => {
  resetCtx();
  const ids = Array.from({ length: 950 }, (_, i) =>
    `a1Q7y00000B${String(i).padStart(4, "0")}AAA`
  );
  ctx.tables.sundial_solar_cache = solarRows(...ids);
  ctx.sfLive = new Set(ids); // all live

  const r = (await run({ mode: "reconcile", object: "solar" })).objects.solar;

  assert.equal(r.soqlQueries, 3, "950 ids -> ceil(950/400) = 3 queries");
  assert.equal(r.ghosts, 0);
  assert.equal(cachedIds().length, 950);
  for (const soql of ctx.soqlCalls) {
    assert.match(soql, /^SELECT Id FROM Sundial_Solar__c WHERE Id IN \(/);
    assert.ok(!/queryAll/i.test(soql));
  }
});

test("an empty cache is a clean no-op with no Salesforce calls", async () => {
  resetCtx();
  ctx.tables.sundial_solar_cache = [];

  const r = (await run({ mode: "reconcile", object: "solar" })).objects.solar;

  assert.equal(r.status, "ok");
  assert.equal(r.cacheRows, 0);
  assert.equal(r.deleted, 0);
  assert.equal(ctx.soqlCalls.length, 0, "must not burn API calls on an empty cache");
});

// --- Mode isolation --------------------------------------------------------

test("reconcile does not advance the sync watermark", async () => {
  resetCtx();
  ctx.tables.sundial_solar_cache = solarRows(GHOST_18);
  ctx.sfLive = new Set();

  await run({ mode: "reconcile", object: "solar" });

  assert.equal(
    ctx.tables.sundial_sync_state.length, 0,
    "reconcile must leave the incremental cursor alone"
  );
});

test("reconcile is opt-in — it never runs on a scheduled/empty event", async () => {
  resetCtx();
  ctx.tables.sundial_solar_cache = solarRows(GHOST_18);
  ctx.sfLive = new Set();

  // Scoped to one object purely to keep the incremental path's (unmocked, and
  // irrelevant here) Salesforce describe failure from spamming the test output —
  // it is caught per-object and does not affect what this test asserts.
  const res = await run({ object: "solar" });

  assert.notEqual(res.mode, "reconcile");
  assert.equal(cachedIds().length, 1, "an unqualified invoke must never delete");
});

test("an unknown object is rejected before any work", async () => {
  resetCtx();
  const res = await run({ mode: "reconcile", object: "not_an_object" });
  assert.equal(res.ok, false);
  assert.equal(res.error, "OBJECT_NOT_ALLOWED");
  assert.equal(ctx.soqlCalls.length, 0);
});
