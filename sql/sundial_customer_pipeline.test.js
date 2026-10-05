// Tests for sql/sundial_customer_pipeline.sql — run against a REAL Postgres (PGlite, in
// process), loading the actual SQL file. No mocks: the bugs this function can have are
// SQL bugs (a NULL comparison, a grant), and only Postgres can show them.
//
// Run with:  npm test
//
// Pinned:
//   - counts per status / stage / rep / source over a seeded cache;
//   - 'Service' exactly is excluded; 'Solar;Service' and a NULL customer_type stay
//     (IS DISTINCT FROM — the `<>` trap drops every NULL row);
//   - the access filter narrows every count; an unknown access column RAISES;
//   - the caller's narrowing (any-of, blank) narrows; an unknown column RAISES;
//   - anon and authenticated cannot execute it (the PUBLIC default is revoked).

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

const T = "a0Xharmon";
const OTHER = "a0Xother";
const REP_A = "a1OrepA";
const REP_B = "a1OrepB";

const db = new PGlite();
await db.exec(`
  create role anon; create role authenticated; create role service_role;
  create table public.sundial_customer_cache (
    sf_id text primary key, client_sf_id text, customer_type text, status text, stage text,
    sales_rep_sf_id text, sales_rep_name text, dealer_sf_id text, lead_source text
  );
  grant usage on schema public to anon, authenticated, service_role;
`);
await db.exec(await readFile(new URL("./sundial_customer_pipeline.sql", import.meta.url), "utf8"));

let seq = 0;
async function seed(rows) {
  for (const r of rows) {
    await db.query(
      `insert into public.sundial_customer_cache values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [`c${++seq}`, r.t ?? T, r.type ?? null, r.status ?? null, r.stage ?? null, r.rep ?? null, r.repName ?? null, r.dealer ?? null, r.src ?? null]
    );
  }
}
await seed([
  // Lead: 4 visible (NULL type ×2, Solar, Solar;Service), 2 Service-only hidden
  { status: "Lead", stage: "New", rep: REP_A, repName: "Ann", src: "Web" },
  { status: "Lead", stage: "New", rep: REP_B, repName: "Bob", src: 'Clean Energy Experts "B"' },
  { status: "Lead", stage: "Contact Attempt Made", rep: REP_A, repName: "Ann", src: "Web", type: "Solar" },
  { status: "Lead", stage: null, rep: REP_A, repName: "Ann", src: null, type: "Solar;Service" },
  { status: "Lead", stage: "New", type: "Service" },
  { status: "Lead", stage: "New", type: "Service" },
  // Opportunity: 2 visible
  { status: "Opportunity", stage: "Proposal", rep: REP_B, repName: "Bob", src: "Referral", dealer: "a0Ydealer" },
  { status: "Opportunity", stage: "Proposal", rep: REP_A, repName: "Ann", src: "Web", dealer: "a0Ydealer" },
  // Another tenant: never counted
  { t: OTHER, status: "Lead", stage: "New", rep: REP_A, repName: "Ann", src: "Web" },
]);

async function pipeline(filters = {}, narrow = null, tenant = T) {
  const r = await db.query(`select public.sundial_customer_pipeline($1, $2::jsonb, $3::jsonb) as p`, [
    tenant, JSON.stringify(filters), narrow == null ? null : JSON.stringify(narrow),
  ]);
  return r.rows[0].p;
}

test("counts per status: Service-only excluded, NULL type and Solar;Service kept, other tenant ignored", async () => {
  const p = await pipeline();
  assert.deepEqual(p.by_status, { Lead: 4, Opportunity: 2 });
});

test("by_stage per status, a blank stage under the key ''", async () => {
  const p = await pipeline();
  assert.deepEqual(p.by_stage, {
    Lead: { New: 2, "Contact Attempt Made": 1, "": 1 },
    Opportunity: { Proposal: 2 },
  });
});

test("reps and sources are tuples per status, most first", async () => {
  const p = await pipeline();
  assert.deepEqual(p.reps.Lead, [[REP_A, "Ann", 3], [REP_B, "Bob", 1]]);
  assert.deepEqual(p.reps.Opportunity, [[REP_A, "Ann", 1], [REP_B, "Bob", 1]]);
  assert.deepEqual(p.sources.Lead, [["Web", 2], ['Clean Energy Experts "B"', 1], [null, 1]]);
});

test("the access filter narrows EVERY count (rep scope)", async () => {
  const p = await pipeline({ eq: { sales_rep_sf_id: REP_B } });
  assert.deepEqual(p.by_status, { Lead: 1, Opportunity: 1 });
  assert.deepEqual(p.reps.Lead, [[REP_B, "Bob", 1]]);
  assert.deepEqual(p.by_stage.Lead, { New: 1 });
});

test("the access filter narrows by dealer too", async () => {
  const p = await pipeline({ eq: { dealer_sf_id: "a0Ydealer" } });
  assert.deepEqual(p.by_status, { Opportunity: 2 });
});

test("an access filter this function cannot apply RAISES (fail closed, never 'no filter')", async () => {
  await assert.rejects(pipeline({ eq: { stage: "New" } }), /unsupported access filter column/);
  await assert.rejects(pipeline({ or: "dealer_sf_id.eq.x" }), /unsupported access filter form/);
  await assert.rejects(pipeline({}, null, ""), /p_client_sf_id is required/);
});

test("the caller's narrowing: any-of values, and blank", async () => {
  const p = await pipeline({}, { stage: { values: ["New", "Proposal"] } });
  assert.deepEqual(p.by_status, { Lead: 2, Opportunity: 2 });

  const blank = await pipeline({}, { stage: { values: [], blank: true } });
  assert.deepEqual(blank.by_status, { Lead: 1 });

  const both = await pipeline({}, { stage: { values: ["Contact Attempt Made"], blank: true } });
  assert.deepEqual(both.by_stage.Lead, { "Contact Attempt Made": 1, "": 1 });
});

test("narrowing composes with the access filter (AND) and across columns", async () => {
  const p = await pipeline({ eq: { sales_rep_sf_id: REP_A } }, { lead_source: { values: ["Web"] }, sales_rep_name: { values: ["Ann"] } });
  assert.deepEqual(p.by_status, { Lead: 2, Opportunity: 1 });
});

test("a value with quotes is matched exactly", async () => {
  const p = await pipeline({}, { lead_source: { values: ['Clean Energy Experts "B"'] } });
  assert.deepEqual(p.by_status, { Lead: 1 });
});

test("an unknown narrowing column RAISES", async () => {
  await assert.rejects(pipeline({}, { customer_type: { values: ["Service"] } }), /unsupported narrowing column/);
});

test("an empty tenant answers empty objects, not nulls", async () => {
  assert.deepEqual(await pipeline({}, null, "a0Xnobody"), { by_status: {}, by_stage: {}, reps: {}, sources: {} });
});

test("anon and authenticated CANNOT execute it; service_role can", async () => {
  for (const role of ["anon", "authenticated"]) {
    const r = await db.query(`select has_function_privilege($1, 'public.sundial_customer_pipeline(text, jsonb, jsonb)', 'execute') ok`, [role]);
    assert.equal(r.rows[0].ok, false, `${role} must not execute`);
    await db.exec(`set role ${role}`);
    await assert.rejects(db.query(`select public.sundial_customer_pipeline('${T}', '{}'::jsonb, null)`), /permission denied/);
    await db.exec(`reset role`);
  }
  await db.exec(`set role service_role`);
  const r = await db.query(`select public.sundial_customer_pipeline('${T}', '{}'::jsonb, null) p`);
  await db.exec(`reset role`);
  assert.deepEqual(r.rows[0].p.by_status, { Lead: 4, Opportunity: 2 });
});
