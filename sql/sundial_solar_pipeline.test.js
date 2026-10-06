// Tests for sql/sundial_solar_pipeline.sql — run against a REAL Postgres (PGlite, in
// process), loading the actual SQL file. No mocks: the bugs this function can have are
// SQL bugs (a NULL sum, a substring rule, a grant), and only Postgres can show them.
//
// Run with:  npm test
//
// Pinned:
//   - by_stage (blank under ""), pms / reps tuples most first, other tenant ignored;
//   - stats: total, contract / kW sums (NULL when nothing to sum), recent 6 by
//     last_synced_at with the page's customer-name fallback;
//   - the terminal rule: substring terms, case-insensitive, the exact-stage exception,
//     and the OLD four-word list vs the NEW list (Archive) on the same data;
//   - the access filter narrows the counts AND the stats; an unknown column RAISES;
//   - the caller's narrowing (any-of, blank) narrows the stats too; unknown RAISES;
//   - anon and authenticated cannot execute it.

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

const T = "a0Xharmon";
const OTHER = "a0Xother";
const REP_A = "a1OrepA";
const REP_B = "a1OrepB";
const OLD_TERMS = ["complete", "cancel", "pto", "closed"];
const NEW_TERMS = [...OLD_TERMS, "archive"];
const KEEP = ["Billing Complete - Pending Closeout"];

const db = new PGlite();
await db.exec(`
  create role anon; create role authenticated; create role service_role;
  create table public.sundial_solar_cache (
    sf_id text primary key, client_sf_id text, stage text, project_manager text,
    sales_rep_sf_id text, sales_rep_name text, dealer_sf_id text,
    contract_amount numeric, system_size numeric, system_size_kw numeric,
    project_name text, first_name text, last_name text, customer_name_at_creation text,
    last_synced_at timestamptz
  );
  grant usage on schema public to anon, authenticated, service_role;
`);
await db.exec(await readFile(new URL("./sundial_solar_pipeline.sql", import.meta.url), "utf8"));

let seq = 0;
async function seed(rows) {
  for (const r of rows) {
    seq += 1;
    await db.query(
      `insert into public.sundial_solar_cache values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [
        r.id ?? `s${String(seq).padStart(2, "0")}`, r.t ?? T, r.stage ?? null, r.pm ?? null,
        r.rep ?? null, r.repName ?? null, r.dealer ?? null,
        r.amt ?? null, r.size ?? null, r.kw ?? null,
        r.name ?? `P${seq}`, r.first ?? null, r.last ?? null, r.snap ?? null,
        r.synced ?? `2026-10-0${(seq % 5) + 1}T00:00:00Z`,
      ]
    );
  }
}
await seed([
  // 9 Harmon rows
  { stage: "Permitting", pm: "Pat", rep: REP_A, repName: "Ann", amt: 10000, size: 5.5, first: "Ada", last: "Lee", synced: "2026-10-05T10:00:00Z" },
  { stage: "Permitting", pm: "Pat", rep: REP_B, repName: "Bob", amt: 20000, size: 7, last: "Kim", synced: "2026-10-05T09:00:00Z" },
  { stage: "Archive", pm: "Quinn", rep: REP_A, repName: "Ann", amt: 5000, size: 4, snap: "Snap Shot", synced: "2026-10-05T08:00:00Z" },
  { stage: "Archive", pm: null, rep: REP_A, repName: "Ann", amt: null, size: null, synced: "2026-10-05T07:00:00Z" },
  { stage: "Cancelled", pm: "Pat", rep: REP_B, repName: "Bob", amt: 1000, size: 3, dealer: "a0Ydealer", synced: "2026-10-05T06:00:00Z" },
  { stage: "Billing Complete - Pending Closeout", pm: "Quinn", rep: REP_B, repName: "Bob", amt: 2000, size: 2, dealer: "a0Ydealer", synced: "2026-10-05T05:00:00Z" },
  { stage: "Inspection COMPLETED", pm: "Pat", rep: REP_A, repName: "Ann", synced: "2026-10-05T04:00:00Z" },
  { stage: null, pm: null, rep: null, repName: null, amt: 300, synced: "2026-10-05T03:00:00Z" },
  { stage: "Green Tagged", pm: "Pat", rep: REP_A, repName: "Ann", synced: "2026-10-01T00:00:00Z" },
  // Another tenant: never counted
  { t: OTHER, stage: "Permitting", pm: "Pat", rep: REP_A, repName: "Ann", amt: 99999, size: 99, synced: "2026-10-06T00:00:00Z" },
]);

async function pipeline({ filters = {}, narrow = null, terms = NEW_TERMS, keep = KEEP, tenant = T } = {}) {
  const r = await db.query(`select public.sundial_solar_pipeline($1, $2::jsonb, $3::jsonb, $4::text[], $5::text[]) as p`, [
    tenant, JSON.stringify(filters), narrow == null ? null : JSON.stringify(narrow), terms, keep,
  ]);
  return r.rows[0].p;
}

test("by_stage over the tenant, blank stage under '', other tenant ignored", async () => {
  const p = await pipeline();
  assert.deepEqual(p.by_stage, {
    Permitting: 2, Archive: 2, Cancelled: 1, "Billing Complete - Pending Closeout": 1,
    "Inspection COMPLETED": 1, "": 1, "Green Tagged": 1,
  });
});

test("pms and reps are [value, n] tuples, most first, blank as null", async () => {
  const p = await pipeline();
  assert.deepEqual(p.pms, [["Pat", 5], ["Quinn", 2], [null, 2]]);
  assert.deepEqual(p.reps, [["Ann", 5], ["Bob", 3], [null, 1]]);
});

test("stats: totals and sums (system_size is the column summed)", async () => {
  const { stats } = await pipeline();
  assert.equal(stats.total_projects, 9);
  assert.equal(Number(stats.contract_total), 38300);
  assert.equal(Number(stats.system_size_kw_total), 21.5);
});

test("stats: in_progress with the NEW list — Archive terminal, Billing Complete kept active", async () => {
  // Non-blank 8; terminal: Archive ×2, Cancelled, Inspection COMPLETED (case-insensitive) = 4.
  // Billing Complete - Pending Closeout contains "complete" but is the exact exception.
  const { stats } = await pipeline();
  assert.equal(stats.in_progress, 4);
});

test("PARITY: the OLD four-word list reproduces the Dashboard's old isTerminalStage() number", async () => {
  // The old rule, no exception: terminal = Cancelled, Billing Complete, Inspection COMPLETED.
  // Archive counted as active. Same arithmetic the page did in the browser.
  const stages = (await db.query(`select stage from public.sundial_solar_cache where client_sf_id = $1`, [T])).rows.map((r) => r.stage ?? "");
  const pageRule = stages.filter((s) => s !== "" && !OLD_TERMS.some((t) => s.toLowerCase().includes(t))).length;
  const { stats } = await pipeline({ terms: OLD_TERMS, keep: [] });
  assert.equal(stats.in_progress, pageRule);
  assert.equal(stats.in_progress, 5);
});

test("NULL / empty term lists: nothing is terminal (every non-blank stage is in progress)", async () => {
  assert.equal((await pipeline({ terms: null, keep: null })).stats.in_progress, 8);
  assert.equal((await pipeline({ terms: ["", "  "], keep: [] })).stats.in_progress, 8);
});

test("stats.recent: 6 newest by last_synced_at, customer name falls back to the snapshot", async () => {
  const { stats } = await pipeline();
  assert.equal(stats.recent.length, 6);
  assert.deepEqual(stats.recent.map((r) => r[0]), ["s01", "s02", "s03", "s04", "s05", "s06"]);
  assert.deepEqual(stats.recent[0].slice(0, 4), ["s01", "P1", "Ada Lee", "Permitting"]);
  assert.equal(stats.recent[1][2], "Kim");          // last name only
  assert.equal(stats.recent[2][2], "Snap Shot");    // no first/last → snapshot
  assert.equal(stats.recent[3][2], null);           // nothing → null
  assert.equal(Date.parse(stats.recent[0][4]), Date.parse("2026-10-05T10:00:00Z"));
});

test("the access filter narrows counts AND stats (rep scope)", async () => {
  const p = await pipeline({ filters: { eq: { sales_rep_sf_id: REP_B } } });
  assert.deepEqual(p.by_stage, { Permitting: 1, Cancelled: 1, "Billing Complete - Pending Closeout": 1 });
  assert.deepEqual(p.reps, [["Bob", 3]]);
  assert.equal(p.stats.total_projects, 3);
  assert.equal(p.stats.in_progress, 2);
  assert.equal(Number(p.stats.contract_total), 23000);
  assert.deepEqual(p.stats.recent.map((r) => r[0]), ["s02", "s05", "s06"]);
});

test("the access filter narrows by dealer too", async () => {
  const p = await pipeline({ filters: { eq: { dealer_sf_id: "a0Ydealer" } } });
  assert.equal(p.stats.total_projects, 2);
  assert.equal(Number(p.stats.system_size_kw_total), 5);
});

test("sums are NULL (not 0) when no row has a value — the card shows '—'", async () => {
  const p = await pipeline({ narrow: { stage: { values: ["Green Tagged"] } } });
  assert.equal(p.stats.total_projects, 1);
  assert.equal(p.stats.contract_total, null);
  assert.equal(p.stats.system_size_kw_total, null);
});

test("an access filter this function cannot apply RAISES (fail closed)", async () => {
  await assert.rejects(pipeline({ filters: { eq: { stage: "Archive" } } }), /unsupported access filter column/);
  await assert.rejects(pipeline({ filters: { or: "dealer_sf_id.eq.x" } }), /unsupported access filter form/);
  await assert.rejects(pipeline({ tenant: "" }), /p_client_sf_id is required/);
});

test("the caller's narrowing: any-of, blank, across columns — and the stats follow it", async () => {
  const p = await pipeline({ narrow: { project_manager: { values: ["Pat"] }, sales_rep_name: { values: ["Ann"] } } });
  assert.deepEqual(p.by_stage, { Permitting: 1, "Inspection COMPLETED": 1, "Green Tagged": 1 });
  assert.equal(p.stats.total_projects, 3);
  assert.equal(p.stats.in_progress, 2);

  const blank = await pipeline({ narrow: { stage: { values: [], blank: true } } });
  assert.deepEqual(blank.by_stage, { "": 1 });
  assert.equal(blank.stats.in_progress, 0);

  const both = await pipeline({ narrow: { stage: { values: ["Archive"], blank: true } } });
  assert.deepEqual(both.by_stage, { Archive: 2, "": 1 });
});

test("an unknown narrowing column RAISES", async () => {
  await assert.rejects(pipeline({ narrow: { lead_source: { values: ["Web"] } } }), /unsupported narrowing column/);
});

test("an empty tenant answers empty shapes and zero counts", async () => {
  const p = await pipeline({ tenant: "a0Xnobody" });
  assert.deepEqual(p, {
    by_stage: {}, pms: [], reps: [],
    stats: { total_projects: 0, in_progress: 0, contract_total: null, system_size_kw_total: null, recent: [] },
  });
});

test("anon and authenticated CANNOT execute it; service_role can", async () => {
  const sig = "public.sundial_solar_pipeline(text, jsonb, jsonb, text[], text[])";
  for (const role of ["anon", "authenticated"]) {
    const r = await db.query(`select has_function_privilege($1, '${sig}', 'execute') ok`, [role]);
    assert.equal(r.rows[0].ok, false, `${role} must not execute`);
    await db.exec(`set role ${role}`);
    await assert.rejects(db.query(`select public.sundial_solar_pipeline('${T}', '{}'::jsonb, null, null, null)`), /permission denied/);
    await db.exec(`reset role`);
  }
  await db.exec(`set role service_role`);
  const r = await db.query(`select public.sundial_solar_pipeline('${T}', '{}'::jsonb, null, null, null) p`);
  await db.exec(`reset role`);
  assert.equal(r.rows[0].p.stats.total_projects, 9);
});
