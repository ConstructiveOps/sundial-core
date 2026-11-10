// lib/report-assist-schema.js — the report assistant's tools (D-092, R4). PURE.
//
// The model proposes a report through ONE tool, propose_report, whose input schema is
// GENERATED from lib/report-def.js's rules for one report type and one caller's gates:
//   - every field is an enum of that type's "<alias>.<column>" names, so a field that does not
//     exist — or that this caller's gates hide — cannot be written at all;
//   - a filter is one of a handful of branches, one per field family × operator group
//     (text / reference / number / date / boolean), so an operator a field does not allow,
//     or a value of the wrong shape, cannot be written either;
//   - groupBy is a field or { field, dateTrunc } on a date field (DATE_TRUNCS);
//   - an aggregate is count, or sum / avg of a number, or min / max of a number or date.
// What the schema cannot say (one group level, the 50 / 10 / 5 limits, sort naming a shown
// column) is in the descriptions and, like everything, re-checked by normalizeDefinition —
// the server's validation is authoritative; the schema only makes most mistakes impossible.
//
// No numeric / length keywords (minimum, maxItems …): strict tool use may refuse them, and the
// limits are enforced by the validator anyway. All object properties are required and closed
// (additionalProperties: false) — what strict mode needs.

import { CATALOG } from "./report-catalog/index.js";
import { reportType, aliasesOf, fieldsOf, REPORT_TYPES } from "./report-types.js";
import { OPERATORS, DATE_TRUNCS, RELATIVE_TOKENS, LAST_N_DAYS_FORM, MAX_ROWS } from "./report-def.js";

export const PROPOSE_TOOL = "propose_report";
export const ASK_TOOL = "ask_question";
export const CHOOSE_TYPE_TOOL = "choose_type";

const FAMILY_OF = {
  text: "text", picklist: "text", multipicklist: "text",
  reference: "reference", number: "number", date: "date", datetime: "date", boolean: "boolean",
};

/**
 * The fields of a report type this caller may use: { ref, entry, alias }. Non-reportable and
 * gated-without-the-gate fields are absent — for this caller they do not exist.
 */
export function visibleFields(typeKey, heldGates = [], catalog = CATALOG) {
  const t = reportType(typeKey);
  if (!t) throw new Error(`unknown report type ${typeKey}`);
  const held = new Set(heldGates);
  const out = [];
  for (const [alias] of aliasesOf(t)) {
    for (const entry of fieldsOf(t, alias, catalog)) {
      if (!entry.reportable) continue;
      if (entry.gate && !held.has(entry.gate)) continue;
      out.push({ ref: `${alias}.${entry.column}`, alias, entry });
    }
  }
  return out;
}

const str = (description) => ({ type: "string", ...(description ? { description } : {}) });
const enumOf = (values, description) => ({ type: "string", enum: values, ...(description ? { description } : {}) });
const obj = (properties, description) => ({
  type: "object",
  ...(description ? { description } : {}),
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
const nullValue = { type: "null", description: "No value for this operator." };

const DATE_VALUE = `A date "YYYY-MM-DD", or a relative period: ${RELATIVE_TOKENS.join(", ")}, ${LAST_N_DAYS_FORM}.`;

// Each field list is defined ONCE under $defs and referenced: a type's field names would
// otherwise repeat in every branch (solar: ~42k tokens of schema instead of ~20k).
const ref = (name) => ({ $ref: `#/$defs/${name}` });

/** The field lists by family (filterable: long text included). */
function familyLists(fields) {
  const by = { text: [], reference: [], number: [], date: [], boolean: [] };
  for (const f of fields) by[FAMILY_OF[f.entry.type]]?.push(f.ref);
  return by;
}

/** The filter branches, one per family × operator group (fields by $ref). */
function filterBranches(by) {
  const has = (op, family) => OPERATORS[family].includes(op);
  const branch = (family, ops, value, description) => {
    const allowed = ops.filter((op) => has(op, family));
    return allowed.length && by[family].length ? [obj({ field: ref(`${family}Fields`), op: enumOf(allowed), value }, description)] : [];
  };
  return [
    ...branch("text", ["eq", "neq", "contains", "starts_with"], str("The text to match. contains / starts_with ignore case."), "A text or picklist field compared with one value."),
    ...branch("text", ["in", "not_in"], { type: "array", items: str() }, "A text or picklist field: any of these values (not_in keeps blank rows)."),
    ...branch("text", ["is_blank", "not_blank"], nullValue),
    ...branch("reference", ["eq", "neq"], str("A record id.")),
    ...branch("reference", ["in", "not_in"], { type: "array", items: str() }),
    ...branch("reference", ["is_blank", "not_blank"], nullValue, "A lookup that is empty / set (e.g. no dealer)."),
    ...branch("number", ["eq", "neq", "gt", "gte", "lt", "lte"], { type: "number" }),
    ...branch("number", ["between"], { type: "array", items: { type: "number" }, description: "[from, to], inclusive." }),
    ...branch("number", ["is_blank"], nullValue),
    ...branch("date", ["eq", "between"], {
      anyOf: [str(DATE_VALUE), { type: "array", items: str(), description: "[from, to] dates, inclusive." }],
    }, "A date field in a day or a period. Prefer a relative period token."),
    ...branch("date", ["before", "after"], str("A date \"YYYY-MM-DD\".")),
    ...branch("date", ["is_blank"], nullValue),
    ...branch("boolean", ["eq"], { type: "boolean" }),
    ...branch("boolean", ["is_blank"], nullValue),
  ];
}

/**
 * propose_report for one type and one caller. `strict` is set by the caller of the API
 * (lib/report-assist.js), which falls back to non-strict if the API refuses the schema.
 */
export function proposeTool(typeKey, heldGates = [], catalog = CATALOG) {
  const fields = visibleFields(typeKey, heldGates, catalog);
  const selectable = fields.filter((f) => !f.entry.longText).map((f) => f.ref);
  const by = familyLists(fields);
  // Number and date fields are never long text, so the family lists double as the aggregate
  // and the group-by-period lists.
  const $defs = { columnFields: enumOf(selectable) };
  for (const [family, refs] of Object.entries(by)) if (refs.length) $defs[`${family}Fields`] = enumOf(refs);

  const groupItems = [ref("columnFields")];
  if (by.date.length) groupItems.push(obj({ field: ref("dateFields"), dateTrunc: enumOf([...DATE_TRUNCS]) }, "Group a date by period (weeks start Monday)."));
  const aggItems = [obj({ fn: enumOf(["count"]) }, "Count the rows (of each group).")];
  if (by.number.length) aggItems.push(obj({ fn: enumOf(["sum", "avg"]), field: ref("numberFields") }));
  const ordered = [by.number.length ? ref("numberFields") : null, by.date.length ? ref("dateFields") : null].filter(Boolean);
  if (ordered.length) aggItems.push(obj({ fn: enumOf(["min", "max"]), field: ordered.length === 1 ? ordered[0] : { anyOf: ordered } }));

  const schema = obj({
      summary: str("One or two plain sentences, for an office user, describing the report exactly as proposed: which records, the filters and periods, the grouping and the sort. No field names in alias.column form."),
      type: enumOf([typeKey]),
      columns: {
        type: "array", items: ref("columnFields"),
        description: "The columns of an UNGROUPED report, in order (at most 50). Leave EMPTY when grouping: a grouped report shows its group and its aggregates.",
      },
      filters: { type: "array", items: { anyOf: filterBranches(by) }, description: "All must match (AND). At most 50." },
      groupBy: { type: "array", items: { anyOf: groupItems }, description: "EMPTY, or exactly ONE entry: only one group level exists." },
      aggregates: { type: "array", items: { anyOf: aggItems }, description: "Totals. With a group: per group. Without: grand totals. At most 10." },
      sort: {
        type: "array",
        items: obj({
          field: str("A shown column \"alias.column\" (ungrouped), or when grouped the group field or an aggregate name: \"count\", or \"<fn>_<alias>_<column>\" such as \"sum_solar_contract_amount\"."),
          dir: enumOf(["asc", "desc"]),
        }),
        description: "At most 5.",
      },
      limit: { type: "integer", description: `How many rows to show, 1 to ${MAX_ROWS}. Use ${MAX_ROWS} unless the user asks for a top N.` },
  });
  return {
    name: PROPOSE_TOOL,
    description:
      "Propose the report. Call this when the request is clear enough to build. The server validates it; "
      + "if it is refused you will be told why and may call again once.",
    input_schema: { ...schema, $defs },
  };
}

/** Resolve a "#/$defs/<name>" reference against a tool's input schema (tests, tooling). */
export function resolveRef(rootSchema, node) {
  if (!node?.$ref) return node;
  const name = node.$ref.replace("#/$defs/", "");
  return rootSchema.$defs[name];
}

export const ASK_QUESTION = Object.freeze({
  name: ASK_TOOL,
  description: "Ask the user ONE short question when the request is ambiguous or cannot be built. Never more than one question.",
  input_schema: obj({ question: str("One question, in plain English, ending with a question mark. Offer the choices when there are a few.") }),
});

export function chooseTypeTool() {
  return {
    name: CHOOSE_TYPE_TOOL,
    description: "Pick the report type the request is about. Call this when one type clearly fits; otherwise call ask_question.",
    input_schema: obj({ type: enumOf(Object.keys(REPORT_TYPES)) }),
  };
}

/** A copy of the tools with `strict` set (or removed). Never mutates. */
export function withStrict(tools, strict) {
  return tools.map((t) => {
    const { strict: _drop, ...rest } = t;
    return strict ? { ...rest, strict: true } : rest;
  });
}

/**
 * The tool input → the definition the editor would hold: the summary dropped, empty lists and
 * the default limit left out, a no-value operator's null value left out.
 */
export function definitionFromInput(input) {
  const d = input && typeof input === "object" ? input : {};
  const out = { type: d.type };
  for (const k of ["columns", "filters", "groupBy", "aggregates", "sort"]) {
    if (Array.isArray(d[k]) && d[k].length) out[k] = d[k];
  }
  if (out.filters) {
    out.filters = out.filters.map((f) => (f && typeof f === "object" && f.value === null ? (({ value: _v, ...rest }) => rest)(f) : f));
  }
  if (Number.isInteger(d.limit) && d.limit !== MAX_ROWS) out.limit = d.limit;
  return out;
}
