// scripts/verify-report-run.mjs — proves the report engine (D-088 R1a, D-089 R1b) end to end
// against the DEPLOYED API and database, as the ZZ TEST users. READ-ONLY except for the
// saved-report rows (and their CSV exports) it creates itself, which it deletes at the end —
// named "ZZ VERIFY …", so a run that dies half-way is cleaned up by the next one.
//
//   node scripts/verify-report-run.mjs
//
// What it checks:
//   A. ACCESS   zz-exec, zz-admin and zz-manager (Executive / Admin / Manager) get 200 from
//               all three routes; zz-rep-a1 (Sales Rep), zz-mgr-a (Sales Dealer) and zz-tech
//               (Technician) get 403 MODULE_FORBIDDEN from all three.
//   B. RUNS     three solar definitions, run as each tenant-scope user: a detail list (joins
//               to customer + rep), totals by rep for the year to date (a relative date, in
//               Arizona time), and counts by stage filtered THROUGH the customer join. Prints
//               the row counts, `truncated` and `asOf`; the three users must get the SAME
//               numbers (one tenant, one cache), and the grand-total count must equal the sum
//               of the per-group counts.
//   C. REFUSALS an unknown field is a 400 that names it; solar has no PM join (a 400).
//   D. CATALOG  GET /reports/catalog?type=solar lists solar / customer / rep / dealer fields, no
//               non-reportable field (sf_id) and no table name.
//   E. TYPES    every report type (all ten) run as zz-admin with its default columns: row
//               count, truncated, asOf.
//   F. CSV      zz-admin exports 12,000 customers (three 5,000-row pages): POST → exportId, the
//               status is polled until done, the presigned URL downloads, its first line is the
//               header (BOM, "<object>: <field>") and it holds rowCount rows. Nothing is written
//               to disk and no value is printed.
//   G. SAVED    zz-manager saves a PRIVATE report: zz-admin cannot list, read or run it (404);
//               zz-manager's own attempt to share it is 403 SHARE_FORBIDDEN. The script then
//               flips that one row to shared with the service role (no one can through the API
//               yet: an Admin cannot see another's private report — reports.admin is R2) and
//               zz-admin can list, read and run it; zz-manager takes it back to private and it
//               is 404 again. Then zz-admin saves a private report, zz-manager cannot see it,
//               zz-admin shares it, zz-manager sees it read-only (PATCH 403 REPORT_READ_ONLY).
//   H. DENIED   zz-rep-a1, zz-mgr-a and zz-tech get 403 MODULE_FORBIDDEN from every R1b route.
//   CLEANUP     every "ZZ VERIFY" report deleted (through the API, then any leftover by the
//               service role), and every export this run made: its CSV file in S3 and its row.
//
// The solar type has no gated column, so the cost gate is proved by the unit and PGlite tests
// (lib/report-def.test.js, sql/sundial_report_run.test.js), not here.
//
// Passwords come from Secrets Manager `sundial/test-users`, never a file (CLAUDE.md:
// access testing uses the designated test users — never a live user).

import { loadTestPasswords, loginAsTestUser } from "./portal-login.mjs";
import { getSupabaseClient } from "../lib/supabase.js";
import { S3Client, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { REPORTS_BUCKET, REPORTS_REGION, quote } from "../lib/report-csv.js";

const API = (process.env.API_BASE_URL || "https://5sktfwldh1.execute-api.us-west-1.amazonaws.com/prod").replace(/\/+$/, "");
const TENANT_USERS = ["exec", "admin", "manager"];
const DENIED_USERS = ["rep-a1", "mgr-a", "tech"];
const VERIFY_PREFIX = "ZZ VERIFY";

const DEFINITIONS = {
  detail: {
    type: "solar",
    columns: ["solar.project_name", "customer.name", "solar.stage", "rep.name", "solar.contract_amount", "solar.contract_date"],
    filters: [{ field: "solar.stage", op: "not_blank" }],
    sort: [{ field: "solar.contract_amount", dir: "desc" }],
    limit: 200,
  },
  byRepYtd: {
    type: "solar",
    groupBy: ["rep.name"],
    aggregates: [{ fn: "count" }, { fn: "sum", field: "solar.contract_amount" }],
    filters: [{ field: "solar.contract_date", op: "between", value: "ytd" }],
    sort: [{ field: "sum_solar_contract_amount", dir: "desc" }],
  },
  byStageThroughCustomer: {
    type: "solar",
    groupBy: ["solar.stage"],
    aggregates: [{ fn: "count" }],
    filters: [{ field: "customer.city", op: "not_blank" }],
    sort: [{ field: "count", dir: "desc" }],
  },
};

let failures = 0;
function check(label, cond, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
  if (!cond) failures++;
}

async function api(token, method, path, body) {
  const resp = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Origin: "http://localhost:5173" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await resp.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not json */
  }
  return { status: resp.status, body: json, text };
}

const passwords = await loadTestPasswords();
const tokens = {};
for (const slug of [...TENANT_USERS, ...DENIED_USERS]) {
  const { token, status } = await loginAsTestUser(slug, passwords);
  if (!token) throw new Error(`zz-${slug}: sign-in failed (${status}) — re-seed the fixtures.`);
  tokens[slug] = token;
}

// --- A. access --------------------------------------------------------------------------
console.log("\n== A. Access ==");
const ROUTES = [
  ["GET", "/reports/types"],
  ["GET", "/reports/catalog?type=solar"],
  ["POST", "/reports/run", DEFINITIONS.byStageThroughCustomer],
];
for (const slug of TENANT_USERS) {
  for (const [m, p, b] of ROUTES) {
    const r = await api(tokens[slug], m, p, b);
    check(`zz-${slug} ${m} ${p} → 200`, r.status === 200, r.status === 200 ? "" : r.text.slice(0, 200));
  }
}
for (const slug of DENIED_USERS) {
  for (const [m, p, b] of ROUTES) {
    const r = await api(tokens[slug], m, p, b);
    check(`zz-${slug} ${m} ${p} → 403 MODULE_FORBIDDEN`, r.status === 403 && r.body?.code === "MODULE_FORBIDDEN", `${r.status} ${r.body?.code ?? ""}`);
  }
}

// --- B. runs -------------------------------------------------------------------------------
console.log("\n== B. Runs ==");
const results = {};
for (const [name, def] of Object.entries(DEFINITIONS)) {
  results[name] = {};
  for (const slug of TENANT_USERS) {
    const r = await api(tokens[slug], "POST", "/reports/run", def);
    results[name][slug] = r.body;
    if (r.status !== 200) {
      check(`${name} as zz-${slug}`, false, `${r.status} ${r.text.slice(0, 300)}`);
      continue;
    }
    const total = r.body.aggregates.find((a) => a.field === "count")?.value;
    console.log(
      `  ${name.padEnd(24)} zz-${slug.padEnd(8)} rows ${String(r.body.rows.length).padStart(5)}` +
        `  truncated ${r.body.truncated}  asOf ${r.body.asOf ?? "—"}` +
        (total !== undefined ? `  total count ${total}` : "") +
        (r.body.stripped.length ? `  stripped ${r.body.stripped.join(", ")}` : "")
    );
    check(`${name} as zz-${slug}: columns describe every row position`, r.body.rows.every((row) => row.length === r.body.columns.length));
  }
  const [first, ...rest] = TENANT_USERS.map((s) => results[name][s]).filter(Boolean);
  if (first) {
    check(`${name}: every tenant user gets the same rows`, rest.every((x) => JSON.stringify(x.rows) === JSON.stringify(first.rows)));
  }
}
for (const name of ["byRepYtd", "byStageThroughCustomer"]) {
  const r = results[name].admin;
  if (!r) continue;
  const countAt = r.columns.findIndex((c) => c.field === "count");
  const sum = r.rows.reduce((n, row) => n + Number(row[countAt] || 0), 0);
  const total = r.aggregates.find((a) => a.field === "count")?.value;
  check(`${name}: the per-group counts add up to the grand total`, r.truncated || sum === Number(total), `${sum} vs ${total}`);
}
const detail = results.detail.admin;
if (detail) {
  const amountAt = detail.columns.findIndex((c) => c.field === "solar.contract_amount");
  const amounts = detail.rows.map((row) => row[amountAt]).filter((v) => v !== null).map(Number);
  check("detail: sorted by contract amount, largest first", amounts.every((v, i) => i === 0 || amounts[i - 1] >= v));
  check("detail: the customer and rep joins return names", detail.rows.some((row) => row[1]) && detail.rows.some((row) => row[3]));
}

// --- C. refusals ---------------------------------------------------------------------------
console.log("\n== C. Refusals ==");
{
  const r = await api(tokens.admin, "POST", "/reports/run", { type: "solar", columns: ["solar.no_such_field"] });
  check("an unknown field is a 400 that names it", r.status === 400 && r.body?.field === "columns[0]" && r.body?.code === "UNKNOWN_FIELD", `${r.status} ${r.body?.code}`);
  const d = await api(tokens.admin, "POST", "/reports/run", { type: "solar", columns: ["pm.name"] });
  check("solar has no PM join (400)", d.status === 400 && d.body?.code === "UNKNOWN_FIELD", `${d.status} ${d.body?.code}`);
}

// --- D. catalog -----------------------------------------------------------------------------
console.log("\n== D. Catalog ==");
{
  const r = await api(tokens.manager, "GET", "/reports/catalog?type=solar");
  const aliases = (r.body?.aliases ?? []).map((a) => `${a.alias}:${a.fields.length}`);
  console.log(`  aliases ${aliases.join("  ")}`);
  check("catalog: solar, customer, rep and dealer", JSON.stringify((r.body?.aliases ?? []).map((a) => a.alias)) === JSON.stringify(["solar", "customer", "rep", "dealer"]));
  check("catalog: no sf_id, no table names", !/"solar\.sf_id"|_cache/.test(r.text));
}

// --- E. every type -----------------------------------------------------------------------
console.log("\n== E. Every report type, default columns, as zz-admin ==");
const typesResp = await api(tokens.admin, "GET", "/reports/types");
const TYPES = typesResp.body?.types ?? [];
check("ten report types", TYPES.length === 10, TYPES.map((t) => t.key).join(", "));
for (const t of TYPES) {
  const r = await api(tokens.admin, "POST", "/reports/run", { type: t.key });
  if (r.status !== 200) {
    check(`${t.key}: runs`, false, `${r.status} ${r.text.slice(0, 300)}`);
    continue;
  }
  console.log(`  ${t.key.padEnd(18)} rows ${String(r.body.rows.length).padStart(5)}  truncated ${r.body.truncated}  asOf ${r.body.asOf ?? "—"}`);
  check(`${t.key}: runs with its ${t.defaultColumns.length} default columns`, r.body.columns.length === t.defaultColumns.length && r.body.rows.every((row) => row.length === t.defaultColumns.length));
}

// --- F. CSV ----------------------------------------------------------------------------------
console.log("\n== F. CSV export ==");
const CSV_DEF = { type: "customers", columns: ["customer.name", "customer.city", "customer.stage", "dealer.name", "rep.name", "customer.created_date"], sort: [{ field: "customer.created_date", dir: "desc" }], limit: 12000 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const exportIds = [];
/** Count CSV records (a quoted field may hold a line break). */
function csvRecords(text) {
  let n = 0;
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') inQ = !inQ;
    else if (!inQ && c === "\n") n++;
  }
  return n;
}
async function waitForExport(token, exportId, label) {
  const started = Date.now();
  for (;;) {
    const s = await api(token, "GET", `/reports/csv/${exportId}`);
    if (s.status !== 200 || s.body?.status === "done" || s.body?.status === "failed") return { ...s, seconds: (Date.now() - started) / 1000 };
    if (Date.now() - started > 240_000) return { status: 0, body: { status: "timeout" }, seconds: 240 };
    await sleep(2000);
  }
}
{
  const typeInfo = TYPES.find((t) => t.key === "customers");
  const labels = new Map([[typeInfo?.base.alias, typeInfo?.base.label], ...(typeInfo?.joins ?? []).map((j) => [j.alias, j.label])]);
  const shape = await api(tokens.admin, "POST", "/reports/run", { ...CSV_DEF, limit: 1 });
  const expectedHeader = (shape.body?.columns ?? []).map((c) => quote(`${labels.get(c.object)}: ${c.label}`)).join(",");
  const q = await api(tokens.admin, "POST", "/reports/csv", CSV_DEF);
  if (q.body?.exportId) exportIds.push(q.body.exportId);
  check("POST /reports/csv → 202 { exportId }", q.status === 202 && /^[0-9a-f-]{36}$/.test(q.body?.exportId ?? ""), `${q.status} ${q.text.slice(0, 200)}`);
  if (q.body?.exportId) {
    const s = await waitForExport(tokens.admin, q.body.exportId);
    console.log(`  export ${s.body?.status} in ${s.seconds.toFixed(1)} s  rowCount ${s.body?.rowCount}  truncated ${s.body?.truncated}  asOf ${s.body?.asOf ?? "—"}`);
    check("the export finishes", s.body?.status === "done", JSON.stringify({ status: s.body?.status, code: s.body?.code }));
    if (s.body?.status === "done") {
      check("the link lasts 15 minutes", Math.abs(Date.parse(s.body.expiresAt) - Date.now() - 15 * 60_000) < 120_000);
      check("the file is under REPORTS/, never SUNDIAL/", /\/REPORTS\//.test(new URL(s.body.url).pathname) && !/\/SUNDIAL\//.test(new URL(s.body.url).pathname));
      const dl = await fetch(s.body.url);
      const buf = Buffer.from(await dl.arrayBuffer());
      check("the presigned URL downloads", dl.ok, `HTTP ${dl.status}`);
      const text = buf.toString("utf8");
      const firstLine = text.slice(0, text.indexOf("\r\n"));
      check("it starts with the UTF-8 BOM", buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf);
      check("its first line is the header", firstLine === `\uFEFF${expectedHeader}`, firstLine.replace("\uFEFF", "").slice(0, 200));
      check("it holds rowCount rows (+ the header)", csvRecords(text) === s.body.rowCount + 1, `${csvRecords(text) - 1} vs ${s.body.rowCount}`);
      check("12,000 rows asked → 12,000 rows, truncated", s.body.rowCount === 12000 && s.body.truncated === true, `${s.body.rowCount} ${s.body.truncated}`);
      console.log(`  ${(buf.length / 1024).toFixed(0)} KB downloaded (kept in memory only)`);
    }
    const other = await api(tokens.manager, "GET", `/reports/csv/${q.body.exportId}`);
    check("another user's export is 404 RECORD_NOT_FOUND", other.status === 404 && other.body?.code === "RECORD_NOT_FOUND", `${other.status}`);
  }
}

// --- G. saved reports ------------------------------------------------------------------------
console.log("\n== G. Saved reports ==");
const supabase = await getSupabaseClient();
// A run that died half-way left rows behind: clear them first (only ours, by name).
await supabase.from("sundial_reports").delete().like("name", `${VERIFY_PREFIX}%`);
const created = [];
const listIds = async (slug) => ((await api(tokens[slug], "GET", "/reports")).body?.reports ?? []).map((r) => r.id);
let mgrReportId = null;
{
  const c = await api(tokens.manager, "POST", "/reports", { name: `${VERIFY_PREFIX} manager private`, definition: DEFINITIONS.byStageThroughCustomer });
  check("zz-manager saves a private report (201)", c.status === 201 && c.body?.sharing === "private" && c.body?.mine === true, `${c.status} ${c.text.slice(0, 200)}`);
  mgrReportId = c.body?.id;
  if (mgrReportId) {
    created.push(["manager", mgrReportId]);
    check("zz-manager lists it", (await listIds("manager")).includes(mgrReportId));
    check("zz-admin does NOT list it", !(await listIds("admin")).includes(mgrReportId));
    for (const [m, path] of [["GET", `/reports/${mgrReportId}`], ["GET", `/reports/${mgrReportId}/run`], ["GET", `/reports/${mgrReportId}/csv`], ["PATCH", `/reports/${mgrReportId}`], ["DELETE", `/reports/${mgrReportId}`]]) {
      const r = await api(tokens.admin, m, path, m === "PATCH" ? { name: "taken" } : undefined);
      check(`zz-admin ${m} ${path.replace(mgrReportId, "{id}")} → 404 while private`, r.status === 404 && r.body?.code === "RECORD_NOT_FOUND", `${r.status}`);
    }
    const share = await api(tokens.manager, "PATCH", `/reports/${mgrReportId}`, { sharing: "tenant" });
    check("zz-manager cannot share (403 SHARE_FORBIDDEN)", share.status === 403 && share.body?.code === "SHARE_FORBIDDEN", `${share.status} ${share.body?.code}`);
    // No API path shares another user's private report yet (reports.admin is R2): flip our own
    // test row with the service role to prove the visibility rule once it IS shared.
    const { error } = await supabase.from("sundial_reports").update({ sharing: "tenant" }).eq("id", mgrReportId).like("name", `${VERIFY_PREFIX}%`);
    check("(service role) the test row is set to shared", !error, error?.message);
    check("zz-admin lists it once shared", (await listIds("admin")).includes(mgrReportId));
    const g = await api(tokens.admin, "GET", `/reports/${mgrReportId}`);
    check("zz-admin reads it once shared (and may edit it: reports.share)", g.status === 200 && g.body?.mine === false && g.body?.canEdit === true, `${g.status}`);
    const run = await api(tokens.admin, "GET", `/reports/${mgrReportId}/run`);
    check("zz-admin runs it once shared", run.status === 200 && Array.isArray(run.body?.rows), `${run.status}`);
    const back = await api(tokens.manager, "PATCH", `/reports/${mgrReportId}`, { sharing: "private" });
    check("zz-manager takes it back to private (200)", back.status === 200 && back.body?.sharing === "private", `${back.status}`);
    check("…and zz-admin gets 404 again", (await api(tokens.admin, "GET", `/reports/${mgrReportId}`)).status === 404);
  }
  const a = await api(tokens.admin, "POST", "/reports", { name: `${VERIFY_PREFIX} admin`, definition: DEFINITIONS.byRepYtd });
  const adminId = a.body?.id;
  check("zz-admin saves a private report (201)", a.status === 201, `${a.status}`);
  if (adminId) {
    created.push(["admin", adminId]);
    check("zz-manager cannot see zz-admin's private report", (await api(tokens.manager, "GET", `/reports/${adminId}`)).status === 404);
    const sh = await api(tokens.admin, "PATCH", `/reports/${adminId}`, { sharing: "tenant" });
    check("zz-admin shares it (200)", sh.status === 200 && sh.body?.sharing === "tenant", `${sh.status} ${sh.body?.code ?? ""}`);
    const seen = await api(tokens.manager, "GET", `/reports/${adminId}`);
    check("zz-manager sees it once shared, read-only", seen.status === 200 && seen.body?.canEdit === false, `${seen.status}`);
    const edit = await api(tokens.manager, "PATCH", `/reports/${adminId}`, { name: "x" });
    check("zz-manager's edit is 403 REPORT_READ_ONLY", edit.status === 403 && edit.body?.code === "REPORT_READ_ONLY", `${edit.status} ${edit.body?.code}`);
    const csv = await api(tokens.manager, "GET", `/reports/${adminId}/csv`);
    check("zz-manager can export the shared report (202)", csv.status === 202, `${csv.status}`);
    if (csv.body?.exportId) {
      exportIds.push(csv.body.exportId);
      const s = await waitForExport(tokens.manager, csv.body.exportId);
      check("…and that export finishes", s.body?.status === "done", JSON.stringify({ status: s.body?.status, code: s.body?.code }));
    }
  }
}

// --- H. denied ---------------------------------------------------------------------------------
console.log("\n== H. Sales and tech users: 403 on every R1b route ==");
{
  const id = mgrReportId ?? "00000000-0000-4000-8000-000000000000";
  const R1B_ROUTES = [
    ["POST", "/reports/csv", CSV_DEF], ["GET", `/reports/csv/${id}`], ["GET", "/reports"], ["POST", "/reports", { name: `${VERIFY_PREFIX} denied`, definition: CSV_DEF }],
    ["GET", `/reports/${id}`], ["PATCH", `/reports/${id}`, { name: "x" }], ["DELETE", `/reports/${id}`], ["GET", `/reports/${id}/run`], ["GET", `/reports/${id}/csv`],
  ];
  for (const slug of DENIED_USERS) {
    for (const [m, path, b] of R1B_ROUTES) {
      const r = await api(tokens[slug], m, path, b);
      check(`zz-${slug} ${m} ${path.replace(id, "{id}")} → 403 MODULE_FORBIDDEN`, r.status === 403 && r.body?.code === "MODULE_FORBIDDEN", `${r.status} ${r.body?.code ?? ""}`);
    }
  }
}

// --- cleanup --------------------------------------------------------------------------------
console.log("\n== Cleanup ==");
for (const [slug, id] of created) {
  const r = await api(tokens[slug], "DELETE", `/reports/${id}`);
  check(`zz-${slug} deletes its report (204)`, r.status === 204, `${r.status}`);
}
{
  const { data, error } = await supabase.from("sundial_reports").delete().like("name", `${VERIFY_PREFIX}%`).select("id");
  check("no ZZ VERIFY report left behind", !error && (data ?? []).length === 0, error?.message ?? `${(data ?? []).length} removed by the service role`);
}
if (exportIds.length) {
  // Let a still-running export finish first, so its file is not written after we delete it.
  for (let i = 0; i < 60; i++) {
    const { data } = await supabase.from("sundial_report_exports").select("id").in("id", exportIds).in("status", ["queued", "running"]);
    if (!(data ?? []).length) break;
    await sleep(2000);
  }
  const { data: rows } = await supabase.from("sundial_report_exports").select("id, s3_key").in("id", exportIds);
  const s3 = new S3Client({ region: REPORTS_REGION });
  let files = 0;
  for (const r of rows ?? []) {
    if (!r.s3_key || !r.s3_key.startsWith("REPORTS/")) continue;
    await s3.send(new DeleteObjectCommand({ Bucket: REPORTS_BUCKET, Key: r.s3_key }));
    files++;
  }
  const { error } = await supabase.from("sundial_report_exports").delete().in("id", exportIds);
  check(`this run's ${exportIds.length} export(s) removed (${files} file(s) + rows)`, !error, error?.message);
}

console.log(failures ? `\n${failures} check(s) FAILED.` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
