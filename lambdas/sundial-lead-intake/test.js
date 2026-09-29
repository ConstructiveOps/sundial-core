// sundial-lead-intake — pure tests, no network. `node --test lambdas/sundial-lead-intake/test.js`
// Every dependency is injected (createIntakeHandler / createReportHandler), so the real
// handlers run against fakes.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeLead, normalizePhone, phoneKey, missingRequirements, maskEmail, matchState,
  schemaFromDescribe, buildLeadCustomerFields, duplicateQuery, pickDuplicate,
  createIntakeHandler, sfErrorSummary, NOTES_FIELD,
} from "./intake.js";
import {
  csvCell, buildCsv, buildRow, COLUMNS, toPhoenixDate, toPhoenixDateTime, phoenixMidnightUtc,
  createReportHandler, SUBJECT, reportFilename, excludeTestRecordsClause,
} from "./report.js";

const SLUG = "test-slug-not-the-real-one-0123456789";
const TENANT_ID = "a1W000000000001AAA";
const esc = (s) => String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'");

// --- a describe shaped like the live org (2026-09-29) ------------------------------
const bit = (i) => { const b = Buffer.alloc(1); b[0] = 0x80 >> i; return b.toString("base64"); };
function customerDescribe({ leadSources = ["Referral", "TCD"], extra = [] } = {}) {
  const pl = (vals) => vals.map((value) => ({ value, active: true }));
  return {
    fields: [
      { name: "Id", type: "id" },
      { name: "Name", type: "string", length: 80 },
      { name: "First_Name__c", type: "string", length: 80 },
      { name: "Last_Name__c", type: "string", length: 80 },
      { name: "Street__c", type: "string", length: 255 },
      { name: "City__c", type: "string", length: 80 },
      { name: "State__c", type: "picklist", picklistValues: pl(["AK", "AZ", "CA", "NM"]) },
      { name: "Postal_Code__c", type: "string", length: 20 },
      { name: "Primary_Email__c", type: "email", length: 80 },
      { name: "Primary_Phone__c", type: "phone", length: 40 },
      { name: "Country__c", type: "picklist", picklistValues: pl(["United States"]) },
      { name: "Status__c", type: "picklist", picklistValues: pl(["Lead", "Opportunity", "Customer"]) },
      {
        name: "Stage__c", type: "picklist", controllerName: "Status__c", dependentPicklist: true,
        picklistValues: [
          { value: "Appointment Set", active: true, validFor: bit(1) }, // Opportunity only — listed first on purpose
          { value: "Old Lead Stage", active: false, validFor: bit(0) }, // inactive: never chosen
          { value: "New", active: true, validFor: bit(0) },
          { value: "Contact Attempt Made", active: true, validFor: bit(0) },
        ],
      },
      { name: "Customer_Type__c", type: "multipicklist", picklistValues: pl(["Solar", "Roofing", "Service"]) },
      { name: "Lead_Source__c", type: "picklist", picklistValues: pl(leadSources) },
      { name: "Lead_Date__c", type: "date" },
      { name: "Client__c", type: "reference" },
      { name: NOTES_FIELD, type: "textarea", length: 32768 },
      { name: "CreatedDate", type: "datetime" },
      ...extra,
    ],
  };
}

const PAYLOAD = {
  first_name: " ZZ ", last_name: "TCD TEST", address1: "1 Test St", city: "Phoenix", state: "AZ",
  zip_code: "85001", email: " TMurphy5213+TCD@Gmail.com ", phone: "(602) 555-0100", utm: "ignored",
};

// ===================================================================================
// Part 1 — intake
// ===================================================================================

test("alias / normalisation table", () => {
  const cases = [
    [{ zip: "85001" }, "zip_code", "85001"],
    [{ postal_code: "85001" }, "zip_code", "85001"],
    [{ zip_code: "85004", zip: "85001" }, "zip_code", "85004"], // canonical wins
    [{ address: "1 A St" }, "address1", "1 A St"],
    [{ street: " 2 B St " }, "address1", "2 B St"],
    [{ address1: "3 C St", street: "x" }, "address1", "3 C St"],
    [{ email: " A.B@X.COM " }, "email", "a.b@x.com"],
    [{ phone: "+1 (602) 555-0100" }, "phone", "+16025550100"],
    [{ phone: "602.555.0100" }, "phone", "6025550100"],
    [{ phone: "n/a" }, "phone", ""],
    [{ zip_code: 85001 }, "zip_code", "85001"], // a bare number is accepted
    [{ first_name: { x: 1 } }, "first_name", ""], // anything else is ignored
  ];
  for (const [body, key, want] of cases) assert.equal(normalizeLead(body).lead[key], want, JSON.stringify(body));
  const { lead, received } = normalizeLead(PAYLOAD);
  assert.equal(lead.first_name, "ZZ");
  assert.ok(!("utm" in lead));
  assert.deepEqual(received.map(([k]) => k), ["first_name", "last_name", "address1", "city", "state", "zip_code", "email", "phone"]);
  assert.equal(normalizePhone("+44 20 7946 0958"), "+442079460958");
  assert.equal(phoneKey("+16025550100"), "6025550100");
  assert.equal(phoneKey("(602) 555-0100"), "6025550100");
});

test("required-field 400s name the requirement and never contain a value", async () => {
  const h = createIntakeHandler(fakeDeps());
  const bodies = [
    { first_name: "Secret-Name-123", city: "Tempe-Unique" },            // no email / phone
    { email: "private.person@example.com", city: "Tempe-Unique" },      // no name
    { email: "not-an-address-xyz", first_name: "Secret-Name-123" },     // bad email counts as absent
  ];
  for (const body of bodies) {
    const res = await h(leadEvent(body));
    assert.equal(res.statusCode, 400);
    const text = res.body;
    for (const v of Object.values(body)) assert.ok(!text.includes(v), `400 echoed "${v}"`);
    assert.match(text, /missing_fields/);
  }
  assert.deepEqual(missingRequirements(normalizeLead({ phone: "6025550100", last_name: "X" }).lead), []);
  assert.deepEqual(missingRequirements(normalizeLead({}).lead), ["email or phone", "first_name or last_name"]);
});

test("state guard: code or full name -> the org's canonical value; unmatched -> notes, never fails", () => {
  const vals = ["AK", "AZ", "CA"];
  assert.equal(matchState("AZ", vals), "AZ");
  assert.equal(matchState("az", vals), "AZ");
  assert.equal(matchState("Arizona", vals), "AZ");
  assert.equal(matchState(" california ", vals), "CA");
  assert.equal(matchState("Texas", vals), null); // real state, not in this org's list
  assert.equal(matchState("Narnia", vals), null);

  const schema = schemaFromDescribe(customerDescribe());
  const { lead, received } = normalizeLead({ ...PAYLOAD, state: "Narnia" });
  const { fields, warnings } = buildLeadCustomerFields({ lead, received, source: "tcd", tenantId: TENANT_ID, schema });
  assert.ok(!("State__c" in fields));
  assert.match(fields[NOTES_FIELD], /State \(not in picklist\): Narnia/);
  assert.ok(warnings.some((w) => w.includes("State__c")));
});

test("field mapping: real field names, Lead defaults, Stage from describe, Phoenix lead date", () => {
  const schema = schemaFromDescribe(customerDescribe());
  const { lead, received } = normalizeLead({ ...PAYLOAD, state: "Arizona" });
  // 2026-09-30T05:30Z is still Sept 29 in Arizona.
  const { fields, warnings } = buildLeadCustomerFields({ lead, received, source: "tcd", tenantId: TENANT_ID, schema, at: new Date("2026-09-30T05:30:00Z") });
  assert.deepEqual(warnings, []);
  assert.equal(fields.Name, "ZZ TCD TEST");
  assert.equal(fields.Primary_Email__c, "tmurphy5213+tcd@gmail.com");
  assert.equal(fields.Primary_Phone__c, "6025550100");
  assert.equal(fields.Postal_Code__c, "85001");
  assert.equal(fields.State__c, "AZ");
  assert.equal(fields.Status__c, "Lead");
  assert.equal(fields.Stage__c, "New", "first ACTIVE Lead stage, not the Opportunity one listed first");
  assert.equal(fields.Customer_Type__c, "Solar");
  assert.equal(fields.Country__c, "United States");
  assert.equal(fields.Lead_Source__c, "TCD");
  assert.equal(fields.Lead_Date__c, "2026-09-29");
  assert.equal(fields.Client__c, TENANT_ID);
  assert.ok(!("Sales_Rep__c" in fields));
  for (const bogus of ["Email__c", "Phone__c", "Zip_Code__c"]) assert.ok(!(bogus in fields));
  assert.match(fields[NOTES_FIELD], /^Lead received from The Cool Down \(TCD\)/);
  assert.match(fields[NOTES_FIELD], /\nzip_code: 85001/);
  assert.ok(!fields[NOTES_FIELD].includes("utm"), "unknown keys stay out of the notes");
});

test("strings longer than the field are truncated, not sent to fail the insert", () => {
  const schema = schemaFromDescribe(customerDescribe());
  const { lead, received } = normalizeLead({ ...PAYLOAD, city: "C".repeat(300) });
  const { fields } = buildLeadCustomerFields({ lead, received, source: "tcd", tenantId: TENANT_ID, schema });
  assert.equal(fields.City__c.length, 80);
});

test("picklist fallback: an org without TCD still gets the lead, with the source in the notes + a loud warning", async () => {
  const schema = schemaFromDescribe(customerDescribe({ leadSources: ["Referral"] }));
  const { lead, received } = normalizeLead(PAYLOAD);
  const { fields, warnings } = buildLeadCustomerFields({ lead, received, source: "tcd", tenantId: TENANT_ID, schema });
  assert.ok(!("Lead_Source__c" in fields));
  assert.match(fields[NOTES_FIELD], /Lead source \(not in picklist\): TCD/);
  assert.ok(warnings.some((w) => w.startsWith("Lead_Source__c")));

  // Through the handler: still a 200 create, and the warning goes to console.error.
  const d = fakeDeps({ describe: customerDescribe({ leadSources: ["Referral"] }) });
  const res = await createIntakeHandler(d)(leadEvent(PAYLOAD));
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).id, "a1PNEW000000001AAA");
  assert.ok(d.logs.error.some((l) => l.includes("Lead_Source__c")));
});

test("a wrong or missing slug is a 404 with an empty body — before anything else is looked at", async () => {
  const d = fakeDeps();
  const h = createIntakeHandler(d);
  for (const ev of [
    leadEvent(PAYLOAD, { token: "wrong" }),
    leadEvent(PAYLOAD, { token: SLUG + "x" }),
    leadEvent(PAYLOAD, { token: "" }),
    leadEvent(PAYLOAD, { token: null, resource: "/webhooks/leads/tcd" }),
    leadEvent("not json at all", { token: "wrong", contentType: "text/plain" }), // no 415 / 400 leak
    leadEvent(PAYLOAD, { resource: "/webhooks/leads/unknown/{token}" }),
    leadEvent(PAYLOAD, { method: "GET" }),
  ]) {
    const res = await h(ev);
    assert.equal(res.statusCode, 404);
    assert.equal(res.body, "");
  }
  assert.equal(d.calls.sfQuery.length, 0, "a rejected request never touches Salesforce");
  const everything = [...d.logs.log, ...d.logs.warn, ...d.logs.error].join("\n");
  assert.ok(!everything.includes(SLUG), "the slug is never logged");

  // A missing secret fails closed the same way.
  const noSecret = createIntakeHandler(fakeDeps({ secret: null }));
  const res = await noSecret(leadEvent(PAYLOAD));
  assert.equal(res.statusCode, 404);
  assert.equal(res.body, "");
});

test("content type, size and JSON shape — after the gate", async () => {
  const h = createIntakeHandler(fakeDeps());
  assert.equal((await h(leadEvent(PAYLOAD, { contentType: "text/plain" }))).statusCode, 415);
  assert.equal((await h(leadEvent({ ...PAYLOAD, junk: "x".repeat(17 * 1024) }))).statusCode, 413);
  assert.equal((await h(leadEvent("{not json"))).statusCode, 400);
  assert.equal((await h(leadEvent("[1,2]"))).statusCode, 400);
  assert.equal((await h(leadEvent(PAYLOAD, { contentType: "application/json; charset=utf-8" }))).statusCode, 200);
});

test("dedupe window: email within 30 days is a duplicate; phone only when there is no email", () => {
  const now = new Date("2026-09-29T20:00:00Z");
  const q = duplicateQuery({ lead: normalizeLead(PAYLOAD).lead, tenantId: TENANT_ID, now, esc });
  assert.equal(q.by, "email");
  assert.match(q.soql, /Client__c = 'a1W000000000001AAA'/);
  assert.match(q.soql, /CreatedDate >= 2026-08-30T20:00:00Z/); // exactly 30 days back
  assert.match(q.soql, /Primary_Email__c = 'tmurphy5213\+tcd@gmail\.com'/);

  const phoneOnly = normalizeLead({ first_name: "A", phone: "+1 602-555-0100" }).lead;
  const qp = duplicateQuery({ lead: phoneOnly, tenantId: TENANT_ID, now, esc });
  assert.equal(qp.by, "phone");
  assert.match(qp.soql, /Primary_Phone__c LIKE '%0100'/);
  // Stored formats vary; only an exact digits match counts.
  assert.equal(pickDuplicate("phone", [{ Id: "a", Primary_Phone__c: "(602) 555-9100" }, { Id: "b", Primary_Phone__c: "602.555.0100" }], phoneOnly), "b");
  assert.equal(pickDuplicate("phone", [{ Id: "a", Primary_Phone__c: "480-555-0100" }], phoneOnly), null);
  // An injection attempt in the email stays inside the literal.
  const evil = duplicateQuery({ lead: { email: "a'or'1'='1@x.com", phone: "" }, tenantId: TENANT_ID, now, esc });
  assert.match(evil.soql, /Primary_Email__c = 'a\\'or\\'1\\'=\\'1@x\.com'/);
});

test("handler: a duplicate returns the existing id and creates nothing; a new lead creates + writes the cache", async () => {
  const dup = fakeDeps({ duplicateRows: [{ Id: "a1PEXIST00000001AA" }] });
  const r1 = await createIntakeHandler(dup)(leadEvent(PAYLOAD));
  assert.equal(r1.statusCode, 200);
  assert.deepEqual(JSON.parse(r1.body), { ok: true, id: "a1PEXIST00000001AA", duplicate: true });
  assert.equal(dup.calls.create.length, 0);

  const fresh = fakeDeps();
  const r2 = await createIntakeHandler(fresh)(leadEvent(PAYLOAD));
  assert.deepEqual(JSON.parse(r2.body), { ok: true, id: "a1PNEW000000001AAA" });
  assert.equal(fresh.calls.create.length, 1);
  assert.equal(fresh.calls.create[0].Stage__c, "New");
  assert.equal(fresh.calls.upsert.length, 1, "cache row written");
  assert.equal(fresh.calls.upsert[0].client_sf_id, TENANT_ID);
  assert.equal(fresh.calls.upsert[0].tenant_id, "harmon");
});

test("a cache failure never fails the lead", async () => {
  const d = fakeDeps({ cacheColumns: new Set() });
  const res = await createIntakeHandler(d)(leadEvent(PAYLOAD));
  assert.equal(res.statusCode, 200);
  assert.ok(d.logs.warn.some((l) => l.includes("cache row")));
});

test("a Salesforce failure is a generic 502 with one masked log line", async () => {
  const err = Object.assign(new Error("Salesforce create failed (400)"), {
    sfStatus: 400,
    sfBody: JSON.stringify([{ errorCode: "INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST", message: "bad value: 1 Test St", fields: ["State__c"] }]),
  });
  const d = fakeDeps({ createError: err });
  const res = await createIntakeHandler(d)(leadEvent(PAYLOAD));
  assert.equal(res.statusCode, 502);
  assert.deepEqual(JSON.parse(res.body), { ok: false, error: "upstream_error" });
  assert.equal(d.logs.error.length, 1);
  const line = d.logs.error[0];
  assert.match(line, /t\*\*\*@gmail\.com/);
  assert.match(line, /INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST:State__c/);
  for (const v of ["tmurphy5213", "1 Test St", "6025550100"]) assert.ok(!line.includes(v), `logged "${v}"`);
  assert.equal(maskEmail("ab@x.com"), "a***@x.com");
  assert.equal(sfErrorSummary({ sfStatus: 503, sfBody: "<html>" }), "HTTP 503");
});

// --- fakes ---------------------------------------------------------------------------

function leadEvent(body, { token = SLUG, resource = "/webhooks/leads/tcd/{token}", contentType = "application/json", method = "POST" } = {}) {
  return {
    resource,
    httpMethod: method,
    headers: { "Content-Type": contentType },
    pathParameters: token === null ? null : { token },
    body: typeof body === "string" ? body : JSON.stringify(body),
    isBase64Encoded: false,
  };
}

function fakeDeps({ secret = { tcd: { token: SLUG, tenant: "harmon" } }, describe = customerDescribe(), duplicateRows = [], createError = null, cacheColumns = new Set(["sf_id", "tenant_id", "client_sf_id", "name", "primary_email", "stage", "created_date", "last_synced_at", "is_stale", "cache_version"]) } = {}) {
  const calls = { sfQuery: [], create: [], upsert: [] };
  const logs = { log: [], warn: [], error: [] };
  let created = null;
  return {
    calls, logs,
    getLeadConfig: async (source) => secret?.[source] ?? null,
    soqlEscapeString: esc,
    sfQuery: async (soql) => {
      calls.sfQuery.push(soql);
      if (soql.includes("FROM Sundial_Tenant__c")) return [{ Id: TENANT_ID }];
      if (soql.includes("CreatedDate >=") && soql.includes("LIMIT")) return duplicateRows;
      if (soql.includes("WHERE Id =")) return created ? [{ Id: "a1PNEW000000001AAA", Client__c: TENANT_ID, CreatedDate: "2026-09-29T20:00:00.000+0000", ...created }] : [];
      return [];
    },
    describeObject: async () => describe,
    sfCreateRecord: async (_obj, fields) => {
      calls.create.push(fields);
      if (createError) throw createError;
      created = fields;
      return { ok: true, id: "a1PNEW000000001AAA" };
    },
    getSupabaseClient: async () => ({ from: () => ({ upsert: async (row) => { calls.upsert.push(row); return { error: null }; } }) }),
    getCacheColumns: async () => cacheColumns,
    now: () => new Date("2026-09-29T20:00:00Z"),
    log: (m) => logs.log.push(m),
    warn: (m) => logs.warn.push(m),
    error: (m) => logs.error.push(m),
  };
}

// ===================================================================================
// Part 2 — the daily report
// ===================================================================================

test("CSV escaping: commas, quotes, newlines, formula-looking cells", () => {
  assert.equal(csvCell("plain"), "plain");
  assert.equal(csvCell("No Answer, twice"), '"No Answer, twice"');
  assert.equal(csvCell('said "call later"'), '"said ""call later"""');
  assert.equal(csvCell("line1\nline2"), '"line1\nline2"');
  assert.equal(csvCell("a\r\nb"), '"a\r\nb"');
  assert.equal(csvCell(null), "");
  assert.equal(csvCell("=HYPERLINK(\"x\")"), '"\'=HYPERLINK(""x"")"');
  assert.equal(csvCell("@sum"), "'@sum");
  const csv = buildCsv([["a,b", 'q"', "x\ny", "", "No", "", "", "No", "", "No", ""]]);
  assert.ok(csv.startsWith("\uFEFFEmail,Lead Received,"));
  assert.ok(csv.endsWith("\r\n"));
  assert.ok(csv.includes('"a,b","q""","x\ny",'));
});

test("header-only CSV on zero rows, header text exactly as TCD asked", () => {
  const csv = buildCsv([]);
  assert.equal(csv, "\uFEFF" + "Email,Lead Received,Contacted Date,Contact Disposition,Appointment Scheduled,Appointment Date,Appointment Disposition,Contract Signed,Contract Signed Date,Installed,Install Date\r\n");
  assert.equal(COLUMNS.length, 11);
});

test("Yes/No derivations and the contract-date fallback", () => {
  const base = { Id: "1", CreatedDate: "2026-09-29T20:00:00.000+0000", Primary_Email__c: "a@x.com" };
  const empty = buildRow(base, null);
  assert.deepEqual(empty, ["a@x.com", "2026-09-29", "", "", "No", "", "", "No", "", "No", ""]);

  const full = buildRow({
    ...base, First_Contact_Date__c: "2026-09-30", Contact_Disposition__c: "Contacted",
    Appointment_DateTime__c: "2026-10-02T22:30:00.000+0000", Appointment_Outcome__c: "Sold",
    Contract_Signed_Date__c: "2026-10-03", Sold_Date__c: "2026-10-09",
  }, { Install_Complete__c: "2026-11-15" });
  assert.deepEqual(full, ["a@x.com", "2026-09-29", "2026-09-30", "Contacted", "Yes", "2026-10-02 15:30", "Sold", "Yes", "2026-10-03", "Yes", "2026-11-15"]);

  const soldOnly = buildRow({ ...base, Sold_Date__c: "2026-10-09" }, { Install_Complete__c: null });
  assert.equal(soldOnly[7], "Yes");
  assert.equal(soldOnly[8], "2026-10-09");
  assert.equal(soldOnly[9], "No", "a Solar project without Install_Complete__c is not installed");
});

test("dates at the Phoenix boundary (UTC−7, no DST)", () => {
  assert.equal(toPhoenixDate("2026-09-30T06:59:59.000+0000"), "2026-09-29");
  assert.equal(toPhoenixDate("2026-09-30T07:00:00.000+0000"), "2026-09-30");
  assert.equal(toPhoenixDate("2027-01-15T06:30:00Z"), "2027-01-14", "no DST shift in winter");
  assert.equal(toPhoenixDateTime("2026-07-01T06:59:00Z"), "2026-06-30 23:59");
  assert.equal(toPhoenixDateTime("2026-12-01T19:05:00Z"), "2026-12-01 12:05");
  assert.equal(toPhoenixDate(""), "");
  assert.equal(phoenixMidnightUtc("2026-09-29"), "2026-09-29T07:00:00Z");
  assert.throws(() => phoenixMidnightUtc("9/29/2026"));
});

test("report: absent picklist columns -> empty + ONE warning each; dry run returns the CSV unsent", async () => {
  const d = reportDeps({ customerFields: ["Id", "CreatedDate", "Primary_Email__c", "First_Contact_Date__c", "Appointment_DateTime__c", "Contract_Signed_Date__c", "Sold_Date__c"] });
  const out = await createReportHandler(d)({ dryRun: true });
  assert.equal(out.dryRun, true);
  assert.equal(out.rows, 2);
  assert.equal(out.filename, "harmon-tcd-leads-2026-09-29.csv");
  assert.equal(d.sent.length, 0);
  assert.deepEqual(out.warnings, [
    "Sundial_Customer__c has no field Contact_Disposition__c — its column is empty.",
    "Sundial_Customer__c has no field Appointment_Outcome__c — its column is empty.",
  ]);
  assert.equal(d.logs.warn.length, 2);
  // The customer SOQL never names an absent field (that would fail the query).
  const q = d.queries.find((s) => s.includes("Lead_Source__c = 'TCD'"));
  assert.ok(!q.includes("Contact_Disposition__c"));
  assert.match(q, /CreatedDate >= 2026-09-29T07:00:00Z AND .* ORDER BY CreatedDate DESC$/);
  const lines = out.csv.split("\r\n");
  assert.equal(lines[1], "new@x.com,2026-09-29,,,No,,,No,,Yes,2026-11-01", "newest first; newest Solar project wins");
  assert.equal(lines[2], "old@x.com,2026-09-29,,,No,,,No,,No,");
});

test("report: ZZ test records (Last_Name__c or Name starting ZZ) are excluded in the query", async () => {
  const clause = excludeTestRecordsClause();
  assert.equal(clause, " AND (Last_Name__c = null OR (NOT Last_Name__c LIKE 'ZZ%')) AND (NOT Name LIKE 'ZZ%')");
  // A local evaluator for the clause's rule (SOQL LIKE is case-insensitive).
  const excluded = (r) => /^zz/i.test(r.Last_Name__c ?? "") || /^zz/i.test(r.Name ?? "");
  assert.equal(excluded({ Last_Name__c: "TCD TEST", Name: "ZZ TCD TEST" }), true, "the smoke-test lead");
  assert.equal(excluded({ Last_Name__c: "ZZ PORTAL TEST", Name: "x" }), true);
  assert.equal(excluded({ Last_Name__c: null, Name: "Jane" }), false, "no last name stays in");
  assert.equal(excluded({ Last_Name__c: "Lazzaro", Name: "Tony Lazzaro" }), false, "ZZ in the middle stays in");
  // Without Last_Name__c in the org, the Name test alone (never a query on a missing field).
  assert.equal(excludeTestRecordsClause(() => false), " AND (NOT Name LIKE 'ZZ%')");

  const d = reportDeps();
  await createReportHandler(d)({ dryRun: true });
  const q = d.queries.find((s) => s.includes("Lead_Source__c = 'TCD'"));
  assert.ok(q.includes(clause), "the report's own query carries the exclusion");
});

test("report: zero rows still sends (header-only), to / bcc / subject / attachment as specified", async () => {
  const d = reportDeps({ customers: [], env: { TCD_REPORT_BCC: "harmon@example.com, ops@example.com", TCD_REPORT_SINCE: "2026-09-29" } });
  const out = await createReportHandler(d)({});
  assert.equal(out.sent, true);
  assert.equal(out.rows, 0);
  const m = d.sent[0];
  assert.equal(m.to, "ryan@thecooldown.com");
  assert.deepEqual(m.bcc, ["harmon@example.com", "ops@example.com"]);
  assert.equal(m.subject, SUBJECT);
  assert.equal(m.subject, "Your Daily Report from Harmon Electric");
  assert.match(m.text, /leads received since 2026-09-29 and reflects their status as of 2026-09-29\./);
  assert.match(m.text, /— Harmon Electric/);
  assert.ok(m.html.startsWith("<p>Hello,</p>"));
  assert.equal(m.attachments[0].fileName, reportFilename("harmon", "2026-09-29"));
  assert.equal(m.attachments[0].content.toString("utf8"), buildCsv([]));
  assert.equal(d.queries.filter((s) => s.includes("Sundial_Solar__c")).length, 0, "no project query for zero customers");
});

test("report: a failed send fails the run; no EMAIL_FROM fails the run", async () => {
  await assert.rejects(createReportHandler(reportDeps({ sendResult: { ok: false, error: "throttled" } }))({}), /send failed/);
  await assert.rejects(createReportHandler(reportDeps({ emailConfigured: false }))({}), /EMAIL_FROM/);
});

function reportDeps({
  customerFields = ["Id", "Name", "Last_Name__c", "CreatedDate", "Primary_Email__c", "First_Contact_Date__c", "Contact_Disposition__c", "Appointment_DateTime__c", "Appointment_Outcome__c", "Contract_Signed_Date__c", "Sold_Date__c"],
  customers = [
    { Id: "c2", CreatedDate: "2026-09-29T21:00:00.000+0000", Primary_Email__c: "new@x.com" },
    { Id: "c1", CreatedDate: "2026-09-29T08:00:00.000+0000", Primary_Email__c: "old@x.com" },
  ],
  env = {}, sendResult = { ok: true, messageId: "m-1" }, emailConfigured = true,
} = {}) {
  const queries = [];
  const sent = [];
  const logs = { log: [], warn: [] };
  return {
    queries, sent, logs, env,
    getLeadConfig: async () => ({ token: SLUG, tenant: "harmon" }),
    soqlEscapeString: esc,
    describeObject: async () => ({ fields: customerFields.map((name) => ({ name })) }),
    sfQuery: async (soql) => {
      queries.push(soql);
      if (soql.includes("Sundial_Tenant__c")) return [{ Id: TENANT_ID }];
      if (soql.includes("FROM Sundial_Customer__c")) return customers;
      if (soql.includes("FROM Sundial_Solar__c")) {
        return [
          { Sundial_Customer__c: "c2", Install_Complete__c: "2026-11-01", CreatedDate: "2026-10-05T00:00:00.000+0000" },
          { Sundial_Customer__c: "c2", Install_Complete__c: null, CreatedDate: "2026-10-01T00:00:00.000+0000" },
        ];
      }
      return [];
    },
    isEmailConfigured: () => emailConfigured,
    sendEmail: async (msg) => { sent.push(msg); return sendResult; },
    now: () => new Date("2026-09-29T20:00:00Z"),
    log: (m) => logs.log.push(m),
    warn: (m) => logs.warn.push(m),
  };
}
