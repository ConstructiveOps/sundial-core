// lib/file-access.test.js — the one write path for sundial_file_metadata.
import { test } from "node:test";
import assert from "node:assert/strict";
import { registerFileMetadata } from "./file-access.js";

function fakeSupabase() {
  const rows = [];
  return {
    rows,
    from: () => ({ insert: (row) => (rows.push(row), { select: () => ({ maybeSingle: async () => ({ data: { id: "r1" }, error: null }) }) }) }),
  };
}

test("registerFileMetadata: the uploader id is never written (its FK is portal_users, 0 rows) — the row lands with the name", async () => {
  const sb = fakeSupabase();
  // A Salesforce user id ("invalid input syntax for type uuid") and a profile uuid (the foreign key):
  // either one made Postgres refuse the whole row.
  for (const id of ["a1O7y00000sfFC5EAM", "0b6f3c2e-6a1d-4c8e-9f51-2d7a4e0c9b11"]) {
    await registerFileMetadata(sb, { s3Key: `SUNDIAL/a1c/${id}.pdf`, fileName: "x.pdf", tenantId: "a1W", sfRecordId: "a1c", sfObjectType: "job", uploadedByUserId: id, uploadedByUserName: "Paige King" });
  }
  assert.deepEqual(sb.rows.map((r) => r.uploaded_by_user_id), [null, null]);
  assert.deepEqual(sb.rows.map((r) => r.uploaded_by_user_name), ["Paige King", "Paige King"]);
});
