// lib/file-access.test.js — the one write path for sundial_file_metadata.
import { test } from "node:test";
import assert from "node:assert/strict";
import { registerFileMetadata, isUuidLike } from "./file-access.js";

function fakeSupabase() {
  const rows = [];
  return {
    rows,
    from: () => ({ insert: (row) => (rows.push(row), { select: () => ({ maybeSingle: async () => ({ data: { id: "r1" }, error: null }) }) }) }),
  };
}

test("registerFileMetadata: a non-uuid uploader id (the Salesforce user id) is left off — the row still lands, with the name", async () => {
  const sb = fakeSupabase();
  await registerFileMetadata(sb, { s3Key: "SUNDIAL/a1c/x.pdf", fileName: "x.pdf", tenantId: "a1W", sfRecordId: "a1c", sfObjectType: "job", uploadedByUserId: "a1O7y00000sfFC5EAM", uploadedByUserName: "Paige King" });
  assert.equal(sb.rows[0].uploaded_by_user_id, null);
  assert.equal(sb.rows[0].uploaded_by_user_name, "Paige King");
  await registerFileMetadata(sb, { s3Key: "SUNDIAL/a1c/y.pdf", fileName: "y.pdf", tenantId: "a1W", sfRecordId: "a1c", sfObjectType: "job", uploadedByUserId: "0B6F3C2E-6A1D-4C8E-9F51-2D7A4E0C9B11" });
  assert.equal(sb.rows[1].uploaded_by_user_id, "0B6F3C2E-6A1D-4C8E-9F51-2D7A4E0C9B11");
  assert.equal(isUuidLike(null), false);
  assert.equal(isUuidLike("uuid-paige-king"), false);
});
