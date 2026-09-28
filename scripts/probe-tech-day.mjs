// scripts/probe-tech-day.mjs — what does the phone actually get from the tech routes?
// (2026-09-25: Larry sees "the red error" on Monday even though Salesforce holds his calls.)
//
//   node scripts/probe-tech-day.mjs --date 2026-09-28            # as zz-tech-2 (Secrets Manager sundial/test-users)
//   node scripts/probe-tech-day.mjs --date 2026-09-28 --as tech-3
//   node scripts/probe-tech-day.mjs --date 2026-09-28 --local     # run THIS repo's board code here, against the live org,
//                                                                 # and print the real error (the deployed Lambda only says server_error)
//
// Signs in as a ZZ TEST tech (never a live user — CLAUDE.md), then calls the deployed API
// exactly as the app does: /auth/me, /service/tech/day, /service/tech/jobs, one call by id.
// Prints status + body for each (the body of a 4xx/5xx is the whole point). No writes.

import { loginAsTestUser } from "./portal-login.mjs";

const args = process.argv.slice(2);
const opt = (n, d = null) => {
  const i = args.indexOf(n);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const DATE = opt("--date", new Date().toISOString().slice(0, 10));
const AS = opt("--as", "tech-2");
const LOCAL = args.includes("--local");
const API = (process.env.API_BASE_URL || "https://5sktfwldh1.execute-api.us-west-1.amazonaws.com/prod").replace(/\/+$/, "");

const { email, token, status } = await loginAsTestUser(AS);
if (!token) {
  console.error(`login as ${email} failed (${status})`);
  process.exit(2);
}
console.log(`signed in as ${email}\napi ${API}\n`);

async function get(pathname) {
  const t0 = Date.now();
  let res;
  try {
    res = await fetch(`${API}${pathname}`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
  } catch (e) {
    console.log(`GET ${pathname}\n  NETWORK ERROR ${e.message}\n`);
    return null;
  }
  const text = await res.text();
  let body = text;
  try {
    body = JSON.parse(text);
  } catch { /* not json */ }
  const ms = Date.now() - t0;
  const shown = typeof body === "string" ? body.slice(0, 600) : JSON.stringify(body, null, 1).slice(0, 1800);
  console.log(`GET ${pathname}\n  ${res.status} in ${ms} ms\n  ${shown.split("\n").join("\n  ")}\n`);
  return { status: res.status, body };
}

if (LOCAL) {
  // The handler from this working copy, with its real dependencies (Salesforce, Supabase,
  // Secrets Manager — the same ones the scripts use), invoked the way API Gateway would.
  const { createHandler } = await import("../lambdas/sundial-service-board/index.js");
  const soql = [];
  const { sfQuery } = await import("../lib/salesforce.js");
  const handler = createHandler({
    sfQuery: async (q, o) => {
      soql.push(q);
      try {
        return await sfQuery(q, o);
      } catch (e) {
        console.log(`\nSOQL FAILED:\n  ${q}\n  → ${e?.sfBody || e?.message || e}\n`);
        throw e;
      }
    },
  });
  const origError = console.error;
  console.error = (...a) => origError("  [lambda]", ...a.map((x) => (x instanceof Error ? x.stack : x)));
  const event = { httpMethod: "GET", path: `/prod/service/tech/day`, headers: { authorization: `Bearer ${token}` }, queryStringParameters: { date: DATE } };
  const r = await handler(event);
  console.error = origError;
  console.log(`LOCAL techDay → ${r.statusCode}\n  ${String(r.body).slice(0, 1500)}\n  (${soql.length} SOQL queries ran)`);
  process.exit(0);
}

const me = await get("/auth/me");
const day = await get(`/service/tech/day?date=${encodeURIComponent(DATE)}`);
await get("/service/tech/jobs");
const first = day?.body?.calls?.[0]?.id;
if (first) await get(`/service/tech/calls/${encodeURIComponent(first)}`);
else console.log("(no call id to open)");
console.log(me?.status === 200 && day?.status === 200 ? "Both routes answered 200 — the API is fine for this tech; the phone's error is elsewhere (send its text)." : "There is the failing step — send this output back.");
