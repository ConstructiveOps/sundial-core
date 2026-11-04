// node --test lib/report-types.test.js
//
// Pinned (D-088, D-089): every report type is consistent with the GENERATED catalog — each
// alias's object has a catalog, every `on` column exists there, a join's left alias is
// declared BEFORE it (the SQL builds joins in order), every default column is reportable,
// short and ungated; the join kinds are lookup / latest / rollup, a lookup's right side is
// sf_id; a latest / rollup `where` names text columns; a rollup's measures name real,
// UNGATED number / date columns (the function checks a measure's source gate when it builds
// the join, so a gated source would refuse the whole report to a Manager). And the ten types
// are exactly the D-089 list with the joins Tim approved.

import test from "node:test";
import assert from "node:assert/strict";
import { REPORT_TYPES, reportType, aliasesOf, fieldsOf, joinOf, describeTypes } from "./report-types.js";
import { CATALOG } from "./report-catalog/index.js";

const ALIAS_RE = /^[a-z][a-z0-9_]{0,30}$/; // sql/sundial_report_run.sql alias_re
const NAME_RE = /^[a-z][a-z0-9_]{0,62}$/; // its name_re
const TEXT_TYPES = new Set(["text", "picklist", "multipicklist", "reference"]);

test("every type agrees with the catalog", () => {
  for (const t of Object.values(REPORT_TYPES)) {
    const aliases = aliasesOf(t);
    assert.equal(aliases.size, 1 + t.joins.length, `${t.key}: duplicate alias`);
    for (const [alias, objectKey] of aliases) {
      assert.match(alias, ALIAS_RE, `${t.key}: alias ${alias}`);
      assert.ok(CATALOG[objectKey], `${t.key}: no catalog for ${objectKey}`);
    }
    const tableCol = (objectKey, column) => CATALOG[objectKey].fields.find((f) => f.column === column);
    const declared = new Set([t.base.alias]);
    for (const j of t.joins) {
      assert.ok(["lookup", "latest", "rollup"].includes(j.kind), `${t.key}.${j.alias}: kind ${j.kind}`);
      const [la, lc] = j.on.left.split(".");
      assert.ok(declared.has(la), `${t.key}.${j.alias}: left alias ${la} must be declared before it`);
      assert.notEqual(joinOf(t, la)?.kind, "rollup", `${t.key}.${j.alias}: a rollup has no join keys`);
      assert.ok(tableCol(aliases.get(la), lc), `${t.key}.${j.alias}: ${j.on.left} is not in the catalog`);
      assert.ok(tableCol(j.object, j.on.right), `${t.key}.${j.alias}: ${j.object}.${j.on.right} is not in the catalog`);
      if (j.kind === "lookup") {
        assert.equal(j.on.right, "sf_id", `${t.key}.${j.alias}: a lookup lands on the record's id`);
        assert.equal(j.where, undefined);
      } else {
        assert.equal(lc, "sf_id", `${t.key}.${j.alias}: a ${j.kind} hangs children off the parent's id`);
      }
      for (const w of j.where ?? []) {
        const c = tableCol(j.object, w.column);
        assert.ok(c && TEXT_TYPES.has(c.type), `${t.key}.${j.alias}: where on ${w.column} needs a text column`);
        assert.ok(Array.isArray(w.in ?? w.notIn) && (w.in ?? w.notIn).length > 0);
      }
      if (j.kind === "latest") {
        assert.ok(tableCol(j.object, "created_date") && tableCol(j.object, "sf_id"), `${t.key}.${j.alias}: latest orders by created_date, sf_id`);
      }
      if (j.kind === "rollup") {
        assert.ok(j.measures.length >= 1);
        const names = new Set();
        for (const m of j.measures) {
          assert.match(m.name, NAME_RE);
          assert.ok(!names.has(m.name), `${t.key}.${j.alias}: measure ${m.name} twice`);
          names.add(m.name);
          assert.ok(["count", "sum", "max"].includes(m.fn));
          if (m.fn === "count") {
            assert.equal(m.column, undefined);
          } else {
            const c = tableCol(j.object, m.column);
            assert.ok(c && c.reportable, `${t.key}.${j.alias}.${m.name}: ${m.column}`);
            assert.equal(c.gate, null, `${t.key}.${j.alias}.${m.name}: a measure's source must be ungated`);
            assert.ok(m.fn === "sum" ? c.type === "number" : ["number", "date", "datetime"].includes(c.type));
          }
          for (const w of [...(m.where ?? []), ...(m.negateWhen ? [m.negateWhen] : [])]) {
            const c = tableCol(j.object, w.column);
            assert.ok(c && TEXT_TYPES.has(c.type), `${t.key}.${j.alias}.${m.name}: ${w.column}`);
          }
        }
      }
      declared.add(j.alias);
    }
    for (const ref of t.defaultColumns) {
      const [a, c] = ref.split(".");
      const f = aliases.has(a) ? fieldsOf(t, a, CATALOG).find((x) => x.column === c) : null;
      assert.ok(f, `${t.key}: default column ${ref} is not in the catalog`);
      assert.ok(f.reportable && !f.longText && !f.gate, `${t.key}: default column ${ref} must be reportable, short and ungated`);
    }
  }
});

test("the ten D-089 types", () => {
  assert.deepEqual(Object.keys(REPORT_TYPES), [
    "customers", "customers_solar", "solar", "roofing", "service_jobs", "service_calls",
    "estimates", "estimate_lines", "invoices_payments", "payments",
  ]);
  const shape = (key) => reportType(key).joins.map((j) => `${j.kind}:${j.alias}=${j.object}@${j.on.left}`);
  assert.deepEqual(shape("customers"), ["lookup:dealer=dealer@customer.dealer_sf_id", "lookup:rep=user@customer.sales_rep_sf_id", "lookup:assignee=user@customer.assigned_to_sf_id"]);
  assert.deepEqual(shape("customers_solar"), ["latest:solar=solar@customer.sf_id", "lookup:dealer=dealer@customer.dealer_sf_id", "lookup:rep=user@customer.sales_rep_sf_id"]);
  assert.deepEqual(shape("solar"), ["lookup:customer=customer@solar.sundial_customer_sf_id", "lookup:rep=user@solar.sales_rep_sf_id", "lookup:dealer=dealer@solar.dealer_sf_id"]);
  assert.deepEqual(shape("roofing"), ["lookup:customer=customer@roofing.sundial_customer_sf_id", "lookup:dealer=dealer@roofing.dealer_sf_id", "lookup:rep=user@roofing.sales_rep_sf_id", "lookup:pm=user@roofing.project_manager_sf_id"]);
  assert.deepEqual(shape("service_jobs"), [
    "lookup:customer=customer@job.sundial_customer_sf_id", "lookup:bill_to=customer@job.bill_to_customer_sf_id",
    "lookup:estimate=estimate@job.estimate_sf_id", "latest:invoice=serviceinvoice@job.sf_id",
    "rollup:payments=servicepayment@job.sf_id", "lookup:assignee=user@job.assigned_to_sf_id",
  ]);
  assert.deepEqual(shape("service_calls"), ["lookup:job=job@call.sundial_service_job_sf_id", "lookup:customer=customer@job.sundial_customer_sf_id", "lookup:tech=user@call.tech_sf_id"]);
  assert.deepEqual(shape("estimates"), ["lookup:customer=customer@estimate.sundial_customer_sf_id", "lookup:job=job@estimate.service_job_sf_id", "lookup:sold_by=user@estimate.sold_by_sf_id"]);
  assert.deepEqual(shape("estimate_lines"), ["lookup:estimate=estimate@line.estimate_sf_id", "lookup:customer=customer@estimate.sundial_customer_sf_id", "lookup:item=pricebookitem@line.price_book_item_sf_id"]);
  assert.deepEqual(shape("invoices_payments"), [
    "lookup:job=job@invoice.service_job_sf_id", "lookup:customer=customer@job.sundial_customer_sf_id",
    "lookup:bill_to=customer@invoice.bill_to_customer_sf_id", "rollup:payments=servicepayment@invoice.sf_id",
  ]);
  assert.deepEqual(shape("payments"), ["lookup:invoice=serviceinvoice@payment.invoice_sf_id", "lookup:job=job@payment.service_job_sf_id", "lookup:customer=customer@job.sundial_customer_sf_id"]);
});

test("service_jobs: the invoice is the newest NON-VOID one; payments are Succeeded, refunds subtract", () => {
  const t = reportType("service_jobs");
  assert.deepEqual(joinOf(t, "invoice").where, [{ column: "status", notIn: ["Void"] }]);
  const p = joinOf(t, "payments");
  assert.deepEqual(p.on, { left: "job.sf_id", right: "service_job_sf_id" });
  assert.deepEqual(p.where, [{ column: "status", in: ["Succeeded"] }]);
  const paid = p.measures.find((m) => m.name === "amount_paid");
  assert.deepEqual(paid.negateWhen, { column: "type", in: ["Refund"] });
  // invoices_payments' rollup is the same measures, by invoice
  assert.equal(joinOf(reportType("invoices_payments"), "payments").measures, p.measures);
  assert.deepEqual(joinOf(reportType("invoices_payments"), "payments").on, { left: "invoice.sf_id", right: "invoice_sf_id" });
});

test("fieldsOf: a table alias is its catalog; a rollup alias is its measures", () => {
  const t = reportType("service_jobs");
  assert.equal(fieldsOf(t, "job", CATALOG), CATALOG.job.fields);
  const m = fieldsOf(t, "payments", CATALOG);
  assert.deepEqual(m.map((f) => [f.column, f.type, f.pgType]), [
    ["payment_count", "number", "bigint"], ["amount_paid", "number", "numeric"], ["deposits_paid", "number", "numeric"],
    ["refunds", "number", "numeric"], ["last_paid_at", "datetime", "timestamp with time zone"],
  ]);
  assert.ok(m.every((f) => f.reportable && !f.longText && f.gate === null && f.rollup));
  assert.equal(fieldsOf(t, "nobody", CATALOG), null);
});

test("solar has no PM join (Project_Manager__c is a multipicklist — D-088)", () => {
  assert.ok(!aliasesOf(reportType("solar")).has("pm"));
});

test("reportType is an own-property lookup", () => {
  assert.equal(reportType("__proto__"), null);
  assert.equal(reportType("constructor"), null);
  assert.equal(reportType(undefined), null);
});

test("describeTypes carries no table names (the browser never needs one)", () => {
  const d = describeTypes();
  assert.equal(d.length, Object.keys(REPORT_TYPES).length);
  assert.doesNotMatch(JSON.stringify(d), /_cache/);
  assert.deepEqual(d.find((x) => x.key === "solar").joins.map((j) => j.alias), ["customer", "rep", "dealer"]);
});
