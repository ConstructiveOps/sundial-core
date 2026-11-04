// lib/saved-reports.js — the saved-report rules (D-089, Reporting R1b; docs/reporting-module.md
// §6.6). PURE: no I/O. lambdas/sundial-reports/saved.js reads and writes public.sundial_reports
// and asks this module every question about who may do what.
//
// THE RULES (Tim, 2026-11-04):
//   VISIBLE   same tenant AND (you own it OR it is shared with the tenant). Anything else is
//             404 RECORD_NOT_FOUND — exactly what a report that does not exist answers, so a
//             private report's existence is never confirmed to anyone but its owner.
//             reports.read (tenant scope) is checked before any of this.
//   CREATE    reports.write (every tenant level).
//   EDIT / DELETE   your own: reports.write. A report shared with the tenant that someone else
//             owns: reports.share (Admin / Executive). Visible but not yours to change → 403
//             REPORT_READ_ONLY. (Anyone's PRIVATE report is R2's reports.admin — not here.)
//   SHARING   setting 'tenant' needs reports.share, owner or not. The owner may always set
//             their own report back to 'private'.
//   STORED    the definition as the saver can see it: a column the saver's gates strip is
//             removed before it is stored (never saved, so never resurrected for someone
//             else), and it must be a valid on-screen definition. Whoever RUNS it gets it
//             re-validated with THEIR gates.

import { normalizeDefinition } from "./report-def.js";

export const MAX_NAME = 120;
export const MAX_DESCRIPTION = 2000;
export const SHARING = Object.freeze(["private", "tenant"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INPUT_KEYS = new Set(["name", "description", "definition", "sharing"]);

export const isUuid = (v) => typeof v === "string" && UUID.test(v);

/** May this caller see this row? (`me` = { tenantId, profileId }) */
export function canSee(row, me) {
  return !!row && row.client_sf_id === me.tenantId && (row.owner_profile_id === me.profileId || row.sharing === "tenant");
}

/** May this caller edit / delete this (visible) row? */
export function canEdit(row, me, { canWrite, canShare }) {
  if (!canSee(row, me)) return false;
  if (row.owner_profile_id === me.profileId) return canWrite;
  return row.sharing === "tenant" && canShare;
}

/** The row as the API returns it (never the tenant id). */
export function present(row, me, perms) {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? null,
    type: row.definition?.type ?? null,
    definition: row.definition,
    sharing: row.sharing,
    mine: row.owner_profile_id === me.profileId,
    canEdit: canEdit(row, me, perms),
    ownerProfileId: row.owner_profile_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Remove every reference to a stripped field (and to an aggregate built from one) from a
 * definition, so what is stored is what the saver could see.
 */
export function stripDefinition(def, stripped) {
  if (!stripped?.length) return def;
  const gone = new Set(stripped);
  const goneAggs = new Set();
  for (const a of def.aggregates ?? []) {
    if (a && gone.has(a.field)) goneAggs.add(`${a.fn}_${String(a.field).replace(".", "_")}`);
  }
  const out = { ...def };
  if (Array.isArray(def.columns)) out.columns = def.columns.filter((c) => !gone.has(c));
  if (Array.isArray(def.groupBy)) out.groupBy = def.groupBy.filter((c) => !gone.has(c));
  if (Array.isArray(def.filters)) out.filters = def.filters.filter((f) => !gone.has(f?.field));
  if (Array.isArray(def.aggregates)) out.aggregates = def.aggregates.filter((a) => !gone.has(a?.field));
  if (Array.isArray(def.sort)) out.sort = def.sort.filter((s) => !gone.has(s?.field) && !goneAggs.has(s?.field));
  return out;
}

const bad = (code, field, message) => ({ ok: false, status: 400, body: { error: "invalid_report", code, field, message } });

/**
 * Validate a POST (creating) or PATCH body. Returns { ok:true, value } with only the keys
 * given (PATCH) or all of them with defaults (POST), the definition already stripped and
 * normalized-checked; or the 400.
 */
export function validateInput(body, { creating, heldGates, now }) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return bad("BAD_DEFINITION", "", "Send a JSON object.");
  for (const k of Object.keys(body)) {
    if (!INPUT_KEYS.has(k)) return bad("BAD_DEFINITION", k, `${k}: not a saved-report field (name, description, definition, sharing).`);
  }
  const value = {};
  if (creating || "name" in body) {
    if (typeof body.name !== "string" || body.name.trim().length < 1 || body.name.trim().length > MAX_NAME) {
      return bad("BAD_NAME", "name", `name: 1–${MAX_NAME} characters.`);
    }
    value.name = body.name.trim();
  }
  if (creating || "description" in body) {
    const d = body.description ?? null;
    if (d !== null && (typeof d !== "string" || d.length > MAX_DESCRIPTION)) return bad("BAD_DESCRIPTION", "description", `description: at most ${MAX_DESCRIPTION} characters.`);
    value.description = d === null || d.trim() === "" ? null : d;
  }
  if (creating || "sharing" in body) {
    const s = body.sharing ?? "private";
    if (!SHARING.includes(s)) return bad("BAD_SHARING", "sharing", "sharing: private or tenant.");
    value.sharing = s;
  }
  if (creating || "definition" in body) {
    const n = normalizeDefinition(body.definition, { heldGates, now });
    if (!n.ok) return { ...n, body: { ...n.body, field: n.body.field ? `definition.${n.body.field}` : "definition" } };
    value.definition = stripDefinition(body.definition, n.stripped);
    value.stripped = n.stripped;
  }
  return { ok: true, value };
}

/**
 * The sharing rule for a create / edit: null when allowed, else the 403 body.
 * `row` is the existing row (null when creating).
 */
export function sharingDenied(nextSharing, row, me, { canShare }) {
  if (nextSharing === undefined) return null;
  if (nextSharing === "tenant" && row?.sharing !== "tenant" && !canShare) {
    return { error: "forbidden", code: "SHARE_FORBIDDEN", message: "Only an Admin or an Executive can share a report with everyone." };
  }
  return null;
}
