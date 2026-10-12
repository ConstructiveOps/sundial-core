// lib/payroll-adjustments.js — the office's weekly correction to a tech's Time Outside
// Calls (2026-10-12, Harmon; sql/2026-10-12_payroll_adjustments.sql).
//
// Payroll computes Time Outside Calls from the clock logs; this is the one number the
// office may overrule, per tech per week, with a reason. The computed value is kept on the
// row (`computed_minutes`) so the report can show "adjusted from 5.2 h", and clearing the
// row brings the arithmetic back. Service role only — never the browser.
//
// `createPayrollAdjustments({ getSupabaseClient })` → { forWeek, set, clear }; the board's
// tests hand the Lambda an in-memory one with the same shape.

export const TABLE = "sundial_payroll_adjustments";
export const MAX_OUTSIDE_MINUTES = 7 * 24 * 60;
export const MAX_REASON_CHARS = 500;

const s = (v) => (v == null ? "" : String(v).trim());

/** The row as the report shows it. */
export function adjustmentView(row) {
  if (!row) return null;
  return {
    minutes: row.outside_minutes,
    hours: Math.round((row.outside_minutes / 60) * 100) / 100,
    computedMinutes: row.computed_minutes ?? null,
    reason: row.reason ?? "",
    setById: row.set_by_sf_id ?? null,
    setByName: row.set_by_name ?? null,
    setAt: row.set_at ?? null,
  };
}

/**
 * Validate what the office typed. `hours` (decimal, e.g. 3.25) or `minutes`; a reason is
 * required. Returns { ok, minutes, reason } or { ok: false, code, message }.
 */
export function parseAdjustmentInput(body) {
  const reason = s(body?.reason).slice(0, MAX_REASON_CHARS);
  if (!reason) return { ok: false, code: "REASON_REQUIRED", message: "Say why the hours are being changed — it is kept with the number." };
  let minutes = null;
  if (body?.minutes != null && body.minutes !== "") minutes = Number(body.minutes);
  else if (body?.hours != null && body.hours !== "") minutes = Number(body.hours) * 60;
  if (minutes == null || !Number.isFinite(minutes)) return { ok: false, code: "HOURS_INVALID", message: "Enter the hours as a number, like 3.25." };
  minutes = Math.round(minutes);
  if (minutes < 0 || minutes > MAX_OUTSIDE_MINUTES) return { ok: false, code: "HOURS_INVALID", message: "Hours must be between 0 and 168." };
  return { ok: true, minutes, reason };
}

export function createPayrollAdjustments({ getSupabaseClient }) {
  return {
    /** Every adjustment for the tenant's week, keyed by tech id. */
    async forWeek({ tenantId, weekMonday }) {
      const supabase = await getSupabaseClient();
      const { data, error } = await supabase.from(TABLE).select("*").eq("client_sf_id", tenantId).eq("week_monday", weekMonday);
      if (error) throw new Error(`payroll adjustments read failed: ${error.message}`);
      const out = new Map();
      for (const row of data || []) out.set(row.tech_sf_id, row);
      return out;
    },
    /** Set (or replace) the week's number for one tech. Returns the row. */
    async set({ tenantId, techId, weekMonday, minutes, computedMinutes, reason, actor, now }) {
      const supabase = await getSupabaseClient();
      const row = {
        client_sf_id: tenantId,
        tech_sf_id: techId,
        week_monday: weekMonday,
        outside_minutes: minutes,
        computed_minutes: computedMinutes ?? null,
        reason,
        set_by_sf_id: actor?.id ?? null,
        set_by_name: actor?.name ?? null,
        set_at: now ?? new Date().toISOString(),
      };
      const { data, error } = await supabase.from(TABLE).upsert(row, { onConflict: "client_sf_id,tech_sf_id,week_monday" }).select().single();
      if (error) throw new Error(`payroll adjustment write failed: ${error.message}`);
      return data ?? row;
    },
    /** Remove the week's number for one tech (the arithmetic is back). */
    async clear({ tenantId, techId, weekMonday }) {
      const supabase = await getSupabaseClient();
      const { error } = await supabase.from(TABLE).delete().eq("client_sf_id", tenantId).eq("tech_sf_id", techId).eq("week_monday", weekMonday);
      if (error) throw new Error(`payroll adjustment delete failed: ${error.message}`);
      return true;
    },
  };
}

/** The in-memory twin the tests use. */
export function createMemoryPayrollAdjustments(seed = []) {
  const rows = [...seed];
  const key = (r) => `${r.client_sf_id}|${r.tech_sf_id}|${r.week_monday}`;
  return {
    rows,
    async forWeek({ tenantId, weekMonday }) {
      return new Map(rows.filter((r) => r.client_sf_id === tenantId && r.week_monday === weekMonday).map((r) => [r.tech_sf_id, r]));
    },
    async set({ tenantId, techId, weekMonday, minutes, computedMinutes, reason, actor, now }) {
      const row = { client_sf_id: tenantId, tech_sf_id: techId, week_monday: weekMonday, outside_minutes: minutes, computed_minutes: computedMinutes ?? null, reason, set_by_sf_id: actor?.id ?? null, set_by_name: actor?.name ?? null, set_at: now ?? new Date().toISOString() };
      const i = rows.findIndex((r) => key(r) === key(row));
      if (i >= 0) rows[i] = { ...rows[i], ...row };
      else rows.push({ id: rows.length + 1, ...row });
      return i >= 0 ? rows[i] : rows[rows.length - 1];
    },
    async clear({ tenantId, techId, weekMonday }) {
      const i = rows.findIndex((r) => r.client_sf_id === tenantId && r.tech_sf_id === techId && r.week_monday === weekMonday);
      if (i >= 0) rows.splice(i, 1);
      return true;
    },
  };
}
