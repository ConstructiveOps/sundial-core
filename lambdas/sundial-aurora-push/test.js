// Tests for the Design Request route: POST /customers/{recordId}/design-request/submit
//
// Run with:  npm test        (see package.json — needs --experimental-test-module-mocks)
//
// Everything outside the Lambda is mocked at the module boundary (Salesforce, identity,
// secrets, email) plus global fetch for the Aurora/Salesforce HTTP calls. No network,
// no AWS, no Salesforce org is touched.

import test from "node:test";
import assert from "node:assert/strict";
import { mock } from "node:test";

// --- mutable test context the mocks read from -------------------------------
const ctx = {
  identity: { tenantId: "a0XharmonTENANT", tenantSlug: "harmon" },
  identityError: null,
  // rows returned by the tenant-scoped customer SELECT
  customerRows: [],
  soqlSeen: [],
  fetchCalls: [], // { method, url, body }
  emailsSent: [], // the msg objects passed to sendEmail
  emailConfigured: true,
  emailResult: { ok: true, messageId: "ses-msg-1" },
  auroraCreateStatus: 200,
  // Serve a describe WITHOUT Design_Request_Email_Sent__c (the state of the org
  // until that field is created).
  omitTrackingField: false,
};

function resetCtx() {
  ctx.identity = { tenantId: "a0XharmonTENANT", tenantSlug: "harmon" };
  ctx.identityError = null;
  ctx.customerRows = [];
  ctx.soqlSeen = [];
  ctx.fetchCalls = [];
  ctx.emailsSent = [];
  ctx.emailConfigured = true;
  ctx.emailResult = { ok: true, messageId: "ses-msg-1" };
  ctx.auroraCreateStatus = 200;
  ctx.omitTrackingField = false;
  delete process.env.DESIGN_REQUEST_NOTIFY_CC;
  process.env.DESIGN_REQUEST_NOTIFY_TO = "design.manager@harmonelectric.net";
  process.env.EMAIL_FROM = "Sundial <no-reply@sundialcrm.com>";
}

// --- the fields the org actually has (mirrors the live describe 2026-08-03) --
// Design_Notes__c is deliberately ABSENT: it does not exist on Sundial_Customer__c,
// and the Lambda must drop it from the SELECT instead of 400-ing the whole submit.
const DESCRIBE_FIELDS = [
  ["Id", "id"],
  ["Name", "string"],
  ["First_Name__c", "string"],
  ["Last_Name__c", "string"],
  ["Primary_Email__c", "email"],
  ["Primary_Phone__c", "phone"],
  ["Street__c", "string"],
  ["City__c", "string"],
  ["State__c", "picklist"],
  ["Postal_Code__c", "string"],
  ["Project_Type__c", "picklist"],
  ["Existing_Solar_System__c", "boolean"],
  ["Existing_Panel_Count__c", "double"],
  ["Design_Turnaround__c", "picklist"],
  ["Proposed_Panel_Type__c", "picklist"],
  ["Inverter_Type__c", "picklist"],
  ["Battery_Type__c", "picklist"],
  ["Battery_Quantity__c", "double"],
  ["For_Profit_PPW__c", "string"],
  ["Annual_Usage_kWh__c", "double"],
  ["Utility_Company__c", "picklist"],
  ["Appointment_DateTime__c", "datetime"],
  ["Proposed_Panel_Count__c", "double"],
  ["Offset_Requested__c", "string"],
  ["Financing_Type__c", "picklist"],
  ["Financing_Partner__c", "picklist"],
  ["Term__c", "multipicklist"],
  ["APR__c", "percent"],
  ["Sent_to_Aurora__c", "datetime"],
  ["Aurora_Project_ID__c", "string"],
  ["Design_Request_Email_Sent__c", "datetime"],
  ...[
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ].map((m) => [`${m}_Usage_kW__c`, "double"]),
].map(([name, type]) => ({ name, type }));

const CUSTOMER_ID = "a0AAA0000001ZZZAA2";

// A fully-populated Design Request. Values chosen to exercise every formatter:
// boolean, multipicklist (";"-joined), percent, datetime, and a long text.
function fullCustomer(overrides = {}) {
  return {
    Id: CUSTOMER_ID,
    Name: "Jane Q Homeowner",
    First_Name__c: "Jane",
    Last_Name__c: "Homeowner",
    Primary_Email__c: "jane@example.com",
    Primary_Phone__c: "602-555-0134",
    Street__c: "1234 E Palm Ln",
    City__c: "Mesa",
    State__c: "AZ",
    Postal_Code__c: "85201",
    Project_Type__c: "Battery and Solar",
    Existing_Solar_System__c: true,
    Existing_Panel_Count__c: 12,
    Design_Turnaround__c: "Within 2 Hours",
    Proposed_Panel_Type__c: "Qcells - Q.TRON BLK M-G2.H1+/AC 430",
    Inverter_Type__c: "Enphase IQ8 Plus",
    Battery_Type__c: "Tesla Powerwall 3",
    Battery_Quantity__c: 2,
    For_Profit_PPW__c: "3.15",
    Annual_Usage_kWh__c: 14250,
    Utility_Company__c: "Salt River Project",
    Appointment_DateTime__c: "2026-08-11T22:30:00.000+0000",
    Proposed_Panel_Count__c: 28,
    Offset_Requested__c: "110%",
    Financing_Type__c: "Loan",
    Financing_Partner__c: "GoodLeap",
    Term__c: "20yr;25yr",
    APR__c: 6.99,
    Sent_to_Aurora__c: null,
    Aurora_Project_ID__c: null,
    Design_Request_Email_Sent__c: null,
    Jan_Usage_kW__c: 950,
    Feb_Usage_kW__c: 880,
    Mar_Usage_kW__c: 910,
    Apr_Usage_kW__c: 1020,
    May_Usage_kW__c: 1340,
    Jun_Usage_kW__c: 1760,
    Jul_Usage_kW__c: 1980,
    Aug_Usage_kW__c: 1930,
    Sep_Usage_kW__c: 1610,
    Oct_Usage_kW__c: 1180,
    Nov_Usage_kW__c: 900,
    Dec_Usage_kW__c: 870,
    ...overrides,
  };
}

// --- module mocks (registered once, at top level so they persist) ------------
mock.module("../../lib/salesforce.js", {
  exports: {
    soqlEscapeString: (v) => String(v).replace(/\\/g, "\\\\").replace(/'/g, "\\'"),
    sfQuery: async (soql) => {
      ctx.soqlSeen.push(soql);
      return ctx.customerRows;
    },
    getSalesforceToken: async () => ({
      access_token: "sf-token",
      instance_url: "https://sf.example.com",
    }),
  },
});

mock.module("../../lib/identity.js", {
  exports: {
    resolveIdentity: async () => {
      if (ctx.identityError) throw ctx.identityError;
      return ctx.identity;
    },
  },
});

mock.module("../../lib/secrets.js", {
  exports: {
    getSecret: async () => ({
      base_url: "https://api.aurorasolar.com/v1",
      tenant_id: "aurora-tenant-uuid",
      api_key: "aurora-key",
    }),
  },
});

mock.module("../../lib/email.js", {
  exports: {
    isEmailConfigured: () => ctx.emailConfigured,
    sendEmail: async (msg) => {
      ctx.emailsSent.push(msg);
      return ctx.emailResult;
    },
  },
});

// --- global fetch mock (Salesforce describe/PATCH + Aurora create/consumption) --
function jsonRes(status, obj) {
  const text = JSON.stringify(obj);
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => JSON.parse(text),
    text: async () => text,
  };
}

globalThis.fetch = async (url, opts = {}) => {
  const method = opts.method || "GET";
  const body = opts.body ? JSON.parse(opts.body) : null;
  ctx.fetchCalls.push({ method, url: String(url), body });

  if (String(url).endsWith("/describe")) {
    const fields = ctx.omitTrackingField
      ? DESCRIBE_FIELDS.filter((f) => f.name !== "Design_Request_Email_Sent__c")
      : DESCRIBE_FIELDS;
    return jsonRes(200, { fields });
  }
  if (String(url).includes("/consumption_profile")) {
    return jsonRes(200, {});
  }
  if (String(url).includes("/projects") && method === "POST") {
    if (ctx.auroraCreateStatus !== 200) {
      return jsonRes(ctx.auroraCreateStatus, {
        errors: [{ message: "aurora said no" }],
      });
    }
    return jsonRes(200, { project: { id: "aurora-project-abc" } });
  }
  if (method === "PATCH") {
    return { ok: true, status: 204, json: async () => ({}), text: async () => "" };
  }
  throw new Error(`unexpected fetch: ${method} ${url}`);
};

// Import AFTER the mocks are registered so the handler binds to them.
const { handler } = await import("./index.js");

// --- helpers ----------------------------------------------------------------
function designRequestEvent(recordId = CUSTOMER_ID) {
  return {
    requestContext: { http: { method: "POST" } },
    rawPath: `/customers/${recordId}/design-request/submit`,
    pathParameters: { recordId },
    headers: { authorization: "Bearer test.jwt", origin: "http://localhost:5173" },
    body: null,
  };
}

const parse = (res) => JSON.parse(res.body);
const auroraCreateCall = () =>
  ctx.fetchCalls.find(
    (c) => c.method === "POST" && c.url.includes("/projects") && !c.url.includes("consumption")
  );
const patchCall = () => ctx.fetchCalls.find((c) => c.method === "PATCH");
const patchCalls = () => ctx.fetchCalls.filter((c) => c.method === "PATCH");
// The PATCH that stamps "the design manager was actually notified".
const trackingPatch = () =>
  patchCalls().find((c) => c.body && "Design_Request_Email_Sent__c" in c.body);

// ============================================================================

test("happy path: creates the Aurora project, writes back, and emails the manager", async () => {
  resetCtx();
  ctx.customerRows = [fullCustomer()];

  const res = await handler(designRequestEvent());
  const body = parse(res);

  assert.equal(res.statusCode, 200);
  assert.equal(body.status, "pushed");
  assert.equal(body.auroraProjectId, "aurora-project-abc");
  assert.equal(body.recordId, CUSTOMER_ID);
  assert.equal(body.consumption, "sent");

  // The read is tenant-scoped on Sundial_Customer__c — no Solar object anywhere.
  const soql = ctx.soqlSeen.at(-1);
  assert.match(soql, /FROM Sundial_Customer__c/);
  assert.match(soql, /Client__c = 'a0XharmonTENANT'/);
  assert.doesNotMatch(soql, /Sundial_Solar__c/);
  // Design Request fields are selected...
  assert.match(soql, /Project_Type__c/);
  assert.match(soql, /Financing_Partner__c/);
  // ...but a field the org does not have is dropped rather than breaking the query.
  assert.doesNotMatch(soql, /Design_Notes__c/);

  // Aurora gets ONLY what its project-create API accepts.
  const create = auroraCreateCall();
  assert.deepEqual(Object.keys(create.body.project).sort(), [
    "customer_email",
    "customer_first_name",
    "customer_last_name",
    "customer_phone",
    "external_provider_id",
    "location",
    "name",
    "status",
  ]);
  assert.equal(create.body.project.external_provider_id, CUSTOMER_ID);
  assert.equal(
    create.body.project.location.property_address,
    "1234 E Palm Ln, Mesa, AZ 85201, US"
  );

  // Consumption profile carries the ordered Jan..Dec array.
  const cons = ctx.fetchCalls.find((c) => c.url.includes("/consumption_profile"));
  assert.equal(cons.method, "PUT");
  assert.equal(cons.body.consumption_profile.monthly_energy.length, 12);
  assert.equal(cons.body.consumption_profile.monthly_energy[0], 950);

  // Write-back: Sent_to_Aurora__c is a DATETIME, so an ISO timestamp (not `true`).
  const patch = patchCall();
  assert.equal(patch.body.Aurora_Project_ID__c, "aurora-project-abc");
  assert.match(patch.body.Sent_to_Aurora__c, /^\d{4}-\d{2}-\d{2}T/);

  // A successful notification is recorded on its own field, separately from
  // Sent_to_Aurora__c — that split is what keeps re-sends possible.
  const stamp = trackingPatch();
  assert.ok(stamp, "must stamp Design_Request_Email_Sent__c");
  assert.match(stamp.body.Design_Request_Email_Sent__c, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(body.email.resend, undefined, "a first submit is not a resend");

  // Email sent, with every Design Request field Aurora could not take.
  assert.equal(body.email.sent, true);
  assert.equal(ctx.emailsSent.length, 1);
  const msg = ctx.emailsSent[0];
  assert.deepEqual(msg.to, ["design.manager@harmonelectric.net"]);
  assert.match(msg.subject, /Design Request \(Within 2 Hours\) — Jane Homeowner — Mesa, AZ/);
  for (const expected of [
    "Battery and Solar",              // Project_Type__c
    "Existing Solar System: Yes",     // boolean formatting
    "Existing Panel Count: 12",
    "Qcells - Q.TRON BLK M-G2.H1+/AC 430",
    "Enphase IQ8 Plus",
    "Tesla Powerwall 3",
    "For-Profit PPW: 3.15",
    "Annual Usage (kWh): 14250",
    "Salt River Project",
    "Proposed Panel Count: 28",
    "Offset Requested: 110%",
    "Financing Type: Loan",
    "Financing Partner: GoodLeap",
    "Term: 20yr, 25yr",               // multipicklist formatting
    "APR: 6.99%",                     // percent formatting
    "Aurora Project ID: aurora-project-abc",
  ]) {
    assert.ok(msg.text.includes(expected), `email text missing: ${expected}`);
  }
  // Appointment rendered in Phoenix local time (22:30 UTC -> 3:30 PM MST).
  assert.match(msg.text, /Appointment: Aug 11, 2026, 3:30 PM/);
  // The absent field produces no row at all.
  assert.ok(!msg.text.includes("Design Notes"));
  assert.ok(msg.html.includes("<table"));
});

test("re-submit after a SUCCESSFUL notification: no second project, no second email", async () => {
  resetCtx();
  ctx.customerRows = [
    fullCustomer({
      Sent_to_Aurora__c: "2026-08-01T17:04:00.000+0000",
      Aurora_Project_ID__c: "aurora-project-original",
      Design_Request_Email_Sent__c: "2026-08-01T17:04:09.000+0000",
    }),
  ];

  const res = await handler(designRequestEvent());
  const body = parse(res);

  assert.equal(res.statusCode, 200);
  assert.equal(body.status, "already_pushed");
  assert.equal(body.auroraProjectId, "aurora-project-original");
  assert.equal(body.sentToAurora, "2026-08-01T17:04:00.000+0000");
  assert.equal(body.notifiedAt, "2026-08-01T17:04:09.000+0000");
  assert.equal(body.email.sent, false);
  assert.equal(body.email.reason, "already_submitted");

  assert.equal(auroraCreateCall(), undefined, "must not call Aurora create");
  assert.equal(patchCall(), undefined, "must not re-write Salesforce");
  assert.equal(ctx.emailsSent.length, 0, "must not re-notify the design manager");
});

test("re-submit after a FAILED notification: re-sends the email, still no Aurora call", async () => {
  resetCtx();
  // Sent_to_Aurora__c stamped (project exists) but the notification never landed —
  // the exact state a first submit leaves behind when SES fails or isn't configured.
  ctx.customerRows = [
    fullCustomer({
      Sent_to_Aurora__c: "2026-08-01T17:04:00.000+0000",
      Aurora_Project_ID__c: "aurora-project-original",
      Design_Request_Email_Sent__c: null,
    }),
  ];

  const res = await handler(designRequestEvent());
  const body = parse(res);

  assert.equal(res.statusCode, 200);
  assert.equal(body.status, "already_pushed");
  assert.equal(body.auroraProjectId, "aurora-project-original");
  assert.equal(body.email.sent, true);
  assert.equal(body.email.resend, true);

  // Project creation stays once-only.
  assert.equal(auroraCreateCall(), undefined, "must not create a second project");
  assert.equal(
    ctx.fetchCalls.some((c) => c.url.includes("/consumption_profile")),
    false,
    "must not re-push consumption"
  );

  // The email carries the same full design-request payload, re-read fresh.
  assert.equal(ctx.emailsSent.length, 1);
  const msg = ctx.emailsSent[0];
  assert.ok(msg.text.includes("Battery and Solar"));
  assert.ok(msg.text.includes("Term: 20yr, 25yr"));
  assert.ok(msg.text.includes("Aurora Project ID: aurora-project-original"));

  // ...and the successful re-send is now recorded, so the NEXT re-submit won't.
  const stamp = trackingPatch();
  assert.ok(stamp, "must stamp Design_Request_Email_Sent__c");
  assert.match(stamp.body.Design_Request_Email_Sent__c, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(
    patchCalls().some((c) => c.body && "Sent_to_Aurora__c" in c.body),
    false,
    "must not re-stamp Sent_to_Aurora__c"
  );
});

test("re-submit after a failed notification that fails AGAIN stays re-sendable", async () => {
  resetCtx();
  ctx.emailResult = { ok: false, error: "MessageRejected" };
  ctx.customerRows = [
    fullCustomer({
      Sent_to_Aurora__c: "2026-08-01T17:04:00.000+0000",
      Aurora_Project_ID__c: "aurora-project-original",
    }),
  ];

  const body = parse(await handler(designRequestEvent()));
  assert.equal(body.status, "already_pushed");
  assert.equal(body.email.sent, false);
  assert.equal(body.email.resend, true);
  assert.equal(body.email.reason, "MessageRejected");
  // Nothing stamped -> the door stays open for another attempt.
  assert.equal(trackingPatch(), undefined);
});

test("idempotent re-submit: Sent_to_Aurora__c set but no project id -> still no create", async () => {
  resetCtx();
  ctx.customerRows = [
    fullCustomer({
      Sent_to_Aurora__c: "2026-08-01T17:04:00.000+0000",
      Design_Request_Email_Sent__c: "2026-08-01T17:04:09.000+0000",
    }),
  ];

  const body = parse(await handler(designRequestEvent()));
  assert.equal(body.status, "already_pushed");
  assert.equal(body.auroraProjectId, null);
  assert.equal(auroraCreateCall(), undefined);
});

test("missing customer -> 404 RECORD_NOT_FOUND, nothing sent anywhere", async () => {
  resetCtx();
  ctx.customerRows = []; // no such record

  const res = await handler(designRequestEvent());
  const body = parse(res);

  assert.equal(res.statusCode, 404);
  assert.equal(body.code, "RECORD_NOT_FOUND");
  assert.equal(auroraCreateCall(), undefined);
  assert.equal(ctx.emailsSent.length, 0);
});

test("cross-tenant id -> 404, and the SELECT was scoped to the CALLER's tenant", async () => {
  resetCtx();
  // The record exists in another tenant, so the tenant-scoped SELECT returns nothing.
  ctx.identity = { tenantId: "a0XotherTENANT", tenantSlug: "other" };
  ctx.customerRows = [];

  const res = await handler(designRequestEvent());
  const body = parse(res);

  assert.equal(res.statusCode, 404);
  assert.equal(body.code, "RECORD_NOT_FOUND");
  // Cross-tenant and not-found are deliberately indistinguishable.
  assert.equal(body.error, "not_found");
  assert.match(ctx.soqlSeen.at(-1), /Client__c = 'a0XotherTENANT'/);
  assert.equal(auroraCreateCall(), undefined);
  assert.equal(ctx.emailsSent.length, 0);
});

test("no tenant on the identity -> 403 NO_TENANT before any Salesforce read", async () => {
  resetCtx();
  ctx.identity = { tenantId: null, tenantSlug: null };

  const res = await handler(designRequestEvent());
  assert.equal(res.statusCode, 403);
  assert.equal(parse(res).code, "NO_TENANT");
  assert.equal(ctx.soqlSeen.length, 0);
});

test("bad record id in the path -> 400 INVALID_RECORD_ID", async () => {
  resetCtx();
  const res = await handler(designRequestEvent("not-an-id"));
  assert.equal(res.statusCode, 400);
  assert.equal(parse(res).code, "INVALID_RECORD_ID");
  assert.equal(ctx.soqlSeen.length, 0);
});

test("DESIGN_REQUEST_NOTIFY_CC set -> Cc included", async () => {
  resetCtx();
  process.env.DESIGN_REQUEST_NOTIFY_CC = "director@harmonelectric.net";
  ctx.customerRows = [fullCustomer()];

  const body = parse(await handler(designRequestEvent()));
  assert.equal(body.email.sent, true);
  assert.deepEqual(body.email.recipients, { to: 1, cc: 1 });
  assert.deepEqual(ctx.emailsSent[0].cc, ["director@harmonelectric.net"]);
});

test("DESIGN_REQUEST_NOTIFY_CC unset -> no cc key at all (no empty Cc header)", async () => {
  resetCtx(); // resetCtx deletes the CC var
  ctx.customerRows = [fullCustomer()];

  const body = parse(await handler(designRequestEvent()));
  assert.equal(body.email.sent, true);
  assert.deepEqual(body.email.recipients, { to: 1, cc: 0 });
  assert.equal("cc" in ctx.emailsSent[0], false);
});

test("multiple recipients: TO and CC accept comma/semicolon lists", async () => {
  resetCtx();
  process.env.DESIGN_REQUEST_NOTIFY_TO = "a@x.com, b@x.com";
  process.env.DESIGN_REQUEST_NOTIFY_CC = "c@x.com; d@x.com";
  ctx.customerRows = [fullCustomer()];

  await handler(designRequestEvent());
  assert.deepEqual(ctx.emailsSent[0].to, ["a@x.com", "b@x.com"]);
  assert.deepEqual(ctx.emailsSent[0].cc, ["c@x.com", "d@x.com"]);
});

test("DESIGN_REQUEST_NOTIFY_TO unset -> push still succeeds, email reports why", async () => {
  resetCtx();
  delete process.env.DESIGN_REQUEST_NOTIFY_TO;
  ctx.customerRows = [fullCustomer()];

  const body = parse(await handler(designRequestEvent()));
  assert.equal(body.status, "pushed"); // the Aurora push is never held hostage by email
  assert.equal(body.email.sent, false);
  assert.equal(body.email.reason, "no_recipient_configured");
  assert.equal(ctx.emailsSent.length, 0);
  // Nothing stamped, so once the env vars land a re-submit delivers the request.
  assert.equal(trackingPatch(), undefined);
});

test("SES failure is non-fatal AND leaves the request re-sendable", async () => {
  resetCtx();
  ctx.emailResult = { ok: false, error: "MessageRejected" };
  ctx.customerRows = [fullCustomer()];

  const res = await handler(designRequestEvent());
  const body = parse(res);
  assert.equal(res.statusCode, 200);
  assert.equal(body.status, "pushed");
  assert.equal(body.email.sent, false);
  assert.equal(body.email.reason, "MessageRejected");
  // The Aurora id IS saved (once-only), but the notification marker is NOT — so a
  // re-submit re-sends instead of returning already_submitted forever.
  assert.ok(patchCalls().some((c) => c.body && "Sent_to_Aurora__c" in c.body));
  assert.equal(trackingPatch(), undefined);
});

test("tracking-field write failure is non-fatal (worst case: one duplicate email)", async () => {
  resetCtx();
  ctx.customerRows = [fullCustomer()];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const parsed = opts.body ? JSON.parse(opts.body) : null;
    if ((opts.method || "GET") === "PATCH" && parsed && "Design_Request_Email_Sent__c" in parsed) {
      ctx.fetchCalls.push({ method: "PATCH", url: String(url), body: parsed });
      return { ok: false, status: 400, json: async () => ({}), text: async () => "FIELD_CUSTOM_VALIDATION_EXCEPTION" };
    }
    return realFetch(url, opts);
  };
  try {
    const res = await handler(designRequestEvent());
    const body = parse(res);
    assert.equal(res.statusCode, 200);
    assert.equal(body.status, "pushed");
    assert.equal(body.email.sent, true);
    assert.equal(body.email.trackingWriteFailed, true);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("customer with no address -> 400 before Aurora is called", async () => {
  resetCtx();
  ctx.customerRows = [
    fullCustomer({ Street__c: "", City__c: "", State__c: "", Postal_Code__c: "" }),
  ];

  const res = await handler(designRequestEvent());
  assert.equal(res.statusCode, 400);
  assert.equal(parse(res).code, "MISSING_SITE_ADDRESS");
  assert.equal(auroraCreateCall(), undefined);
  assert.equal(ctx.emailsSent.length, 0);
});

test("write-back failure still notifies the design manager", async () => {
  resetCtx();
  ctx.customerRows = [fullCustomer()];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    if ((opts.method || "GET") === "PATCH") {
      ctx.fetchCalls.push({ method: "PATCH", url: String(url), body: null });
      return {
        ok: false,
        status: 400,
        json: async () => ({}),
        text: async () => '[{"message":"field not writeable"}]',
      };
    }
    return realFetch(url, opts);
  };
  try {
    const body = parse(await handler(designRequestEvent()));
    assert.equal(body.status, "pushed_writeback_failed");
    assert.equal(body.auroraProjectId, "aurora-project-abc");
    assert.equal(body.email.sent, true, "the request was submitted — still notify");
  } finally {
    globalThis.fetch = realFetch;
  }
});

// --- describe guard: the org has no Design_Request_Email_Sent__c yet -----------
// A fresh module instance (cache-busting import specifier) so it builds its own
// describe cache while the mock is serving the reduced field list. The default
// `handler` above keeps the full describe it already cached.
test("tracking field absent: works, and re-submit still re-sends rather than going silent", async (t) => {
  resetCtx();
  ctx.omitTrackingField = true;
  const { handler: noField } = await import("./index.js?variant=no-tracking-field");

  await t.test("first submit succeeds and flags that tracking is unavailable", async () => {
    resetCtx();
    ctx.omitTrackingField = true;
    ctx.customerRows = [fullCustomer()];

    const body = parse(await noField(designRequestEvent()));
    assert.equal(body.status, "pushed");
    assert.equal(body.email.sent, true);
    assert.equal(body.email.tracking, "unavailable");
    // The field isn't selected (it doesn't exist) and isn't written.
    assert.doesNotMatch(ctx.soqlSeen.at(-1), /Design_Request_Email_Sent__c/);
    assert.equal(trackingPatch(), undefined);
  });

  await t.test("re-submit re-sends (unknown delivery is treated as not delivered)", async () => {
    resetCtx();
    ctx.omitTrackingField = true;
    ctx.customerRows = [
      fullCustomer({
        Sent_to_Aurora__c: "2026-08-01T17:04:00.000+0000",
        Aurora_Project_ID__c: "aurora-project-original",
      }),
    ];

    const body = parse(await noField(designRequestEvent()));
    assert.equal(body.status, "already_pushed");
    assert.equal(body.email.sent, true);
    assert.equal(body.email.resend, true);
    assert.equal(body.email.tracking, "unavailable");
    assert.equal(auroraCreateCall(), undefined, "still never a second project");
    assert.equal(ctx.emailsSent.length, 1);
  });
});

test("the /projects design-request route is gone (a Solar id is just a customer id now)", async () => {
  resetCtx();
  ctx.customerRows = [];
  const res = await handler({
    requestContext: { http: { method: "POST" } },
    rawPath: `/projects/${CUSTOMER_ID}/design-request/submit`,
    pathParameters: {}, // no recordId: API Gateway no longer has this resource
    headers: { authorization: "Bearer test.jwt" },
    body: null,
  });
  // Falls through to the body route and is rejected — there is no Solar resolution.
  assert.equal(res.statusCode, 400);
  assert.equal(parse(res).code, "INVALID_BODY");
  assert.equal(ctx.soqlSeen.length, 0);
});
