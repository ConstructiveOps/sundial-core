// scripts/diagnose-tech-visibility.mjs — why does a tech not see a call in the app? (2026-09-25)
//
//   node scripts/diagnose-tech-visibility.mjs --tenant harmon --date 2026-09-28 --name Larry
//   node scripts/diagnose-tech-visibility.mjs --tenant harmon --date 2026-09-28 --user a1U...   (a Sundial_User__c id)
//
// Read-only. Reproduces exactly what GET /service/tech/day does for a tech and shows every
// step that can break: the login → Sundial_User__c link (Supabase_User_Id__c), Active__c,
// the tenant, the profile row the RLS reads, and which Sundial user the calls that day were
// actually assigned to. Prints ids, names of USERS, call / job numbers and statuses — never
// a customer's name, phone or address.

import { sfQuery, soqlEscapeString } from "../lib/salesforce.js";
import { getSupabaseClient } from "../lib/supabase.js";

const args = process.argv.slice(2);
const opt = (n, d = null) => {
  const i = args.indexOf(n);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const TENANT = opt("--tenant");
const DATE = opt("--date");
const NAME = opt("--name");
const USER = opt("--user");
const TZ = "America/Phoenix";
if (!TENANT || !DATE || (!NAME && !USER)) {
  console.error("usage: --tenant <slug> --date YYYY-MM-DD (--name <first or last name> | --user <Sundial_User__c id>)");
  process.exit(2);
}
const q = (soql) => sfQuery(soql);
const esc = soqlEscapeString;

// the same day bounds the Lambda uses (a calendar day in Arizona)
function dayBounds(date) {
  const [y, m, d] = date.split("-").map(Number);
  const guess = Date.UTC(y, m - 1, d, 12);
  const f = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const p = Object.fromEntries(f.formatToParts(new Date(guess)).map((x) => [x.type, x.value]));
  const offset = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - guess;
  const from = new Date(Date.UTC(y, m - 1, d) - offset);
  return { from: from.toISOString(), to: new Date(from.getTime() + 86400000).toISOString() };
}
const bounds = dayBounds(DATE);
console.log(`Tenant ${TENANT} · ${DATE} in ${TZ} = ${bounds.from} … ${bounds.to}\n`);

const [tenant] = await q(`SELECT Id, Name FROM Sundial_Tenant__c WHERE Name = '${esc(TENANT)}' LIMIT 1`);
if (!tenant) {
  console.error("no such tenant");
  process.exit(2);
}

// 1. the candidate Sundial users
const USER_FIELDS = "Id, Name, First_Name__c, Last_Name__c, Email__c, Active__c, Access_Level__c, Default_Department__c, Client__c, Client__r.Name, Supabase_User_Id__c, CreatedDate";
const where = USER
  ? `Id = '${esc(USER)}'`
  : `(First_Name__c LIKE '%${esc(NAME)}%' OR Last_Name__c LIKE '%${esc(NAME)}%' OR Email__c LIKE '%${esc(NAME.toLowerCase())}%')`;
const users = await q(`SELECT ${USER_FIELDS} FROM Sundial_User__c WHERE ${where} ORDER BY CreatedDate`);
console.log(`1. Sundial_User__c rows matching "${USER || NAME}": ${users.length}`);
for (const u of users) {
  const flags = [];
  if (u.Client__c !== tenant.Id) flags.push(`WRONG TENANT (${u.Client__r?.Name ?? u.Client__c})`);
  if (u.Active__c !== true) flags.push("INACTIVE — loadTech() refuses it");
  if (!u.Supabase_User_Id__c) flags.push("no Supabase_User_Id__c — no login resolves to this row");
  const tech = u.Access_Level__c === "Technician" || u.Default_Department__c === "Service";
  if (!tech) flags.push("not a tech (Access_Level != Technician and department != Service) — not offered on the board");
  console.log(`   ${u.Id}  ${u.Name}  <${u.Email__c}>  level=${u.Access_Level__c}  dept=${u.Default_Department__c}  active=${u.Active__c}  login=${u.Supabase_User_Id__c ? "linked" : "—"}  created=${u.CreatedDate?.slice(0, 10)}${flags.length ? `\n      ⚠ ${flags.join("; ")}` : ""}`);
}

// 2. the Supabase profile rows (what RLS and /auth/me carry)
let supabase = null;
try {
  supabase = await getSupabaseClient();
} catch (e) {
  console.log(`\n2. Supabase: not reachable from here (${e.message}) — skipped`);
}
if (supabase) {
  const ids = users.map((u) => u.Supabase_User_Id__c).filter(Boolean);
  const emails = users.map((u) => (u.Email__c || "").toLowerCase()).filter(Boolean);
  const { data: profiles, error } = await supabase.from("profiles").select("*").or([ids.length ? `id.in.(${ids.join(",")})` : null, emails.length ? `email.in.(${emails.map((e) => `"${e}"`).join(",")})` : null].filter(Boolean).join(","));
  console.log(`\n2. profiles rows: ${error ? `error ${error.message}` : profiles.length}`);
  for (const p of profiles || []) {
    const keys = Object.keys(p).filter((k) => /id|email|scope|tenant|level|active|updated/i.test(k));
    console.log(`   ${keys.map((k) => `${k}=${p[k]}`).join("  ")}`);
    const linked = users.find((u) => u.Id === p.sundial_user_id);
    if (!linked) console.log(`      ⚠ profile.sundial_user_id ${p.sundial_user_id} is not one of the rows above`);
  }
}

// 3. every call that day for the tenant, whoever it is assigned to
const CALL = "Id, Name, Status__c, Tech__c, Tech__r.Name, Tech__r.Active__c, Client__c, Scheduled_Start__c, Scheduled_End__c, Visit_Type__c, Sundial_Service_Job__c, Sundial_Service_Job__r.Name, Sundial_Service_Job__r.Status__c, CreatedDate, CreatedBy.Name";
const dayCalls = await q(`SELECT ${CALL} FROM Sundial_Service_Call__c WHERE Client__c = '${tenant.Id}' AND Scheduled_Start__c >= ${bounds.from} AND Scheduled_Start__c < ${bounds.to} ORDER BY Scheduled_Start__c`);
console.log(`\n3. calls scheduled ${DATE} (tenant-wide): ${dayCalls.length}`);
for (const c of dayCalls) {
  const mine = users.some((u) => u.Id === c.Tech__c);
  console.log(`   ${c.Name}  job ${c.Sundial_Service_Job__r?.Name} (${c.Sundial_Service_Job__r?.Status__c})  ${c.Status__c}  start ${c.Scheduled_Start__c}  tech=${c.Tech__c ?? "—"} ${c.Tech__r?.Name ?? ""}${c.Tech__r && c.Tech__r.Active__c === false ? " (INACTIVE)" : ""}  created ${c.CreatedDate?.slice(0, 16)} by ${c.CreatedBy?.Name}${mine ? "   ← one of the users above" : ""}`);
}
const strays = await q(`SELECT ${CALL} FROM Sundial_Service_Call__c WHERE Client__c != '${tenant.Id}' AND Scheduled_Start__c >= ${bounds.from} AND Scheduled_Start__c < ${bounds.to}`);
if (strays.length) {
  console.log(`   ⚠ ${strays.length} call(s) that day carry ANOTHER tenant (or none) in Client__c — invisible to every ${TENANT} login:`);
  for (const c of strays) console.log(`     ${c.Name}  Client__c=${c.Client__c ?? "null"}  tech=${c.Tech__c ?? "—"} ${c.Tech__r?.Name ?? ""}`);
}

// 4. the exact day query, per candidate user
console.log(`\n4. what GET /service/tech/day?date=${DATE} returns for each user above:`);
for (const u of users) {
  const me = `Tech__c = '${u.Id}'`;
  const [day, active, unscheduled] = await Promise.all([
    q(`SELECT Id, Name, Status__c FROM Sundial_Service_Call__c WHERE Client__c = '${tenant.Id}' AND ${me} AND Scheduled_Start__c >= ${bounds.from} AND Scheduled_Start__c < ${bounds.to}`),
    q(`SELECT Id, Name, Status__c FROM Sundial_Service_Call__c WHERE Client__c = '${tenant.Id}' AND ${me} AND Status__c IN ('En Route', 'In Progress')`),
    q(`SELECT Id, Name, Status__c FROM Sundial_Service_Call__c WHERE Client__c = '${tenant.Id}' AND ${me} AND Status__c = 'Unscheduled'`),
  ]);
  const anyTime = await q(`SELECT Id, Scheduled_Start__c, Client__c FROM Sundial_Service_Call__c WHERE ${me} ORDER BY Scheduled_Start__c DESC NULLS LAST LIMIT 200`);
  const otherTenant = anyTime.filter((c) => c.Client__c !== tenant.Id).length;
  console.log(`   ${u.Name} (${u.Id}): day ${day.length} [${day.map((c) => `${c.Name} ${c.Status__c}`).join(", ")}]  active ${active.length}  unscheduled ${unscheduled.length}  — calls assigned to this user ever: ${anyTime.length}${anyTime.length ? ` (latest start ${anyTime[0].Scheduled_Start__c ?? "unscheduled"})` : ""}${otherTenant ? `  ⚠ ${otherTenant} of them under another tenant` : ""}`);
}
