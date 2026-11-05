// sql/2026-11-05_job_photo_reports.sql (D-072 amendment 17) on a REAL Postgres (PGlite),
// loading the actual file: idempotent, one report per job, the defaults the Lambda relies on
// (receipt OFF, sent_count 0), updated_at follows a write, the render statuses are closed, and
// the browser roles cannot touch either table.

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

const sql = await readFile(new URL("./2026-11-05_job_photo_reports.sql", import.meta.url), "utf8");
const db = new PGlite();
await db.exec(`create role anon; create role authenticated; create role service_role;`);

test("applies, and applies again; the browser roles have no privilege, the service role has", async () => {
  await db.exec(sql);
  await db.exec(sql);
  const r = (await db.query(`
    select has_table_privilege('anon', 'public.sundial_job_photo_reports', 'select') as a,
           has_table_privilege('authenticated', 'public.sundial_job_photo_reports', 'select') as b,
           has_table_privilege('authenticated', 'public.sundial_job_photo_report_renders', 'insert') as c,
           has_table_privilege('service_role', 'public.sundial_job_photo_reports', 'update') as svc,
           (select relrowsecurity from pg_class where relname = 'sundial_job_photo_reports') as rls1,
           (select relrowsecurity from pg_class where relname = 'sundial_job_photo_report_renders') as rls2`)).rows[0];
  assert.deepEqual(r, { a: false, b: false, c: false, svc: true, rls1: true, rls2: true });
  const policies = (await db.query(`select count(*)::int as n from pg_policies where tablename like 'sundial_job_photo_report%'`)).rows[0].n;
  assert.equal(policies, 0, "no browser policies: every read goes through a Lambda");
});

test("one report per job; the defaults: receipt off, nothing sent, empty cover and sections", async () => {
  await db.query(`insert into public.sundial_job_photo_reports (client_sf_id, job_sf_id) values ('a0T1', 'a1c1')`);
  const row = (await db.query(`select cover, sections, receipt, sent_count, public_token, created_at = updated_at as fresh from public.sundial_job_photo_reports where job_sf_id = 'a1c1'`)).rows[0];
  assert.deepEqual(row, { cover: {}, sections: [], receipt: false, sent_count: 0, public_token: null, fresh: true });
  await assert.rejects(db.query(`insert into public.sundial_job_photo_reports (client_sf_id, job_sf_id) values ('a0T1', 'a1c1')`), /duplicate key/);
});

test("the token is unique across jobs; updated_at moves on a write", async () => {
  await db.query(`insert into public.sundial_job_photo_reports (client_sf_id, job_sf_id, public_token, created_at, updated_at) values ('a0T1', 'a1c2', 'TOK', now() - interval '1 day', now() - interval '1 day')`);
  await assert.rejects(db.query(`insert into public.sundial_job_photo_reports (client_sf_id, job_sf_id, public_token) values ('a0T1', 'a1c3', 'TOK')`), /duplicate key/);
  await db.query(`update public.sundial_job_photo_reports set receipt = true where job_sf_id = 'a1c2'`);
  const r = (await db.query(`select updated_at > created_at as moved from public.sundial_job_photo_reports where job_sf_id = 'a1c2'`)).rows[0];
  assert.equal(r.moved, true);
});

test("a render row: queued by default, kind and status are closed lists", async () => {
  const r = (await db.query(`insert into public.sundial_job_photo_report_renders (client_sf_id, job_sf_id, kind) values ('a0T1', 'a1c1', 'send') returning status, hops`)).rows[0];
  assert.deepEqual(r, { status: "queued", hops: 0 });
  await assert.rejects(db.query(`insert into public.sundial_job_photo_report_renders (client_sf_id, job_sf_id, kind) values ('a0T1', 'a1c1', 'print')`), /check/);
  await assert.rejects(db.query(`update public.sundial_job_photo_report_renders set status = 'lost'`), /check/);
});
