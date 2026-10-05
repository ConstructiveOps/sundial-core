// lib/hcp-import.js — the decisions of the Housecall Pro import (2026-09-25, docs/migration.md):
// how an HCP customer finds (or does not find) an existing Sundial customer, and what each
// HCP record becomes in Salesforce. Pure functions over the pulled JSON; the script
// (scripts/hcp-import.mjs) does the reading and the writing. Nothing here talks to
// Salesforce, so all of it is unit-tested against the real shapes from the 2026-09-25 probe.
//
// The two-pass rule (Tim, 2026-09-25):
//   first import   an HCP customer is matched to an existing Sundial customer (prior solar /
//                  roofing work) by exact email, else by normalised street + zip; a match is
//                  STAMPED with HCP_Id__c, anything ambiguous is created new + written to the
//                  review sheet, never guessed
//   every run      a record whose HCP id is already in Sundial is found by HCP_Id__c alone —
//                  that is the go-live delta, and why every child carries its own HCP_Id__c
//
// Money: HCP sends cents; Salesforce currency fields take dollars.

import { createHash } from "node:crypto";
import { billToFields, jobNotesText } from "./hcp-bill-to.js";
import { matchPicklist, normalizeEmail, normalizePhone, normalizeZip, streetKey, unionProjectTypes } from "../lambdas/sundial-service-estimate/customer.js";
import { ARCHIVE_NOTE, closedLeadOutcome, openLeadStage } from "./hcp-disposition.js";

export const HCP_ID_FIELD = "HCP_Id__c";

/**
 * Fields Salesforce computes itself (formulas): the builders below still fill them so the
 * estimate subtotals can be summed from the line rows, but they must never reach an
 * upsert — INVALID_FIELD_FOR_INSERT_UPDATE on the first canary (2026-09-28, Line_Total__c).
 */
export const FORMULA_FIELDS = Object.freeze({
  Sundial_Service_Line__c: ["Line_Total__c"],
  Sundial_Service_Job__c: ["Estimate_Status__c", "Estimate_Total__c", "Estimate_Approved_Amount__c", "Estimate_Deposit_Amount__c"],
  Sundial_Service_Invoice__c: ["Balance__c"],
});

/** The record without the fields Salesforce refuses to take. */
export function writable(sfObject, record) {
  const drop = FORMULA_FIELDS[sfObject];
  if (!drop) return record;
  const out = { ...record };
  for (const k of drop) delete out[k];
  return out;
}
export const MIGRATION_NOTE = "Migrated from Housecall Pro";
/** Arizona keeps MST all year: a fixed -07:00 is correct for every HCP timestamp Harmon has. */
export const TZ_OFFSET = "-07:00";
const TZ_HOURS = -7;

const s = (v) => (v == null ? "" : String(v).trim());
/** Cut to a Text(n) field's length, ending on "…" when something was lost. */
export const cut = (v, n) => {
  const str = s(v);
  return str.length <= n ? str : `${str.slice(0, n - 1)}…`;
};
export const dollars = (cents) => (cents == null || cents === "" || !Number.isFinite(Number(cents)) ? null : Math.round(Number(cents)) / 100);
const iso = (v) => (s(v) ? new Date(v).toISOString() : null);
const dateOnly = (v) => (s(v) ? new Date(v).toISOString().slice(0, 10) : null);

export function personName(p) {
  if (!p || typeof p !== "object") return "";
  const n = [s(p.first_name), s(p.last_name)].filter(Boolean).join(" ");
  return n || s(p.company) || s(p.name) || s(p.email) || s(p.mobile_number) || "";
}
export function serviceAddress(c) {
  const list = Array.isArray(c?.addresses) ? c.addresses : [];
  return list.find((a) => a?.type === "service") || list[0] || null;
}
export const addressLine = (a) => (a ? [s(a.street), s(a.street_line_2), s(a.city), s(a.state), s(a.zip)].filter(Boolean).join(", ") : "");
export const firstPhone = (c) => s(c?.mobile_number) || s(c?.home_number) || s(c?.work_number) || "";

// ---------------------------------------------------------------------------------------
// Customers

export const addrKey = (street, zip) => {
  const sk = streetKey(street);
  const z = normalizeZip(zip);
  return sk && z ? `${sk}|${z}` : "";
};

/** An index of the tenant's existing Sundial customers for the three lookups. */
export function indexExisting(records) {
  const byHcp = new Map();
  const byEmail = new Map();
  const byAddr = new Map();
  const push = (m, k, r) => {
    if (!k) return;
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r);
  };
  for (const r of records || []) {
    if (s(r[HCP_ID_FIELD])) byHcp.set(s(r[HCP_ID_FIELD]), r);
    push(byEmail, normalizeEmail(r.Primary_Email__c), r);
    push(byAddr, addrKey(r.Street__c, r.Postal_Code__c), r);
  }
  return { byHcp, byEmail, byAddr };
}

/**
 * One HCP customer → what to do. `taken` is the set of Sundial ids already claimed by an
 * earlier HCP customer in this run (two HCP records for one household both link to the
 * same Sundial customer; only the first one stamps HCP_Id__c on it).
 *
 * @returns {{ action: 'known'|'link'|'create', sfId?: string, by?: string, review?: string }}
 */
export function decideCustomer(c, index, taken = new Set()) {
  const hcpId = s(c.id);
  const known = index.byHcp.get(hcpId);
  if (known) return { action: "known", sfId: known.Id, by: "hcp_id" };
  const email = normalizeEmail(c.email);
  const addr = serviceAddress(c);
  const key = addrKey(addr?.street, addr?.zip);
  const emailHits = email ? index.byEmail.get(email) || [] : [];
  const addrHits = key ? index.byAddr.get(key) || [] : [];
  if (emailHits.length === 1) {
    const hit = emailHits[0];
    const note = addrHits.length && !addrHits.some((r) => r.Id === hit.Id) ? "email matched one record but the address matched a different one — linked by email" : undefined;
    return { action: "link", sfId: hit.Id, by: "email", review: note, shared: taken.has(hit.Id) };
  }
  if (emailHits.length > 1) return { action: "create", review: `email matches ${emailHits.length} Sundial customers (${emailHits.map((r) => r.Id).join(", ")}) — created new; merge by hand` };
  if (addrHits.length === 1) {
    const hit = addrHits[0];
    // an address match with a DIFFERENT email on file is a new occupant more often than a typo
    const theirs = normalizeEmail(hit.Primary_Email__c);
    if (email && theirs && theirs !== email) return { action: "create", review: `address matches ${hit.Id} but its email differs (${theirs}) — created new; merge by hand if it is the same household` };
    return { action: "link", sfId: hit.Id, by: "address", review: email ? undefined : "matched by address only (no email on the HCP side)", shared: taken.has(hit.Id) };
  }
  if (addrHits.length > 1) return { action: "create", review: `address matches ${addrHits.length} Sundial customers (${addrHits.map((r) => r.Id).join(", ")}) — created new; merge by hand` };
  return { action: "create" };
}

/**
 * The customer's fields.
 *   create      everything HCP knows
 *   refresh     everything HCP knows (a customer the import itself created — HCP is still
 *               the source of truth until cutover)
 *   fillBlanks  only the fields the existing Sundial record has EMPTY (a matched customer
 *               with prior solar history: Sales owns that record)
 */
/**
 * `disposition` (lib/hcp-disposition.js customerDisposition) writes Archived__c on a customer
 * the import CREATED (create / refresh) — never on a linked one, Sales owns that record.
 * `blankStage` (refresh only): the stage is "New" from the first import and HCP has no open
 * lead for the household — the "New" that crowded the board (2026-09-29) comes off.
 */
/** The customer's Description__c: HCP's notes (or the lead block), then the archive reason as a trailing line (Tim, 2026-10-02). */
export function withArchiveLine(text, disposition) {
  const line = disposition?.archived ? `${ARCHIVE_NOTE}: ${disposition.reason}` : "";
  return [s(text), line].filter(Boolean).join("\n").slice(0, 32000);
}

export function customerFields(c, { mode, existing = null, pickState = (v) => v || null, leadSources = null, hasJobs = false, tenantId, disposition = null, blankStage = false }) {
  const addr = serviceAddress(c);
  const full = {
    Name: cut(personName(c), 80) || "HCP customer",
    First_Name__c: s(c.first_name) || null,
    Last_Name__c: s(c.last_name) || null,
    Street__c: s(addr?.street) ? [s(addr.street), s(addr.street_line_2)].filter(Boolean).join(", ") : null,
    City__c: s(addr?.city) || null,
    State__c: pickState(s(addr?.state)) || null,
    Postal_Code__c: s(addr?.zip) || null,
    Primary_Email__c: normalizeEmail(c.email) || null,
    Primary_Phone__c: firstPhone(c) || null,
    Lead_Source__c: leadSources ? matchPicklist(c.lead_source, leadSources) : s(c.lead_source) || null,
  };
  const out = { [HCP_ID_FIELD]: s(c.id) };
  if (mode === "create") {
    Object.assign(out, full);
    out.Client__c = tenantId;
    out.Customer_Type__c = "Service";
    out.Requested_Project_Types__c = "Service";
    out.Status__c = hasJobs ? "Customer" : "Lead";
    // No Service_Stage__c here (2026-09-29): the first import stamped ~7,400 stage-less
    // service customers "New" and buried the office's real pipeline under them. The office
    // sets the stage by hand on the customers it is actually working; the import leaves it blank.
    if (disposition) out.Archived__c = disposition.archived === true;
    const desc = withArchiveLine(s(c.notes), disposition);
    if (desc) out.Description__c = desc;
  } else if (mode === "refresh") {
    Object.assign(out, full);
    if (disposition) out.Archived__c = disposition.archived === true;
    const desc = withArchiveLine(s(c.notes), disposition);
    if (desc) out.Description__c = desc;
  } else {
    for (const [k, v] of Object.entries(full)) {
      if (k === "Name") continue;
      if (v != null && !s(existing?.[k])) out[k] = v;
    }
    const ct = unionProjectTypes(existing?.Customer_Type__c, "Service");
    if (ct) out.Customer_Type__c = ct;
    const rt = unionProjectTypes(existing?.Requested_Project_Types__c, "Service");
    if (rt) out.Requested_Project_Types__c = rt;
  }
  for (const k of Object.keys(out)) if (out[k] == null) delete out[k];
  if (mode === "refresh" && blankStage) out.Service_Stage__c = null; // an explicit null clears the field (REST), after the null-stripping above
  return out;
}

// ---------------------------------------------------------------------------------------
// Leads (probed 2026-09-25: id, number, customer, address, lead_source, status,
// pipeline_status, tags, total_amount, assigned_employee, conversions, lost_at, job_fields)

/** The stage a lead lands in (lib/hcp-disposition.js decides; this is the one-word view). */
export function leadStage(l, { stages = null, resolutions = null } = {}) {
  return closedLeadOutcome(l, { resolutions })?.stage ?? openLeadStage(l, { stages }).stage;
}

/**
 * A lead is a Service pipeline entry on its customer's hub record (2026-10-02 rules):
 *   open  → the stage HCP's pipeline_status means (First Contact → Contact Attempt Made with
 *           Call_Attempts__c = 1, Waiting on Customer, On Hold …), the request type from the
 *           lead's job type when the org has that value
 *   won   → Resolved · Job Created / Estimate Created, resolved on the day the job was made
 *   lost  → Closed · Lost (Not Interested until the org has "Lost"), resolved on lost_at
 * `stages` / `resolutions` / `requestTypes` are the org's picklists (describe); a value the
 * org lacks is reported through `onGap(field, value)` and the nearest value is written.
 */
export function leadFields(l, { assignedToId = null, leadSources = null, stages = null, resolutions = null, requestTypes = null, jobTypeName = "", convertedAt = null, onGap = null, disposition = null } = {}) {
  const closed = closedLeadOutcome(l, { resolutions, convertedAt });
  const open = closed ? null : openLeadStage(l, { stages });
  const stage = closed ? closed.stage : open.stage;
  const desc = [
    `HCP lead #${s(l.number) || s(l.id)}${s(l.pipeline_status) ? ` · ${s(l.pipeline_status)}` : ""}${s(l.status) ? ` (${s(l.status)})` : ""}`,
    Array.isArray(l.tags) && l.tags.length ? `Tags: ${l.tags.map(s).join(", ")}` : "",
    s(jobTypeName) ? `Job type: ${s(jobTypeName)}` : "",
    s(l.job_fields) && typeof l.job_fields === "object" ? Object.entries(l.job_fields).filter(([k, v]) => s(v) && !/uuid$/.test(k)).map(([k, v]) => `${k}: ${s(v)}`).join("; ") : "",
  ].filter(Boolean).join("\n");
  const out = {
    Customer_Type__c: "Service",
    Description__c: withArchiveLine(desc, disposition), // the lead block replaces HCP's notes; the archive line rides along
    Service_Stage__c: stage,
  };
  if (closed) {
    out.Service_Resolution__c = closed.resolution;
    if (closed.resolvedAt) out.Service_Resolved_Date__c = closed.resolvedAt;
    if (closed.missingValue && onGap) onGap("Service_Resolution__c", closed.missingValue);
  } else {
    if (open.attempts > 0) out.Call_Attempts__c = open.attempts;
    if (open.missingValue && onGap) onGap("Service_Stage__c", open.missingValue);
    if (!open.known && onGap) onGap("pipeline_status (unmapped → New)", s(l.pipeline_status));
  }
  if (s(jobTypeName)) {
    const rt = requestTypes ? matchPicklist(jobTypeName, requestTypes) : null;
    if (rt) out.Service_Request_Type__c = rt;
    else if (onGap) onGap("Service_Request_Type__c", s(jobTypeName));
  }
  const ls = leadSources ? matchPicklist(l.lead_source, leadSources) : s(l.lead_source) || null;
  if (ls) out.Lead_Source__c = ls;
  else if (s(l.lead_source) && onGap) onGap("Lead_Source__c", s(l.lead_source));
  if (assignedToId) out.Assigned_To__c = assignedToId;
  return out;
}

// ---------------------------------------------------------------------------------------
// Lines

export function lineKind(li, item) {
  if (item?.Kind__c) return item.Kind__c;
  const k = s(li.kind ?? li.type).toLowerCase();
  if (/material|part|product/.test(k)) return "Material";
  if (/fee|trip|charge/.test(k)) return "Fee";
  if (/discount/.test(k)) return "Fee";
  return "Labor";
}

export function lineFields(li, { estimateSfId, itemsByHcpId = new Map(), stage = "Approved", tenantId, index = 0 }) {
  const item = s(li.service_item_id) ? itemsByHcpId.get(s(li.service_item_id)) : null;
  const kind = lineKind(li, item);
  const qty = Number(li.quantity) || 1;
  const unit = dollars(li.unit_price) ?? 0;
  const cost = dollars(li.unit_cost);
  const out = {
    [HCP_ID_FIELD]: s(li.id),
    Estimate__c: estimateSfId,
    Client__c: tenantId,
    Kind__c: kind,
    Description__c: cut([s(li.name), s(li.description)].filter(Boolean).join(" — "), 255) || "Line", // Text(255)
    Quantity__c: qty,
    Unit_Price__c: unit,
    Line_Total__c: dollars(li.amount) ?? Math.round(unit * qty * 100) / 100,
    Taxable__c: li.taxable === true,
    Sort_Order__c: Number.isFinite(Number(li.order_index)) ? Number(li.order_index) : index,
    Source__c: "Migration",
    Stage__c: stage,
    Show_Unit_Price__c: true,
  };
  const uom = s(li.unit_of_measure);
  if (/hour/i.test(uom)) out.Unit_of_Measure__c = "Hour";
  else if (/foot|ft/i.test(uom)) out.Unit_of_Measure__c = "Foot";
  else if (/lot/i.test(uom)) out.Unit_of_Measure__c = "Lot";
  else out.Unit_of_Measure__c = "Each";
  if (cost != null) {
    if (kind === "Material") out.Unit_Material_Cost__c = cost;
    else out.Unit_Labor_Cost__c = cost;
  }
  if (item?.Id) out.Price_Book_Item__c = item.Id;
  return out;
}

export function lineTotals(lineRows) {
  const t = { Labor_Subtotal__c: 0, Material_Subtotal__c: 0, Fee_Subtotal__c: 0, Subtotal__c: 0 };
  for (const l of lineRows) {
    const v = Number(l.Line_Total__c) || 0;
    t.Subtotal__c += v;
    if (l.Kind__c === "Material") t.Material_Subtotal__c += v;
    else if (l.Kind__c === "Fee") t.Fee_Subtotal__c += v;
    else if (l.Kind__c === "Product") continue; // an unsplit Product counts in the subtotal only (totals.js)
    else t.Labor_Subtotal__c += v;
  }
  for (const k of Object.keys(t)) t[k] = Math.round(t[k] * 100) / 100;
  return t;
}

// ---------------------------------------------------------------------------------------
// Estimates

/** The option whose lines become the Sundial estimate: the approved one, else the first. */
export function pickOption(est) {
  const options = Array.isArray(est.options) ? est.options : [];
  const approved = options.find((o) => /approved/i.test(s(o.approval_status)) || o.approved === true);
  return approved || options[0] || null;
}

export function estimateStatus(est, option) {
  const st = s(option?.approval_status || est.approval_status).toLowerCase();
  if (/approved/.test(st)) return "Approved";
  if (/declined/.test(st)) return "Declined";
  if (/expired/.test(st)) return "Expired";
  const ws = s(est.work_status).toLowerCase();
  if (/cancel/.test(ws)) return "Declined";
  return "Sent";
}

function snapshot(rec) {
  const c = rec.customer || {};
  const a = rec.address || serviceAddress(c);
  return {
    Customer_Name_at_Creation__c: cut(personName(c), 120) || null,
    Address_at_Creation__c: cut(addressLine(a), 255) || null,
    Primary_Phone_at_Creation__c: firstPhone(c) || null,
    Primary_Email_at_Creation__c: normalizeEmail(c.email) || null,
  };
}

/** A standalone HCP estimate (one not claimed by a job). */
export function estimateFields(est, { customerSfId, tenantId, lineRows = [], disposition = null }) {
  const option = pickOption(est);
  const status = estimateStatus(est, option);
  const totals = lineTotals(lineRows);
  const total = dollars(option?.total_amount ?? est.total_amount) ?? totals.Subtotal__c;
  const others = (est.options || []).filter((o) => o !== option).map((o) => `${s(o.name) || o.id}: $${dollars(o.total_amount) ?? "?"}${s(o.approval_status) ? ` (${s(o.approval_status)})` : ""}`);
  const out = {
    [HCP_ID_FIELD]: s(est.id),
    Client__c: tenantId,
    Sundial_Customer__c: customerSfId,
    ...snapshot(est),
    Status__c: status,
    Version__c: 1,
    Version_Log__c: JSON.stringify([{ version: 1, at: iso(est.created_at) || new Date().toISOString(), by: "HCP import", note: `${MIGRATION_NOTE} estimate #${s(est.estimate_number) || s(est.id)}${option ? `; option "${s(option.name) || option.id}"` : ""}${others.length ? `; other options: ${others.join("; ")}` : ""}` }]),
    ...totals,
    Total__c: total,
    Tax_Amount__c: Math.max(0, Math.round((total - totals.Subtotal__c) * 100) / 100),
    Internal_Notes__c: [`${MIGRATION_NOTE} estimate #${s(est.estimate_number) || s(est.id)}`, disposition?.archived ? `${ARCHIVE_NOTE}: ${disposition.reason}` : ""].filter(Boolean).join("\n"),
  };
  if (disposition) out.Archived__c = disposition.archived === true;
  if (status === "Approved") {
    out.Approved_At__c = iso(est.updated_at) || iso(est.created_at);
    out.Approved_Version__c = 1;
    out.Approved_Amount__c = total;
    out.Approval_Method__c = "Verbal";
  }
  if (status !== "Draft") {
    out.Last_Sent_At__c = iso(est.created_at);
    out.Last_Sent_Via__c = "Manual";
  }
  for (const k of Object.keys(out)) if (out[k] == null) delete out[k];
  return out;
}

/**
 * The estimate a job carries — always the one MADE FOR the job (`job:<id>:estimate`). An HCP
 * estimate the job came from stays its own (archived, "converted to job #…") record: the
 * 2026-09-28 run already gave every job this estimate with its lines, and a job never has two.
 */
export function jobEstimateFields(job, { customerSfId, tenantId, lineRows = [], jobState, archived = false }) {
  const totals = lineTotals(lineRows);
  const total = dollars(job.total_amount) ?? totals.Subtotal__c;
  const status = jobState.invoiced ? "Invoiced" : "Approved";
  const out = {
    [HCP_ID_FIELD]: `job:${s(job.id)}:estimate`,
    Archived__c: archived === true,
    Client__c: tenantId,
    Sundial_Customer__c: customerSfId,
    ...snapshot(job),
    Status__c: status,
    Version__c: 1,
    Version_Log__c: JSON.stringify([{ version: 1, at: iso(job.created_at) || new Date().toISOString(), by: "HCP import", note: `${MIGRATION_NOTE} job #${s(job.invoice_number) || s(job.id)}` }]),
    ...totals,
    Total__c: total,
    Tax_Amount__c: Math.max(0, Math.round((total - (dollars(job.subtotal) ?? totals.Subtotal__c)) * 100) / 100),
    Approved_At__c: iso(job.created_at),
    Approved_Version__c: 1,
    Approved_Amount__c: total,
    Approval_Method__c: "Verbal",
    Last_Sent_At__c: iso(job.created_at),
    Last_Sent_Via__c: "Manual",
    Scope_Summary__c: s(job.description).slice(0, 32000) || null,
    Internal_Notes__c: `${MIGRATION_NOTE} job #${s(job.invoice_number) || s(job.id)}`,
  };
  for (const k of Object.keys(out)) if (out[k] == null) delete out[k];
  return out;
}

// ---------------------------------------------------------------------------------------
// Jobs, invoices, payments

/** What the job's invoices add up to: the live (latest non-void) one, paid, invoiced. */
export function invoiceState(invoices) {
  const list = (invoices || []).filter((i) => i && !/void|cancel/i.test(s(i.status)));
  const live = list.sort((a, b) => s(b.invoice_date || b.created_at).localeCompare(s(a.invoice_date || a.created_at)))[0] || null;
  const sum = (arr) => (Array.isArray(arr) ? arr.reduce((n, x) => n + (Number(x?.amount) || 0), 0) : 0);
  const paid = list.reduce((n, i) => n + sum(i.payments) - Math.abs(sum(i.refunds)), 0);
  const refunded = list.reduce((n, i) => n + Math.abs(sum(i.refunds)), 0);
  const total = live ? Number(live.amount) || 0 : 0;
  return {
    live,
    invoiced: !!live && !/draft/i.test(s(live.status)),
    total,
    paid,
    refunded,
    fullyPaid: !!live && (/paid/i.test(s(live.status)) || (total > 0 && paid >= total)),
  };
}

export function jobStatus(job, st) {
  const ws = s(job.work_status).toLowerCase();
  if (/cancel/.test(ws)) return { Status__c: "Closed", Resolution__c: "Cancelled" };
  if (/complete/.test(ws)) {
    if (st.fullyPaid) return { Status__c: "Paid", Resolution__c: "Completed" };
    if (st.invoiced) return { Status__c: "Invoiced" };
    if ((Number(job.total_amount) || 0) === 0) return { Status__c: "Closed", Resolution__c: "Completed" };
    return { Status__c: "Ready to Bill" };
  }
  if (/in_progress|progress/.test(ws)) return { Status__c: "In Progress" };
  if (/unscheduled/.test(ws)) return { Status__c: "Ready to Schedule" };
  if (/scheduled/.test(ws)) return { Status__c: "Scheduled" };
  return { Status__c: "Ready to Schedule" };
}

export function paymentStatus(st) {
  if (st.paid <= 0 && st.refunded > 0) return "Refunded";
  if (st.paid <= 0) return "None";
  if (st.fullyPaid) return "Paid";
  return "Partially Paid";
}

export function jobFields(job, { customerSfId, estimateSfId, tenantId, st, appointments = [], disposition = null }) {
  const status = jobStatus(job, st);
  const archiveLine = disposition?.archived ? `${ARCHIVE_NOTE}: ${disposition.reason}` : "";
  const firstStart = appointments.map((a) => apptTimes(a).start).filter(Boolean).sort()[0] || iso(job.schedule?.scheduled_start);
  const out = {
    [HCP_ID_FIELD]: s(job.id),
    Client__c: tenantId,
    Sundial_Customer__c: customerSfId,
    Estimate__c: estimateSfId,
    ...snapshot(job),
    ...status,
    Status_Changed_At__c: iso(job.updated_at) || iso(job.created_at),
    Intake_Date__c: dateOnly(job.created_at),
    Priority__c: "Standard",
    // The title is the job type ("Solar - SunRun Standard Truck Roll"); the notes are the
    // story (2026-10-05: HCP's `notes` is a list — `jobNotesText`, never `s(job.notes)`).
    Issue_Description__c: jobIssueDescription(job),
    Office_Notes__c: [`${MIGRATION_NOTE} — HCP job #${s(job.invoice_number) || s(job.id)}`, Array.isArray(job.tags) && job.tags.length ? `Tags: ${job.tags.map(s).join(", ")}` : "", s(job.lead_source) ? `Lead source: ${s(job.lead_source)}` : "", archiveLine, jobNotesText(job)].filter(Boolean).join("\n").slice(0, 32000),
    // Who pays, read off the title (2026-10-05, lib/hcp-bill-to.js) — HCP has no Bill-To.
    ...billToFields(job.description),
    Payment_Status__c: paymentStatus(st),
    Geocode_Status__c: "Pending",
    First_Scheduled_Start__c: firstStart,
    Estimate_Status__c: st.invoiced ? "Invoiced" : "Approved",
    Estimate_Total__c: dollars(job.total_amount),
    Estimate_Approved_Amount__c: dollars(job.total_amount),
  };
  if (disposition) out.Archived__c = disposition.archived === true;
  for (const k of Object.keys(out)) if (out[k] == null) delete out[k];
  return out;
}

/**
 * The job's Issue Description: the HCP title, then the notes under it, so a tech reading the
 * job sees what the office wrote without opening Office notes (2026-10-05).
 */
export function jobIssueDescription(job) {
  const title = s(job?.description);
  const notes = jobNotesText(job);
  return [title, notes].filter(Boolean).join("\n\n").slice(0, 32000) || null;
}

/** Start / end of an HCP appointment as ISO instants (Arizona, no DST). */
export function apptTimes(a) {
  const day = s(a.start_date);
  const toIso = (v, fallbackHour) => {
    const t = s(v);
    if (!t && !day) return null;
    if (/T/.test(t)) return new Date(t).toISOString();
    if (!day) return null;
    if (/^\d{1,2}:\d{2}/.test(t)) return new Date(`${day}T${t.length === 4 ? "0" + t : t.slice(0, 5)}:00${TZ_OFFSET}`).toISOString();
    return new Date(`${day}T${String(fallbackHour).padStart(2, "0")}:00:00${TZ_OFFSET}`).toISOString();
  };
  let start = toIso(a.start_time, 8);
  let end = toIso(a.end_time, 17);
  if (start && end && end <= start) end = new Date(new Date(start).getTime() + 2 * 3600 * 1000).toISOString();
  return { start, end };
}

export function callFields(job, appt, { jobSfId, techSfId = null, techName = "", tenantId, hcpId, status }) {
  const { start, end } = apptTimes(appt);
  const complete = status === "Complete";
  const wt = job.work_timestamps || {};
  const single = complete && s(wt.started_at) && s(wt.completed_at);
  const actualStart = single ? iso(wt.started_at) : complete ? start : null;
  const actualEnd = single ? iso(wt.completed_at) : complete ? end : null;
  const minutes = actualStart && actualEnd ? Math.max(0, Math.round((new Date(actualEnd) - new Date(actualStart)) / 60000)) : null;
  const out = {
    [HCP_ID_FIELD]: hcpId,
    Client__c: tenantId,
    Sundial_Service_Job__c: jobSfId,
    Visit_Type__c: "Service",
    Visit_Sub_Type__c: "On-Site",
    Status__c: status,
    Scheduled_Start__c: start,
    Scheduled_End__c: end,
    Tech__c: techSfId,
    Actual_Start__c: actualStart,
    Actual_End__c: actualEnd,
    Duration_Minutes__c: minutes,
    Clock_Intervals__c: actualStart && actualEnd ? JSON.stringify([{ start: actualStart, end: actualEnd, source: "hcp-import" }]) : null,
    Private_Notes__c: [`${MIGRATION_NOTE} appointment ${s(appt.id)}`, techName && !techSfId ? `HCP tech: ${techName} (no matching Sundial user)` : "", a11y(appt)].filter(Boolean).join("\n"),
    Billable_to_Customer__c: false,
  };
  for (const k of Object.keys(out)) if (out[k] == null) delete out[k];
  return out;
}
const a11y = (appt) => (appt.anytime ? "Anytime appointment" : s(appt.arrival_window_minutes) ? `Arrival window ${s(appt.arrival_window_minutes)} min` : "");

/** The call's status follows the job's: HCP keeps no per-appointment state. */
export function callStatusFor(job) {
  const ws = s(job.work_status).toLowerCase();
  if (/cancel/.test(ws)) return "Cancelled";
  if (/complete/.test(ws)) return "Complete";
  if (/in_progress/.test(ws)) return "In Progress";
  return "Scheduled";
}

export function invoiceStatus(inv) {
  const st = s(inv.status).toLowerCase();
  if (/void|cancel/.test(st)) return "Void";
  const amount = Number(inv.amount) || 0;
  const due = Number(inv.due_amount);
  if (/paid/.test(st) || (amount > 0 && Number.isFinite(due) && due <= 0)) return "Paid";
  if (Number.isFinite(due) && due > 0 && due < amount) return "Partially Paid";
  if (/sent/.test(st) || s(inv.sent_at)) return "Sent";
  if (/draft/.test(st)) return "Draft";
  return "Issued";
}

export function invoiceFields(inv, { jobSfId, tenantId }) {
  const sum = (arr) => (Array.isArray(arr) ? arr.reduce((n, x) => n + (Number(x?.amount) || 0), 0) : 0);
  const paid = dollars(sum(inv.payments) - Math.abs(sum(inv.refunds))) ?? 0;
  const status = invoiceStatus(inv);
  const out = {
    [HCP_ID_FIELD]: s(inv.id),
    Name: s(inv.invoice_number) || s(inv.id),
    Client__c: tenantId,
    Service_Job__c: jobSfId,
    Status__c: status,
    Bill_To_Type__c: "Customer",
    Subtotal__c: dollars(inv.subtotal),
    Discount_Amount__c: dollars(Math.abs(sum(inv.discounts))),
    Tax_Amount__c: dollars(sum(inv.taxes)),
    Total__c: dollars(inv.amount),
    Paid_Amount__c: Math.max(0, paid),
    Balance__c: dollars(inv.due_amount) ?? Math.max(0, (dollars(inv.amount) ?? 0) - paid),
    Issued_At__c: iso(inv.invoice_date) || iso(inv.created_at),
    Sent_At__c: iso(inv.sent_at),
    Due_Date__c: dateOnly(inv.due_at),
    Paid_At__c: iso(inv.paid_at),
  };
  if (status === "Void") {
    out.Voided_At__c = iso(inv.updated_at) || iso(inv.invoice_date);
    out.Void_Reason__c = cut(`${MIGRATION_NOTE}: voided in HCP`, 255);
  }
  for (const k of Object.keys(out)) if (out[k] == null) delete out[k];
  return out;
}

export function paymentMethod(p) {
  const m = s(p.payment_method ?? p.method ?? p.source ?? p.kind ?? p.type).toLowerCase();
  if (/card|credit|debit|stripe/.test(m)) return "Card";
  if (/check|cheque/.test(m)) return "Check";
  if (/ach|bank|wire/.test(m)) return "ACH";
  return "Other";
}

export function paymentFields(p, kind, { inv, jobSfId, invoiceSfId, tenantId }) {
  const out = {
    [HCP_ID_FIELD]: s(p.id) || `${s(inv.id)}:${kind}:${s(p.paid_at ?? p.created_at ?? "")}`,
    Client__c: tenantId,
    Service_Job__c: jobSfId,
    Invoice__c: invoiceSfId,
    Type__c: kind === "refund" ? "Refund" : "Payment",
    Method__c: paymentMethod(p),
    Amount__c: Math.abs(dollars(p.amount) ?? 0),
    Status__c: "Succeeded",
    Received_At__c: iso(p.paid_at ?? p.refunded_at ?? p.created_at ?? p.date) || iso(inv.paid_at) || iso(inv.invoice_date),
    Reference__c: cut(s(p.check_number ?? p.reference ?? p.transaction_id), 100) || null,
    Notes__c: cut(`${MIGRATION_NOTE} — invoice #${s(inv.invoice_number)}${s(p.status) ? ` (${s(p.status)})` : ""}`, 255),
  };
  for (const k of Object.keys(out)) if (out[k] == null) delete out[k];
  return out;
}

/**
 * The HCP_Id__c of one tech's call on a multi-tech appointment. Two HCP ids joined are 73
 * characters and the field is Text(64) (2026-09-28: FIELD_INTEGRITY_EXCEPTION on five
 * calls), so the employee id rides as a short stable hash: `<appointment>:<8 hex>`.
 */
export function callKey(appointmentId, employeeId, multi) {
  if (!multi) return s(appointmentId);
  const h = createHash("sha1").update(s(employeeId)).digest("hex").slice(0, 8);
  return `${s(appointmentId)}:${h}`;
}

// ---------------------------------------------------------------------------------------
// Techs: HCP employee → Sundial user, by the mapping file first, then by email.

export function techResolver({ employees = [], users = [], map = {} }) {
  const byEmail = new Map(users.map((u) => [normalizeEmail(u.Email__c), u]));
  const byId = new Map(users.map((u) => [u.Id, u]));
  const emp = new Map(employees.map((e) => [s(e.id), e]));
  return (employeeId) => {
    const e = emp.get(s(employeeId));
    const name = e ? personName(e) : s(employeeId);
    const mapped = map[s(employeeId)] ?? (e ? map[normalizeEmail(e.email)] : undefined);
    if (mapped) {
      const u = byId.get(mapped) || byEmail.get(normalizeEmail(mapped));
      if (u) return { sfId: u.Id, name };
    }
    const u = e ? byEmail.get(normalizeEmail(e.email)) : null;
    return { sfId: u?.Id ?? null, name };
  };
}

export { normalizeEmail, normalizePhone, normalizeZip, streetKey };
