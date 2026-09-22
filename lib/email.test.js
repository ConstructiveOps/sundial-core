// lib/email.js — the one thing that ever broke here: a binary attachment must reach
// the customer byte-for-byte (2026-09-22, the 6 KB estimate "PDF" that would not open).
//
// The SES v2 API reference says an attachment's ContentTransferEncoding defaults to
// BASE64. It does not: SES applies SEVEN_BIT when the field is omitted, treats the bytes
// as text, and a PDF arrives with every high byte replaced and every LF turned into CRLF.
// These tests pin (1) that we always declare BASE64, and (2) that the real SDK serializer
// puts the exact bytes on the wire (base64) — run against a fake transport, no network.

import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { buildAttachments, buildSendEmailInput, sendEmail } from "./email.js";

// A PDF-shaped payload with the bytes that got mangled: 0x81 header comment bytes,
// a bare LF, and a deflate-looking run above 0x7F.
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a, 0x25, 0x81, 0x81, 0x81, 0x81, 0x0a, 0x78, 0x9c, 0xe2, 0xe3, 0xcf, 0xd3, 0xff, 0xfe, 0x00, 0x0a]);

/** A SESv2Client whose transport captures the serialized request instead of sending it. */
function capturingClient(captured) {
  return new SESv2Client({
    region: "us-west-1",
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
    requestHandler: {
      handle: async (req) => {
        captured.body = JSON.parse(Buffer.from(req.body).toString("utf8"));
        return { response: { statusCode: 200, headers: { "content-type": "application/json" }, body: streamOf('{"MessageId":"m-1"}') } };
      },
    },
  });
}

function streamOf(text) {
  return Readable.from([Buffer.from(text)]);
}

test("every attachment is declared BASE64 and carries the raw bytes untouched", () => {
  const out = buildAttachments([
    { fileName: "EST-00002-v1.pdf", contentType: "application/pdf", content: PDF },
    { fileName: "as-buffer.pdf", contentType: "application/pdf", content: Buffer.from(PDF) },
    null,
    { fileName: "", content: PDF }, // no name → dropped
    { fileName: "empty.pdf", content: null }, // no bytes → dropped
  ]);
  assert.equal(out.length, 2);
  for (const a of out) {
    assert.equal(a.ContentTransferEncoding, "BASE64");
    assert.equal(a.ContentDisposition, "ATTACHMENT");
    assert.equal(a.ContentType, "application/pdf");
    assert.ok(a.RawContent instanceof Uint8Array);
    assert.deepEqual(Array.from(a.RawContent), Array.from(PDF));
  }
  assert.equal(buildAttachments(undefined).length, 0);
});

test("the SDK puts the exact bytes on the wire, base64-encoded, next to the BASE64 declaration", async () => {
  const captured = {};
  const client = capturingClient(captured);
  const input = buildSendEmailInput({
    from: "Sundial <no-reply@example.test>",
    to: "customer@example.test",
    subject: "Your estimate",
    body: { Text: { Data: "See attached.", Charset: "UTF-8" } },
    attachments: buildAttachments([{ fileName: "EST-00002-v1.pdf", contentType: "application/pdf", content: PDF }]),
    configurationSet: undefined,
  });
  await client.send(new SendEmailCommand(input));
  const [att] = captured.body.Content.Simple.Attachments;
  assert.equal(att.ContentTransferEncoding, "BASE64");
  assert.equal(att.RawContent, Buffer.from(PDF).toString("base64"));
  // and decoding what went out gives back the PDF, byte for byte
  assert.deepEqual(Array.from(Buffer.from(att.RawContent, "base64")), Array.from(PDF));
  assert.equal(captured.body.Content.Simple.Attachments.length, 1);
});

test("sendEmail() end to end through the capturing client: attachment declared BASE64, MessageId returned", async () => {
  const prevFrom = process.env.EMAIL_FROM;
  process.env.EMAIL_FROM = "Sundial <no-reply@example.test>";
  try {
    const captured = {};
    const res = await sendEmail(
      { to: "customer@example.test", subject: "Invoice", text: "Attached.", attachments: [{ fileName: "INV-00001.pdf", contentType: "application/pdf", content: PDF }] },
      { client: capturingClient(captured) },
    );
    assert.deepEqual(res, { ok: true, messageId: "m-1" });
    const [att] = captured.body.Content.Simple.Attachments;
    assert.equal(att.ContentTransferEncoding, "BASE64");
    assert.equal(att.FileName, "INV-00001.pdf");
    assert.deepEqual(Array.from(Buffer.from(att.RawContent, "base64")), Array.from(PDF));
  } finally {
    if (prevFrom === undefined) delete process.env.EMAIL_FROM;
    else process.env.EMAIL_FROM = prevFrom;
  }
});

test("a message without attachments sends no Attachments field at all", () => {
  const input = buildSendEmailInput({ from: "a@b.test", to: ["c@d.test"], subject: "s", body: { Text: { Data: "t" } }, attachments: [], configurationSet: undefined });
  assert.equal("Attachments" in input.Content.Simple, false);
  assert.deepEqual(input.Destination.ToAddresses, ["c@d.test"]);
});
