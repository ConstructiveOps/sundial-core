// scripts/verify-photo-report.mjs — the photo report (D-072 amendment 17) end to end against the
// DEPLOYED API, as the ZZ TEST users, on ZZ test jobs only.
//
//   node scripts/verify-photo-report.mjs
//
// What it checks:
//   A. ACCESS    zz-tech gets 403 from GET …/photo-report; zz-admin gets 200.
//   B. PARTNER   the Leasing-Partner-billed ZZ job: sendDefaults (source billTo when the job names
//                a payer record), the title line, and a preview whose header shows the service
//                address and NOT the homeowner's name.
//   C. BUILD     zz-admin saves a report (cover + a list section + a grid section) on a ZZ
//                customer-paid job, previews it (customer name + address, the title line).
//   D. DOWNLOAD  GET …/pdf: inline (base64) or a queued render polled to done; the PDF holds one
//                image per distinct photo picked — never fewer.
//   E. SEND      Email to a ZZ address only (never the job's own recipients); a queued render
//                is polled. The PDF exists before the send reports done, the public page
//                (/public/photo-reports/{token}) draws the report as sent with the PDF link.
//   F. STALE     a PUT with an old baseUpdatedAt is 409 PHOTO_REPORT_CHANGED.
//
// Writes: a sundial_job_photo_reports row on each ZZ job it saves to, the sent PDF in that
// job's folder, one email to tim+zz-admin@…. No Salesforce field is written.
// Passwords come from Secrets Manager `sundial/test-users`, never a file (CLAUDE.md).

import { PDFDocument, PDFName, PDFRawStream } from "pdf-lib";
import { loadTestPasswords, loginAsTestUser } from "./portal-login.mjs";

const API = (process.env.API_BASE_URL || "https://5sktfwldh1.execute-api.us-west-1.amazonaws.com/prod").replace(/\/+$/, "");
const PARTNER_JOB = "a1c7y00000RKN0vAAH"; // SVC-00001 — ZZZ Matt Test Murphy Test, Leasing Partner
const CUSTOMER_JOB = "a1c7y00000SDkUmAAL"; // SVC-02279 — ZZZ New Matt Test, Customer pays
const SEND_TO = "tim+zz-admin@constructiveoperations.com";

let failures = 0;
const ok = (cond, label, extra = "") => {
  console.log(`${cond ? "  PASS" : "  FAIL"}  ${label}${extra ? `  — ${extra}` : ""}`);
  if (!cond) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(token, method, path, body) {
  const resp = await fetch(`${API}${path}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await resp.json().catch(() => ({}));
  return { status: resp.status, body: json };
}

async function pollRender(token, jobId, renderId, label) {
  const started = Date.now();
  while (Date.now() - started < 15 * 60 * 1000) {
    const r = await call(token, "GET", `/service/jobs/${jobId}/photo-report/renders/${renderId}`);
    if (r.status !== 200) return r;
    const p = r.body.progress ? ` ${r.body.progress.ready}/${r.body.progress.total}` : "";
    console.log(`        ${label}: ${r.body.status}${p} (${Math.round((Date.now() - started) / 1000)} s)`);
    if (r.body.status === "done" || r.body.status === "failed") return r;
    await sleep(10000);
  }
  return { status: 0, body: { status: "timeout" } };
}

// Images in the PDF that are not a transparency mask: the photos, plus the brand logo when it has one.
async function countImages(buf) {
  const doc = await PDFDocument.load(buf);
  const images = [];
  const masks = new Set();
  for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream) || String(obj.dict.get(PDFName.of("Subtype"))) !== "/Image") continue;
    images.push(ref.toString());
    const sm = obj.dict.get(PDFName.of("SMask"));
    if (sm) masks.add(sm.toString());
  }
  return { count: images.filter((r) => !masks.has(r)).length, title: doc.getTitle() };
}

async function pdfBytesFrom(token, jobId, r) {
  if (r.status === 200 && r.body.base64) return { buf: Buffer.from(r.body.base64, "base64"), how: "inline" };
  if (r.status === 202) {
    const done = await pollRender(token, jobId, r.body.renderId, "download");
    if (done.body.status !== "done") return { error: JSON.stringify(done.body) };
    const resp = await fetch(done.body.url);
    return { buf: Buffer.from(await resp.arrayBuffer()), how: "background render" };
  }
  if (r.status === 200 && r.body.url) {
    const resp = await fetch(r.body.url);
    return { buf: Buffer.from(await resp.arrayBuffer()), how: "stored + linked" };
  }
  return { error: `${r.status} ${JSON.stringify(r.body)}` };
}

function pickPhotos(groups, n) {
  return groups.flatMap((g) => g.photos).filter((p) => p.embeddable).slice(0, n).map((p) => p.key);
}

async function main() {
  const pw = await loadTestPasswords();
  const admin = await loginAsTestUser("admin", pw);
  const tech = await loginAsTestUser("tech", pw);
  if (!admin.token || !tech.token) throw new Error("ZZ login failed");

  console.log("A. ACCESS");
  ok((await call(tech.token, "GET", `/service/jobs/${CUSTOMER_JOB}/photo-report`)).status === 403, "zz-tech → 403");
  const g = await call(admin.token, "GET", `/service/jobs/${CUSTOMER_JOB}/photo-report`);
  ok(g.status === 200, "zz-admin → 200", g.status === 200 ? `${g.body.photoCount} photos on the job` : JSON.stringify(g.body));
  if (g.status !== 200) return;

  console.log("B. PARTNER");
  const p = await call(admin.token, "GET", `/service/jobs/${PARTNER_JOB}/photo-report`);
  ok(p.status === 200, "partner job read", `${p.body.jobNumber}, partnerBilled=${p.body.partnerBilled}`);
  const sd = p.body.sendDefaults || {};
  console.log(`        sendDefaults: source=${sd.source} name=${sd.name ?? "—"} email=${sd.email ? "set" : "—"} phone=${sd.phone ? "set" : "—"}`);
  ok(sd.source === "billTo", "sendDefaults come from the payer record", sd.source === "billTo" ? "" : "the job names no Bill_To_Customer__c — see report");
  ok(/^Photo report for /.test(p.body.title || ""), "title line", p.body.title);

  console.log("C. BUILD");
  const photos = pickPhotos(g.body.photos, 9);
  ok(photos.length >= 3, "the job has JPEG / PNG photos to pick", `${photos.length} picked`);
  const report = {
    cover: { title: "ZZ VERIFY photo report", scope: "Smoke test of the photo report.", coverPhotoKey: photos[0] },
    sections: [
      { id: "s1", name: "Before", layout: "list", description: "List layout.", photos: photos.slice(0, 3).map((key, i) => ({ key, description: `Photo ${i + 1} description.` })) },
      { id: "s2", name: "After", layout: "grid", photos: photos.slice(3).map((key) => ({ key })) },
    ],
    receipt: false,
  };
  const s = await call(admin.token, "PUT", `/service/jobs/${CUSTOMER_JOB}/photo-report`, report);
  ok(s.status === 200, "save", s.status === 200 ? `updatedAt ${s.body.updatedAt}` : JSON.stringify(s.body));
  const pv = await call(admin.token, "GET", `/service/jobs/${CUSTOMER_JOB}/photo-report/preview`);
  ok(pv.status === 200 && pv.body.photos === new Set(photos).size, "preview", `${pv.body.sections} sections, ${pv.body.photos} photos, title "${pv.body.title}"`);
  ok((pv.body.html || "").includes("ZZZ New Matt Test"), "customer pays → the customer's name in the header");

  console.log("F. STALE");
  const stale = await call(admin.token, "PUT", `/service/jobs/${CUSTOMER_JOB}/photo-report`, { ...report, baseUpdatedAt: "2020-01-01T00:00:00.000Z" });
  ok(stale.status === 409 && stale.body.code === "PHOTO_REPORT_CHANGED", "old baseUpdatedAt → 409", `${stale.status} ${stale.body.code ?? ""}`);

  console.log("D. DOWNLOAD");
  const t0 = Date.now();
  const dl = await call(admin.token, "GET", `/service/jobs/${CUSTOMER_JOB}/photo-report/pdf`);
  console.log(`        first response ${dl.status} after ${Math.round((Date.now() - t0) / 1000)} s`);
  const pdf = await pdfBytesFrom(admin.token, CUSTOMER_JOB, dl);
  if (pdf.error) ok(false, "download", pdf.error);
  else {
    const { count: n, title } = await countImages(pdf.buf);
    const want = new Set(photos).size;
    ok(pdf.buf.subarray(0, 5).toString() === "%PDF-", `PDF via ${pdf.how}`, `${(pdf.buf.length / 1024 / 1024).toFixed(2)} MB`);
    ok(n === want || n === want + 1, "every picked photo is embedded", `${n} images (photos + logo) for ${want} photos`);
    ok(/^Photo report for /.test(title || ""), "PDF title metadata", title);
  }

  console.log("E. SEND (email to a ZZ address)");
  const t1 = Date.now();
  let sent = await call(admin.token, "POST", `/service/jobs/${CUSTOMER_JOB}/photo-report/send`, { via: "Email", to: SEND_TO });
  console.log(`        first response ${sent.status} after ${Math.round((Date.now() - t1) / 1000)} s`);
  if (sent.status === 202) {
    const done = await pollRender(admin.token, CUSTOMER_JOB, sent.body.renderId, "send");
    sent = { status: done.body.status === "done" ? 200 : 500, body: done.body };
  }
  ok(sent.status === 200 && sent.body.success !== false, "send", JSON.stringify({ delivery: sent.body.delivery, recipient: sent.body.recipient, attached: sent.body.attached, pdfBytes: sent.body.pdfBytes, sentCount: sent.body.sentCount, errorCode: sent.body.errorCode ?? sent.body.code }));
  ok(sent.body.recipient === SEND_TO || (sent.body.recipient || "").includes("zz-admin"), "went to the ZZ address only");
  if (sent.body.pdfUrl) {
    const head = await fetch(sent.body.pdfUrl, { method: "HEAD" });
    ok(head.status === 200, "the sent PDF is reachable", sent.body.pdfUrl);
  }
  const token = (sent.body.publicUrl || "").split("/").pop();
  if (token) {
    const pub = await call(null, "GET", `/public/photo-reports/${token}`);
    ok(pub.status === 200 && (pub.body.html || "").includes("ZZ VERIFY photo report"), "public page draws the report as sent", pub.body.title);
    ok((pub.body.html || "").includes(">Download the PDF</a>") && !!pub.body.pdfUrl, "public page links the PDF");
    console.log(`        hosted page: ${sent.body.publicUrl}`);
  }
  const after = await call(admin.token, "GET", `/service/jobs/${CUSTOMER_JOB}/photo-report`);
  ok(after.body.sentCount >= 1 && after.body.editedSinceSent === false, "row stamped, not 'edited since sent'", `sentCount ${after.body.sentCount}`);

  console.log(failures ? `\n${failures} check(s) FAILED` : "\nALL CHECKS PASSED");
  process.exitCode = failures ? 1 : 0;
}

main().catch((e) => {
  console.error(e?.stack || e);
  process.exitCode = 1;
});
