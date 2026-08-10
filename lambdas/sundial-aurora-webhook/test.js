// Tests for the Aurora webhook DOORBELL (sundial-aurora-webhook).
//
// Run with:  npm test        (needs --experimental-test-module-mocks)
//
// The doorbell's whole job is: authenticate, validate minimally, enqueue, ack —
// inside Aurora's 10-second deadline. These tests pin exactly that, including the
// deliberate 5xx on enqueue failure (which is what triggers Aurora's retry ladder).

import test from "node:test";
import assert from "node:assert/strict";
import { mock } from "node:test";

const GOOD_TOKEN = "s3cr3t-webhook-token";

const ctx = {
  apiSecret: { base_url: "https://api.aurorasolar.com/v1", tenant_id: "t", api_key: "k", webhook_token: GOOD_TOKEN },
  dedicatedSecret: null, // sundial/aurora/webhook — usually absent
  dedicatedThrows: true, // secret doesn't exist yet -> getSecret throws
  sent: [], // messages handed to SQS
  sendThrows: null,
};

function resetCtx() {
  ctx.apiSecret = { base_url: "https://api.aurorasolar.com/v1", tenant_id: "t", api_key: "k", webhook_token: GOOD_TOKEN };
  ctx.dedicatedSecret = null;
  ctx.dedicatedThrows = true;
  ctx.sent = [];
  ctx.sendThrows = null;
  process.env.AURORA_INBOUND_QUEUE_URL =
    "https://sqs.us-west-1.amazonaws.com/891377232720/sundial-aurora-inbound";
}

mock.module("../../lib/secrets.js", {
  exports: {
    getSecret: async (name) => {
      if (name === "sundial/aurora/webhook") {
        if (ctx.dedicatedThrows) throw new Error("ResourceNotFoundException");
        return ctx.dedicatedSecret;
      }
      return ctx.apiSecret;
    },
  },
});

mock.module("../../lib/sqs.js", {
  exports: {
    sendMessage: async (queueUrl, body) => {
      if (ctx.sendThrows) throw new Error(ctx.sendThrows);
      ctx.sent.push({ queueUrl, body });
      return { messageId: "msg-1" };
    },
    parseSqsRecords: () => [],
  },
});

const { handler } = await import("./index.js");

const parse = (res) => JSON.parse(res.body);

function webhookEvent(params = {}, token = GOOD_TOKEN) {
  return {
    requestContext: { http: { method: "GET" } },
    rawPath: "/webhooks/aurora/agreement-status",
    headers: token === null ? {} : { "X-Aurora-Webhook-Token": token },
    queryStringParameters: {
      project_id: "aurora-project-1",
      design_id: "design-1",
      agreement_id: "agreement-1",
      financing_id: "financing-1",
      status: "signed",
      ...params,
    },
  };
}

// ============================================================================

test("valid token -> 200 and the event is enqueued with all five attributes", async () => {
  resetCtx();
  const res = await handler(webhookEvent());
  const body = parse(res);

  assert.equal(res.statusCode, 200);
  assert.equal(body.received, true);
  assert.equal(body.queued, true);

  assert.equal(ctx.sent.length, 1);
  const msg = ctx.sent[0].body;
  assert.equal(msg.project_id, "aurora-project-1");
  assert.equal(msg.design_id, "design-1");
  assert.equal(msg.agreement_id, "agreement-1");
  assert.equal(msg.financing_id, "financing-1");
  assert.equal(msg.status, "signed");
  // Receipt time is stamped at the edge — it is the only signing timestamp we get.
  assert.match(msg.received_at, /^\d{4}-\d{2}-\d{2}T/);
});

test("bad token -> 401, nothing enqueued", async () => {
  resetCtx();
  const res = await handler(webhookEvent({}, "wrong-token"));
  assert.equal(res.statusCode, 401);
  assert.equal(parse(res).error, "unauthorized");
  assert.equal(ctx.sent.length, 0);
});

test("missing token header -> 401, nothing enqueued", async () => {
  resetCtx();
  const res = await handler(webhookEvent({}, null));
  assert.equal(res.statusCode, 401);
  assert.equal(ctx.sent.length, 0);
});

// The token is cached in module scope (5-min TTL), so these two need a handler
// whose cache is empty. A cache-busting import specifier gives a fresh module
// instance while keeping the same mocks.
test("misconfigured secret (no webhook_token anywhere) -> 401, fail closed", async () => {
  resetCtx();
  ctx.apiSecret = { base_url: "x", tenant_id: "y", api_key: "z" }; // no webhook_token
  const { handler: fresh } = await import("./index.js?variant=no-token");
  const res = await fresh(webhookEvent());
  assert.equal(res.statusCode, 401);
  assert.equal(ctx.sent.length, 0);
});

test("a dedicated sundial/aurora/webhook secret takes precedence when present", async () => {
  resetCtx();
  ctx.dedicatedThrows = false;
  ctx.dedicatedSecret = { token: "dedicated-token" };
  const { handler: fresh } = await import("./index.js?variant=dedicated-secret");
  // The api-secret token must no longer be accepted...
  const rejected = await fresh(webhookEvent({}, GOOD_TOKEN));
  assert.equal(rejected.statusCode, 401);
  // ...and the dedicated one must be.
  const accepted = await fresh(webhookEvent({}, "dedicated-token"));
  assert.equal(accepted.statusCode, 200);
});

test("a failed token lookup is NOT cached (the next delivery retries it)", async () => {
  resetCtx();
  ctx.apiSecret = { base_url: "x", tenant_id: "y", api_key: "z" }; // no webhook_token
  const { handler: fresh } = await import("./index.js?variant=no-cache-on-failure");
  assert.equal((await fresh(webhookEvent())).statusCode, 401);
  // Secret gets fixed; the very next call must succeed without a redeploy.
  ctx.apiSecret.webhook_token = GOOD_TOKEN;
  assert.equal((await fresh(webhookEvent())).statusCode, 200);
});

test("ENQUEUE FAILURE -> 5xx on purpose (drives Aurora's retry ladder)", async () => {
  resetCtx();
  ctx.sendThrows = "AWS.SimpleQueueService.NonExistentQueue";

  const res = await handler(webhookEvent());
  assert.equal(res.statusCode, 500, "must NOT ack an event we failed to queue");
  assert.equal(parse(res).error, "enqueue_failed");
});

test("unset queue URL -> 5xx (event survives via Aurora's retry, not acked into a void)", async () => {
  resetCtx();
  delete process.env.AURORA_INBOUND_QUEUE_URL;
  const res = await handler(webhookEvent());
  assert.equal(res.statusCode, 500);
  assert.equal(parse(res).error, "queue_not_configured");
  assert.equal(ctx.sent.length, 0);
});

test("missing required params -> 400, nothing enqueued", async () => {
  resetCtx();
  const ev = webhookEvent();
  delete ev.queryStringParameters.agreement_id;
  const res = await handler(ev);
  assert.equal(res.statusCode, 400);
  assert.deepEqual(parse(res).missing, ["agreement_id"]);
  assert.equal(ctx.sent.length, 0);
});

test("EMPTY financing_id is enqueued as null, not an error", async () => {
  resetCtx();
  // Aurora sends an empty FINANCING_ID when no financing was selected.
  const res = await handler(webhookEvent({ financing_id: "" }));
  assert.equal(res.statusCode, 200);
  assert.equal(ctx.sent[0].body.financing_id, null);
});

test("UPPERCASE attribute names are accepted too", async () => {
  resetCtx();
  const res = await handler({
    requestContext: { http: { method: "GET" } },
    headers: { "x-aurora-webhook-token": GOOD_TOKEN },
    queryStringParameters: {
      PROJECT_ID: "p9", DESIGN_ID: "d9", AGREEMENT_ID: "a9",
      FINANCING_ID: "f9", STATUS: "viewed",
    },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(ctx.sent[0].body.project_id, "p9");
  assert.equal(ctx.sent[0].body.status, "viewed");
});

test("every lifecycle status is accepted and enqueued", async () => {
  resetCtx();
  for (const status of ["sent", "viewed", "signed", "cancel-pending", "canceled", "declined", "error"]) {
    await handler(webhookEvent({ status }));
  }
  assert.deepEqual(
    ctx.sent.map((m) => m.body.status),
    ["sent", "viewed", "signed", "cancel-pending", "canceled", "declined", "error"]
  );
});

test("does no heavy work: only ONE outbound call, well inside the 10s deadline", async () => {
  resetCtx();
  const started = Date.now();
  const res = await handler(webhookEvent());
  const elapsed = Date.now() - started;

  assert.equal(res.statusCode, 200);
  // The doorbell must never call Salesforce or Aurora — the only I/O is the enqueue.
  assert.equal(ctx.sent.length, 1, 'exactly one outbound call (the enqueue)');
  assert.ok(elapsed < 1000, `doorbell took ${elapsed}ms — it must stay far under Aurora's 10s`);
});

test("non-GET is rejected", async () => {
  resetCtx();
  const res = await handler({
    requestContext: { http: { method: "POST" } },
    headers: { "x-aurora-webhook-token": GOOD_TOKEN },
  });
  assert.equal(res.statusCode, 405);
});
