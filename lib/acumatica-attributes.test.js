// Tests for the Acumatica project attribute builder.
//
// The values pinned here come from the LIVE enumeration of project R251282 (§7). That
// matters more than usual: attributes are the numbers Harmon's accounting reporting
// reads, and every one of them is derivable two or three plausible ways. The live pull
// is the only thing that says which way is right.
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildProjectAttributes, split7525, splitRepThirdParty, formatAttributeValue,
  DATE_ATTRIBUTES, attributeFieldNames, M1_SHARE, REP_M1_CAP,
  ATTRIBUTE_DECIMALS, attributeDatePart, attributeValueMatches, verifyAttributeWrite,
  ATTR_GATE, syncProjectAttributes,
  NON_COMMISSION_ATTRIBUTES, nonCommissionFieldNames,
  ATTRIBUTE_SYNC_FIELDS, ATTRIBUTE_SYNC_STATUSES, buildAttributeSyncWriteback,
} from "./acumatica-attributes.js";

/** R251282's shape: 12.76 kW, third-party, 7,314 rep commission. */
const LIVE = {
  Commission_Deal_Type__c: "3rd Party",
  System_Size__c: 12.76,
  Sales_Company_Harmon_Solar_or_Third__c: "Familia Sicairos",
  Sales_Rep_Commission_Amt__c: 7314,
  Sales_Mgr_Commission_Amt__c: 510.4,   // .04 x 12760 W
  Overhead_Commission_Amt__c: 191.4,    // .015 x 12760 W
  Audit_Date_and_DateTime__c: "2026-07-14",
  Approved_for_Design_Date__c: "2026-07-20",
  Scheduled_Install_Date__c: "2026-08-01",
  Inspection_Pass_Date__c: "2026-08-10",
  Commission_of_System__c: "2026-08-15",
};

const asMap = (values, opts) =>
  Object.fromEntries(buildProjectAttributes(values, opts).attributes.map((a) => [a.AttributeID, a.Value]));

test("reproduces the live R251282 commission attributes exactly — TEXTUALLY, not just numerically", () => {
  // The four numbers verified against the live pull: SLSCOM 2500.00/4814.00 (the cap
  // biting), MGRCOM 382.80/127.60, MGMTOR 143.55/47.85. If a refactor changes any of
  // these, it has changed what Harmon's reports say people were paid.
  //
  // The TRAILING ZEROS are pinned deliberately (Q17, ruled 2026-08-24). Attributes are
  // string-valued and Acumatica stores exactly what it is given, so `String(2500)` really
  // does land in a reporting field as `2500` beside a hand-entered `1538.00`. This
  // assertion used to read "2500" and "382.8" — numerically identical to the live pull,
  // textually different from every value already in the system.
  const m = asMap(LIVE);
  assert.equal(m.SLSCOM1, "2500.00");
  assert.equal(m.SLSCOM2, "4814.00");
  assert.equal(m.MGRCOM1, "382.80");
  assert.equal(m.MGRCOM2, "127.60");
  assert.equal(m.MGMTOR1, "143.55");
  assert.equal(m.MGMTOR2, "47.85");
});

test("KW carries THREE decimals, matching the live 8.360", () => {
  // Harmon's convention is per-attribute, not one rule for all numbers: money is 2dp and
  // KW is 3dp. Live R261065 held `8.360`.
  assert.equal(asMap(LIVE).KW, "12.760");
  assert.equal(asMap({ ...LIVE, System_Size__c: 8.36 }).KW, "8.360");
  assert.equal(ATTRIBUTE_DECIMALS.KW, 3);
});

test("every numeric attribute has a decimal rule, and no text attribute has one", () => {
  // A money attribute missing from the map would silently go back to unpadded output,
  // which is the exact bug Q17 fixed.
  assert.deepEqual(
    Object.keys(ATTRIBUTE_DECIMALS).sort(),
    ["KW", "MGMTOR1", "MGMTOR2", "MGRCOM1", "MGRCOM2", "SLSCOM1", "SLSCOM2"]
  );
  for (const a of DATE_ATTRIBUTES) {
    assert.equal(ATTRIBUTE_DECIMALS[a.attributeId], undefined, `${a.attributeId} is a date, not a number`);
  }
  for (const id of ["JOBTYPE", "SALESPERSO"]) {
    assert.equal(ATTRIBUTE_DECIMALS[id], undefined, `${id} is text`);
  }
});

test("padding never turns a non-numeric value into NaN", () => {
  // Defensive: if a text value ever reaches an attribute with a decimals rule, passing it
  // through is recoverable and "NaN" in a reporting field is not.
  assert.equal(formatAttributeValue("not a number", 2), "not a number");
  assert.equal(formatAttributeValue("", 2), "");
  assert.equal(formatAttributeValue(null, 2), "");
  // ...and a numeric STRING still pads, since that is what Salesforce often hands over.
  assert.equal(formatAttributeValue("2500", 2), "2500.00");
  assert.equal(formatAttributeValue(" 8.36 ", 3), "8.360");
});

test("SALESPERSO comes from the sales-company field (Q10, resolved)", () => {
  const m = asMap(LIVE);
  assert.equal(m.SALESPERSO, "Familia Sicairos");
  // Internal jobs carry the literal "Harmon Solar" — the attribute is named "Sales
  // Person" but holds the selling COMPANY, which is what the live data shows.
  const internal = asMap({ ...LIVE, Sales_Company_Harmon_Solar_or_Third__c: "Harmon Solar", Commission_Deal_Type__c: "Internal", Internal_Rep_Commission_Amt__c: 7314 });
  assert.equal(internal.SALESPERSO, "Harmon Solar");
});

test("the five lifecycle dates map to the fields the describe confirmed", () => {
  const m = asMap(LIVE);
  assert.equal(m.AUDITDATE, "2026-07-14");
  assert.equal(m.INDESIGN, "2026-07-20");
  assert.equal(m.INCOMDATE, "2026-08-01");
  assert.equal(m.GREENTAG, "2026-08-10");
  assert.equal(m.COMDATE, "2026-08-15");
  assert.equal(DATE_ATTRIBUTES.length, 5);
});

test("KW is the system size and JOBTYPE comes from the caller", () => {
  assert.equal(asMap(LIVE).KW, "12.760");
  assert.equal(asMap(LIVE, { jobType: "RSDC" }).JOBTYPE, "RSDC");
  // Without it, JOBTYPE is omitted rather than guessed — the template code is known at
  // Layer-1 push time and nowhere else.
  assert.ok(buildProjectAttributes(LIVE).omitted.includes("JOBTYPE"));
});

// ---------------------------------------------------------------------------
// The split that is not the same split
// ---------------------------------------------------------------------------

test("INTERNAL rep commission splits 75/25, NOT by the third-party milestone rule", () => {
  // D16: an internal deal raises no PO but still gets SLSCOM1/2. Using the third-party
  // rule would cap the first payment at 2,500 and understate it on every internal job
  // over $5,000 — which under D19's redline model is most of them.
  const m = asMap({ ...LIVE, Commission_Deal_Type__c: "Internal", Internal_Rep_Commission_Amt__c: 14032, Sales_Rep_Commission_Amt__c: 0 });
  assert.equal(m.SLSCOM1, "10524.00");   // 75% of 14032
  assert.equal(m.SLSCOM2, "3508.00");    // 25%
  // Emphatically not the capped rule:
  assert.notEqual(m.SLSCOM1, "2500.00");
});

test("an internal deal reads the INTERNAL amount field, not the third-party one", () => {
  // The two amounts live in different fields (D19 routes one or the other), and reading
  // the wrong one would silently report zero commission on every internal job.
  const m = asMap({ ...LIVE, Commission_Deal_Type__c: "Internal", Internal_Rep_Commission_Amt__c: 8000, Sales_Rep_Commission_Amt__c: 0 });
  assert.equal(m.SLSCOM1, "6000.00");
});

test("manager and overhead are 75/25 whichever way the deal was sold", () => {
  const ext = asMap(LIVE);
  const int = asMap({ ...LIVE, Commission_Deal_Type__c: "Internal", Internal_Rep_Commission_Amt__c: 9000 });
  for (const k of ["MGRCOM1", "MGRCOM2", "MGMTOR1", "MGMTOR2"]) {
    assert.equal(ext[k], int[k], `${k} should not depend on deal type`);
  }
});

test("manager and overhead stay SEPARATE attributes, never summed", () => {
  // D10 keeps them as two stored components precisely so this split is possible. The
  // budget's SLMC line sums them; doing that here too would collapse MGRCOM and MGMTOR
  // into one number and lose the distinction the attributes exist to make.
  const m = asMap(LIVE);
  const summed = split7525(510.4 + 191.4);
  assert.notEqual(m.MGRCOM1, String(summed.m1));
  assert.equal(Number(m.MGRCOM1) + Number(m.MGMTOR1), summed.m1);
});

test("both splits always sum to their total, to the cent", () => {
  for (const total of [0.01, 1, 33.33, 510.4, 1234.57, 4999.99, 5000.01, 7314, 99999.99]) {
    const a = split7525(total);
    assert.equal(Math.round((a.m1 + a.m2) * 100) / 100, Math.round(total * 100) / 100, `75/25 of ${total}`);
    const b = splitRepThirdParty(total);
    assert.equal(Math.round((b.m1 + b.m2) * 100) / 100, Math.round(total * 100) / 100, `rep split of ${total}`);
  }
  assert.equal(M1_SHARE, 0.75);
  assert.equal(REP_M1_CAP, 2500);
});

// ---------------------------------------------------------------------------
// Blanks
// ---------------------------------------------------------------------------

test("a blank date is OMITTED, never written as an empty string", () => {
  // This is the property that stops the sync being able to erase things. A milestone
  // that has not happened is not a milestone someone cleared, and an unreached date
  // written as "" would wipe a value entered in Acumatica by hand.
  const { attributes, omitted } = buildProjectAttributes({ ...LIVE, Inspection_Pass_Date__c: null, Commission_of_System__c: "" });
  const ids = attributes.map((a) => a.AttributeID);
  assert.ok(!ids.includes("GREENTAG"));
  assert.ok(!ids.includes("COMDATE"));
  assert.ok(omitted.includes("GREENTAG") && omitted.includes("COMDATE"));
  // ...and nothing was emitted with an empty value.
  for (const a of attributes) assert.notEqual(a.Value, "");
});

test("zero commissions omit their milestone pair rather than writing 0", () => {
  const { attributes, omitted } = buildProjectAttributes({ ...LIVE, Sales_Rep_Commission_Amt__c: 0, Overhead_Commission_Amt__c: 0 });
  const ids = attributes.map((a) => a.AttributeID);
  for (const k of ["SLSCOM1", "SLSCOM2", "MGMTOR1", "MGMTOR2"]) {
    assert.ok(!ids.includes(k), `${k} should be omitted`);
    assert.ok(omitted.includes(k));
  }
  // The manager pair is unaffected — omission is per-pair, not all-or-nothing.
  assert.ok(ids.includes("MGRCOM1"));
});

test("a totally empty record produces no attributes and no crash", () => {
  const { attributes, omitted } = buildProjectAttributes({});
  assert.deepEqual(attributes, []);
  assert.ok(omitted.length >= 13);
});

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

test("a Salesforce DateTime is reduced to its date", () => {
  // Attributes here are calendar dates. Keeping the time would put a meaningless
  // 00:00:00Z into a reporting field, and reformatting is where timezones creep into a
  // value that never had one.
  assert.equal(formatAttributeValue("2026-07-14T00:00:00.000+0000"), "2026-07-14");
  assert.equal(formatAttributeValue("2026-07-14"), "2026-07-14");
  assert.equal(formatAttributeValue(new Date("2026-07-14T12:00:00Z")), "2026-07-14");
});

test("every value is a string, because attributes are string-valued", () => {
  for (const a of buildProjectAttributes(LIVE, { jobType: "RS" }).attributes) {
    assert.equal(typeof a.Value, "string", `${a.AttributeID} is ${typeof a.Value}`);
    assert.equal(typeof a.AttributeID, "string");
  }
});

// ---------------------------------------------------------------------------
// Verify by re-read (D24) — because a 200 is not evidence
// ---------------------------------------------------------------------------

/** Acumatica's read-back shape, including the timestamp form it echoes dates in. */
const back = (pairs) =>
  Object.entries(pairs).map(([AttributeID, Value]) => ({
    AttributeID: { value: AttributeID },
    Value: { value: Value },
  }));

test("a clean round-trip verifies", () => {
  const sent = buildProjectAttributes(LIVE, { jobType: "RS" }).attributes;
  const echoed = back(Object.fromEntries(sent.map((a) => [
    a.AttributeID,
    // Acumatica echoes dates as timestamps and everything else verbatim.
    /^\d{4}-\d{2}-\d{2}$/.test(a.Value) ? `${a.Value} 00:00:00.000` : a.Value,
  ])));
  assert.deepEqual(verifyAttributeWrite(sent, echoed), { ok: true, missing: [], mismatched: [] });
});

test("DATES COMPARE BY DATE PART — otherwise every date reads as a failed write", () => {
  // We send `2026-07-14`; Acumatica echoes `2026-07-14 00:00:00.000`. A string comparison
  // would flag all five lifecycle dates on every single run, and a check that always
  // cries wolf gets switched off — which is worse than not having one.
  assert.equal(attributeDatePart("2026-07-14 00:00:00.000"), "2026-07-14");
  assert.equal(attributeDatePart("2026-07-14T00:00:00+00:00"), "2026-07-14");
  assert.equal(attributeDatePart("2026-07-14"), "2026-07-14");
  assert.equal(attributeDatePart("Familia Sicairos"), null);

  assert.ok(attributeValueMatches("2026-07-14", "2026-07-14 00:00:00.000"));
  assert.ok(attributeValueMatches("2026-07-14", "2026-07-14T00:00:00+00:00"));
  // A genuinely different date is still caught.
  assert.ok(!attributeValueMatches("2026-07-14", "2026-07-15 00:00:00.000"));
});

test("AN ATTRIBUTE ACCEPTED WITH A 200 AND THEN DISCARDED IS REPORTED MISSING", () => {
  // The whole point. `NOTAREALATTR` got a 200 on 2026-08-24 and never appeared, so a
  // template change that drops an attribute looks exactly like success. Only the re-read
  // can tell the difference.
  const sent = [
    { AttributeID: "KW", Value: "12.760" },
    { AttributeID: "NOTAREALATTR", Value: "x" },
  ];
  const r = verifyAttributeWrite(sent, back({ KW: "12.760" }));
  assert.equal(r.ok, false);
  assert.deepEqual(r.missing, ["NOTAREALATTR"]);
  assert.deepEqual(r.mismatched, []);
});

test("a value that came back different is reported with both sides", () => {
  const sent = [{ AttributeID: "SLSCOM1", Value: "2500.00" }];
  const r = verifyAttributeWrite(sent, back({ SLSCOM1: "1538.00" }));
  assert.equal(r.ok, false);
  assert.deepEqual(r.mismatched, [{ attributeId: "SLSCOM1", sent: "2500.00", got: "1538.00" }]);
});

test("verification ignores attributes we did not send", () => {
  // The PUT merges (D24), so the project legitimately carries values this run had no
  // opinion about. Flagging them would make every run noisy for no reason.
  const sent = [{ AttributeID: "KW", Value: "12.760" }];
  const r = verifyAttributeWrite(sent, back({ KW: "12.760", SALESPERSO: "Property Upgrades", JOBTYPE: "RS" }));
  assert.equal(r.ok, true);
});

test("verification survives an empty or malformed read-back rather than throwing", () => {
  const sent = [{ AttributeID: "KW", Value: "12.760" }];
  for (const bad of [[], null, undefined, [{}], [{ AttributeID: { value: "KW" } }]]) {
    const r = verifyAttributeWrite(sent, bad);
    assert.equal(r.ok, false, "an unreadable read-back is not a pass");
  }
  // A read-back holding a blank value is a mismatch, not a match — step 6 proved '' is a
  // real stored state, so it means the write was cleared rather than absent.
  const cleared = verifyAttributeWrite(sent, back({ KW: "" }));
  assert.equal(cleared.ok, false);
  assert.equal(cleared.mismatched[0].got, "");
});

// ---------------------------------------------------------------------------
// syncProjectAttributes — the write path
// ---------------------------------------------------------------------------

/**
 * A fake Acumatica that MERGES, as the hand-proof proved the real one does, echoes dates
 * as timestamps, and silently discards attributes outside `defined` — the 200-and-drop
 * behaviour that verification exists to catch.
 */
function fakeAcumatica({ existing = { JOBTYPE: "RS" }, defined = null, writeStatus = 200, readStatus = 200 } = {}) {
  const store = { ...existing };
  const allowed = defined; // null = the template defines everything
  const calls = { puts: [], gets: 0 };
  return {
    calls,
    store,
    deps: {
      getAcumaticaEntity: async () => {
        calls.gets++;
        if (readStatus !== 200) return { ok: false, status: readStatus, text: "read boom" };
        return {
          ok: true, status: 200,
          data: [{
            id: "project-guid-1",
            Attributes: Object.entries(store).map(([k, v]) => ({ AttributeID: { value: k }, Value: { value: v } })),
          }],
        };
      },
      putAcumaticaEntity: async (_entity, body) => {
        calls.puts.push(body);
        if (writeStatus !== 200) return { ok: false, status: writeStatus, text: "write boom" };
        for (const a of body.Attributes ?? []) {
          const id = a.AttributeID.value;
          if (allowed && !allowed.includes(id)) continue; // 200, silently discarded
          store[id] = /^\d{4}-\d{2}-\d{2}$/.test(a.Value.value)
            ? `${a.Value.value} 00:00:00.000`
            : a.Value.value;
        }
        return { ok: true, status: 200, data: {}, text: "" };
      },
    },
  };
}

test("ATTR_GATE is OPEN, and its committed value is pinned", () => {
  // Opened 2026-08-24 after the hand-proof settled merge-vs-replace. A repo constant, not
  // an env var, so closing it — the emergency stop — is also a reviewed diff.
  assert.equal(ATTR_GATE.enabled, true, "ATTR_GATE is open — see the attribute runbook §Results and D-060");
});

test("a clean sync writes every non-blank attribute and verifies it", async () => {
  const f = fakeAcumatica();
  const r = await syncProjectAttributes("R261065", LIVE, { deps: f.deps });
  assert.equal(r.ok, true);
  assert.equal(r.action, "synced");
  assert.equal(f.calls.puts.length, 1);
  // The PUT addresses the project by the guid from THIS run's read.
  assert.equal(f.calls.puts[0].id, "project-guid-1");
  // Padded per Q17, and the date attributes present.
  assert.equal(f.store.SLSCOM1, "2500.00");
  assert.equal(f.store.KW, "12.760");
  assert.equal(f.store.AUDITDATE, "2026-07-14 00:00:00.000");
});

test("AN ATTRIBUTE SILENTLY DISCARDED WITH A 200 FAILS THE SYNC", async () => {
  // The standing hazard, end to end: the template no longer defines GREENTAG, Acumatica
  // takes the write and drops it, and the status code says nothing. Only the re-read
  // notices — which is the entire reason this stage verifies.
  const f = fakeAcumatica({ defined: ["AUDITDATE", "INDESIGN", "INCOMDATE", "COMDATE", "KW", "SALESPERSO", "SLSCOM1", "SLSCOM2", "MGRCOM1", "MGRCOM2", "MGMTOR1", "MGMTOR2"] });
  const r = await syncProjectAttributes("R261065", LIVE, { deps: f.deps });
  assert.equal(r.ok, false);
  assert.equal(r.action, "unverified");
  assert.deepEqual(r.missing, ["GREENTAG"]);
  assert.match(r.message, /discarded/);
});

test("dates round-tripping as timestamps do NOT read as failures", async () => {
  // The regression that would make the verification useless: Acumatica echoes every date
  // as `... 00:00:00.000`, so a string comparison would fail all five, every run.
  const f = fakeAcumatica();
  const r = await syncProjectAttributes("R261065", LIVE, { deps: f.deps });
  assert.equal(r.ok, true, "date echo format must not be read as a mismatch");
});

test("JOBTYPE is not sent, so the merge leaves what Layer-1 wrote", async () => {
  // The budget push cannot know RS vs RSDC authoritatively — it can only infer it from
  // which lines a scaffold has, and inference is not authority. Saying nothing is how the
  // existing value survives.
  const f = fakeAcumatica({ existing: { JOBTYPE: "RSDC" } });
  await syncProjectAttributes("R261065", LIVE, { deps: f.deps });
  const sentIds = f.calls.puts[0].Attributes.map((a) => a.AttributeID.value);
  assert.ok(!sentIds.includes("JOBTYPE"));
  assert.equal(f.store.JOBTYPE, "RSDC", "the existing value must survive untouched");
});

test("a record with nothing known writes NOTHING rather than a set of empty strings", async () => {
  const f = fakeAcumatica();
  const r = await syncProjectAttributes("R261065", {}, { deps: f.deps });
  assert.equal(r.ok, true);
  assert.equal(r.action, "nothing_to_write");
  assert.equal(f.calls.puts.length, 0, "blanks are omitted, and all-blank means no PUT at all");
});

test("the gate CLOSED means nothing is read or written", async () => {
  const prior = ATTR_GATE.enabled;
  ATTR_GATE.enabled = false;
  try {
    const f = fakeAcumatica();
    const r = await syncProjectAttributes("R261065", LIVE, { deps: f.deps });
    assert.equal(r.ok, false);
    assert.equal(r.action, "blocked");
    assert.equal(f.calls.puts.length, 0);
    assert.equal(f.calls.gets, 0);
  } finally {
    ATTR_GATE.enabled = prior;
  }
});

test("a failed write, a failed verifying re-read and a missing project are distinct outcomes", async () => {
  const write = await syncProjectAttributes("R261065", LIVE, { deps: fakeAcumatica({ writeStatus: 500 }).deps });
  assert.equal(write.action, "write_failed");

  const read = await syncProjectAttributes("R261065", LIVE, { deps: fakeAcumatica({ readStatus: 500 }).deps });
  assert.equal(read.action, "read_failed");

  const gone = await syncProjectAttributes("R261065", LIVE, {
    deps: { getAcumaticaEntity: async () => ({ ok: true, status: 200, data: [] }), putAcumaticaEntity: async () => { throw new Error("must not write"); } },
  });
  assert.equal(gone.action, "project_not_found");

  const noId = await syncProjectAttributes("", LIVE, {
    deps: { getAcumaticaEntity: async () => { throw new Error("must not read"); }, putAcumaticaEntity: async () => { throw new Error("must not write"); } },
  });
  assert.equal(noId.action, "refused");
});

test("attributeFieldNames covers every field the builder reads", () => {
  const names = attributeFieldNames();
  for (const a of DATE_ATTRIBUTES) assert.ok(names.includes(a.field), `${a.field} missing`);
  for (const f of ["System_Size__c", "Sales_Company_Harmon_Solar_or_Third__c", "Commission_Deal_Type__c",
    "Sales_Rep_Commission_Amt__c", "Internal_Rep_Commission_Amt__c", "Sales_Mgr_Commission_Amt__c",
    "Overhead_Commission_Amt__c"]) {
    assert.ok(names.includes(f), `${f} missing`);
  }
  assert.equal(new Set(names).size, names.length, "duplicate field name");
});

// ---------------------------------------------------------------------------
// The attribute-only scope (NON_COMMISSION_ATTRIBUTES)
// ---------------------------------------------------------------------------

test("THE ATTRIBUTE-ONLY SET CANNOT CARRY A COMMISSION FIGURE", () => {
  // The load-bearing test for the legacy path. Harmon hand-enters SLSCOM/MGRCOM/MGMTOR on
  // projects the integration never calculated (R261065 held 1538.00/2138.00, matching no
  // rule we have). If any of those six ever enters this set, the attribute-only sync
  // starts overwriting figures a person typed in.
  for (const id of ["SLSCOM1", "SLSCOM2", "MGRCOM1", "MGRCOM2", "MGMTOR1", "MGMTOR2"]) {
    assert.ok(!NON_COMMISSION_ATTRIBUTES.includes(id), `${id} must never be in the attribute-only set`);
  }
  // JOBTYPE is out too - RS/RSDC is authoritative at Layer-1 creation and nothing here
  // can do better than infer it.
  assert.ok(!NON_COMMISSION_ATTRIBUTES.includes("JOBTYPE"));
  assert.deepEqual(
    [...NON_COMMISSION_ATTRIBUTES].sort(),
    ["AUDITDATE", "COMDATE", "GREENTAG", "INCOMDATE", "INDESIGN", "KW", "SALESPERSO"]
  );
});

test("`only` filters at BUILD time, so a caller cannot forget it", () => {
  const { attributes } = buildProjectAttributes(LIVE, { only: NON_COMMISSION_ATTRIBUTES });
  const ids = attributes.map((a) => a.AttributeID);
  assert.deepEqual(ids.sort(), ["AUDITDATE", "COMDATE", "GREENTAG", "INCOMDATE", "INDESIGN", "KW", "SALESPERSO"]);
  // The same record built unrestricted DOES carry the commission attributes - proving the
  // filter is what excluded them, not an accident of the fixture.
  const full = buildProjectAttributes(LIVE).attributes.map((a) => a.AttributeID);
  assert.ok(full.includes("SLSCOM1") && full.includes("MGRCOM1"));
});

test("JOBTYPE is excluded by scope even when a caller passes one", () => {
  const { attributes } = buildProjectAttributes(LIVE, { jobType: "RSDC", only: NON_COMMISSION_ATTRIBUTES });
  assert.ok(!attributes.some((a) => a.AttributeID === "JOBTYPE"));
});

test("out-of-scope is not the same as omitted-because-blank", () => {
  // `omitted` means "we have no value for this". Listing attributes this path does not
  // own would make an empty legacy record look like it was missing twelve values, not five.
  const { omitted } = buildProjectAttributes(
    { ...LIVE, Inspection_Pass_Date__c: null },
    { only: NON_COMMISSION_ATTRIBUTES }
  );
  assert.ok(omitted.includes("GREENTAG"), "a blank in-scope date is still reported");
  for (const id of ["SLSCOM1", "MGRCOM1", "MGMTOR1", "JOBTYPE"]) {
    assert.ok(!omitted.includes(id), `${id} is out of scope, not missing`);
  }
});

test("a legacy record with ONLY dates still syncs, and touches nothing else", async () => {
  // The case this whole path exists for: no contract, no commissions, no deal type -
  // exactly the record the push worker's gates would (correctly) refuse.
  const f = fakeAcumatica({
    existing: { JOBTYPE: "RS", SLSCOM1: "1538.00", SLSCOM2: "2138.00", MGRCOM1: "250.80" },
  });
  const legacy = {
    Audit_Date_and_DateTime__c: "2026-06-19",
    Scheduled_Install_Date__c: "2026-07-01",
    System_Size__c: 8.36,
  };
  const r = await syncProjectAttributes("R261065", legacy, {
    only: NON_COMMISSION_ATTRIBUTES,
    deps: f.deps,
  });
  assert.equal(r.ok, true);
  assert.equal(f.store.AUDITDATE, "2026-06-19 00:00:00.000");
  assert.equal(f.store.KW, "8.360");
  // Every hand-entered value survives, untouched.
  assert.equal(f.store.SLSCOM1, "1538.00");
  assert.equal(f.store.SLSCOM2, "2138.00");
  assert.equal(f.store.MGRCOM1, "250.80");
  assert.equal(f.store.JOBTYPE, "RS");
  // ...and none of them was even in the request body.
  const sent = f.calls.puts[0].Attributes.map((a) => a.AttributeID.value);
  for (const id of ["SLSCOM1", "SLSCOM2", "MGRCOM1", "JOBTYPE"]) assert.ok(!sent.includes(id));
});

test("an EMPTY legacy record writes nothing rather than blanking a hand-entered value", async () => {
  // Belt and braces behind the scope filter: even in scope, a blank is omitted, so a
  // record with no data at all cannot clear anything.
  const f = fakeAcumatica({ existing: { SLSCOM1: "1538.00", AUDITDATE: "2026-06-19 00:00:00.000" } });
  const r = await syncProjectAttributes("R261065", {}, { only: NON_COMMISSION_ATTRIBUTES, deps: f.deps });
  assert.equal(r.action, "nothing_to_write");
  assert.equal(f.calls.puts.length, 0);
  assert.equal(f.store.SLSCOM1, "1538.00");
  assert.equal(f.store.AUDITDATE, "2026-06-19 00:00:00.000");
});

test("verification is still mandatory on this path", async () => {
  // The silent-200 hazard does not care which path is writing.
  const f = fakeAcumatica({ defined: ["AUDITDATE", "KW"] });
  const r = await syncProjectAttributes("R261065", LIVE, { only: NON_COMMISSION_ATTRIBUTES, deps: f.deps });
  assert.equal(r.ok, false);
  assert.equal(r.action, "unverified");
  assert.ok(r.missing.includes("SALESPERSO"));
});

test("nonCommissionFieldNames is a strict subset of attributeFieldNames", () => {
  const all = new Set(attributeFieldNames());
  const some = nonCommissionFieldNames();
  for (const f of some) assert.ok(all.has(f), `${f} is not in the full field list`);
  for (const a of DATE_ATTRIBUTES) assert.ok(some.includes(a.field), `${a.field} missing`);
  assert.ok(some.includes("System_Size__c") && some.includes("Sales_Company_Harmon_Solar_or_Third__c"));
  // And it must NOT pull the commission fields - a SELECT that reads them invites a
  // future edit that sends them.
  for (const f of ["Sales_Rep_Commission_Amt__c", "Internal_Rep_Commission_Amt__c",
    "Sales_Mgr_Commission_Amt__c", "Overhead_Commission_Amt__c", "Commission_Deal_Type__c"]) {
    assert.ok(!some.includes(f), `${f} must not be read by the attribute-only path`);
  }
});

// ---------------------------------------------------------------------------
// The shared Salesforce write-back
// ---------------------------------------------------------------------------

test("every status the write-back produces is in the restricted picklist", () => {
  assert.deepEqual([...ATTRIBUTE_SYNC_STATUSES], ["Synced", "Nothing to Sync", "Unverified", "Failed"]);
  const S = ATTRIBUTE_SYNC_FIELDS.status;
  const produced = [
    buildAttributeSyncWriteback({ ok: true, action: "synced" }, "T")[S],
    buildAttributeSyncWriteback({ ok: true, action: "nothing_to_write" }, "T")[S],
    buildAttributeSyncWriteback({ ok: false, action: "unverified", message: "x" }, "T")[S],
    buildAttributeSyncWriteback({ ok: false, action: "write_failed", message: "x" }, "T")[S],
    buildAttributeSyncWriteback({ ok: false, action: "read_failed" }, "T")[S],
    buildAttributeSyncWriteback({ ok: false, action: "project_not_found" }, "T")[S],
  ];
  for (const s of produced) assert.ok(ATTRIBUTE_SYNC_STATUSES.includes(s), `${s} is not a valid picklist value`);
});

test("UNVERIFIED IS NOT FAILED - they need different responses", () => {
  // Failed means the write did not happen. Unverified means it may have, and Acumatica
  // did not confirm it: the silent-200 case this verification exists to surface.
  const S = ATTRIBUTE_SYNC_FIELDS.status;
  assert.equal(buildAttributeSyncWriteback({ ok: false, action: "unverified", message: "x" }, "T")[S], "Unverified");
  assert.equal(buildAttributeSyncWriteback({ ok: false, action: "write_failed", message: "x" }, "T")[S], "Failed");
});

test("Attribute_Synced_At__c means 'last known good' and does NOT move on failure", () => {
  const A = ATTRIBUTE_SYNC_FIELDS.syncedAt;
  assert.equal(buildAttributeSyncWriteback({ ok: true, action: "synced" }, "T")[A], "T");
  // Stamped on "nothing to sync" too: the sync RAN and had nothing to say, which is a
  // different fact from never having run (blank status carries that).
  assert.equal(buildAttributeSyncWriteback({ ok: true, action: "nothing_to_write" }, "T")[A], "T");
  assert.ok(!(A in buildAttributeSyncWriteback({ ok: false, action: "write_failed" }, "T")));
  assert.ok(!(A in buildAttributeSyncWriteback({ ok: false, action: "unverified" }, "T")));
});

test("a clean run CLEARS the error, and the gate being shut writes nothing at all", () => {
  const E = ATTRIBUTE_SYNC_FIELDS.error;
  assert.equal(buildAttributeSyncWriteback({ ok: true, action: "synced" }, "T")[E], null);
  // Same reasoning as the PO engine: the gate being closed is not a fact about the job.
  assert.equal(buildAttributeSyncWriteback({ ok: false, action: "blocked" }, "T"), null);
});

test("the error message is captured and capped to the field length", () => {
  const E = ATTRIBUTE_SYNC_FIELDS.error;
  const long = "x".repeat(9000);
  const out = buildAttributeSyncWriteback({ ok: false, action: "unverified", message: long }, "T");
  assert.equal(out[E].length, 4000, "must fit Attribute_Sync_Error__c(4000)");
  // And it falls back through the shapes a result can carry rather than writing "undefined".
  assert.match(buildAttributeSyncWriteback({ ok: false, action: "read_failed", error: "boom" }, "T")[E], /boom/);
  assert.match(buildAttributeSyncWriteback({ ok: false, action: "project_not_found" }, "T")[E], /project_not_found/);
});
