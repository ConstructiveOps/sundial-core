// Tests for the Aurora inbound SQS worker (sundial-aurora-inbound).
//
// Run with:  npm test        (needs --experimental-test-module-mocks)
//
// Salesforce, Aurora, S3, Supabase, and email are all mocked at the module
// boundary — no network, no AWS, no Salesforce org, and no live Aurora calls.

import test from "node:test";
import assert from "node:assert/strict";
import { mock } from "node:test";

const CUSTOMER_ID = "a1P7y00000AUo6TEAT";
const PROJECT_ID = "aurora-project-uuid";
const DESIGN_ID = "design-uuid";
const AGREEMENT_ID = "agreement-uuid";
const FINANCING_ID = "financing-uuid";
const RECEIVED_AT = "2026-08-04T02:30:00.000Z"; // = 2026-08-03 19:30 in Phoenix

// --- describe fixture -------------------------------------------------------
// The five agreement-lifecycle fields do NOT exist on the org yet. `extraFields`
// lets a test pretend they've been created.
const BASE_DESCRIBE_FIELDS = [
  "Id", "Name", "First_Name__c", "Last_Name__c", "City__c", "State__c", "Client__c",
  "Aurora_Project_ID__c",
  "Proposal_Amount__c", "Contract_Price_Per_Watt__c", "Down_Payment_Amount__c",
  "Final_System_Size_kW__c", "Final_Panel_Count__c", "First_Year_kW_Production__c",
  "Contract_Signed_Date__c", "Sold_Date__c", "Loan_Term_Years__c", "Monthly_Payment__c",
  // lease/PPA financing fields — all three confirmed present on the org 2026-08-17
  "Energy_Rate__c", "Escalator__c",
].map((name) => ({ name, type: "string" }));

const PARTNER_PICKLIST = [
  "Aurora", "Cash", "Credit Human", "Enfin", "GoodLeap", "ICCU",
  "Lightreach", "Mosaic", "Other", "Sungage", "Sunlight",
];

const TRACKING_FIELDS = [
  "Aurora_Agreement_ID__c", "Aurora_Agreement_Status__c",
  "Aurora_Agreement_Status_At__c", "Aurora_Proposal_Link__c",
  "Aurora_Signed_Email_Sent__c",
];

const PARTNER_ID = "partner-uuid-1";
const OWNER_ID = "owner-user-uuid-1";
const TENANT_SF_ID = "a1W7y000007AszBEAS";

const ctx = {
  hasTrackingFields: true,
  hasDealerFields: true, // Aurora_Dealer_Name__c + Aurora_Import_Notes__c
  hasDealerLeadSource: false, // the org has no "Aurora - Third-Party Dealer" value
  hasDealerStatusValue: true, // Status__c has "Customer"
  hasDealerStageValue: true, // Stage__c has "Sold - Pending Review"
  stageValueCasing: "Sold - Pending Review", // how the ORG spells it
  customerRows: [],
  customerById: null, // rows for a SELECT ... WHERE Id = ...
  tenantRows: [{ Id: TENANT_SF_ID }],
  upserts: [], // { object, extField, extValue, fields }
  upsertResult: { ok: true, id: "a1PautoCreated0001AA", created: true },
  upsertThrows: null,
  soqlSeen: [],
  updates: [], // { object, id, fields }
  updateThrows: null,
  aurora: {}, // per-endpoint responses or Error instances
  auroraCalls: [],
  s3Puts: [],
  s3Throws: null,
  emails: [],
  cancelEmails: [],
  emailResult: { sent: true, messageId: "ses-1", recipients: { to: 1, cc: 0 } },
  downloadJobs: [], // sequence of job objects returned by fetchSignedAgreementUrl
  downloadThrows: null,
  pdfBytes: Buffer.from("%PDF-1.4 fake signed agreement"),
  downloadBytesThrows: null,
};

function baseCustomer(over = {}) {
  return {
    Id: CUSTOMER_ID,
    Name: "Jane Homeowner",
    First_Name__c: "Jane",
    Last_Name__c: "Homeowner",
    City__c: "Mesa",
    State__c: "AZ",
    Client__c: "a1W7y000007AszBEAS",
    Aurora_Project_ID__c: PROJECT_ID,
    ...over,
  };
}

function designFixture(over = {}) {
  return {
    design_id: DESIGN_ID,
    project_id: PROJECT_ID,
    external_provider_id: CUSTOMER_ID,
    system_size_stc: 12400, // Watts -> 12.4 kW
    bill_of_materials: [
      { component_type: "modules", sku: "Q.TRON-430", quantity: 28 },
      { component_type: "microinverters", sku: "IQ8", quantity: 28 },
      { component_type: "modules", sku: "Q.TRON-430-B", quantity: 3 },
    ],
    energy_production: { up_to_date: true, annual: 19850, annual_offset: "104%" },
    ...over,
  };
}

function financingFixture(over = {}) {
  return {
    id: FINANCING_ID,
    financing_option: "loans",
    system_price: 38750.5,
    loan_principal: 33750.5,
    down_payment: 5000,
    monthly_payment_first_month: 189.44,
    up_to_date: true,
    loans: [{ name: "GoodLeap 25yr", duration_months: 300 }],
    financier: { type: "integrated", provider: "goodleap", status: "approved" },
    ...over,
  };
}

// A Retrieve Project response, shaped exactly as Aurora's spec documents it
// (address components nested under `location`).
function projectFixture(over = {}) {
  return {
    id: PROJECT_ID,
    name: "Dealer Deal — 42 Mesquite Ln",
    external_provider_id: null, // dealer origination by default
    status: "active",
    project_type: "residential",
    tags: ["dealer", "q3"],
    customer_salutation: "Ms.",
    customer_first_name: "Dana",
    customer_last_name: "Dealer-Customer",
    customer_email: "dana@example.com",
    customer_phone: "480-555-0111",
    mailing_address: "PO Box 9, Mesa, AZ 85201",
    owner_id: OWNER_ID,
    team_id: "team-uuid-1",
    partner_id: PARTNER_ID,
    created_at: "2026-08-01 17:04:00 UTC",
    location: {
      property_address: "42 Mesquite Ln, Mesa, AZ 85201, USA",
      latitude: 33.4152,
      longitude: -111.8315,
      property_address_components: {
        street_address: "42 Mesquite Ln",
        city: "Mesa",
        region: "AZ",
        postal_code: "85201",
        country: "United States",
      },
    },
    ...over,
  };
}

function resetCtx() {
  ctx.hasTrackingFields = true;
  ctx.hasDealerFields = true;
  ctx.hasDealerLeadSource = false;
  ctx.hasDealerStatusValue = true;
  ctx.hasDealerStageValue = true;
  ctx.stageValueCasing = "Sold - Pending Review";
  ctx.describeExclude = [];
  ctx.customerRows = [baseCustomer()];
  ctx.customerById = null;
  ctx.tenantRows = [{ Id: TENANT_SF_ID }];
  ctx.upserts = [];
  ctx.upsertResult = { ok: true, id: "a1PautoCreated0001AA", created: true };
  ctx.upsertThrows = null;
  ctx.soqlSeen = [];
  ctx.updates = [];
  ctx.updateThrows = null;
  ctx.auroraCalls = [];
  ctx.aurora = {
    agreement: { id: AGREEMENT_ID, status: "signed", signing_provider: "docusign" },
    design: designFixture(),
    proposal: { id: "prop-1", proposal_link: "https://app.aurorasolar.com/proposals/abc" },
    financing: financingFixture(),
    project: projectFixture(),
    partners: [{ id: PARTNER_ID, name: "Sunny Solar Group" }],
    user: { id: OWNER_ID, first_name: "Owen", last_name: "Owner" },
  };
  ctx.s3Puts = [];
  ctx.s3Throws = null;
  ctx.emails = [];
  ctx.cancelEmails = [];
  ctx.emailResult = { sent: true, messageId: "ses-1", recipients: { to: 1, cc: 0 } };
  ctx.downloadThrows = null;
  ctx.downloadBytesThrows = null;
}

// --- mocks ------------------------------------------------------------------
class FakeAuroraError extends Error {
  constructor(message, { status, notProvisioned, endpoint } = {}) {
    super(message);
    this.name = "AuroraError";
    this.status = status ?? null;
    this.notProvisioned = !!notProvisioned;
    this.endpoint = endpoint ?? null;
  }
}

mock.module("../../lib/salesforce.js", {
  exports: {
    soqlEscapeString: (v) => String(v).replace(/\\/g, "\\\\").replace(/'/g, "\\'"),
    sfQuery: async (soql) => {
      ctx.soqlSeen.push(soql);
      if (/FROM Sundial_Tenant__c/.test(soql)) return ctx.tenantRows;
      // A lookup by Id (provider-id resolution or the post-create re-read) is a
      // different question from "who owns this Aurora project id".
      if (/WHERE Id = /.test(soql)) return ctx.customerById ? [ctx.customerById] : [];
      return ctx.customerRows;
    },
    sfUpdateRecord: async (object, id, fields) => {
      if (ctx.updateThrows) throw new Error(ctx.updateThrows);
      ctx.updates.push({ object, id, fields });
      return { ok: true, id };
    },
    sfUpsertRecord: async (object, extField, extValue, fields) => {
      if (ctx.upsertThrows) throw ctx.upsertThrows;
      ctx.upserts.push({ object, extField, extValue, fields });
      return ctx.upsertResult;
    },
    describeObject: async () => ({
      fields: [
        ...BASE_DESCRIBE_FIELDS,
        { name: "Financing_Type__c", type: "picklist",
          picklistValues: [{ value: "Cash" }, { value: "Loan" }, { value: "Lease" }] },
        { name: "Financing_Partner__c", type: "picklist",
          picklistValues: PARTNER_PICKLIST.map((v) => ({ value: v })) },
        // Real org values: note "Il" (the org's own typo) — matching must be
        // case-insensitive and must write the org's canonical casing.
        { name: "State__c", type: "picklist",
          picklistValues: ["AZ", "CA", "Il", "NV", "TX"].map((v) => ({ value: v })) },
        { name: "Lead_Source__c", type: "picklist",
          picklistValues: [
            { value: "Referral" },
            { value: "Web" },
            ...(ctx.hasDealerLeadSource ? [{ value: "Aurora - Third-Party Dealer" }] : []),
          ] },
        // Status__c defaults to "Lead" in the real org — that's why the import
        // sets it explicitly.
        { name: "Status__c", type: "picklist",
          picklistValues: [
            { value: "Lead" },
            { value: "Opportunity" },
            ...(ctx.hasDealerStatusValue ? [{ value: "Customer" }] : []),
            { value: "Past Customer" },
          ] },
        { name: "Stage__c", type: "picklist",
          picklistValues: [
            { value: "New" },
            { value: "Proposal Complete" },
            ...(ctx.hasDealerStageValue ? [{ value: ctx.stageValueCasing }] : []),
            { value: "Sold" },
          ] },
        { name: "Primary_Email__c", type: "email" },
        { name: "Primary_Phone__c", type: "phone" },
        { name: "Street__c", type: "string" },
        { name: "Postal_Code__c", type: "string" },
        { name: "Active__c", type: "boolean" },
        ...(ctx.hasDealerFields
          ? [
              { name: "Aurora_Dealer_Name__c", type: "string" },
              { name: "Aurora_Import_Notes__c", type: "textarea" },
            ]
          : []),
        ...(ctx.hasTrackingFields
          ? TRACKING_FIELDS.map((name) => ({ name, type: "string" }))
          : []),
      ].filter(
        // ctx.describeExclude lets a test pretend the org is missing any field,
        // to exercise the describe guard on fields that DO exist today.
        (f) =>
          !(ctx.describeExclude || []).some(
            (n) => String(n).toLowerCase() === f.name.toLowerCase()
          )
      ),
    }),
  },
});

const takeOrThrow = (key) => {
  const v = ctx.aurora[key];
  ctx.auroraCalls.push(key);
  if (v instanceof Error) throw v;
  return v;
};

mock.module("../../lib/aurora.js", {
  exports: {
    AuroraError: FakeAuroraError,
    getAgreement: async () => takeOrThrow("agreement"),
    getDesignSummary: async () => takeOrThrow("design"),
    getDefaultProposal: async () => takeOrThrow("proposal"),
    getFinancing: async () => takeOrThrow("financing"),
    getProject: async () => takeOrThrow("project"),
    listPartners: async () => takeOrThrow("partners"),
    getUser: async () => takeOrThrow("user"),
    fetchSignedAgreementUrl: async () => {
      ctx.auroraCalls.push("download_url");
      if (ctx.downloadThrows) throw ctx.downloadThrows;
      return { fileUrl: "https://files.aurora/signed.pdf?sig=x", jobId: "job-1" };
    },
    downloadSignedAgreement: async () => {
      ctx.auroraCalls.push("download_bytes");
      if (ctx.downloadBytesThrows) throw ctx.downloadBytesThrows;
      return ctx.pdfBytes;
    },
  },
});

mock.module("../../lib/supabase.js", {
  exports: {
    getSupabaseClient: async () => ({
      from: () => ({
        insert: () => ({ select: () => ({ maybeSingle: async () => ({ data: { id: "m" }, error: null }) }) }),
      }),
    }),
  },
});

mock.module("@aws-sdk/client-s3", {
  exports: {
    S3Client: class {
      async send(cmd) {
        if (ctx.s3Throws) throw new Error(ctx.s3Throws);
        ctx.s3Puts.push(cmd.input);
        return {};
      }
    },
    PutObjectCommand: class {
      constructor(input) { this.input = input; }
    },
    // lib/file-access.js imports these from the same module; mocking the module
    // replaces ALL of its exports, so they have to be present or the import fails.
    ListObjectsV2Command: class {
      constructor(input) { this.input = input; }
    },
    CopyObjectCommand: class {
      constructor(input) { this.input = input; }
    },
  },
});

mock.module("./notify.js", {
  exports: {
    sendSignedNotification: async (args) => {
      ctx.emails.push(args);
      return ctx.emailResult;
    },
    sendCancellationNotification: async (args) => {
      ctx.cancelEmails.push(args);
      return ctx.emailResult;
    },
    resolveNotifyRecipients: () => ({ to: ["design@x.com"], cc: [] }),
    buildSignedEmail: () => ({ subject: "s", text: "t", html: "h" }),
    buildCancellationEmail: () => ({ subject: "s", text: "t", html: "h" }),
  },
});

const { handler } = await import("./index.js");
// Imported after the mocks so it binds to them. Its tenant/partner caches are
// module-scope, so they must be cleared between tests.
const { resetTenantCache, resetPartnersCache } = await import("./customerCreate.js");

// --- helpers ----------------------------------------------------------------
function sqsEvent(over = {}, messageId = "m1") {
  return {
    Records: [
      {
        messageId,
        body: JSON.stringify({
          source: "aurora.agreement_status_changed",
          project_id: PROJECT_ID,
          design_id: DESIGN_ID,
          agreement_id: AGREEMENT_ID,
          financing_id: FINANCING_ID,
          status: "signed",
          received_at: RECEIVED_AT,
          ...over,
        }),
      },
    ],
  };
}

const fieldUpdates = () => ctx.updates.map((u) => u.fields);
const mergedFields = () => Object.assign({}, ...fieldUpdates());

// Put the worker in the "no customer carries this Aurora project id" state, which
// is what a dealer-originated deal looks like.
function unmatched() {
  ctx.customerRows = []; // the Aurora_Project_ID__c lookup finds nothing
  // A dealer-originated design carries no provider id either — it was never
  // created from a Sundial design request.
  ctx.aurora.design = designFixture({ external_provider_id: null });
  resetTenantCache();
  resetPartnersCache();
}
const createdCustomer = (over = {}) =>
  baseCustomer({
    Id: "a1PautoCreated0001AA",
    Name: "Dana Dealer-Customer",
    First_Name__c: "Dana",
    Last_Name__c: "Dealer-Customer",
    Aurora_Project_ID__c: PROJECT_ID,
    ...over,
  });

// ============================================================================

test("signed happy path: all four retrievals, field write-back, PDF, and email", async () => {
  resetCtx();
  const res = await handler(sqsEvent());

  assert.deepEqual(res.batchItemFailures, [], "nothing should fail");

  // a) all four Aurora retrievals happened
  for (const call of ["agreement", "design", "proposal", "financing"]) {
    assert.ok(ctx.auroraCalls.includes(call), `missing Aurora call: ${call}`);
  }

  // b) field mapping written to the CUSTOMER (never a solar record)
  assert.ok(ctx.updates.length > 0);
  for (const u of ctx.updates) assert.equal(u.object, "Sundial_Customer__c");
  for (const u of ctx.updates) assert.equal(u.id, CUSTOMER_ID);
  const f = mergedFields();

  assert.equal(f.Proposal_Amount__c, 38750.5);
  // 38750.50 / 12400 W = 3.125 -> 2dp
  assert.equal(f.Contract_Price_Per_Watt__c, 3.13);
  assert.equal(f.Financing_Type__c, "Loan");          // loans -> Loan
  assert.equal(f.Financing_Partner__c, "GoodLeap");   // "goodleap" -> picklist casing
  assert.equal(f.Down_Payment_Amount__c, 5000);
  assert.equal(f.Final_System_Size_kW__c, 12.4);      // 12400 W -> kW
  assert.equal(f.Final_Panel_Count__c, 31);           // 28 + 3 modules only
  assert.equal(f.First_Year_kW_Production__c, 19850); // kWh despite the field name
  assert.equal(f.Loan_Term_Years__c, 25);             // 300 months
  assert.equal(f.Monthly_Payment__c, 189.44);
  assert.equal(f.Aurora_Proposal_Link__c, "https://app.aurorasolar.com/proposals/abc");
  // DATE fields use Harmon LOCAL time: 02:30 UTC is still Aug 3 in Phoenix.
  assert.equal(f.Contract_Signed_Date__c, "2026-08-03");
  assert.equal(f.Sold_Date__c, "2026-08-03");
  assert.equal(f.Aurora_Agreement_Status__c, "signed");
  assert.equal(f.Aurora_Agreement_ID__c, AGREEMENT_ID);

  // c) PDF stored under the CUSTOMER's folder with a deterministic name
  assert.equal(ctx.s3Puts.length, 1);
  assert.equal(ctx.s3Puts[0].Bucket, "sfsolproj");
  assert.equal(ctx.s3Puts[0].Key, `SUNDIAL/${CUSTOMER_ID}/${AGREEMENT_ID}-signed-agreement.pdf`);
  assert.equal(ctx.s3Puts[0].ContentType, "application/pdf");

  // d) email sent once, and the completion marker stamped
  assert.equal(ctx.emails.length, 1);
  assert.equal(ctx.emails[0].pdfKey, ctx.s3Puts[0].Key);
  assert.ok(f.Aurora_Signed_Email_Sent__c, "email marker must be stamped after a send");

  // no Sundial_Solar__c anywhere
  assert.ok(!JSON.stringify(ctx.updates).includes("Sundial_Solar__c"));
  assert.ok(!ctx.soqlSeen.join(" ").includes("Sundial_Solar__c"));
});

// --- lease/PPA financing fields (2026-08-17) --------------------------------
// solar_rate/escalation/monthly_payment are LEASE/PPA-ONLY in Aurora's response.

function leaseFinancingFixture(over = {}) {
  return {
    id: FINANCING_ID,
    financing_option: "lease",
    system_price: 38750.5,
    monthly_payment: 142.75,
    solar_rate: 0.1425,
    escalation: 2.9,
    epc_price_per_watt: 3.1,
    upfront_payment: 1500, // deliberately NOT mapped
    up_to_date: true,
    financier: { type: "integrated", provider: "lightreach" },
    ...over,
  };
}

test("lease: solar_rate, escalation and monthly_payment are written", async () => {
  resetCtx();
  ctx.aurora.financing = leaseFinancingFixture();
  const res = await handler(sqsEvent());

  assert.deepEqual(res.batchItemFailures, []);
  const f = mergedFields();
  assert.equal(f.Energy_Rate__c, 0.1425);
  assert.equal(f.Escalator__c, 2.9);
  assert.equal(f.Monthly_Payment__c, 142.75);
  assert.equal(f.Financing_Type__c, "Lease");
  assert.equal(f.Financing_Partner__c, "Lightreach");

  // Contract PPW is still derived from system_price / watts, NOT epc_price_per_watt.
  assert.equal(f.Contract_Price_Per_Watt__c, 3.13);
  // The $/kWh rate must never be confused with the $/W metric.
  assert.equal(f.Solar_Price_per_Watt__c, undefined);
  // Loan-only fields stay absent on a lease.
  assert.equal(f.Down_Payment_Amount__c, undefined);
  assert.equal(f.Loan_Term_Years__c, undefined);
});

test("upfront_payment is deliberately ignored, including as a down payment", async () => {
  resetCtx();
  ctx.aurora.financing = leaseFinancingFixture({ upfront_payment: 1500 });
  await handler(sqsEvent());

  const f = mergedFields();
  assert.equal(f.Down_Payment_Amount__c, undefined, "upfront_payment must not become a down payment");
  assert.ok(
    !Object.values(f).includes(1500),
    "no field should carry the upfront_payment value until its meaning is proven"
  );
});

test("a loan financing writes none of the lease/PPA fields", async () => {
  resetCtx(); // default fixture is a loan
  await handler(sqsEvent());

  const f = mergedFields();
  assert.equal(f.Energy_Rate__c, undefined);
  assert.equal(f.Escalator__c, undefined);
  assert.equal(f.Monthly_Payment__c, 189.44); // from monthly_payment_first_month
});

test("lease with the fields absent from the response writes nothing for them", async () => {
  resetCtx();
  ctx.aurora.financing = leaseFinancingFixture({
    solar_rate: undefined, escalation: undefined, monthly_payment: undefined,
  });
  await handler(sqsEvent());

  const f = mergedFields();
  assert.equal(f.Energy_Rate__c, undefined);
  assert.equal(f.Escalator__c, undefined);
  assert.equal(f.Monthly_Payment__c, undefined);
  // A partial response must not blank out the rest of the mapping.
  assert.equal(f.Proposal_Amount__c, 38750.5);
});

test("a fraction-looking escalation is written but flagged for verification", async () => {
  resetCtx();
  ctx.aurora.financing = leaseFinancingFixture({ escalation: 0.029 });
  await handler(sqsEvent());

  const f = mergedFields();
  assert.equal(f.Escalator__c, 0.029, "value passes through unconverted — we never guess a x100");
  const warnings = ctx.emails[0].warnings.join(" ");
  assert.match(warnings, /looks like a fraction rather than a percentage/);
});

test("a normal percentage escalation raises no warning", async () => {
  resetCtx();
  ctx.aurora.financing = leaseFinancingFixture({ escalation: 1.9 });
  await handler(sqsEvent());

  const warnings = ctx.emails[0].warnings.join(" ");
  assert.ok(!/fraction rather than a percentage/.test(warnings));
});

test("ppa still gets the financing fields even though Financing_Type__c can't map", async () => {
  resetCtx();
  ctx.aurora.financing = leaseFinancingFixture({ financing_option: "ppa" });
  await handler(sqsEvent());

  const f = mergedFields();
  // A PPA has no Financing_Type__c picklist match (reported, never guessed into
  // "Lease") — but the money fields are still real and must still land.
  assert.equal(f.Financing_Type__c, undefined);
  assert.equal(f.Energy_Rate__c, 0.1425);
  assert.equal(f.Escalator__c, 2.9);
  assert.equal(f.Monthly_Payment__c, 142.75);
});

test("lease/PPA fields missing from the org are dropped and reported, not fatal", async () => {
  resetCtx();
  ctx.aurora.financing = leaseFinancingFixture();
  ctx.describeExclude = ["Energy_Rate__c", "Escalator__c"];
  const res = await handler(sqsEvent());

  assert.deepEqual(res.batchItemFailures, [], "a missing field must never fail the event");
  const f = mergedFields();
  assert.equal(f.Energy_Rate__c, undefined);
  assert.equal(f.Escalator__c, undefined);
  assert.equal(f.Monthly_Payment__c, 142.75, "the present field still lands");

  const warnings = ctx.emails[0].warnings.join(" ");
  assert.match(warnings, /Energy_Rate__c/);
  assert.match(warnings, /Escalator__c/);
});

test("signed on an EXISTING matched customer sets Status/Stage too", async () => {
  resetCtx();
  const res = await handler(sqsEvent());

  assert.deepEqual(res.batchItemFailures, []);
  const f = mergedFields();
  // Aurora `signed` means exactly this in Sundial — Harmon's SF alerts key off it.
  assert.equal(f.Status__c, "Customer");
  assert.equal(f.Stage__c, "Sold - Pending Review");
  assert.equal(f.Aurora_Agreement_Status__c, "signed");
  assert.equal(ctx.upserts.length, 0, "an existing customer is updated, not re-created");
});

test("the REPAIRED-link path also gets Status/Stage", async () => {
  resetCtx();
  unmatched();
  ctx.aurora.project = projectFixture({ external_provider_id: CUSTOMER_ID });
  ctx.customerById = baseCustomer({ Aurora_Project_ID__c: null });

  await handler(sqsEvent());
  const f = mergedFields();
  assert.equal(f.Status__c, "Customer");
  assert.equal(f.Stage__c, "Sold - Pending Review");
});

test("matched + signed with Status/Stage values missing from the org -> skipped and warned", async () => {
  resetCtx();
  ctx.hasDealerStatusValue = false;
  ctx.hasDealerStageValue = false;

  const res = await handler(sqsEvent());
  assert.deepEqual(res.batchItemFailures, [], "a renamed picklist must not fail a signed contract");
  const f = mergedFields();
  assert.equal(f.Status__c, undefined);
  assert.equal(f.Stage__c, undefined);
  // The warning has to say the alerts won't fire — that's the real consequence.
  const warnings = ctx.emails[0].warnings.join(" ");
  assert.match(warnings, /Stage__c has no "Sold - Pending Review" value/);
  assert.match(warnings, /alerts key off this Stage/);
});

test("NON-signed statuses never touch Status/Stage", async () => {
  resetCtx();
  for (const status of ["sent", "viewed"]) {
    ctx.updates = [];
    await handler(sqsEvent({ status }));
    const f = mergedFields();
    assert.equal(f.Status__c, undefined, `${status} must not move the pipeline`);
    assert.equal(f.Stage__c, undefined);
  }
});

test("a confirmed cancellation does not set Status/Stage", async () => {
  resetCtx();
  ctx.customerRows = [
    baseCustomer({ Aurora_Agreement_ID__c: AGREEMENT_ID, Aurora_Agreement_Status__c: "signed" }),
  ];
  ctx.aurora.agreement = { id: AGREEMENT_ID, status: "canceled" };

  await handler(sqsEvent({ status: "canceled" }));
  const f = mergedFields();
  assert.equal(f.Aurora_Agreement_Status__c, "canceled");
  assert.equal(f.Status__c, undefined, "a dead contract must not be promoted");
  assert.equal(f.Stage__c, undefined);
});

test("a signed event Aurora contradicts does not set Status/Stage", async () => {
  resetCtx();
  ctx.aurora.agreement = { id: AGREEMENT_ID, status: "canceled" };

  await handler(sqsEvent());
  const f = mergedFields();
  assert.equal(f.Status__c, undefined);
  assert.equal(f.Stage__c, undefined);
});

test("empty FINANCING_ID: financing call skipped entirely, rest still written", async () => {
  resetCtx();
  const res = await handler(sqsEvent({ financing_id: null }));

  assert.deepEqual(res.batchItemFailures, []);
  assert.ok(!ctx.auroraCalls.includes("financing"), "must not call the financing endpoint");

  const f = mergedFields();
  // Design-derived values still land...
  assert.equal(f.Final_System_Size_kW__c, 12.4);
  assert.equal(f.Final_Panel_Count__c, 31);
  // ...but nothing financing-derived is invented.
  assert.equal(f.Proposal_Amount__c, undefined);
  assert.equal(f.Financing_Type__c, undefined);
  assert.equal(f.Monthly_Payment__c, undefined);

  const warnings = ctx.emails[0].warnings.join(" ");
  assert.match(warnings, /No financing was selected/i);
});

test("duplicate signed event no-ops (no re-write, no re-download, no second email)", async () => {
  resetCtx();
  ctx.customerRows = [
    baseCustomer({
      Aurora_Agreement_ID__c: AGREEMENT_ID,
      Aurora_Agreement_Status__c: "signed",
      Aurora_Signed_Email_Sent__c: "2026-08-04T02:31:00.000Z",
    }),
  ];

  const res = await handler(sqsEvent());
  assert.deepEqual(res.batchItemFailures, []);
  assert.equal(ctx.auroraCalls.length, 0, "no Aurora calls at all");
  assert.equal(ctx.updates.length, 0, "no Salesforce writes");
  assert.equal(ctx.s3Puts.length, 0, "no PDF re-upload");
  assert.equal(ctx.emails.length, 0, "no second notification");
});

test("partial first run (signed recorded, email never sent) is RESUMED, not skipped", async () => {
  resetCtx();
  ctx.customerRows = [
    baseCustomer({
      Aurora_Agreement_ID__c: AGREEMENT_ID,
      Aurora_Agreement_Status__c: "signed",
      Aurora_Signed_Email_Sent__c: null, // the email never landed
    }),
  ];

  await handler(sqsEvent());
  assert.ok(ctx.auroraCalls.includes("design"), "should re-run the retrievals");
  assert.equal(ctx.s3Puts.length, 1, "PDF re-stored (same deterministic key)");
  assert.equal(ctx.emails.length, 1, "the missing notification is finally sent");
});

test("out-of-order: a late `viewed` cannot regress a `signed`", async () => {
  resetCtx();
  ctx.customerRows = [
    baseCustomer({
      Aurora_Agreement_ID__c: AGREEMENT_ID,
      Aurora_Agreement_Status__c: "signed",
      Aurora_Signed_Email_Sent__c: "2026-08-04T02:31:00.000Z",
    }),
  ];

  const res = await handler(sqsEvent({ status: "viewed" }));
  assert.deepEqual(res.batchItemFailures, []);
  assert.equal(ctx.updates.length, 0, "status must NOT be written back to viewed");
  assert.equal(ctx.auroraCalls.length, 0);
});

// --- post-signature cancellation: confirmed with Aurora, not inferred from order --

test("CONFIRMED cancellation after signing: applied over `signed`, stamped, and emailed", async () => {
  resetCtx();
  ctx.customerRows = [
    baseCustomer({
      Aurora_Agreement_ID__c: AGREEMENT_ID,
      Aurora_Agreement_Status__c: "signed",
      Aurora_Signed_Email_Sent__c: "2026-08-04T02:31:00.000Z",
    }),
  ];
  // Aurora agrees the agreement is dead.
  ctx.aurora.agreement = { id: AGREEMENT_ID, status: "canceled" };

  const res = await handler(sqsEvent({ status: "canceled" }));
  assert.deepEqual(res.batchItemFailures, []);

  // It asked Aurora rather than trusting delivery order.
  assert.ok(ctx.auroraCalls.includes("agreement"), "must re-read the agreement");

  // Precedence is bypassed: the cancellation lands even over a recorded `signed`.
  assert.equal(ctx.updates.length, 1);
  assert.deepEqual(ctx.updates[0].fields, {
    Aurora_Agreement_ID__c: AGREEMENT_ID,
    Aurora_Agreement_Status__c: "canceled",
    Aurora_Agreement_Status_At__c: RECEIVED_AT,
  });

  // And it is visible, not just recorded.
  assert.equal(ctx.cancelEmails.length, 1);
  assert.equal(ctx.cancelEmails[0].status, "canceled");
  assert.equal(ctx.cancelEmails[0].previousStatus, "signed");

  // Nothing about the signed artifacts is undone.
  assert.equal(ctx.s3Puts.length, 0);
  assert.equal(ctx.emails.length, 0);
});

test("STALE cancellation: Aurora still says signed -> dropped, nothing written or sent", async () => {
  resetCtx();
  ctx.customerRows = [
    baseCustomer({
      Aurora_Agreement_ID__c: AGREEMENT_ID,
      Aurora_Agreement_Status__c: "signed",
      Aurora_Signed_Email_Sent__c: "2026-08-04T02:31:00.000Z",
    }),
  ];
  // Out-of-order delivery: Aurora's current truth is still `signed`.
  ctx.aurora.agreement = { id: AGREEMENT_ID, status: "signed" };

  const res = await handler(sqsEvent({ status: "canceled" }));
  assert.deepEqual(res.batchItemFailures, []);

  assert.ok(ctx.auroraCalls.includes("agreement"), "must still check with Aurora");
  assert.equal(ctx.updates.length, 0, "the signed status must survive a stale event");
  assert.equal(ctx.cancelEmails.length, 0, "no false alarm to the design manager");
});

test("declined and cancel-pending take the same confirmation path", async () => {
  for (const status of ["declined", "cancel-pending"]) {
    resetCtx();
    ctx.customerRows = [
      baseCustomer({
        Aurora_Agreement_ID__c: AGREEMENT_ID,
        Aurora_Agreement_Status__c: "signed",
        Aurora_Signed_Email_Sent__c: "2026-08-04T02:31:00.000Z",
      }),
    ];
    ctx.aurora.agreement = { id: AGREEMENT_ID, status };

    await handler(sqsEvent({ status }));
    assert.equal(ctx.updates.length, 1, `${status} should apply when Aurora confirms it`);
    assert.equal(ctx.updates[0].fields.Aurora_Agreement_Status__c, status);
    assert.equal(ctx.cancelEmails.length, 1, `${status} should notify`);
  }
});

test("Aurora's value wins when it differs from the event (cancel-pending -> canceled)", async () => {
  resetCtx();
  ctx.customerRows = [
    baseCustomer({ Aurora_Agreement_ID__c: AGREEMENT_ID, Aurora_Agreement_Status__c: "signed" }),
  ];
  // The webhook says cancel-pending; Aurora has already moved on to canceled.
  ctx.aurora.agreement = { id: AGREEMENT_ID, status: "canceled" };

  await handler(sqsEvent({ status: "cancel-pending" }));
  assert.equal(ctx.updates[0].fields.Aurora_Agreement_Status__c, "canceled",
    "Aurora is the authority, not the webhook payload");
  assert.equal(ctx.cancelEmails[0].status, "canceled");
});

test("`error` is NOT treated as a cancellation (no re-read, precedence still governs)", async () => {
  resetCtx();
  ctx.customerRows = [
    baseCustomer({ Aurora_Agreement_ID__c: AGREEMENT_ID, Aurora_Agreement_Status__c: "signed" }),
  ];

  await handler(sqsEvent({ status: "error" }));
  assert.equal(ctx.auroraCalls.length, 0, "error must not trigger an agreement re-read");
  assert.equal(ctx.updates.length, 0, "and must not regress the signed status");
  assert.equal(ctx.cancelEmails.length, 0);
});

test("a duplicate cancellation does not re-read Aurora or re-notify", async () => {
  resetCtx();
  ctx.customerRows = [
    baseCustomer({ Aurora_Agreement_ID__c: AGREEMENT_ID, Aurora_Agreement_Status__c: "canceled" }),
  ];
  ctx.aurora.agreement = { id: AGREEMENT_ID, status: "canceled" };

  const res = await handler(sqsEvent({ status: "canceled" }));
  assert.deepEqual(res.batchItemFailures, []);
  assert.equal(ctx.auroraCalls.length, 0, "an exact duplicate needs no Aurora call");
  assert.equal(ctx.updates.length, 0);
  assert.equal(ctx.cancelEmails.length, 0, "the design manager is told once, not twice");
});

test("a cancellation on a NON-signed record applies and notifies without the after-signing framing", async () => {
  resetCtx();
  ctx.customerRows = [
    baseCustomer({ Aurora_Agreement_ID__c: AGREEMENT_ID, Aurora_Agreement_Status__c: "viewed" }),
  ];
  ctx.aurora.agreement = { id: AGREEMENT_ID, status: "declined" };

  await handler(sqsEvent({ status: "declined" }));
  assert.equal(ctx.updates[0].fields.Aurora_Agreement_Status__c, "declined");
  assert.equal(ctx.cancelEmails.length, 1);
  assert.equal(ctx.cancelEmails[0].previousStatus, "viewed");
});

test("cancellation email failure is non-fatal — the status still lands", async () => {
  resetCtx();
  ctx.customerRows = [
    baseCustomer({ Aurora_Agreement_ID__c: AGREEMENT_ID, Aurora_Agreement_Status__c: "signed" }),
  ];
  ctx.aurora.agreement = { id: AGREEMENT_ID, status: "canceled" };
  ctx.emailResult = { sent: false, reason: "MessageRejected" };

  const res = await handler(sqsEvent({ status: "canceled" }));
  assert.deepEqual(res.batchItemFailures, []);
  assert.equal(ctx.updates[0].fields.Aurora_Agreement_Status__c, "canceled");
});

test("cancellation still works with none of the tracking fields created", async () => {
  resetCtx();
  ctx.hasTrackingFields = false;
  ctx.aurora.agreement = { id: AGREEMENT_ID, status: "canceled" };

  const res = await handler(sqsEvent({ status: "canceled" }));
  assert.deepEqual(res.batchItemFailures, []);
  assert.equal(ctx.updates.length, 0, "nothing writable, but no crash");
  // Without a stored status there is nothing to contradict, so it still notifies.
  assert.equal(ctx.cancelEmails.length, 1);
});

test("a 403 while confirming a cancellation dead-letters rather than guessing", async () => {
  resetCtx();
  ctx.customerRows = [
    baseCustomer({ Aurora_Agreement_ID__c: AGREEMENT_ID, Aurora_Agreement_Status__c: "signed" }),
  ];
  ctx.aurora.agreement = new FakeAuroraError("not provisioned", {
    status: 403, notProvisioned: true, endpoint: "/agreements/x",
  });

  const res = await handler(sqsEvent({ status: "canceled" }));
  assert.deepEqual(res.batchItemFailures, [{ itemIdentifier: "m1" }]);
  assert.equal(ctx.updates.length, 0);
  assert.equal(ctx.cancelEmails.length, 0);
});

test("non-signed statuses update tracking state only", async () => {
  resetCtx();
  const res = await handler(sqsEvent({ status: "viewed" }));

  assert.deepEqual(res.batchItemFailures, []);
  assert.equal(ctx.auroraCalls.length, 0, "no retrievals for a non-signed status");
  assert.equal(ctx.s3Puts.length, 0);
  assert.equal(ctx.emails.length, 0);
  assert.equal(ctx.updates.length, 1);
  assert.deepEqual(ctx.updates[0].fields, {
    Aurora_Agreement_ID__c: AGREEMENT_ID,
    Aurora_Agreement_Status__c: "viewed",
    Aurora_Agreement_Status_At__c: RECEIVED_AT,
  });
});

test("duplicate non-signed status is ignored", async () => {
  resetCtx();
  ctx.customerRows = [
    baseCustomer({ Aurora_Agreement_ID__c: AGREEMENT_ID, Aurora_Agreement_Status__c: "viewed" }),
  ];
  await handler(sqsEvent({ status: "viewed" }));
  assert.equal(ctx.updates.length, 0);
});

// --- dealer origination: unmatched Aurora projects (D-049) -------------------

test("CREATE: signed + no customer + no external_provider_id -> upsert, then normal processing", async () => {
  resetCtx();
  unmatched();
  ctx.customerById = createdCustomer();

  const res = await handler(sqsEvent());
  assert.deepEqual(res.batchItemFailures, [], "a dealer sale must not dead-letter");

  // Upserted on the external id — the create is idempotent by construction.
  assert.equal(ctx.upserts.length, 1);
  const up = ctx.upserts[0];
  assert.equal(up.object, "Sundial_Customer__c");
  assert.equal(up.extField, "Aurora_Project_ID__c");
  assert.equal(up.extValue, PROJECT_ID);
  // The external id is the KEY, never a field in the body.
  assert.equal(up.fields.Aurora_Project_ID__c, undefined);

  // Full mapping, including the nested address components.
  assert.equal(up.fields.First_Name__c, "Dana");
  assert.equal(up.fields.Last_Name__c, "Dealer-Customer");
  assert.equal(up.fields.Name, "Dana Dealer-Customer");
  assert.equal(up.fields.Primary_Email__c, "dana@example.com");
  assert.equal(up.fields.Primary_Phone__c, "480-555-0111");
  assert.equal(up.fields.Street__c, "42 Mesquite Ln");
  assert.equal(up.fields.City__c, "Mesa");
  assert.equal(up.fields.Postal_Code__c, "85201");
  assert.equal(up.fields.State__c, "AZ");
  assert.equal(up.fields.Active__c, true);
  assert.equal(up.fields.Client__c, TENANT_SF_ID);
  // A closed dealer sale must not land as the org's default "Lead".
  assert.equal(up.fields.Status__c, "Customer");
  assert.equal(up.fields.Stage__c, "Sold - Pending Review");
  // Dealer resolved from partner_id via List Partners.
  assert.equal(up.fields.Aurora_Dealer_Name__c, "Sunny Solar Group");

  // Notes capture everything retrieved but not mapped.
  const notes = up.fields.Aurora_Import_Notes__c;
  assert.match(notes, /^Auto-created from Aurora signed agreement agreement-uuid on 2026-08-04T/);
  assert.match(notes, /Property address \(raw\): 42 Mesquite Ln, Mesa, AZ 85201, USA/);
  assert.match(notes, /Country: United States/);
  assert.match(notes, /Salutation: Ms\./);
  assert.match(notes, /Partner id: partner-uuid-1/);
  assert.match(notes, /Owner \(user\) id: owner-user-uuid-1/);
  assert.match(notes, /Team id: team-uuid-1/);
  assert.match(notes, /Mailing address: PO Box 9/);
  assert.match(notes, /Tags: dealer, q3/);

  // ...and then the normal signed pipeline ran on the new record.
  assert.ok(ctx.auroraCalls.includes("design"));
  assert.equal(ctx.s3Puts.length, 1);
  assert.equal(ctx.emails.length, 1);
  assert.equal(mergedFields().Proposal_Amount__c, 38750.5);
  // The email says where this record came from.
  assert.match(ctx.emails[0].warnings.join(" "), /AUTO-CREATED from a dealer-originated/);
});

test("REPAIR: signed + no customer + provider id that resolves -> link written, nothing created", async () => {
  resetCtx();
  unmatched();
  // Our own deal: the design-request write-back failed, so the customer exists but
  // carries no Aurora_Project_ID__c.
  ctx.aurora.project = projectFixture({ external_provider_id: CUSTOMER_ID });
  ctx.customerById = baseCustomer({ Aurora_Project_ID__c: null });

  const res = await handler(sqsEvent());
  assert.deepEqual(res.batchItemFailures, []);

  assert.equal(ctx.upserts.length, 0, "must NOT create — this customer already exists");
  const repair = ctx.updates.find((u) => "Aurora_Project_ID__c" in u.fields);
  assert.ok(repair, "the missing link must be written");
  assert.equal(repair.id, CUSTOMER_ID);
  assert.equal(repair.fields.Aurora_Project_ID__c, PROJECT_ID);

  // Normal signed processing continues on the repaired record.
  assert.equal(ctx.s3Puts.length, 1);
  assert.equal(ctx.emails.length, 1);
  assert.match(ctx.emails[0].warnings.join(" "), /has been repaired/);
});

test("Aurora contradicts itself (project has no provider id, design does) -> warn, don't strand", async () => {
  resetCtx();
  unmatched();
  // Project says dealer-originated; design disagrees. We already created the
  // customer by then, so dead-lettering would strand it — warn instead.
  ctx.aurora.design = designFixture({ external_provider_id: CUSTOMER_ID });
  ctx.customerById = createdCustomer();

  const res = await handler(sqsEvent());
  assert.deepEqual(res.batchItemFailures, []);
  assert.match(
    ctx.emails[0].warnings.join(" "),
    /Aurora inconsistency: the project had no external_provider_id/
  );
});

test("MISMATCH: provider id that resolves to nothing still dead-letters", async () => {
  resetCtx();
  unmatched();
  ctx.aurora.project = projectFixture({ external_provider_id: "a1Pnobody00000000AA" });
  ctx.customerById = null; // no such record in this tenant

  const res = await handler(sqsEvent());
  assert.deepEqual(res.batchItemFailures, [{ itemIdentifier: "m1" }]);
  assert.equal(ctx.upserts.length, 0, "never guess: no create on a mismatch");
  assert.equal(ctx.updates.length, 0);
});

test("duplicate signed for a dealer deal converges on ONE record (upsert semantics)", async () => {
  resetCtx();
  unmatched();
  ctx.customerById = createdCustomer();

  await handler(sqsEvent());
  // Second delivery: the customer now exists and is found by project id, so the
  // create path isn't even reached.
  const first = ctx.upserts.length;
  ctx.customerRows = [createdCustomer({
    Aurora_Agreement_ID__c: AGREEMENT_ID,
    Aurora_Agreement_Status__c: "signed",
    Aurora_Signed_Email_Sent__c: "2026-08-04T02:31:00.000Z",
  })];
  ctx.upserts = [];
  await handler(sqsEvent());

  assert.equal(first, 1);
  assert.equal(ctx.upserts.length, 0, "no second create");
});

test("concurrent-safe: the create goes through UPSERT, not select-then-insert", async () => {
  resetCtx();
  unmatched();
  ctx.customerById = createdCustomer();

  await handler(sqsEvent());
  // The whole race-safety argument rests on this: one atomic upsert keyed on the
  // external id, and no plain create call anywhere.
  assert.equal(ctx.upserts.length, 1);
  assert.equal(ctx.upserts[0].extField, "Aurora_Project_ID__c");
  assert.equal(ctx.upserts[0].extValue, PROJECT_ID);
});

test("ambiguous upsert (300 Multiple Choices) dead-letters instead of looping", async () => {
  resetCtx();
  unmatched();
  const err = new Error("Salesforce upsert ambiguous (300)");
  err.sfStatus = 300;
  ctx.upsertThrows = err;

  const res = await handler(sqsEvent());
  assert.deepEqual(res.batchItemFailures, [{ itemIdentifier: "m1" }]);
});

test("sparse Aurora data (no names, email, phone) still creates with a fallback Name", async () => {
  resetCtx();
  unmatched();
  ctx.aurora.project = projectFixture({
    customer_first_name: null, customer_last_name: null,
    customer_email: null, customer_phone: null,
  });
  ctx.customerById = createdCustomer();

  const res = await handler(sqsEvent());
  assert.deepEqual(res.batchItemFailures, []);
  const f = ctx.upserts[0].fields;
  assert.equal(f.Name, "Dealer Deal — 42 Mesquite Ln", "falls back to the Aurora project name");
  assert.equal(f.First_Name__c, undefined);
  assert.equal(f.Primary_Email__c, undefined, "absent, never written as null/empty");
  assert.equal(f.Street__c, "42 Mesquite Ln", "the address still maps");
});

test("no names AND no project name -> last-resort Name, never anonymous", async () => {
  resetCtx();
  unmatched();
  ctx.aurora.project = projectFixture({
    customer_first_name: "", customer_last_name: "", name: "",
  });
  ctx.customerById = createdCustomer();

  await handler(sqsEvent());
  assert.equal(ctx.upserts[0].fields.Name, `Aurora Project ${PROJECT_ID}`);
});

test("state not in the picklist -> left unset and captured in the notes", async () => {
  resetCtx();
  unmatched();
  ctx.aurora.project = projectFixture({
    location: {
      ...projectFixture().location,
      property_address_components: {
        ...projectFixture().location.property_address_components,
        region: "Sonora", // a Mexican state; not in the org's US picklist
      },
    },
  });
  ctx.customerById = createdCustomer();

  await handler(sqsEvent());
  const f = ctx.upserts[0].fields;
  assert.equal(f.State__c, undefined, "an invalid picklist value would fail the insert");
  assert.match(f.Aurora_Import_Notes__c, /State \(unmatched, from Aurora region\): Sonora/);
  assert.match(ctx.emails[0].warnings.join(" "), /not in the State__c picklist/);
});

test("state matching is case-insensitive and writes the org's canonical casing", async () => {
  resetCtx();
  unmatched();
  const base = projectFixture();
  ctx.aurora.project = projectFixture({
    location: {
      ...base.location,
      property_address_components: { ...base.location.property_address_components, region: "IL" },
    },
  });
  ctx.customerById = createdCustomer();

  await handler(sqsEvent());
  // The org's picklist has the typo "Il"; we must write THAT, not "IL".
  assert.equal(ctx.upserts[0].fields.State__c, "Il");
});

test("Lead_Source value missing from the org -> skipped, warned, and noted", async () => {
  resetCtx();
  unmatched(); // hasDealerLeadSource is false by default (matches the real org)
  ctx.customerById = createdCustomer();

  await handler(sqsEvent());
  const f = ctx.upserts[0].fields;
  assert.equal(f.Lead_Source__c, undefined);
  assert.match(f.Aurora_Import_Notes__c, /Lead source \(not in picklist\): Aurora - Third-Party Dealer/);
  assert.match(ctx.emails[0].warnings.join(" "), /no "Aurora - Third-Party Dealer" value/);
});

test("Status/Stage values missing from the org -> skipped, warned, and noted", async () => {
  resetCtx();
  ctx.hasDealerStatusValue = false;
  ctx.hasDealerStageValue = false;
  unmatched();
  ctx.customerById = createdCustomer();

  const res = await handler(sqsEvent());
  assert.deepEqual(res.batchItemFailures, [], "a missing picklist value must not fail a signed sale");

  const f = ctx.upserts[0].fields;
  assert.equal(f.Status__c, undefined, "an invalid picklist value would fail the insert");
  assert.equal(f.Stage__c, undefined);
  assert.match(f.Aurora_Import_Notes__c, /Status__c \(not in picklist\): Customer/);
  assert.match(f.Aurora_Import_Notes__c, /Stage__c \(not in picklist\): Sold - Pending Review/);

  const warnings = ctx.emails[0].warnings.join(" ");
  assert.match(warnings, /Status__c has no "Customer" value/);
  assert.match(warnings, /Stage__c has no "Sold - Pending Review" value/);
  // The rest of the record still lands.
  assert.equal(f.Name, "Dana Dealer-Customer");
});

test("one of the two missing -> the other is still written", async () => {
  resetCtx();
  ctx.hasDealerStageValue = false; // Stage missing, Status present
  unmatched();
  ctx.customerById = createdCustomer();

  await handler(sqsEvent());
  const f = ctx.upserts[0].fields;
  assert.equal(f.Status__c, "Customer");
  assert.equal(f.Stage__c, undefined);
  assert.match(f.Aurora_Import_Notes__c, /Stage__c \(not in picklist\): Sold - Pending Review/);
});

test("Status/Stage match the org's canonical casing, like State__c does", async () => {
  resetCtx();
  ctx.stageValueCasing = "SOLD - Pending review"; // however the org happens to spell it
  unmatched();
  ctx.customerById = createdCustomer();

  await handler(sqsEvent());
  assert.equal(ctx.upserts[0].fields.Stage__c, "SOLD - Pending review",
    "write the org's spelling, not ours");
});

test("Lead_Source value present in the org -> written", async () => {
  resetCtx();
  ctx.hasDealerLeadSource = true;
  unmatched();
  ctx.customerById = createdCustomer();

  await handler(sqsEvent());
  assert.equal(ctx.upserts[0].fields.Lead_Source__c, "Aurora - Third-Party Dealer");
});

test("dealer fields not created yet -> import still succeeds, values just aren't written", async () => {
  resetCtx();
  ctx.hasDealerFields = false;
  unmatched();
  ctx.customerById = createdCustomer();

  const res = await handler(sqsEvent());
  assert.deepEqual(res.batchItemFailures, []);
  const f = ctx.upserts[0].fields;
  assert.equal(f.Aurora_Dealer_Name__c, undefined);
  assert.equal(f.Aurora_Import_Notes__c, undefined);
  assert.equal(f.Name, "Dana Dealer-Customer", "the real fields still map");
  assert.match(ctx.emails[0].warnings.join(" "), /has no field Aurora_Dealer_Name__c/);
});

test("dealer attribution falls back to the owning user when there is no partner_id", async () => {
  resetCtx();
  unmatched();
  ctx.aurora.project = projectFixture({ partner_id: null });
  ctx.customerById = createdCustomer();

  await handler(sqsEvent());
  assert.equal(ctx.upserts[0].fields.Aurora_Dealer_Name__c, "Owen Owner");
});

test("403 on List Partners degrades to raw ids — it does NOT fail the import", async () => {
  resetCtx();
  unmatched();
  ctx.aurora.partners = new FakeAuroraError("not provisioned", {
    status: 403, notProvisioned: true, endpoint: "/partners",
  });
  ctx.aurora.user = new FakeAuroraError("not provisioned", {
    status: 403, notProvisioned: true, endpoint: "/users/x",
  });
  ctx.customerById = createdCustomer();

  const res = await handler(sqsEvent());
  assert.deepEqual(res.batchItemFailures, [], "attribution is a nice-to-have");
  assert.equal(ctx.upserts[0].fields.Aurora_Dealer_Name__c, PARTNER_ID, "raw id kept");
  assert.match(ctx.emails[0].warnings.join(" "), /List Partners is NOT PROVISIONED/);
});

test("403 on Retrieve Project is a LOUD permanent dead-letter (the feature depends on it)", async () => {
  resetCtx();
  unmatched();
  ctx.aurora.project = new FakeAuroraError("not provisioned", {
    status: 403, notProvisioned: true, endpoint: "/projects/x",
  });

  const res = await handler(sqsEvent());
  assert.deepEqual(res.batchItemFailures, [{ itemIdentifier: "m1" }]);
  assert.equal(ctx.upserts.length, 0);
  assert.equal(ctx.emails.length, 0);
});

test("unmatched NON-signed dealer event is dropped quietly — no DLQ, no create", async () => {
  resetCtx();
  unmatched();

  for (const status of ["sent", "viewed"]) {
    ctx.upserts = [];
    ctx.updates = [];
    const res = await handler(sqsEvent({ status }));
    assert.deepEqual(res.batchItemFailures, [], `${status} must not dead-letter`);
    assert.equal(ctx.upserts.length, 0, "non-signed never creates a customer");
    assert.equal(ctx.updates.length, 0);
    assert.equal(ctx.emails.length, 0);
  }
});

test("unmatched NON-signed WITH a provider id still dead-letters (our own broken deal)", async () => {
  resetCtx();
  unmatched();
  ctx.aurora.project = projectFixture({ external_provider_id: CUSTOMER_ID });

  const res = await handler(sqsEvent({ status: "viewed" }));
  assert.deepEqual(res.batchItemFailures, [{ itemIdentifier: "m1" }]);
  assert.equal(ctx.upserts.length, 0);
});

test("cancellation-after-signing works on an auto-created record", async () => {
  resetCtx();
  // The record now exists (created by an earlier signed event) and is signed.
  ctx.customerRows = [
    createdCustomer({
      Aurora_Agreement_ID__c: AGREEMENT_ID,
      Aurora_Agreement_Status__c: "signed",
      Aurora_Signed_Email_Sent__c: "2026-08-04T02:31:00.000Z",
    }),
  ];
  ctx.aurora.agreement = { id: AGREEMENT_ID, status: "canceled" };

  const res = await handler(sqsEvent({ status: "canceled" }));
  assert.deepEqual(res.batchItemFailures, []);
  assert.equal(ctx.upserts.length, 0, "no special-casing — the record already exists");
  assert.equal(ctx.updates[0].fields.Aurora_Agreement_Status__c, "canceled");
  assert.equal(ctx.cancelEmails.length, 1);
  assert.equal(ctx.cancelEmails[0].previousStatus, "signed");
});


test("ambiguous PROJECT_ID (two customers) dead-letters rather than guessing", async () => {
  resetCtx();
  ctx.customerRows = [baseCustomer(), baseCustomer({ Id: "a1Pother00000000AA" })];

  const res = await handler(sqsEvent());
  assert.deepEqual(res.batchItemFailures, [{ itemIdentifier: "m1" }]);
  assert.equal(ctx.updates.length, 0);
  assert.equal(ctx.upserts.length, 0, "ambiguity is never resolved by creating another");
});

test("external_provider_id mismatch dead-letters (never write onto the wrong customer)", async () => {
  resetCtx();
  ctx.aurora.design = designFixture({ external_provider_id: "a1PsomeoneElse000AA" });

  const res = await handler(sqsEvent());
  assert.deepEqual(res.batchItemFailures, [{ itemIdentifier: "m1" }]);
  assert.equal(ctx.s3Puts.length, 0);
  assert.equal(ctx.emails.length, 0);
});

test("403 from Aurora surfaces as a permanent not-provisioned failure", async () => {
  resetCtx();
  ctx.aurora.design = new FakeAuroraError("not provisioned", {
    status: 403, notProvisioned: true, endpoint: "/designs/x/summary",
  });

  const res = await handler(sqsEvent());
  assert.deepEqual(res.batchItemFailures, [{ itemIdentifier: "m1" }]);
  assert.equal(ctx.emails.length, 0);
});

test("403 on the PDF download also surfaces (not swallowed as a warning)", async () => {
  resetCtx();
  ctx.downloadThrows = new FakeAuroraError("not provisioned", {
    status: 403, notProvisioned: true, endpoint: "/agreements/x/download_url/run",
  });

  const res = await handler(sqsEvent());
  assert.deepEqual(res.batchItemFailures, [{ itemIdentifier: "m1" }],
    "a 403 must not be downgraded to a warning");
});

test("expired file_url: PDF is skipped with a warning, and the retry re-runs the job", async () => {
  resetCtx();
  // A pre-signed URL that died before we fetched it — retryable, not permanent.
  ctx.downloadBytesThrows = new FakeAuroraError(
    "Signed-agreement download failed (403) — the 15-minute file_url has most likely expired; re-run the job.",
    { status: 403, notProvisioned: false, endpoint: "file_url" }
  );

  const first = await handler(sqsEvent());
  assert.deepEqual(first.batchItemFailures, [], "field write-back still succeeded");
  assert.equal(ctx.s3Puts.length, 0, "no PDF stored");
  const warnings = ctx.emails[0].warnings.join(" ");
  assert.match(warnings, /Signed PDF was NOT saved/i);

  // A later delivery (the marker was never stamped, since... it WAS emailed) —
  // simulate the redelivery with a healthy URL and a record mid-flight.
  resetCtx();
  ctx.customerRows = [
    baseCustomer({
      Aurora_Agreement_ID__c: AGREEMENT_ID,
      Aurora_Agreement_Status__c: "signed",
      Aurora_Signed_Email_Sent__c: null,
    }),
  ];
  await handler(sqsEvent());
  assert.equal(ctx.s3Puts.length, 1, "the fresh job/poll cycle stores the PDF");
});

test("describe guard: works with NONE of the new tracking fields created", async () => {
  resetCtx();
  ctx.hasTrackingFields = false;

  const res = await handler(sqsEvent());
  assert.deepEqual(res.batchItemFailures, [], "must not fail just because fields are missing");

  const f = mergedFields();
  // Business fields still written...
  assert.equal(f.Proposal_Amount__c, 38750.5);
  assert.equal(f.Final_System_Size_kW__c, 12.4);
  // ...and no non-existent field is ever sent to Salesforce.
  for (const name of TRACKING_FIELDS) {
    assert.equal(f[name], undefined, `${name} must not be written when it doesn't exist`);
  }
  // The gap is reported to the design manager rather than hidden.
  const warnings = ctx.emails[0].warnings.join(" ");
  assert.match(warnings, /Salesforce is missing field/i);
});

test("describe guard: a non-signed status with no tracking fields does not crash", async () => {
  resetCtx();
  ctx.hasTrackingFields = false;
  const res = await handler(sqsEvent({ status: "sent" }));
  assert.deepEqual(res.batchItemFailures, []);
  assert.equal(ctx.updates.length, 0);
});

test("signed event, dead agreement: record Aurora's status, skip the work, AND notify", async () => {
  resetCtx();
  ctx.aurora.agreement = { id: AGREEMENT_ID, status: "canceled" };

  const res = await handler(sqsEvent());
  assert.deepEqual(res.batchItemFailures, []);
  assert.equal(ctx.s3Puts.length, 0, "no PDF for a dead agreement");
  assert.equal(ctx.emails.length, 0, "no SIGNED notification");
  assert.equal(mergedFields().Aurora_Agreement_Status__c, "canceled");

  // Unified with the negative-terminal path: a dead agreement is announced however
  // we found out about it.
  assert.equal(ctx.cancelEmails.length, 1);
  assert.equal(ctx.cancelEmails[0].status, "canceled");
  // Nothing was recorded before, so nothing was contradicted -> no AFTER SIGNING.
  assert.equal(ctx.cancelEmails[0].previousStatus, null);
});

test("signed event, dead agreement, record already SIGNED -> AFTER SIGNING notification", async () => {
  resetCtx();
  // A signature Sundial already recorded and acted on...
  ctx.customerRows = [
    baseCustomer({
      Aurora_Agreement_ID__c: AGREEMENT_ID,
      Aurora_Agreement_Status__c: "signed",
      Aurora_Signed_Email_Sent__c: null, // not fully processed, so the re-read happens
    }),
  ];
  // ...that Aurora now says is declined.
  ctx.aurora.agreement = { id: AGREEMENT_ID, status: "declined" };

  await handler(sqsEvent());
  assert.equal(mergedFields().Aurora_Agreement_Status__c, "declined");
  assert.equal(ctx.cancelEmails.length, 1);
  assert.equal(ctx.cancelEmails[0].status, "declined");
  assert.equal(ctx.cancelEmails[0].previousStatus, "signed",
    "drives the AFTER SIGNING flag");
  assert.equal(ctx.s3Puts.length, 0);
  assert.equal(ctx.emails.length, 0);
});

test("signed event on an already-canceled record does not re-notify", async () => {
  resetCtx();
  ctx.customerRows = [
    baseCustomer({
      Aurora_Agreement_ID__c: AGREEMENT_ID,
      Aurora_Agreement_Status__c: "canceled",
    }),
  ];
  ctx.aurora.agreement = { id: AGREEMENT_ID, status: "canceled" };

  const res = await handler(sqsEvent());
  assert.deepEqual(res.batchItemFailures, []);
  assert.equal(ctx.cancelEmails.length, 0, "status unchanged -> no repeat alarm");
});

test("signed event whose re-read shows a NON-terminal status records it without notifying", async () => {
  resetCtx();
  // Not a cancellation — nothing to sound the alarm about.
  ctx.aurora.agreement = { id: AGREEMENT_ID, status: "viewed" };

  await handler(sqsEvent());
  assert.equal(mergedFields().Aurora_Agreement_Status__c, "viewed");
  assert.equal(ctx.cancelEmails.length, 0);
  assert.equal(ctx.emails.length, 0);
});

test("unmappable financing_option is reported, not guessed", async () => {
  resetCtx();
  ctx.aurora.financing = financingFixture({ financing_option: "ppa", loans: [] });

  await handler(sqsEvent());
  const f = mergedFields();
  assert.equal(f.Financing_Type__c, undefined, "a PPA must not be forced into Lease");
  const warnings = ctx.emails[0].warnings.join(" ");
  assert.match(warnings, /financing_option "ppa" has no match/i);
});

test("unmappable financier.provider is reported, not defaulted to Other", async () => {
  resetCtx();
  ctx.aurora.financing = financingFixture({
    financier: { type: "custom", provider: "Some New Lender LLC" },
  });

  await handler(sqsEvent());
  assert.equal(mergedFields().Financing_Partner__c, undefined);
  assert.match(ctx.emails[0].warnings.join(" "), /has no match in the Financing_Partner__c picklist/i);
});

test("email failure is non-fatal and leaves the event re-notifiable", async () => {
  resetCtx();
  ctx.emailResult = { sent: false, reason: "MessageRejected" };

  const res = await handler(sqsEvent());
  assert.deepEqual(res.batchItemFailures, [], "the write-back stands");
  assert.equal(mergedFields().Aurora_Signed_Email_Sent__c, undefined,
    "marker must NOT be stamped when the email failed");
  assert.equal(ctx.s3Puts.length, 1);
});

test("a Salesforce write failure is retryable (message is not deleted)", async () => {
  resetCtx();
  ctx.updateThrows = "UNABLE_TO_LOCK_ROW";

  const res = await handler(sqsEvent());
  assert.deepEqual(res.batchItemFailures, [{ itemIdentifier: "m1" }]);
});

test("signed event with no design_id dead-letters", async () => {
  resetCtx();
  const res = await handler(sqsEvent({ design_id: null }));
  assert.deepEqual(res.batchItemFailures, [{ itemIdentifier: "m1" }]);
  assert.equal(ctx.auroraCalls.includes("design"), false);
});

test("malformed SQS body dead-letters without touching anything", async () => {
  resetCtx();
  const res = await handler({ Records: [{ messageId: "bad", body: "not-json{" }] });
  assert.deepEqual(res.batchItemFailures, [{ itemIdentifier: "bad" }]);
  assert.equal(ctx.updates.length, 0);
});

test("batch isolation: one bad message does not stop the others", async () => {
  resetCtx();
  const good = JSON.parse(sqsEvent().Records[0].body);
  const res = await handler({
    Records: [
      { messageId: "bad", body: "not-json{" },
      { messageId: "good", body: JSON.stringify({ ...good, status: "viewed" }) },
    ],
  });
  assert.deepEqual(res.batchItemFailures, [{ itemIdentifier: "bad" }]);
  assert.equal(ctx.updates.length, 1, "the healthy message was still processed");
});
