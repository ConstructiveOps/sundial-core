// scripts/verify-report-schedule.mjs — proves scheduled report delivery (D-091, Reporting R3)
// end to end against the DEPLOYED API, Lambda and database, as the ZZ TEST users.
//
//   node scripts/verify-report-schedule.mjs
//
// What it checks:
//   A. PICKER     GET /reports/recipients: zz-admin is listed, a sales rep is not; zz-admin may
//                 add outside addresses, zz-manager may not.
//   B. SCHEDULE   zz-admin saves "ZZ VERIFY R3 …" (customers named "ZZ PORTAL TEST…" only — no
//                 live customer reaches an inbox) and PUTs a daily 07:00 schedule to itself:
//                 200, next_run_at is a future 14:00 UTC (07:00 Arizona).
//   C. SEND-NOW   zz-admin POST /send-now { toMe: true } → 202; the export is polled until its
//                 delivery is "sent"; the SES message id is read from the export row (the SES
//                 SEND RESULT — no inbox is read); nothing is recorded on the report.
//   D. OUTSIDE    zz-manager cannot add an outside address (403 EXTERNAL_RECIPIENT_FORBIDDEN);
//                 zz-admin can (200, on a schedule saved DISABLED — never sent, so no bounce).
//   E. TICK       the service role makes the schedule due (next_run_at one minute ago); the
//                 Lambda is invoked with { task: "tick" } TWICE AT ONCE: exactly one new export
//                 for the report, next_run_at moves into the future, the delivery is "sent"
//                 with an SES message id, the report reads last_run_status ok.
//   F. PERIODS    a grouped run with groupBy { field: solar.created_date, dateTrunc: month }:
//                 every key is a month's first day (or blank) and the groups add up to the total.
//   G. PUBLIC     GET /public/reports/download/<unknown token> answers 404 with no login.
//   CLEANUP       the ZZ VERIFY R3 reports (their schedules go with them), this run's export
//                 rows and their CSV files in S3.
//
// Passwords come from Secrets Manager `sundial/test-users` (CLAUDE.md: never a live user).

import { loadTestPasswords, loginAsTestUser } from "./portal-login.mjs";
import { getSupabaseClient } from "../lib/supabase.js";
import { S3Client, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { REPORTS_BUCKET, REPORTS_REGION } from "../lib/report-csv.js";

const API = (process.env.API_BASE_URL || "https://5sktfwldh1.execute-api.us-west-1.amazonaws.com/prod").replace(/\/+$/, "");
const FN = "sundial-reports";
const PREFIX = "ZZ VERIFY R3";
const DEF = {
  type: "customers",
  columns: ["customer.name", "customer.city"],
  filters: [{ field: "customer.name", op: "starts_with", value: "ZZ PORTAL TEST" }],
  limit: 25,
};

let failures = 0;
function check(label, cond, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
  if (!cond) failures++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(token, method, path, body) {
  const resp = await fetch(`${API}${path}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json", Origin: "http://localhost:5173" },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual",
  });
  const text = await resp.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: resp.status, body: json, text };
}

const supabase = await getSupabaseClient();
const lambda = new LambdaClient({ region: "us-west-1" });
const exportIds = new Set();

/** Poll an export row (service role) until its delivery is recorded. */
async function waitForDelivery(exportId, label) {
  for (let i = 0; i < 60; i++) {
    const { data } = await supabase.from("sundial_report_exports").select("id, status, error_code, delivery").eq("id", exportId).maybeSingle();
    if (data?.delivery) return data;
    if (data?.status === "failed" && i > 5) return data;
    await sleep(2000);
  }
  console.log(`  (${label}: no delivery after 120 s)`);
  return null;
}

async function tick() {
  const out = await lambda.send(new InvokeCommand({ FunctionName: FN, InvocationType: "RequestResponse", Payload: Buffer.from(JSON.stringify({ task: "tick" })) }));
  const body = out.Payload ? JSON.parse(Buffer.from(out.Payload).toString("utf8")) : null;
  return { functionError: out.FunctionError ?? null, body };
}

// Leftovers from a run that died half-way.
await supabase.from("sundial_reports").delete().like("name", `${PREFIX}%`);

const passwords = await loadTestPasswords();
const tokens = {};
for (const slug of ["admin", "manager", "rep-a1"]) {
  const { token, status } = await loginAsTestUser(slug, passwords);
  if (!token) throw new Error(`zz-${slug}: sign-in failed (${status}) — re-seed the fixtures.`);
  tokens[slug] = token;
}
const ADMIN_EMAIL = "tim+zz-admin@constructiveoperations.com";
const REP_EMAIL = "tim+zz-rep-a1@constructiveoperations.com";
const created = [];

try {
  // --- A. picker ------------------------------------------------------------------------------
  console.log("\n== A. Recipient picker ==");
  const pick = await api(tokens.admin, "GET", "/reports/recipients");
  check("GET /reports/recipients (zz-admin) 200", pick.status === 200, `${pick.status}`);
  const me = (pick.body?.users ?? []).find((u) => u.email === ADMIN_EMAIL);
  check("zz-admin is a pickable recipient", !!me);
  check("a sales rep is not", !(pick.body?.users ?? []).some((u) => u.email === REP_EMAIL));
  check("zz-admin may add outside addresses", pick.body?.canAddExternal === true);
  const pickM = await api(tokens.manager, "GET", "/reports/recipients");
  check("zz-manager may not", pickM.body?.canAddExternal === false);
  check("zz-rep-a1 cannot reach the picker (403)", (await api(tokens["rep-a1"], "GET", "/reports/recipients")).status === 403);
  if (!me) throw new Error("zz-admin is not in the picker — check its Sundial_User__c (active, Admin, email) and the user cache.");

  // --- B. schedule ----------------------------------------------------------------------------
  console.log("\n== B. Schedule ==");
  const saved = await api(tokens.admin, "POST", "/reports", { name: `${PREFIX} daily`, definition: DEF });
  check("zz-admin saves the report (201)", saved.status === 201, `${saved.status}`);
  const reportId = saved.body?.id;
  created.push(["admin", reportId]);
  const put = await api(tokens.admin, "PUT", `/reports/${reportId}/schedule`, { cadence: "daily", time: "07:00", recipients: [{ userId: me.userId }] });
  check("PUT schedule (200)", put.status === 200, `${put.status} ${put.body?.code ?? ""}`);
  const next = Date.parse(put.body?.schedule?.nextRunAt ?? "");
  check("next run is in the future at 14:00 UTC (07:00 Arizona)", next > Date.now() && new Date(next).getUTCHours() === 14 && new Date(next).getUTCMinutes() === 0, put.body?.schedule?.nextRunAt);
  check("summary reads in words", put.body?.schedule?.summary === "Daily at 7:00 AM (Arizona time)", put.body?.schedule?.summary);

  // --- C. send-now toMe -------------------------------------------------------------------------
  console.log("\n== C. Send now, to me ==");
  const sn = await api(tokens.admin, "POST", `/reports/${reportId}/send-now`, { toMe: true });
  check("send-now { toMe } → 202", sn.status === 202, `${sn.status} ${sn.body?.code ?? ""}`);
  if (sn.body?.exportId) {
    exportIds.add(sn.body.exportId);
    const ex = await waitForDelivery(sn.body.exportId, "send-now");
    const r = ex?.delivery?.results?.[0];
    check("the delivery is sent", ex?.delivery?.status === "sent", `${ex?.status} / ${ex?.delivery?.status} ${ex?.delivery?.code ?? ex?.error_code ?? ""}`);
    check("SES accepted it (a message id)", typeof r?.messageId === "string" && r.messageId.length > 10, r?.messageId ? `messageId ${r.messageId}` : "none");
    check("the CSV was attached (small file)", ex?.delivery?.attached === true);
    const st = await api(tokens.admin, "GET", `/reports/csv/${sn.body.exportId}`);
    check("GET /reports/csv/{id} shows the delivery (counts only)", st.body?.delivery?.status === "sent" && st.body?.delivery?.sent === 1);
    const rep = (await supabase.from("sundial_reports").select("last_run_status, last_run_at").eq("id", reportId).single()).data;
    check("toMe records nothing on the report", rep?.last_run_status === null && rep?.last_run_at === null);
  }

  // --- D. outside addresses -------------------------------------------------------------------
  console.log("\n== D. Outside addresses ==");
  const mSaved = await api(tokens.manager, "POST", "/reports", { name: `${PREFIX} manager`, definition: DEF });
  created.push(["manager", mSaved.body?.id]);
  const mPut = await api(tokens.manager, "PUT", `/reports/${mSaved.body?.id}/schedule`, { cadence: "daily", time: "07:00", recipients: [{ email: "verify-outside@example.com" }] });
  check("zz-manager adding an outside address → 403 EXTERNAL_RECIPIENT_FORBIDDEN", mPut.status === 403 && mPut.body?.code === "EXTERNAL_RECIPIENT_FORBIDDEN", `${mPut.status} ${mPut.body?.code}`);
  const repAsRecipient = await api(tokens.manager, "PUT", `/reports/${mSaved.body?.id}/schedule`, { cadence: "daily", time: "07:00", recipients: [{ email: REP_EMAIL }] });
  check("a sales rep's address is outside too (403 for zz-manager)", repAsRecipient.status === 403, `${repAsRecipient.status}`);
  const aSaved = await api(tokens.admin, "POST", `/reports`, { name: `${PREFIX} outside (disabled)`, definition: DEF });
  created.push(["admin", aSaved.body?.id]);
  const aPut = await api(tokens.admin, "PUT", `/reports/${aSaved.body?.id}/schedule`, { cadence: "weekly", days: ["mon"], time: "06:00", enabled: false, recipients: [{ email: "verify-outside@example.com" }] });
  check("zz-admin may add one (200, saved disabled — never sent)", aPut.status === 200 && aPut.body?.schedule?.enabled === false, `${aPut.status}`);

  // --- E. the tick ------------------------------------------------------------------------------
  console.log("\n== E. The tick ==");
  const before = new Set(((await supabase.from("sundial_report_exports").select("id").eq("report_id", reportId)).data ?? []).map((r) => r.id));
  const due = new Date(Date.now() - 60_000).toISOString();
  await supabase.from("sundial_reports").update({ next_run_at: due }).eq("id", reportId);
  const [t1, t2] = await Promise.all([tick(), tick()]);
  check("both ticks ran without error", !t1.functionError && !t2.functionError, `${t1.functionError ?? ""} ${t2.functionError ?? ""}`);
  console.log(`  tick 1: ${JSON.stringify(t1.body)}\n  tick 2: ${JSON.stringify(t2.body)}`);
  const after = ((await supabase.from("sundial_report_exports").select("id, job").eq("report_id", reportId)).data ?? []).filter((r) => !before.has(r.id));
  after.forEach((r) => exportIds.add(r.id));
  check("exactly ONE delivery queued for the report", after.length === 1, `${after.length}`);
  check("it is a scheduled delivery", after[0]?.job?.delivery?.kind === "schedule");
  const row = (await supabase.from("sundial_reports").select("next_run_at, last_run_status, last_export_id").eq("id", reportId).single()).data;
  check("next_run_at moved into the future", Date.parse(row?.next_run_at) > Date.now(), row?.next_run_at);
  if (after[0]) {
    const ex = await waitForDelivery(after[0].id, "tick");
    const r = ex?.delivery?.results?.[0];
    check("the scheduled delivery is sent", ex?.delivery?.status === "sent", `${ex?.delivery?.status} ${ex?.delivery?.code ?? ex?.error_code ?? ""}`);
    check("SES accepted it (a message id)", typeof r?.messageId === "string" && r.messageId.length > 10, r?.messageId ? `messageId ${r.messageId}` : "none");
    // The worker records the delivery on the export FIRST, then the outcome on the report — so
    // wait for the report to leave "running" rather than read it the instant the email is out.
    let done = null;
    for (let i = 0; i < 15; i++) {
      done = (await supabase.from("sundial_reports").select("last_run_status, consecutive_failures").eq("id", reportId).single()).data;
      if (done?.last_run_status !== "running") break;
      await sleep(2000);
    }
    check("the report reads last_run_status ok", done?.last_run_status === "ok" && done?.consecutive_failures === 0, `${done?.last_run_status}`);
  }
  const list = await api(tokens.admin, "GET", "/reports");
  const inList = (list.body?.reports ?? []).find((x) => x.id === reportId);
  check("GET /reports shows the schedule's summary and last run", inList?.schedule?.lastRunStatus === "ok" && !inList?.schedule?.recipients, inList?.schedule?.summary);

  // --- F. periods -------------------------------------------------------------------------------
  console.log("\n== F. Group by period ==");
  const g = await api(tokens.admin, "POST", "/reports/run", { type: "solar", groupBy: [{ field: "solar.created_date", dateTrunc: "month" }], aggregates: [{ fn: "count" }] });
  check("grouped by month (200)", g.status === 200, `${g.status} ${g.body?.code ?? ""}`);
  const keys = (g.body?.rows ?? []).map((r) => r[0]);
  check("every key is a month's first day (or blank)", keys.length > 0 && keys.every((k) => k === null || /^\d{4}-\d{2}-01$/.test(k)), `${keys.length} months`);
  const sum = (g.body?.rows ?? []).reduce((s, r) => s + Number(r[1] ?? 0), 0);
  const total = g.body?.aggregates?.find((a) => a.field === "count")?.value;
  check("the months add up to the total", Number(total) === sum, `${sum} vs ${total}`);
  check("the column is a date labelled by its period", g.body?.columns?.[0]?.type === "date" && /\(month\)$/.test(g.body?.columns?.[0]?.label ?? ""));

  // --- G. public route ----------------------------------------------------------------------------
  console.log("\n== G. Public download route ==");
  const pub = await api(null, "GET", `/public/reports/download/${"A".repeat(43)}`);
  check("an unknown link → 404, no login needed", pub.status === 404, `${pub.status}`);
} finally {
  // --- cleanup --------------------------------------------------------------------------------
  console.log("\n== Cleanup ==");
  for (const [slug, id] of created) {
    if (!id) continue;
    const r = await api(tokens[slug], "DELETE", `/reports/${id}`);
    check(`zz-${slug} deletes its report (204)`, r.status === 204, `${r.status}`);
  }
  const { data: left } = await supabase.from("sundial_reports").delete().like("name", `${PREFIX}%`).select("id");
  check("no ZZ VERIFY R3 report left behind", (left ?? []).length === 0, `${(left ?? []).length} removed by the service role`);
  const ids = [...exportIds];
  if (ids.length) {
    for (let i = 0; i < 60; i++) {
      const { data } = await supabase.from("sundial_report_exports").select("id").in("id", ids).in("status", ["queued", "running"]);
      if (!(data ?? []).length) break;
      await sleep(2000);
    }
    const { data: rows } = await supabase.from("sundial_report_exports").select("id, s3_key").in("id", ids);
    const s3 = new S3Client({ region: REPORTS_REGION });
    let files = 0;
    for (const r of rows ?? []) {
      if (!r.s3_key || !r.s3_key.startsWith("REPORTS/")) continue;
      await s3.send(new DeleteObjectCommand({ Bucket: REPORTS_BUCKET, Key: r.s3_key }));
      files++;
    }
    await supabase.from("sundial_report_downloads").delete().in("export_id", ids);
    const { error } = await supabase.from("sundial_report_exports").delete().in("id", ids);
    check(`this run's ${ids.length} export(s) removed (${files} file(s) + rows)`, !error, error?.message);
  }
}

console.log(failures ? `\n${failures} check(s) FAILED.` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
