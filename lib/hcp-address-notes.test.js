// lib/hcp-address-notes.js + the web client's listCustomerAddresses (2026-10-07).
import { test } from "node:test";
import assert from "node:assert/strict";
import { addressNotesText, csvCell, planWarrantyNotes, WARRANTY_NOTES_MAX } from "./hcp-address-notes.js";
import { addressFromRow, createHcpWebClient } from "./hcp-media.js";

test("addressNotesText: none → empty; one → as typed; several → one line per address headed by the street", () => {
  assert.equal(addressNotesText([]), "");
  assert.equal(addressNotesText([{ street: "1 Main St", notes: "  " }]), "");
  assert.equal(addressNotesText([{ street: "1 Main St", notes: " Gate code 4412, dog in yard " }]), "Gate code 4412, dog in yard");
  // two addresses, only one noted: still as typed (no header needed)
  assert.equal(addressNotesText([{ street: "1 Main St", notes: "" }, { street: "9 Elm Ave", notes: "Call first" }]), "Call first");
  assert.equal(
    addressNotesText([
      { street: "1 Main St", unit: "Unit B", notes: "Gate 4412" },
      { street: "9 Elm Ave", unit: "", notes: "Inverter in garage" },
      { street: "", unit: "", city: "Mesa", notes: "Tenant: Ray" },
    ]),
    "1 Main St Unit B: Gate 4412\n9 Elm Ave: Inverter in garage\nMesa: Tenant: Ray",
  );
});

test("planWarrantyNotes: set when blank, append when other text, skip when already there or nothing to say", () => {
  assert.deepEqual(planWarrantyNotes(null, ""), { action: "skip-empty" });
  assert.deepEqual(planWarrantyNotes("", "Gate 4412"), { action: "set", value: "Gate 4412" });
  assert.deepEqual(planWarrantyNotes("Panels: 25 yr SunPower.", "Gate 4412"), { action: "append", value: "Panels: 25 yr SunPower.\n\nGate 4412" });
  // a re-run: the same text, with different spacing / case / line endings, is "present"
  assert.deepEqual(planWarrantyNotes("Panels: 25 yr.\r\n\r\nGATE  4412", "gate 4412"), { action: "skip-present" });
  assert.deepEqual(planWarrantyNotes("Gate 4412", "Gate 4412"), { action: "skip-present" });
  // never overflow the Long Text Area
  const big = "x".repeat(WARRANTY_NOTES_MAX - 3);
  assert.deepEqual(planWarrantyNotes(big, "Gate 4412"), { action: "skip-too-long" });
  assert.equal(planWarrantyNotes("", "y".repeat(WARRANTY_NOTES_MAX + 10)).value.length, WARRANTY_NOTES_MAX);
});

test("csvCell quotes commas, quotes and newlines", () => {
  assert.equal(csvCell("plain"), "plain");
  assert.equal(csvCell('a "b", c\nd'), '"a ""b"", c\nd"');
  assert.equal(csvCell(null), "");
});

test("listCustomerAddresses: the web app's { object: list, data } with notes; 404 → []; 401 → SESSION_EXPIRED", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, cookie: init.headers.Cookie });
    if (/cus_gone/.test(url)) return { status: 404, headers: new Map(), text: async () => "" };
    if (/cus_out/.test(url)) return { status: 401, headers: new Map(), text: async () => "" };
    return {
      status: 200,
      headers: new Map(),
      text: async () =>
        JSON.stringify({
          object: "list",
          data: [
            { object: "address", id: "adr_1", street: "9717 E Villa Park St", street_line_2: null, city: "Sun Lakes", state: "AZ", zip: "85248", notes: "Gate code 4412", billing: true },
            { object: "address", id: "adr_2", street: "1 Elm", street_line_2: "B", city: "Mesa", state: "AZ", zip: "85201", notes: "", billing: false },
          ],
          url: "/api/customers/cus_1/addresses",
        }),
    };
  };
  const client = createHcpWebClient({ cookie: "_s=abc", fetchImpl, sleep: async () => {}, minGapMs: 0 });
  const rows = await client.listCustomerAddresses({ customerId: "cus_1" });
  assert.equal(calls[0].cookie, "_s=abc");
  assert.ok(calls[0].url.endsWith("/api/customers/cus_1/addresses"));
  assert.deepEqual(rows[0], { id: "adr_1", street: "9717 E Villa Park St", unit: "", city: "Sun Lakes", state: "AZ", zip: "85248", notes: "Gate code 4412", billing: true });
  assert.equal(rows[1].unit, "B");
  assert.equal(addressNotesText(rows), "Gate code 4412");
  assert.deepEqual(await client.listCustomerAddresses({ customerId: "cus_gone" }), []);
  await assert.rejects(() => client.listCustomerAddresses({ customerId: "cus_out" }), (e) => e.code === "SESSION_EXPIRED");
  assert.equal(addressFromRow({ id: 1, notes: null }).notes, "");
});
