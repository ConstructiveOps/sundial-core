// lib/report-columns.js — the reporting-grade cache plan (D-087, R0;
// docs/reporting-module.md §4). PURE: no Salesforce, no Supabase, no file system.
// scripts/generate-report-columns.mjs gathers the live inputs and calls planTable()
// once per cache table; lib/report-columns.test.js runs the same functions on fixtures.
//
// WHAT IT DECIDES. For one cache table: which Salesforce fields should have a cache
// column (the workbook's rows plus what is already cached, or — for an object with no
// workbook — every field the integration user can read), what each column is called
// (sfFieldToColumn, imported, never restated: the sync and sf-query fill a column by that
// name and nothing else) and what Postgres type it gets (§4.2).
//
// WHAT IT REFUSES (§4.3), and REPORTS rather than guesses:
//   - name_too_long     the column name is over 63 characters (Postgres would truncate
//                       it, and the sync would never match the truncated name);
//   - collision         two Salesforce fields map to one column, or a field maps onto a
//                       control column the sync writes itself (sf_id, created_date...);
//   - not_readable      the field is not in the integration user's describe — Read FLS
//                       missing (or the field is not created yet; a describe cannot tell
//                       the two apart). It becomes a "TIM: grant Read FLS" line;
//   - type_mismatch     the column already exists with another type. Left alone;
//   - unsupported_type  a describe type the map does not name (address, location,
//                       base64, anyType, or anything new) — never a guessed type;
//   - sensitive         a credential (a password, a public page's bearer token) or a value
//                       a cost / payroll gate protects that no CACHE read gates yet (a
//                       tech's pay rate: lib/cost-gate.js covers price-book and line costs
//                       only). A cache column is returned by every cache read of the row;
//                       a report never needs these, so they stay live-only;
//   - formula_not_fresh a NEW formula column the incremental sync could not keep fresh
//                       (TODAY()/NOW(), a $ global, an unresolvable parent — the
//                       lib/formula-parents.js rules). A stale number in a report is a
//                       wrong number, so it gets no column until that is solved.

import { sfFieldToColumn, EXCLUDED_FIELD_TYPES } from "./cache-row.js";

/** Postgres' identifier limit (NAMEDATALEN - 1). */
export const MAX_IDENTIFIER_LENGTH = 63;

/** Salesforce's REST URI limit; sfQuery sends the SOQL as a GET (?q=…). */
export const MAX_SOQL_URI = 16384;

/** §4.2 — Salesforce describe type → Postgres type. A type not here is refused. */
export const TYPE_MAP = Object.freeze({
  string: "text",
  textarea: "text",
  picklist: "text",
  multipicklist: "text",
  phone: "text",
  email: "text",
  url: "text",
  id: "text",
  encryptedstring: "text",
  reference: "text",
  boolean: "boolean",
  int: "integer",
  double: "numeric",
  currency: "numeric",
  percent: "numeric",
  date: "date",
  datetime: "timestamptz",
});

/** The spelling PostgREST's OpenAPI document uses for each type in TYPE_MAP. */
export const OPENAPI_FORMAT = Object.freeze({
  text: "text",
  boolean: "boolean",
  integer: "integer",
  numeric: "numeric",
  date: "date",
  timestamptz: "timestamp with time zone",
});

/**
 * Columns the sync writes from its own context, never from a field of the same name.
 * A Salesforce field that maps onto one of these would be overwritten (or overwrite) —
 * Client__c → client_sf_id is the one intended mapping and is allowed.
 */
export const CONTROL_COLUMNS = Object.freeze([
  "sf_id", "tenant_id", "client_sf_id", "created_date", "last_synced_at", "is_stale", "cache_version",
]);
const CONTROL_SET = new Set(CONTROL_COLUMNS);
const CONTROL_SOURCE = { client_sf_id: "client__c" };

/**
 * Never a cache column (see "sensitive" above). By name, per object, plus any field whose
 * API name ENDS in Password / Secret / Token — the shape every credential field here has.
 * An expiry date beside a token (Public_Token_Expires_At__c) is not itself a credential.
 */
export const SENSITIVE_FIELDS = Object.freeze({
  Sundial_User__c: Object.freeze(["Hourly_Cost_Rate__c"]),
});
const CREDENTIAL_NAME = /(^|_)(password|secret|token)(__c)?$/i;

/** Why a field must never be cached, or null. */
export function sensitiveReason(sfObject, field) {
  if (CREDENTIAL_NAME.test(field.name)) return "a credential (password / bearer token) — live reads only";
  if ((SENSITIVE_FIELDS[sfObject] || []).some((n) => n.toLowerCase() === field.name.toLowerCase())) {
    return "a gated value (pay rate) with no cache-read gate — live reads only";
  }
  return null;
}

/** The Postgres type for a describe field, or null when the map does not name it. */
export function pgTypeFor(field) {
  if (EXCLUDED_FIELD_TYPES.has(field.type)) return null;
  return TYPE_MAP[field.type] ?? null;
}

/** Is a long-text field (textarea over 255) — it stays out of LIST_PROJECTION / lists. */
function isLongText(field) {
  return field.type === "textarea" && Number(field.length) > 255;
}

/**
 * Plan one cache table.
 *
 * @param {object} input
 * @param {string} input.objectKey        e.g. "customer"
 * @param {string} input.sfObject         e.g. "Sundial_Customer__c"
 * @param {string} input.cacheTable       e.g. "sundial_customer_cache"
 * @param {string|null} input.source      where the field list came from (for the report)
 * @param {Array<{apiName:string,label?:string,section?:string,rowNumber?:number}>|null} input.workbookRows
 *        null = no workbook: every readable describe field is a candidate.
 * @param {Array<{name:string,type:string,label?:string,length?:number,calculated?:boolean}>} input.describeFields
 *        the raw describe (the integration user's view — FLS-hidden fields are absent).
 * @param {Set<string>} input.queryableNames  lowercased names getQueryableFields returned.
 * @param {Map<string,string>} input.existingColumns  column → OpenAPI format, the live table.
 * @param {(field:object) => (string|null)} [input.freshnessProblem]
 *        reason a NEW formula column could not be kept fresh by the sync, or null.
 */
export function planTable({
  objectKey, sfObject, cacheTable, source, workbookRows, describeFields, queryableNames,
  existingColumns, freshnessProblem = () => null,
}) {
  const byName = new Map(describeFields.map((f) => [f.name.toLowerCase(), f]));
  const plan = {
    objectKey, sfObject, cacheTable, source,
    add: [],         // { column, pgType, field, label, longText }
    existing: [],    // { column, field }
    skipped: [],     // { field, label, column?, reason, detail }
    fls: [],         // { field, label, section }
    tableMissing: existingColumns.size === 0,
  };

  // Every queryable describe field, by the column it would fill — the collision check
  // looks at the whole object, because buildCacheSelect selects EVERY field whose column
  // exists, whether or not it is on a workbook.
  const fieldsByColumn = new Map();
  for (const f of describeFields) {
    if (!queryableNames.has(f.name.toLowerCase())) continue;
    if (f.name === "Id") continue; // → sf_id, written by the sync itself
    const col = sfFieldToColumn(f);
    if (!fieldsByColumn.has(col)) fieldsByColumn.set(col, []);
    fieldsByColumn.get(col).push(f);
  }

  // Candidates, in a stable order: workbook rows (sheet order) or the describe (its
  // order), then every field whose column already exists.
  const candidates = [];
  const seen = new Set();
  const push = (name, meta = {}) => {
    const key = name.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({ name, ...meta });
  };
  if (workbookRows) {
    for (const r of workbookRows) push(r.apiName, { label: r.label, section: r.section });
  } else {
    for (const f of describeFields) push(f.name);
  }
  for (const [col, fs] of fieldsByColumn) {
    if (existingColumns.has(col)) for (const f of fs) push(f.name);
  }

  for (const c of candidates) {
    const f = byName.get(c.name.toLowerCase());
    const label = f?.label || c.label || "";
    if (!f) {
      plan.fls.push({ field: c.name, label, section: c.section || "" });
      continue;
    }
    if (f.name === "Id") continue;
    const pgType = pgTypeFor(f);
    if (!pgType || !queryableNames.has(f.name.toLowerCase())) {
      plan.skipped.push({ field: f.name, label, reason: "unsupported_type", detail: `describe type "${f.type}" has no column type (§4.2)` });
      continue;
    }
    const column = sfFieldToColumn(f);
    const sensitive = sensitiveReason(sfObject, f);
    if (sensitive && !existingColumns.has(column)) {
      plan.skipped.push({ field: f.name, label, column, reason: "sensitive", detail: sensitive });
      continue;
    }
    if (column.length > MAX_IDENTIFIER_LENGTH) {
      plan.skipped.push({ field: f.name, label, column, reason: "name_too_long", detail: `${column.length} characters; Postgres keeps ${MAX_IDENTIFIER_LENGTH}` });
      continue;
    }
    if (CONTROL_SET.has(column) && CONTROL_SOURCE[column] !== f.name.toLowerCase()) {
      plan.skipped.push({ field: f.name, label, column, reason: "collision", detail: `maps onto the control column "${column}", which the sync writes itself` });
      continue;
    }
    const sharers = (fieldsByColumn.get(column) || []).filter((o) => o.name !== f.name);
    if (sharers.length > 0) {
      const others = sharers.map((o) => o.name).join(", ");
      const detail = existingColumns.has(column)
        ? `"${column}" is also filled by ${others}; the column stays as it is, and the sync writes whichever comes last`
        : `"${column}" would also be filled by ${others}; no column added`;
      plan.skipped.push({ field: f.name, label, column, reason: "collision", detail });
      continue;
    }
    if (existingColumns.has(column)) {
      const have = existingColumns.get(column);
      if (have && have !== OPENAPI_FORMAT[pgType]) {
        plan.skipped.push({ field: f.name, label, column, reason: "type_mismatch", detail: `column is ${have}; the map says ${pgType} (left alone)` });
      } else {
        plan.existing.push({ column, field: f.name });
      }
      continue;
    }
    if (f.calculated) {
      const problem = freshnessProblem(f);
      if (problem) {
        plan.skipped.push({ field: f.name, label, column, reason: "formula_not_fresh", detail: problem });
        continue;
      }
    }
    plan.add.push({ column, pgType, field: f.name, label, longText: isLongText(f) });
  }
  return plan;
}

// --- Rendering ---------------------------------------------------------------
// Both renderers are deterministic (no timestamps, input order only), so a re-run over an
// unchanged state rewrites the files byte for byte — an empty diff.

/** Keep a comment on one line, whatever the label holds. */
function oneLine(s) {
  return String(s ?? "").replace(/\s+/g, " ").trim();
}

export function renderSql(plans) {
  const out = [];
  out.push("-- sql/2026-10-30_report_columns.sql — the reporting-grade cache (D-087, R0).");
  out.push("--");
  out.push("-- GENERATED by scripts/generate-report-columns.mjs — do not edit by hand; re-run the");
  out.push("-- script. One column per Salesforce field on the object's field-design workbook (or,");
  out.push("-- for an object with no workbook, every field the integration user can read), named");
  out.push("-- by lib/cache-row.js sfFieldToColumn so sundial-cache-sync and sundial-sf-query fill");
  out.push("-- it with no code change. Skipped fields and why: docs/reporting-cache-coverage.md.");
  out.push("--");
  out.push("-- Idempotent: `add column if not exists`. Adding a nullable column with no default is");
  out.push("-- a catalog change, not a table rewrite. The new columns stay empty until the full");
  out.push("-- resync (TASKS.md, Reporting R0).");
  let total = 0;
  for (const p of plans) {
    if (p.tableMissing) continue;
    out.push("");
    out.push(`-- ${p.cacheTable} (${p.sfObject}) — ${p.add.length} column(s)`);
    for (const a of p.add) {
      out.push(`alter table public.${p.cacheTable} add column if not exists ${a.column} ${a.pgType}; -- ${a.field} — ${oneLine(a.label)}${a.longText ? " (long text)" : ""}`);
      total++;
    }
  }
  out.push("");
  out.push(`-- ${total} column(s) in all.`);
  return out.join("\n") + "\n";
}

const REASON_TEXT = {
  name_too_long: "name over 63 characters",
  collision: "column collision",
  type_mismatch: "existing column, different type",
  unsupported_type: "no column type",
  formula_not_fresh: "formula the sync cannot keep fresh",
  sensitive: "sensitive — never cached",
};

export function renderCoverage(plans) {
  const out = [];
  out.push("# Reporting cache coverage (D-087, R0)");
  out.push("");
  out.push("> GENERATED by `scripts/generate-report-columns.mjs` — do not edit by hand; re-run the script.");
  out.push("> Design: `docs/reporting-module.md` §4. SQL: `sql/2026-10-30_report_columns.sql`.");
  out.push("");
  out.push("| Table | Source of the field list | Already cached | Added | Skipped | Needs Read FLS | Sync query URI |");
  out.push("|---|---|---:|---:|---:|---:|---:|");
  for (const p of plans) {
    const uri = p.syncUriLength == null ? "—" : `${p.syncUriLength.toLocaleString("en-US")}${p.syncUriLength > MAX_SOQL_URI ? " **OVER**" : ""}`;
    out.push(`| \`${p.cacheTable}\` | ${p.source} | ${p.existing.length} | ${p.add.length} | ${p.skipped.length} | ${p.fls.length} | ${uri} |`);
  }
  out.push("");
  out.push(`*Sync query URI* = the length of the incremental sync's GET once the columns exist (the parent-modstamp`);
  out.push(`OR included). Salesforce refuses a URI over ${MAX_SOQL_URI.toLocaleString("en-US")} bytes; a table marked **OVER** must not get its`);
  out.push("columns until the sync can split its SELECT.");
  const widest = plans.filter((p) => p.syncUriLength != null).sort((a, b) => b.syncUriLength - a.syncUriLength)[0];
  if (widest) {
    // ~35 encoded bytes per field name plus its separator, a fair average for these objects.
    const room = Math.max(0, Math.floor((MAX_SOQL_URI - widest.syncUriLength) / 35));
    out.push(`The widest is \`${widest.cacheTable}\` at ${widest.syncUriLength.toLocaleString("en-US")}: its sync SELECT must be split into two`);
    out.push(`queries before roughly ${room} more fields are cached there. The portal's stale-row refresh (\`sundial-sf-query\``);
    out.push("`refetchByIds`) sizes its `Id IN (…)` list from the same budget (`lib/soql-budget.js`), so it fits at any");
    out.push("SELECT width — that deploy must be live before the SQL runs.");
  }

  const fls = plans.flatMap((p) => p.fls.map((x) => ({ ...x, sfObject: p.sfObject })));
  out.push("");
  out.push("## TIM: grant Read FLS");
  out.push("");
  if (fls.length === 0) {
    out.push("Nothing — every workbook field is readable by the integration user.");
  } else {
    out.push("Setup → Object Manager → *object* → Fields & Relationships → *field* → Set Field-Level Security →");
    out.push("tick **Visible** for the Sundial Integration User's profile (or its permission set). A field that does");
    out.push("not exist in the org at all looks the same from the API — those are planned fields on the workbook;");
    out.push("skip them. Re-run the generator afterwards: each granted field then moves to *Added*.");
    out.push("");
    for (const x of fls) {
      out.push(`- [ ] \`${x.sfObject}.${x.field}\`${x.label ? ` — ${oneLine(x.label)}` : ""}${x.section ? ` (${oneLine(x.section)})` : ""}`);
    }
  }

  for (const p of plans) {
    out.push("");
    out.push(`## \`${p.cacheTable}\` — ${p.sfObject}`);
    out.push("");
    out.push(`Source: ${p.source}.`);
    if (p.tableMissing) {
      out.push("");
      out.push("**The cache table does not exist (or has no columns) — nothing generated for it.**");
      continue;
    }
    out.push("");
    out.push(`**Already cached (${p.existing.length}):** ${p.existing.length ? p.existing.map((e) => `\`${e.column}\``).join(", ") : "none"}`);
    out.push("");
    out.push(`**Added (${p.add.length}):**`);
    if (p.add.length === 0) out.push("none");
    else {
      out.push("");
      out.push("| Column | Type | Salesforce field | Label |");
      out.push("|---|---|---|---|");
      for (const a of p.add) out.push(`| \`${a.column}\` | ${a.pgType} | \`${a.field}\` | ${oneLine(a.label).replace(/\|/g, "\\|")}${a.longText ? " *(long text)*" : ""} |`);
    }
    out.push("");
    out.push(`**Skipped (${p.skipped.length}):**`);
    if (p.skipped.length === 0) out.push("none");
    else {
      out.push("");
      out.push("| Salesforce field | Column | Why | Detail |");
      out.push("|---|---|---|---|");
      for (const s of p.skipped) out.push(`| \`${s.field}\` | ${s.column ? `\`${s.column}\`` : "—"} | ${REASON_TEXT[s.reason]} | ${oneLine(s.detail).replace(/\|/g, "\\|")} |`);
    }
    if (p.fls.length) {
      out.push("");
      out.push(`**Needs Read FLS (${p.fls.length}):** ${p.fls.map((x) => `\`${x.field}\``).join(", ")}`);
    }
  }
  return out.join("\n") + "\n";
}
