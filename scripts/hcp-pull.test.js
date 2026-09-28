// scripts/hcp-pull.mjs end to end against a fake HCP (2026-09-25) shaped like the real
// probe of Harmon's account: the probe report, the full pull's raw files + CSVs, resume
// (unchanged records are not re-read), --refresh. No network, no AWS.

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "hcp-pull.mjs");

function fakeHcp() {
  const hits = {};
  const jobs = Array.from({ length: 7 }, (_, i) => ({
    id: `job${i + 1}`, invoice_number: `${1000 + i}`, work_status: "complete", updated_at: `2026-09-0${(i % 9) + 1}T00:00:00Z`,
    customer: { id: "c1", first_name: "Cy", last_name: "Diaz" }, address: { street: "9 Elm St", city: "Mesa", state: "AZ", zip: "85201" },
    total_amount: 45000, assigned_employees: [{ first_name: "Jake", last_name: "Dorsey" }], notes: "gate 1234",
  }));
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    hits[u.pathname] = (hits[u.pathname] || 0) + 1;
    const page = Number(u.searchParams.get("page") || 1);
    const size = Number(u.searchParams.get("page_size") || 100);
    const send = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const paged = (key, all) => send(200, { [key]: all.slice((page - 1) * size, page * size), page, page_size: size, total_pages: Math.max(1, Math.ceil(all.length / size)), total_items: all.length });
    if (req.headers.authorization !== "Token local-test") return send(401, { error: "unauthorized" });
    const m = u.pathname.match(/^\/(\w+)(?:\/([\w-]+)(?:\/(\w+)(?:\/([\w-]+)\/(\w+))?)?)?$/);
    const [, top, id, child, optId, optChild] = m || [];
    if (u.pathname === "/company") return send(200, { id: "co", name: "Harmon Service" });
    if (u.pathname === "/employees") return paged("employees", [{ id: "e1", first_name: "Jake", last_name: "Dorsey", role: "field_tech" }]);
    if (u.pathname === "/tags") return paged("tags", [{ id: "t1", name: "Warranty" }]);
    if (u.pathname === "/job_fields/job_types") return paged("job_types", [{ id: "jt1", name: "Repair" }]);
    if (u.pathname === "/lead_sources") return paged("lead_sources", [{ id: "ls1", name: "Web" }]);
    if (u.pathname === "/customers") return paged("customers", [{ id: "c1", first_name: "Cy", last_name: "Diaz", email: "cy@example.com", addresses: [{ type: "service", street: "9 Elm St", city: "Mesa", state: "AZ", zip: "85201" }] }]);
    if (u.pathname === "/leads") return paged("leads", [{ id: "lead1", status: "open", source: "phone", customer: { id: "c1", first_name: "Cy", last_name: "Diaz", email: "cy@example.com" }, address: { street: "9 Elm St", city: "Mesa", state: "AZ", zip: "85201" }, tags: ["Inverter"], created_at: "2026-09-20T00:00:00Z" }]);
    if (u.pathname === "/jobs") return paged("jobs", jobs);
    if (top === "jobs" && id && child) {
      if (child === "line_items") return send(200, { line_items: [{ id: `${id}-li`, name: "Inverter", quantity: 1, unit_price: 210000, unit_cost: 150000 }] });
      if (child === "appointments" && id === "job7") return send(400, { error: "job has no schedule" }); // HCP: a 400 for THIS job, the route is fine
      if (child === "appointments") return send(200, { appointments: [{ id: `${id}-a`, start_date: "2026-09-01", start_time: "2026-09-01T15:00:00Z", end_time: "2026-09-01T17:00:00Z", anytime: false, arrival_window_minutes: 60, dispatched_employees_ids: ["e1"] }] });
      if (child === "notes") return send(404, { error: "not found" }); // HCP: no notes feed
    }
    if (u.pathname === "/estimates") return paged("estimates", [{ id: "est1", estimate_number: "E-1", approval_status: "pending", total_amount: 99000, options: [{ id: "o1", name: "Option 1", total_amount: 99000 }], customer: { id: "c1", first_name: "Cy" } }]);
    if (top === "estimates" && optId && optChild === "line_items") return send(200, { line_items: [{ id: "eli1", name: "Panel", quantity: 3, unit_price: 33000 }] });
    // the list record IS the invoice (items, taxes, discounts, payments, refunds); /invoices/{id} is a 404 on HCP
    if (u.pathname === "/invoices") return paged("invoices", [{ id: "inv1", invoice_number: "1000", status: "paid", job_id: "job1", subtotal: 42000, amount: 45000, due_amount: 0, taxes: [{ amount: 3000 }], discounts: [], items: [{ id: "ii1", name: "Inverter", quantity: 1, unit_price: 210000, kind: "materials" }], payments: [{ id: "p1", amount: 45000, payment_method: "credit_card", paid_at: "2026-09-02" }], refunds: [] }]);
    send(404, { error: "no such route" });
  });
  return { server, hits, jobs };
}

function run(args, cwd) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [SCRIPT, ...args], { cwd, env: { ...process.env, AWS_REGION: "us-west-1" } });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("close", (code) => resolve({ code, out }));
  });
}

test("hcp-pull: probe, full pull, resume, refresh — against HCP's real shapes", async (t) => {
  const { server, hits } = fakeHcp();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const out = await fs.mkdtemp(path.join(os.tmpdir(), "hcp-pull-"));
  t.after(() => new Promise((r) => server.close(r)));

  // --- probe
  const probe = await run(["--probe", "--base", base, "--out", out], process.cwd());
  assert.equal(probe.code, 0, probe.out);
  const report = JSON.parse(await fs.readFile(path.join(out, "probe-report.json"), "utf8"));
  const byName = Object.fromEntries(report.calls.map((c) => [c.name, c]));
  assert.equal(byName.jobs.status, 200);
  assert.equal(byName.jobs.total_items, 7);
  assert.ok(byName.jobs.keys.includes("invoice_number"));
  assert.equal(byName["jobs/{id}/appointments"].keys.includes("dispatched_employees_ids"), true);
  assert.equal(byName["estimates/{id}/options/{opt}/line_items"].count, 1);
  assert.ok(byName.invoices.keys.includes("payments"), "the invoice list carries the payments");
  assert.equal(byName["invoices/{id}"], undefined, "no single-invoice read");
  assert.equal(byName["jobs/{id}/notes"], undefined, "the notes feed is not asked for");
  assert.ok(!probe.out.includes("cy@example.com"), "the probe prints keys, never values");

  // --- full pull
  const full = await run(["--base", base, "--out", out], process.cwd());
  assert.equal(full.code, 0, full.out);
  const jobFile = JSON.parse(await fs.readFile(path.join(out, "raw", "jobs", "job3.json"), "utf8"));
  assert.equal(jobFile.line_items[0].name, "Inverter");
  assert.equal(jobFile.appointments[0].dispatched_employees_ids[0], "e1");
  assert.deepEqual(jobFile.errors, {});
  const est = JSON.parse(await fs.readFile(path.join(out, "raw", "estimates", "est1.json"), "utf8"));
  assert.equal(est.options[0].line_items[0].name, "Panel");
  const csvs = await fs.readdir(path.join(out, "csv"));
  const leadsCsv = await fs.readFile(path.join(out, "csv", "leads.csv"), "utf8");
  assert.ok(leadsCsv.includes("lead_id,") || leadsCsv.includes("id,"), leadsCsv.slice(0, 200));
  assert.ok(leadsCsv.includes("Cy Diaz") && leadsCsv.includes("9 Elm St, Mesa, AZ, 85201") && leadsCsv.includes("Inverter"));
  for (const f of ["customers.csv", "employees.csv", "jobs.csv", "leads.csv", "job-line-items.csv", "appointments.csv", "estimates.csv", "estimate-line-items.csv", "invoices.csv", "invoice-line-items.csv", "payments.csv"]) {
    assert.ok(csvs.includes(f), `csv/${f}`);
  }
  const lines = (await fs.readFile(path.join(out, "csv", "job-line-items.csv"), "utf8")).split("\r\n").filter(Boolean);
  assert.equal(lines.length, 1 + 7);
  const apptLines = (await fs.readFile(path.join(out, "csv", "appointments.csv"), "utf8")).split("\r\n").filter(Boolean);
  assert.equal(apptLines.length, 1 + 6, "six jobs with appointments; job7 was refused");
  assert.ok(lines[1].includes("2100.00"));
  const pays = await fs.readFile(path.join(out, "csv", "payments.csv"), "utf8");
  assert.ok(pays.includes("credit_card") && pays.includes("450.00"));
  const apptCsv = await fs.readFile(path.join(out, "csv", "appointments.csv"), "utf8");
  assert.ok(apptCsv.includes("Jake Dorsey"), "tech names joined from employees.json");
  const invCsv = await fs.readFile(path.join(out, "csv", "invoices.csv"), "utf8");
  assert.ok(invCsv.includes("30.00"), "taxes_total from the list record");
  assert.ok(!hits["/invoices/inv1"], "no single-invoice reads");
  const summary = await fs.readFile(path.join(out, "SUMMARY.txt"), "utf8");
  assert.ok(summary.includes("jobs             7"), summary);
  const hitsAfterFull = { ...hits };
  assert.equal(hitsAfterFull["/jobs/job3/line_items"], 1);

  const job7 = JSON.parse(await fs.readFile(path.join(out, "raw", "jobs", "job7.json"), "utf8"));
  assert.equal(job7.errors.appointments, 400, "the refusal is recorded on the job");
  assert.ok(job7.line_items.length, "its other children still came");
  assert.ok(!summary.includes("NOT offered"), "a 400 never switches the endpoint off");

  // --- resume: unchanged jobs are not re-read, except the one HCP refused last time; lists are re-walked
  const again = await run(["--base", base, "--out", out], process.cwd());
  assert.equal(again.code, 0, again.out);
  assert.equal(hits["/jobs/job3/line_items"], 1, "unchanged job not re-read");
  assert.equal(hits["/jobs/job7/appointments"], 2, "the refused child is asked for again");
  assert.ok(again.out.includes("jobs: 1 of 7 need"), again.out);
  assert.ok(hits["/jobs"] > hitsAfterFull["/jobs"], "the list is re-walked every run");

  // --- --refresh re-reads
  const refresh = await run(["--base", base, "--out", out, "--only", "jobs", "--refresh"], process.cwd());
  assert.equal(refresh.code, 0, refresh.out);
  assert.equal(hits["/jobs/job3/line_items"], 2);
});
