// Tests for sundial-welcome-call.
//
// Run with:  npm test        (needs --experimental-test-module-mocks)
//
// The two things worth testing hardest are the ones that reach a real customer:
//   - the eligibility guard (every branch of it stops a call that shouldn't happen)
//   - the spoken value formatting (these strings are read aloud as contract terms)
// After that: signature verification, the ledger-forward-first ordering, the status
// state machine, and idempotency on redelivery.

import test from "node:test";
import assert from "node:assert/strict";
import { mock } from "node:test";
import crypto from "node:crypto";

// ---------------------------------------------------------------------------
// Shared mutable context the mocks read from
// ---------------------------------------------------------------------------
const WEBHOOK_SECRET = "whsec-test-value";
const SUPABASE_URL = "https://proj.supabase.co";

const ctx = {
  secret: {},
  describeFields: [],
  queryRows: [],
  soqlSeen: [],
  sfUpdates: [],
  sfUpdateThrows: null,
  cacheUpdates: [],
  broadcasts: [],
  retellCalls: [],
  retellResponse: { status: 201, body: { call_id: "call_abc123" } },
  zapierPosts: [],
  zapierResponses: [], // consumed per attempt; default ok
};

// Live Sundial_Customer__c field set (names + types taken from the real describe).
const ORG_FIELDS = [
  ["Id", "id"],
  ["Name", "string"],
  ["Street__c", "string"],
  ["City__c", "string"],
  ["State__c", "picklist"],
  ["Postal_Code__c", "string"],
  ["Primary_Phone__c", "phone"],
  ["Primary_Email__c", "email"],
  ["Final_System_Size_kW__c", "double"],
  ["First_Year_kW_Production__c", "double"],
  ["Financing_Partner__c", "picklist"],
  ["Monthly_Payment__c", "currency"],
  ["Energy_Rate__c", "currency"],
  ["Escalator__c", "percent"],
  ["Contract_Amount__c", "currency"],
  ["Down_Payment_Amount__c", "currency"],
  ["Due_at_Audit_Amount__c", "currency"],
  // NOTE: the live org spells this with an underscore between Green and Tag, which is
  // NOT the name in the spec. fields.js resolves both.
  ["Due_at_Green_Tag_Amount__c", "currency"],
  ["Loan_Term_Years__c", "double"],
  ["APR__c", "percent"],
  ["Prepaid_Lease_Amount__c", "currency"],
  ["Welcome_Call_Status__c", "picklist"],
  ["Welcome_Call_Attempts__c", "double"],
  ["Welcome_Call_Log__c", "textarea"],
  ["Client__c", "reference"],
].map(([name, type]) => ({ name, type }));

function baseCustomer(overrides = {}) {
  return {
    Id: "a1P7y00000AUo6TEAT",
    Name: "Dana Whitfield",
    Street__c: "123 Main St",
    City__c: "Phoenix",
    State__c: "AZ",
    Postal_Code__c: "85032",
    Primary_Phone__c: "(602) 555-0134",
    Primary_Email__c: "dana@example.com",
    Final_System_Size_kW__c: 7.2,
    First_Year_kW_Production__c: 11450,
    Financing_Partner__c: "ICCU",
    Monthly_Payment__c: 142.5,
    Energy_Rate__c: 0.089,
    Escalator__c: 1.9,
    Contract_Amount__c: 45900,
    Down_Payment_Amount__c: 0,
    Due_at_Audit_Amount__c: 5000,
    Due_at_Green_Tag_Amount__c: 20900,
    Loan_Term_Years__c: 25,
    APR__c: 3.99,
    Prepaid_Lease_Amount__c: null,
    Welcome_Call_Status__c: "Queued",
    Welcome_Call_Attempts__c: 0,
    Welcome_Call_Log__c: "",
    Client__c: "a1W7y000007AszBEAS",
    ...overrides,
  };
}

function resetCtx() {
  ctx.secret = {
    api_key: "retell-key",
    webhook_secret: WEBHOOK_SECRET,
    from_number: "+16025550000",
    agent_id: "agent_welcome",
  };
  ctx.describeFields = ORG_FIELDS;
  ctx.queryRows = [baseCustomer()];
  ctx.soqlSeen = [];
  ctx.sfUpdates = [];
  ctx.sfUpdateThrows = null;
  ctx.cacheUpdates = [];
  ctx.broadcasts = [];
  ctx.retellCalls = [];
  ctx.retellResponse = { status: 201, body: { call_id: "call_abc123" } };
  ctx.zapierPosts = [];
  ctx.zapierResponses = [];
  process.env.ZAPIER_RESULTS_HOOK_URL = "https://hooks.zapier.com/hooks/catch/1/abc/";
  delete process.env.RETELL_API_KEY;
  delete process.env.RETELL_FROM_NUMBER;
  delete process.env.RETELL_AGENT_ID;
  delete process.env.RETELL_WEBHOOK_SECRET;
}
resetCtx();

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------
mock.module("../../lib/secrets.js", {
  exports: { getSecret: async () => ctx.secret, clearSecretCache: () => {} },
});

mock.module("../../lib/salesforce.js", {
  exports: {
    soqlEscapeString: (v) => String(v).replace(/\\/g, "\\\\").replace(/'/g, "\\'"),
    describeObject: async () => ({ fields: ctx.describeFields }),
    sfQuery: async (soql) => {
      ctx.soqlSeen.push(soql);
      return ctx.queryRows;
    },
    sfUpdateRecord: async (obj, id, fields) => {
      if (ctx.sfUpdateThrows) throw new Error(ctx.sfUpdateThrows);
      ctx.sfUpdates.push({ obj, id, fields });
      return { ok: true, id };
    },
  },
});

// A minimal PostgREST-shaped chainable stub: .from().update().eq().eq() resolves.
function supabaseStub() {
  return {
    from(table) {
      const rec = { table, patch: null, filters: {} };
      const chain = {
        update(patch) {
          rec.patch = patch;
          return chain;
        },
        eq(col, val) {
          rec.filters[col] = val;
          return chain;
        },
        then(resolve) {
          ctx.cacheUpdates.push(rec);
          return Promise.resolve({ error: null }).then(resolve);
        },
      };
      return chain;
    },
  };
}

mock.module("../../lib/supabase.js", {
  exports: {
    getSupabaseClient: async () => supabaseStub(),
    getSupabaseConfig: async () => ({ url: SUPABASE_URL, serviceRoleKey: "svc-key" }),
  },
});

mock.module("../../lib/realtime.js", {
  exports: {
    recordChannel: (t, o, id) => `tenant:${t}:${o}:${id}`,
    broadcast: async (channel, eventName, payload) => {
      ctx.broadcasts.push({ channel, eventName, payload });
      return { ok: true, status: 202 };
    },
  },
});

// --- global fetch router -----------------------------------------------------
// Routes the three outbound HTTP calls this Lambda can make. Anything unrecognized
// throws, so a new call site can't slip through a test unnoticed.
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);

  if (u.includes("api.retellai.com")) {
    ctx.retellCalls.push({ url: u, headers: init.headers, body: JSON.parse(init.body) });
    const { status, body } = ctx.retellResponse;
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(body),
    };
  }

  if (u.includes("hooks.zapier.com")) {
    ctx.zapierPosts.push({ url: u, body: init.body });
    const next = ctx.zapierResponses.shift();
    if (next?.throw) throw new Error(next.throw);
    const status = next?.status ?? 200;
    return { ok: status >= 200 && status < 300, status, text: async () => "ok" };
  }

  if (u.startsWith(`${SUPABASE_URL}/rest/v1/`)) {
    // PostgREST OpenAPI document, used for cache column introspection.
    return {
      ok: true,
      status: 200,
      json: async () => ({
        definitions: {
          sundial_customer_cache: {
            properties: {
              sf_id: {},
              client_sf_id: {},
              welcome_call_status: {},
              welcome_call_attempts: {},
              welcome_call_log: {},
              is_stale: {},
            },
          },
        },
      }),
    };
  }

  throw new Error(`unexpected fetch to ${u}`);
};

// ---------------------------------------------------------------------------
const fmt = await import("./format.js");
const fieldsMod = await import("./fields.js");
const wb = await import("./writeback.js");
const hook = await import("./webhook.js");
const place = await import("./placeCall.js");
const { handler } = await import("./index.js");
const { clearConfigCache } = await import("./config.js");

function fresh() {
  resetCtx();
  clearConfigCache();
  wb.clearCacheColumnCache();
}

const parse = (res) => JSON.parse(res.body);

// A time inside the Phoenix calling window (17:00 UTC = 10:00 MST).
const IN_WINDOW = new Date("2026-08-17T17:00:00Z");
// 05:00 UTC = 22:00 MST the previous day — outside.
const OUT_OF_WINDOW = new Date("2026-08-18T05:00:00Z");

function signedWebhookEvent(payload, secret = WEBHOOK_SECRET) {
  const body = JSON.stringify(payload);
  const sig = crypto.createHmac("sha256", secret).update(body, "utf8").digest("hex");
  return {
    httpMethod: "POST",
    headers: { "Content-Type": "application/json", "X-Retell-Signature": `v=${sig}` },
    body,
  };
}

function analyzedPayload(overrides = {}, analysisOverrides = {}) {
  return {
    event: "call_analyzed",
    call: {
      call_id: "call_abc123",
      recording_url: "https://recordings.retellai.com/call_abc123.wav",
      in_voicemail: false,
      metadata: { source: "sundial", sf_record_id: baseCustomer().Id, attempt_no: 1 },
      call_analysis: {
        call_summary: "Customer confirmed all terms.",
        custom_analysis_data: {
          verification_result: "passed",
          identity_confirmed: true,
          email_confirmed: true,
          system_details_confirmed: true,
          financial_terms_confirmed: true,
          utility_bill_understood: true,
          usage_change_understood: true,
          mismatched_items: [],
          unconfirmed_items: [],
          follow_up_notes: "",
          ...analysisOverrides,
        },
      },
      ...overrides,
    },
  };
}

// ===========================================================================
// format.js — the values a customer hears
// ===========================================================================

test("money drops a bare .00 but keeps real cents", () => {
  assert.equal(fmt.money(45900), "$45,900");
  assert.equal(fmt.money(142.5), "$142.50");
  assert.equal(fmt.money(0), "$0");
  assert.equal(fmt.money(1234567.89), "$1,234,567.89");
});

test("blank sources become the literal 'not provided', but zero does not", () => {
  assert.equal(fmt.money(null), "not provided");
  assert.equal(fmt.money(""), "not provided");
  assert.equal(fmt.money("   "), "not provided");
  assert.equal(fmt.money(0), "$0");
  assert.equal(fmt.percent(0), "0%");
});

test("energy rate keeps sub-cent precision the money formatter would destroy", () => {
  assert.equal(fmt.ratePerKwh(0.089), "$0.089 per kilowatt-hour");
  assert.equal(fmt.ratePerKwh(0.1), "$0.10 per kilowatt-hour");
  assert.equal(fmt.ratePerKwh(0.1234), "$0.1234 per kilowatt-hour");
  assert.notEqual(fmt.ratePerKwh(0.089), "$0.09 per kilowatt-hour");
});

test("speech formats: percent, escalator, term, size, production", () => {
  assert.equal(fmt.percent(3.99), "3.99%");
  assert.equal(fmt.percent(4), "4%");
  assert.equal(fmt.percent(1.9), "1.9%");
  assert.equal(fmt.percentPerYear(1.9), "1.9% per year");
  assert.equal(fmt.moneyPerMonth(142.5), "$142.50 per month");
  assert.equal(fmt.years(25), "25 years");
  assert.equal(fmt.years(1), "1 year");
  assert.equal(fmt.kilowatts(7.2), "7.2 kilowatts");
  assert.equal(fmt.kilowatts(1), "1 kilowatt");
  // Field name says kW; the value is kWh and must be spoken as such.
  assert.equal(fmt.kilowattHours(11450), "11,450 kilowatt-hours");
});

test("address joins state and postal code as one unit and drops blanks", () => {
  assert.equal(
    fmt.address({ street: "123 Main St", city: "Phoenix", state: "AZ", postalCode: "85032" }),
    "123 Main St, Phoenix, AZ 85032"
  );
  assert.equal(
    fmt.address({ street: "123 Main St", city: "", state: "AZ", postalCode: "" }),
    "123 Main St, AZ"
  );
  assert.equal(fmt.address({}), "not provided");
});

// ===========================================================================
// Finance mapping
// ===========================================================================

test("finance_source maps every supported partner", () => {
  const cases = [
    ["Lightreach", "Lightreach_lease", "No"],
    ["Cash", "cash", "No"],
    ["ICCU", "loan", "No"],
    ["Credit Human", "loan", "No"],
    ["Participate Prepaid Lease - Cash", "Participate_prepaid_lease", "No"],
    ["Participate Prepaid Lease - Financed", "Participate_prepaid_lease", "Yes"],
  ];
  for (const [partner, source, loan] of cases) {
    const r = fmt.mapFinanceSource(partner);
    assert.ok(r, `expected a mapping for "${partner}"`);
    assert.equal(r.financeSource, source);
    assert.equal(r.wasALoanUsed, loan);
  }
});

test("partner match is case/space insensitive AND folds the org's EN DASH", () => {
  // The live picklist stores "Participate Prepaid Lease – Cash" with U+2013. A literal
  // comparison misses it and the customer never gets called.
  assert.equal(
    fmt.mapFinanceSource("Participate Prepaid Lease – Cash").financeSource,
    "Participate_prepaid_lease"
  );
  assert.equal(fmt.mapFinanceSource("  lightREACH  ").financeSource, "Lightreach_lease");
  assert.equal(fmt.mapFinanceSource("credit   human").financeSource, "loan");
});

test("unmapped or blank partner returns null (caller must skip)", () => {
  assert.equal(fmt.mapFinanceSource("GoodLeap"), null);
  assert.equal(fmt.mapFinanceSource(""), null);
  assert.equal(fmt.mapFinanceSource(null), null);
  assert.equal(fmt.mapFinanceSource("Sunlight"), null);
});

// ===========================================================================
// Phone + clock
// ===========================================================================

test("phone parsing accepts real US formats and rejects junk", () => {
  assert.equal(fmt.toE164US("(602) 555-0134"), "+16025550134");
  assert.equal(fmt.toE164US("602.555.0134"), "+16025550134");
  assert.equal(fmt.toE164US("1-602-555-0134"), "+16025550134");
  assert.equal(fmt.toE164US("+1 602 555 0134"), "+16025550134");

  assert.equal(fmt.toE164US(""), null);
  assert.equal(fmt.toE164US("555-0134"), null); // too short
  assert.equal(fmt.toE164US("602-555-0134 x22"), null); // extension: refuse to guess
  assert.equal(fmt.toE164US("0000000000"), null); // invalid NANP area code
  assert.equal(fmt.toE164US("1602555013"), null); // 10 digits starting with 1
});

test("calling window is 08:00-20:00 America/Phoenix, end exclusive", () => {
  // Phoenix is UTC-7 year round (no DST).
  assert.equal(fmt.isWithinCallWindow(new Date("2026-08-17T14:59:00Z")), false); // 07:59
  assert.equal(fmt.isWithinCallWindow(new Date("2026-08-17T15:00:00Z")), true); // 08:00
  assert.equal(fmt.isWithinCallWindow(new Date("2026-08-18T02:59:00Z")), true); // 19:59
  assert.equal(fmt.isWithinCallWindow(new Date("2026-08-18T03:00:00Z")), false); // 20:00
});

test("log stamp is Phoenix local time labelled MST", () => {
  assert.equal(fmt.phoenixStamp(new Date("2026-08-17T21:32:00Z")), "2026-08-17 14:32 MST");
});

// ===========================================================================
// fields.js — describe guard
// ===========================================================================

test("field resolution falls back to the org's Due_at_Green_Tag_Amount__c spelling", () => {
  const s = fieldsMod.resolveCustomerFields({ fields: ORG_FIELDS });
  assert.equal(s.apiName("dueAtGreentagAmount"), "Due_at_Green_Tag_Amount__c");
  assert.ok(s.selectFields.includes("Due_at_Green_Tag_Amount__c"));
  assert.equal(s.missingRequired.length, 0);
});

test("a field absent from the org degrades to 'not provided', not an error", () => {
  const trimmed = ORG_FIELDS.filter((f) => f.name !== "Prepaid_Lease_Amount__c");
  const s = fieldsMod.resolveCustomerFields({ fields: trimmed });
  assert.ok(s.missingLogical.includes("prepaidLeaseAmount"));
  assert.ok(!s.selectFields.includes("Prepaid_Lease_Amount__c"));
  const vars = fmt.buildDynamicVariables(s.reader(baseCustomer()), {
    financeSource: "loan",
    wasALoanUsed: "No",
  });
  assert.equal(vars.prepaid_lease_amount, "not provided");
});

test("missing Welcome Call control fields are reported as required-missing", () => {
  const trimmed = ORG_FIELDS.filter((f) => f.name !== "Welcome_Call_Log__c");
  const s = fieldsMod.resolveCustomerFields({ fields: trimmed });
  assert.deepEqual(s.missingRequired, ["welcomeCallLog"]);
});

test("dynamic variables are all strings, complete, and carry no rep_name", () => {
  const s = fieldsMod.resolveCustomerFields({ fields: ORG_FIELDS });
  const vars = fmt.buildDynamicVariables(s.reader(baseCustomer()), {
    financeSource: "loan",
    wasALoanUsed: "No",
  });
  for (const [k, v] of Object.entries(vars)) {
    assert.equal(typeof v, "string", `${k} must be a string, got ${typeof v}`);
  }
  assert.ok(!("rep_name" in vars));
  assert.equal(Object.keys(vars).length, 21);
  assert.equal(vars.customer_name, "Dana Whitfield");
  assert.equal(vars.property_address, "123 Main St, Phoenix, AZ 85032");
  assert.equal(vars.system_size, "7.2 kilowatts");
  assert.equal(vars.estimated_production, "11,450 kilowatt-hours");
  assert.equal(vars.monthly_payment, "$142.50 per month");
  assert.equal(vars.energy_rate, "$0.089 per kilowatt-hour");
  assert.equal(vars.escalator, "1.9% per year");
  assert.equal(vars.total_price, "$45,900");
  assert.equal(vars.loan_amount, "$45,900"); // same source as total_price, by design
  assert.equal(vars.amount_due_signing, "$0"); // zero is a value, not "not provided"
  assert.equal(vars.amount_due_install, "$20,900");
  assert.equal(vars.loan_term, "25 years");
  assert.equal(vars.interest_rate, "3.99%");
  assert.equal(vars.ppl_loan_payment, "$142.50 per month");
  assert.equal(vars.ppl_loan_term, "25 years");
  assert.equal(vars.prepaid_lease_amount, "not provided");
});

// ===========================================================================
// Eligibility guard
// ===========================================================================

function readerFor(record) {
  return fieldsMod.resolveCustomerFields({ fields: ORG_FIELDS }).reader(record);
}

test("eligible customer passes the guard", () => {
  const v = place.evaluateEligibility(readerFor(baseCustomer()), IN_WINDOW);
  assert.equal(v.eligible, true);
  assert.equal(v.phone, "+16025550134");
  assert.equal(v.attempts, 0);
  assert.equal(v.finance.financeSource, "loan");
});

test("every blocking status stops the call", () => {
  for (const status of ["Calling", "Verified", "Verified - Exceptions", "Refused", "Failed - Max Attempts"]) {
    const v = place.evaluateEligibility(
      readerFor(baseCustomer({ Welcome_Call_Status__c: status })),
      IN_WINDOW
    );
    assert.equal(v.eligible, false, `${status} should block`);
    assert.equal(v.reason, "status");
  }
});

test("non-blocking statuses still allow a call", () => {
  for (const status of ["Not Started", "Queued", "No Answer", null]) {
    const v = place.evaluateEligibility(
      readerFor(baseCustomer({ Welcome_Call_Status__c: status })),
      IN_WINDOW
    );
    assert.equal(v.eligible, true, `${status} should not block`);
  }
});

test("attempt ceiling, bad phone, closed window and bad partner each block", () => {
  const cases = [
    [{ Welcome_Call_Attempts__c: 5 }, IN_WINDOW, "max_attempts"],
    [{ Welcome_Call_Attempts__c: 9 }, IN_WINDOW, "max_attempts"],
    [{ Primary_Phone__c: "" }, IN_WINDOW, "no_phone"],
    [{ Primary_Phone__c: "n/a" }, IN_WINDOW, "no_phone"],
    [{}, OUT_OF_WINDOW, "outside_calling_window"],
    [{ Financing_Partner__c: "GoodLeap" }, IN_WINDOW, "unmappable_financing_partner"],
    [{ Financing_Partner__c: "" }, IN_WINDOW, "unmappable_financing_partner"],
  ];
  for (const [over, when, reason] of cases) {
    const v = place.evaluateEligibility(readerFor(baseCustomer(over)), when);
    assert.equal(v.eligible, false);
    assert.equal(v.reason, reason);
  }
});

test("only the unmappable-partner skip writes a Salesforce log line", () => {
  const bad = place.evaluateEligibility(
    readerFor(baseCustomer({ Financing_Partner__c: "GoodLeap" })),
    IN_WINDOW
  );
  assert.equal(bad.writeLogLine, "unmappable financing partner: GoodLeap");
  const blank = place.evaluateEligibility(
    readerFor(baseCustomer({ Financing_Partner__c: "" })),
    IN_WINDOW
  );
  assert.equal(blank.writeLogLine, "unmappable financing partner: (blank)");

  const window = place.evaluateEligibility(readerFor(baseCustomer()), OUT_OF_WINDOW);
  assert.equal(window.writeLogLine, undefined);
});

// ===========================================================================
// placeCall — end to end through the mocks
// ===========================================================================

test("place call: Retell payload, SF writeback, cache and broadcast", async () => {
  fresh();
  const res = await place.placeWelcomeCall(baseCustomer().Id, { now: IN_WINDOW });
  assert.equal(res.status, "placed");
  assert.equal(res.callId, "call_abc123");
  assert.equal(res.attemptNo, 1);

  // Fresh read from Salesforce, not the cache.
  assert.equal(ctx.soqlSeen.length, 1);
  assert.match(ctx.soqlSeen[0], /FROM Sundial_Customer__c WHERE Id = 'a1P7y00000AUo6TEAT'/);

  const sent = ctx.retellCalls[0];
  assert.equal(sent.headers.Authorization, "Bearer retell-key");
  assert.equal(sent.body.from_number, "+16025550000");
  assert.equal(sent.body.to_number, "+16025550134");
  assert.equal(sent.body.override_agent_id, "agent_welcome");
  assert.deepEqual(sent.body.metadata, {
    source: "sundial",
    sf_record_id: "a1P7y00000AUo6TEAT",
    tenant: "a1W7y000007AszBEAS",
    attempt_no: 1,
  });
  assert.equal(sent.body.retell_llm_dynamic_variables.finance_source, "loan");

  const upd = ctx.sfUpdates[0];
  assert.equal(upd.fields.Welcome_Call_Status__c, "Calling");
  assert.equal(upd.fields.Welcome_Call_Attempts__c, 1);
  assert.match(
    upd.fields.Welcome_Call_Log__c,
    /^\d{4}-\d{2}-\d{2} \d{2}:\d{2} MST · Attempt 1 · Call placed · call_id=call_abc123$/
  );

  const cache = ctx.cacheUpdates[0];
  assert.equal(cache.table, "sundial_customer_cache");
  assert.equal(cache.patch.welcome_call_status, "Calling");
  assert.equal(cache.patch.welcome_call_attempts, 1);
  assert.equal(cache.patch.is_stale, true);
  assert.equal(cache.filters.sf_id, "a1P7y00000AUo6TEAT");
  assert.equal(cache.filters.client_sf_id, "a1W7y000007AszBEAS");

  assert.equal(ctx.broadcasts.length, 1);
  assert.equal(
    ctx.broadcasts[0].channel,
    "tenant:a1W7y000007AszBEAS:sundial_customer:a1P7y00000AUo6TEAT"
  );
});

test("attempt counter increments from the stored value", async () => {
  fresh();
  ctx.queryRows = [baseCustomer({ Welcome_Call_Attempts__c: 3 })];
  const res = await place.placeWelcomeCall(baseCustomer().Id, { now: IN_WINDOW });
  assert.equal(res.attemptNo, 4);
  assert.equal(ctx.sfUpdates[0].fields.Welcome_Call_Attempts__c, 4);
  assert.equal(ctx.retellCalls[0].body.metadata.attempt_no, 4);
});

test("a skipped call places nothing and writes nothing (window closed)", async () => {
  fresh();
  const res = await place.placeWelcomeCall(baseCustomer().Id, { now: OUT_OF_WINDOW });
  assert.equal(res.status, "skipped");
  assert.equal(res.reason, "outside_calling_window");
  assert.equal(ctx.retellCalls.length, 0);
  assert.equal(ctx.sfUpdates.length, 0);
});

test("an unmappable partner skips the call but records why, without burning an attempt", async () => {
  fresh();
  ctx.queryRows = [baseCustomer({ Financing_Partner__c: "GoodLeap" })];
  const res = await place.placeWelcomeCall(baseCustomer().Id, { now: IN_WINDOW });
  assert.equal(res.status, "skipped");
  assert.equal(ctx.retellCalls.length, 0);
  assert.equal(ctx.sfUpdates.length, 1);
  const fields = ctx.sfUpdates[0].fields;
  assert.match(fields.Welcome_Call_Log__c, /Skipped · unmappable financing partner: GoodLeap/);
  assert.ok(!("Welcome_Call_Status__c" in fields));
  assert.ok(!("Welcome_Call_Attempts__c" in fields));
});

test("a Retell failure does NOT burn an attempt or set Calling", async () => {
  fresh();
  ctx.retellResponse = { status: 402, body: { error_message: "insufficient balance" } };
  await assert.rejects(
    () => place.placeWelcomeCall(baseCustomer().Id, { now: IN_WINDOW }),
    /insufficient balance/
  );
  assert.equal(ctx.sfUpdates.length, 0);
});

test("a 2xx with no call_id is treated as a failure", async () => {
  fresh();
  ctx.retellResponse = { status: 201, body: {} };
  await assert.rejects(() => place.placeWelcomeCall(baseCustomer().Id, { now: IN_WINDOW }));
  assert.equal(ctx.sfUpdates.length, 0);
});

test("a missing customer is a no-op, not an error", async () => {
  fresh();
  ctx.queryRows = [];
  const res = await place.placeWelcomeCall(baseCustomer().Id, { now: IN_WINDOW });
  assert.equal(res.status, "record_not_found");
  assert.equal(ctx.retellCalls.length, 0);
});

test("customer id is extracted from every relay envelope", () => {
  const id = "a1P7y00000AUo6TEAT";
  assert.deepEqual(place.extractCustomerIds({ detail: { payload: { Customer_Id__c: id } } }), [id]);
  assert.deepEqual(
    place.extractCustomerIds({
      Records: [{ body: JSON.stringify({ detail: { payload: { Customer_Id__c: id } } }) }],
    }),
    [id]
  );
  assert.deepEqual(
    place.extractCustomerIds({ Records: [{ body: JSON.stringify({ Customer_Id__c: id }) }] }),
    [id]
  );
  assert.deepEqual(place.extractCustomerIds({ Customer_Id__c: id }), [id]);
  // De-duplicated so one batch can't double-dial the same customer.
  assert.deepEqual(
    place.extractCustomerIds({
      Records: [
        { body: JSON.stringify({ Customer_Id__c: id }) },
        { body: JSON.stringify({ Customer_Id__c: id }) },
      ],
    }),
    [id]
  );
  assert.deepEqual(place.extractCustomerIds({}), []);
});

// ===========================================================================
// Webhook — signature
// ===========================================================================

test("signature must match the raw body, with or without the v= prefix", () => {
  const body = '{"event":"call_analyzed"}';
  const sig = crypto.createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex");
  assert.equal(hook.verifySignature(body, `v=${sig}`, WEBHOOK_SECRET), true);
  assert.equal(hook.verifySignature(body, sig, WEBHOOK_SECRET), true);
  assert.equal(hook.verifySignature(body, sig.toUpperCase(), WEBHOOK_SECRET), true);

  assert.equal(hook.verifySignature(body, sig, "wrong-secret"), false);
  assert.equal(hook.verifySignature(`${body} `, `v=${sig}`, WEBHOOK_SECRET), false);
  assert.equal(hook.verifySignature(body, "", WEBHOOK_SECRET), false);
  assert.equal(hook.verifySignature(body, undefined, WEBHOOK_SECRET), false);
  assert.equal(hook.verifySignature(body, `v=${sig}`, ""), false);
});

test("an unsigned or wrongly-signed webhook is 401 and touches nothing", async () => {
  fresh();
  const payload = analyzedPayload();
  const bad = { httpMethod: "POST", headers: {}, body: JSON.stringify(payload) };
  const res = await handler(bad);
  assert.equal(res.statusCode, 401);
  assert.equal(ctx.zapierPosts.length, 0);
  assert.equal(ctx.sfUpdates.length, 0);
});

test("an unconfigured webhook secret fails CLOSED", async () => {
  fresh();
  ctx.secret = { api_key: "retell-key" }; // no webhook_secret anywhere
  clearConfigCache();
  const res = await handler(signedWebhookEvent(analyzedPayload()));
  assert.equal(res.statusCode, 401);
  assert.equal(ctx.sfUpdates.length, 0);
});

test("base64-encoded bodies verify (API Gateway may deliver them that way)", async () => {
  fresh();
  const payload = analyzedPayload();
  const body = JSON.stringify(payload);
  const sig = crypto.createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex");
  const res = await handler({
    httpMethod: "POST",
    headers: { "x-retell-signature": `v=${sig}` },
    body: Buffer.from(body, "utf8").toString("base64"),
    isBase64Encoded: true,
  });
  assert.equal(res.statusCode, 200);
  assert.equal(parse(res).salesforce, "updated");
});

// ===========================================================================
// Webhook — lifecycle events
// ===========================================================================

test("call_started and call_ended are acked and ignored (no ledger row)", async () => {
  for (const name of ["call_started", "call_ended"]) {
    fresh();
    const res = await handler(signedWebhookEvent({ event: name, call: { call_id: "c1" } }));
    assert.equal(res.statusCode, 200);
    assert.equal(parse(res).ignored, name);
    assert.equal(ctx.zapierPosts.length, 0);
    assert.equal(ctx.sfUpdates.length, 0);
  }
});

test("an unrecognized event is acked, not retried", async () => {
  fresh();
  const res = await handler(signedWebhookEvent({ event: "call_transferred" }));
  assert.equal(res.statusCode, 200);
  assert.equal(parse(res).ignored, "call_transferred");
});

// ===========================================================================
// Webhook — ledger forward
// ===========================================================================

test("call_analyzed forwards the RAW body to Zapier before writing Salesforce", async () => {
  fresh();
  const event = signedWebhookEvent(analyzedPayload());
  const res = await handler(event);
  assert.equal(res.statusCode, 200);
  assert.equal(ctx.zapierPosts.length, 1);
  assert.equal(ctx.zapierPosts[0].body, event.body); // byte-for-byte
  assert.equal(parse(res).forwarded, true);
  assert.equal(ctx.sfUpdates.length, 1);
});

test("the forward retries twice, then gives up without blocking the writeback", async () => {
  fresh();
  ctx.zapierResponses = [{ status: 500 }, { throw: "socket hang up" }, { status: 503 }];
  const res = await handler(signedWebhookEvent(analyzedPayload()));
  assert.equal(ctx.zapierPosts.length, 3);
  assert.equal(res.statusCode, 200);
  assert.equal(parse(res).forwarded, false);
  // The critical assertion: Salesforce was still updated.
  assert.equal(parse(res).salesforce, "updated");
  assert.equal(ctx.sfUpdates[0].fields.Welcome_Call_Status__c, "Verified");
});

test("a transient forward failure recovers on retry", async () => {
  fresh();
  ctx.zapierResponses = [{ status: 502 }, { status: 200 }];
  const res = await handler(signedWebhookEvent(analyzedPayload()));
  assert.equal(ctx.zapierPosts.length, 2);
  assert.equal(parse(res).forwarded, true);
});

test("a rep-form call with no sf_record_id is forwarded and nothing else", async () => {
  fresh();
  const payload = analyzedPayload({ metadata: { source: "rep_form" } });
  const res = await handler(signedWebhookEvent(payload));
  assert.equal(res.statusCode, 200);
  assert.equal(parse(res).salesforce, "not_applicable");
  assert.equal(ctx.zapierPosts.length, 1);
  assert.equal(ctx.sfUpdates.length, 0);
  assert.equal(ctx.soqlSeen.length, 0); // Salesforce was never even queried
});

// ===========================================================================
// Webhook — outcome mapping
// ===========================================================================

test("verification_result maps to the documented statuses", () => {
  const m = (r, ctxArg) => hook.mapOutcomeToStatus(r, ctxArg).status;
  assert.equal(m("passed"), "Verified");
  assert.equal(m("partial"), "Verified - Exceptions");
  assert.equal(m("failed"), "Verified - Exceptions");
  assert.equal(m("callback_requested"), "Verified - Exceptions");
  assert.equal(m("callback requested"), "Verified - Exceptions"); // space form
  assert.equal(m("refusal"), "Refused");
  assert.equal(m("wrong_person"), "No Answer");
  assert.equal(m("voicemail"), "No Answer");
  assert.equal(m("no answer"), "No Answer");
  assert.equal(m("no_answer"), "No Answer");
  assert.equal(m("PASSED"), "Verified");
});

test("the attempt ceiling rewrites only the No Answer bucket", () => {
  const at5 = { attempts: 5 };
  assert.equal(hook.mapOutcomeToStatus("no_answer", at5).status, "Failed - Max Attempts");
  assert.equal(hook.mapOutcomeToStatus("voicemail", at5).status, "Failed - Max Attempts");
  assert.equal(hook.mapOutcomeToStatus("wrong_person", at5).status, "Failed - Max Attempts");
  // A finished call stays finished no matter how many attempts it took.
  assert.equal(hook.mapOutcomeToStatus("passed", at5).status, "Verified");
  assert.equal(hook.mapOutcomeToStatus("refusal", at5).status, "Refused");
  assert.equal(hook.mapOutcomeToStatus("partial", at5).status, "Verified - Exceptions");
  assert.equal(hook.mapOutcomeToStatus("no_answer", { attempts: 4 }).status, "No Answer");
});

test("an unknown outcome parks for a human rather than queueing another call", () => {
  const r = hook.mapOutcomeToStatus("something_new", { attempts: 0 });
  assert.equal(r.status, "Verified - Exceptions");
  assert.equal(r.recognized, false);
  // ...unless it's an empty result on a voicemail, which really is a no-answer.
  assert.equal(hook.mapOutcomeToStatus("", { inVoicemail: true }).status, "No Answer");
  assert.equal(hook.mapOutcomeToStatus("", { inVoicemail: false }).status, "Verified - Exceptions");
});

test("result writeback records outcome, mismatches and recording url", async () => {
  fresh();
  const payload = analyzedPayload(
    {},
    {
      verification_result: "partial",
      email_confirmed: false,
      financial_terms_confirmed: false,
      mismatched_items: ["email address", "monthly payment"],
      unconfirmed_items: ["utility bill"],
      follow_up_notes: "Customer will call back about the payment amount.",
    }
  );
  const res = await handler(signedWebhookEvent(payload));
  assert.equal(res.statusCode, 200);
  const fields = ctx.sfUpdates[0].fields;
  assert.equal(fields.Welcome_Call_Status__c, "Verified - Exceptions");
  const line = fields.Welcome_Call_Log__c.split("\n")[0];
  assert.match(line, /Result: partial/);
  assert.match(line, /Status: Verified - Exceptions/);
  assert.match(line, /not confirmed: email, financials/);
  assert.match(line, /mismatches: email address; monthly payment/);
  assert.match(line, /unconfirmed: utility bill/);
  assert.match(line, /notes: Customer will call back/);
  assert.match(line, /recording=https:\/\/recordings\.retellai\.com\/call_abc123\.wav/);
  assert.match(line, /call_id=call_abc123/);
});

test("the result line goes on TOP of the existing log", async () => {
  fresh();
  ctx.queryRows = [
    baseCustomer({
      Welcome_Call_Log__c: "2026-08-17 10:00 MST · Attempt 1 · Call placed · call_id=call_abc123",
      Welcome_Call_Status__c: "Calling",
    }),
  ];
  await handler(signedWebhookEvent(analyzedPayload()));
  const lines = ctx.sfUpdates[0].fields.Welcome_Call_Log__c.split("\n");
  assert.match(lines[0], /Result: passed/);
  assert.match(lines[1], /Call placed/);
});

// ===========================================================================
// Webhook — idempotency
// ===========================================================================

test("a redelivered call_analyzed is acked and skipped", async () => {
  fresh();
  ctx.queryRows = [
    baseCustomer({
      Welcome_Call_Status__c: "Verified",
      Welcome_Call_Log__c:
        "2026-08-17 10:05 MST · Attempt 1 · Result: passed · Status: Verified · mismatches: none · call_id=call_abc123\n" +
        "2026-08-17 10:00 MST · Attempt 1 · Call placed · call_id=call_abc123",
    }),
  ];
  const res = await handler(signedWebhookEvent(analyzedPayload()));
  assert.equal(res.statusCode, 200);
  assert.equal(parse(res).salesforce, "duplicate");
  assert.equal(ctx.sfUpdates.length, 0);
});

test("a 'Call placed' line alone is NOT treated as already processed", () => {
  const log = "2026-08-17 10:00 MST · Attempt 1 · Call placed · call_id=call_abc123";
  assert.equal(hook.alreadyProcessed(log, "call_abc123"), false);
  const withResult = `2026-08-17 10:05 MST · Attempt 1 · Result: passed · call_id=call_abc123\n${log}`;
  assert.equal(hook.alreadyProcessed(withResult, "call_abc123"), true);
  // A different call on the same record must still be processed.
  assert.equal(hook.alreadyProcessed(withResult, "call_zzz999"), false);
  assert.equal(hook.alreadyProcessed("", "call_abc123"), false);
  assert.equal(hook.alreadyProcessed(null, "call_abc123"), false);
});

// ===========================================================================
// Webhook — failure handling
// ===========================================================================

test("a Salesforce writeback failure returns 500 so Retell retries", async () => {
  fresh();
  ctx.sfUpdateThrows = "UNABLE_TO_LOCK_ROW";
  const res = await handler(signedWebhookEvent(analyzedPayload()));
  assert.equal(res.statusCode, 500);
  assert.equal(parse(res).forwarded, true); // the ledger still got it
});

test("a deleted customer is acked, not retried forever", async () => {
  fresh();
  ctx.queryRows = [];
  const res = await handler(signedWebhookEvent(analyzedPayload()));
  assert.equal(res.statusCode, 200);
  assert.equal(parse(res).salesforce, "record_not_found");
});

test("non-POST methods are rejected, OPTIONS is a bare 204", async () => {
  fresh();
  assert.equal((await handler({ httpMethod: "OPTIONS", headers: {} })).statusCode, 204);
  assert.equal((await handler({ httpMethod: "GET", headers: {} })).statusCode, 405);
});

// ===========================================================================
// writeback.js — log field bounds
// ===========================================================================

test("log prepend puts the newest line first and trims the oldest at the cap", () => {
  assert.equal(wb.prependLogLine("", "line A"), "line A");
  assert.equal(wb.prependLogLine("old", "new"), "new\nold");
  assert.equal(wb.prependLogLine(null, "new"), "new");

  const filler = Array.from({ length: 900 }, (_, i) => `old line ${i} ${"x".repeat(40)}`).join("\n");
  assert.ok(filler.length > wb.LOG_FIELD_MAX_CHARS);
  const out = wb.prependLogLine(filler, "NEWEST");
  assert.ok(out.length <= wb.LOG_FIELD_MAX_CHARS);
  assert.equal(out.split("\n")[0], "NEWEST");
  assert.ok(!out.endsWith("\n"));
  // The oldest entries are what got dropped.
  assert.ok(!out.includes("old line 899"));
  assert.ok(out.includes("old line 0"));
});

// ===========================================================================
// Routing
// ===========================================================================

test("the handler routes by event shape, not by a flag", async () => {
  fresh();
  // No HTTP method -> platform-event path -> a real call is placed.
  const r1 = await handler({ detail: { payload: { Customer_Id__c: baseCustomer().Id } } });
  assert.equal(r1.processed, 1);
  assert.equal(ctx.retellCalls.length, 1);

  fresh();
  // An HTTP method -> webhook path -> no call is placed.
  const r2 = await handler(signedWebhookEvent(analyzedPayload()));
  assert.equal(r2.statusCode, 200);
  assert.equal(ctx.retellCalls.length, 0);
});

test("a platform event with no Customer_Id__c is a clean no-op", async () => {
  fresh();
  const res = await handler({ detail: { payload: {} } });
  assert.equal(res.processed, 0);
  assert.equal(ctx.retellCalls.length, 0);
});

test("a failing platform-event batch throws so the relay retries", async () => {
  fresh();
  ctx.retellResponse = { status: 500, body: { error_message: "upstream" } };
  await assert.rejects(
    () => handler({ detail: { payload: { Customer_Id__c: baseCustomer().Id } } }),
    /1 of 1 call attempts failed/
  );
});
