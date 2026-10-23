// lib/full-read.js — the role-projected FULL read of one record, live from Salesforce.
//
// This is the `?full=true` detail read (sundial-sf-query handleSingleReadFull), moved here
// 2026-10-23 (dealer module step 3) so the dealer shell's customer and solar reads run the
// SAME code path, not a second copy that could drift from it. Two callers, one answer to
// "which fields of this record may this role see".
//
// §4.3 (docs/access-model.md): for a sales role the SELECT carries ONLY the manifest's read
// set. Not "select everything then strip" — data a role may not see should never leave
// Salesforce. projectRecord behind it is belt and braces.
//
// TENANT ISOLATION: Id = :id AND Client__c = :tenantId, always, with tenantId from the
// verified token. `accessClause` (the row filter's SOQL, or null) is ANDed after it; a
// record outside it is 0 rows → the caller's 404.
//
// Value-safety: the record is business fields only; nothing here logs it.

import { sfQuery, soqlEscapeString } from "./salesforce.js";
import { getQueryableFields } from "./sf-describe.js";
import { fieldsFor, selectListFor, projectRecord, editableFor, MANIFEST_VERSION } from "./field-manifest/index.js";

/**
 * Read one record with every field this role may see.
 *
 * @param {object} p
 * @param {string} p.objectKey   the short key the manifest knows (customer | solar | …)
 * @param {string} p.sfObject    the Salesforce object API name
 * @param {string} p.id          the record id (the caller shape-checks it)
 * @param {string} p.tenantId    Client__c from the verified identity
 * @param {object|null} p.access the AccessContext the manifest projects by; null = tenant
 *                               scope / not enforcing (every field, no restriction)
 * @param {string|null} [p.accessClause] the row filter's SOQL fragment, ANDed after the
 *                               tenant clause; null = no row filter
 * @returns {Promise<null | { record, access: { visible, editable, manifestVersion } }>}
 *   null when the record is missing, in another tenant, or outside the row filter — the
 *   caller answers 404 for all three alike.
 */
export async function readFullRecord({ objectKey, sfObject, id, tenantId, access, accessClause = null }) {
  // Every queryable field (compound/base64 already excluded by getQueryableFields).
  const { fields } = await getQueryableFields(sfObject);

  // Returns null for tenant scope, which keeps that query character-for-character.
  const allowed = selectListFor(objectKey, access, fields.map((f) => f.name));
  const selectList = (allowed ?? fields.map((f) => f.name)).join(", ");

  const soql =
    `SELECT ${selectList} FROM ${sfObject} ` +
    `WHERE Id = '${soqlEscapeString(id)}' ` +
    `AND Client__c = '${soqlEscapeString(tenantId)}'` +
    (accessClause ? ` AND ${accessClause}` : "") +
    ` LIMIT 1`;
  const records = await sfQuery(soql);
  if (!records || records.length === 0) return null;

  // Strip the Salesforce `attributes` envelope (object type + internal record URL) so
  // `record` is pure field data.
  const { attributes, ...record } = records[0];
  return {
    record: projectRecord(objectKey, access, record),
    access: renderableFor(objectKey, access),
  };
}

/**
 * §4.3: the RENDERABLE set, stated explicitly rather than left to be inferred.
 *
 * The client used to decide "may I render this field?" by asking whether the key was
 * present on the record. Presence is a property of the PAYLOAD, not a statement of
 * intent: `Id` and `Client__c` are always retained, and anything that later fills in nulls
 * for missing fields would silently turn "hidden" into "visible". Sending the list
 * removes the inference.
 *
 * `visible` is the set the client may RENDER; `editable` the subset it may offer an input
 * for. `null` on either means tenant scope — no restriction.
 */
export function renderableFor(objectKey, access) {
  const visibleSet = fieldsFor(objectKey, access);
  return {
    visible: visibleSet ? [...visibleSet.read].sort() : null,
    editable: editableFor(objectKey, access),
    manifestVersion: MANIFEST_VERSION,
  };
}
