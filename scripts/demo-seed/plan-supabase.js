// plan-supabase.js — the Supabase-only parts of the demo: team notes, the activity trail,
// text threads, bell notifications and the users' profile rows.
//
// These never touch Salesforce. Every row carries the demo tenant's id (`tenant_id` on
// profiles / comments, `client_sf_id` on the rest) so the documented cleanup is one
// `delete … where <column> = '<demo tenant id>'` per table.
//
// NOT seeded on purpose: `comment_mentions`. A trigger on that table emails the mentioned
// person on insert (sql/sundial_comment_mention_notify.sql).

import { createHash } from "node:crypto";
import { resolveScope, profileScopeColumns } from "../../lib/access.js";
import { EVENTS } from "../../lib/service-activity.js";
import { CATEGORIES, fmtTime } from "../../lib/notify.js";
import { addMinutes, phxAt, addDays, onWeekday, prettyDate, phxDateOf } from "./dates.js";
import { ref, nameOf, authId, concat } from "./tokens.js";
import { PERSONAS, DEALERS, persona, toE164, ADMIN_KEY, DISPATCHER_KEY, SOLAR_PM_KEY, ROOFING_PM_KEY, OFFICE_SMS_NUMBER } from "./catalog.js";
import { replayJobTransitions } from "./plan-service.js";

/** A stable uuid from a label — the same comment gets the same id on every run, so an upsert is idempotent. */
export function stableUuid(label) {
  const h = createHash("sha1").update(`sundial-demo-seed|${label}`).digest("hex");
  const variant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** The profiles row, in the shape sundial-auth-proxy upserts on every /auth/me. */
function profileRows() {
  return PERSONAS.map((p) => {
    const dealer = p.dealer ? DEALERS.find((d) => d.key === p.dealer) : null;
    // The scope columns come from the same pure function the auth proxy uses; the ids
    // are placeholders here and swapped for the real ones by the writer.
    const scope = resolveScope({ accessLevel: p.accessLevel, id: "user", dealer: dealer ? { id: "dealer", active: true, isInternal: dealer.internal } : null }, "tenant");
    const cols = profileScopeColumns(scope);
    return {
      id: authId(p.key),
      tenant_id: ref("tenant"),
      sundial_user_id: ref(p.key),
      email: p.email,
      full_name: p.name,
      access_scope: cols.access_scope,
      access_level: cols.access_level,
      dealer_sf_id: cols.dealer_sf_id ? ref(p.dealer) : null,
    };
  });
}

function commentRows({ profiles, service, anchorDate, tenantSlug, rng }) {
  const rows = [];
  const add = (recordKey, recordObject, authorKey, body, daysAgo, minute) => {
    const label = `comment|${tenantSlug}|${recordKey}|${rows.length}`;
    rows.push({
      id: stableUuid(label),
      tenant_id: ref("tenant"),
      record_id: ref(recordKey),
      record_object: recordObject,
      author_id: authId(authorKey),
      author_name: persona(authorKey).name,
      body,
      created_at: phxAt(onWeekday(addDays(anchorDate, -daysAgo)), minute),
    });
  };
  const r = rng.fork("comments");
  const solar = profiles.filter((p) => p.kind === "solar");
  // Solar projects: the PM's running notes.
  for (const p of solar.slice(0, 22)) {
    const pm = p.roofing ? ROOFING_PM_KEY : SOLAR_PM_KEY;
    add(p.solar.key, "solar", pm, `${p.solar.rule.note} Next update to the homeowner is on my list.`, r.int(1, 6), 9 * 60 + r.int(0, 40) * 10);
    if (p.n % 3 === 0) add(p.solar.key, "solar", ADMIN_KEY, "Thanks. Keep this one moving, the homeowner referred two neighbours.", r.int(0, 1), 14 * 60 + r.int(0, 12) * 10);
  }
  // Customers: the rep who owns the record (a sales role may only comment on customers).
  for (const p of profiles.filter((x) => x.kind === "pipeline").slice(0, 14)) {
    add(p.key, "customer", p.repKey, p.pipeline.status === "Lead"
      ? "Tried the mobile twice this week. Will try again after 5 pm."
      : "Good conversation. They want the numbers side by side with their current bill before deciding.", r.int(1, 9), 10 * 60 + r.int(0, 30) * 10);
  }
  for (const p of solar.slice(0, 6)) add(p.key, "customer", p.repKey, "Checked in with the homeowner. Happy with progress, asked when the install will be.", r.int(2, 12), 11 * 60 + r.int(0, 20) * 10);
  // Jobs: the dispatcher and the techs.
  for (const j of service.jobs.filter((x) => x.calls.length).slice(0, 18)) {
    const tech = j.calls.find((c) => c.techKey)?.techKey;
    add(j.key, "job", DISPATCHER_KEY, j.status === "Awaiting Parts"
      ? "Part ordered, supplier says three working days. I will book the return visit when it lands."
      : "Customer confirmed the appointment by phone. Side gate will be unlocked.", r.int(1, 8), 8 * 60 + r.int(0, 30) * 10);
    if (tech && j.no % 2 === 0) add(j.key, "job", tech, "Bring the 28 ft ladder for this one, array is on the second storey.", r.int(0, 3), 7 * 60 + r.int(0, 5) * 10);
  }
  return rows;
}

function activityRows({ service, tenantSlug }) {
  const rows = [];
  const dana = persona(DISPATCHER_KEY);
  const add = (event, recordType, record, jobKey, estKey, actorKey, details, at) =>
    rows.push({
      client_sf_id: ref("tenant"),
      tenant_id: tenantSlug,
      event,
      record_type: recordType,
      record_sf_id: ref(record),
      job_sf_id: jobKey ? ref(jobKey) : null,
      estimate_sf_id: estKey ? ref(estKey) : null,
      actor_user_sf_id: actorKey ? ref(actorKey) : null,
      actor_name: actorKey ? persona(actorKey).name : null,
      details,
      at,
    });
  void dana;
  for (const est of service.estimates) {
    const job = est.jobKey ? service.jobs.find((j) => j.key === est.jobKey) : null;
    const jk = job?.key ?? null;
    const t = est.times;
    add(EVENTS.ESTIMATE_CREATED, "estimate", est.key, jk, est.key, DISPATCHER_KEY, { number: nameOf(est.key), total: est.totals.total }, t.createdAt);
    est.lines.forEach((l, i) => add(EVENTS.LINE_ADDED, "serviceline", l.key, jk, est.key, DISPATCHER_KEY, { description: l.fields.Description__c }, addMinutes(t.createdAt, i + 1)));
    if (est.fields.Last_Sent_At__c) add(EVENTS.ESTIMATE_SENT, "estimate", est.key, jk, est.key, DISPATCHER_KEY, { version: est.fields.Version__c, via: est.fields.Last_Sent_Via__c, total: est.totals.total }, t.sentAt);
    if (est.fields.Approved_At__c) add(EVENTS.ESTIMATE_APPROVED, "estimate", est.key, jk, est.key, null, { method: est.fields.Approval_Method__c, approvedBy: est.fields.Approved_By_Name__c, version: est.fields.Approved_Version__c, amount: est.totals.total }, t.approvedAt);
    if (est.status === "Declined") add(EVENTS.ESTIMATE_DECLINED, "estimate", est.key, jk, est.key, null, { reason: est.fields.Declined_Reason__c }, t.viewedAt);
    if (!job) continue;

    add(EVENTS.JOB_CREATED, "job", job.key, job.key, est.key, DISPATCHER_KEY, { quickCreate: true }, job.times.intakeAt);
    const { transitions } = replayJobTransitions("New", job.calls, job.officeSteps);
    for (const tr of transitions) {
      add(EVENTS.JOB_UPDATED, "job", job.key, job.key, est.key, tr.via === "dispatch" ? null : DISPATCHER_KEY, { fields: { Status__c: { from: tr.from, to: tr.to } }, via: tr.via }, addMinutes(tr.at, 0));
    }
    for (const c of job.calls) {
      if (c.kind === "unscheduled") {
        add(EVENTS.SERVICE_CALL_CREATED, "servicecall", c.key, job.key, est.key, DISPATCHER_KEY, { unscheduled: true }, addMinutes(job.bookedAt, 3));
        continue;
      }
      add(EVENTS.SERVICE_CALL_CREATED, "servicecall", c.key, job.key, est.key, DISPATCHER_KEY, { start: c.start, end: c.end, techName: persona(c.techKey).name }, addMinutes(job.bookedAt, 2));
      if (c.kind === "cancelled") add(EVENTS.SERVICE_CALL_CANCELLED, "servicecall", c.key, job.key, est.key, DISPATCHER_KEY, { reason: c.fields.Cancel_Reason__c }, c.cancelledAt);
      const first = c.intervals[0];
      if (!first) continue;
      if (first.kind === "en_route") add(EVENTS.SERVICE_CALL_CLOCK, "servicecall", c.key, job.key, est.key, c.techKey, { status: "En Route", at: first.in }, first.in);
      if (first.arrived) add(EVENTS.SERVICE_CALL_CLOCK, "servicecall", c.key, job.key, est.key, c.techKey, { status: "In Progress", at: first.arrived, geofence: true }, addMinutes(first.arrived, 0));
      if (c.workNote) add(EVENTS.SERVICE_CALL_NOTE, "servicecall", c.key, job.key, est.key, c.techKey, { preview: c.workNote.slice(0, 120), private: false }, addMinutes(c.actualEnd, -4));
      if (first.out && c.kind !== "inprogress") add(EVENTS.SERVICE_CALL_CLOCK, "servicecall", c.key, job.key, est.key, c.techKey, { status: c.kind === "noshow" ? "No-Show" : "Complete", at: first.out, minutes: c.minutes }, addMinutes(first.out, 0));
    }
    if (job.invoice) {
      add(EVENTS.INVOICE_ISSUED, "serviceinvoice", job.invoice.key, job.key, est.key, DISPATCHER_KEY, { number: nameOf(job.key), total: est.totals.total, billTo: job.billTo.type }, job.invoice.issuedAt);
      if (job.invoice.sentAt) add(EVENTS.INVOICE_SENT, "serviceinvoice", job.invoice.key, job.key, est.key, DISPATCHER_KEY, { number: nameOf(job.key) }, job.invoice.sentAt);
    }
    for (const p of job.payments) add(EVENTS.PAYMENT_RECORDED, "servicepayment", p.key, job.key, est.key, DISPATCHER_KEY, { amount: p.amount, method: p.method, type: p.type }, p.at);
  }
  return rows;
}

function smsRows({ service, tenantSlug, liveDemoKeys }) {
  const rows = [];
  const dana = persona(DISPATCHER_KEY);
  // Never on a live-demo customer's job: their thread is kept clean for real texts.
  const jobs = service.jobs.filter((j) => j.calls.some((c) => c.start) && !liveDemoKeys.includes(j.profile.key)).slice(0, 12);
  for (const job of jobs) {
    const customer = toE164(job.profile.phone);
    const first = job.profile.person.first;
    const call = job.calls.find((c) => c.start);
    const tech = persona(call.techKey);
    const day = prettyDate(phxDateOf(call.start));
    let n = 0;
    const msg = (direction, body, at, by) => {
      n++;
      rows.push({
        client_sf_id: ref("tenant"),
        tenant_id: tenantSlug,
        direction,
        job_sf_id: ref(job.key),
        customer_sf_id: ref(job.profile.key),
        from_number: direction === "out" ? OFFICE_SMS_NUMBER : customer,
        to_number: direction === "out" ? customer : OFFICE_SMS_NUMBER,
        body,
        media: [],
        status: direction === "out" ? "delivered" : "received",
        error_code: null,
        // Twilio's real ids start with "SM"; these cannot collide with one.
        provider_sid: `DEMO-${tenantSlug}-${job.key.split(":")[1]}-${n}`,
        sent_by_user_sf_id: by ? ref(by.key) : null,
        sent_by_name: by ? by.name : null,
        created_at: at,
        updated_at: at,
      });
    };
    const booked = job.bookedAt;
    msg("out", `Hi ${first}, this is ${dana.first} at Constructive Solar. You are booked for ${day}. Reply C to confirm or call us to change it.`, addMinutes(booked, 5), dana);
    msg("in", "C, thank you", addMinutes(booked, 38), null);
    if (call.intervals?.length && call.intervals[0].kind === "en_route") {
      msg("out", `Hi ${first}, ${tech.first} from Constructive Solar is on the way and should be with you in about 20 minutes.`, call.intervals[0].in, tech);
      if (job.no % 2) msg("in", "Great, the side gate is open.", addMinutes(call.intervals[0].in, 4), null);
    }
    if (call.kind === "complete") msg("out", `Thanks ${first}. ${tech.first} has finished for today. Your summary will follow by email.`, addMinutes(call.actualEnd, 20), dana);
  }
  return rows;
}

/**
 * The office's bell. Every row is one a REAL emitter would have written for the seeded
 * event — same category, kind, wording, url and record — so the bell, its Settings
 * switches (which are per category) and a click on a row all behave as they do live:
 *
 *   tech_activity / complete          sundial-service-board tech.js   "<tech> completed SVC-… · <customer>"   -> the job
 *   tech_activity / clock_in          sundial-service-board tech.js   "<tech> clocked in at SVC-… · <customer>" -> the job
 *   money / estimate_approved         sundial-service-public          "Approved online: EST-… · <customer> — $…" -> the estimate
 *   money / deposit_paid              sundial-service-estimate stripe "Deposit received: $… on SVC-… · <customer>" -> the job
 *   customer_message / text           sundial-sms                     "Text from <customer> · SVC-…"          -> the job
 *
 * (The office is never sent `customer_text` — that category is the TECH's copy of an
 * inbound text.) Only the dedupe key is the demo's own ("demo:…"), so a real event on the
 * same record can never be swallowed as a duplicate of a seeded row.
 */
function notificationRows({ service, tenantSlug, sms }) {
  const rows = [];
  let n = 0;
  const add = (userKey, { category, kind, title, body, url, recordType, recordKey, at }) => {
    n++;
    rows.push({
      client_sf_id: ref("tenant"),
      profile_id: authId(userKey),
      user_sf_id: ref(userKey),
      category,
      kind,
      title,
      body,
      url,
      record_type: recordType,
      record_sf_id: ref(recordKey),
      dedupe_key: `demo:${tenantSlug}:${n}`,
      created_at: at,
    });
  };
  const by = (status) => service.jobs.filter((j) => j.status === status);
  const jobUrl = (job) => concat("/service/jobs/", ref(job.key));
  // "SVC-00012 · Ann Lee" — lib/notify.js jobLabel().
  const jobLabel = (job) => [nameOf(job.key), ` · ${job.profile.person.name}`];
  const usd = (x) => `$${Number(x).toFixed(2)}`;

  // A tech completed a call on a job now waiting for the office.
  const aor = by("Awaiting Office Review")[0];
  const done = aor?.calls.filter((c) => c.kind === "complete").pop();
  // A tech is clocked in right now.
  const live = by("In Progress")[0];
  const arrived = live?.calls.find((c) => c.kind === "inprogress");
  // An estimate approved on the customer's hosted page.
  const approvedJob = by("Scheduled").find((j) => j.estimate.status === "Approved" && j.estimate.fields.Approval_Method__c === "Online")
    ?? service.jobs.find((j) => j.estimate.fields.Approval_Method__c === "Online" && j.estimate.fields.Approved_At__c);
  // A deposit paid by card when the estimate was approved.
  const depositJob = service.jobs.find((j) => j.payments.some((p) => p.type === "Deposit" && p.method === "Card"));
  const deposit = depositJob?.payments.find((p) => p.type === "Deposit" && p.method === "Card");
  // The latest inbound text in the seeded threads.
  const inbound = sms.filter((r) => r.direction === "in").sort((a, b) => a.created_at.localeCompare(b.created_at)).pop();
  const textedJob = inbound ? service.jobs.find((j) => j.key === inbound.job_sf_id.$ref) : null;

  for (const userKey of [ADMIN_KEY, DISPATCHER_KEY]) {
    if (aor && done) {
      add(userKey, {
        category: CATEGORIES.TECH_ACTIVITY, kind: "complete",
        title: concat(`${persona(done.techKey).name} completed `, ...jobLabel(aor)),
        body: concat(nameOf(done.key), ` · ${fmtTime(done.actualEnd)} · ${done.minutes} min on site`),
        url: jobUrl(aor), recordType: "servicecall", recordKey: done.key, at: done.actualEnd,
      });
    }
    if (deposit) {
      add(userKey, {
        category: CATEGORIES.MONEY, kind: "deposit_paid",
        title: concat(`Deposit received: ${usd(deposit.amount)} on `, ...jobLabel(depositJob)),
        body: "Paid online by card",
        url: jobUrl(depositJob), recordType: "job", recordKey: depositJob.key, at: deposit.at,
      });
    }
    if (approvedJob) {
      const est = approvedJob.estimate;
      add(userKey, {
        category: CATEGORIES.MONEY, kind: "estimate_approved",
        title: concat("Approved online: ", nameOf(est.key), ` · ${approvedJob.profile.person.name} — ${usd(est.totals.total)}`),
        body: `Signed by ${est.fields.Approved_By_Name__c} (v${est.fields.Approved_Version__c})`,
        url: concat("/service/estimates/", ref(est.key)), recordType: "estimate", recordKey: est.key, at: est.fields.Approved_At__c,
      });
    }
    if (live && arrived) {
      add(userKey, {
        category: CATEGORIES.TECH_ACTIVITY, kind: "clock_in",
        title: concat(`${persona(arrived.techKey).name} clocked in at `, ...jobLabel(live)),
        body: concat(nameOf(arrived.key), ` · ${fmtTime(arrived.arrivedAt)}`),
        url: jobUrl(live), recordType: "servicecall", recordKey: arrived.key, at: arrived.arrivedAt,
      });
    }
    if (inbound && textedJob) {
      add(userKey, {
        category: CATEGORIES.CUSTOMER_MESSAGE, kind: "text",
        title: concat(`Text from ${textedJob.profile.person.name} · `, nameOf(textedJob.key)),
        body: inbound.body,
        url: jobUrl(textedJob), recordType: "job", recordKey: textedJob.key, at: inbound.created_at,
      });
    }
  }
  return rows;
}

export function planSupabase({ profiles, service, anchorDate, tenantSlug, rng, liveDemoKeys }) {
  const sms = smsRows({ service, tenantSlug, liveDemoKeys });
  return {
    profiles: profileRows(),
    comments: commentRows({ profiles, service, anchorDate, tenantSlug, rng }),
    activity: activityRows({ service, tenantSlug }),
    sms,
    notifications: notificationRows({ service, tenantSlug, sms }),
  };
}

/** Which column holds the tenant on each table the seed writes — for the cleanup statements. */
export const SUPABASE_TENANT_COLUMN = Object.freeze({
  profiles: "tenant_id",
  comments: "tenant_id",
  sundial_service_activity: "client_sf_id",
  sundial_sms_messages: "client_sf_id",
  sundial_notifications: "client_sf_id",
  sundial_file_metadata: "tenant_id",
});
