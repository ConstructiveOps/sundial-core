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
//   G. SAVED    zz-manager saves a PRIVATE report: zz-admin cannot list, read, edit, delete,
//               run or export it (404). zz-manager shares it THROUGH THE API (Managers share,
//               D-089): zz-admin can list, read and run it, but not change it (403
//               REPORT_READ_ONLY — managing others' reports is R2's reports.admin). zz-manager
//               takes it back to private and it is 404 again. Then zz-admin saves a private
//               report, zz-manager cannot see it, zz-admin shares it, zz-manager sees it
//               read-only (PATCH 403 REPORT_READ_ONLY) and can export it.
//               Since D-089 am. 1 the header ends with the link columns GET /reports/types
//               implies, and the first row's "Customer link" is a URL on Harmon's portal.
//   I. LINKS +  (D-089 am. 1, runs between F and G) the page map in /reports/types; an
//      VALUES   ungrouped run's records parallel to rows and agreeing with them, none when
//               grouped; catalog nameField / valuesLookup; GET /reports/values ordered, its
//               solar.stage counts equal a grouped count, q narrows, a joined alias works, a
//               number / an id are 400, sales / tech 403. Counts only — no value printed.
//   S. SUMMARY  (D-093, runs after F) zz-admin runs solar by rep WITH DETAILS: the groups'
//               first / shown tile the rows exactly, each group's count ≥ its shown rows, the
//               grand totals equal the ungrouped run's; an aggregate sort is 400 BAD_SORT; the
//               summary CSV has the group first, a subtotal after each group's rows (one per
//               group, carrying the run's counts) and the grand total last. Counts only.
//   H. DENIED  zz-rep-a1, zz-mgr-a and zz-tech get 403 MODULE_FORBIDDEN from every R1b route.
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
  // Data columns, then (D-089 am. 1) one "<alias label> link" per record alias with a page,
  // read from GET /reports/types — the same map the CSV is built from.
  const linkTitles = [typeInfo?.base, ...(typeInfo?.joins ?? []).filter((j) => j.kind !== "rollup")]
    .filter((a) => a && (a.recordPath || a.linkVia)).map((a) => quote(`${a.label} link`));
  const expectedHeader = [...(shape.body?.columns ?? []).map((c) => quote(`${labels.get(c.object)}: ${c.label}`)), ...linkTitles].join(",");
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
      // The base record always exists, so the first row's "Customer link" is a full URL on
      // Harmon's portal (the primary tenant's origin). The URL itself is not printed.
      const second = text.slice(firstLine.length + 2, text.indexOf("\r\n", firstLine.length + 2));
      const lastCell = second.slice(second.lastIndexOf(",") + 1);
      const linkOk = /^https:\/\/sundial\.harmonelectric\.net\/customers\/[A-Za-z0-9]{15,18}$/.test(lastCell);
      check("the first row ends with the customer's portal link (D-089 am. 1)", linkOk,
        linkOk ? "" : lastCell.startsWith("https://") ? "a URL of another shape" : "not a URL");
      check("12,000 rows asked → 12,000 rows, truncated", s.body.rowCount === 12000 && s.body.truncated === true, `${s.body.rowCount} ${s.body.truncated}`);
      console.log(`  ${(buf.length / 1024).toFixed(0)} KB downloaded (kept in memory only)`);
    }
    const other = await api(tokens.manager, "GET", `/reports/csv/${q.body.exportId}`);
    check("another user's export is 404 RECORD_NOT_FOUND", other.status === 404 && other.body?.code === "RECORD_NOT_FOUND", `${other.status}`);
  }
}

// --- S. summary reports (D-093) ---------------------------------------------------------------
console.log("\n== S. Summary report (showDetails, D-093) ==");
{
  const SUM_DEF = {
    type: "solar", showDetails: true, groupBy: ["rep.name"],
    columns: ["solar.project_name", "solar.stage", "solar.contract_amount"],
    aggregates: [{ fn: "count" }, { fn: "sum", field: "solar.contract_amount" }],
    sort: [{ field: "solar.contract_amount", dir: "desc" }],
  };
  const r = await api(tokens.admin, "POST", "/reports/run", SUM_DEF);
  check("summary run as zz-admin → 200", r.status === 200, r.status === 200 ? "" : `${r.status} ${r.text.slice(0, 300)}`);
  const b = r.body ?? {};
  const rows = b.rows ?? [];
  const groups = b.groups ?? [];
  console.log(`  rows ${rows.length}  groups on page ${groups.length}  groupCount ${b.groupCount}  totalRows ${b.totalRows}  truncated ${b.truncated}  asOf ${b.asOf ?? "—"}`);
  // first / shown tile the rows exactly: group k starts where k-1 ended, the last ends at the last row.
  let next = 0;
  let tiles = groups.length > 0;
  for (const g of groups) {
    if (g.first !== next || !(g.shown >= 1)) tiles = false;
    next = g.first + g.shown;
  }
  check("summary: groups' first / shown tile the rows exactly", tiles && next === rows.length, `${groups.length} groups end at ${next} of ${rows.length}`);
  check("summary: each group's count ≥ its shown rows", groups.every((g) => Number(g.count) >= g.shown));
  check("summary: each group's count aggregate equals its count", groups.every((g) => Number(g.aggregates?.count) === Number(g.count)));
  check("summary: records parallel to rows", Array.isArray(b.records) && b.records.length === rows.length);
  check("summary: groupCount ≥ the groups on the page", Number(b.groupCount) >= groups.length);
  if (!b.truncated && Number(b.groupCount) === groups.length) {
    const sum = groups.reduce((n, g) => n + Number(g.count), 0);
    check("summary: every group on the page, so their counts add up to totalRows", sum === Number(b.totalRows), `${sum} vs ${b.totalRows}`);
  }
  // The grand totals are the plain (ungrouped) run's.
  const plain = await api(tokens.admin, "POST", "/reports/run", { type: "solar", columns: ["solar.project_name"], aggregates: SUM_DEF.aggregates, limit: 1 });
  const val = (resp, f) => Number((resp.body?.aggregates ?? []).find((a) => a.field === f)?.value ?? NaN);
  for (const f of ["count", "sum_solar_contract_amount"]) {
    const a = val(r, f);
    const p = val(plain, f);
    check(`summary: grand total ${f} = the ungrouped run's`, Number.isFinite(a) && Math.abs(a - p) < 0.005, `${a} vs ${p}`);
  }
  check("summary: totalRows = the ungrouped count", Number(b.totalRows) === val(plain, "count"), `${b.totalRows} vs ${val(plain, "count")}`);
  const agg = await api(tokens.admin, "POST", "/reports/run", { ...SUM_DEF, sort: [{ field: "count", dir: "desc" }] });
  check("summary: sorting the groups by a total is a 400 BAD_SORT (not in v1)", agg.status === 400 && agg.body?.code === "BAD_SORT", `${agg.status} ${agg.body?.code ?? ""}`);

  // The CSV: group first, a subtotal after each group's last row, a grand total at the end.
  const q = await api(tokens.admin, "POST", "/reports/csv", SUM_DEF);
  if (q.body?.exportId) exportIds.push(q.body.exportId);
  check("summary CSV: POST → 202", q.status === 202, `${q.status} ${q.text.slice(0, 200)}`);
  if (q.body?.exportId) {
    const s = await waitForExport(tokens.admin, q.body.exportId);
    console.log(`  summary export ${s.body?.status} in ${s.seconds.toFixed(1)} s  rowCount ${s.body?.rowCount}  truncated ${s.body?.truncated}`);
    check("summary CSV: the export finishes", s.body?.status === "done", JSON.stringify({ status: s.body?.status, code: s.body?.code }));
    if (s.body?.status === "done") {
      const text = Buffer.from(await (await fetch(s.body.url)).arrayBuffer()).toString("utf8").replace(/^﻿/, "");
      const lines = text.split("\r\n").filter((l, i, all) => !(i === all.length - 1 && l === ""));
      const firstCell = (line) => {
        if (!line.startsWith('"')) return line.slice(0, line.indexOf(",") < 0 ? line.length : line.indexOf(","));
        let i = 1;
        let out = "";
        for (; i < line.length; i++) {
          if (line[i] === '"' && line[i + 1] === '"') { out += '"'; i++; } else if (line[i] === '"') break; else out += line[i];
        }
        return out;
      };
      const header = lines[0];
      check("summary CSV: the header starts with the group and ends its data part with the aggregates",
        header.startsWith("Sales rep: User Name,Solar project: Project Name,") && /,Count,Sum of Contract Amount(,|$)/.test(header), header.slice(0, 160));
      const isSub = (l) => firstCell(l).startsWith("Subtotal: ");
      const isGrand = (l) => firstCell(l).startsWith("Grand total");
      let details = 0;
      let subtotals = 0;
      let order = true;
      let prevKey = null;
      for (let i = 1; i < lines.length; i++) {
        const l = lines[i];
        if (isGrand(l)) {
          if (i !== lines.length - 1 || !isSub(lines[i - 1])) order = false;
        } else if (isSub(l)) {
          subtotals++;
          if (isSub(lines[i - 1]) || i === 1) order = false; // a subtotal follows a detail row
          prevKey = null;
        } else {
          details++;
          const key = firstCell(l);
          if (prevKey !== null && key !== prevKey) order = false; // a new group must come after a subtotal
          prevKey = key;
        }
      }
      check("summary CSV: the last line is the grand total", isGrand(lines[lines.length - 1] ?? ""));
      check("summary CSV: a subtotal after each group's rows, before the next group and before the grand total", order);
      check("summary CSV: one subtotal per group", subtotals === Number(b.groupCount), `${subtotals} vs ${b.groupCount}`);
      check("summary CSV: rowCount detail rows", details === s.body.rowCount, `${details} vs ${s.body.rowCount}`);
      // The subtotals carry the same counts as the run's groups (labels compared, never printed).
      const subs = new Set(lines.filter(isSub).map(firstCell));
      const missing = groups.filter((g) => !subs.has(`Subtotal: ${g.label} (${g.count} record${g.count === 1 ? "" : "s"})`)).length;
      check("summary CSV: each on-screen group's subtotal line carries its full count", missing === 0, `${missing} of ${groups.length} missing`);
      check("summary CSV: the grand total line names totalRows", firstCell(lines[lines.length - 1] ?? "") === `Grand total (${b.totalRows} record${Number(b.totalRows) === 1 ? "" : "s"})`);
    }
  }
}

// --- I. record links + distinct values (D-089 amendment 1) ------------------------------------
console.log("\n== I. Record links + distinct values (D-089 am. 1) ==");
{
  // Types: the page map, served once.
  const ty = (key) => TYPES.find((t) => t.key === key);
  const all = (t) => [t.base, ...t.joins];
  check("types: customers' base opens /customers/{id}", ty("customers")?.base.recordPath === "/customers/{id}");
  check("types: a service job's invoice links via the job", all(ty("service_jobs") ?? { base: {}, joins: [] }).find((a) => a.alias === "invoice")?.linkVia === "job");
  const badVia = TYPES.flatMap((t) => all(t).filter((a) => a.linkVia && !all(t).find((x) => x.alias === a.linkVia)?.recordPath).map((a) => `${t.key}.${a.alias}`));
  check("types: every linkVia names an alias of the same type that has a page", badVia.length === 0, badVia.join(", "));

  // Records: the detail run (ungrouped) carries one per row; the grouped run none.
  const d = await api(tokens.admin, "POST", "/reports/run", DEFINITIONS.detail);
  const rows = d.body?.rows ?? [];
  const recs = d.body?.records ?? null;
  check("ungrouped run: records parallel to rows", Array.isArray(recs) && recs.length === rows.length && rows.length > 0, `${recs?.length} records / ${rows.length} rows`);
  if (Array.isArray(recs) && recs.length === rows.length) {
    const solarOk = rows.every((row, i) => recs[i].solar?.sfId && recs[i].solar.name === row[0]);
    check("each row's solar record: an id and its name = the row's project name", solarOk);
    const custOk = rows.every((row, i) => (recs[i].customer === null ? row[1] === null : recs[i].customer.name === row[1] && /^[A-Za-z0-9]{15,18}$/.test(recs[i].customer.sfId)));
    check("each row's customer record matches the row (null where the row has no customer)", custOk);
    console.log(`  ${rows.length} rows; ${recs.filter((r) => r.customer).length} with a customer, ${recs.filter((r) => r.rep).length} with a rep, ${recs.filter((r) => r.dealer).length} with a dealer`);
  }
  const g = await api(tokens.admin, "POST", "/reports/run", DEFINITIONS.byRepYtd);
  check("grouped run: no records key", g.status === 200 && !("records" in (g.body ?? {})));

  // Catalog flags.
  const cat = await api(tokens.manager, "GET", "/reports/catalog?type=solar");
  const flds = (cat.body?.aliases ?? []).flatMap((a) => a.fields);
  const f = (ref) => flds.find((x) => x.field === ref);
  check("catalog: solar's name field is project_name", f("solar.project_name")?.nameField === true && flds.filter((x) => x.nameField && x.field.startsWith("solar.")).length === 1);
  check("catalog: solar.stage offers values, contract_amount does not", f("solar.stage")?.valuesLookup === true && !f("solar.contract_amount")?.valuesLookup);

  // Values: solar.stage's counts agree with a grouped count of the same column.
  const v = await api(tokens.manager, "GET", "/reports/values?type=solar&field=solar.stage");
  const vals = v.body?.values ?? [];
  // On failure the status and error code only — never the body (it holds values).
  check("GET /reports/values solar.stage → 200 with values", v.status === 200 && vals.length > 0, `${v.status} ${v.body?.code ?? ""} ${vals.length} values`);
  const sorted = vals.every((x, i) => i === 0 || vals[i - 1].count > x.count || (vals[i - 1].count === x.count && vals[i - 1].value <= x.value));
  check("values: most frequent first, then by value; ≤ 200; partial says whether more exist",
    sorted && vals.length <= 200 && v.body?.partial === (v.body?.totalDistinct > vals.length), `${vals.length} of ${v.body?.totalDistinct}`);
  const byStage = await api(tokens.manager, "POST", "/reports/run", { type: "solar", groupBy: ["solar.stage"], aggregates: [{ fn: "count" }], limit: 5000 });
  const groupCount = new Map((byStage.body?.rows ?? []).filter((r) => r[0] !== null && String(r[0]).trim() !== "").map((r) => [r[0], Number(r[1])]));
  const agree = !v.body?.partial && vals.length === groupCount.size && vals.every((x) => groupCount.get(x.value) === Number(x.count));
  check("values: the same stages and counts as a grouped run of solar.stage", agree, `${vals.length} values vs ${groupCount.size} groups`);

  const s = await api(tokens.manager, "GET", "/reports/values?type=customers&field=customer.city&q=mes");
  check("values: q narrows (every city contains 'mes', any case)", s.status === 200 && (s.body?.values ?? []).every((x) => String(x.value).toLowerCase().includes("mes")), `${s.status} ${(s.body?.values ?? []).length} values`);
  const j = await api(tokens.manager, "GET", "/reports/values?type=customers&field=rep.name");
  check("values: a joined alias (customers → rep.name) reads its own object", j.status === 200 && (j.body?.values ?? []).length > 0, `${j.status}`);
  const n = await api(tokens.manager, "GET", "/reports/values?type=solar&field=solar.contract_amount");
  check("values: a number is 400 VALUES_NOT_AVAILABLE", n.status === 400 && n.body?.code === "VALUES_NOT_AVAILABLE", `${n.status} ${n.body?.code ?? ""}`);
  const id = await api(tokens.manager, "GET", "/reports/values?type=solar&field=solar.sales_rep_sf_id");
  check("values: an id is 400 VALUES_NOT_AVAILABLE", id.status === 400 && id.body?.code === "VALUES_NOT_AVAILABLE", `${id.status} ${id.body?.code ?? ""}`);
  for (const slug of DENIED_USERS) {
    const r = await api(tokens[slug], "GET", "/reports/values?type=solar&field=solar.stage");
    check(`zz-${slug} GET /reports/values → 403 MODULE_FORBIDDEN`, r.status === 403 && r.body?.code === "MODULE_FORBIDDEN", `${r.status}`);
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
    check("zz-manager shares it through the API (200)", share.status === 200 && share.body?.sharing === "tenant", `${share.status} ${share.body?.code ?? ""}`);
    check("zz-admin lists it once shared", (await listIds("admin")).includes(mgrReportId));
    const g = await api(tokens.admin, "GET", `/reports/${mgrReportId}`);
    check("zz-admin reads it once shared, read-only", g.status === 200 && g.body?.mine === false && g.body?.canEdit === false, `${g.status}`);
    const ro = await api(tokens.admin, "PATCH", `/reports/${mgrReportId}`, { name: "taken" });
    check("zz-admin's edit is 403 REPORT_READ_ONLY (reports.admin is R2)", ro.status === 403 && ro.body?.code === "REPORT_READ_ONLY", `${ro.status} ${ro.body?.code}`);
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
