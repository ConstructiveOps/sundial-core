// lib/hcp-disposition.js — what is ACTIVE in the Housecall Pro data (2026-10-02, Tim + Harmon).
//
// Harmon's complaint after the first import: every HCP record came over as a live one, so
// the Service list and board views were ~9,500 customers deep and the real work was buried.
// HCP has no "archived" flag on the API; it has signals, and this module turns them into
// three things the import writes:
//
//   Archived__c (checkbox, every Service list hides it by default, search still finds it)
//     customer   EVERY customer that would land as a Lead (no job in HCP — the import's
//                Status__c rule), open HCP lead or not: Harmon starts Sundial with a clean
//                Lead / Opportunity pipeline (2026-10-02, the 11th-hour ask); its stage is
//                still written, hidden. A customer WITH jobs: archived when nothing is open
//                (no open HCP lead, no live job, no live estimate) AND no activity for
//                STALE_DAYS. Never written on a customer the import merely LINKED (prior
//                solar / roofing work — Sales owns it).
//     job        cancelled in HCP; complete and paid (or $0); complete + unpaid but tagged
//                "invoiced …" (Harmon's "handed to Acumatica" tag — the untagged ones stay
//                visible as Invoiced so the office can check them); or STALE: scheduled more
//                than STALE_DAYS ago and never started, or needs-scheduling untouched that long
//     estimate   converted to a job in HCP; cancelled / declined / expired; or untouched for
//                STALE_DAYS. The job's own estimate follows the job.
//   Service_Stage__c   an OPEN lead's stage from HCP's pipeline_status (First Contact …),
//                a won lead is Resolved (Job / Estimate Created), a lost one Closed (Lost).
//                A blank stage is NOT "open" any more — the Customers page says so too.
//   the stale list     every job archived as stale goes to stale-jobs.csv for Monday's review.
//
// Pure functions over the pulled JSON, like lib/hcp-import.js; the script passes `now`.

const s = (v) => (v == null ? "" : String(v).trim());
const ms = (v) => (s(v) ? new Date(v).getTime() : NaN);
const DAY = 24 * 3600 * 1000;

export const DEFAULT_STALE_DAYS = 90;
export const ARCHIVE_NOTE = "Archived by the HCP import";

const isCancelled = (ws) => /cancel/.test(s(ws).toLowerCase());
const isComplete = (ws) => /complete/.test(s(ws).toLowerCase());
const isInProgress = (ws) => /in[_ ]progress/.test(s(ws).toLowerCase());
const needsScheduling = (ws) => /unscheduled|needs scheduling/.test(s(ws).toLowerCase());
/** Harmon tags a job "invoiced", "invoiced 7/23/26", … when the invoice goes to Acumatica. */
export const hasInvoicedTag = (job) => (Array.isArray(job?.tags) ? job.tags : []).some((t) => /^invoiced\b/i.test(s(t)));
const day = (v) => (s(v) ? new Date(v).toISOString().slice(0, 10) : "");

/**
 * The job: `{ archived, reason, stale }`. `st` is invoiceState() for the job's invoices.
 * `stale` is true only for the two abandonment rules — those are the rows of stale-jobs.csv.
 */
export function jobDisposition(job, { st, now = new Date(), staleDays = DEFAULT_STALE_DAYS } = {}) {
  const ws = s(job?.work_status);
  const cutoff = now.getTime() - staleDays * DAY;
  if (isCancelled(ws)) return { archived: true, reason: `cancelled in HCP${s(job.deleted_at) ? " (deleted)" : ""}`, stale: false };
  if (isComplete(ws)) {
    if (st?.fullyPaid) return { archived: true, reason: "complete and paid in HCP", stale: false };
    if (!st?.invoiced || (Number(job.total_amount) || 0) === 0) return { archived: true, reason: "complete in HCP, nothing to bill", stale: false };
    if (hasInvoicedTag(job)) return { archived: true, reason: "complete; invoice handed to Acumatica (HCP tag)", stale: false };
    return { archived: false, reason: null, stale: false }; // Invoiced, unpaid, untagged: the office checks it
  }
  if (isInProgress(ws)) return { archived: false, reason: null, stale: false };
  const started = s(job?.work_timestamps?.started_at);
  const start = ms(job?.schedule?.scheduled_start);
  if (/scheduled/.test(ws.toLowerCase()) && !needsScheduling(ws)) {
    if (!started && Number.isFinite(start) && start < cutoff) {
      return { archived: true, reason: `scheduled for ${day(job.schedule.scheduled_start)} in HCP and never started`, stale: true };
    }
    return { archived: false, reason: null, stale: false };
  }
  // needs scheduling (or anything else open): abandoned when nobody touched it for a season
  const touched = ms(job?.updated_at) || ms(job?.created_at);
  if (Number.isFinite(touched) && touched < cutoff) {
    return { archived: true, reason: `needs scheduling in HCP, untouched since ${day(job.updated_at || job.created_at)}`, stale: true };
  }
  return { archived: false, reason: null, stale: false };
}

/**
 * A standalone estimate: `{ archived, reason }`. `convertedTo` is the HCP job it became
 * (matched on the OPTION id — a job's original_estimate_id is `est_…`, the estimate's own
 * id is `csr_…`; 0 of 77 matched by estimate id on 2026-09-28).
 */
export function estimateDisposition(est, { convertedTo = null, status = "Sent", now = new Date(), staleDays = DEFAULT_STALE_DAYS } = {}) {
  if (convertedTo) return { archived: true, reason: `converted to HCP job #${s(convertedTo.invoice_number) || s(convertedTo.id)}` };
  if (isCancelled(est?.work_status)) return { archived: true, reason: "cancelled in HCP" };
  if (status === "Declined" || status === "Expired") return { archived: true, reason: `${status.toLowerCase()} in HCP` };
  const cutoff = now.getTime() - staleDays * DAY;
  const touched = ms(est?.updated_at) || ms(est?.created_at);
  if (Number.isFinite(touched) && touched < cutoff) return { archived: true, reason: `untouched in HCP since ${day(est.updated_at || est.created_at)}` };
  return { archived: false, reason: null };
}

const isOpenLead = (l) => s(l?.status).toLowerCase() === "open" && !s(l?.lost_at);

/**
 * The customer: `{ archived, reason, lastActivity }` from everything HCP holds on it.
 * `jobs` / `estimates` carry their dispositions ({ job, disposition }); `leads` are raw.
 */
export const LEAD_RESET_REASON = "would start as a Lead — Harmon opens Sundial with a clean Lead / Opportunity pipeline";

export function customerDisposition(c, { leads = [], jobs = [], estimates = [], now = new Date(), staleDays = DEFAULT_STALE_DAYS, cleanLeadPipeline = true } = {}) {
  // No job in HCP → the import makes it a Lead (customerFields' Status__c rule) → archived,
  // whatever its lead or estimate says. The Service Customers list opens with zero Leads /
  // Opportunities on Monday; "Show archived" and search still find every one of them.
  if (cleanLeadPipeline && jobs.length === 0) return { archived: true, reason: LEAD_RESET_REASON, open: null, leadReset: true };
  if (leads.some(isOpenLead)) return { archived: false, reason: null, open: "lead" };
  if (jobs.some((j) => !j.disposition?.archived)) return { archived: false, reason: null, open: "job" };
  if (estimates.some((e) => !e.disposition?.archived)) return { archived: false, reason: null, open: "estimate" };
  const stamps = [
    ms(c?.updated_at), ms(c?.created_at),
    ...leads.map((l) => ms(l?.lost_at)),
    ...jobs.map((j) => ms(j.job?.updated_at)),
    ...estimates.map((e) => ms(e.est?.updated_at)),
  ].filter(Number.isFinite);
  const last = stamps.length ? Math.max(...stamps) : NaN;
  const cutoff = now.getTime() - staleDays * DAY;
  if (!Number.isFinite(last) || last < cutoff) {
    const what = !leads.length && !jobs.length && !estimates.length ? "no job, estimate or lead in HCP" : "nothing open in HCP";
    return { archived: true, reason: `${what}; last activity ${Number.isFinite(last) ? new Date(last).toISOString().slice(0, 10) : "unknown"}`, open: null };
  }
  return { archived: false, reason: null, open: null };
}

// ---------------------------------------------------------------------------------------
// The lead's pipeline → Service_Stage__c

/** HCP pipeline_status → [Sundial stage, call attempts]. Unknown → New (and reported). */
const PIPELINE = [
  [/^new lead$|^unassigned$|^assigned$/i, "New", 0],
  [/^first contact$/i, "Contact Attempt Made", 1],
  [/^second contact$/i, "Contact Attempt Made", 2],
  [/^third contact$/i, "Contact Attempt Made", 3],
  [/waiting on customer/i, "Waiting on Customer", 0],
  [/waiting on service|waiting on quote|working on/i, "In Progress", 0],
  [/^on hold$/i, "On Hold", 0],
];

/**
 * An OPEN lead's stage. `stages` is the org's Service_Stage__c value list (strings or
 * describe entries) so a stage the org lacks (On Hold) falls back to the nearest one it
 * has, and the gap is reported for Tim to add the value.
 */
export function openLeadStage(l, { stages = null } = {}) {
  const ps = s(l?.pipeline_status);
  const hit = PIPELINE.find(([re]) => re.test(ps));
  let stage = hit ? hit[1] : "New";
  const attempts = hit ? hit[2] : 0;
  const known = !!hit || !ps;
  const has = (v) => !stages || stages.some((x) => (typeof x === "string" ? x : x?.value) === v);
  let fallback = null;
  if (!has(stage)) {
    fallback = stage;
    stage = stage === "On Hold" ? "Waiting on Customer" : "In Progress";
    if (!has(stage)) stage = "New";
  }
  return { stage, attempts, known, missingValue: fallback };
}

/**
 * The outcome of a closed lead: `{ stage, resolution, resolvedAt }`.
 * won → Resolved + Job Created / Estimate Created (what the conversion was);
 * lost → Closed + "Lost" when the org has it, else "Not Interested" (reported as a gap).
 */
export function closedLeadOutcome(l, { resolutions = null, convertedAt = null } = {}) {
  const has = (v) => !resolutions || resolutions.some((x) => (typeof x === "string" ? x : x?.value) === v);
  const conv = Array.isArray(l?.conversions) ? l.conversions : l?.conversions && typeof l.conversions === "object" ? Object.values(l.conversions).flat() : [];
  const won = /won|converted/.test(s(l?.status).toLowerCase()) || conv.length > 0;
  if (s(l?.lost_at) || (!won && /lost|closed|dead/.test(s(l?.status).toLowerCase()))) {
    const resolution = has("Lost") ? "Lost" : "Not Interested";
    return { stage: "Closed", resolution, resolvedAt: day(l?.lost_at) || null, missingValue: resolution === "Lost" ? null : "Lost" };
  }
  if (won) {
    const kinds = conv.map((x) => s(x?.type).toLowerCase());
    const resolution = kinds.includes("job") ? "Job Created" : "Estimate Created";
    return { stage: "Resolved", resolution: has(resolution) ? resolution : "Other", resolvedAt: convertedAt ? day(convertedAt) : null, missingValue: has(resolution) ? null : resolution };
  }
  return null; // open
}

/** The ids a lead says it became (job / estimate), by HCP id. */
export function leadConversions(l) {
  const conv = Array.isArray(l?.conversions) ? l.conversions : l?.conversions && typeof l.conversions === "object" ? Object.values(l.conversions).flat() : [];
  return conv.map((x) => ({ type: s(x?.type).toLowerCase(), id: s(x?.id) })).filter((x) => x.id);
}

/**
 * Which HCP estimate each job came from, by the estimate's OWN id: a job's
 * original_estimate_id / original_estimate_uuids name an option (`est_…`), so the option
 * ids are walked back to their estimate (`csr_…`). Map(estimate id → job).
 */
export function claimedEstimates(jobs, estimates) {
  const byOption = new Map();
  for (const e of estimates || []) {
    byOption.set(s(e.id), s(e.id));
    for (const o of Array.isArray(e.options) ? e.options : []) if (s(o?.id)) byOption.set(s(o.id), s(e.id));
  }
  const claimed = new Map();
  for (const j of jobs || []) {
    const refs = [s(j.original_estimate_id), ...(Array.isArray(j.original_estimate_uuids) ? j.original_estimate_uuids.map(s) : [])].filter(Boolean);
    for (const r of refs) {
      const estId = byOption.get(r);
      if (estId && !claimed.has(estId)) claimed.set(estId, j);
    }
  }
  return claimed;
}
