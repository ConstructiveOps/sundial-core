// IDENTITY — what a record is CALLED, per object. ONE list, every surface.
// D-064, docs/access-model.md §4.2, §4.3.
//
// ---------------------------------------------------------------------------
// THE RULE
// ---------------------------------------------------------------------------
//   The identity of a record a role is entitled to SEE is a `read` field by definition.
//
// A row you may have but cannot name is not a narrower answer, it is a broken one. The
// access model decides WHICH rows a role sees (`rowFilter`); it was never meant to decide
// whether those rows arrive legible. Withholding the name protects nothing — the caller
// already holds the record, its address, its stage and its id.
//
// ---------------------------------------------------------------------------
// WHY THIS FILE EXISTS RATHER THAN A CONST PER SURFACE
// ---------------------------------------------------------------------------
// The rule was first written for LIST rows only, as `IDENTITY_LIST_COLUMNS` inside
// `scripts/generate-field-configs.mjs`, after board cards and the list "Project" column
// came back blank for every sales role on 2026-09-01. `Sundial_Solar__c.Project_Name__c`
// has NO ROW in `docs/Sundial_Solar_Fields_by_Section.xlsx`, so the generator — which
// emits a field only if the workbook has a row for it — never put it in `read`. It was
// never hidden by anyone; it fell through the gap between the sheet and the schema.
//
// That fix repaired the list and nothing else, because it was expressed in CACHE COLUMNS
// and lists are the only surface that speaks cache columns. The DETAIL read speaks
// Salesforce field names and builds its SELECT from `roles[role].read` — which still had
// no `Project_Name__c` — so the detail header kept rendering `—` for every sales role
// (reported from live dealer usage, 2026-09-15).
//
// Two spellings of one rule, in two files, is how the second surface got missed. So the
// rule now lives HERE, once, carrying BOTH spellings of every identity element, and both
// surfaces read it:
//
//   • lists   — `scripts/generate-field-configs.mjs` unions `column` into `listColumns`
//   • detail  — `fieldsFor()` in ./index.js unions `field` into the role's `read` set,
//               which is what `selectListFor()` turns into the `?full=true` SELECT
//   • gate    — `scripts/verify-field-manifest-live.mjs` asserts both, live
//
// A new object cannot be legible on one surface and blank on the other, because there is
// no longer anywhere to add it to only one.
//
// ---------------------------------------------------------------------------
// DELIBERATELY SHORT — AND `column` IS NOT DERIVED FROM `field`
// ---------------------------------------------------------------------------
// Anything with a SHEET ROW belongs in the SHEET. `Customer_Name_at_Creation__c` had one
// marked `hidden` and was fixed by editing row 65 to `read` — NOT by adding it here. Add
// to this list only when a column NAMES the record and there is no sheet row that could
// carry the decision.
//
// The cache column is written out rather than computed by `sfFieldToColumn()`, for the
// same reason that function is duplicated between cache-sync, sf-query and the generator:
// a rename that breaks the mapping must fail VISIBLY (the live gate stops finding the
// column) rather than quietly produce a filter over a column of nulls.

/**
 * @typedef {{ field: string, column: string }} IdentityElement
 *   field  — the Salesforce API name, for the `?full=true` detail SELECT
 *   column — the Supabase cache column, for list/search rows
 */

/**
 * Per object key. The ARRAY IS ANY-OF for assertions and ALL-OF for grants:
 * one populated element is enough to render a name (so a gate that required all three
 * would fail on a correct manifest), but every element is granted, because choosing
 * which one the client falls back to is the client's business, not the server's.
 */
export const IDENTITY = Object.freeze({
  // Customer renders first+last, falling back to `Name` (salesCustomerName in
  // harmon-crm src/components/sales/helpers.ts, and the same chain in
  // CustomerDetailPage.tsx). All three already have sheet rows marked `edit`, so
  // listing them here is a NO-OP TODAY on both surfaces — checked, not assumed.
  // It is here anyway so the rule is stated in one place for every object rather
  // than being true of customer only by luck.
  customer: Object.freeze([
    Object.freeze({ field: "First_Name__c", column: "first_name" }),
    Object.freeze({ field: "Last_Name__c", column: "last_name" }),
    Object.freeze({ field: "Name", column: "name" }),
  ]),
  // Board card titles, the list "Project" column, and the detail page <h1>.
  // No sheet row on either project object — this list is the only thing granting them.
  solar: Object.freeze([Object.freeze({ field: "Project_Name__c", column: "project_name" })]),
  // Roofing is denied to both sales scopes today (§3.1), so nothing here grants anything
  // yet: the module gate 404s the detail read before `fieldsFor()` is consulted. It is
  // listed so that the day roofing opens, it opens LEGIBLE — the same reason its
  // all-hidden manifest exists at all.
  roofing: Object.freeze([Object.freeze({ field: "Project_Name__c", column: "project_name" })]),
});

/** The Salesforce field names that name a record of this object. Never null. */
export function identityFields(objectKey) {
  return (IDENTITY[objectKey] ?? []).map((e) => e.field);
}

/** The cache column names that name a record of this object. Never null. */
export function identityColumns(objectKey) {
  return (IDENTITY[objectKey] ?? []).map((e) => e.column);
}
