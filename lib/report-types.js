// lib/report-types.js — the report types (D-088 R1a, D-089 R1b; docs/reporting-module.md §6.2).
//
// A report type is a FIXED join, named like a Salesforce report type: a base object and the
// objects hung off it, each under an alias. A report definition names its fields as
// "<alias>.<column>" (e.g. "rep.name"), so one object can appear twice under two aliases.
//
// THE SHAPE:
//   {
//     key, label,
//     base:  { object, alias, label },                 object = a key of the catalog
//     joins: [{ object, alias, label, kind,
//               on: { left: "<alias>.<column>", right: "<column of the joined object>" },
//               where?, measures? }],
//     defaultColumns: ["<alias>.<column>", ...],
//   }
// `on` is structured, never SQL text: sundial_report_run re-checks `left`'s alias and both
// columns against public.sundial_report_catalog and builds the join itself, with the tenant
// clause (`client_sf_id = tenant`) inside every join.
//
// THE THREE JOIN KINDS (D-089). Every one of them yields AT MOST ONE row per base row, so a
// report's row count is always its base object's — a join never multiplies or drops rows:
//   lookup  LEFT JOIN on a lookup field → the one record it points at (sf_id on the right).
//           R1a's "left" is the same thing and is still accepted.
//   latest  LEFT JOIN LATERAL … ORDER BY created_date DESC NULLS LAST, sf_id ASC LIMIT 1: the
//           NEWEST child (the order the dealer shell uses to pick a customer's leading solar).
//           `where` narrows the children first (service_jobs: not a Void invoice).
//   rollup  LEFT JOIN LATERAL (SELECT <measures> …): one row of aggregates over the children.
//           Its "columns" are its MEASURES, declared here — count / sum / max over a catalog
//           column, each optionally narrowed (`where`) and with `negateWhen` (a refund is
//           stored positive and subtracts). `where` on the join narrows every measure.
//           A sum over no children is 0, a count 0, a max blank.
// where items: { column, in: [...] } or { column, notIn: [...] } (notIn keeps blanks — the
// D-080 IS DISTINCT FROM rule).
//
// DELIBERATELY NOT JOINED:
//   - "User as PM" on solar: Sundial_Solar__c.Project_Manager__c is a MULTIPICKLIST in the
//     live org (names, not a user id); the PM is reported as solar.project_manager (D-088).
//     Roofing's Project_Manager__c IS a user lookup, so roofing has `pm`.
//   - Every list a customer has many of (solar projects, jobs, estimates): that is a report
//     on THAT object with the customer joined, or customers_solar's `latest` — never a join
//     that repeats the customer.

const f = Object.freeze;
const lookup = (object, alias, label, left, right = "sf_id") => f({ object, alias, label, kind: "lookup", on: f({ left, right }) });

// The payments rollup, shared by service_jobs (by job) and invoices_payments (by invoice).
// Only Succeeded payments count (all 1,019 live rows are, 2026-11-04; a Pending / Failed row
// is not money). A Refund is stored as a POSITIVE amount, so the net paid subtracts it.
const PAYMENT_MEASURES = f([
  f({ name: "payment_count", label: "Payment Count", fn: "count" }),
  f({ name: "amount_paid", label: "Amount Paid (net of refunds)", fn: "sum", column: "amount", negateWhen: f({ column: "type", in: f(["Refund"]) }) }),
  f({ name: "deposits_paid", label: "Deposits Paid", fn: "sum", column: "amount", where: f([f({ column: "type", in: f(["Deposit"]) })]) }),
  f({ name: "refunds", label: "Refunds", fn: "sum", column: "amount", where: f([f({ column: "type", in: f(["Refund"]) })]) }),
  f({ name: "last_paid_at", label: "Last Payment Received", fn: "max", column: "received_at" }),
]);
const paymentsRollup = (left, right) => f({
  object: "servicepayment", alias: "payments", label: "Payments", kind: "rollup",
  on: f({ left, right }),
  where: f([f({ column: "status", in: f(["Succeeded"]) })]),
  measures: PAYMENT_MEASURES,
});

export const REPORT_TYPES = f({
  customers: f({
    key: "customers",
    label: "Customers",
    base: f({ object: "customer", alias: "customer", label: "Customer" }),
    joins: f([
      lookup("dealer", "dealer", "Dealer", "customer.dealer_sf_id"),
      lookup("user", "rep", "Sales rep", "customer.sales_rep_sf_id"),
      lookup("user", "assignee", "Assigned to", "customer.assigned_to_sf_id"),
    ]),
    defaultColumns: f(["customer.name", "customer.city", "customer.stage", "customer.status", "dealer.name", "rep.name", "customer.lead_source", "customer.created_date"]),
  }),

  customers_solar: f({
    key: "customers_solar",
    label: "Customers with their solar project",
    base: f({ object: "customer", alias: "customer", label: "Customer" }),
    joins: f([
      // 113 customers have more than one solar project (2026-11-04): the newest one leads.
      f({ object: "solar", alias: "solar", label: "Solar project (newest)", kind: "latest", on: f({ left: "customer.sf_id", right: "sundial_customer_sf_id" }) }),
      lookup("dealer", "dealer", "Dealer", "customer.dealer_sf_id"),
      lookup("user", "rep", "Sales rep", "customer.sales_rep_sf_id"),
    ]),
    defaultColumns: f(["customer.name", "customer.stage", "solar.project_name", "solar.stage", "dealer.name", "rep.name", "solar.contract_amount", "solar.contract_date"]),
  }),

  solar: f({
    key: "solar",
    label: "Solar projects",
    base: f({ object: "solar", alias: "solar", label: "Solar project" }),
    joins: f([
      lookup("customer", "customer", "Customer", "solar.sundial_customer_sf_id"),
      lookup("user", "rep", "Sales rep", "solar.sales_rep_sf_id"),
      lookup("dealer", "dealer", "Dealer", "solar.dealer_sf_id"),
    ]),
    defaultColumns: f(["solar.project_name", "customer.name", "solar.stage", "rep.name", "solar.project_manager", "solar.contract_amount", "solar.system_size", "solar.contract_date"]),
  }),

  roofing: f({
    key: "roofing",
    label: "Roofing projects",
    base: f({ object: "roofing", alias: "roofing", label: "Roofing project" }),
    joins: f([
      lookup("customer", "customer", "Customer", "roofing.sundial_customer_sf_id"),
      lookup("dealer", "dealer", "Dealer", "roofing.dealer_sf_id"),
      lookup("user", "rep", "Sales rep", "roofing.sales_rep_sf_id"),
      lookup("user", "pm", "Project manager", "roofing.project_manager_sf_id"),
    ]),
    defaultColumns: f(["roofing.project_name", "customer.name", "roofing.stage", "rep.name", "pm.name", "roofing.total_squares", "roofing.contract_presented_amount", "roofing.created_date"]),
  }),

  service_jobs: f({
    key: "service_jobs",
    label: "Service jobs",
    base: f({ object: "job", alias: "job", label: "Service job" }),
    joins: f([
      lookup("customer", "customer", "Customer", "job.sundial_customer_sf_id"),
      lookup("customer", "bill_to", "Bill-to customer", "job.bill_to_customer_sf_id"),
      lookup("estimate", "estimate", "Estimate", "job.estimate_sf_id"),
      // One job = one live invoice (D-072 am. 5), but a void + reissue leaves the Void row
      // behind, and 76 HCP-imported jobs carry 2–3 non-Void invoices (2026-11-04): the newest
      // non-Void one is "the job's invoice".
      f({ object: "serviceinvoice", alias: "invoice", label: "Invoice (newest, not void)", kind: "latest",
          on: f({ left: "job.sf_id", right: "service_job_sf_id" }),
          where: f([f({ column: "status", notIn: f(["Void"]) })]) }),
      // Payments are by JOB: a deposit before the invoice is a job-level row (D-072 am. 16).
      paymentsRollup("job.sf_id", "service_job_sf_id"),
      lookup("user", "assignee", "Assigned to", "job.assigned_to_sf_id"),
    ]),
    defaultColumns: f(["job.name", "customer.name", "job.status", "job.service_type", "assignee.name", "invoice.total", "payments.amount_paid", "job.created_date"]),
  }),

  service_calls: f({
    key: "service_calls",
    label: "Service calls",
    base: f({ object: "servicecall", alias: "call", label: "Service call" }),
    joins: f([
      // 45 calls are Events (no job, 2026-11-04): their job and customer are blank.
      lookup("job", "job", "Service job", "call.sundial_service_job_sf_id"),
      lookup("customer", "customer", "Customer", "job.sundial_customer_sf_id"),
      lookup("user", "tech", "Technician", "call.tech_sf_id"),
    ]),
    defaultColumns: f(["call.name", "job.name", "customer.name", "tech.name", "call.visit_type", "call.status", "call.scheduled_start", "call.duration_minutes"]),
  }),

  estimates: f({
    key: "estimates",
    label: "Estimates",
    base: f({ object: "estimate", alias: "estimate", label: "Estimate" }),
    joins: f([
      lookup("customer", "customer", "Customer", "estimate.sundial_customer_sf_id"),
      lookup("job", "job", "Service job", "estimate.service_job_sf_id"),
      lookup("user", "sold_by", "Sold by", "estimate.sold_by_sf_id"),
    ]),
    defaultColumns: f(["estimate.name", "customer.name", "estimate.status", "sold_by.name", "estimate.total", "estimate.approved_at", "estimate.created_date"]),
  }),

  estimate_lines: f({
    key: "estimate_lines",
    label: "Estimate lines",
    base: f({ object: "serviceline", alias: "line", label: "Line" }),
    joins: f([
      lookup("estimate", "estimate", "Estimate", "line.estimate_sf_id"),
      lookup("customer", "customer", "Customer", "estimate.sundial_customer_sf_id"),
      lookup("pricebookitem", "item", "Price book item", "line.price_book_item_sf_id"),
    ]),
    defaultColumns: f(["estimate.name", "customer.name", "line.kind", "line.name", "line.quantity", "line.unit_price", "line.line_total", "item.item_code"]),
  }),

  invoices_payments: f({
    key: "invoices_payments",
    label: "Invoices with payments",
    base: f({ object: "serviceinvoice", alias: "invoice", label: "Invoice" }),
    joins: f([
      lookup("job", "job", "Service job", "invoice.service_job_sf_id"),
      lookup("customer", "customer", "Customer", "job.sundial_customer_sf_id"),
      lookup("customer", "bill_to", "Bill-to customer", "invoice.bill_to_customer_sf_id"),
      // One row per invoice; the payments applied to IT (a job-level deposit not yet on an
      // invoice is on service_jobs' rollup, not here).
      paymentsRollup("invoice.sf_id", "invoice_sf_id"),
    ]),
    defaultColumns: f(["invoice.name", "customer.name", "invoice.status", "invoice.issued_at", "invoice.total", "payments.amount_paid", "invoice.balance", "payments.last_paid_at"]),
  }),

  payments: f({
    key: "payments",
    label: "Payments",
    base: f({ object: "servicepayment", alias: "payment", label: "Payment" }),
    joins: f([
      lookup("serviceinvoice", "invoice", "Invoice", "payment.invoice_sf_id"),
      lookup("job", "job", "Service job", "payment.service_job_sf_id"),
      lookup("customer", "customer", "Customer", "job.sundial_customer_sf_id"),
    ]),
    defaultColumns: f(["payment.name", "customer.name", "job.name", "invoice.name", "payment.type", "payment.method", "payment.amount", "payment.status", "payment.received_at"]),
  }),
});

/** The type, by own-property lookup (a key comes straight from a request body). */
export function reportType(key) {
  return typeof key === "string" && Object.hasOwn(REPORT_TYPES, key) ? REPORT_TYPES[key] : null;
}

/** alias → catalog object key, base first. */
export function aliasesOf(type) {
  const out = new Map([[type.base.alias, type.base.object]]);
  for (const j of type.joins) out.set(j.alias, j.object);
  return out;
}

/** The join of an alias, or null for the base. */
export function joinOf(type, alias) {
  return type.joins.find((j) => j.alias === alias) ?? null;
}

/**
 * The catalog fields an alias offers. A table alias offers its object's catalog; a ROLLUP
 * alias offers its measures, shaped like catalog fields (a count / sum is a number, a max
 * has its column's type; the gate is the column's).
 */
export function fieldsOf(type, alias, catalog) {
  const objectKey = aliasesOf(type).get(alias);
  const cat = objectKey ? catalog[objectKey] : null;
  if (!cat) return null;
  const j = joinOf(type, alias);
  if (!j || j.kind !== "rollup") return cat.fields;
  const byColumn = new Map(cat.fields.map((x) => [x.column, x]));
  return j.measures.map((m) => {
    const src = m.column ? byColumn.get(m.column) : null;
    return {
      column: m.name,
      sfField: null,
      label: m.label,
      section: j.label,
      type: m.fn === "max" ? src?.type ?? "number" : "number",
      pgType: m.fn === "count" ? "bigint" : m.fn === "sum" ? "numeric" : src?.pgType ?? "numeric",
      description: "",
      gate: src?.gate ?? null,
      reportable: true,
      longText: false,
      rollup: true,
    };
  });
}

/** The shape GET /reports/types returns. */
export function describeTypes() {
  return Object.values(REPORT_TYPES).map((t) => ({
    key: t.key,
    label: t.label,
    base: { alias: t.base.alias, object: t.base.object, label: t.base.label },
    joins: t.joins.map((j) => ({ alias: j.alias, object: j.object, label: j.label, kind: j.kind })),
    defaultColumns: [...t.defaultColumns],
  }));
}
