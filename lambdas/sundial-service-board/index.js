// sundial-service-board — the dispatch board's backend (D-072, docs/dispatch-board-design.md).
//
//   GET   /service/board?from=<iso>&to=<iso>     techs + the calls in the window + the
//                                                 unscheduled tray, in one read
//   GET   /service/jobs/{id}/calls               one job's calls (the job page's card)
//   POST  /service/jobs/{id}/calls               schedule a tech onto a job (tray drop)
//   PATCH /service/calls/{id}                    move / resize / reassign / status / notes
//   POST  /service/calls/{id}/cancel             { reason } → Cancelled
//   /service/tech/*                              the technician app — see tech.js
//
// A service call is ONE tech × ONE appointment on a job (D-072). Multi-tech jobs are
// parallel calls under the same job, so "add a tech" is just another POST.
//
// ALWAYS FRESH. Scheduling commits read Salesforce directly (caching-architecture.md's
// always-fresh list) — the board must never move a block based on a stale cache row.
// The board READ is fresh too: 7 techs × ~10 calls a day is a trivial query, and a
// dispatcher who moves a block and sees it snap back because the cache lagged will
// stop trusting the board on day one.
//
// CONCURRENCY (design §4): optimistic, the server is the referee. Every board mutation
// may carry `baseModstamp` (the SystemModstamp the block was rendered from); a fresh
// read that disagrees is a 409 CALL_CONFLICT carrying the current state, and nothing
// is written. Beth is the only full-time dispatcher — conflicts are rare, but a
// silently clobbered move is the one thing this board must never do.
//
// JOB STATUS FOLLOWS THE CALLS (the only automation here, all in one place):
//   first call scheduled          job New/Triaging/Remote Inv./Ready/Awaiting Parts → Scheduled
//   a call goes In Progress       job Scheduled → In Progress
//   last open call Complete       job In Progress/Scheduled → Awaiting Office Review
//   last open call Cancelled      job Scheduled → Ready to Schedule
//   a tech reopens a Complete     job Awaiting Office Review → In Progress
// Nothing else on the job is touched; anything more opinionated is a per-tenant rule
// added on request (D-072 rule 5).
//
// After every write: activity row (best-effort), cache rows flagged stale, one
// Realtime broadcast on tenant:{tenantId}:sundial_service:list so other open boards
// patch themselves, and — when the dispatcher asked — a customer email with the window
// (SMS when Twilio lands). None of those can fail the write.
//
// TENANT ISOLATION: tenantId only from resolveIdentity; every read is Client__c-bound;
// cross-tenant ids are 404. Dependencies are injectable (createHandler) for test.js.

import { resolveIdentity as realResolveIdentity } from "../../lib/identity.js";
import {
  sfQuery as realSfQuery,
  sfCreateRecord as realSfCreateRecord,
  sfUpdateRecord as realSfUpdateRecord,
  soqlEscapeString,
} from "../../lib/salesforce.js";
import { getSupabaseClient as realGetSupabaseClient } from "../../lib/supabase.js";
import { sendEmail as realSendEmail, isEmailConfigured as realIsEmailConfigured } from "../../lib/email.js";
import { broadcast as realBroadcast, recordChannel } from "../../lib/realtime.js";
import { alwaysEnforcedAccess, assertAction } from "../../lib/access-enforce.js";
import { EVENTS, recordActivity } from "../../lib/service-activity.js";
import { corsHeaders, normalizeHeaders, jsonResponse, mapIdentityError, parseJsonBody, httpMethod } from "../../lib/http.js";
import { getSecret as realGetSecret } from "../../lib/secrets.js";
import { createSmsSender } from "../../lib/sms-send.js";
import { applyClockEvent, clockFields, createTechHandlers, liveIntervals, parseIntervals, realListPhotos, realPresignPut } from "./tech.js";
import { syncCallNotesToJob } from "./job-notes.js";

export const CALL_SF_OBJECT = "Sundial_Service_Call__c";
export const JOB_SF_OBJECT = "Sundial_Service_Job__c";
export const USER_SF_OBJECT = "Sundial_User__c";
export const CUSTOMER_SF_OBJECT = "Sundial_Customer__c";

const CACHE = Object.freeze({ call: "sundial_service_call_cache", job: "sundial_service_job_cache" });

// "Unscheduled" (2026-09-15): a call that exists before it has a window. It sits in the
// dispatch tray as its own card, keeps its tech / notes, and becomes Scheduled the moment
// a window is set (drop on the board or the schedule form). It is not "open" for the
// job-status rules — a job with only an unscheduled call is still Ready to Schedule.
export const CALL_STATUSES = Object.freeze(["Unscheduled", "Scheduled", "En Route", "In Progress", "Complete", "Cancelled", "No-Show"]);
export const OPEN_CALL_STATUSES = Object.freeze(["Scheduled", "En Route", "In Progress"]);
export const STARTED_CALL_STATUSES = Object.freeze(["In Progress", "Complete"]);
export const SUB_TYPES = Object.freeze(["On-Site", "Remote", "Office Work", "In-Field", "Travel", "Prep"]);

/** Job statuses that mean "nothing on the calendar yet" — the tray. */
export const UNSCHEDULED_JOB_STATUSES = Object.freeze(["New", "Triaging", "Remote Investigation", "Ready to Schedule", "Awaiting Parts"]);
const PRIORITY_RANK = { Emergency: 0, High: 1, Standard: 2, Low: 3 };

// Tenant config placeholders (service-workflows.md §12): default block length, the
// hours the board shows, the timezone customer emails are written in.
export const DEFAULTS = Object.freeze({
  callMinutes: 120,
  maxWindowDays: 42, // the portal's month view is a fixed 6-week grid = 42 days
  timeZone: process.env.SERVICE_TIMEZONE || "America/Phoenix",
  brandName: process.env.SERVICE_BRAND_NAME || "",
});

export const CALL_SELECT =
  "Id, Name, Client__c, Visit_Type__c, Visit_Sub_Type__c, Sundial_Service_Job__c, Tech__c, Scheduled_Start__c, " +
  "Scheduled_End__c, Status__c, Cancel_Reason__c, Actual_Start__c, Actual_End__c, Duration_Minutes__c, Work_Notes__c, " +
  "Private_Notes__c, Geofence_Verified__c, Photos_Count__c, Billable_to_Customer__c, Billable_Hours__c, Bill_Rate__c, " +
  "Clock_Intervals__c, SystemModstamp, CreatedDate, " +
  "Tech__r.First_Name__c, Tech__r.Last_Name__c, " +
  "Sundial_Service_Job__r.Name, Sundial_Service_Job__r.Status__c, Sundial_Service_Job__r.Priority__c, " +
  "Sundial_Service_Job__r.Service_Type__c, Sundial_Service_Job__r.Customer_Name_at_Creation__c, " +
  "Sundial_Service_Job__r.Address_at_Creation__c, Sundial_Service_Job__r.Primary_Phone_at_Creation__c, " +
  "Sundial_Service_Job__r.Bill_To_Type__c, Sundial_Service_Job__r.Sundial_Customer__c";

export const JOB_SELECT =
  "Id, Name, Client__c, Status__c, Priority__c, Service_Type__c, Customer_Name_at_Creation__c, Address_at_Creation__c, " +
  "Primary_Phone_at_Creation__c, Primary_Email_at_Creation__c, Issue_Description__c, Sundial_Customer__c, Estimate__c, " +
  "Estimate_Total__c, Bill_To_Type__c, Geocode_Lat__c, Geocode_Lon__c, Geocode_Status__c, CreatedDate, SystemModstamp";

const SF_ID_RE = /^[a-zA-Z0-9]{15,18}$/;

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------
const strOrNull = (v) => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
};
const isoOrNull = (v) => {
  const s = strOrNull(v);
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};
/** SOQL datetime literal: unquoted, no fractional seconds (Salesforce rejects millis). */
export const soqlDateTime = (iso) => new Date(iso).toISOString().replace(/\.\d{3}Z$/, "Z");
const techName = (r) => [r?.First_Name__c, r?.Last_Name__c].filter(Boolean).join(" ").trim() || r?.Email__c || r?.Id || null;

/** The board shape of one call — what the portal renders and what the broadcast carries. */
export function callToBoard(c) {
  const job = c.Sundial_Service_Job__r || {};
  return {
    id: c.Id,
    number: c.Name ?? null,
    jobId: c.Sundial_Service_Job__c ?? null,
    jobNumber: job.Name ?? null,
    jobStatus: job.Status__c ?? null,
    customerId: job.Sundial_Customer__c ?? null,
    customerName: job.Customer_Name_at_Creation__c ?? null,
    address: job.Address_at_Creation__c ?? null,
    phone: job.Primary_Phone_at_Creation__c ?? null,
    priority: job.Priority__c ?? null,
    serviceType: job.Service_Type__c ?? null,
    billToType: job.Bill_To_Type__c ?? null,
    techId: c.Tech__c ?? null,
    techName: c.Tech__r ? techName(c.Tech__r) : null,
    visitType: c.Visit_Type__c ?? null,
    subType: c.Visit_Sub_Type__c ?? null,
    start: c.Scheduled_Start__c ?? null,
    end: c.Scheduled_End__c ?? null,
    status: c.Status__c ?? null,
    cancelReason: c.Cancel_Reason__c ?? null,
    actualStart: c.Actual_Start__c ?? null,
    actualEnd: c.Actual_End__c ?? null,
    durationMinutes: c.Duration_Minutes__c ?? null,
    workNotes: c.Work_Notes__c ?? null,
    privateNotes: c.Private_Notes__c ?? null,
    billable: c.Billable_to_Customer__c === true,
    billableHours: c.Billable_Hours__c ?? null,
    billRate: c.Bill_Rate__c ?? null,
    // The clock as the office sees it on the job page (2026-09-19): every live interval
    // with the phone's GPS at each tap, plus the geofence tag. Removed intervals stay in
    // the correction dialog (GET /clock) — this is the plain reading, not the audit.
    clockLog: clockSummary(c),
    createdAt: c.CreatedDate ?? null,
    modstamp: c.SystemModstamp ?? null,
  };
}

/** { intervals: [{ kind, in, arrived, out, gps: { in, arrived, out } }], geofenceVerified } */
export function clockSummary(c) {
  const live = liveIntervals(parseIntervals(c.Clock_Intervals__c));
  return {
    intervals: live.map((i) => ({
      kind: i.kind ?? (i.arrived ? "on_site" : "en_route"),
      in: i.in,
      arrived: i.arrived ?? null,
      out: i.out ?? null,
      gps: { in: i.in_gps ?? null, arrived: i.arrived_gps ?? null, out: i.out_gps ?? null },
    })),
    geofenceVerified: c.Geofence_Verified__c === true,
  };
}

/** The tray shape of one unscheduled job. */
export function jobToTray(j, now) {
  const created = j.CreatedDate ? Date.parse(j.CreatedDate) : NaN;
  return {
    jobId: j.Id,
    jobNumber: j.Name ?? null,
    status: j.Status__c ?? null,
    priority: j.Priority__c ?? null,
    serviceType: j.Service_Type__c ?? null,
    customerId: j.Sundial_Customer__c ?? null,
    customerName: j.Customer_Name_at_Creation__c ?? null,
    address: j.Address_at_Creation__c ?? null,
    phone: j.Primary_Phone_at_Creation__c ?? null,
    issue: j.Issue_Description__c ?? null,
    estimateTotal: j.Estimate_Total__c ?? null,
    ageDays: Number.isFinite(created) ? Math.max(0, Math.floor((now.getTime() - created) / 86400000)) : null,
    defaultDurationMin: DEFAULTS.callMinutes,
  };
}

/** Tray order: emergencies first, then by how long the job has waited. */
export function sortTray(rows) {
  return [...rows].sort((a, b) => {
    const pa = PRIORITY_RANK[a.priority] ?? 9;
    const pb = PRIORITY_RANK[b.priority] ?? 9;
    if (pa !== pb) return pa - pb;
    return (b.ageDays ?? 0) - (a.ageDays ?? 0);
  });
}

/**
 * Which users are techs. A user marked Technician, or anyone whose home department
 * is Service, so a working manager (Larry) rides the board too. Until the tenant has
 * marked anyone, every active user is a column — an empty board on day one would look
 * broken, and the dispatcher can still schedule.
 */
export function pickTechs(users) {
  const marked = users.filter((u) => u.Access_Level__c === "Technician" || u.Default_Department__c === "Service");
  const chosen = marked.length ? marked : users;
  return {
    source: marked.length ? "technicians" : "all-users",
    techs: chosen.map((u) => ({ id: u.Id, name: techName(u), level: u.Access_Level__c ?? null })),
  };
}

/** Human window in the tenant's timezone, for the customer email. */
export function formatWindow(startIso, endIso, timeZone = DEFAULTS.timeZone) {
  const s = new Date(startIso);
  const e = new Date(endIso);
  const day = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "long", month: "long", day: "numeric" }).format(s);
  const t = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" });
  // Newer ICU puts a narrow no-break space before AM/PM; plain spaces read the same
  // in every mail client and keep the string stable across Node versions.
  return `${day}, ${t.format(s)} – ${t.format(e)}`.replace(/\u202f/g, " ");
}

export function buildAppointmentEmail({ kind, jobNumber, customerName, window, techFirstName, brandName, reason }) {
  const who = brandName ? ` from ${brandName}` : "";
  const first = customerName ? customerName.split(" ")[0] : "there";
  let subject;
  let body;
  if (kind === "cancelled") {
    subject = `Your service appointment${who} has been cancelled`;
    body = `Hi ${first},\n\nYour service appointment (${window}) has been cancelled${reason ? ` — ${reason}` : ""}. We'll be in touch to reschedule.`;
  } else {
    subject = `${kind === "updated" ? "Updated: your" : "Your"} service appointment${who} — ${window}`;
    body = `Hi ${first},\n\n${kind === "updated" ? "Your service appointment has been updated. " : ""}${
      techFirstName ? `${techFirstName} is scheduled to visit ` : "A technician is scheduled to visit "
    }on ${window}.${jobNumber ? ` (Job ${jobNumber})` : ""}\n\nIf that time no longer works, just reply to this email or give us a call.`;
  }
  const html = `<p>${body.replace(/\n\n/g, "</p><p>").replace(/\n/g, "<br>")}</p>`;
  return { subject, text: body, html };
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
const ROUTES = [
  ["GET", /^\/service\/board\/?$/, "board"],
  ["GET", /^\/service\/jobs\/([^/]+)\/calls\/?$/, "jobCalls"],
  ["POST", /^\/service\/jobs\/([^/]+)\/calls\/?$/, "createCall"],
  ["PATCH", /^\/service\/calls\/([^/]+)\/?$/, "patchCall"],
  ["POST", /^\/service\/calls\/([^/]+)\/cancel\/?$/, "cancelCall"],
  // The office's time corrections (tech.js — same clock engine as the phone).
  ["GET", /^\/service\/calls\/([^/]+)\/clock\/?$/, "clockGet"],
  ["POST", /^\/service\/calls\/([^/]+)\/clock\/?$/, "clockCorrect"],
  // The job's photos (2026-09-18): the office reads + adds at the top level; a tech reads.
  ["GET", /^\/service\/jobs\/([^/]+)\/photos\/?$/, "jobPhotos"],
  ["POST", /^\/service\/jobs\/([^/]+)\/photos\/confirm\/?$/, "jobPhotoConfirm"],
  ["POST", /^\/service\/jobs\/([^/]+)\/photos\/?$/, "jobPhotoPresign"],
  ["GET", /^\/service\/tech\/jobs\/([^/]+)\/photos\/?$/, "techJobPhotos"],
  ["GET", /^\/service\/tech\/jobs\/([^/]+)\/files\/?$/, "techJobFiles"],
  // The technician app (tech.js). Order matters: "photos/confirm" before "photos".
  ["GET", /^\/service\/tech\/day\/?$/, "techDay"],
  ["GET", /^\/service\/tech\/price-book\/?$/, "techPriceBook"],
  ["GET", /^\/service\/tech\/jobs\/?$/, "techJobs"],
  ["GET", /^\/service\/tech\/jobs\/([^/]+)\/?$/, "techJob"],
  ["GET", /^\/service\/tech\/estimates\/?$/, "techEstimates"],
  ["GET", /^\/service\/tech\/estimates\/([^/]+)\/?$/, "techEstimate"],
  ["GET", /^\/service\/tech\/customers\/?$/, "techCustomers"],
  ["GET", /^\/service\/tech\/customers\/([^/]+)\/?$/, "techCustomer"],
  ["GET", /^\/service\/tech\/calls\/([^/]+)\/?$/, "techCall"],
  ["POST", /^\/service\/tech\/calls\/([^/]+)\/status\/?$/, "techStatus"],
  ["POST", /^\/service\/tech\/calls\/([^/]+)\/notes\/?$/, "techNote"],
  ["POST", /^\/service\/tech\/calls\/([^/]+)\/checklist\/?$/, "techChecklist"],
  ["POST", /^\/service\/tech\/calls\/([^/]+)\/photos\/confirm\/?$/, "techPhotoConfirm"],
  ["POST", /^\/service\/tech\/calls\/([^/]+)\/photos\/?$/, "techPhotoPresign"],
  ["GET", /^\/service\/tech\/calls\/([^/]+)\/photos\/?$/, "techPhotos"],
];
export function matchRoute(method, path) {
  const p = (path || "").replace(/^\/[^/]+(?=\/service\/)/, "");
  for (const [m, re, name] of ROUTES) {
    if (m !== method) continue;
    const hit = p.match(re);
    if (hit) return { name, params: hit.slice(1).map((x) => decodeURIComponent(x)) };
  }
  return null;
}
const ACTION_FOR = Object.freeze({
  board: "service.board.read",
  jobCalls: "service.board.read",
  createCall: "service.call.write",
  patchCall: "service.call.write",
  cancelCall: "service.call.write",
  clockGet: "service.board.read",
  clockCorrect: "service.call.write",
  jobPhotos: "service.board.read",
  jobPhotoPresign: "files.job.upload",
  jobPhotoConfirm: "files.job.upload",
  techJobPhotos: "service.tech.read",
  techJobFiles: "service.tech.read",
  techDay: "service.tech.self",
  techPriceBook: "service.tech.self",
  techCall: "service.tech.self",
  techStatus: "service.tech.self",
  techNote: "service.tech.self",
  techChecklist: "service.tech.self",
  techPhotoConfirm: "service.tech.self",
  techPhotoPresign: "service.tech.self",
  techPhotos: "service.tech.self",
  // Read-only, tenant-wide (2026-09-16).
  techJobs: "service.tech.read",
  techJob: "service.tech.read",
  techEstimates: "service.tech.read",
  techEstimate: "service.tech.read",
  techCustomers: "service.tech.read",
  techCustomer: "service.tech.read",
});

function bad(cors, code, message, extra = {}) {
  return jsonResponse(400, cors, { error: "bad_request", code, message, ...extra });
}
function notFound(cors) {
  return jsonResponse(404, cors, { error: "not_found", code: "RECORD_NOT_FOUND" });
}
function sfError(cors, err, where) {
  console.error(`service-board ${where}:`, err?.sfStatus, err?.sfBody || err?.message || err);
  return jsonResponse(502, cors, {
    error: "salesforce_error",
    code: "SALESFORCE_ERROR",
    where,
    message: err?.sfBody ? String(err.sfBody).slice(0, 500) : err?.message || "Salesforce write failed",
  });
}

// ---------------------------------------------------------------------------
// Handler factory
// ---------------------------------------------------------------------------
export function createHandler(deps = {}) {
  const d = {
    resolveIdentity: realResolveIdentity,
    sfQuery: realSfQuery,
    sfCreateRecord: realSfCreateRecord,
    sfUpdateRecord: realSfUpdateRecord,
    getSupabaseClient: realGetSupabaseClient,
    sendEmail: realSendEmail,
    isEmailConfigured: realIsEmailConfigured,
    broadcast: realBroadcast,
    getSecret: realGetSecret,
    fetchUrl: (url, init) => fetch(url, { signal: AbortSignal.timeout(8000), ...(init || {}) }),
    sendSms: undefined, // lib/twilio.js's real send unless a test injects one
    presignPut: realPresignPut,
    listPhotos: realListPhotos,
    now: () => new Date(),
    env: process.env,
    ...deps,
  };
  // The tech's "on my way" text goes through the same sender as the office's panel.
  const sms = createSmsSender({ getSecret: d.getSecret, getSupabaseClient: d.getSupabaseClient, sfQuery: d.sfQuery, broadcast: d.broadcast, now: d.now, env: d.env, ...(d.sendSms ? { sendSms: d.sendSms } : {}) });

  // --- side effects, all best-effort ---------------------------------------------
  async function markStale(table, ids, tenantId) {
    const list = (ids || []).filter(Boolean);
    if (!list.length) return;
    try {
      const supabase = await d.getSupabaseClient();
      const { error } = await supabase.from(table).update({ is_stale: true }).in("sf_id", list).eq("client_sf_id", tenantId);
      if (error) console.error(`cache stale-flag error (${table}):`, error.message);
    } catch (e) {
      console.error(`cache stale-flag threw (${table}):`, e?.message || String(e));
    }
  }
  async function act(ctx, entry) {
    return recordActivity(d.getSupabaseClient, {
      tenantId: ctx.tenantId,
      tenantSlug: ctx.tenantSlug,
      actor: ctx.actor,
      at: d.now().toISOString(),
      ...entry,
    });
  }
  async function announce(ctx, payload) {
    try {
      await d.broadcast(recordChannel(ctx.tenantId, "sundial_service", "list"), "board", { at: d.now().toISOString(), ...payload });
    } catch (e) {
      console.error("board broadcast threw:", e?.message || String(e));
    }
  }
  /** Email the customer about a scheduled/updated/cancelled window. Returns { notified, detail }. */
  async function notifyCustomer(ctx, { kind, job, call, tech, reason }) {
    if (!d.isEmailConfigured()) return { notified: false, detail: "EMAIL_FROM is not set on this Lambda (SES not wired)." };
    let email = strOrNull(job?.Primary_Email_at_Creation__c);
    if (!email && job?.Sundial_Customer__c) {
      try {
        const rows = await d.sfQuery(
          `SELECT Id, Primary_Email__c FROM ${CUSTOMER_SF_OBJECT} WHERE Id = '${soqlEscapeString(job.Sundial_Customer__c)}' ` +
            `AND Client__c = '${soqlEscapeString(ctx.tenantId)}' LIMIT 1`
        );
        email = strOrNull(rows?.[0]?.Primary_Email__c);
      } catch (e) {
        console.error("notify: customer lookup failed:", e?.message || e);
      }
    }
    if (!email) return { notified: false, detail: "The customer has no email address on file." };
    const msg = buildAppointmentEmail({
      kind,
      jobNumber: job?.Name,
      customerName: job?.Customer_Name_at_Creation__c,
      window: formatWindow(call.Scheduled_Start__c, call.Scheduled_End__c),
      techFirstName: tech?.First_Name__c ?? null,
      brandName: DEFAULTS.brandName,
      reason,
    });
    const sent = await d.sendEmail({ to: email, subject: msg.subject, text: msg.text, html: msg.html });
    return sent.ok ? { notified: true, detail: null, recipient: email } : { notified: false, detail: `Email failed: ${sent.error}` };
  }

  // --- tenant-scoped reads --------------------------------------------------------
  async function loadJob(id, tenantId) {
    if (!SF_ID_RE.test(id || "")) return null;
    const rows = await d.sfQuery(
      `SELECT ${JOB_SELECT} FROM ${JOB_SF_OBJECT} WHERE Id = '${soqlEscapeString(id)}' AND Client__c = '${soqlEscapeString(tenantId)}' LIMIT 1`
    );
    return rows?.[0] ?? null;
  }
  async function loadCall(id, tenantId) {
    if (!SF_ID_RE.test(id || "")) return null;
    const rows = await d.sfQuery(
      `SELECT ${CALL_SELECT} FROM ${CALL_SF_OBJECT} WHERE Id = '${soqlEscapeString(id)}' AND Client__c = '${soqlEscapeString(tenantId)}' LIMIT 1`
    );
    return rows?.[0] ?? null;
  }
  async function loadTech(id, tenantId) {
    if (!SF_ID_RE.test(id || "")) return null;
    const rows = await d.sfQuery(
      `SELECT Id, First_Name__c, Last_Name__c, Email__c, Access_Level__c, Default_Department__c FROM ${USER_SF_OBJECT} ` +
        `WHERE Id = '${soqlEscapeString(id)}' AND Client__c = '${soqlEscapeString(tenantId)}' AND Active__c = true LIMIT 1`
    );
    return rows?.[0] ?? null;
  }
  async function loadTechs(tenantId) {
    const rows = await d.sfQuery(
      `SELECT Id, First_Name__c, Last_Name__c, Email__c, Access_Level__c, Default_Department__c FROM ${USER_SF_OBJECT} ` +
        `WHERE Client__c = '${soqlEscapeString(tenantId)}' AND Active__c = true ORDER BY Last_Name__c, First_Name__c`
    );
    return pickTechs(rows || []);
  }
  async function loadJobCalls(jobId, tenantId) {
    return (
      (await d.sfQuery(
        `SELECT ${CALL_SELECT} FROM ${CALL_SF_OBJECT} WHERE Sundial_Service_Job__c = '${soqlEscapeString(jobId)}' ` +
          `AND Client__c = '${soqlEscapeString(tenantId)}' ORDER BY Scheduled_Start__c NULLS LAST, CreatedDate`
      )) || []
    );
  }

  /** The job-status automation described in the header. Returns the new status or null. */
  async function settleJobStatus(ctx, job, trigger, callsAfter) {
    const open = callsAfter.filter((c) => OPEN_CALL_STATUSES.includes(c.Status__c));
    let next = null;
    if (trigger === "scheduled" && UNSCHEDULED_JOB_STATUSES.includes(job.Status__c)) next = "Scheduled";
    if (trigger === "in_progress" && job.Status__c === "Scheduled") next = "In Progress";
    if (trigger === "complete" && open.length === 0 && ["Scheduled", "In Progress"].includes(job.Status__c)) next = "Awaiting Office Review";
    if (trigger === "cancelled" && open.length === 0 && job.Status__c === "Scheduled") next = "Ready to Schedule";
    if (trigger === "reopened" && job.Status__c === "Awaiting Office Review") next = "In Progress";
    if (!next || next === job.Status__c) return null;
    try {
      await d.sfUpdateRecord(JOB_SF_OBJECT, job.Id, { Status__c: next, Status_Changed_At__c: d.now().toISOString() });
    } catch (e) {
      console.error(`job status follow-up failed for ${job.Id}:`, e?.sfBody || e?.message || e);
      return null;
    }
    await act(ctx, {
      event: EVENTS.JOB_UPDATED,
      recordType: "job",
      recordSfId: job.Id,
      jobSfId: job.Id,
      estimateSfId: job.Estimate__c ?? null,
      details: { fields: { Status__c: { from: job.Status__c, to: next } }, via: "dispatch" },
    });
    await markStale(CACHE.job, [job.Id], ctx.tenantId);
    job.Status__c = next;
    return next;
  }

  /** What job-notes.js needs to roll a Complete call's notes onto its job. */
  const notesDeps = { JOB_SF_OBJECT, DEFAULTS, CACHE, EVENTS, markStale, act };

  const H = {
    // --- the board ------------------------------------------------------------
    async board({ ctx, query }) {
      const { tenantId, cors } = ctx;
      const from = isoOrNull(query?.from);
      const to = isoOrNull(query?.to);
      if (!from || !to || Date.parse(to) <= Date.parse(from)) return bad(cors, "WINDOW_INVALID", "from and to must be ISO datetimes with to after from.");
      if (Date.parse(to) - Date.parse(from) > DEFAULTS.maxWindowDays * 86400000) return bad(cors, "WINDOW_TOO_WIDE", `The window is capped at ${DEFAULTS.maxWindowDays} days.`);
      const techFilter = strOrNull(query?.techId);
      if (techFilter && !SF_ID_RE.test(techFilter)) return bad(cors, "TECH_INVALID", "techId must be a Salesforce id.");

      const [{ techs, source }, calls, unscheduled, unscheduledCalls] = await Promise.all([
        loadTechs(tenantId),
        d.sfQuery(
          `SELECT ${CALL_SELECT} FROM ${CALL_SF_OBJECT} WHERE Client__c = '${soqlEscapeString(tenantId)}' ` +
            `AND Scheduled_Start__c >= ${soqlDateTime(from)} AND Scheduled_Start__c < ${soqlDateTime(to)}` +
            (techFilter ? ` AND Tech__c = '${soqlEscapeString(techFilter)}'` : "") +
            ` ORDER BY Scheduled_Start__c`
        ),
        d.sfQuery(
          `SELECT ${JOB_SELECT} FROM ${JOB_SF_OBJECT} WHERE Client__c = '${soqlEscapeString(tenantId)}' ` +
            `AND Status__c IN (${UNSCHEDULED_JOB_STATUSES.map((s) => `'${s}'`).join(", ")}) ORDER BY CreatedDate LIMIT 200`
        ),
        // Calls created without a window (any date — they have none). Their own tray cards.
        d.sfQuery(
          `SELECT ${CALL_SELECT} FROM ${CALL_SF_OBJECT} WHERE Client__c = '${soqlEscapeString(tenantId)}' ` +
            `AND Status__c = 'Unscheduled'` + (techFilter ? ` AND Tech__c = '${soqlEscapeString(techFilter)}'` : "") + ` ORDER BY CreatedDate LIMIT 200`
        ),
      ]);
      const now = d.now();
      // A job whose next step already exists as an unscheduled call shows as THAT card,
      // not twice.
      const jobsWithCalls = new Set((unscheduledCalls || []).map((c) => c.Sundial_Service_Job__c));
      return jsonResponse(200, cors, {
        window: { from, to },
        techs,
        techsSource: source,
        calls: (calls || []).map(callToBoard),
        unscheduled: sortTray((unscheduled || []).filter((j) => !jobsWithCalls.has(j.Id)).map((j) => jobToTray(j, now))),
        unscheduledCalls: (unscheduledCalls || []).map(callToBoard),
        defaults: { callMinutes: DEFAULTS.callMinutes, timeZone: DEFAULTS.timeZone },
      });
    },

    async jobCalls({ ctx, params }) {
      const { tenantId, cors } = ctx;
      const job = await loadJob(params[0], tenantId);
      if (!job) return notFound(cors);
      const [calls, { techs }] = await Promise.all([loadJobCalls(job.Id, tenantId), loadTechs(tenantId)]);
      const geocode = job.Geocode_Lat__c != null && job.Geocode_Lon__c != null ? { lat: job.Geocode_Lat__c, lng: job.Geocode_Lon__c, status: job.Geocode_Status__c ?? null } : null;
      return jsonResponse(200, cors, { jobId: job.Id, jobStatus: job.Status__c ?? null, geocode, calls: calls.map(callToBoard), techs, defaults: { callMinutes: DEFAULTS.callMinutes } });
    },

    // --- schedule -------------------------------------------------------------
    async createCall({ ctx, params, body }) {
      const { tenantId, cors } = ctx;
      const job = await loadJob(params[0], tenantId);
      if (!job) return notFound(cors);
      if (["Closed", "Paid", "Invoiced"].includes(job.Status__c)) {
        return jsonResponse(409, cors, { error: "job_closed", code: "JOB_CLOSED", status: job.Status__c, message: "This job is billed or closed; reopen it before scheduling." });
      }
      const techId = strOrNull(body?.techId);
      const start = isoOrNull(body?.start);
      const end = isoOrNull(body?.end) ?? (start ? new Date(Date.parse(start) + DEFAULTS.callMinutes * 60000).toISOString() : null);
      // `unscheduled: true` (or simply no start) creates the call without a window: it
      // goes to the dispatch tray and is scheduled from there. A tech is optional then.
      const unscheduled = body?.unscheduled === true || !start;
      if (!unscheduled && !techId) return bad(cors, "TECH_REQUIRED", "Pick a technician.");
      if (!unscheduled && Date.parse(end) <= Date.parse(start)) return bad(cors, "WINDOW_INVALID", "end must be after start.");
      const subType = SUB_TYPES.includes(body?.subType) ? body.subType : "On-Site";
      const tech = techId ? await loadTech(techId, tenantId) : null;
      if (techId && !tech) return bad(cors, "TECH_INVALID", "That technician is not an active user in this tenant.");

      const fields = {
        Client__c: tenantId,
        Visit_Type__c: "Service",
        Visit_Sub_Type__c: subType,
        Sundial_Service_Job__c: job.Id,
        Tech__c: tech?.Id ?? null,
        Scheduled_Start__c: unscheduled ? null : start,
        Scheduled_End__c: unscheduled ? null : end,
        Status__c: unscheduled ? "Unscheduled" : "Scheduled",
        Private_Notes__c: strOrNull(body?.privateNotes),
      };
      for (const k of Object.keys(fields)) if (fields[k] === null) delete fields[k];
      let created;
      try {
        created = await d.sfCreateRecord(CALL_SF_OBJECT, fields);
      } catch (e) {
        return sfError(cors, e, "service call create");
      }
      const call = await loadCall(created.id, tenantId);
      await act(ctx, {
        event: EVENTS.SERVICE_CALL_CREATED,
        recordType: "servicecall",
        recordSfId: created.id,
        jobSfId: job.Id,
        estimateSfId: job.Estimate__c ?? null,
        details: { techId: tech?.Id ?? null, techName: tech ? techName(tech) : null, start: unscheduled ? null : start, end: unscheduled ? null : end, subType, unscheduled },
      });
      const calls = await loadJobCalls(job.Id, tenantId);
      const jobStatus = unscheduled ? null : await settleJobStatus(ctx, job, "scheduled", calls);
      await markStale(CACHE.call, [created.id], tenantId);
      let notify = { notified: false, detail: null };
      if (body?.notifyCustomer === true && !unscheduled) notify = await notifyCustomer(ctx, { kind: "scheduled", job, call: call || fields, tech });
      const shaped = call ? callToBoard(call) : { id: created.id, jobId: job.Id, techId: tech?.Id ?? null, start: unscheduled ? null : start, end: unscheduled ? null : end, status: fields.Status__c };
      await announce(ctx, { kind: "call", action: "created", call: shaped, jobStatus: job.Status__c });
      return jsonResponse(201, cors, { success: true, call: shaped, jobStatus: job.Status__c, jobStatusChanged: jobStatus, ...notify });
    },

    // --- move / resize / reassign / status ---------------------------------------
    async patchCall({ ctx, params, body }) {
      const { tenantId, cors } = ctx;
      const call = await loadCall(params[0], tenantId);
      if (!call) return notFound(cors);
      const base = strOrNull(body?.baseModstamp);
      if (base && call.SystemModstamp && base !== call.SystemModstamp) {
        return jsonResponse(409, cors, { error: "conflict", code: "CALL_CONFLICT", message: "This call changed since you loaded it — take another look.", call: callToBoard(call) });
      }
      const fields = {};
      const changes = {};
      const has = (k) => body && Object.prototype.hasOwnProperty.call(body, k);

      // Window / tech: a move. Refused once the tech has started the work.
      const moving = has("start") || has("end") || has("techId");
      if (moving && STARTED_CALL_STATUSES.includes(call.Status__c)) {
        return jsonResponse(409, cors, { error: "started", code: "CALL_ALREADY_STARTED", status: call.Status__c, message: "This call has already started; it can't be moved." });
      }
      const wasUnscheduled = call.Status__c === "Unscheduled";
      if (has("start") || has("end")) {
        const start = has("start") ? isoOrNull(body.start) : call.Scheduled_Start__c;
        // An unscheduled call being given a start gets the default length unless told.
        const end = has("end") ? isoOrNull(body.end) : call.Scheduled_End__c ?? (start ? new Date(Date.parse(start) + DEFAULTS.callMinutes * 60000).toISOString() : null);
        if (!start || !end) return bad(cors, "WINDOW_INVALID", "start and end must be ISO datetimes.");
        if (Date.parse(end) <= Date.parse(start)) return bad(cors, "WINDOW_INVALID", "end must be after start.");
        if (start !== call.Scheduled_Start__c) { fields.Scheduled_Start__c = start; changes.Scheduled_Start__c = { from: call.Scheduled_Start__c, to: start }; }
        if (end !== call.Scheduled_End__c) { fields.Scheduled_End__c = end; changes.Scheduled_End__c = { from: call.Scheduled_End__c, to: end }; }
        // Giving an unscheduled call a window IS scheduling it.
        if (wasUnscheduled && !has("status")) { fields.Status__c = "Scheduled"; changes.Status__c = { from: "Unscheduled", to: "Scheduled" }; }
      }
      let tech = null;
      if (has("techId")) {
        const techId = strOrNull(body.techId);
        if (!techId) return bad(cors, "TECH_REQUIRED", "Pick a technician.");
        tech = await loadTech(techId, tenantId);
        if (!tech) return bad(cors, "TECH_INVALID", "That technician is not an active user in this tenant.");
        if (tech.Id !== call.Tech__c) { fields.Tech__c = tech.Id; changes.Tech__c = { from: call.Tech__c, to: tech.Id, toName: techName(tech) }; }
      }
      if (has("subType")) {
        if (!SUB_TYPES.includes(body.subType)) return bad(cors, "SUBTYPE_INVALID", `subType must be one of ${SUB_TYPES.join(", ")}.`);
        if (body.subType !== call.Visit_Sub_Type__c) { fields.Visit_Sub_Type__c = body.subType; changes.Visit_Sub_Type__c = { from: call.Visit_Sub_Type__c, to: body.subType }; }
      }
      if (has("status")) {
        const status = body.status;
        if (!CALL_STATUSES.includes(status)) return bad(cors, "STATUS_INVALID", `status must be one of ${CALL_STATUSES.join(", ")}.`);
        if (status === "Cancelled") return bad(cors, "USE_CANCEL", "Cancel through POST /service/calls/{id}/cancel so a reason is recorded.");
        if (status !== "Unscheduled" && !(fields.Scheduled_Start__c || call.Scheduled_Start__c)) {
          return bad(cors, "CALL_NOT_SCHEDULED", "Give the call a start time before moving it past Unscheduled.");
        }
        if (status !== call.Status__c) {
          fields.Status__c = status;
          changes.Status__c = { from: call.Status__c, to: status };
          // The office marking progress by hand moves the SAME clock the phone writes, so the
          // log, the actuals and the tech's app all agree: In Progress opens an interval (if none
          // is open), Complete / No-Show closes the open one, and the actuals are derived from
          // the log — never stamped beside it. A call that was never clocked and is marked
          // Complete keeps the old behaviour: the end is now.
          const now = d.now().toISOString();
          const log = parseIntervals(call.Clock_Intervals__c);
          if (status === "In Progress") {
            const ev = applyClockEvent(log, { kind: "clock_in", at: now });
            if (ev.changed) Object.assign(fields, clockFields(ev.intervals), { Actual_End__c: null, Duration_Minutes__c: null });
          } else if (status === "Complete" || status === "No-Show") {
            const ev = applyClockEvent(log, { kind: "clock_out", at: now });
            if (ev.changed) Object.assign(fields, clockFields(ev.intervals));
            if (status === "Complete" && !fields.Actual_End__c && !call.Actual_End__c) fields.Actual_End__c = now;
            if (status === "No-Show") { delete fields.Actual_End__c; delete fields.Duration_Minutes__c; }
          }
        }
      }
      for (const [key, api] of [["workNotes", "Work_Notes__c"], ["privateNotes", "Private_Notes__c"]]) {
        if (has(key)) {
          const v = strOrNull(body[key]);
          if (v !== (call[api] ?? null)) { fields[api] = v; changes[api] = { from: call[api] ?? null, to: v }; }
        }
      }
      if ((fields.Status__c === "Scheduled" || (changes.Status__c && changes.Status__c.to !== "Unscheduled")) && !(fields.Tech__c || call.Tech__c)) {
        return bad(cors, "TECH_REQUIRED", "Pick a technician to schedule this call.");
      }
      if (Object.keys(fields).length === 0) {
        return jsonResponse(200, cors, { success: true, unchanged: true, call: callToBoard(call) });
      }
      try {
        await d.sfUpdateRecord(CALL_SF_OBJECT, call.Id, fields);
      } catch (e) {
        return sfError(cors, e, "service call update");
      }
      const after = (await loadCall(call.Id, tenantId)) || { ...call, ...fields };
      await act(ctx, {
        event: EVENTS.SERVICE_CALL_UPDATED,
        recordType: "servicecall",
        recordSfId: call.Id,
        jobSfId: call.Sundial_Service_Job__c ?? null,
        details: { fields: changes, via: "dispatch" },
      });
      await markStale(CACHE.call, [call.Id], tenantId);
      // A Complete call's notes live on the job too (job-notes.js): when the office marks it
      // Complete from the status menu, or edits the notes of a call that is already Complete.
      if (after.Status__c === "Complete" && (changes.Status__c || changes.Work_Notes__c || changes.Private_Notes__c)) {
        await syncCallNotesToJob({ d, h: notesDeps, ctx, call: after, techName: after.Tech__r ? techName(after.Tech__r) : null, at: after.Actual_End__c ?? d.now().toISOString() });
      }

      // Job status follows the call.
      let jobStatusChanged = null;
      let job = null;
      if (call.Sundial_Service_Job__c && (changes.Status__c || moving)) {
        job = await loadJob(call.Sundial_Service_Job__c, tenantId);
        if (job && changes.Status__c) {
          const calls = await loadJobCalls(job.Id, tenantId);
          if (changes.Status__c.to === "Scheduled" && wasUnscheduled) jobStatusChanged = await settleJobStatus(ctx, job, "scheduled", calls);
          else if (changes.Status__c.to === "In Progress") jobStatusChanged = await settleJobStatus(ctx, job, "in_progress", calls);
          else if (["Complete", "No-Show"].includes(changes.Status__c.to)) jobStatusChanged = await settleJobStatus(ctx, job, "complete", calls);
        }
      }
      let notify = { notified: false, detail: null };
      if (body?.notifyCustomer === true && moving) {
        job = job || (call.Sundial_Service_Job__c ? await loadJob(call.Sundial_Service_Job__c, tenantId) : null);
        notify = await notifyCustomer(ctx, { kind: wasUnscheduled ? "scheduled" : "updated", job, call: after, tech: tech || after.Tech__r });
      }
      const shaped = callToBoard(after);
      await announce(ctx, { kind: "call", action: "updated", call: shaped, jobStatus: job?.Status__c ?? null });
      return jsonResponse(200, cors, { success: true, call: shaped, changed: Object.keys(changes), jobStatusChanged, ...notify });
    },

    async cancelCall({ ctx, params, body }) {
      const { tenantId, cors } = ctx;
      const call = await loadCall(params[0], tenantId);
      if (!call) return notFound(cors);
      if (call.Status__c === "Cancelled") return jsonResponse(200, cors, { success: true, alreadyCancelled: true, call: callToBoard(call) });
      if (call.Status__c === "Complete") return jsonResponse(409, cors, { error: "complete", code: "CALL_ALREADY_COMPLETE", message: "A completed call can't be cancelled." });
      const base = strOrNull(body?.baseModstamp);
      if (base && call.SystemModstamp && base !== call.SystemModstamp) {
        return jsonResponse(409, cors, { error: "conflict", code: "CALL_CONFLICT", message: "This call changed since you loaded it — take another look.", call: callToBoard(call) });
      }
      const reason = strOrNull(body?.reason);
      if (!reason) return bad(cors, "REASON_REQUIRED", "Give a reason for the cancellation.");
      try {
        await d.sfUpdateRecord(CALL_SF_OBJECT, call.Id, { Status__c: "Cancelled", Cancel_Reason__c: reason.slice(0, 255) });
      } catch (e) {
        return sfError(cors, e, "service call cancel");
      }
      await act(ctx, {
        event: EVENTS.SERVICE_CALL_CANCELLED,
        recordType: "servicecall",
        recordSfId: call.Id,
        jobSfId: call.Sundial_Service_Job__c ?? null,
        details: { reason, fields: { Status__c: { from: call.Status__c, to: "Cancelled" } }, via: "dispatch" },
      });
      await markStale(CACHE.call, [call.Id], tenantId);
      let jobStatusChanged = null;
      let job = null;
      if (call.Sundial_Service_Job__c) {
        job = await loadJob(call.Sundial_Service_Job__c, tenantId);
        if (job) jobStatusChanged = await settleJobStatus(ctx, job, "cancelled", await loadJobCalls(job.Id, tenantId));
      }
      let notify = { notified: false, detail: null };
      if (body?.notifyCustomer === true) notify = await notifyCustomer(ctx, { kind: "cancelled", job, call, tech: call.Tech__r, reason });
      const shaped = callToBoard({ ...call, Status__c: "Cancelled", Cancel_Reason__c: reason });
      await announce(ctx, { kind: "call", action: "cancelled", call: shaped, jobStatus: job?.Status__c ?? null });
      return jsonResponse(200, cors, { success: true, call: shaped, jobStatusChanged, ...notify });
    },
  };
  Object.assign(
    H,
    createTechHandlers(d, {
      CALL_SF_OBJECT, JOB_SF_OBJECT, USER_SF_OBJECT, CALL_SELECT, DEFAULTS, CACHE,
      callToBoard, techName, soqlDateTime, loadTech, loadJob, loadJobCalls, settleJobStatus, act, markStale, announce, sms,
      jsonResponse, bad, notFound, sfError, notesDeps,
    })
  );
  H.techJobPhotos = H.jobPhotos; // the tech's route: same handler, different action gate

  return async function handler(event) {
    const method = httpMethod(event);
    const headers = normalizeHeaders(event?.headers);
    const cors = corsHeaders(headers["origin"]);
    if (method === "OPTIONS") return { statusCode: 204, headers: cors, body: "" };

    const route = matchRoute(method, event?.rawPath || event?.path || "");
    if (!route) return jsonResponse(404, cors, { error: "not_found", code: "ROUTE_NOT_FOUND" });

    let identity;
    try {
      identity = await d.resolveIdentity(headers["authorization"]);
    } catch (err) {
      const m = mapIdentityError(err?.code);
      if (m) return jsonResponse(m.status, cors, m.body);
      console.error("identity error:", err?.message || err);
      return jsonResponse(500, cors, { error: "server_error" });
    }
    const tenantId = identity?.tenantId;
    if (!tenantId) return jsonResponse(403, cors, { error: "no_tenant", code: "NO_TENANT" });
    const denied = assertAction(ACTION_FOR[route.name], alwaysEnforcedAccess(identity));
    if (denied) return jsonResponse(denied.status, cors, denied.body);

    let body = {};
    if (method !== "GET") {
      const parsed = parseJsonBody(event);
      if (!parsed.ok && event?.body) return bad(cors, "INVALID_BODY", "Body must be JSON.");
      body = parsed.ok ? parsed.data : {};
    }
    try {
      const u = identity?.user ?? {};
      const ctx = {
        tenantId,
        tenantSlug: identity?.tenantSlug ?? null,
        userId: u.id ?? null,
        scope: identity?.access?.scope ?? null,
        actor: { id: u.id ?? null, name: [u.firstName, u.lastName].filter(Boolean).join(" ") || u.email || null },
        cors,
      };
      return await H[route.name]({ ctx, params: route.params, body, query: event?.queryStringParameters || {} });
    } catch (err) {
      console.error(`service-board ${route.name} error:`, err?.sfBody || err?.message || err);
      return jsonResponse(500, cors, { error: "server_error", route: route.name });
    }
  };
}

export const handler = createHandler();
