// Phase 2 — the shadow LOG summary. D-064, docs/access-model.md §7 step 1, §8 Phase 2.
//
//   node scripts/access-shadow-summary.mjs                  # last 24 hours
//   node scripts/access-shadow-summary.mjs --hours 72       # the §8 gate window
//   node scripts/access-shadow-summary.mjs --since 2026-08-28T00:00:00Z
//   node scripts/access-shadow-summary.mjs --json
//   node scripts/access-shadow-summary.mjs --no-sf          # skip name enrichment
//
// READ-ONLY. Reads CloudWatch Logs and (for names) Salesforce. Writes nothing, deploys
// nothing, and does not touch the Lambda.
//
// ---------------------------------------------------------------------------
// WHAT THIS IS FOR, AND HOW IT DIFFERS FROM access-shadow-report.mjs
// ---------------------------------------------------------------------------
// The REPORT is offline and hypothetical: for every portal user it computes both id sets
// from scratch and diffs them. It answers "what WOULD change", for everyone, whether or
// not they have ever opened the portal.
//
// This SUMMARY is the other half: it reads what actually happened. Real users, real read
// paths, real query strings, over a real window. It answers "what DID the new model
// decide on live traffic", which is the only thing that can tell you a path is exercised
// at all — a rule that is right for a page nobody loads has not been tested by anybody.
//
// You need both. The report can prove Dennis's sets match and still miss that ?parentId=
// on a related list takes a code path the report never models. The summary sees the path
// and cannot see the id sets. Neither is redundant.
//
// ---------------------------------------------------------------------------
// THE ONE FINDING THAT STOPS EVERYTHING
// ---------------------------------------------------------------------------
// §7's rule is that access may only TIGHTEN. Every narrowing in this output is expected
// and is a decision for Tim (who loses what, and whose Access_Level__c needs setting
// before Phase 3). A WIDENING on a served path is different: it means the new model would
// show somebody a record the old one hid.
//
// Two widenings are known-good, both caused by the TEMP guard narrowing WRONGLY:
//   - a Sales Rep who is not Dennis gaining their OWN records (the guard filters on a
//     hardcoded name, so it serves them Dennis's book and hides theirs);
//   - a MIS-STAMPED user (Hierarchy_Level__c "Sales Rep", real level something else)
//     getting their real role's view back.
// Anything else is a leak in the new model and Phase 3 does not proceed.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

const REGION = "us-west-1";
const LOG_GROUP = argValue("--log-group") ?? "/aws/lambda/sundial-sf-query";
const JSON_OUT = process.argv.includes("--json");
const NO_SF = process.argv.includes("--no-sf");
const MAX_RESULTS = 10000; // CloudWatch Insights hard cap per query

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i === -1 ? null : process.argv[i + 1];
}

const now = Date.now();
const since = argValue("--since")
  ? Date.parse(argValue("--since"))
  : now - Number(argValue("--hours") ?? 24) * 3600 * 1000;
const until = argValue("--until") ? Date.parse(argValue("--until")) : now;

const log = (...a) => {
  if (!JSON_OUT) console.log(...a);
};
const rule = (c = "=") => log(c.repeat(100));
const fmt = (n) => (typeof n === "number" ? n.toLocaleString() : String(n ?? "-"));

// ---------------------------------------------------------------------------
// Fetch — CloudWatch Logs Insights via the AWS CLI
// ---------------------------------------------------------------------------
// The CLI rather than an SDK client on purpose: @aws-sdk/client-cloudwatch-logs is not a
// dependency of this repo and adding one to every Lambda bundle for an offline reporting
// script would be a poor trade. The CLI is already the deployment tool (deploy.ps1) and
// is authenticated the same way.
//
// ⚠️ THE LINE IS NOT PURE JSON IN THE LOG EVENT. The Node runtime prefixes console.log
// with a timestamp, a request id and a level, so `@message` is
// "2026-08-28T... <uuid> INFO {"shadow":true,...}". Insights cannot parse that as JSON,
// which is why this filters on a substring and parses from the first brace here instead
// of using `filter shadow = 1`. Changing the function's log format to JSON would fix that
// and would also change the shape of every other log line in the function, so it is not
// something to do quietly during a measurement window.

async function aws(args) {
  const { stdout } = await exec("aws", [...args, "--region", REGION, "--output", "json"], {
    maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}

async function fetchLines() {
  const start = await aws([
    "logs",
    "start-query",
    "--log-group-name",
    LOG_GROUP,
    "--start-time",
    String(Math.floor(since / 1000)),
    "--end-time",
    String(Math.floor(until / 1000)),
    "--query-string",
    `fields @timestamp, @message | filter @message like /"shadow":true/ | sort @timestamp asc | limit ${MAX_RESULTS}`,
  ]);

  for (let attempt = 0; attempt < 120; attempt++) {
    const res = await aws(["logs", "get-query-results", "--query-id", start.queryId]);
    if (res.status === "Complete") return res;
    if (res.status === "Failed" || res.status === "Cancelled" || res.status === "Timeout") {
      throw new Error(`CloudWatch query ${res.status}`);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("CloudWatch query did not complete within 120s");
}

/** Pull the JSON object out of a runtime-prefixed log message. */
function parseLine(message) {
  const i = message.indexOf("{");
  if (i === -1) return null;
  try {
    const obj = JSON.parse(message.slice(i));
    return obj && obj.shadow === true ? obj : null;
  } catch {
    return null;
  }
}

const raw = await fetchLines();
const rows = [];
for (const result of raw.results ?? []) {
  const msg = result.find((f) => f.field === "@message")?.value ?? "";
  const parsed = parseLine(msg);
  if (parsed) rows.push(parsed);
}

const truncated = (raw.results ?? []).length >= MAX_RESULTS;

// ---------------------------------------------------------------------------
// Enrich — user ids are the join key; names make the output readable
// ---------------------------------------------------------------------------
// Best-effort by design: a Salesforce hiccup must degrade this to ids rather than fail
// the summary. The ZZ test users are identified HERE rather than by a hardcoded id list,
// so a re-seeded fixture does not silently become an "unexplained" widening.
const userInfo = new Map();
if (!NO_SF && rows.length > 0) {
  try {
    const { sfQuery } = await import("../lib/salesforce.js");
    const ids = [...new Set(rows.map((r) => r.user).filter(Boolean))];
    for (let i = 0; i < ids.length; i += 200) {
      const chunk = ids.slice(i, i + 200).map((id) => `'${id}'`).join(",");
      const recs = await sfQuery(
        `SELECT Id, First_Name__c, Last_Name__c, Email__c, Access_Level__c, ` +
          `Hierarchy_Level__c, Dealer__r.Name FROM Sundial_User__c WHERE Id IN (${chunk})`
      );
      for (const r of recs) {
        const name =
          [r.First_Name__c, r.Last_Name__c].filter(Boolean).join(" ").trim() ||
          r.Email__c ||
          r.Id;
        userInfo.set(r.Id, {
          name,
          email: r.Email__c ?? null,
          level: r.Access_Level__c ?? null,
          hierarchy: r.Hierarchy_Level__c ?? null,
          dealer: r.Dealer__r?.Name ?? null,
          isTestUser: /^tim\+zz-/i.test(r.Email__c ?? ""),
        });
      }
    }
  } catch (e) {
    log(`  (name enrichment skipped: ${e?.message || e})`);
  }
}
const nameOf = (id) => userInfo.get(id)?.name ?? id ?? "(unknown)";

// ---------------------------------------------------------------------------
// Aggregate
// ---------------------------------------------------------------------------
// Per user × object × path, which is the grain §8 asks for. The count DISTRIBUTION is
// kept as min/median/max of both sides rather than a mean: one request that returns a
// wildly different total is the interesting one, and a mean hides it behind the hundreds
// of identical page loads around it.
const groups = new Map();
const key = (r) => [r.user, r.object, r.path].join("|");

for (const r of rows) {
  const k = key(r);
  if (!groups.has(k)) {
    groups.set(k, {
      user: r.user,
      object: r.object,
      path: r.path,
      scope: r.scope,
      level: r.level,
      dealer: r.dealer ?? null,
      dealerActive: r.dealerActive ?? null,
      temp: false,
      requests: 0,
      disagreements: 0,
      narrower: 0,
      wider: 0,
      unknown: 0,
      errors: 0,
      mixedSource: 0,
      oldCounts: [],
      newCounts: [],
      ms: [],
      verdicts: new Map(),
      newDeny: new Set(),
      fieldFilterDeferred: 0,
    });
  }
  const g = groups.get(k);
  g.requests++;
  g.temp = g.temp || r.temp === true;
  if (r.countSourcesDiffer) g.mixedSource++;
  if (r.error) g.errors++;
  if (r.newDeny) g.newDeny.add(r.newDeny);
  if (r.fieldFilter === "deferred_phase4") g.fieldFilterDeferred++;
  if (typeof r.shadowMs === "number") g.ms.push(r.shadowMs);
  const v = r.verdict ?? "unknown";
  g.verdicts.set(v, (g.verdicts.get(v) ?? 0) + 1);
  if (v === "narrower") g.narrower++;
  else if (v === "wider") g.wider++;
  else if (v === "unknown") g.unknown++;
  if (v === "narrower" || v === "wider") g.disagreements++;
  const oldN = typeof r.oldTotal === "number" ? r.oldTotal : null;
  const newN = typeof r.newTotal === "number" ? r.newTotal : null;
  if (oldN !== null) g.oldCounts.push(oldN);
  if (newN !== null) g.newCounts.push(newN);
}

function stats(arr) {
  if (arr.length === 0) return null;
  const s = [...arr].sort((a, b) => a - b);
  return { min: s[0], med: s[Math.floor(s.length / 2)], max: s[s.length - 1] };
}
function pct(arr, p) {
  if (arr.length === 0) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}

const all = [...groups.values()];
const allMs = rows.map((r) => r.shadowMs).filter((n) => typeof n === "number");

/**
 * Classify a widening. Mirrors access-shadow-report.mjs's classify() deliberately: the
 * two known-good causes are the TEMP guard narrowing WRONGLY, and undoing a wrong
 * narrowing shows up here as a gain.
 */
function classifyWidening(g) {
  if (g.temp && g.scope === "own") {
    return {
      ok: true,
      why: "EXPECTED — a rep gaining their OWN records, which the name-matched TEMP guard never gave them",
    };
  }
  if (g.temp && (g.scope === "tenant" || g.scope === "dealer")) {
    return {
      ok: true,
      why: "EXPECTED — mis-stamped by the old user-admin default; the TEMP guard is serving them Dennis's book (A6 repairs this)",
    };
  }
  if (g.mixedSource === g.requests && !g.temp) {
    return {
      ok: false,
      why: "MIXED SOURCE — old total is a live SOQL COUNT, new is a cache count. A small delta is cache lag; confirm against access-shadow-report.mjs before treating it as real",
    };
  }
  return {
    ok: false,
    why: "** UNEXPLAINED — the new model would show a record the old one hid, to somebody the old one was treating correctly. STOP. **",
  };
}

const widened = all.filter((g) => g.wider > 0);
const unexplained = widened.filter((g) => !classifyWidening(g).ok);

if (JSON_OUT) {
  console.log(
    JSON.stringify(
      {
        window: { since: new Date(since).toISOString(), until: new Date(until).toISOString() },
        logGroup: LOG_GROUP,
        lines: rows.length,
        truncated,
        groups: all.map((g) => ({
          ...g,
          name: nameOf(g.user),
          verdicts: Object.fromEntries(g.verdicts),
          newDeny: [...g.newDeny],
          oldCounts: stats(g.oldCounts),
          newCounts: stats(g.newCounts),
          ms: stats(g.ms),
        })),
        unexplainedWidenings: unexplained.length,
      },
      null,
      2
    )
  );
  process.exit(unexplained.length === 0 ? 0 : 1);
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
rule();
log("ACCESS SHADOW SUMMARY — what the new model decided on REAL traffic");
rule();
log(`  log group ${LOG_GROUP}`);
log(`  window    ${new Date(since).toISOString()}  ->  ${new Date(until).toISOString()}`);
log(`  lines     ${fmt(rows.length)} shadow line(s), ${fmt(all.length)} user x object x path group(s)`);
if (truncated) {
  log(
    `  ** TRUNCATED at the ${fmt(MAX_RESULTS)}-result Insights cap. Narrow the window and\n` +
      "     re-run, or this summary is a sample rather than the window. **"
  );
}
if (rows.length === 0) {
  log(
    "\n  No shadow lines in this window. Either ACCESS_MODEL_MODE is not `shadow` on the\n" +
      "  function, or nobody called it. Check with:\n" +
      "    aws lambda get-function-configuration --function-name sundial-sf-query \\\n" +
      "      --region us-west-1 --query 'Environment.Variables'"
  );
  process.exit(0);
}
log(
  `  added latency  p50 ${fmt(pct(allMs, 50))} ms   p95 ${fmt(pct(allMs, 95))} ms   max ${fmt(pct(allMs, 100))} ms`
);

// --- the gate ---------------------------------------------------------------
rule("-");
log("THE GATE — widenings. §7: access may only TIGHTEN.");
rule("-");
if (widened.length === 0) {
  log("  none. Not one request would have shown anybody a record they cannot see today.");
} else {
  for (const g of widened) {
    const c = classifyWidening(g);
    const o = stats(g.oldCounts);
    const n = stats(g.newCounts);
    log(`  ${nameOf(g.user)} — ${g.object} ${g.path} (scope ${g.scope}, temp guard ${g.temp})`);
    log(
      `     ${fmt(g.wider)} of ${fmt(g.requests)} request(s) wider   ` +
        `old ${o ? `${fmt(o.min)}..${fmt(o.max)}` : "-"}   new ${n ? `${fmt(n.min)}..${fmt(n.max)}` : "-"}`
    );
    log(`     ${c.why}`);
  }
  log(
    unexplained.length === 0
      ? `\n  All ${widened.length} are explained by the TEMP guard's known wrong-narrowing. None is a leak.`
      : `\n  ** ${unexplained.length} UNEXPLAINED widening(s). Phase 3 does not proceed until each is understood. **`
  );
}

// --- per user x object x path ----------------------------------------------
rule("-");
log("EVERY USER x OBJECT x PATH");
rule("-");
log(
  `  ${"user".padEnd(24)} ${"object".padEnd(9)} ${"path".padEnd(26)} ${"scope".padEnd(7)} ` +
    `${"reqs".padStart(6)} ${"disagree".padStart(8)} ${"old (min..max)".padStart(18)} ${"new (min..max)".padStart(18)}`
);
for (const g of all.sort(
  (a, b) =>
    nameOf(a.user).localeCompare(nameOf(b.user)) ||
    String(a.object).localeCompare(String(b.object)) ||
    a.path.localeCompare(b.path)
)) {
  const o = stats(g.oldCounts);
  const n = stats(g.newCounts);
  const span = (s) => (s ? `${fmt(s.min)}..${fmt(s.max)}` : "-");
  const flag = g.wider > 0 ? " <-- WIDER" : g.errors > 0 ? " <-- errors" : "";
  log(
    `  ${nameOf(g.user).slice(0, 23).padEnd(24)} ${String(g.object ?? "-").padEnd(9)} ${g.path.padEnd(26)} ` +
      `${String(g.scope).padEnd(7)} ${fmt(g.requests).padStart(6)} ${fmt(g.disagreements).padStart(8)} ` +
      `${span(o).padStart(18)} ${span(n).padStart(18)}${flag}`
  );
}

// --- narrowings, by user ----------------------------------------------------
// The decision Phase 3 forces: who loses what, so levels can be set BEFORE the flip
// rather than discovered after it.
rule("-");
log("NARROWINGS BY USER — who sees less, and by how much");
rule("-");
const byUser = new Map();
for (const g of all) {
  if (!byUser.has(g.user)) {
    byUser.set(g.user, { user: g.user, scope: g.scope, level: g.level, requests: 0, narrower: 0, denied: new Set(), worst: null, why: null });
  }
  const u = byUser.get(g.user);
  u.requests += g.requests;
  u.narrower += g.narrower;
  for (const d of g.newDeny) u.denied.add(`${g.object}:${d}`);
  // WHY this user resolves to none. The three causes need three different fixes -- set
  // a level, attribute the rep, or switch the dealer back on -- and they are
  // indistinguishable from the scope alone, which is what made the first run's single
  // "(unknown)" row useless for the re-levelling the §8 gate asks for.
  if (g.scope === "none" && !u.why) {
    u.why =
      g.level == null
        ? "no Access_Level__c set"
        : g.level === "Technician"
          ? "Technician (Phase II defines it)"
          : g.dealer == null
            ? `${g.level} with NO dealer (unattributed)`
            : g.dealerActive === false
              ? `${g.level} whose dealer is INACTIVE`
              : `level "${g.level}" is not in the scope table`;
  }
  const o = stats(g.oldCounts);
  const n = stats(g.newCounts);
  if (o && n && o.max - n.max > (u.worst?.delta ?? -1)) {
    u.worst = { object: g.object, delta: o.max - n.max, from: o.max, to: n.max };
  }
}
const narrowing = [...byUser.values()].filter((u) => u.narrower > 0);
if (narrowing.length === 0) {
  log("  none — every request agreed.");
} else {
  log(`  ${"user".padEnd(24)} ${"level".padEnd(14)} ${"scope".padEnd(7)} ${"narrower".padStart(9)} ${"biggest drop".padStart(26)}`);
  for (const u of narrowing.sort((a, b) => b.narrower - a.narrower)) {
    const w = u.worst ? `${u.worst.object} ${fmt(u.worst.from)} -> ${fmt(u.worst.to)}` : "-";
    log(
      `  ${nameOf(u.user).slice(0, 23).padEnd(24)} ${String(u.level ?? "(blank)").padEnd(14)} ` +
        `${String(u.scope).padEnd(7)} ${fmt(u.narrower).padStart(9)} ${w.padStart(26)}`
    );
    if (u.why) log(`       resolves to none: ${u.why}`);
    if (u.denied.size > 0) log(`       modules that would close: ${[...u.denied].join(", ")}`);
  }
}

// --- path coverage ----------------------------------------------------------
// A path with zero traffic in the window has not been validated by anybody, however
// green the rest of this looks. The §8 gate is three business days of REAL use, and this
// table is how you tell real use from a quiet weekend.
rule("-");
log("PATH COVERAGE — a path nobody exercised has not been tested");
rule("-");
const EXPECTED_PATHS = [
  "list.cache", "list.live.cold", "list.live.rep", "list.live.parent_uncached",
  "search.cache", "search.live.rep", "search.live.parent_uncached",
  "single.cache", "single.soql", "single.full",
  "users.route", "meta.picklist", "meta.picklists",
];
const seenPaths = new Map();
for (const r of rows) seenPaths.set(r.path, (seenPaths.get(r.path) ?? 0) + 1);
for (const p of EXPECTED_PATHS) {
  const n = seenPaths.get(p) ?? 0;
  log(`  ${p.padEnd(28)} ${fmt(n).padStart(8)}${n === 0 ? "   <-- NO TRAFFIC" : ""}`);
}
for (const [p, n] of seenPaths) {
  if (!EXPECTED_PATHS.includes(p)) log(`  ${p.padEnd(28)} ${fmt(n).padStart(8)}   <-- UNEXPECTED PATH`);
}

// --- shadow's own health ----------------------------------------------------
rule("-");
log("SHADOW HEALTH — errors are a broken measurement, not a broken portal");
rule("-");
const errored = all.filter((g) => g.errors > 0 || g.unknown > 0);
if (errored.length === 0) {
  log("  clean — every line resolved to a decision.");
} else {
  log(
    "  These requests SERVED NORMALLY (that is the contract), but the shadow computation\n" +
      "  did not produce an answer, so they are missing from the gate above.\n"
  );
  for (const g of errored) {
    log(`  ${nameOf(g.user)} ${g.object} ${g.path}: ${fmt(g.errors)} error(s), ${fmt(g.unknown)} unknown of ${fmt(g.requests)}`);
  }
}

// --- what this summary cannot tell you --------------------------------------
rule("-");
log("WHAT THIS CANNOT TELL YOU");
rule("-");
log(
  "  1. EQUAL COUNTS ARE NOT AN EQUAL SET. Two disjoint sets of 3,534 rows compare equal\n" +
    "     here. `scripts/access-shadow-report.mjs` does the id-set diff; run BOTH before\n" +
    "     the Phase 3 flip.\n" +
    "  2. The picklist routes shadow the MODULE gate only. §4.4's field-level narrowing\n" +
    "     needs the Phase 4 manifest, so `meta.*` lines saying `served` mean the object is\n" +
    "     reachable, NOT that the response is unchanged for a sales role in Phase 4.\n" +
    "  3. A user who did not log in during the window is absent, not unaffected. The\n" +
    "     report covers everyone; this covers whoever showed up."
);
log("");
process.exit(unexplained.length === 0 ? 0 : 1);
