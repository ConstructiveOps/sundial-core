// sundial-reports/saved.js — saved reports (D-089, Reporting R1b; docs/reporting-module.md §6.6).
//
//   GET    /reports              mine + shared with my tenant, newest first
//   POST   /reports              { name, description?, definition, sharing? } → 201 the report
//   GET    /reports/{id}         one report
//   PATCH  /reports/{id}         any of name / description / definition / sharing
//   DELETE /reports/{id}         204
//   GET    /reports/{id}/run     run it (re-validated with the CALLER's gates)
//   GET    /reports/{id}/csv     export it (csv.js startExport) → 202 { exportId }
//
// Every rule is lib/saved-reports.js: visible = same tenant AND (owner OR shared); anything
// else 404 RECORD_NOT_FOUND. reports.read was checked by index.js before any of this; writing
// needs reports.write and only the owner may edit / delete (reports.admin is R2); sharing your
// own report with the tenant needs reports.share (every tenant level).
// The owner, created_by and updated_by are the caller's profile id from the verified JWT —
// never a body field (validateInput refuses unknown keys).

import { getSupabaseClient } from "../../lib/supabase.js";
import { jsonResponse } from "../../lib/http.js";
import { DENY } from "../../lib/access.js";
import { canSee, canEdit, present, validateInput, sharingDenied, isUuid } from "../../lib/saved-reports.js";

export const REPORTS_TABLE = "sundial_reports";
export const MAX_LIST = 500;

const notFound = (cors) => jsonResponse(404, cors, { error: "not_found", code: DENY.RECORD_NOT_FOUND });
const forbidden = (cors, code = DENY.ACTION_FORBIDDEN) => jsonResponse(403, cors, { error: "forbidden", code });
const serverError = (cors, what, error) => {
  console.error(`reports saved: ${what} failed:`, error?.message || String(error));
  return jsonResponse(500, cors, { error: "server_error" });
};

/** One row the caller may see, or null (missing, another tenant's, someone else's private). */
export async function loadVisible(supabase, id, me) {
  if (!isUuid(id)) return { row: null };
  const { data, error } = await supabase.from(REPORTS_TABLE).select("*").eq("id", id).eq("client_sf_id", me.tenantId).maybeSingle();
  if (error) return { error };
  return { row: canSee(data, me) ? data : null };
}

export async function listReports({ me, perms, cors }) {
  const supabase = await getSupabaseClient();
  // Two plain reads (mine; shared) rather than an or() string: nothing caller-derived is ever
  // spliced into a PostgREST filter expression.
  const [mine, shared] = await Promise.all([
    supabase.from(REPORTS_TABLE).select("*").eq("client_sf_id", me.tenantId).eq("owner_profile_id", me.profileId).order("created_at", { ascending: false }).limit(MAX_LIST),
    supabase.from(REPORTS_TABLE).select("*").eq("client_sf_id", me.tenantId).eq("sharing", "tenant").order("created_at", { ascending: false }).limit(MAX_LIST),
  ]);
  if (mine.error || shared.error) return serverError(cors, "list", mine.error || shared.error);
  const byId = new Map();
  for (const r of [...(mine.data ?? []), ...(shared.data ?? [])]) if (canSee(r, me)) byId.set(r.id, r);
  const rows = [...byId.values()].sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : a.id < b.id ? -1 : 1)).slice(0, MAX_LIST);
  const names = await ownerNames(supabase, rows.map((r) => r.owner_profile_id));
  // A name is a label, never a reason to fail the list: on a failed lookup it is null (unknown),
  // not "former user" (which would claim the profile is gone).
  if (names.error) console.warn("reports saved: owner names lookup failed:", names.error?.message || String(names.error));
  return jsonResponse(200, cors, {
    reports: rows.map((r) => ({
      ...present(r, me, perms),
      ownerName: names.error ? null : names.byId.get(r.owner_profile_id) || FORMER_USER,
    })),
  });
}

/** Shown as the owner when the owner's profile is gone (or has no name). */
export const FORMER_USER = "former user";

/** profiles.full_name for every distinct owner, in ONE read for the whole list. */
export async function ownerNames(supabase, profileIds) {
  const ids = [...new Set(profileIds.filter(isUuid))];
  const byId = new Map();
  if (!ids.length) return { byId };
  const { data, error } = await supabase.from("profiles").select("id, full_name").in("id", ids);
  if (error) return { error };
  for (const p of data ?? []) if (p.full_name && String(p.full_name).trim()) byId.set(p.id, String(p.full_name).trim());
  return { byId };
}

export async function createReport({ body, me, perms, heldGates, cors }) {
  if (!perms.canWrite) return forbidden(cors);
  const v = validateInput(body, { creating: true, heldGates });
  if (!v.ok) return jsonResponse(v.status, cors, v.body);
  const denied = sharingDenied(v.value.sharing, null, me, perms);
  if (denied) return jsonResponse(403, cors, denied);
  const supabase = await getSupabaseClient();
  const now = new Date().toISOString();
  const { data, error } = await supabase.from(REPORTS_TABLE).insert({
    client_sf_id: me.tenantId,
    owner_profile_id: me.profileId,
    name: v.value.name,
    description: v.value.description,
    definition: v.value.definition,
    sharing: v.value.sharing,
    created_at: now,
    updated_at: now,
    created_by: me.profileId,
    updated_by: me.profileId,
  }).select("*").single();
  if (error) return serverError(cors, "create", error);
  console.log(JSON.stringify({ saved: "create", id: data.id, report: data.definition?.type, sharing: data.sharing }));
  return jsonResponse(201, cors, { ...present(data, me, perms), stripped: v.value.stripped });
}

export async function getReport({ id, me, perms, cors }) {
  const supabase = await getSupabaseClient();
  const { row, error } = await loadVisible(supabase, id, me);
  if (error) return serverError(cors, "read", error);
  if (!row) return notFound(cors);
  return jsonResponse(200, cors, present(row, me, perms));
}

export async function updateReport({ id, body, me, perms, heldGates, cors }) {
  const supabase = await getSupabaseClient();
  const { row, error } = await loadVisible(supabase, id, me);
  if (error) return serverError(cors, "read", error);
  if (!row) return notFound(cors);
  if (!canEdit(row, me, perms)) return forbidden(cors, "REPORT_READ_ONLY");
  const v = validateInput(body, { creating: false, heldGates });
  if (!v.ok) return jsonResponse(v.status, cors, v.body);
  const denied = sharingDenied(v.value.sharing, row, me, perms);
  if (denied) return jsonResponse(403, cors, denied);
  const { stripped, ...patch } = v.value;
  const { data, error: upErr } = await supabase
    .from(REPORTS_TABLE)
    .update({ ...patch, updated_at: new Date().toISOString(), updated_by: me.profileId })
    .eq("id", row.id)
    .eq("client_sf_id", me.tenantId)
    .select("*")
    .single();
  if (upErr) return serverError(cors, "update", upErr);
  console.log(JSON.stringify({ saved: "update", id: row.id, fields: Object.keys(patch), sharing: data.sharing }));
  return jsonResponse(200, cors, { ...present(data, me, perms), stripped: stripped ?? [] });
}

export async function deleteReport({ id, me, perms, cors }) {
  const supabase = await getSupabaseClient();
  const { row, error } = await loadVisible(supabase, id, me);
  if (error) return serverError(cors, "read", error);
  if (!row) return notFound(cors);
  if (!canEdit(row, me, perms)) return forbidden(cors, "REPORT_READ_ONLY");
  const { error: delErr } = await supabase.from(REPORTS_TABLE).delete().eq("id", row.id).eq("client_sf_id", me.tenantId);
  if (delErr) return serverError(cors, "delete", delErr);
  console.log(JSON.stringify({ saved: "delete", id: row.id }));
  return { statusCode: 204, headers: cors, body: "" };
}
