// lib/cache-row.js must map a record EXACTLY as sundial-sf-query's own copy does, until
// sf-query (and cache-sync) are switched over to the lib (TASKS.md). If this fails, one
// copy changed without the other — fix the drift, do not loosen the test.
// No module mocks: `node --test lib/cache-row.test.js`.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as lib from "./cache-row.js";
import * as sfq from "../lambdas/sundial-sf-query/index.js";
import { CUSTOMER_CREATED_DATE_SOURCE } from "../lambdas/sundial-lead-intake/intake.js";

// A customer-shaped describe: lookups, a nested relationship, excluded types, nulls,
// a field with no cache column, and every created_date source.
const DESCRIBE = {
  fields: [
    { name: "Id", type: "id" },
    { name: "Name", type: "string" },
    { name: "Client__c", type: "reference" },
    { name: "Sales_Rep__c", type: "reference" },
    { name: "Primary_Email__c", type: "email" },
    { name: "Stage__c", type: "picklist" },
    { name: "Customer_Type__c", type: "multipicklist" },
    { name: "Lead_Date__c", type: "date" },
    { name: "Active__c", type: "boolean" },
    { name: "Total_Adder_Price__c", type: "currency" },
    { name: "Not_Cached__c", type: "string" },
    { name: "Billing_Address__c", type: "address" },
    { name: "Geo__c", type: "location" },
    { name: "Sunbase_Last_Updated__c", type: "datetime" },
    { name: "Sunbase_Created_Date__c", type: "datetime" },
    { name: "CreatedDate", type: "datetime" },
  ],
};
const COLUMNS = new Set([
  "sf_id", "tenant_id", "client_sf_id", "name", "sales_rep_sf_id", "primary_email", "stage",
  "customer_type", "lead_date", "active", "total_adder_price", "created_date",
  "last_synced_at", "is_stale", "cache_version",
]);
const RECORD = {
  attributes: { type: "Sundial_Customer__c" },
  Id: "a1P7y00000AmyXCEAZ",
  Name: "ZZ PORTAL TEST",
  Client__c: "a1W000000000001AAA",
  Sales_Rep__c: "a1X000000000002AAA",
  Sales_Rep__r: { Name: "Rep" },
  Primary_Email__c: "zz@example.com",
  Stage__c: "New",
  Customer_Type__c: "Solar;Service",
  Lead_Date__c: "2026-09-29",
  Active__c: false,
  Total_Adder_Price__c: 16387.5,
  Not_Cached__c: "dropped",
  Sunbase_Last_Updated__c: null,
  Sunbase_Created_Date__c: "",
  CreatedDate: "2026-09-29T18:00:00.000+0000",
};
const CTX = { tenantId: "a1W000000000001AAA", tenantSlug: "harmon", createdDateSources: CUSTOMER_CREATED_DATE_SOURCE, now: "2026-09-29T18:00:01.000Z", cacheVersion: 1 };

test("same excluded types, same created_date sources as sf-query", () => {
  assert.deepEqual([...lib.EXCLUDED_FIELD_TYPES].sort(), [...sfq.EXCLUDED_FIELD_TYPES].sort());
  assert.deepEqual(CUSTOMER_CREATED_DATE_SOURCE, sfq.CREATED_DATE_SOURCE.customer);
});

test("sfFieldToColumn agrees on every field", () => {
  for (const f of DESCRIBE.fields) assert.equal(lib.sfFieldToColumn(f), sfq.sfFieldToColumn(f), f.name);
});

test("buildCacheSelect and mapSfRecordToCacheRow produce identical output", () => {
  const fields = lib.queryableFields(DESCRIBE);
  assert.ok(!fields.some((f) => f.type === "address" || f.type === "location"));
  const a = lib.buildCacheSelect(fields, COLUMNS, CTX.createdDateSources);
  const b = sfq.buildCacheSelect(fields, COLUMNS, CTX.createdDateSources);
  assert.deepEqual(a, b);

  const rowLib = lib.mapSfRecordToCacheRow(RECORD, a.selectFields, COLUMNS, CTX);
  const rowSfq = sfq.mapSfRecordToCacheRow(RECORD, b.selectFields, COLUMNS, CTX);
  assert.deepEqual(rowLib, rowSfq);
  // And the row is what we expect, so "identical" is not "identically empty".
  assert.equal(rowLib.sf_id, RECORD.Id);
  assert.equal(rowLib.sales_rep_sf_id, RECORD.Sales_Rep__c);
  assert.equal(rowLib.active, false);
  assert.equal(rowLib.created_date, RECORD.CreatedDate, "COALESCE skips null and empty sources");
  assert.equal(rowLib.tenant_id, "harmon");
  assert.equal(rowLib.cache_version, 1);
  assert.ok(!("not_cached" in rowLib));
});

test("writeRecordToCache reads back tenant-filtered and upserts one row on sf_id", async () => {
  const seen = { soql: null, upsert: null };
  const supabase = { from: (t) => ({ upsert: async (row, opts) => { seen.upsert = { t, row, opts }; return { error: null }; } }) };
  const ok = await lib.writeRecordToCache({
    supabase,
    sfQuery: async (soql) => { seen.soql = soql; return [RECORD]; },
    soqlEscapeString: (s) => String(s).replace(/'/g, "\\'"),
    sfObject: "Sundial_Customer__c", cacheTable: "sundial_customer_cache",
    fields: lib.queryableFields(DESCRIBE), columnSet: COLUMNS,
    id: RECORD.Id, tenantId: CTX.tenantId, tenantSlug: "harmon", createdDateSources: CTX.createdDateSources, now: CTX.now,
  });
  assert.equal(ok, true);
  assert.match(seen.soql, /WHERE Id = 'a1P7y00000AmyXCEAZ' AND Client__c = 'a1W000000000001AAA' LIMIT 1$/);
  assert.equal(seen.upsert.t, "sundial_customer_cache");
  assert.deepEqual(seen.upsert.opts, { onConflict: "sf_id" });
  assert.equal(seen.upsert.row.client_sf_id, CTX.tenantId);
});
