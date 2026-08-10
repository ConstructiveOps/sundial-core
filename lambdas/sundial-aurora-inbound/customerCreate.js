// Auto-create a Sundial_Customer__c from an Aurora project (dealer origination).
//
// WHY: Harmon works with third-party dealers who originate deals entirely inside
// Aurora, in Harmon's own tenant. Their agreement events reach our webhook, but no
// Sundial_Customer__c exists — the design request that normally creates the Aurora
// project never happened. A SIGNED agreement from one of those is a real sale, so
// the worker builds the customer from Aurora's data instead of dead-lettering.
// Non-signed dealer events create nothing (D-049).
//
// Everything here is describe-guarded and best-effort about OPTIONAL values: a
// missing email, phone, address component, or picklist match must never fail the
// creation of a customer who has just signed a contract. Anything retrieved but not
// mappable is written to the import-notes field rather than dropped.
//
// Field surface verified against Aurora's public Retrieve Project reference
// (2026-08-07) — see lib/aurora.js » getProject and
// docs/integrations/aurora-api-reference.md.

import { sfQuery, soqlEscapeString, sfUpsertRecord } from "../../lib/salesforce.js";
import { AuroraError, listPartners, getUser } from "../../lib/aurora.js";

export const CUSTOMER_SF_OBJECT = "Sundial_Customer__c";
export const EXTERNAL_ID_FIELD = "Aurora_Project_ID__c";

// New fields for this feature; neither exists yet (describe 2026-08-07).
export const F_DEALER_NAME = "Aurora_Dealer_Name__c";
export const F_IMPORT_NOTES = "Aurora_Import_Notes__c";

// The Lead_Source__c value that marks a dealer-originated import. The org's
// picklist does NOT contain it today (it has ~200 partner-specific values but no
// generic Aurora one), so the field is skipped with a warning until Tim adds it.
export const DEALER_LEAD_SOURCE = "Aurora - Third-Party Dealer";

// Where a dealer-originated signed deal lands in the pipeline (Tim's call,
// 2026-08-07). Both values are present in the org today (verified by describe), but
// they go through the same match-or-skip guard as every other picklist: a value that
// disappears from the org must degrade to a warning, never fail the import of a
// signed contract.
//
// Status__c matters more than it looks: the org default is "Lead", so WITHOUT this
// a closed dealer sale would sit in the CRM as a lead.
export const DEALER_STATUS = "Customer";
export const DEALER_STAGE = "Sold - Pending Review";

// Which tenant these records belong to. Resolved from the tenant SLUG rather than a
// hardcoded Salesforce id: the id is deploy-specific, the slug is the same identity
// used by VITE_TENANT_ID, the S3 prefix, and client-config.ts (D-034). Env var so a
// second tenant is a config change, not a code change.
const TENANT_SLUG = process.env.SUNDIAL_TENANT_SLUG || "harmon";
const TENANT_TTL_MS = 30 * 60 * 1000;
let tenantCache = null; // { id, fetchedAt }

/** Resolve (and cache) the Sundial_Tenant__c record id for this deployment. */
export async function resolveTenantId() {
  if (tenantCache && Date.now() - tenantCache.fetchedAt < TENANT_TTL_MS) {
    return tenantCache.id;
  }
  const rows = await sfQuery(
    `SELECT Id FROM Sundial_Tenant__c WHERE Name = '${soqlEscapeString(TENANT_SLUG)}' LIMIT 1`
  );
  const id = rows?.[0]?.Id ?? null;
  if (!id) {
    throw new Error(
      `No Sundial_Tenant__c named "${TENANT_SLUG}" (SUNDIAL_TENANT_SLUG) — cannot set Client__c on an auto-created customer.`
    );
  }
  tenantCache = { id, fetchedAt: Date.now() };
  return id;
}

/** Test seam / rotation: drop the cached tenant id. */
export function resetTenantCache() {
  tenantCache = null;
}

// --- dealer attribution -----------------------------------------------------

// Aurora's partner list is small and changes rarely; one fetch serves every event
// in a warm container.
const PARTNERS_TTL_MS = 30 * 60 * 1000;
let partnersCache = null; // { list, fetchedAt }

export function resetPartnersCache() {
  partnersCache = null;
}

async function partnerNameFor(partnerId) {
  if (!partnersCache || Date.now() - partnersCache.fetchedAt >= PARTNERS_TTL_MS) {
    partnersCache = { list: await listPartners(), fetchedAt: Date.now() };
  }
  const hit = partnersCache.list.find((p) => p?.id === partnerId);
  return hit?.name ?? null;
}

/**
 * Work out who the dealer is.
 *
 * Preference order, best evidence first:
 *   1. partner_id -> the partner's NAME (Aurora "partner" == external dealer org)
 *   2. owner_id   -> the owning USER's name (a person, not the firm, but useful)
 *   3. whatever raw ids exist
 *
 * NEVER throws and never fails the import: attribution is a nice-to-have, and a
 * 403 on these endpoints (not provisioned for our key) simply degrades to raw ids
 * plus a warning. The ids always land in the import notes either way.
 *
 * @returns {Promise<{ name: string|null, warnings: string[] }>}
 */
export async function resolveDealer(project) {
  const warnings = [];
  const partnerId = cleanStr(project?.partner_id);
  const ownerId = cleanStr(project?.owner_id);

  if (partnerId) {
    try {
      const name = await partnerNameFor(partnerId);
      if (name) return { name, warnings };
      warnings.push(
        `Aurora partner_id ${partnerId} is not in the tenant's partner list — dealer name unresolved.`
      );
    } catch (e) {
      warnings.push(
        e instanceof AuroraError && e.notProvisioned
          ? `Aurora List Partners is NOT PROVISIONED for our API key (403) — dealer attribution unavailable; raw ids kept in the import notes. Contact Aurora's account team.`
          : `Could not list Aurora partners: ${e?.message || e}`
      );
    }
  }

  if (ownerId) {
    try {
      const user = await getUser(ownerId);
      const name = [cleanStr(user?.first_name), cleanStr(user?.last_name)]
        .filter(Boolean)
        .join(" ");
      if (name) return { name, warnings };
    } catch (e) {
      warnings.push(
        e instanceof AuroraError && e.notProvisioned
          ? `Aurora Retrieve User is NOT PROVISIONED for our API key (403) — owner name unavailable.`
          : `Could not retrieve Aurora user ${ownerId}: ${e?.message || e}`
      );
    }
  }

  // Nothing resolvable: fall back to the raw id so the record still points somewhere.
  const raw = partnerId || ownerId || null;
  if (raw) {
    warnings.push(
      `Dealer name could not be resolved; recorded the raw Aurora id "${raw}" instead.`
    );
  }
  return { name: raw, warnings };
}

// --- helpers ----------------------------------------------------------------

function cleanStr(v) {
  return v == null ? "" : String(v).trim();
}

/**
 * Match a value against a picklist case/punctuation-insensitively and return the
 * org's CANONICAL casing (so "IL" writes the org's "Il", and "az" writes "AZ").
 */
export function matchPicklist(value, picklistValues = []) {
  const raw = cleanStr(value);
  if (!raw) return null;
  const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, "");
  const target = norm(raw);
  return picklistValues.find((v) => norm(v) === target) ?? null;
}

/** Build the "key: value" import-notes block. Returns "" when there is nothing to say. */
export function buildImportNotes({ project, agreementId, receivedAt, extras = [] }) {
  const lines = [];
  const add = (k, v) => {
    const s = cleanStr(v);
    if (s) lines.push(`${k}: ${s}`);
  };

  const loc = project?.location || {};
  add("Aurora project id", project?.id);
  add("Aurora project name", project?.name);
  add("Project type", project?.project_type);
  add("Aurora status", project?.status);
  add("Property address (raw)", loc.property_address);
  add("Country", loc.property_address_components?.country);
  add("Latitude", loc.latitude);
  add("Longitude", loc.longitude);
  add("Salutation", project?.customer_salutation);
  add("Mailing address", project?.mailing_address);
  add("Partner id", project?.partner_id);
  add("Owner (user) id", project?.owner_id);
  add("Team id", project?.team_id);
  add("Created in Aurora", project?.created_at);
  if (Array.isArray(project?.tags) && project.tags.length > 0) {
    add("Tags", project.tags.join(", "));
  }
  for (const line of extras) {
    const s = cleanStr(line);
    if (s) lines.push(s);
  }

  if (lines.length === 0) return "";
  const header =
    `Auto-created from Aurora signed agreement ${cleanStr(agreementId) || "(unknown)"} ` +
    `on ${cleanStr(receivedAt) || new Date().toISOString()}`;
  return [header, "", ...lines].join("\n");
}

/**
 * Map an Aurora project onto Sundial_Customer__c fields.
 *
 * @param {object} args
 * @param {object} args.project      - Retrieve Project response
 * @param {string} args.projectId    - the Aurora project id (upsert key)
 * @param {string} args.agreementId
 * @param {string} args.receivedAt
 * @param {string} args.tenantId     - Client__c
 * @param {string|null} args.dealerName
 * @param {object} args.schema       - { has(name), picklistValues(name) }
 * @returns {{ fields: object, warnings: string[] }}
 */
export function buildCustomerFields({
  project,
  projectId,
  agreementId,
  receivedAt,
  tenantId,
  dealerName,
  schema,
}) {
  const warnings = [];
  const noteExtras = [];
  const fields = {};
  const set = (name, value) => {
    if (value === null || value === undefined || value === "") return;
    if (!schema.has(name)) {
      warnings.push(`Salesforce has no field ${name} — value not written.`);
      return;
    }
    fields[name] = value;
  };

  const first = cleanStr(project?.customer_first_name);
  const last = cleanStr(project?.customer_last_name);
  set("First_Name__c", first);
  set("Last_Name__c", last);

  // Name is what a human sees in every list. Fall back through the Aurora project
  // name to a last-resort label so an auto-created record is never anonymous.
  const name =
    [first, last].filter(Boolean).join(" ") ||
    cleanStr(project?.name) ||
    `Aurora Project ${cleanStr(projectId)}`;
  set("Name", name);

  set("Primary_Email__c", cleanStr(project?.customer_email));
  set("Primary_Phone__c", cleanStr(project?.customer_phone));

  // Address components are nested under `location` (verified against the spec).
  const comp = project?.location?.property_address_components || {};
  set("Street__c", cleanStr(comp.street_address));
  set("City__c", cleanStr(comp.city));
  set("Postal_Code__c", cleanStr(comp.postal_code));

  // State is a picklist: write it ONLY on a real match, else keep the raw value in
  // the notes. A junk picklist value would fail the whole insert.
  const region = cleanStr(comp.region);
  if (region) {
    const matched = matchPicklist(region, schema.picklistValues("State__c"));
    if (matched) {
      set("State__c", matched);
    } else {
      warnings.push(
        `Aurora region "${region}" is not in the State__c picklist — left unset; the raw value is in the import notes.`
      );
      noteExtras.push(`State (unmatched, from Aurora region): ${region}`);
    }
  }

  // Lead source marks these as dealer-originated — but only if the org actually has
  // the value; an invalid picklist entry would fail the insert.
  const leadSource = matchPicklist(
    DEALER_LEAD_SOURCE,
    schema.picklistValues("Lead_Source__c")
  );
  if (leadSource) {
    set("Lead_Source__c", leadSource);
  } else {
    warnings.push(
      `Lead_Source__c has no "${DEALER_LEAD_SOURCE}" value in this org — left unset. Add the picklist value (see TASKS.md) to tag dealer-originated deals.`
    );
    noteExtras.push(`Lead source (not in picklist): ${DEALER_LEAD_SOURCE}`);
  }

  set("Active__c", true);
  set("Client__c", tenantId);
  set(F_DEALER_NAME, dealerName);

  // Pipeline position for a dealer-originated signed deal. Same match-or-skip
  // treatment as Lead_Source__c / State__c: an unmatched value is left unset,
  // warned about, and written to the notes rather than risking the whole insert.
  for (const [field, wanted] of [
    ["Status__c", DEALER_STATUS],
    ["Stage__c", DEALER_STAGE],
  ]) {
    if (!schema.has(field)) {
      warnings.push(`Salesforce has no field ${field} — "${wanted}" not written.`);
      noteExtras.push(`${field} (field missing): ${wanted}`);
      continue;
    }
    const matched = matchPicklist(wanted, schema.picklistValues(field));
    if (matched) {
      set(field, matched);
    } else {
      warnings.push(
        `${field} has no "${wanted}" value in this org — left unset. Add the picklist value (see TASKS.md) so dealer-originated deals land in the right place.`
      );
      noteExtras.push(`${field} (not in picklist): ${wanted}`);
    }
  }

  const notes = buildImportNotes({ project, agreementId, receivedAt, extras: noteExtras });
  set(F_IMPORT_NOTES, notes);

  return { fields, warnings };
}

/**
 * Create (or converge on) the customer for an Aurora project.
 *
 * IDEMPOTENT BY CONSTRUCTION: a Salesforce upsert keyed on Aurora_Project_ID__c
 * (flagged External ID, verified 2026-08-07). Duplicate signed deliveries and
 * concurrent workers therefore produce exactly ONE record — no SELECT-then-create
 * race. The external id is passed as the upsert key, never inside the field map.
 *
 * @returns {Promise<{ id: string, created: boolean, warnings: string[], dealerName: string|null }>}
 */
export async function createCustomerFromAuroraProject({
  project,
  projectId,
  agreementId,
  receivedAt,
  schema,
}) {
  const tenantId = await resolveTenantId();
  const dealer = await resolveDealer(project);

  const { fields, warnings } = buildCustomerFields({
    project,
    projectId,
    agreementId,
    receivedAt,
    tenantId,
    dealerName: dealer.name,
    schema,
  });

  const result = await sfUpsertRecord(
    CUSTOMER_SF_OBJECT,
    EXTERNAL_ID_FIELD,
    projectId,
    fields
  );

  return {
    id: result.id,
    created: result.created,
    dealerName: dealer.name,
    warnings: [...dealer.warnings, ...warnings],
  };
}
