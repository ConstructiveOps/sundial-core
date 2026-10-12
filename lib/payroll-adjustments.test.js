// lib/payroll-adjustments.js — the office's weekly Time Outside Calls (2026-10-12).
import { test } from "node:test";
import assert from "node:assert/strict";
import { adjustmentView, createMemoryPayrollAdjustments, createPayrollAdjustments, parseAdjustmentInput, TABLE } from "./payroll-adjustments.js";

test("parseAdjustmentInput: hours or minutes, a reason always, bounds", () => {
  assert.equal(parseAdjustmentInput({ hours: 3.25 }).code, "REASON_REQUIRED");
  assert.deepEqual(parseAdjustmentInput({ hours: "3.25", reason: " Lunch " }), { ok: true, minutes: 195, reason: "Lunch" });
  assert.deepEqual(parseAdjustmentInput({ minutes: 61.4, reason: "x" }), { ok: true, minutes: 61, reason: "x" });
  assert.equal(parseAdjustmentInput({ hours: 0, reason: "none this week" }).minutes, 0);
  assert.equal(parseAdjustmentInput({ hours: "lots", reason: "x" }).code, "HOURS_INVALID");
  assert.equal(parseAdjustmentInput({ hours: -1, reason: "x" }).code, "HOURS_INVALID");
  assert.equal(parseAdjustmentInput({ hours: 200, reason: "x" }).code, "HOURS_INVALID");
  assert.equal(parseAdjustmentInput({ reason: "x" }).code, "HOURS_INVALID");
  assert.equal(parseAdjustmentInput({ hours: 1, reason: "r".repeat(900) }).reason.length, 500);
});

test("adjustmentView: the row as the report shows it", () => {
  assert.equal(adjustmentView(null), null);
  assert.deepEqual(adjustmentView({ outside_minutes: 195, computed_minutes: 312, reason: "Lunch", set_by_sf_id: "U1", set_by_name: "Beth", set_at: "2026-10-12T20:00:00.000Z" }), { minutes: 195, hours: 3.25, computedMinutes: 312, reason: "Lunch", setById: "U1", setByName: "Beth", setAt: "2026-10-12T20:00:00.000Z" });
});

test("the Supabase store: one row per tenant × tech × week, upsert on conflict, delete to clear; the memory twin behaves the same", async () => {
  const ops = [];
  const rows = [];
  const fakeSupabase = {
    from: (table) => {
      assert.equal(table, TABLE);
      return {
        select: () => ({ eq: (c1, v1) => ({ eq: async (c2, v2) => ({ data: rows.filter((r) => r[c1] === v1 && r[c2] === v2), error: null }) }) }),
        upsert: (row, opts) => {
          ops.push(["upsert", opts.onConflict]);
          const i = rows.findIndex((r) => r.client_sf_id === row.client_sf_id && r.tech_sf_id === row.tech_sf_id && r.week_monday === row.week_monday);
          if (i >= 0) rows[i] = { ...rows[i], ...row };
          else rows.push({ id: rows.length + 1, ...row });
          return { select: () => ({ single: async () => ({ data: rows[i >= 0 ? i : rows.length - 1], error: null }) }) };
        },
        delete: () => ({ eq: (c1, v1) => ({ eq: (c2, v2) => ({ eq: async (c3, v3) => { const i = rows.findIndex((r) => r[c1] === v1 && r[c2] === v2 && r[c3] === v3); if (i >= 0) rows.splice(i, 1); ops.push(["delete"]); return { error: null }; } }) }) }),
      };
    },
  };
  for (const store of [createPayrollAdjustments({ getSupabaseClient: async () => fakeSupabase }), createMemoryPayrollAdjustments()]) {
    const base = { tenantId: "T1", techId: "U1", weekMonday: "2026-10-05" };
    assert.equal((await store.forWeek({ tenantId: "T1", weekMonday: "2026-10-05" })).size, 0);
    const a = await store.set({ ...base, minutes: 120, computedMinutes: 200, reason: "first", actor: { id: "A", name: "Beth" }, now: "2026-10-12T20:00:00.000Z" });
    assert.equal(a.outside_minutes, 120);
    const b = await store.set({ ...base, minutes: 90, computedMinutes: 200, reason: "second", actor: { id: "A", name: "Beth" } });
    assert.equal(b.outside_minutes, 90);
    const week = await store.forWeek({ tenantId: "T1", weekMonday: "2026-10-05" });
    assert.equal(week.size, 1, "a second set replaces, never a second row");
    assert.equal(week.get("U1").reason, "second");
    assert.equal((await store.forWeek({ tenantId: "T2", weekMonday: "2026-10-05" })).size, 0, "tenant-bound");
    await store.clear(base);
    assert.equal((await store.forWeek({ tenantId: "T1", weekMonday: "2026-10-05" })).size, 0);
  }
  assert.deepEqual(ops[0], ["upsert", "client_sf_id,tech_sf_id,week_monday"]);
});
