// scripts/verify-report-assist.mjs — proves the report assistant (D-092, R4) end to end against
// the DEPLOYED API, the real model and the real database, as the ZZ TEST users. It spends real
// model tokens (about a dozen turns) and writes only: the assistant's own log rows, and
// zz-admin's own daily counter (filled for the 429 check, then put back exactly as it was).
//
//   node scripts/verify-report-assist.mjs
//
// What it checks:
//   A. BUILD    five canned requests as zz-admin, with NO type (the router picks one): each
//               must come back as a definition of the expected type with the expected shape,
//               and that definition must RUN (POST /reports/run → 200).
//   B. ASK      an ambiguous request ("revenue last month" — the glossary says revenue is
//               ambiguous) must come back as ONE question and no definition.
//   C. REFINE   the first definition + "make it last quarter" → a definition on last_quarter.
//   D. EXPLAIN  a seeded definition → one paragraph.
//   E. DENIED   zz-rep-a1 → 403 MODULE_FORBIDDEN.
//   F. BUDGET   zz-admin's daily counter filled → 429 ASSIST_BUDGET_EXHAUSTED (scope user), the
//               counter restored afterwards.
// It prints, per turn: the latency the caller saw, and per model call its kind, input / output /
// cache-read / cache-write tokens and milliseconds; then one totals line. Never a data row.
//
// Passwords come from Secrets Manager `sundial/test-users` (CLAUDE.md: designated test users).

import { loadTestPasswords, loginAsTestUser } from "./portal-login.mjs";
import { getSupabaseClient } from "../lib/supabase.js";
import { arizonaToday } from "../lib/report-def.js";

const API = (process.env.API_BASE_URL || "https://5sktfwldh1.execute-api.us-west-1.amazonaws.com/prod").replace(/\/+$/, "");

let failures = 0;
function check(label, cond, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
  if (!cond) failures++;
}

async function api(token, method, path, body) {
  const started = Date.now();
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
  return { status: resp.status, body: json, text, ms: Date.now() - started };
}

const turns = [];
function report(label, r) {
  const u = r.body?.usage;
  turns.push({ label, ms: r.ms, usage: u });
  console.log(`      ${label}: HTTP ${r.status}, ${r.ms} ms seen by the caller${r.body?.type ? `, type ${r.body.type}` : ""}${r.body?.outcome ? `, outcome ${r.body.outcome}` : ""}`);
  for (const c of u?.calls ?? []) {
    console.log(`        call ${c.kind.padEnd(7)} in ${String(c.inputTokens).padStart(6)}  out ${String(c.outputTokens).padStart(5)}  cache-read ${String(c.cacheReadTokens).padStart(6)}  cache-write ${String(c.cacheWriteTokens).padStart(6)}  ${c.ms} ms`);
  }
}

const fieldsOf = (def) => JSON.stringify(def ?? {});
const groupField = (def) => (typeof def?.groupBy?.[0] === "string" ? def.groupBy[0] : def?.groupBy?.[0]?.field);

const passwords = await loadTestPasswords();
const admin = await loginAsTestUser("admin", passwords);
const rep = await loginAsTestUser("rep-a1", passwords);
if (!admin.token || !rep.token) throw new Error("ZZ sign-in failed — re-seed the fixtures (scripts/seed-access-test-fixtures.mjs).");
const adminProfile = JSON.parse(Buffer.from(admin.token.split(".")[1], "base64url").toString("utf8")).sub;

const build = (content) => api(admin.token, "POST", "/reports/assist", { mode: "build", messages: [{ role: "user", content }] });

// --- A. five canned requests ---------------------------------------------------------------
console.log("\n== A. Build (no type given: the router picks it) ==");
const CANNED = [
  {
    ask: "solar projects sold this quarter by rep with contract totals", types: ["solar", "customers_solar"],
    shape: (d) => /contract_date/.test(fieldsOf(d.filters)) && /this_quarter/.test(fieldsOf(d.filters)) && /rep\./.test(groupField(d) ?? "") && /contract_amount/.test(fieldsOf(d.aggregates)),
    expect: "filter contract_date this_quarter, group by rep, sum contract_amount",
  },
  {
    ask: "service jobs still open, oldest first", types: ["service_jobs"],
    shape: (d) => /"Paid"/.test(fieldsOf(d.filters)) && /"Closed"/.test(fieldsOf(d.filters)) && /job\.archived/.test(fieldsOf(d.filters)) && d.sort?.[0]?.dir === "asc",
    expect: "status not in Paid / Closed, not archived, sorted ascending",
  },
  {
    ask: "unpaid invoices by customer", types: ["invoices_payments"],
    shape: (d) => /invoice\.balance/.test(fieldsOf(d.filters)) && /Void/.test(fieldsOf(d.filters)) && /(customer|bill_to)\./.test(groupField(d) ?? fieldsOf(d.columns)),
    expect: "balance > 0, not Void / Draft, by customer",
  },
  {
    ask: "calls per tech this month", types: ["service_calls"],
    shape: (d) => /tech\./.test(groupField(d) ?? "") && /this_month/.test(fieldsOf(d.filters)) && /count/.test(fieldsOf(d.aggregates)),
    expect: "group by tech, count, this_month",
  },
  {
    ask: "customers with no dealer", types: ["customers"],
    shape: (d) => (d.filters ?? []).some((f) => f.field === "customer.dealer_sf_id" && f.op === "is_blank"),
    expect: "customer.dealer_sf_id is_blank",
  },
];
const built = [];
for (const c of CANNED) {
  const r = await build(c.ask);
  console.log(`  "${c.ask}"`);
  report("turn", r);
  const d = r.body?.definition;
  check(`"${c.ask}" → a definition`, r.status === 200 && r.body?.outcome === "definition" && !!d, r.body?.outcome === "definition" ? "" : `${r.status} ${r.body?.outcome ?? ""} ${r.body?.question ?? r.text.slice(0, 200)}`);
  if (!d) continue;
  console.log(`      reply: ${r.body.reply}`);
  console.log(`      definition: ${JSON.stringify(d)}`);
  check(`  type is ${c.types.join(" or ")}`, c.types.includes(d.type), d.type);
  check(`  shape: ${c.expect}`, c.shape(d));
  const run = await api(admin.token, "POST", "/reports/run", d);
  check("  it runs (POST /reports/run → 200)", run.status === 200, run.status === 200 ? `${run.body.rows.length} row(s), truncated ${run.body.truncated}` : run.text.slice(0, 200));
  built.push(d);
}

// --- B. ambiguous → one question --------------------------------------------------------------
console.log("\n== B. Ambiguous → one question ==");
{
  const r = await build("show me revenue for last month");
  report("turn", r);
  check("\"show me revenue for last month\" → a question, no definition", r.status === 200 && r.body?.outcome === "question" && !r.body?.definition && /\?/.test(r.body?.question ?? ""), r.body?.question ?? r.text.slice(0, 200));
  if (r.body?.question) console.log(`      question: ${r.body.question}`);
}

// --- C. refine --------------------------------------------------------------------------------
console.log("\n== C. Refine ==");
if (built[0]) {
  const r = await api(admin.token, "POST", "/reports/assist", { mode: "refine", messages: [{ role: "user", content: "make it last quarter" }], currentDefinition: built[0] });
  report("turn", r);
  const d = r.body?.definition;
  check("refine → last_quarter, still grouped by rep", r.status === 200 && /last_quarter/.test(fieldsOf(d?.filters)) && groupField(d) === groupField(built[0]), d ? JSON.stringify(d) : r.text.slice(0, 200));
}

// --- D. explain -------------------------------------------------------------------------------
console.log("\n== D. Explain ==");
{
  const seeded = {
    type: "service_jobs",
    groupBy: ["job.status"],
    aggregates: [{ fn: "count" }, { fn: "sum", field: "invoice.total" }, { fn: "sum", field: "payments.amount_paid" }],
    filters: [{ field: "job.created_date", op: "between", value: "ytd" }],
    sort: [{ field: "count", dir: "desc" }],
  };
  const r = await api(admin.token, "POST", "/reports/assist", { mode: "explain", currentDefinition: seeded });
  report("turn", r);
  const para = r.body?.reply ?? "";
  check("explain → one paragraph", r.status === 200 && r.body?.outcome === "explained" && para.length > 60 && !para.includes("\n\n"), para.slice(0, 300));
  console.log(`      paragraph: ${para}`);
}

// --- E. denied --------------------------------------------------------------------------------
console.log("\n== E. Denied ==");
{
  const r = await api(rep.token, "POST", "/reports/assist", { mode: "build", messages: [{ role: "user", content: "customers with no dealer" }] });
  check("zz-rep-a1 → 403 MODULE_FORBIDDEN", r.status === 403 && r.body?.code === "MODULE_FORBIDDEN", `${r.status} ${r.body?.code ?? ""}`);
}

// --- F. budget --------------------------------------------------------------------------------
console.log("\n== F. Budget (zz-admin's own daily counter) ==");
{
  const supabase = await getSupabaseClient();
  const key = { client_sf_id: null, profile_key: adminProfile, period_kind: "day", period_start: arizonaToday() };
  const { data: rows, error } = await supabase.from("sundial_report_assist_usage").select("*").eq("profile_key", adminProfile).eq("period_kind", "day").eq("period_start", key.period_start);
  if (error) throw new Error(`usage read failed: ${error.message}`);
  const before = rows?.[0];
  check("zz-admin's daily counter exists after the turns above", !!before, before ? `${before.turns} turn(s) today` : "");
  if (before) {
    try {
      const { error: e1 } = await supabase.from("sundial_report_assist_usage").update({ turns: 1_000_000 })
        .eq("client_sf_id", before.client_sf_id).eq("profile_key", adminProfile).eq("period_kind", "day").eq("period_start", before.period_start);
      if (e1) throw new Error(e1.message);
      const r = await build("customers with no dealer");
      check("a filled day → 429 ASSIST_BUDGET_EXHAUSTED (scope user)", r.status === 429 && r.body?.code === "ASSIST_BUDGET_EXHAUSTED" && r.body?.scope === "user", `${r.status} ${r.body?.code ?? ""} ${r.body?.scope ?? ""}`);
      const editor = await api(admin.token, "POST", "/reports/run", built.at(-1) ?? { type: "customers", columns: ["customer.name"], limit: 1 });
      check("…and the editor still runs reports", editor.status === 200, String(editor.status));
    } finally {
      const { error: e2 } = await supabase.from("sundial_report_assist_usage").update({ turns: before.turns })
        .eq("client_sf_id", before.client_sf_id).eq("profile_key", adminProfile).eq("period_kind", "day").eq("period_start", before.period_start);
      check("the counter is restored", !e2, e2?.message ?? `${before.turns} turn(s)`);
    }
  }
}

// --- totals -----------------------------------------------------------------------------------
const calls = turns.flatMap((t) => t.usage?.calls ?? []);
const sum = (k) => calls.reduce((a, c) => a + (c[k] ?? 0), 0);
const lat = turns.map((t) => t.ms).sort((a, b) => a - b);
console.log(`\nTOTALS  ${turns.length} turns, ${calls.length} model calls · input ${sum("inputTokens")} · output ${sum("outputTokens")} · cache-read ${sum("cacheReadTokens")} · cache-write ${sum("cacheWriteTokens")} · latency median ${lat[Math.floor(lat.length / 2)] ?? 0} ms, max ${lat.at(-1) ?? 0} ms`);
check("the cache is read on a later turn (prompt caching works)", sum("cacheReadTokens") > 0);

console.log(failures ? `\n${failures} check(s) FAILED` : "\nALL CHECKS PASSED");
process.exit(failures ? 1 : 0);
