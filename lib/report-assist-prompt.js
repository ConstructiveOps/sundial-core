// lib/report-assist-prompt.js — what the report assistant reads (D-092, R4). PURE.
//
// PROMPT CACHING. The API caches a prefix: tools → system → messages, byte for byte. So:
//   - everything here is DETERMINISTIC for (report type, the caller's gates): no clock, no id,
//     no user text. Today's date and the conversation go in the messages, after the cache.
//   - one cached prefix per report type and gate set (≤ 10 × 2), plus one for the type router.
// The catalog block lists ONLY the fields this caller may use (lib/report-assist-schema.js
// visibleFields): a cost column the caller's gates hide is not in the text and not in the
// schema — for them it does not exist.

import { reportType, REPORT_TYPES } from "./report-types.js";
import { OPERATORS, RELATIVE_TOKENS, LAST_N_DAYS_FORM, MAX_ROWS } from "./report-def.js";
import { GLOSSARY } from "./report-glossary.js";
import { visibleFields, PROPOSE_TOOL, ASK_TOOL, CHOOSE_TYPE_TOOL } from "./report-assist-schema.js";

const DESCRIPTION_CHARS = 160;

// One line per report type, for the router and for the rules block. A test pins one per type.
export const TYPE_DESCRIPTIONS = Object.freeze({
  customers: "One row per customer (lead / opportunity / customer hub), with their dealer, sales rep and assignee. Sales pipeline stage, status, lead source, contract fields on the customer.",
  customers_solar: "One row per customer with their NEWEST solar project beside them. Use when the question is about customers but needs project fields.",
  solar: "One row per residential solar project, with its customer, sales rep and dealer. Stages, contract amount and dates, system size, install / PTO milestones, budgets and commissions.",
  roofing: "One row per roofing project, with its customer, dealer, sales rep and project manager.",
  service_jobs: "One row per service job, with its customer, bill-to customer, estimate, newest non-void invoice, payments collected (rolled up per job) and assignee. Job status, service type, created date.",
  service_calls: "One row per service call (one technician on one appointment), with its job, the job's customer and the technician. Scheduled / actual times, duration, status, visit type.",
  estimates: "One row per service estimate, with its customer, job and the user who sold it. Status, totals, approval date.",
  estimate_lines: "One row per line on a service estimate, with the estimate, its customer and the price-book item.",
  invoices_payments: "One row per service invoice, with its job, customer, bill-to customer and the payments applied to it (rolled up per invoice). Status, total, balance, issue date.",
  payments: "One row per payment (deposit, payment, refund), with its invoice, job and the job's customer. Amount, type, method, status, received date.",
});

const RULES = `You are Sundial's report assistant. Sundial is the operations platform of a solar, roofing and service company. You turn what an office user asks for, in plain English, into a report DEFINITION that the report engine runs. You never see the data and never write SQL; the server validates everything you propose with the user's own permissions.

How to answer — every turn ends with exactly ONE tool call:
1. ${PROPOSE_TOOL}: when the request is clear enough to build. Use ONLY fields from the catalog, written exactly as "alias.column". Never invent a field, an alias or a picklist value. A field that is not in the catalog does not exist for this user (some are hidden by permissions): say so in a question instead of substituting another field.
2. ${ASK_TOOL}: when the request is ambiguous — which date, which measure, which of two similar fields, a word the glossary says to ask about, a period that is not given where it matters — ask ONE short question. Do not guess. Do not ask when a sensible reading is obvious; build it and say what you chose in the summary.

Definition rules (the server enforces them):
- Periods: use the relative tokens (${RELATIVE_TOKENS.join(", ")}, ${LAST_N_DAYS_FORM}). The server resolves them in ARIZONA time when the report runs, so a saved report rolls forward. Use typed dates "YYYY-MM-DD" only for a named month or an explicit date. A date/time field filtered on a day means the whole Arizona day.
- Shape: an ungrouped report lists columns. A grouped report has EXACTLY ONE groupBy entry, EMPTY columns, and its aggregates (count, sum / avg of a number, min / max of a number or date). Only one group level exists: "per tech per week" cannot be built — ask which one they want, or build the one level that answers the request and say so.
- Sort only on what the report shows: a column when ungrouped; the group field or an aggregate name ("count", "<fn>_<alias>_<column>") when grouped.
- Operators by field type: text / picklist / multipicklist ${OPERATORS.text.join(", ")}; reference ${OPERATORS.reference.join(", ")}; number ${OPERATORS.number.join(", ")}; date / datetime ${OPERATORS.date.join(", ")}; boolean ${OPERATORS.boolean.join(", ")}. neq and not_in keep blank rows. contains / starts_with ignore case. A multipicklist holds "A;B;C": use contains for one value.
- Long-text fields (marked "long text") can be filtered on, never shown, grouped or sorted.
- Names of people or companies: match with contains on the name field (rep.name contains "Dennis"); you do not know the exact values.
- limit: ${MAX_ROWS} unless the user asks for a top N.
- The summary is for an office user: plain words, no "alias.column" names, and it must describe exactly what you proposed.
- When the user is refining a report open in the editor, change only what they ask for and keep the rest.

The glossary below is the company's meaning of common words. Follow it exactly.

${GLOSSARY}`;

/** The rules + glossary block (shared text; the first system block of every call). */
export function rulesBlock() {
  return RULES;
}

const pickValues = (entry) => (entry.picklistValues ?? []).map((p) => (typeof p === "string" ? p : p.value));
const oneLine = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

/** One catalog line for a field. */
export function fieldLine(f) {
  const e = f.entry;
  const parts = [f.ref, oneLine(e.label), e.format ? `${e.type} (${e.format})` : e.type];
  const values = pickValues(e);
  if (values.length) parts.push(`values: ${values.join("; ")}`);
  if (e.longText) parts.push("long text: filter only");
  if (e.nameField) parts.push("the record's name");
  const d = oneLine(e.description);
  if (d && d.toLowerCase() !== oneLine(e.label).toLowerCase()) parts.push(d.length > DESCRIPTION_CHARS ? `${d.slice(0, DESCRIPTION_CHARS - 1)}…` : d);
  return `- ${parts.join(" | ")}`;
}

const JOIN_WORDS = {
  lookup: "the record it points to",
  left: "the record it points to",
  latest: "the NEWEST one",
  rollup: "totals over all of them (its fields are measures)",
};

/** The catalog block for one report type and one caller (deterministic). */
export function catalogBlock(typeKey, heldGates = []) {
  const t = reportType(typeKey);
  if (!t) throw new Error(`unknown report type ${typeKey}`);
  const fields = visibleFields(typeKey, heldGates);
  const lines = [
    `REPORT TYPE: ${t.key} — ${t.label}`,
    TYPE_DESCRIPTIONS[t.key],
    "",
    "Aliases:",
    `- ${t.base.alias}: ${t.base.label} (one row each)`,
    ...t.joins.map((j) => `- ${j.alias}: ${j.label} — ${JOIN_WORDS[j.kind] ?? j.kind}, joined on ${j.on.left}${j.where ? " (filtered)" : ""}`),
    "",
    "Fields (alias.column | label | type | picklist values | notes):",
  ];
  let alias = null;
  for (const f of fields) {
    if (f.alias !== alias) {
      alias = f.alias;
      lines.push(`# ${alias}`);
    }
    lines.push(fieldLine(f));
  }
  return lines.join("\n");
}

/** The router's block: the report types, one line each (deterministic). */
export function typesBlock() {
  return [
    "REPORT TYPES — pick the one whose rows the user is asking about:",
    ...Object.values(REPORT_TYPES).map((t) => `- ${t.key} (${t.label}): ${TYPE_DESCRIPTIONS[t.key]}`),
    "",
    `Call ${CHOOSE_TYPE_TOOL} with the type, or ${ASK_TOOL} if you cannot tell which one.`,
  ].join("\n");
}

const CACHE = Object.freeze({ type: "ephemeral", ttl: "1h" });

/** The system blocks of a type call: rules + glossary, then the type's catalog (cached). */
export function typeSystem(typeKey, heldGates = []) {
  return [
    { type: "text", text: rulesBlock() },
    { type: "text", text: catalogBlock(typeKey, heldGates), cache_control: CACHE },
  ];
}

/** The system blocks of the router call (cached). */
export function routerSystem() {
  return [
    { type: "text", text: rulesBlock() },
    { type: "text", text: typesBlock(), cache_control: CACHE },
  ];
}

const WEEKDAY = new Intl.DateTimeFormat("en-US", { timeZone: "America/Phoenix", weekday: "long" });

/** The context line put in front of the LAST user message (never in the cached prefix). */
export function contextLine(now, todayYmd) {
  return `(Context: today is ${WEEKDAY.format(now)} ${todayYmd} in Arizona.)`;
}
