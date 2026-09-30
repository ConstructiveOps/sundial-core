// supabase-phase.js — writes the Supabase-only demo data (service role).
//
// Every table is written so that a second run adds NOTHING:
//   profiles              upsert on id (the auth uuid) — the same row /auth/me writes
//   comments              upsert on id — the ids are derived from the record, not random
//   sundial_sms_messages  upsert on provider_sid ("DEMO-…", cannot collide with Twilio's "SM…")
//   sundial_notifications upsert on (profile_id, dedupe_key), exactly as lib/notify.js does
//   sundial_service_activity  has a database-generated id, so existing rows are read back
//                         and only the missing (record, event, time) rows are inserted
//
// comment_mentions is never touched: an insert there emails the mentioned person.

import { resolveValue } from "./tokens.js";
import { SeedError } from "./writer.js";
import { SUPABASE_TENANT_COLUMN } from "./plan-supabase.js";

export const TABLE_OF = Object.freeze({
  profiles: "profiles",
  comments: "comments",
  activity: "sundial_service_activity",
  sms: "sundial_sms_messages",
  notifications: "sundial_notifications",
});
const CHUNK = 200;

const chunks = (arr, n) => {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
};

/**
 * READ-ONLY: every column the plan wants to write exists on the live table. A table with
 * no rows cannot show its columns, which is reported rather than guessed at.
 */
export async function checkSupabaseColumns(supabase, plan) {
  const errors = [];
  const notes = [];
  for (const [part, table] of Object.entries(TABLE_OF)) {
    const rows = plan.supabase[part] || [];
    if (!rows.length) continue;
    const { data, error } = await supabase.from(table).select("*").limit(1);
    if (error) { errors.push(`Supabase table ${table}: cannot be read (${error.code || error.message})`); continue; }
    if (!data?.length) { notes.push(`Supabase table ${table} is empty — its columns could not be checked.`); continue; }
    const live = new Set(Object.keys(data[0]));
    const wanted = new Set(rows.flatMap((r) => Object.keys(r)));
    if (part === "profiles") wanted.add("updated_at");
    for (const col of wanted) if (!live.has(col)) errors.push(`Supabase table ${table}: no column "${col}"`);
  }
  return { errors, notes };
}

const fail = (table, error) => { throw new SeedError(`Supabase ${table}: ${error.code ? `${error.code} ` : ""}${String(error.message || error).slice(0, 200)}`, "SUPABASE_WRITE"); };
async function resolveRows(rows, resolver) {
  const out = [];
  for (const r of rows) out.push(await resolveValue(r, resolver));
  return out;
}

/**
 * profiles — one row per demo user, keyed on the auth uuid, in the shape sundial-auth-proxy
 * upserts on every login. Done right after the users exist (so comments can be attributed
 * before anyone has logged in) and again in the supabase phase; an upsert is harmless twice.
 */
export async function upsertProfiles({ io, plan, writer, log, counters }) {
  const supabase = await io.getSupabase();
  const rows = (await resolveRows(plan.supabase.profiles, writer.resolver())).map((r) => ({ ...r, updated_at: io.now().toISOString() }));
  const { error } = await supabase.from(TABLE_OF.profiles).upsert(rows, { onConflict: "id" });
  if (error) fail(TABLE_OF.profiles, error);
  counters.supabase[TABLE_OF.profiles] = rows.length;
  log(`  profiles: ${rows.length} upserted`);
}

export async function runSupabasePhase({ io, plan, writer, log, counters }) {
  const supabase = await io.getSupabase();
  const resolver = writer.resolver();
  const count = (table, n) => { counters.supabase[table] = (counters.supabase[table] || 0) + n; };
  await upsertProfiles({ io, plan, writer, log, counters });

  // comments / sms / notifications — "insert unless it is already there".
  const upserts = [
    ["comments", "id"],
    ["sms", "provider_sid"],
    ["notifications", "profile_id,dedupe_key"],
  ];
  for (const [part, onConflict] of upserts) {
    const table = TABLE_OF[part];
    const rows = await resolveRows(plan.supabase[part], resolver);
    let added = 0;
    for (const part2 of chunks(rows, CHUNK)) {
      const { data, error } = await supabase.from(table).upsert(part2, { onConflict, ignoreDuplicates: true }).select("*");
      if (error) fail(table, error);
      added += (data || []).length;
    }
    count(table, added);
    log(`  ${table}: ${added} added (${rows.length - added} already there)`);
  }

  // activity — read what exists, add what is missing.
  {
    const table = TABLE_OF.activity;
    const tenantId = writer.tenantId;
    const rows = await resolveRows(plan.supabase.activity, resolver);
    const have = new Set();
    for (let from = 0; ; from += 1000) {
      const { data, error } = await supabase.from(table).select("record_sf_id,event,at").eq(SUPABASE_TENANT_COLUMN[table], tenantId).range(from, from + 999);
      if (error) fail(table, error);
      for (const r of data || []) have.add(`${r.record_sf_id}|${r.event}|${Date.parse(r.at)}`);
      if (!data || data.length < 1000) break;
    }
    const missing = rows.filter((r) => !have.has(`${r.record_sf_id}|${r.event}|${Date.parse(r.at)}`));
    for (const part of chunks(missing, CHUNK)) {
      const { error } = await supabase.from(table).insert(part);
      if (error) fail(table, error);
    }
    count(table, missing.length);
    log(`  ${table}: ${missing.length} added (${rows.length - missing.length} already there)`);
  }
}

/** The documented cleanup: one delete per table, by the demo tenant's id. Printed, never run. */
export function cleanupStatements(tenantId) {
  return Object.entries(SUPABASE_TENANT_COLUMN).map(([table, column]) => `delete from ${table} where ${column} = '${tenantId}';`);
}
