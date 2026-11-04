// node --test lib/saved-reports.test.js
//
// Pinned (D-089): visibility = same tenant AND (owner OR shared); edit / delete = the OWNER
// with reports.write (someone else's report, shared or not, is R2's reports.admin); the owner
// shares with reports.share — every tenant level, Managers included — and can always go back to
// private; the stored definition loses every stripped (gated) reference; input validation
// names the field.

import test from "node:test";
import assert from "node:assert/strict";
import { canSee, canEdit, present, stripDefinition, validateInput, sharingDenied, isUuid } from "./saved-reports.js";

const T = "a1W7y000007AszBEAS";
const ME = { tenantId: T, profileId: "11111111-1111-4111-8111-111111111111" };
const OTHER = "22222222-2222-4222-8222-222222222222";
const row = (over = {}) => ({ id: "33333333-3333-4333-8333-333333333333", client_sf_id: T, owner_profile_id: ME.profileId, sharing: "private", name: "R", definition: { type: "solar" }, ...over });
// reports.write and reports.share are both every tenant level (D-089, 2026-11-04).
const MANAGER = { canWrite: true, canShare: true };
const ADMIN = { canWrite: true, canShare: true };
const NO_SHARE = { canWrite: true, canShare: false }; // the rule itself, should a level ever lack it

test("visibility: mine, or shared with my tenant — never another tenant's", () => {
  assert.equal(canSee(row(), ME), true);
  assert.equal(canSee(row({ owner_profile_id: OTHER }), ME), false, "someone else's private report");
  assert.equal(canSee(row({ owner_profile_id: OTHER, sharing: "tenant" }), ME), true);
  assert.equal(canSee(row({ client_sf_id: "a1Wother", sharing: "tenant" }), ME), false, "another tenant's shared report");
  assert.equal(canSee(row({ client_sf_id: "a1Wother" }), ME), false, "another tenant, even 'mine'");
  assert.equal(canSee(null, ME), false);
});

test("edit / delete: the owner only, at any level — someone else's report is R2's reports.admin", () => {
  assert.equal(canEdit(row(), ME, MANAGER), true);
  assert.equal(canEdit(row({ sharing: "tenant" }), ME, MANAGER), true, "a Manager edits their own shared report");
  assert.equal(canEdit(row(), ME, { canWrite: false, canShare: true }), false);
  assert.equal(canEdit(row({ owner_profile_id: OTHER, sharing: "tenant" }), ME, MANAGER), false, "another's shared report is read-only");
  assert.equal(canEdit(row({ owner_profile_id: OTHER, sharing: "tenant" }), ME, ADMIN), false, "…for an Admin too, until reports.admin");
  assert.equal(canEdit(row({ owner_profile_id: OTHER }), ME, ADMIN), false, "another's private report is not even visible");
});

test("sharing: the owner shares at any tenant level; private is always the owner's to choose", () => {
  assert.equal(sharingDenied("tenant", null, ME, MANAGER), null, "a Manager may share (Tim, 2026-11-04)");
  assert.equal(sharingDenied("tenant", row(), ME, MANAGER), null);
  assert.equal(sharingDenied("tenant", null, ME, ADMIN), null);
  assert.equal(sharingDenied("tenant", null, ME, NO_SHARE).code, "SHARE_FORBIDDEN", "without reports.share the rule still refuses");
  assert.equal(sharingDenied("private", row({ sharing: "tenant" }), ME, MANAGER), null, "an owner Manager can unshare their own");
  assert.equal(sharingDenied("tenant", row({ sharing: "tenant" }), ME, MANAGER), null, "already shared: renaming it is not a new share");
  assert.equal(sharingDenied(undefined, row(), ME, MANAGER), null);
});

test("present: no tenant id; mine / canEdit for the caller", () => {
  const p = present(row({ owner_profile_id: OTHER, sharing: "tenant" }), ME, MANAGER);
  assert.equal(p.mine, false);
  assert.equal(p.canEdit, false);
  assert.equal(p.type, "solar");
  assert.ok(!("client_sf_id" in p));
  assert.doesNotMatch(JSON.stringify(p), new RegExp(T));
});

test("stripDefinition removes every reference to a stripped field", () => {
  const def = {
    type: "estimate_lines",
    columns: ["line.name", "line.unit_labor_cost"],
    filters: [{ field: "line.unit_labor_cost", op: "gt", value: 1 }, { field: "line.kind", op: "eq", value: "Labor" }],
    aggregates: [{ fn: "sum", field: "line.unit_labor_cost" }, { fn: "count" }],
    sort: [{ field: "line.unit_labor_cost" }, { field: "sum_line_unit_labor_cost" }, { field: "line.name" }],
  };
  const s = stripDefinition(def, ["line.unit_labor_cost"]);
  assert.deepEqual(s.columns, ["line.name"]);
  assert.deepEqual(s.filters.map((f) => f.field), ["line.kind"]);
  assert.deepEqual(s.aggregates, [{ fn: "count" }]);
  assert.deepEqual(s.sort, [{ field: "line.name" }]);
  assert.equal(stripDefinition(def, []), def);
});

test("validateInput: create needs name + definition; the stored definition is the saver's visible one", () => {
  const def = { type: "estimate_lines", columns: ["line.name", "line.unit_labor_cost"] };
  const mgr = validateInput({ name: "  Lines  ", definition: def }, { creating: true, heldGates: [] });
  assert.equal(mgr.ok, true);
  assert.equal(mgr.value.name, "Lines");
  assert.equal(mgr.value.sharing, "private");
  assert.equal(mgr.value.description, null);
  assert.deepEqual(mgr.value.definition.columns, ["line.name"]);
  assert.deepEqual(mgr.value.stripped, ["line.unit_labor_cost"]);
  const adm = validateInput({ name: "Lines", definition: def }, { creating: true, heldGates: ["service.costing.read"] });
  assert.deepEqual(adm.value.definition.columns, ["line.name", "line.unit_labor_cost"]);

  const no = (body, code, field, creating = true) => {
    const r = validateInput(body, { creating, heldGates: [] });
    assert.equal(r.ok, false);
    assert.equal(r.status, 400);
    assert.equal(r.body.code, code);
    assert.equal(r.body.field, field);
  };
  no({ definition: def }, "BAD_NAME", "name");
  no({ name: "x".repeat(121), definition: def }, "BAD_NAME", "name");
  no({ name: "R" }, "BAD_DEFINITION", "definition");
  no({ name: "R", definition: { type: "solar", columns: ["solar.nope"] } }, "UNKNOWN_FIELD", "definition.columns[0]");
  no({ name: "R", definition: def, sharing: "public" }, "BAD_SHARING", "sharing");
  no({ name: "R", definition: def, owner_profile_id: OTHER }, "BAD_DEFINITION", "owner_profile_id");
  no({ name: "R", definition: def, description: "x".repeat(2001) }, "BAD_DESCRIPTION", "description");
  no({ name: "" }, "BAD_NAME", "name", false);
  // PATCH: only what is given
  const patch = validateInput({ sharing: "tenant" }, { creating: false, heldGates: [] });
  assert.deepEqual(patch.value, { sharing: "tenant" });
});

test("isUuid", () => {
  assert.equal(isUuid(ME.profileId), true);
  assert.equal(isUuid("run"), false);
  assert.equal(isUuid("33333333-3333-4333-8333-33333333333"), false);
});
