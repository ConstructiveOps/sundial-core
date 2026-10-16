// How close is each list page to Lambda's 6 MB response cap?
//
// WHY (2026-10-01): the CloudWatch alarm `sundial-sf-query-errors` fired (6 Lambda errors
// in 5 minutes) with no timeout, crash or console.error line in the log. sundial-sf-query
// catches its own errors, so the Lambda-level failures left are few — and the one this
// endpoint has hit before (2026-08-10, PROGRESS.md) is a list page whose response is over
// Lambda's hard cap of 6,291,556 bytes: the runtime cannot deliver it, API Gateway answers
// 502, the portal retries, and every attempt counts as one Lambda error. The portal sweeps
// lists 5,000 rows at a time (harmon-crm src/lib/api.ts DEFAULT_PAGE_SIZE), and the rows
// only get fatter as fields are filled in — a page that fitted in August may not today.
//
// The Lambda does not log which request failed, so this asks the question directly: it
// requests every 5,000-row page of every list the way the portal does and reports the SIZE
// of each answer. A page that fails is fetched again as two halves, so its true size is
// known too.
//
// READ-ONLY (GET only). Signs in as the ZZ TEST Executive of the primary tenant — never a
// live user (CLAUDE.md) — with the password from Secrets Manager `sundial/test-users`.
// VALUE-SAFETY: prints object names, offsets, row counts and byte counts. Never a row.
//
// ⚠️ A page that IS over the cap fails once more when this asks for it: expect one Lambda
// error per oversized page (the alarm needs more than 5 in 5 minutes).
//
//   node scripts/probe-list-payload.mjs            every list
//   node scripts/probe-list-payload.mjs customer   one list (the object key in the URL)

import { pathToFileURL } from "node:url";

export const API_BASE_DEFAULT = "https://5sktfwldh1.execute-api.us-west-1.amazonaws.com/prod";
/** Lambda's cap on the serialized response (the number its own 413 error quotes). */
export const LAMBDA_CAP_BYTES = 6291556;
export const PAGE = 5000;
/** The object keys of GET /sf/{key} (OBJECT_ALLOWLIST in lambdas/sundial-sf-query). */
export const KEYS = ["customer", "solar", "roofing", "po", "user", "estimate", "job", "servicecall", "serviceline", "serviceinvoice", "servicepayment", "pricebookitem", "serviceplan", "membership"];
/** Filtered sweeps the portal also makes — a filtered page holds different rows than an unfiltered one. */
export const VARIANTS = [{ key: "customer", label: "customer (Service customers)", extra: "&field=Customer_Type__c&value=Service&op=includes" }];

/**
 * The size Lambda measures: the whole response object {statusCode, headers, body} as JSON,
 * in which the body string is escaped a second time. ~400 bytes stand in for the headers.
 */
export const envelopeBytes = (bodyText) => Buffer.byteLength(JSON.stringify({ statusCode: 200, headers: {}, body: bodyText })) + 400;
const mb = (n) => `${(n / 1048576).toFixed(2)} MB`;
const pct = (n) => `${Math.round((n / LAMBDA_CAP_BYTES) * 100)}%`;

/**
 * @param {{ fetch: Function, token: string, log: Function, apiBase?: string, keys?: string[] }} io
 * @returns {Promise<{ over: object[], near: object[], pages: object[] }>}
 */
export async function probe({ fetch: doFetch, token, log, apiBase = API_BASE_DEFAULT, keys = KEYS }) {
  const get = async (path) => {
    try {
      const res = await doFetch(`${apiBase}${path}`, { method: "GET", headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch { json = null; }
      return { status: res.status, text, json };
    } catch (e) {
      return { status: null, text: "", json: null, failure: e?.name === "TimeoutError" ? "timed out" : "network failure" };
    }
  };
  const pages = [];
  const sweeps = [...keys.map((key) => ({ key, label: key, extra: "" })), ...VARIANTS.filter((v) => keys.includes(v.key))];
  for (const s of sweeps) {
    const head = await get(`/sf/${s.key}?limit=1&offset=0${s.extra}`);
    if (head.status !== 200 || typeof head.json?.total !== "number") {
      log(`${s.label}: could not be read (${head.status === null ? head.failure : `HTTP ${head.status}${head.json?.code ? ` ${head.json.code}` : ""}`}) — skipped`);
      continue;
    }
    const total = head.json.total;
    log(`${s.label}: ${total.toLocaleString("en-US")} rows`);
    for (let offset = 0; offset < total; offset += PAGE) {
      const r = await get(`/sf/${s.key}?limit=${PAGE}&offset=${offset}${s.extra}`);
      const page = { label: s.label, key: s.key, offset, status: r.status, rows: null, bytes: null, failed: false };
      if (r.status === 200 && Array.isArray(r.json?.records)) {
        page.rows = r.json.records.length;
        page.bytes = envelopeBytes(r.text);
        log(`  offset ${String(offset).padStart(6)}  ${String(page.rows).padStart(5)} rows  ${mb(page.bytes).padStart(9)}  ${pct(page.bytes).padStart(4)} of the cap${page.bytes > LAMBDA_CAP_BYTES * 0.85 ? "   <-- CLOSE" : ""}`);
      } else {
        // The page did not arrive. Fetch it as two halves: their sizes add up to what the
        // whole page would have been, which says whether the cap is the reason.
        page.failed = true;
        const half = PAGE / 2;
        let sum = 0;
        let rows = 0;
        let halvesOk = true;
        for (const off of [offset, offset + half]) {
          if (off >= total) continue;
          const h = await get(`/sf/${s.key}?limit=${half}&offset=${off}${s.extra}`);
          if (h.status === 200 && Array.isArray(h.json?.records)) { sum += envelopeBytes(h.text); rows += h.json.records.length; }
          else halvesOk = false;
        }
        if (halvesOk) { page.bytes = sum; page.rows = rows; }
        const why = r.status === null ? r.failure : `HTTP ${r.status}`;
        log(`  offset ${String(offset).padStart(6)}  FAILED (${why})${halvesOk ? ` — as two halves: ${rows} rows, ${mb(sum)} = ${pct(sum)} of the cap${sum > LAMBDA_CAP_BYTES ? "   <-- OVER THE CAP" : ""}` : " — the halves failed too, so this is not (only) a size problem"}`);
      }
      pages.push(page);
    }
  }
  const over = pages.filter((p) => p.failed);
  const near = pages.filter((p) => !p.failed && p.bytes > LAMBDA_CAP_BYTES * 0.85);
  log("");
  if (over.length) {
    log(`RESULT: ${over.length} page(s) FAILED at ${PAGE} rows:`);
    for (const p of over) log(`  - ${p.label}, offset ${p.offset}${p.bytes ? `: ${mb(p.bytes)} (${pct(p.bytes)} of Lambda's 6 MB cap)` : ""}`);
    log("  Anyone whose screen sweeps that list gets a failed page, retried, each attempt one Lambda error.");
  } else {
    log(`RESULT: every ${PAGE}-row page arrived.`);
  }
  if (near.length) {
    log(`  ${near.length} page(s) are within 15% of the cap and will cross it as records fill in:`);
    for (const p of near) log(`  - ${p.label}, offset ${p.offset}: ${mb(p.bytes)} (${pct(p.bytes)})`);
  }
  const biggest = pages.filter((p) => p.bytes).sort((a, b) => b.bytes - a.bytes)[0];
  if (biggest) log(`  Largest page: ${biggest.label}, offset ${biggest.offset} — ${mb(biggest.bytes)} (${pct(biggest.bytes)} of the cap).`);
  return { over, near, pages };
}

async function main(argv) {
  const keys = argv.filter((a) => !a.startsWith("--"));
  const bad = keys.filter((k) => !KEYS.includes(k));
  if (bad.length || argv.some((a) => a.startsWith("--"))) {
    console.error(`usage: node scripts/probe-list-payload.mjs [${KEYS.join(" | ")}]`);
    return 2;
  }
  const { loginAsTestUser } = await import("./portal-login.mjs");
  const who = await loginAsTestUser("exec");
  if (!who?.token) { console.error(`could not sign in as the ZZ TEST Executive (HTTP ${who?.status ?? "?"})`); return 1; }
  console.log(`LIST PAYLOAD PROBE — read-only, signed in as ${who.email} (a ZZ TEST user). Sizes only; no row is printed.`);
  console.log(`Lambda's response cap: ${LAMBDA_CAP_BYTES.toLocaleString("en-US")} bytes. Page size: ${PAGE} rows, as the portal asks.`);
  console.log("");
  const r = await probe({
    fetch: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(60000) }),
    token: who.token,
    log: (line) => console.log(line),
    apiBase: (process.env.API_BASE_URL || API_BASE_DEFAULT).replace(/\/+$/, ""),
    keys: keys.length ? keys : KEYS,
  });
  return r.over.length ? 1 : 0;
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => { process.exitCode = code; })
    .catch((err) => {
      console.error(`FAILED: ${err?.message || err}`);
      process.exitCode = 1;
    });
}
