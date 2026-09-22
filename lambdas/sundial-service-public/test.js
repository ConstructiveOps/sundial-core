// Tests for sundial-service-public — the customer page's backend, driven through
// the real router with an in-memory Salesforce and a recording activity sink.
// Run:  node --test lambdas/sundial-service-public/test.js   (also in `npm test`)

import test from "node:test";
import assert from "node:assert/strict";
import { createHandler, matchRoute } from "./index.js";

const TENANT = "a1W7y000007AszBEAS";
const TOKEN = "abcdefghijklmnopqrstuvwxyz012345";
const NOW = new Date("2026-09-12T15:00:00Z");

function fake({ status = "Sent", expiresAt = "2026-10-30T00:00:00Z", version = 1, approvedAt = null } = {}) {
  const est = {
    Id: "EST000000000000001", Name: "EST-00042", Client__c: TENANT, Status__c: status, Version__c: version,
    Public_Token__c: TOKEN, Public_Token_Expires_At__c: expiresAt, Customer_Name_at_Creation__c: "Ann Lee",
    Address_at_Creation__c: "123 N Main St, Phoenix, AZ 85001", Tax_Rate__c: 8.6, Deposit_Required__c: true,
    Deposit_Type__c: "Percent", Deposit_Value__c: 25, Valid_Until__c: "2026-10-12", Approved_At__c: approvedAt,
    Service_Job__c: "SVC000000000000001", Is_Template__c: false,
    // The send wrote v1's PDF; a later version without one must NOT fall back to it.
    Version_Log__c: JSON.stringify([{ version: 1, pdfKey: "SUNDIAL/EST000000000000001/estimate-v1.pdf" }, { version: 2, pdfKey: null }]),
  };
  const lines = [
    { Id: "SL1", Estimate__c: est.Id, Client__c: TENANT, Description__c: "Standard service call", Kind__c: "Labor", Quantity__c: 1, Unit_Price__c: 275, Line_Total__c: 275, Taxable__c: false, Stage__c: "Proposed" },
    { Id: "SL2", Estimate__c: est.Id, Client__c: TENANT, Description__c: "Disconnect", Kind__c: "Material", Quantity__c: 1, Unit_Price__c: 120, Line_Total__c: 120, Taxable__c: true, Stage__c: "Proposed" },
  ];
  const updates = [];
  const activity = [];
  const notes = [];
  const deps = {
    sfQuery: async (soql) => {
      if (soql.includes("FROM Sundial_Estimate__c")) return soql.includes(`Public_Token__c = '${TOKEN}'`) ? [{ ...est }] : [];
      if (soql.includes("FROM Sundial_Service_Line__c")) return lines.map((l) => ({ ...l }));
      return [];
    },
    sfUpdateRecord: async (obj, id, fields) => {
      updates.push({ obj, id, fields });
      const target = obj === "Sundial_Estimate__c" ? est : lines.find((l) => l.Id === id);
      Object.assign(target, fields);
      return { ok: true, id };
    },
    getSupabaseClient: async () => ({ from: () => ({ insert: async (row) => { activity.push(row); return { error: null }; } }) }),
    now: () => NOW,
    brandName: "Acme Solar",
    // Notifications (D-074): recorded, never delivered.
    notifier: { toOffice: async (n) => (notes.push(n), { inserted: 1, skipped: 0, pushed: 0 }) },
  };
  return { est, lines, updates, activity, notes, deps };
}
const call = (h, method, path, body) =>
  h({ requestContext: { http: { method } }, rawPath: path, headers: { origin: "http://localhost:5173" }, body: body ? JSON.stringify(body) : undefined })
    .then((r) => ({ status: r.statusCode, body: r.body ? JSON.parse(r.body) : null }));

test("matchRoute: token captured, stage prefix stripped, unknown 404", () => {
  assert.deepEqual(matchRoute("GET", `/prod/public/estimates/${TOKEN}`), { name: "view", token: TOKEN });
  assert.deepEqual(matchRoute("POST", `/public/estimates/${TOKEN}/accept`), { name: "accept", token: TOKEN });
  assert.equal(matchRoute("GET", "/public/estimates"), null);
});

test("view: renders the customer document, marks Sent → Viewed once, reports canAccept + totals", async () => {
  const f = fake();
  const h = createHandler(f.deps);
  const r = await call(h, "GET", `/public/estimates/${TOKEN}`);
  assert.equal(r.status, 200);
  assert.ok(r.body.html.includes("Standard service call"));
  assert.ok(r.body.html.includes("Acme Solar"));
  assert.ok(!r.body.html.includes("PREVIEW"), "customer mode has no watermark");
  assert.equal(r.body.number, "EST-00042");
  assert.equal(r.body.status, "Viewed");
  assert.equal(r.body.canAccept, true);
  assert.equal(r.body.pdfUrl, "https://sfsolproj.s3.us-west-1.amazonaws.com/SUNDIAL/EST000000000000001/estimate-v1.pdf");
  // Version 2's send had no PDF → no link, and never v1's stale one.
  const f2 = fake({ version: 2 });
  const r2 = await call(createHandler({ ...f2.deps, now: () => NOW }), "GET", `/public/estimates/${TOKEN}`);
  assert.equal(r2.body.pdfUrl, null);
  assert.equal(r.body.total, 405.32); // 395 + 8.6% of 120
  assert.equal(r.body.depositAmount, 101.33);
  assert.equal(f.est.Status__c, "Viewed");
  assert.equal(f.activity.length, 1);
  assert.equal(f.activity[0].actor_name, "Customer");
  assert.equal(f.activity[0].client_sf_id, TENANT);
  // Second view: no status change, no second activity row.
  await call(h, "GET", `/public/estimates/${TOKEN}`);
  assert.equal(f.activity.length, 1);
});

test("view: wrong token → 404, expired → 410, template → 404, malformed → 404 without a query", async () => {
  const f = fake();
  const h = createHandler(f.deps);
  assert.equal((await call(h, "GET", "/public/estimates/zzzzzzzzzzzzzzzzzzzzzzzz")).status, 404);
  assert.equal((await call(h, "GET", "/public/estimates/short")).status, 404);
  const g = fake({ expiresAt: "2026-09-01T00:00:00Z" });
  assert.equal((await call(createHandler(g.deps), "GET", `/public/estimates/${TOKEN}`)).status, 410);
});

test("accept: needs a name; approves online, promotes Proposed lines, writes the activity row with the customer as actor; idempotent", async () => {
  const f = fake();
  const h = createHandler(f.deps);
  const noName = await call(h, "POST", `/public/estimates/${TOKEN}/accept`, {});
  assert.equal(noName.status, 400);
  const ok = await call(h, "POST", `/public/estimates/${TOKEN}/accept`, { name: "  Ann Lee  " });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.status, "Approved");
  assert.equal(ok.body.approvedByName, "Ann Lee");
  assert.equal(f.est.Approval_Method__c, "Online");
  assert.equal(f.est.Approved_Version__c, 1);
  assert.equal(f.est.Approved_Amount__c, 405.32);
  assert.ok(f.lines.every((l) => l.Stage__c === "Approved"));
  const row = f.activity.find((a) => a.event === "estimate_approved");
  assert.equal(row.actor_name, "Customer: Ann Lee");
  assert.equal(row.job_sf_id, "SVC000000000000001");
  const again = await call(h, "POST", `/public/estimates/${TOKEN}/accept`, { name: "Ann Lee" });
  assert.equal(again.body.alreadyApproved, true);
  assert.equal(f.activity.filter((a) => a.event === "estimate_approved").length, 1);
  // The office's bell (D-074): once, keyed on the approved version.
  assert.equal(f.notes.length, 1);
  assert.deepEqual([f.notes[0].category, f.notes[0].kind, f.notes[0].tenantId], ["money", "estimate_approved", f.est.Client__c]);
  assert.equal(f.notes[0].title, `Approved online: ${f.est.Name} · ${f.est.Customer_Name_at_Creation__c} — $405.32`);
  assert.equal(f.notes[0].url, `/service/estimates/${f.est.Id}`);
  assert.equal(f.notes[0].dedupeKey, `money:approved:${f.est.Id}:1`);
});

test("accept on a declined/unsent estimate is 409; decline works and refuses after approval", async () => {
  const f = fake({ status: "Draft", version: 0 });
  const h = createHandler(f.deps);
  const r = await call(h, "POST", `/public/estimates/${TOKEN}/accept`, { name: "X" });
  assert.equal(r.status, 409);
  const g = fake();
  const h2 = createHandler(g.deps);
  const dec = await call(h2, "POST", `/public/estimates/${TOKEN}/decline`, { reason: "Too expensive" });
  assert.equal(dec.status, 200);
  assert.equal(g.est.Status__c, "Declined");
  assert.equal(g.est.Declined_Reason__c, "Too expensive");
  assert.equal(g.notes[0].kind, "estimate_declined");
  assert.equal(g.notes[0].body, "Reason: Too expensive");
  const k = fake({ status: "Approved" });
  assert.equal((await call(createHandler(k.deps), "POST", `/public/estimates/${TOKEN}/decline`, {})).status, 409);
});

// ---------------------------------------------------------------------------
// Payments on the hosted page (D-072 amendment 8, 2026-09-17)
// ---------------------------------------------------------------------------
import { paymentSummary, CHECKOUT_KINDS } from "./index.js";

test("paymentSummary: what the page offers, from the records alone", () => {
  const est = { Status__c: "Approved", Deposit_Required__c: true, Deposit_Amount__c: 101.33, Deposit_Paid_At__c: null };
  const job = { Bill_To_Type__c: "Customer", Customer_Card_on_File__c: false };
  // Approved + deposit due → deposit (and it also keeps the card).
  assert.equal(paymentSummary({ est, job, invoice: null, configured: true }).next, "deposit");
  // Deposit paid, no card yet → setup. Card on file → nothing.
  assert.equal(paymentSummary({ est: { ...est, Deposit_Paid_At__c: "2026-09-17T00:00:00Z" }, job, invoice: null, configured: true }).next, "setup");
  assert.equal(paymentSummary({ est: { ...est, Deposit_Paid_At__c: "x" }, job: { ...job, Customer_Card_on_File__c: true }, invoice: null, configured: true }).next, null);
  // No deposit on the estimate, approved, no card → setup; not yet approved → nothing.
  assert.equal(paymentSummary({ est: { ...est, Deposit_Required__c: false }, job, invoice: null, configured: true }).next, "setup");
  assert.equal(paymentSummary({ est: { ...est, Status__c: "Sent" }, job, invoice: null, configured: true }).next, null);
  // A live invoice with a balance wins over everything; a paid one offers nothing.
  const inv = { Name: "SVC-00003", Status__c: "Issued", Total__c: 405.32, Paid_Amount__c: 101.33 };
  const s = paymentSummary({ est: { ...est, Status__c: "Invoiced" }, job, invoice: inv, configured: true });
  assert.equal(s.next, "balance");
  assert.deepEqual(s.invoice, { number: "SVC-00003", status: "Issued", total: 405.32, paid: 101.33, balance: 303.99 });
  assert.equal(paymentSummary({ est, job, invoice: { ...inv, Status__c: "Paid", Paid_Amount__c: 405.32 }, configured: true }).next, null);
  assert.equal(paymentSummary({ est, job, invoice: { ...inv, Status__c: "Void" }, configured: true }).next, "deposit"); // a void invoice is no invoice
  // A partner-billed job never asks the customer for a card or money.
  assert.equal(paymentSummary({ est, job: { ...job, Bill_To_Type__c: "Manufacturer" }, invoice: inv, configured: true }).next, null);
  // Stripe not configured: nothing offered, and the page is told why.
  const off = paymentSummary({ est, job, invoice: null, configured: false });
  assert.equal(off.next, null);
  assert.equal(off.configured, false);
  assert.match(off.unavailable, /isn't set up yet/);
  assert.deepEqual(CHECKOUT_KINDS, ["setup", "deposit", "balance"]);
});

test("checkout: re-derives the step, finds-or-creates the Stripe customer, builds the session on the tenant's keys, never trusts the browser's kind", async () => {
  const f = fake({ status: "Approved", approvedAt: "2026-09-12T00:00:00Z" });
  f.est.Sundial_Customer__c = "CUS000000000000001";
  f.est.Deposit_Amount__c = 101.33;
  const job = { Id: "SVC000000000000001", Name: "SVC-00003", Client__c: TENANT, Status__c: "Scheduled", Bill_To_Type__c: "Customer", Sundial_Customer__c: "CUS000000000000001", Customer_Card_on_File__c: false, Customer_Name_at_Creation__c: "Ann Lee" };
  const customer = { Id: "CUS000000000000001", Name: "Ann Lee", Client__c: TENANT, Primary_Email__c: "ann@example.com", Primary_Phone__c: "(602) 555-0100", Stripe_Customer_Id__c: null };
  const invoices = [];
  const stripeCalls = [];
  const deps = {
    ...f.deps,
    sfQuery: async (soql) => {
      if (soql.includes("FROM Sundial_Service_Job__c")) return [{ ...job }];
      if (soql.includes("FROM Sundial_Customer__c")) return [{ ...customer }];
      if (soql.includes("FROM Sundial_Service_Invoice__c")) return invoices.map((i) => ({ ...i }));
      if (soql.includes("FROM Sundial_Tenant__c")) return [{ Id: TENANT, Name: "harmon" }];
      return f.deps.sfQuery(soql);
    },
    sfUpdateRecord: async (obj, id, fields) => {
      if (obj === "Sundial_Customer__c") { Object.assign(customer, fields); f.updates.push({ obj, id, fields }); return { ok: true, id }; }
      return f.deps.sfUpdateRecord(obj, id, fields);
    },
    getSecret: async (name) => (name === "sundial/stripe" ? { tenants: { harmon: { secretKey: "sk_test_h", webhookSecret: "whsec_h" } } } : {}),
    fetchUrl: async (url, init) => {
      stripeCalls.push({ url, init });
      if (url.endsWith("/customers") && init.method === "POST") return { ok: true, status: 200, json: async () => ({ id: "cus_new" }) };
      if (url.includes("/customers/cus_")) return { ok: true, status: 200, json: async () => ({ id: url.split("/").pop() }) };
      if (url.endsWith("/checkout/sessions")) return { ok: true, status: 200, json: async () => ({ id: "cs_1", url: "https://checkout.stripe.com/c/pay/cs_1" }) };
      return { ok: false, status: 500, json: async () => ({}) };
    },
    publicBaseUrl: "https://sundial.example.com/",
  };
  const h = createHandler(deps);

  // The page is told what to offer.
  let r = await call(h, "GET", `/public/estimates/${TOKEN}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.payment.configured, true);
  assert.equal(r.body.payment.next, "deposit");
  assert.equal(r.body.payment.depositAmount, 101.33);

  // Asking for the wrong step is refused before Stripe is touched.
  r = await call(h, "POST", `/public/estimates/${TOKEN}/checkout`, { kind: "balance" });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, "CHECKOUT_NOT_APPLICABLE");
  assert.equal(stripeCalls.length, 0);
  assert.equal((await call(h, "POST", `/public/estimates/${TOKEN}/checkout`, { kind: "bogus" })).body.code, "KIND_INVALID");

  // The deposit: a Stripe customer is created and remembered on the hub, the session charges the deposit and keeps the card.
  r = await call(h, "POST", `/public/estimates/${TOKEN}/checkout`, { kind: "deposit" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.url, "https://checkout.stripe.com/c/pay/cs_1");
  assert.equal(r.body.mode, "test");
  assert.equal(customer.Stripe_Customer_Id__c, "cus_new");
  const session = stripeCalls.find((c) => c.url.endsWith("/checkout/sessions"));
  const p = new URLSearchParams(session.init.body);
  assert.equal(session.init.headers.Authorization, "Bearer sk_test_h");
  assert.equal(p.get("mode"), "payment");
  assert.equal(p.get("customer"), "cus_new");
  assert.equal(p.get("line_items[0][price_data][unit_amount]"), "10133");
  assert.equal(p.get("line_items[0][price_data][product_data][name]"), "Deposit — EST-00042 (Acme Solar)");
  assert.equal(p.get("payment_intent_data[setup_future_usage]"), "off_session");
  assert.equal(p.get("payment_intent_data[metadata][kind]"), "deposit");
  assert.equal(p.get("payment_intent_data[metadata][jobId]"), "SVC000000000000001");
  assert.equal(p.get("payment_intent_data[metadata][tenantId]"), TENANT);
  assert.equal(p.get("success_url"), `https://sundial.example.com/estimate/${TOKEN}?checkout=success&kind=deposit`);
  assert.equal(p.get("cancel_url"), `https://sundial.example.com/estimate/${TOKEN}?checkout=cancel`);
  assert.ok(f.activity.some((a) => a.details?.checkout === "deposit" && a.details.amount === 101.33));

  // Deposit paid (the webhook stamped it), the customer id is reused: a setup session, no charge.
  f.est.Deposit_Paid_At__c = "2026-09-13T00:00:00Z";
  stripeCalls.length = 0;
  r = await call(h, "POST", `/public/estimates/${TOKEN}/checkout`, { kind: "setup" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(!stripeCalls.some((c) => c.url.endsWith("/customers") && c.init.method === "POST"), "no second Stripe customer");
  const setup = new URLSearchParams(stripeCalls.find((c) => c.url.endsWith("/checkout/sessions")).init.body);
  assert.equal(setup.get("mode"), "setup");
  assert.equal(setup.get("customer"), "cus_new");
  assert.equal(setup.get("setup_intent_data[metadata][kind]"), "setup");

  // Invoiced with a balance: the balance session names the invoice.
  job.Customer_Card_on_File__c = true;
  f.est.Status__c = "Invoiced";
  invoices.push({ Id: "INV000000000000001", Name: "SVC-00003", Service_Job__c: job.Id, Client__c: TENANT, Status__c: "Sent", Total__c: 405.32, Paid_Amount__c: 101.33 });
  stripeCalls.length = 0;
  r = await call(h, "POST", `/public/estimates/${TOKEN}/checkout`, { kind: "balance" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const bal = new URLSearchParams(stripeCalls.find((c) => c.url.endsWith("/checkout/sessions")).init.body);
  assert.equal(bal.get("line_items[0][price_data][unit_amount]"), "30399");
  assert.equal(bal.get("payment_intent_data[metadata][invoiceId]"), "INV000000000000001");
  assert.equal(bal.get("payment_intent_data[metadata][kind]"), "balance");

  // No Stripe for this tenant → 503 with a plain message, and the page's summary says so.
  const off = createHandler({ ...deps, getSecret: async () => ({}) });
  r = await call(off, "POST", `/public/estimates/${TOKEN}/checkout`, { kind: "balance" });
  assert.equal(r.status, 503);
  assert.equal(r.body.code, "STRIPE_NOT_CONFIGURED");
  r = await call(off, "GET", `/public/estimates/${TOKEN}`);
  assert.equal(r.body.payment.next, null);
  assert.match(r.body.payment.unavailable, /isn't set up/);
});

// ---------------------------------------------------------------------------
// The customer's job report + receipt (D-072 amendment 10)
// ---------------------------------------------------------------------------
test("report: the token resolves the job; the document carries the sections, the summary and the receipt; wrong / expired tokens are 404 / 410", async () => {
  const RTOKEN = "rep_abcdefghijklmnopqrstuvwxyz0123";
  const job = {
    Id: "SVC000000000000009", Name: "SVC-00009", Client__c: TENANT, Bill_To_Type__c: "Customer", Estimate__c: "EST000000000000001",
    Customer_Name_at_Creation__c: "Cy Diaz", Address_at_Creation__c: "3 Elm St, Phoenix, AZ 85001", Primary_Email_at_Creation__c: "cy@example.com",
    Customer_Summary__c: "Replaced the failed breaker.",
    Report_Sections__c: JSON.stringify({ sections: [{ id: "a", photoKey: "SUNDIAL/SVC000000000000009/photos/SC1/before.jpg", caption: "Arc marks on the bus." }, { id: "b", caption: "Lugs torqued." }] }),
    Report_Public_Token__c: RTOKEN, Report_Token_Expires_At__c: "2027-09-01T00:00:00Z", Report_Sent_At__c: "2026-09-16T18:00:00Z", Report_PDF_S3_Key__c: "SUNDIAL/SVC000000000000009/job-report-1.pdf",
  };
  const invoice = { Id: "INV1", Name: "SVC-00009", Client__c: TENANT, Service_Job__c: job.Id, Status__c: "Paid", Subtotal__c: 395, Discount_Amount__c: 0, Tax_Amount__c: 10.32, Total__c: 405.32, Paid_Amount__c: 405.32, Paid_At__c: "2026-09-16T18:00:00Z", Bill_To_Type__c: "Customer" };
  const f = fake();
  const deps = {
    ...f.deps,
    sfQuery: async (soql) => {
      if (soql.includes("FROM Sundial_Service_Job__c")) return soql.includes(`Report_Public_Token__c = '${RTOKEN}'`) ? [{ ...job }] : [];
      if (soql.includes("FROM Sundial_Service_Invoice__c")) return [{ ...invoice }];
      if (soql.includes("FROM Sundial_Service_Payment__c")) return [{ Id: "P1", Invoice__c: "INV1", Status__c: "Succeeded", Type__c: "Payment", Method__c: "Card", Amount__c: 405.32, Received_At__c: "2026-09-16T18:00:00Z" }];
      if (soql.includes("FROM Sundial_Service_Call__c")) return [{ Id: "SC1", Name: "SC-00001", Scheduled_Start__c: "2026-09-14T16:00:00Z", Tech__r: { First_Name__c: "Jake", Last_Name__c: "Dorsey" } }];
      if (soql.includes("FROM Sundial_Estimate__c") && soql.includes("Id = 'EST000000000000001'")) return [{ ...f.est }];
      return f.deps.sfQuery(soql);
    },
    listFiles: async (id) => [{ key: `SUNDIAL/${id}/photos/SC1/before.jpg`, publicUrl: "https://s3/before.jpg", size: 10, lastModified: "2026-09-14T17:00:00Z" }],
  };
  const h = createHandler(deps);
  const r = await call(h, "GET", `/public/reports/${RTOKEN}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.title, "Job report SVC-00009");
  assert.equal(r.body.customerName, "Cy Diaz");
  assert.equal(r.body.sections, 2);
  assert.equal(r.body.receipt, true);
  assert.equal(r.body.paid, true);
  assert.equal(r.body.pdfUrl, "https://sfsolproj.s3.us-west-1.amazonaws.com/SUNDIAL/SVC000000000000009/job-report-1.pdf");
  assert.ok(r.body.html.includes("Acme Solar"));
  assert.ok(r.body.html.includes("Replaced the failed breaker."));
  assert.ok(r.body.html.includes('src="https://s3/before.jpg"'));
  assert.ok(r.body.html.includes("Jake Dorsey · Sep 14, 2026"));
  assert.ok(r.body.html.includes("Receipt · SVC-00009"));
  assert.ok(r.body.html.includes("Standard service call"));
  assert.ok(r.body.html.includes("Paid in full"));
  assert.ok(!r.body.html.includes("PREVIEW"));
  assert.equal((await call(h, "GET", "/public/reports/rep_zzzzzzzzzzzzzzzzzzzzzzzzzzzz")).status, 404);
  assert.equal((await call(h, "GET", "/public/reports/short")).status, 404);
  job.Report_Token_Expires_At__c = "2026-01-01T00:00:00Z";
  assert.equal((await call(h, "GET", `/public/reports/${RTOKEN}`)).status, 410);
  // A partner-billed job: the customer's page has no receipt even though the invoice is paid.
  job.Report_Token_Expires_At__c = "2027-09-01T00:00:00Z";
  job.Bill_To_Type__c = "Manufacturer";
  const p = await call(h, "GET", `/public/reports/${RTOKEN}`);
  assert.equal(p.body.receipt, false);
  assert.ok(!p.body.html.includes("Receipt ·"));
});
