// lib/hcp-api.js — a read-only client for the Housecall Pro public API (2026-09-25), for the
// Phase 2 migration. HCP's own exports (Excel: customers, estimates, jobs, invoices) carry
// the header rows only; everything underneath — the line items, the job notes, the
// appointments (which tech, when), the invoice payments — is reachable only through the
// MAX-plan API, and that is what `scripts/hcp-pull.mjs` pulls with this module.
//
// What the API does NOT expose to a reader (probed against Harmon's account 2026-09-25):
// the photos and attachments on jobs / estimates (there is an "add attachment" call, no
// "list"), the job's NOTES FEED (`/jobs/{id}/notes` is a 404; only the job's one `notes`
// text field comes back), and a single-invoice read (`/invoices/{id}` is a 404 — but the
// invoice LIST already carries items, taxes, discounts, payments and refunds, so nothing
// is lost). Those two gaps need the signed-in web app — see docs/migration.md.
//
// Facts this file relies on (docs.housecallpro.com, "Housecall v1 API"):
//   base URL      https://api.housecallpro.com
//   auth          `Authorization: Token {key}` — the key comes from HCP → My Apps → All Apps →
//                 API Key Management (admin only, MAX plan); Bearer is accepted too, so the
//                 client tries Token first and falls back to Bearer on a 401.
//   pagination    ?page=N&page_size=M, the list under a plural key ({ jobs: [...] }) with
//                 page / page_size / total_pages / total_items beside it.
//   money         integers in cents.
// The exact shape of every sub-resource is NOT something this code assumes: the pull
// script saves the raw JSON for each call, and `--probe` prints each endpoint's status and
// keys so the first run against the real account tells us what is there.
//
// The key is read from Secrets Manager `sundial/hcp` → { "apiKey": "…" } by the script,
// never from a file or an env var (CLAUDE.md).

export const HCP_SECRET = "sundial/hcp";
export const HCP_BASE_URL = "https://api.housecallpro.com";
export const DEFAULT_PAGE_SIZE = 100;
const MAX_ATTEMPTS = 8;

/**
 * The resources the pull walks. `path` is the collection endpoint (its plural `key`
 * names the array in the envelope); `children` are per-record calls, `{id}` replaced.
 * Every child is best-effort: a 404 / 403 is recorded and the pull moves on, so an
 * endpoint HCP does not offer never stops the run. Probed 2026-09-25: the job's
 * `line_items` and `appointments` answer; `notes` and a single-invoice read do not, and
 * `/jobs/{id}/invoices` only repeats what `/invoices` lists (with `job_id`), so neither
 * is called.
 */
export const RESOURCES = Object.freeze({
  company: { path: "/company", single: true },
  employees: { path: "/employees", key: "employees" },
  tags: { path: "/tags", key: "tags" },
  job_types: { path: "/job_fields/job_types", key: "job_types" },
  lead_sources: { path: "/lead_sources", key: "lead_sources" },
  customers: { path: "/customers", key: "customers" },
  // HCP's Leads (the pre-estimate pipeline Harmon uses for incoming calls) — shape unknown
  // until probed; the CSV is a generic flatten of whatever comes back.
  leads: { path: "/leads", key: "leads" },
  jobs: {
    path: "/jobs",
    key: "jobs",
    children: {
      line_items: "/jobs/{id}/line_items",
      appointments: "/jobs/{id}/appointments",
    },
  },
  estimates: {
    path: "/estimates",
    key: "estimates",
    // one call per option: the estimate's `options[]` carry the option ids
    optionChild: "/estimates/{id}/options/{optionId}/line_items",
  },
  // the list record is the whole invoice: items, taxes, discounts, payments, refunds, job_id
  invoices: { path: "/invoices", key: "invoices" },
});

/** The order the pull runs in: reference lists first, the big three last. */
export const PULL_ORDER = Object.freeze([
  "company", "employees", "tags", "job_types", "lead_sources",
  "customers", "leads", "jobs", "estimates", "invoices",
]);

const sleepReal = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {object} deps
 *   apiKey      the HCP key
 *   fetchImpl   fetch (tests inject one)
 *   sleep       (ms) => Promise (tests inject one)
 *   log         (msg) => void
 *   minGapMs    the gap between two requests (a gentle 250 ms = 4/s by default)
 *   authScheme  "Token" | "Bearer" — the first one tried
 */
export function createHcpClient({
  apiKey,
  baseUrl = HCP_BASE_URL,
  fetchImpl = (u, i) => fetch(u, i),
  sleep = sleepReal,
  log = () => {},
  minGapMs = 250,
  authScheme = "Token",
} = {}) {
  if (!apiKey) throw new Error("createHcpClient: apiKey is required");
  let scheme = authScheme;
  let gapMs = minGapMs;
  let lastAt = 0;
  const stats = { requests: 0, retries: 0, statuses: {} };

  async function throttle() {
    const wait = lastAt + gapMs - Date.now();
    if (wait > 0) await sleep(wait);
    lastAt = Date.now();
  }

  function url(path, query) {
    const u = new URL(path, baseUrl);
    for (const [k, v] of Object.entries(query || {})) {
      if (v == null || v === "") continue;
      if (Array.isArray(v)) v.forEach((x) => u.searchParams.append(`${k}[]`, String(x)));
      else u.searchParams.set(k, String(v));
    }
    return u.toString();
  }

  /**
   * GET one URL. Returns { status, body } — body parsed when JSON, else the text.
   * 429 and 5xx are retried with backoff (Retry-After honoured); a 401 on the first
   * scheme switches to the other one once; anything else is returned as-is.
   */
  async function get(path, query) {
    const target = url(path, query);
    let attempt = 0;
    let switched = false;
    for (;;) {
      attempt++;
      await throttle();
      stats.requests++;
      let res;
      try {
        res = await fetchImpl(target, {
          headers: { Authorization: `${scheme} ${apiKey}`, Accept: "application/json" },
        });
      } catch (e) {
        if (attempt >= MAX_ATTEMPTS) throw e;
        stats.retries++;
        log(`network error on ${path} (${e?.message || e}); retry ${attempt}`);
        await sleep(backoffMs(attempt));
        continue;
      }
      stats.statuses[res.status] = (stats.statuses[res.status] || 0) + 1;
      if (res.status === 401 && !switched) {
        switched = true;
        scheme = scheme === "Token" ? "Bearer" : "Token";
        log(`401 with Authorization: ${scheme === "Token" ? "Bearer" : "Token"}; trying ${scheme}`);
        continue;
      }
      if (res.status === 429 || res.status >= 500) {
        if (attempt >= MAX_ATTEMPTS) return { status: res.status, body: await readBody(res) };
        stats.retries++;
        // HCP's real limit is below 4/s sustained (Harmon's run: 293 × 429): every 429 slows
        // the whole run down a notch, for good, so the retries stop compounding.
        if (res.status === 429) gapMs = Math.min(1000, gapMs + 100);
        const ra = Number(res.headers?.get?.("retry-after"));
        const wait = Number.isFinite(ra) && ra > 0 ? ra * 1000 : backoffMs(attempt);
        log(`${res.status} on ${path}; waiting ${wait} ms`);
        await sleep(wait);
        continue;
      }
      return { status: res.status, body: await readBody(res) };
    }
  }

  /**
   * Walk a paginated list. Yields { page, items, total_pages, total_items, body } per
   * page and stops on an empty page, on page >= total_pages, or on a non-2xx (the
   * caller sees the status on the yielded `error`).
   */
  async function* pages(path, { key, query = {}, pageSize = DEFAULT_PAGE_SIZE, startPage = 1 } = {}) {
    let page = startPage;
    for (;;) {
      const r = await get(path, { ...query, page, page_size: pageSize });
      if (r.status < 200 || r.status >= 300) {
        yield { page, items: [], error: r.status, body: r.body };
        return;
      }
      const items = listOf(r.body, key);
      const total_pages = numberOr(r.body?.total_pages, null);
      const total_items = numberOr(r.body?.total_items, null);
      yield { page, items, total_pages, total_items, body: r.body };
      if (items.length === 0) return;
      if (total_pages != null && page >= total_pages) return;
      if (total_pages == null && items.length < pageSize) return;
      page++;
    }
  }

  return { get, pages, stats, get scheme() { return scheme; }, get gapMs() { return gapMs; } };
}

function backoffMs(attempt) {
  return Math.min(30_000, 1000 * 2 ** (attempt - 1));
}

async function readBody(res) {
  const text = await res.text();
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return text;
  }
}

function numberOr(v, d) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

/** The array in a list envelope: the named key, else the first array-valued property, else []. */
export function listOf(body, key) {
  if (Array.isArray(body)) return body;
  if (!body || typeof body !== "object") return [];
  if (key && Array.isArray(body[key])) return body[key];
  for (const v of Object.values(body)) if (Array.isArray(v)) return v;
  return [];
}

/** Fill `{id}` / `{optionId}` in a child path. */
export function fillPath(template, params) {
  return template.replace(/\{(\w+)\}/g, (_, k) => encodeURIComponent(String(params[k] ?? "")));
}

// ---------------------------------------------------------------------------------------
// CSV — the office opens these in Excel next to HCP's own exports. One row per line /
// note / appointment / payment, always carrying the parent's id + number so a VLOOKUP
// back to the export sheets works. Cents become dollars in the CSV; the JSON keeps cents.

export function dollars(cents) {
  if (cents == null || cents === "") return "";
  const n = Number(cents);
  return Number.isFinite(n) ? (n / 100).toFixed(2) : "";
}

const s = (v) => (v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));

export function personName(p) {
  if (!p || typeof p !== "object") return "";
  return [p.first_name, p.last_name].filter(Boolean).join(" ") || p.name || p.company || "";
}

export function addressLine(a) {
  if (!a || typeof a !== "object") return "";
  return [a.street, a.street_line_2, a.city, a.state, a.zip].filter(Boolean).join(", ");
}

/** The job's own columns (one row per job). */
export function jobRow(j) {
  return {
    job_id: s(j.id),
    invoice_number: s(j.invoice_number),
    work_status: s(j.work_status),
    customer_id: s(j.customer?.id),
    customer: personName(j.customer),
    address: addressLine(j.address),
    description: s(j.description),
    notes_field: s(j.notes),
    scheduled_start: s(j.schedule?.scheduled_start),
    scheduled_end: s(j.schedule?.scheduled_end),
    on_my_way_at: s(j.work_timestamps?.on_my_way_at),
    started_at: s(j.work_timestamps?.started_at),
    completed_at: s(j.work_timestamps?.completed_at),
    assigned_employees: (j.assigned_employees || []).map(personName).join("; "),
    tags: (j.tags || []).map(s).join("; "),
    lead_source: s(j.lead_source),
    original_estimate_id: s(j.original_estimate_id),
    subtotal: dollars(j.subtotal),
    total_amount: dollars(j.total_amount),
    outstanding_balance: dollars(j.outstanding_balance),
    job_fields: s(j.job_fields),
    recurrence_id: s(j.recurrence_id),
    created_at: s(j.created_at),
    updated_at: s(j.updated_at),
    canceled_at: s(j.canceled_at),
    deleted_at: s(j.deleted_at),
    locked_at: s(j.locked_at),
  };
}

/** One row per line item on a job (or an estimate option). */
export function lineItemRows(parent, items, extra = {}) {
  return (items || []).map((li) => ({
    ...extra,
    parent_id: s(parent.id),
    parent_number: s(parent.invoice_number ?? parent.estimate_number),
    line_item_id: s(li.id),
    name: s(li.name),
    description: s(li.description),
    kind: s(li.kind ?? li.type),
    quantity: s(li.quantity),
    unit_of_measure: s(li.unit_of_measure),
    unit_price: dollars(li.unit_price),
    unit_cost: dollars(li.unit_cost),
    amount: dollars(li.amount ?? (Number(li.unit_price) * Number(li.quantity) || null)),
    taxable: s(li.taxable),
    duration_in_minutes: s(li.duration_in_minutes),
    order_index: s(li.order_index),
    service_item_id: s(li.service_item_id ?? li.price_book_id ?? li.pricebook_id),
    service_item_type: s(li.service_item_type),
  }));
}

/** One row per note on a job. */
export function noteRows(job, notes) {
  return (notes || []).map((n) => ({
    job_id: s(job.id),
    invoice_number: s(job.invoice_number),
    note_id: s(n.id),
    content: s(n.content ?? n.note ?? n.body ?? n.text),
    author: personName(n.employee ?? n.author ?? n.created_by) || s(n.employee_id),
    created_at: s(n.created_at),
    updated_at: s(n.updated_at),
  }));
}

/**
 * One row per appointment (a visit) on a job. HCP's shape: `start_date` (YYYY-MM-DD),
 * `start_time` / `end_time` (either full timestamps or HH:MM on that date), `anytime`,
 * `arrival_window_minutes`, `dispatched_employees_ids` — ids only, so the names are
 * joined from the employees list (`employeesById`: id → employee record).
 */
export function appointmentRows(job, appts, employeesById = new Map()) {
  return (appts || []).map((a) => {
    const ids = (a.dispatched_employees_ids || a.dispatched_employees || a.assigned_employees || a.employees || [])
      .map((e) => s(e?.id ?? e))
      .filter(Boolean);
    return {
      job_id: s(job.id),
      invoice_number: s(job.invoice_number),
      appointment_id: s(a.id),
      start_date: s(a.start_date),
      start_time: s(a.start_time ?? a.scheduled_start ?? a.start),
      end_time: s(a.end_time ?? a.scheduled_end ?? a.end),
      anytime: s(a.anytime),
      arrival_window_minutes: s(a.arrival_window_minutes ?? a.arrival_window),
      dispatched_employees: ids.map((id) => personName(employeesById.get(id)) || id).join("; "),
      employee_ids: ids.join("; "),
    };
  });
}

/** The invoice's own row (the list record carries everything). */
export function invoiceRow(inv) {
  const sum = (list, k = "amount") => (Array.isArray(list) ? list.reduce((n, x) => n + (Number(x?.[k]) || 0), 0) : null);
  return {
    invoice_id: s(inv.id),
    invoice_number: s(inv.invoice_number),
    status: s(inv.status),
    job_id: s(inv.job_id ?? inv.job?.id),
    customer_id: s(inv.customer_id ?? inv.customer?.id),
    subtotal: dollars(inv.subtotal),
    amount: dollars(inv.amount ?? inv.total_amount),
    due_amount: dollars(inv.due_amount ?? inv.outstanding_balance),
    taxes_total: dollars(sum(inv.taxes)),
    discounts_total: dollars(sum(inv.discounts)),
    payments_total: dollars(sum(inv.payments)),
    refunds_total: dollars(sum(inv.refunds)),
    due_concept: s(inv.display_due_concept ?? inv.due_concept),
    invoice_date: s(inv.invoice_date),
    service_date: s(inv.service_date),
    due_at: s(inv.due_at),
    sent_at: s(inv.sent_at),
    paid_at: s(inv.paid_at),
    created_at: s(inv.created_at),
    updated_at: s(inv.updated_at),
  };
}

/** One row per payment and per refund on an invoice (refunds come back negative). */
export function paymentRows(inv) {
  const row = (p, kind) => ({
    invoice_id: s(inv.id),
    invoice_number: s(inv.invoice_number),
    job_id: s(inv.job_id ?? inv.job?.id),
    payment_id: s(p.id),
    kind,
    method: s(p.payment_method ?? p.method ?? p.source ?? p.kind ?? p.type),
    amount: dollars(kind === "refund" ? -Math.abs(Number(p.amount) || 0) : p.amount),
    status: s(p.status),
    paid_at: s(p.paid_at ?? p.refunded_at ?? p.created_at ?? p.date),
    reference: s(p.check_number ?? p.reference ?? p.transaction_id ?? p.note),
  });
  const pays = (inv.payments || inv.transactions || []).map((p) => row(p, p.kind === "refund" || Number(p.amount) < 0 ? "refund" : "payment"));
  const refunds = (inv.refunds || []).map((r) => row(r, "refund"));
  return [...pays, ...refunds];
}

/** A CSV with a header from the union of keys, quoted per RFC 4180, CRLF rows (Excel). */
export function toCsv(rows) {
  if (!rows || rows.length === 0) return "";
  const cols = [];
  for (const r of rows) for (const k of Object.keys(r)) if (!cols.includes(k)) cols.push(k);
  const cell = (v) => {
    const str = v == null ? "" : String(v);
    return /[",\r\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
  };
  const lines = [cols.map(cell).join(",")];
  for (const r of rows) lines.push(cols.map((c) => cell(r[c])).join(","));
  return "﻿" + lines.join("\r\n") + "\r\n";
}
