// Tests for sundial-acumatica-push.
//
// Run with:  npm test        (needs --experimental-test-module-mocks)
//
// Two halves.
//
// The phone normaliser is tested hardest of the pure helpers because it is the thing
// that broke a real production Create Project: Acumatica enforces a `(999) 999-9999`
// input mask server-side and 422s the whole customer when a value does not match.
// Salesforce imposes no phone format, so anything not already in that exact shape fails.
//
// The rest asserts the EXACT bodies handed to Acumatica for the three September
// additions — address, parent account, project manager + JOBTYPE. Exact bodies, not
// "contains", because every one of these has a plausible-looking wrong value that
// Acumatica accepts silently: a state label instead of a code, a blank ParentRecord
// instead of an absent one, and above all a JOBTYPE of "Residential Solar" instead of
// the combo's ValueID `RS`. An unknown attribute value returns 200 and is discarded
// (proved 2026-08-24), so nothing about the response would tell us we got it wrong.

import test from "node:test";
import assert from "node:assert/strict";
import { mock } from "node:test";

// ---------------------------------------------------------------------------
// Fake Acumatica + Salesforce, sitting at the real module boundary
// ---------------------------------------------------------------------------
const ctx = {
  puts: [],          // every putAcumaticaEntity call: { entity, body }
  gets: [],          // every getAcumaticaEntity call: { entity, query }
  customerOk: true,
  projectOk: true,
  /**
   * What the verifying re-read reports back. `undefined` means "echo what the PUT
   * sent", which is the honest Acumatica: a write that worked reads back. Setting
   * either explicitly simulates the interesting failure — a value accepted with a 200
   * and then silently discarded.
   */
  readBackAttributes: undefined,
  readBackManager: undefined,
  readBackOk: true,
  sfPatches: [],     // every Salesforce PATCH: { url, body }
  sfRecords: {},     // object name -> rows returned by sfQuery
};

function resetCtx() {
  ctx.puts = [];
  ctx.gets = [];
  ctx.customerOk = true;
  ctx.projectOk = true;
  ctx.readBackAttributes = undefined;
  ctx.readBackManager = undefined;
  ctx.readBackOk = true;
  ctx.sfPatches = [];
  ctx.sfRecords = {};
}

mock.module("../../lib/acumatica.js", {
  exports: {
    putAcumaticaEntity: async (entity, body) => {
      ctx.puts.push({ entity, body });
      if (entity === "Customer") {
        if (!ctx.customerOk) return { ok: false, status: 422, data: null, text: "nope" };
        return {
          ok: true,
          status: 200,
          data: { CustomerID: { value: "C999001" }, id: "guid-cust-999001" },
          text: "",
        };
      }
      if (!ctx.projectOk) return { ok: false, status: 422, data: null, text: "nope" };
      return {
        ok: true,
        status: 200,
        data: { ProjectID: { value: body?.ProjectID?.value } },
        text: "",
      };
    },
    getAcumaticaEntity: async (entity, query) => {
      ctx.gets.push({ entity, query });
      if (!ctx.readBackOk) return { ok: false, status: 500, data: null, text: "read failed" };
      const sent = ctx.puts.filter((p) => p.entity === "Project").at(-1)?.body;
      const attributes =
        ctx.readBackAttributes !== undefined ? ctx.readBackAttributes : sent?.Attributes ?? [];
      const manager =
        ctx.readBackManager !== undefined
          ? ctx.readBackManager
          : sent?.ProjectProperties?.ProjectManager?.value ?? null;
      return {
        ok: true,
        status: 200,
        data: [
          {
            id: "guid-proj",
            Attributes: attributes,
            ProjectProperties: manager ? { ProjectManager: { value: manager } } : {},
          },
        ],
        text: "",
      };
    },
    // The real one; the address/parent tests exercise it through the customer body.
    normalizeAcumaticaPhone: (await import("../../lib/acumatica.js")).normalizeAcumaticaPhone,
  },
});

mock.module("../../lib/salesforce.js", {
  exports: {
    getSalesforceToken: async () => ({ access_token: "t", instance_url: "https://sf.test" }),
    sfQuery: async (soql) => {
      const object = /FROM\s+(\w+)/.exec(soql)?.[1];
      return ctx.sfRecords[object] ?? [];
    },
    soqlEscapeString: (v) => String(v).replace(/'/g, "\\'"),
  },
});

mock.module("../../lib/identity.js", {
  exports: {
    resolveIdentity: async () => ({ tenantId: "a0X000000000001", accessLevel: "admin" }),
  },
});

mock.module("../../lib/access-enforce.js", {
  exports: {
    alwaysEnforcedAccess: (identity) => identity,
    assertAction: () => null, // allowed
  },
});

// fetch is the Salesforce PATCH path inside the Lambda.
globalThis.fetch = async (url, init) => {
  ctx.sfPatches.push({ url: String(url), body: JSON.parse(init.body) });
  return { ok: true, status: 204, text: async () => "" };
};

const mod = await import("./index.js");
const {
  handler,
  normalizePicklist,
  resolveParentAccount,
  resolveCustomerState,
  buildCustomerAddress,
  resolveProjectManager,
  verifyProjectExtras,
  FINANCING_PARTNER_PARENT_ACCOUNTS,
  PROJECT_MANAGER_EMPLOYEE_IDS,
  PROJECT_JOBTYPE_VALUE,
  PROJECT_JOBTYPE_ATTRIBUTE_ID,
  DEFAULT_STATE,
  CUSTOMER_COUNTRY,
} = mod;
const { normalizeAcumaticaPhone } = await import("../../lib/acumatica.js");

// ===========================================================================
// Phone normalisation (unchanged — the production breakage this guards)
// ===========================================================================

test("the exact value that broke production is normalised", () => {
  // Gary Rayfield, 2026-08-19. Acumatica rejected this verbatim.
  const r = normalizeAcumaticaPhone("623 703-2778");
  assert.equal(r.phone, "(623) 703-2778");
  assert.equal(r.reason, null);
  assert.equal(r.extension, null);
});

test("every common Salesforce phone shape reaches the mask", () => {
  for (const raw of [
    "623 703-2778",
    "(623) 703-2778",
    "6237032778",
    "623-703-2778",
    "623.703.2778",
    "  623 703 2778  ",
    "+1 623-703-2778",
    "1-623-703-2778",
    "+1 (623) 703-2778",
  ]) {
    assert.equal(normalizeAcumaticaPhone(raw).phone, "(623) 703-2778", `failed on ${raw}`);
  }
});

test("an already-masked value is returned unchanged, not double-formatted", () => {
  assert.equal(normalizeAcumaticaPhone("(623) 703-2778").phone, "(623) 703-2778");
});

test("a NANP country code is stripped rather than read as an 11th digit", () => {
  assert.equal(normalizeAcumaticaPhone("+1 623 703 2778").phone, "(623) 703-2778");
  assert.equal(normalizeAcumaticaPhone("16237032778").phone, "(623) 703-2778");
});

test("extensions are separated, not merged into the digits", () => {
  for (const [raw, ext] of [
    ["623.703.2778 x123", "123"],
    ["623-703-2778 ext 45", "45"],
    ["623-703-2778 ext. 45", "45"],
    ["(623) 703-2778 extension 9", "9"],
    ["6237032778 #22", "22"],
  ]) {
    const r = normalizeAcumaticaPhone(raw);
    assert.equal(r.phone, "(623) 703-2778", `phone failed on ${raw}`);
    assert.equal(r.extension, ext, `extension failed on ${raw}`);
  }
});

test("empty input is not an error — there is simply nothing to send", () => {
  for (const raw of ["", "   ", null, undefined]) {
    const r = normalizeAcumaticaPhone(raw);
    assert.equal(r.phone, null);
    assert.equal(r.reason, null, "an absent phone must not be reported as a problem");
  }
});

test("an unusable value yields null AND a reason — never a guess", () => {
  const short = normalizeAcumaticaPhone("555-1234");
  assert.equal(short.phone, null);
  assert.match(short.reason, /expected 10 digits, found 7/);

  const intl = normalizeAcumaticaPhone("+44 20 7946 0958");
  assert.equal(intl.phone, null);
  assert.match(intl.reason, /expected 10 digits, found 12/);

  const junk = normalizeAcumaticaPhone("not a phone");
  assert.equal(junk.phone, null);
  assert.match(junk.reason, /no digits found/);
});

test("output always matches Acumatica's mask exactly", () => {
  const MASK = /^\(\d{3}\) \d{3}-\d{4}$/;
  for (const raw of ["6237032778", "623 703-2778", "+1 (623) 703-2778", "623.703.2778 x9"]) {
    const { phone } = normalizeAcumaticaPhone(raw);
    assert.match(phone, MASK, `mask violated for ${raw}`);
  }
});

test("a non-string input does not throw", () => {
  assert.equal(normalizeAcumaticaPhone(6237032778).phone, "(623) 703-2778");
  assert.doesNotThrow(() => normalizeAcumaticaPhone({}));
  assert.equal(normalizeAcumaticaPhone({}).phone, null);
});

// ===========================================================================
// B — parent account by financing partner
// ===========================================================================

test("THE EN DASH: 'Participate Prepaid Lease – Cash' maps, and its hyphen sibling does too", () => {
  // The live picklist spells these two inconsistently — U+2013 in the Cash value, an
  // ASCII hyphen in the Financed one (verified against the org 2026-09-08). A matcher
  // that only trims and lowercases matches Financed and silently misses Cash, leaving
  // four real Participate customers with no parent account and no warning. This is the
  // single assertion that would catch that regression.
  const enDash = "Participate Prepaid Lease – Cash";
  assert.ok(enDash.includes("–"), "fixture must actually contain the en dash");
  assert.deepEqual(resolveParentAccount(enDash), { parentAccount: "C001310754", unlisted: false });
  assert.deepEqual(resolveParentAccount("Participate Prepaid Lease - Financed"), {
    parentAccount: "C001310754",
    unlisted: false,
  });
  // Both spellings of both values, in both directions.
  assert.equal(resolveParentAccount("Participate Prepaid Lease - Cash").parentAccount, "C001310754");
  assert.equal(
    resolveParentAccount("Participate Prepaid Lease – Financed").parentAccount,
    "C001310754"
  );
});

test("the mapping table is exactly the four rows agreed, and nothing else", () => {
  assert.deepEqual(
    Object.values(FINANCING_PARTNER_PARENT_ACCOUNTS).sort(),
    ["01868", "C001308357", "C001310754", "C001310754"].sort()
  );
  assert.equal(resolveParentAccount("Lightreach").parentAccount, "C001308357");
  assert.equal(resolveParentAccount("Credit Human").parentAccount, "01868");
});

test("matching is trimmed and case-insensitive", () => {
  assert.equal(resolveParentAccount("  lightreach  ").parentAccount, "C001308357");
  assert.equal(resolveParentAccount("CREDIT HUMAN").parentAccount, "01868");
  assert.equal(resolveParentAccount("credit  human").parentAccount, "01868", "collapsed spaces");
});

test("Cash and blank get no parent AND no warning; an unlisted partner warns", () => {
  // Cash is 256 live records and correct. Warning on it would train everyone to ignore
  // the warning that actually means something.
  assert.deepEqual(resolveParentAccount("Cash"), { parentAccount: null, unlisted: false });
  for (const blank of ["", "   ", null, undefined]) {
    assert.deepEqual(resolveParentAccount(blank), { parentAccount: null, unlisted: false });
  }
  // A new finance partner must surface rather than silently get no parent.
  for (const other of ["GoodLeap", "Sunlight", "Mosaic", "ICCU", "Other"]) {
    assert.deepEqual(
      resolveParentAccount(other),
      { parentAccount: null, unlisted: true },
      `expected ${other} to be reported as unlisted`
    );
  }
});

// ===========================================================================
// A — customer address
// ===========================================================================

test("state is the two-letter code Acumatica stores, never a display label", () => {
  assert.deepEqual(resolveCustomerState("AZ"), { state: "AZ", fellBack: false });
  assert.deepEqual(resolveCustomerState(" ok "), { state: "OK", fellBack: false });
  // What the UI shows. Sending it would be wrong even though it "looks right".
  assert.deepEqual(resolveCustomerState("AZ - ARIZONA"), { state: "AZ", fellBack: true });
  assert.deepEqual(resolveCustomerState("Arizona"), { state: "AZ", fellBack: true });
});

test("blank or unrecognised state falls back to AZ and says so", () => {
  for (const raw of ["", "   ", null, undefined, "ZZ", "XX"]) {
    const r = resolveCustomerState(raw);
    assert.equal(r.state, DEFAULT_STATE);
    assert.equal(r.fellBack, true, `expected a reported fallback for ${JSON.stringify(raw)}`);
  }
});

test("address omits blank street/city/zip but ALWAYS sends state and country", () => {
  const full = buildCustomerAddress({
    Street__c: "205 S 122nd Dr",
    City__c: "Avondale",
    State__c: "AZ",
    Postal_Code__c: "85323",
  });
  assert.deepEqual(full.address, {
    State: { value: "AZ" },
    Country: { value: "US" },
    AddressLine1: { value: "205 S 122nd Dr" },
    City: { value: "Avondale" },
    PostalCode: { value: "85323" },
  });
  assert.equal(full.stateFellBack, false);

  // Blank street/zip are OMITTED, not sent as "". Sending "" would let a push blank an
  // address someone completed in Acumatica by hand.
  const sparse = buildCustomerAddress({ Street__c: "  ", City__c: "", State__c: "AZ", Postal_Code__c: null });
  assert.deepEqual(sparse.address, { State: { value: "AZ" }, Country: { value: "US" } });
  assert.equal("AddressLine1" in sparse.address, false);
  assert.equal("PostalCode" in sparse.address, false);
});

test("country is always US, whatever the record says", () => {
  const r = buildCustomerAddress({ Street__c: "1 A St", State__c: "MA", Postal_Code__c: "02101" });
  assert.equal(r.address.Country.value, CUSTOMER_COUNTRY);
  assert.equal(r.address.Country.value, "US");
});

// ===========================================================================
// C — project manager
// ===========================================================================

test("the two mapped project managers resolve to their live Acumatica employee ids", () => {
  assert.equal(resolveProjectManager("Lindsay McCormack").employeeId, "E00675");
  assert.equal(resolveProjectManager("Cameron Labonte").employeeId, "E01177");
  assert.equal(resolveProjectManager("  cameron labonte ").employeeId, "E01177");
  assert.deepEqual(Object.values(PROJECT_MANAGER_EMPLOYEE_IDS).sort(), ["E00675", "E01177"]);
});

test("blank omits silently; an unmapped name omits and reports", () => {
  for (const blank of ["", "   ", null, undefined, ";;"]) {
    const r = resolveProjectManager(blank);
    assert.equal(r.employeeId, null);
    assert.deepEqual(r.unknownNames, [], "an absent PM is not an unmapped one");
  }
  // A legacy value: 683 live records carry it, and no Acumatica employee is mapped.
  const legacy = resolveProjectManager("Breana Evans");
  assert.equal(legacy.employeeId, null);
  assert.deepEqual(legacy.unknownNames, ["Breana Evans"]);
  assert.equal(legacy.ambiguous, false);
});

test("MULTIPICKLIST: a semicolon list with one mapped name resolves; two mapped names refuse", () => {
  // Project_Manager__c is a multipicklist, so the raw value can be a list, and Acumatica
  // has one manager slot. One match wins; two matches must not be silently coin-tossed.
  const one = resolveProjectManager("Breana Evans;Lindsay McCormack");
  assert.equal(one.employeeId, "E00675");
  assert.deepEqual(one.unknownNames, ["Breana Evans"]);

  const two = resolveProjectManager("Lindsay McCormack;Cameron Labonte");
  assert.equal(two.employeeId, null, "must not pick one of two people at random");
  assert.equal(two.ambiguous, true);

  // The same name twice is not ambiguous — it is one person.
  const dup = resolveProjectManager("Lindsay McCormack;Lindsay McCormack");
  assert.equal(dup.employeeId, "E00675");
  assert.equal(dup.ambiguous, false);
});

// ===========================================================================
// JOBTYPE — the value is the combo's ValueID, not the label
// ===========================================================================

test("JOBTYPE is the code RS, not any human phrasing of it", () => {
  // Acumatica accepts an unrecognised combo value with a 200 and discards it, so this
  // is the kind of mistake that ships and then never reports itself. The allowed
  // ValueIDs read live 2026-09-08 are CE, CS, EV, RE, RS, SE.
  assert.equal(PROJECT_JOBTYPE_VALUE, "RS");
  assert.notEqual(PROJECT_JOBTYPE_VALUE, "Residential Solar");
  assert.notEqual(PROJECT_JOBTYPE_VALUE, "Residential - Solar");
  assert.equal(PROJECT_JOBTYPE_ATTRIBUTE_ID, "JOBTYPE");
});

// ===========================================================================
// End-to-end: the EXACT bodies handed to Acumatica
// ===========================================================================

const TENANT = "a0X000000000001";

/** A customer row shaped like the SOQL result, overridable per test. */
function customerRow(over = {}) {
  return {
    Id: "a1P000000000001",
    Name: "Jane Roe",
    Primary_Email__c: "jane@example.com",
    Primary_Phone__c: "623 703-2778",
    Street__c: "205 S 122nd Dr",
    City__c: "Avondale",
    State__c: "AZ",
    Postal_Code__c: "85323",
    Financing_Partner__c: "Lightreach",
    Acumatica_Project_ID__c: "R261200",
    Acumatica_Customer_ID__c: null,
    Acumatica_Customer_GUID__c: null,
    Synced_to_Acumatica__c: false,
    Description__c: "Jane Roe - APS LightReach Lease",
    Linked_Solar_Project__c: "a1Q000000000001",
    Client__c: TENANT,
    Domestic_Content_Eligible__c: null,
    ...over,
  };
}
function solarRow(over = {}) {
  return {
    Id: "a1Q000000000001",
    Project_Created_in_Acumatica__c: null,
    Project_Manager__c: "Lindsay McCormack",
    Client__c: TENANT,
    ...over,
  };
}

async function runPush({ customer = {}, solar = {} } = {}) {
  resetCtx();
  ctx.sfRecords.Sundial_Customer__c = [customerRow(customer)];
  ctx.sfRecords.Sundial_Solar__c = [solarRow(solar)];
  const res = await handler({
    requestContext: { http: { method: "POST" } },
    headers: { authorization: "Bearer x", origin: "http://localhost:5173" },
    body: JSON.stringify({ recordId: "a1P000000000001" }),
  });
  return { res, body: JSON.parse(res.body) };
}

const customerPut = () => ctx.puts.find((p) => p.entity === "Customer")?.body;
const projectPut = () => ctx.puts.find((p) => p.entity === "Project")?.body;

test("the customer body carries the full address and the mapped parent account", async () => {
  const { body } = await runPush();
  assert.equal(body.ok, true, JSON.stringify(body));

  assert.deepEqual(customerPut(), {
    CustomerName: { value: "Jane Roe" },
    CustomerClass: { value: "RESIDENT" },
    Email: { value: "jane@example.com" },
    MainContact: {
      Phone1: { value: "(623) 703-2778" },
      Email: { value: "jane@example.com" },
      Address: {
        State: { value: "AZ" },
        Country: { value: "US" },
        AddressLine1: { value: "205 S 122nd Dr" },
        City: { value: "Avondale" },
        PostalCode: { value: "85323" },
      },
    },
    TaxZone: { value: "08AVONDALR" },
    ParentRecord: { value: "C001308357" },
  });
});

test("no financing partner means NO ParentRecord key at all — not an empty one", async () => {
  // A blank ParentRecord is a value. Acumatica would read it as "detach the parent",
  // which on a re-push would undo a parent someone set by hand.
  const { body } = await runPush({ customer: { Financing_Partner__c: "Cash" } });
  assert.equal(body.ok, true);
  assert.equal("ParentRecord" in customerPut(), false);
  assert.deepEqual(body.warnings, []);
});

test("an unlisted financing partner still creates, with a warning naming it", async () => {
  const { body } = await runPush({ customer: { Financing_Partner__c: "GoodLeap" } });
  assert.equal(body.ok, true);
  assert.equal("ParentRecord" in customerPut(), false);
  assert.deepEqual(body.warnings, [{ code: "financing_partner_unmapped", value: "GoodLeap" }]);
});

test("an out-of-state customer files under AZ and warns", async () => {
  const { body } = await runPush({ customer: { State__c: "Arizona", Financing_Partner__c: "Cash" } });
  assert.equal(body.ok, true);
  assert.equal(customerPut().MainContact.Address.State.value, "AZ");
  assert.deepEqual(body.warnings, [
    { code: "state_fallback", value: "Arizona", usedState: "AZ" },
  ]);
});

test("the project body carries JOBTYPE=RS and the mapped project manager", async () => {
  const { body } = await runPush();
  assert.equal(body.ok, true);

  assert.deepEqual(projectPut(), {
    ProjectID: { value: "R261200" },
    ProjectTemplateID: { value: "RS" },
    Customer: { value: "C999001" },
    Attributes: [{ AttributeID: { value: "JOBTYPE" }, Value: { value: "RS" } }],
    Description: { value: "Jane Roe - APS LightReach Lease" },
    ProjectProperties: { ProjectManager: { value: "E00675" } },
  });
  assert.equal(body.project.jobType, "RS");
  assert.equal(body.project.projectManager, "E00675");
});

test("JOBTYPE=RS is sent on the RSDC template too — the attribute is not the template", async () => {
  // (read-back echoes the PUT by default)
  const { body } = await runPush({
    customer: { Domestic_Content_Eligible__c: "Yes" },
    solar: { Project_Manager__c: "Cameron Labonte" },
  });
  assert.equal(body.ok, true);
  assert.equal(projectPut().ProjectTemplateID.value, "RSDC");
  assert.deepEqual(projectPut().Attributes, [
    { AttributeID: { value: "JOBTYPE" }, Value: { value: "RS" } },
  ]);
  assert.equal(body.project.domesticContentEligible, true);
});

test("an unmapped project manager omits ProjectProperties entirely and warns", async () => {
  const { body } = await runPush({ solar: { Project_Manager__c: "Breana Evans" } });
  assert.equal(body.ok, true);
  assert.equal("ProjectProperties" in projectPut(), false);
  assert.deepEqual(body.warnings, [
    { code: "project_manager_unmapped", names: ["Breana Evans"] },
  ]);
});

test("the create is VERIFIED by a fresh re-read, not by the PUT's own 200", async () => {
  await runPush();
  const verify = ctx.gets.find((g) => g.entity === "Project");
  assert.ok(verify, "a verifying re-read must happen");
  assert.equal(verify.query.$filter, "ProjectID eq 'R261200'");
  assert.match(verify.query.$expand, /Attributes/);
  assert.match(verify.query.$expand, /ProjectProperties/);
});

test("a silently-discarded JOBTYPE is reported, and does NOT fail the push", async () => {
  // The standing hazard: Acumatica answers 200 and throws the attribute away. Only the
  // re-read can tell. The project is real and correctly scaffolded, so this warns.
  resetCtx();
  ctx.sfRecords.Sundial_Customer__c = [customerRow()];
  ctx.sfRecords.Sundial_Solar__c = [solarRow()];
  ctx.readBackAttributes = []; // accepted, then discarded
  const res = await handler({
    requestContext: { http: { method: "POST" } },
    headers: { authorization: "Bearer x" },
    body: JSON.stringify({ recordId: "a1P000000000001" }),
  });
  const body = JSON.parse(res.body);
  assert.equal(res.statusCode, 200);
  assert.equal(body.ok, true, "a discarded attribute must not fail a good project");
  assert.equal(body.project.attributesVerified, false);
  const warn = body.warnings.find((w) => w.code === "project_attributes_unverified");
  assert.ok(warn, JSON.stringify(body.warnings));
  assert.deepEqual(warn.missing, ["JOBTYPE"]);
});

test("a failed verifying re-read reports 'cannot tell' (null), never a false pass", async () => {
  resetCtx();
  ctx.sfRecords.Sundial_Customer__c = [customerRow()];
  ctx.sfRecords.Sundial_Solar__c = [solarRow()];
  ctx.readBackOk = false;
  const res = await handler({
    requestContext: { http: { method: "POST" } },
    headers: { authorization: "Bearer x" },
    body: JSON.stringify({ recordId: "a1P000000000001" }),
  });
  const body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.equal(body.project.attributesVerified, null, "null means unknown, not verified");
  assert.ok(body.warnings.some((w) => w.code === "project_verify_read_failed"));
});

test("a ProjectManager that did not land is reported", async () => {
  const summary = { project: {}, warnings: [] };
  resetCtx();
  // Called directly, so nothing was PUT for the read-back to echo: state both halves.
  ctx.readBackAttributes = [{ AttributeID: { value: "JOBTYPE" }, Value: { value: "RS" } }];
  ctx.readBackManager = null; // sent E00675, came back empty
  await verifyProjectExtras("R261200", {
    attributes: [{ AttributeID: { value: "JOBTYPE" }, Value: { value: "RS" } }],
    expectedManager: "E00675",
    summary,
    recordId: "a1P000000000001",
  });
  assert.equal(summary.project.attributesVerified, true);
  assert.deepEqual(summary.warnings, [
    { code: "project_manager_unverified", sent: "E00675", got: null },
  ]);
});

test("an EXISTING customer is never re-addressed or re-parented", async () => {
  // The address and parent apply to NEW customers only. This is what stops a re-push
  // from overwriting a correction someone made in Acumatica by hand.
  const { body } = await runPush({
    customer: { Acumatica_Customer_ID__c: "C001311228", Acumatica_Customer_GUID__c: "g" },
  });
  assert.equal(body.ok, true);
  assert.equal(customerPut(), undefined, "no Customer PUT at all");
  assert.equal(body.customer.stage, "skipped_exists");
  assert.equal(body.customer.parentAccount, null);
});

test("normalizePicklist folds every dash it might meet", () => {
  const expected = "participate prepaid lease - cash";
  for (const dash of ["-", "‐", "‑", "‒", "–", "—", "―", "−"]) {
    assert.equal(
      normalizePicklist(`  Participate  Prepaid Lease ${dash} CASH `),
      expected,
      `dash U+${dash.charCodeAt(0).toString(16)} not folded`
    );
  }
});
