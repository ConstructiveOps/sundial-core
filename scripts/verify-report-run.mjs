// scripts/verify-report-run.mjs — proves the report engine (D-088, Reporting R1a) end to end
// against the DEPLOYED API and database, as the ZZ TEST users. READ-ONLY: a report run
// writes nothing anywhere.
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
//   C. REFUSALS an unknown field is a 400 that names it; a dealer join (not in R1a) is a 400.
//   D. CATALOG  GET /reports/catalog?type=solar lists solar / customer / rep fields, no
//               non-reportable field (sf_id) and no table name.
//
// The solar type has no gated column, so the cost gate is proved by the unit and PGlite tests
// (lib/report-def.test.js, sql/sundial_report_run.test.js), not here.
//
// Passwords come from Secrets Manager `sundial/test-users`, never a file (CLAUDE.md:
// access testing uses the designated test users — never a live user).

import { loadTestPasswords, loginAsTestUser } from "./portal-login.mjs";

const API = (process.env.API_BASE_URL || "https://5sktfwldh1.execute-api.us-west-1.amazonaws.com/prod").replace(/\/+$/, "");
const TENANT_USERS = ["exec", "admin", "manager"];
const DENIED_USERS = ["rep-a1", "mgr-a", "tech"];

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
  const d = await api(tokens.admin, "POST", "/reports/run", { type: "solar", columns: ["dealer.name"] });
  check("a dealer join is not part of R1a (400)", d.status === 400 && d.body?.code === "UNKNOWN_FIELD", `${d.status} ${d.body?.code}`);
}

// --- D. catalog -----------------------------------------------------------------------------
console.log("\n== D. Catalog ==");
{
  const r = await api(tokens.manager, "GET", "/reports/catalog?type=solar");
  const aliases = (r.body?.aliases ?? []).map((a) => `${a.alias}:${a.fields.length}`);
  console.log(`  aliases ${aliases.join("  ")}`);
  check("catalog: solar, customer and rep", JSON.stringify((r.body?.aliases ?? []).map((a) => a.alias)) === JSON.stringify(["solar", "customer", "rep"]));
  check("catalog: no sf_id, no table names", !/"solar\.sf_id"|_cache/.test(r.text));
}

console.log(failures ? `\n${failures} check(s) FAILED.` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
