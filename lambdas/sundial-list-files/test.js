// Tests for POST /projects/{customerId}/files/copy-to-solar (sundial-list-files).
//
// Run with:  npm test        (needs --experimental-test-module-mocks)
//
// Salesforce, Supabase, and the S3 client are mocked at the module boundary — no
// network, no AWS, no Salesforce org is touched.

import test from "node:test";
import assert from "node:assert/strict";
import { mock } from "node:test";

const CUSTOMER_ID = "a0AAA0000001ZZZAA2";
const SOLAR_ID = "a0BBB0000002YYYAA2";

const ctx = {
  identity: { tenantId: "a0XharmonTENANT", tenantSlug: "harmon", user: { id: "u1" } },
  customerRows: [], // rows for the customer SELECT
  solarOwned: true, // does the tenant own the linked solar record
  soqlSeen: [],
  s3Objects: [], // { Key, Size }
  copyCalls: [], // { Bucket, Key, CopySource }
  copyFailKeys: new Set(), // source keys whose copy should throw
  metadataRows: [],
  supabaseThrows: false,
};

function resetCtx() {
  ctx.identity = {
    tenantId: "a0XharmonTENANT",
    tenantSlug: "harmon",
    user: { id: "u1" },
  };
  ctx.customerRows = [{ Id: CUSTOMER_ID, Linked_Solar_Project__c: SOLAR_ID }];
  ctx.solarOwned = true;
  ctx.soqlSeen = [];
  ctx.s3Objects = [];
  ctx.copyCalls = [];
  ctx.copyFailKeys = new Set();
  ctx.metadataRows = [];
  ctx.supabaseThrows = false;
}

mock.module("../../lib/identity.js", {
  exports: { resolveIdentity: async () => ctx.identity },
});

mock.module("../../lib/salesforce.js", {
  exports: {
    soqlEscapeString: (v) => String(v).replace(/\\/g, "\\\\").replace(/'/g, "\\'"),
    sfQuery: async (soql) => {
      ctx.soqlSeen.push(soql);
      // The solar tenant-ownership probe (assertTenantOwnsRecord) hits Sundial_Solar__c.
      if (/FROM Sundial_Solar__c/.test(soql)) {
        return ctx.solarOwned ? [{ Id: SOLAR_ID }] : [];
      }
      return ctx.customerRows;
    },
  },
});

mock.module("../../lib/supabase.js", {
  exports: {
    getSupabaseClient: async () => {
      if (ctx.supabaseThrows) throw new Error("supabase down");
      return {
        from: () => ({
          insert: (row) => ({
            select: () => ({
              maybeSingle: async () => {
                ctx.metadataRows.push(row);
                return { data: { id: "meta-1" }, error: null };
              },
            }),
          }),
        }),
      };
    },
  },
});

// Minimal S3 client stand-in: the commands carry their input, so the fake `send`
// dispatches on constructor name.
mock.module("@aws-sdk/client-s3", {
  exports: {
    S3Client: class {
      async send(cmd) {
        if (cmd.__type === "list") {
          return { Contents: ctx.s3Objects, IsTruncated: false };
        }
        if (cmd.__type === "copy") {
          ctx.copyCalls.push(cmd.input);
          const src = decodeURIComponent(cmd.input.CopySource);
          for (const failing of ctx.copyFailKeys) {
            if (src.endsWith(failing)) throw new Error("AccessDenied");
          }
          return {};
        }
        throw new Error("unexpected command");
      }
    },
    ListObjectsV2Command: class {
      constructor(input) {
        this.__type = "list";
        this.input = input;
      }
    },
    CopyObjectCommand: class {
      constructor(input) {
        this.__type = "copy";
        this.input = input;
      }
    },
  },
});

const { handler } = await import("./index.js");

function copyEvent(recordId = CUSTOMER_ID) {
  return {
    requestContext: { http: { method: "POST" } },
    rawPath: `/projects/${recordId}/files/copy-to-solar`,
    pathParameters: { recordId },
    headers: { authorization: "Bearer test.jwt", origin: "http://localhost:5173" },
    body: null,
  };
}

const parse = (res) => JSON.parse(res.body);
const s3File = (recordId, name, size = 100) => ({
  Key: `SUNDIAL/${recordId}/${name}`,
  Size: size,
  LastModified: new Date("2026-08-03T00:00:00Z"),
});

// ============================================================================

test("copies every customer file into the linked solar folder", async () => {
  resetCtx();
  ctx.s3Objects = [
    s3File(CUSTOMER_ID, "contract.pdf", 1024),
    s3File(CUSTOMER_ID, "utility bill (2).pdf", 2048),
    s3File(CUSTOMER_ID, "photos/roof.jpg", 4096),
  ];

  const res = await handler(copyEvent());
  const body = parse(res);

  assert.equal(res.statusCode, 200);
  assert.equal(body.customerId, CUSTOMER_ID);
  assert.equal(body.solarRecordId, SOLAR_ID);
  assert.equal(body.copied, 3);
  assert.equal(body.failedCount, 0);
  assert.deepEqual(body.failed, []);

  // Destination keys preserve the filename AND any nested path.
  assert.deepEqual(
    ctx.copyCalls.map((c) => c.Key).sort(),
    [
      `SUNDIAL/${SOLAR_ID}/contract.pdf`,
      `SUNDIAL/${SOLAR_ID}/photos/roof.jpg`,
      `SUNDIAL/${SOLAR_ID}/utility bill (2).pdf`,
    ].sort()
  );
  // CopySource is URI-encoded per segment (spaces/parens would otherwise break it)
  // while the "/" separators stay literal.
  const encoded = ctx.copyCalls.find((c) => c.Key.endsWith("utility bill (2).pdf"));
  assert.equal(
    encoded.CopySource,
    `sfsolproj/SUNDIAL/${CUSTOMER_ID}/utility%20bill%20(2).pdf`
  );
  assert.equal(encoded.Bucket, "sfsolproj");

  // Metadata rows point at the SOLAR record (best-effort mirror of the S3 copy).
  assert.equal(body.metadataRegistered, 3);
  assert.equal(ctx.metadataRows.length, 3);
  assert.equal(ctx.metadataRows[0].sf_record_id, SOLAR_ID);
  assert.equal(ctx.metadataRows[0].sf_object_type, "Sundial_Solar__c");
  assert.equal(ctx.metadataRows[0].tenant_id, "a0XharmonTENANT");
  assert.equal(ctx.metadataRows[0].category, "Copied from Customer");

  // No solar-prefixed public URLs are handed back.
  assert.ok(!JSON.stringify(body).includes("amazonaws.com"));
});

test("zero files is a success, not an error", async () => {
  resetCtx();
  ctx.s3Objects = [];

  const res = await handler(copyEvent());
  const body = parse(res);
  assert.equal(res.statusCode, 200);
  assert.equal(body.copied, 0);
  assert.deepEqual(body.files, []);
  assert.equal(ctx.copyCalls.length, 0);
  assert.equal(ctx.metadataRows.length, 0);
});

test("folder placeholder keys are skipped", async () => {
  resetCtx();
  ctx.s3Objects = [
    { Key: `SUNDIAL/${CUSTOMER_ID}/`, Size: 0 },
    s3File(CUSTOMER_ID, "real.pdf"),
  ];

  const body = parse(await handler(copyEvent()));
  assert.equal(body.copied, 1);
  assert.equal(ctx.copyCalls.length, 1);
  assert.equal(ctx.copyCalls[0].Key, `SUNDIAL/${SOLAR_ID}/real.pdf`);
});

test("a per-object failure does not abort the batch", async () => {
  resetCtx();
  ctx.s3Objects = [
    s3File(CUSTOMER_ID, "good1.pdf"),
    s3File(CUSTOMER_ID, "bad.pdf"),
    s3File(CUSTOMER_ID, "good2.pdf"),
  ];
  ctx.copyFailKeys.add("bad.pdf");

  const res = await handler(copyEvent());
  const body = parse(res);

  assert.equal(res.statusCode, 200, "partial failure is still a 200 with detail");
  assert.equal(body.copied, 2);
  assert.equal(body.failedCount, 1);
  assert.equal(body.failed[0].fileName, "bad.pdf");
  assert.equal(body.failed[0].error, "AccessDenied");
  assert.deepEqual(
    body.files.map((f) => f.fileName).sort(),
    ["good1.pdf", "good2.pdf"]
  );
  // Only the successful copies are registered.
  assert.equal(body.metadataRegistered, 2);
});

test("no Linked_Solar_Project__c -> 400 NO_LINKED_PROJECT, nothing copied", async () => {
  resetCtx();
  ctx.customerRows = [{ Id: CUSTOMER_ID, Linked_Solar_Project__c: null }];
  ctx.s3Objects = [s3File(CUSTOMER_ID, "contract.pdf")];

  const res = await handler(copyEvent());
  assert.equal(res.statusCode, 400);
  assert.equal(parse(res).code, "NO_LINKED_PROJECT");
  assert.equal(ctx.copyCalls.length, 0);
});

test("missing / cross-tenant customer -> 404, nothing copied", async () => {
  resetCtx();
  ctx.customerRows = []; // tenant-scoped SELECT returns nothing
  ctx.s3Objects = [s3File(CUSTOMER_ID, "contract.pdf")];

  const res = await handler(copyEvent());
  assert.equal(res.statusCode, 404);
  assert.equal(parse(res).code, "RECORD_NOT_FOUND");
  assert.match(ctx.soqlSeen[0], /FROM Sundial_Customer__c/);
  assert.match(ctx.soqlSeen[0], /Client__c = 'a0XharmonTENANT'/);
  assert.equal(ctx.copyCalls.length, 0);
});

test("linked solar project outside the tenant -> refused, nothing copied", async () => {
  resetCtx();
  ctx.solarOwned = false; // bad data: the link points elsewhere
  ctx.s3Objects = [s3File(CUSTOMER_ID, "contract.pdf")];

  const res = await handler(copyEvent());
  assert.equal(res.statusCode, 400);
  assert.equal(parse(res).code, "LINKED_PROJECT_NOT_ACCESSIBLE");
  assert.equal(ctx.copyCalls.length, 0, "must never write into another tenant's folder");
});

test("no tenant on the identity -> 403 before any Salesforce read", async () => {
  resetCtx();
  ctx.identity = { tenantId: null, tenantSlug: null, user: {} };

  const res = await handler(copyEvent());
  assert.equal(res.statusCode, 403);
  assert.equal(parse(res).code, "NO_TENANT");
  assert.equal(ctx.soqlSeen.length, 0);
});

test("bad customer id in the path -> 400 before any Salesforce read", async () => {
  resetCtx();
  const res = await handler(copyEvent("not-an-id"));
  assert.equal(res.statusCode, 400);
  assert.equal(parse(res).code, "INVALID_RECORD_ID");
  assert.equal(ctx.soqlSeen.length, 0);
});

test("re-running is idempotent: same destination keys, no duplicates", async () => {
  resetCtx();
  ctx.s3Objects = [s3File(CUSTOMER_ID, "contract.pdf")];

  const first = parse(await handler(copyEvent()));
  const keysFirst = ctx.copyCalls.map((c) => c.Key);
  ctx.copyCalls = [];
  const second = parse(await handler(copyEvent()));
  const keysSecond = ctx.copyCalls.map((c) => c.Key);

  assert.deepEqual(keysFirst, keysSecond, "same deterministic destination key");
  assert.equal(first.copied, 1);
  assert.equal(second.copied, 1);
});

test("Supabase being down does not fail the copy", async () => {
  resetCtx();
  ctx.supabaseThrows = true;
  ctx.s3Objects = [s3File(CUSTOMER_ID, "contract.pdf")];

  const res = await handler(copyEvent());
  const body = parse(res);
  assert.equal(res.statusCode, 200);
  assert.equal(body.copied, 1, "the bytes are in S3; metadata is best-effort");
  assert.equal(body.metadataRegistered, 0);
});

test("POST to an unrelated path is not treated as a copy", async () => {
  resetCtx();
  const res = await handler({
    requestContext: { http: { method: "POST" } },
    rawPath: "/files/by-record/whatever",
    pathParameters: {},
    headers: { authorization: "Bearer test.jwt" },
  });
  assert.equal(res.statusCode, 404);
  assert.equal(parse(res).code, "ROUTE_NOT_FOUND");
  assert.equal(ctx.copyCalls.length, 0);
});

test("the GET list route still works", async () => {
  resetCtx();
  ctx.s3Objects = [s3File(CUSTOMER_ID, "contract.pdf", 10)];

  const res = await handler({
    requestContext: { http: { method: "GET" } },
    rawPath: `/files/by-record/${CUSTOMER_ID}`,
    pathParameters: { recordId: CUSTOMER_ID },
    queryStringParameters: { object: "customer" },
    headers: { authorization: "Bearer test.jwt" },
  });
  const body = parse(res);
  assert.equal(res.statusCode, 200);
  assert.equal(body.files.length, 1);
  assert.equal(body.files[0].fileName, "contract.pdf");
  assert.ok(body.files[0].publicUrl.startsWith("https://sfsolproj.s3."));
});
