// scripts/hcp-pull.mjs — pull everything the Housecall Pro API exposes, for the migration
// (2026-09-25). HCP's Excel exports stop at the header rows; this reaches underneath them:
// the line items on jobs, estimates and invoices, the appointments (which tech, when), the
// invoice payments and refunds, plus the reference lists (employees, tags, job types, lead
// sources) that the exports only name. NOT readable through the API (probed 2026-09-25):
// photos / attachments, and the job's notes feed — docs/migration.md.
//
//   node scripts/hcp-pull.mjs --probe            # one page of everything + one record's children;
//                                                #   prints what is really there; writes probe-report.json
//   node scripts/hcp-pull.mjs                    # the full pull (resumable — run it again after a stop)
//   node scripts/hcp-pull.mjs --only jobs,invoices
//   node scripts/hcp-pull.mjs --refresh          # re-read every record's children, changed or not
//   node scripts/hcp-pull.mjs --out D:\hcp-pull  # somewhere other than migration\hcp
//   node scripts/hcp-pull.mjs --fast             # 10 requests/s instead of 4 (backs off on a 429 either way)
//
// The key: Secrets Manager `sundial/hcp` → { "apiKey": "…" } (HCP → My Apps → All Apps →
// API Key Management → Generate, Read-only). Never a key in a file or an env var.
//
// Output (default C:\Users\…\sundial-core\migration\hcp\ — the folder is git-ignored; it is
// customer data):
//   raw/<list>.json            every record of each list, as HCP returned it
//   raw/jobs/<id>.json         { job, line_items, appointments, errors }
//   raw/estimates/<id>.json    { estimate, options: [{ option, line_items }], errors }
//   csv/*.csv                  one sheet per thing, ready for Excel next to HCP's own exports
//   state.json                 what is done (per record: its updated_at) — the resume point
//   SUMMARY.txt                counts, the endpoints HCP did not offer, request stats
//
// Reads only. Nothing here writes to HCP, Salesforce or Supabase.

import { promises as fs } from "node:fs";
import path from "node:path";
import { getSecret } from "../lib/secrets.js";
import {
  HCP_SECRET, RESOURCES, PULL_ORDER, createHcpClient, listOf, fillPath, toCsv,
  jobRow, lineItemRows, appointmentRows, invoiceRow, paymentRows, personName, addressLine, dollars,
} from "../lib/hcp-api.js";

// ---------------------------------------------------------------- arguments
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, d = null) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : d;
};
const PROBE = flag("--probe");
const REFRESH = flag("--refresh");
const FAST = flag("--fast");
const OUT = path.resolve(opt("--out", path.join("migration", "hcp")));
const ONLY = (opt("--only", "") || "").split(",").map((x) => x.trim()).filter(Boolean);
const CONCURRENCY = 3;
// A child endpoint that answers 404 / 403 / 400 this many times in a row is not offered
// on this account: stop asking, say so in the summary.
const GIVE_UP_AFTER = 20;

const RAW = path.join(OUT, "raw");
const CSV = path.join(OUT, "csv");
const STATE_FILE = path.join(OUT, "state.json");

const selected = PULL_ORDER.filter((r) => ONLY.length === 0 || ONLY.includes(r));
if (selected.length === 0) {
  console.error(`--only: nothing matched. Known: ${PULL_ORDER.join(", ")}`);
  process.exit(2);
}

// ---------------------------------------------------------------- helpers
async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}
async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(value, null, 2));
}
const stamp = (r) => String(r?.updated_at ?? r?.created_at ?? "?");
const ok = (status) => status >= 200 && status < 300;
// Only "the route does not exist" answers count towards giving up. A 400 is HCP refusing
// THAT record (Harmon's run 2026-09-25: 356 × 400 on /appointments for jobs with no
// schedule) and must never switch the endpoint off for the jobs that do have one.
const NOT_OFFERED = new Set([403, 404, 405]);

/** Run `fn(item)` over `items` with a fixed number of workers, in order of the list. */
async function pool(items, n, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    for (;;) {
      const ix = i++;
      if (ix >= items.length) return;
      await fn(items[ix], ix);
    }
  });
  await Promise.all(workers);
}

/** Tracks whether a child endpoint is worth calling. */
function availability() {
  const streak = {};
  const off = new Set();
  return {
    off: (name) => off.has(name),
    note(name, status) {
      if (ok(status)) {
        streak[name] = 0;
        return;
      }
      if (!NOT_OFFERED.has(status)) return;
      streak[name] = (streak[name] || 0) + 1;
      if (streak[name] >= GIVE_UP_AFTER && !off.has(name)) {
        off.add(name);
        console.log(`  ${name}: ${status} ${GIVE_UP_AFTER} times in a row — not offered on this account; skipping the rest`);
      }
    },
    list: () => [...off],
  };
}

// ---------------------------------------------------------------- the client
// `--base http://127.0.0.1:<port>` points the pull at a local fake (the smoke test in
// scripts/hcp-pull.smoke.mjs); only a loopback host is accepted, and only then is the key
// a dummy. The real API always takes its key from Secrets Manager.
const BASE = opt("--base", null);
let apiKey;
if (BASE) {
  const host = new URL(BASE).hostname;
  if (!["127.0.0.1", "localhost", "[::1]"].includes(host)) {
    console.error("--base is for a local fake server only (127.0.0.1 / localhost).");
    process.exit(2);
  }
  apiKey = "local-test";
} else {
  const secret = await getSecret(HCP_SECRET);
  apiKey = secret?.apiKey;
  if (!apiKey) {
    console.error(`Secrets Manager ${HCP_SECRET} has no "apiKey".`);
    process.exit(2);
  }
}
const client = createHcpClient({
  apiKey,
  baseUrl: BASE || undefined,
  minGapMs: FAST ? 100 : 250,
  log: (m) => console.log(`  [api] ${m}`),
});

await fs.mkdir(RAW, { recursive: true });
await fs.mkdir(CSV, { recursive: true });
const state = await readJson(STATE_FILE, { lists: {}, children: {} });
const saveState = () => writeJson(STATE_FILE, state);

// ---------------------------------------------------------------- probe
if (PROBE) {
  console.log(`Probing the HCP API …`);
  const report = { at: new Date().toISOString(), calls: [] };
  const record = (name, r, key) => {
    const items = key === undefined ? (r.body && typeof r.body === "object" ? [r.body] : []) : listOf(r.body, key);
    const first = items[0];
    const entry = {
      name, status: r.status, count: items.length,
      envelope: r.body && typeof r.body === "object" && !Array.isArray(r.body) ? Object.keys(r.body) : Array.isArray(r.body) ? ["<array>"] : [typeof r.body],
      keys: first && typeof first === "object" ? Object.keys(first) : [],
      total_items: r.body?.total_items ?? null,
    };
    report.calls.push(entry);
    console.log(`  ${entry.status}  ${name.padEnd(34)} ${String(entry.count).padStart(3)} item(s)${entry.total_items != null ? ` of ${entry.total_items}` : ""}  keys: ${entry.keys.join(", ") || "-"}`);
    return first;
  };
  const firsts = {};
  for (const name of selected) {
    const res = RESOURCES[name];
    if (res.single) {
      record(name, await client.get(res.path));
      continue;
    }
    firsts[name] = record(name, await client.get(res.path, { page: 1, page_size: 5 }), res.key);
  }
  const job = firsts.jobs;
  if (job?.id) {
    for (const [child, tpl] of Object.entries(RESOURCES.jobs.children)) {
      record(`jobs/{id}/${child}`, await client.get(fillPath(tpl, { id: job.id })), child);
    }
  }
  const est = firsts.estimates;
  if (est?.id) {
    const option = (est.options || [])[0];
    if (option?.id) record("estimates/{id}/options/{opt}/line_items", await client.get(fillPath(RESOURCES.estimates.optionChild, { id: est.id, optionId: option.id })), "line_items");
    else console.log("  (the first estimate has no options[] with an id — the option line-items call was not tried)");
  }
  report.auth = client.scheme;
  report.stats = client.stats;
  await writeJson(path.join(OUT, "probe-report.json"), report);
  console.log(`\nAuth that worked: Authorization: ${client.scheme} …   requests: ${client.stats.requests}`);
  console.log(`Report: ${path.join(OUT, "probe-report.json")} (keys and counts only — no customer data)`);
}

// Everything below is the full pull. It is skipped after a probe by falling off the end of
// the module rather than process.exit(): on Windows, exiting while stdout is still being
// flushed trips a libuv assertion ("UV_HANDLE_CLOSING") after the useful output.
if (!PROBE) {

// ---------------------------------------------------------------- lists
const counts = {};
async function pullList(name) {
  const res = RESOURCES[name];
  if (res.single) {
    const r = await client.get(res.path);
    if (!ok(r.status)) {
      console.log(`  ${name}: HTTP ${r.status} — skipped`);
      return null;
    }
    await writeJson(path.join(RAW, `${name}.json`), r.body);
    counts[name] = 1;
    return r.body;
  }
  const all = [];
  let error = null;
  for await (const p of client.pages(res.path, { key: res.key })) {
    if (p.error) {
      error = p.error;
      break;
    }
    all.push(...p.items);
    if (p.total_pages && p.total_pages > 1) process.stdout.write(`\r  ${name}: page ${p.page}/${p.total_pages} (${all.length} so far)   `);
  }
  if (all.length && process.stdout.isTTY) process.stdout.write("\n");
  if (error && all.length === 0) {
    console.log(`  ${name}: HTTP ${error} — skipped`);
    return null;
  }
  await writeJson(path.join(RAW, `${name}.json`), all);
  state.lists[name] = { at: new Date().toISOString(), count: all.length, error };
  counts[name] = all.length;
  console.log(`  ${name}: ${all.length} record(s)${error ? ` (stopped early: HTTP ${error})` : ""}`);
  return all;
}

// ---------------------------------------------------------------- children
const avail = availability();

/** A saved job file that is missing a child (refused last time, or the child was added later) is read again. */
async function needsRetry(job) {
  const saved = await readJson(path.join(RAW, "jobs", `${job.id}.json`), null);
  if (!saved) return true;
  if (saved.errors && Object.keys(saved.errors).length) return true;
  return Object.keys(RESOURCES.jobs.children).some((child) => !(child in saved) && !avail.off(child));
}

async function pullJobChildren(jobs) {
  const done = (state.children.jobs ||= {});
  const todo = [];
  for (const j of jobs) {
    if (REFRESH || done[j.id] !== stamp(j) || (await needsRetry(j))) todo.push(j);
  }
  console.log(`  jobs: ${todo.length} of ${jobs.length} need their line items / appointments`);
  let n = 0;
  await pool(todo, CONCURRENCY, async (job) => {
    const out = { job, errors: {} };
    for (const [child, tpl] of Object.entries(RESOURCES.jobs.children)) {
      if (avail.off(child)) continue;
      const r = await client.get(fillPath(tpl, { id: job.id }));
      avail.note(child, r.status);
      if (ok(r.status)) out[child] = listOf(r.body, child);
      else out.errors[child] = r.status;
    }
    await writeJson(path.join(RAW, "jobs", `${job.id}.json`), out);
    done[job.id] = stamp(job);
    if (++n % 50 === 0) {
      await saveState();
      console.log(`  jobs: ${n}/${todo.length}`);
    }
  });
  await saveState();
}

async function pullEstimateChildren(estimates) {
  const done = (state.children.estimates ||= {});
  const todo = REFRESH ? estimates : estimates.filter((e) => done[e.id] !== stamp(e));
  console.log(`  estimates: ${todo.length} of ${estimates.length} need their option line items`);
  let n = 0;
  await pool(todo, CONCURRENCY, async (est) => {
    const out = { estimate: est, options: [], errors: {} };
    for (const option of est.options || []) {
      if (!option?.id || avail.off("option_line_items")) {
        out.options.push({ option, line_items: null });
        continue;
      }
      const r = await client.get(fillPath(RESOURCES.estimates.optionChild, { id: est.id, optionId: option.id }));
      avail.note("option_line_items", r.status);
      if (ok(r.status)) out.options.push({ option, line_items: listOf(r.body, "line_items") });
      else {
        out.options.push({ option, line_items: null });
        out.errors[option.id] = r.status;
      }
    }
    await writeJson(path.join(RAW, "estimates", `${est.id}.json`), out);
    done[est.id] = stamp(est);
    if (++n % 50 === 0) {
      await saveState();
      console.log(`  estimates: ${n}/${todo.length}`);
    }
  });
  await saveState();
}

// ---------------------------------------------------------------- CSV (rebuilt from raw/ every run)
async function readDir(dir) {
  try {
    const names = await fs.readdir(dir);
    const out = [];
    for (const f of names) if (f.endsWith(".json")) out.push(await readJson(path.join(dir, f), null));
    return out.filter(Boolean);
  } catch {
    return [];
  }
}

const s = (v) => (v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));

async function buildCsvs() {
  const files = {};
  const customers = await readJson(path.join(RAW, "customers.json"), []);
  if (customers.length) {
    files["customers.csv"] = customers.map((c) => {
      const service = (c.addresses || []).find((a) => a.type === "service") || (c.addresses || [])[0];
      const billing = (c.addresses || []).find((a) => a.type === "billing");
      return {
        customer_id: s(c.id), name: personName(c), first_name: s(c.first_name), last_name: s(c.last_name), company: s(c.company),
        email: s(c.email), mobile_number: s(c.mobile_number), home_number: s(c.home_number), work_number: s(c.work_number),
        lead_source: s(c.lead_source), tags: (c.tags || []).map(s).join("; "), notifications_enabled: s(c.notifications_enabled),
        service_address: addressLine(service), billing_address: addressLine(billing), address_count: s((c.addresses || []).length),
        notes: s(c.notes), created_at: s(c.created_at), updated_at: s(c.updated_at),
      };
    });
  }
  const employees = await readJson(path.join(RAW, "employees.json"), []);
  const employeesById = new Map(employees.map((e) => [String(e.id), e]));
  if (employees.length) {
    files["employees.csv"] = employees.map((e) => ({
      employee_id: s(e.id), name: personName(e), email: s(e.email), mobile_number: s(e.mobile_number), role: s(e.role), color_hex: s(e.color_hex),
    }));
  }
  for (const name of ["tags", "job_types", "lead_sources"]) {
    const rows = await readJson(path.join(RAW, `${name}.json`), []);
    if (rows.length) files[`${name}.csv`] = rows.map((r) => (typeof r === "object" ? Object.fromEntries(Object.entries(r).map(([k, v]) => [k, s(v)])) : { value: s(r) }));
  }

  // leads: every scalar as a column, nested objects flattened one level (customer.first_name …)
  const leads = await readJson(path.join(RAW, "leads.json"), []);
  if (leads.length) {
    files["leads.csv"] = leads.map((l) => {
      const row = {};
      for (const [k, v] of Object.entries(l)) {
        if (v && typeof v === "object" && !Array.isArray(v)) {
          if (k === "customer") { row.customer_id = s(v.id); row.customer = personName(v); row.customer_email = s(v.email); row.customer_phone = s(v.mobile_number ?? v.home_number ?? v.work_number); }
          else if (k === "address") row.address = addressLine(v);
          else for (const [k2, v2] of Object.entries(v)) row[`${k}_${k2}`] = s(v2);
        } else row[k] = Array.isArray(v) ? v.map(s).join("; ") : s(v);
      }
      return row;
    });
  }

  const jobFiles = await readDir(path.join(RAW, "jobs"));
  const jobsList = await readJson(path.join(RAW, "jobs.json"), []);
  const byId = new Map(jobFiles.map((f) => [f.job?.id, f]));
  if (jobsList.length) files["jobs.csv"] = jobsList.map(jobRow);
  const jobLines = [], appts = [];
  for (const j of jobsList) {
    const f = byId.get(j.id);
    if (!f) continue;
    jobLines.push(...lineItemRows(j, f.line_items, { source: "job" }));
    appts.push(...appointmentRows(j, f.appointments, employeesById));
  }
  if (jobLines.length) files["job-line-items.csv"] = jobLines;
  if (appts.length) files["appointments.csv"] = appts;

  const estList = await readJson(path.join(RAW, "estimates.json"), []);
  const estFiles = await readDir(path.join(RAW, "estimates"));
  const estById = new Map(estFiles.map((f) => [f.estimate?.id, f]));
  if (estList.length) {
    files["estimates.csv"] = estList.map((e) => ({
      estimate_id: s(e.id), estimate_number: s(e.estimate_number), work_status: s(e.work_status), approval_status: s(e.approval_status),
      customer_id: s(e.customer?.id), customer: personName(e.customer), address: addressLine(e.address), total_amount: dollars(e.total_amount),
      option_count: s((e.options || []).length),
      options: (e.options || []).map((o) => `${o.name ?? o.id}: ${dollars(o.total_amount)}${o.approval_status ? ` [${o.approval_status}]` : ""}`).join("; "),
      scheduled_start: s(e.schedule?.scheduled_start), scheduled_end: s(e.schedule?.scheduled_end),
      assigned_employees: (e.assigned_employees || []).map(personName).join("; "),
      on_my_way_at: s(e.work_timestamps?.on_my_way_at), started_at: s(e.work_timestamps?.started_at), completed_at: s(e.work_timestamps?.completed_at),
      lead_source: s(e.lead_source), estimate_fields: s(e.estimate_fields), created_at: s(e.created_at), updated_at: s(e.updated_at),
    }));
    const estLines = [];
    for (const e of estList) {
      const f = estById.get(e.id);
      for (const { option, line_items } of f?.options || []) {
        estLines.push(...lineItemRows(e, line_items, { source: "estimate", option_id: s(option?.id), option_name: s(option?.name), option_status: s(option?.approval_status ?? option?.status) }));
      }
    }
    if (estLines.length) files["estimate-line-items.csv"] = estLines;
  }

  // the invoice list record is the whole invoice: its items, taxes, discounts, payments, refunds
  const invList = await readJson(path.join(RAW, "invoices.json"), []);
  if (invList.length) {
    files["invoices.csv"] = invList.map(invoiceRow);
    const invLines = [], pays = [];
    for (const i of invList) {
      invLines.push(...lineItemRows({ id: i.id, invoice_number: i.invoice_number }, i.items, { source: "invoice", job_id: s(i.job_id) }));
      pays.push(...paymentRows(i));
    }
    if (invLines.length) files["invoice-line-items.csv"] = invLines;
    if (pays.length) files["payments.csv"] = pays;
  }

  for (const [name, rows] of Object.entries(files)) {
    await fs.writeFile(path.join(CSV, name), toCsv(rows));
    counts[`csv:${name}`] = rows.length;
  }
  return Object.keys(files);
}

// ---------------------------------------------------------------- run
console.log(`HCP pull → ${OUT}\n  resources: ${selected.join(", ")}${REFRESH ? "  (refresh: every record's children)" : ""}`);
const started = Date.now();
try {
  for (const name of selected) {
    console.log(`\n${name}`);
    const list = await pullList(name);
    if (!list || RESOURCES[name].single) continue;
    if (name === "jobs") await pullJobChildren(list);
    if (name === "estimates") await pullEstimateChildren(list);
  }
} finally {
  await saveState();
}

console.log("\nBuilding the CSVs from raw/ …");
const csvs = await buildCsvs();

const mins = ((Date.now() - started) / 60000).toFixed(1);
const summary = [
  `HCP pull — ${new Date().toISOString()} — ${mins} min — ${OUT}`,
  `auth: Authorization: ${client.scheme} …   requests: ${client.stats.requests}   retries: ${client.stats.retries}   statuses: ${JSON.stringify(client.stats.statuses)}`,
  "",
  "records:",
  ...Object.entries(counts).filter(([k]) => !k.startsWith("csv:")).map(([k, v]) => `  ${k.padEnd(16)} ${v}`),
  "",
  "csv/:",
  ...csvs.map((n) => `  ${n.padEnd(26)} ${counts[`csv:${n}`]} row(s)`),
  "",
  avail.list().length
    ? `NOT offered by the API on this account (stopped asking after ${GIVE_UP_AFTER} refusals): ${avail.list().join(", ")}`
    : "every child endpoint answered.",
  "",
  "Not reachable through the API at all: photos / attachments, and the job's notes feed (only the job's one notes field). See docs/migration.md.",
  "",
].join("\n");
await fs.writeFile(path.join(OUT, "SUMMARY.txt"), summary);
console.log(`\n${summary}`);
}
