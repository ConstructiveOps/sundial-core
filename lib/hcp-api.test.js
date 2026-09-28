// lib/hcp-api.js — the HCP read client (2026-09-25): auth fallback, pagination, backoff,
// the envelope reader, and the CSV flatteners. All against a fake fetch; no network.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createHcpClient, listOf, fillPath, toCsv, dollars,
  jobRow, lineItemRows, noteRows, appointmentRows, invoiceRow, paymentRows,
} from "./hcp-api.js";

function fakeFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, auth: init.headers.Authorization });
    const r = handler(new URL(url), init, calls.length);
    const body = typeof r.body === "string" ? r.body : JSON.stringify(r.body ?? null);
    return {
      status: r.status ?? 200,
      headers: { get: (k) => r.headers?.[k.toLowerCase()] ?? null },
      text: async () => body,
    };
  };
  return { fetchImpl, calls };
}

const noSleep = { sleep: async () => {}, minGapMs: 0 };

test("pagination: walks page by page until total_pages, sends page_size, stops on an empty page when totals are missing", async () => {
  const { fetchImpl, calls } = fakeFetch((u) => {
    const page = Number(u.searchParams.get("page"));
    if (u.pathname === "/jobs") {
      return { body: { jobs: page === 3 ? [{ id: "j5" }] : [{ id: `j${page * 2 - 1}` }, { id: `j${page * 2}` }], page, page_size: 2, total_pages: 3, total_items: 5 } };
    }
    // /customers: no totals in the envelope — stop on the short page
    return { body: { customers: page === 1 ? [{ id: "c1" }, { id: "c2" }] : [{ id: "c3" }] } };
  });
  const c = createHcpClient({ apiKey: "k", fetchImpl, ...noSleep });
  const got = [];
  for await (const p of c.pages("/jobs", { key: "jobs", pageSize: 2 })) got.push(...p.items.map((j) => j.id));
  assert.deepEqual(got, ["j1", "j2", "j3", "j4", "j5"]);
  assert.equal(calls.length, 3);
  assert.ok(calls[0].url.includes("page_size=2"));
  const cs = [];
  for await (const p of c.pages("/customers", { key: "customers", pageSize: 2 })) cs.push(...p.items.map((x) => x.id));
  assert.deepEqual(cs, ["c1", "c2", "c3"]);
  assert.equal(calls.length, 5, "the short second page ends the walk without a third call");
});

test("auth: Token first, one switch to Bearer on a 401, then Bearer stays", async () => {
  const { fetchImpl, calls } = fakeFetch((u, init) => {
    if (init.headers.Authorization.startsWith("Token ")) return { status: 401, body: { error: "unauthorized" } };
    return { body: { employees: [{ id: "e1" }] } };
  });
  const c = createHcpClient({ apiKey: "k", fetchImpl, ...noSleep });
  const r = await c.get("/employees");
  assert.equal(r.status, 200);
  assert.deepEqual(calls.map((x) => x.auth), ["Token k", "Bearer k"]);
  await c.get("/employees");
  assert.equal(calls[2].auth, "Bearer k");
  assert.equal(c.scheme, "Bearer");
});

test("429 honours Retry-After, 5xx backs off, then gives the last status up after the attempts run out; a 404 comes straight back", async () => {
  const waits = [];
  let n = 0;
  const { fetchImpl } = fakeFetch((u) => {
    if (u.pathname === "/jobs/x/notes") return { status: 404, body: { error: "not found" } };
    if (u.pathname === "/flaky") {
      n++;
      if (n === 1) return { status: 429, headers: { "retry-after": "2" }, body: "" };
      if (n === 2) return { status: 503, body: "" };
      return { body: { ok: true } };
    }
    return { status: 500, body: "boom" };
  });
  const c = createHcpClient({ apiKey: "k", fetchImpl, sleep: async (ms) => waits.push(ms), minGapMs: 0 });
  const r = await c.get("/flaky");
  assert.deepEqual(r.body, { ok: true });
  const backoffs = waits.filter((w) => w >= 1000); // the sub-second ones are the throttle after the 429
  assert.equal(backoffs[0], 2000, "Retry-After seconds");
  assert.equal(backoffs[1], 2000, "second attempt's backoff");
  const nf = await c.get("/jobs/x/notes");
  assert.equal(nf.status, 404);
  const dead = await c.get("/always-500");
  assert.equal(dead.status, 500);
  assert.equal(c.stats.retries, 2 + 7);
  assert.equal(c.gapMs, 100, "one 429 slowed the run down a notch");
});

test("listOf + fillPath", () => {
  assert.deepEqual(listOf({ jobs: [1, 2], page: 1 }, "jobs"), [1, 2]);
  assert.deepEqual(listOf({ data: [3] }, "jobs"), [3], "falls back to the first array");
  assert.deepEqual(listOf([4]), [4]);
  assert.deepEqual(listOf(null, "x"), []);
  assert.equal(fillPath("/estimates/{id}/options/{optionId}/line_items", { id: "e 1", optionId: "o1" }), "/estimates/e%201/options/o1/line_items");
});

test("the flatteners: dollars from cents, names joined, notes / appointments / payments one row each; CSV quotes commas, quotes and newlines", () => {
  const job = {
    id: "j1", invoice_number: "1042", work_status: "complete", description: "Inverter fault",
    customer: { id: "c1", first_name: "Cy", last_name: "Diaz" }, address: { street: "9 Elm St", city: "Mesa", state: "AZ", zip: "85201" },
    schedule: { scheduled_start: "2026-09-01T15:00:00Z" }, work_timestamps: { completed_at: "2026-09-01T17:00:00Z" },
    assigned_employees: [{ first_name: "Jake", last_name: "Dorsey" }], tags: ["Warranty"], total_amount: 45000, outstanding_balance: 0, notes: "gate code 1234",
  };
  const row = jobRow(job);
  assert.equal(row.customer, "Cy Diaz");
  assert.equal(row.total_amount, "450.00");
  assert.equal(row.assigned_employees, "Jake Dorsey");
  assert.equal(row.notes_field, "gate code 1234");
  const lines = lineItemRows(job, [{ id: "li1", name: "Inverter, 7.6 kW", quantity: 1, unit_price: 210000, unit_cost: 150000, kind: "materials" }], { source: "job" });
  assert.equal(lines[0].parent_number, "1042");
  assert.equal(lines[0].unit_price, "2100.00");
  assert.equal(lines[0].amount, "2100.00", "amount derived when HCP omits it");
  assert.equal(lines[0].source, "job");
  const notes = noteRows(job, [{ id: "n1", content: "Said \"call first\"\nDog in yard", employee: { first_name: "Beth" }, created_at: "2026-09-01T10:00:00Z" }]);
  assert.equal(notes[0].author, "Beth");
  // HCP's real appointment shape (probed 2026-09-25): ids only, names joined from the employee list
  const employeesById = new Map([["e1", { id: "e1", first_name: "Jake", last_name: "Dorsey" }]]);
  const appts = appointmentRows(job, [{ id: "a1", start_date: "2026-09-01", start_time: "2026-09-01T15:00:00Z", end_time: "2026-09-01T17:00:00Z", anytime: false, arrival_window_minutes: 60, dispatched_employees_ids: ["e1", "e9"] }], employeesById);
  assert.equal(appts[0].dispatched_employees, "Jake Dorsey; e9", "an unknown id stays an id");
  assert.equal(appts[0].employee_ids, "e1; e9");
  assert.equal(appts[0].start_date, "2026-09-01");
  // the invoice list record carries everything: subtotal, due_amount, taxes, discounts, payments, refunds
  const inv = { id: "i1", invoice_number: "1042", status: "paid", job_id: "j1", subtotal: 42000, amount: 45000, due_amount: 0, taxes: [{ amount: 3000 }], discounts: [], payments: [{ id: "p1", amount: 45000, payment_method: "credit_card", paid_at: "2026-09-02" }], refunds: [{ id: "r1", amount: 5000, payment_method: "credit_card", refunded_at: "2026-09-03" }] };
  const ir = invoiceRow(inv);
  assert.equal(ir.amount, "450.00");
  assert.equal(ir.taxes_total, "30.00");
  assert.equal(ir.payments_total, "450.00");
  assert.equal(ir.refunds_total, "50.00");
  const pays = paymentRows(inv);
  assert.equal(pays.length, 2);
  assert.equal(pays[0].kind, "payment");
  assert.equal(pays[1].kind, "refund");
  assert.equal(pays[1].amount, "-50.00", "a refund is written negative");
  assert.equal(pays[1].paid_at, "2026-09-03");
  const csv = toCsv(notes);
  assert.ok(csv.startsWith("﻿job_id,invoice_number,note_id,content,author"));
  assert.ok(csv.includes('"Said ""call first""\nDog in yard"'));
  assert.equal(toCsv([]), "");
  assert.equal(dollars(null), "");
});
