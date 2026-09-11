// lib/estimate-document.js — THE renderer for the customer-facing estimate document.
//
// One function, four consumers (Tim, 2026-09-11: "see the final product before
// sending"): the office Preview (GET /service/estimates/{id}/preview), the hosted
// customer page (next increment), the PDF (next increment), and the email body.
// Because all four call this, what the office previews is exactly what the customer
// gets — there is no second template to drift.
//
// PURE and self-contained: plain objects in, one HTML string out, every CSS rule
// inline, no external assets (the PDF renderer and the email client both need that).
// Tenant identity (company name, license numbers, contact line, terms link) comes in
// as `brand` — nothing Harmon-specific lives here (CLAUDE.md multi-client rule).
// Markup is NEVER printed as a line; it is inside the totals by design (D-072.8).

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const money = (n) => {
  const v = Number(n);
  if (!Number.isFinite(v)) return "—";
  return v.toLocaleString("en-US", { style: "currency", currency: "USD" });
};

const qty = (n, uom) => {
  const v = Number(n);
  const q = Number.isFinite(v) ? (Number.isInteger(v) ? String(v) : v.toFixed(2)) : "—";
  return uom && uom !== "Each" ? `${q} ${esc(uom)}` : q;
};

const dateOnly = (v) => {
  if (!v) return "";
  const m = String(v).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return String(v);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}`;
};

/** Default brand block when the tenant has not configured one yet. */
export const DEFAULT_BRAND = Object.freeze({
  companyName: "",
  tagline: "",
  addressLine: "",
  phone: "",
  email: "",
  licenseLine: "", // e.g. "ROC #123456 · ROC #654321" — GET FROM HARMON
  termsUrl: "", // re-hosted T&C link (9/9 meeting) — GET FROM HARMON
  footerNote: "", // e.g. the Service Club blurb the office wants on everything
  accentColor: "#1F3864",
});

/**
 * @param {object} args
 * @param {object} args.estimate   Sundial_Estimate__c record (API names)
 * @param {Array}  args.lines      Sundial_Service_Line__c records (API names)
 * @param {object} args.totals     computeTotals() output (numbers)
 * @param {object} [args.brand]    tenant identity (see DEFAULT_BRAND)
 * @param {object} [args.options]  { mode: "preview"|"customer"|"pdf"|"email",
 *                                   acceptUrl, showUnitPrices (default true), watermark }
 * @returns {{ html: string, title: string }}
 */
export function renderEstimateDocument({ estimate, lines, totals, brand = {}, options = {} }) {
  const b = { ...DEFAULT_BRAND, ...brand };
  const mode = options.mode || "preview";
  const est = estimate || {};
  const version = Number(est.Version__c) || 0;
  const number = est.Name || "Estimate";
  const title = `${number}${version ? ` v${version}` : ""}`;
  const visible = (lines || []).filter((l) => l.Stage__c !== "Removed");
  const showUnit = options.showUnitPrices !== false;

  const rows = visible
    .map((l) => {
      const perLine = showUnit && l.Show_Unit_Price__c !== false;
      return `<tr>
        <td class="desc">${esc(l.Description__c || "")}${l.Stage__c === "Proposed" && version > 0 && (est.Approved_Version__c ?? 0) > 0 ? ' <span class="tag">new</span>' : ""}</td>
        <td class="num">${qty(l.Quantity__c, l.Unit_of_Measure__c)}</td>
        <td class="num">${perLine ? money(l.Unit_Price__c) : ""}</td>
        <td class="num">${money(l.Line_Total__c ?? Number(l.Quantity__c || 0) * Number(l.Unit_Price__c || 0))}</td>
      </tr>`;
    })
    .join("");

  const t = totals || {};
  const totalRows = [
    ["Subtotal", t.subtotal],
    t.discountAmount > 0 ? [est.Discount_Source__c === "Service Plan" ? "Service plan discount" : "Discount", -t.discountAmount] : null,
    t.taxAmount > 0 ? [`Tax${est.Tax_Jurisdiction__c ? ` (${esc(est.Tax_Jurisdiction__c)})` : ""}`, t.taxAmount] : null,
    ["Total", t.total, true],
    est.Deposit_Required__c === true && t.depositAmount > 0 ? ["Deposit due to schedule", t.depositAmount] : null,
  ]
    .filter(Boolean)
    .map(([label, amount, strong]) => `<tr class="${strong ? "grand" : ""}"><td colspan="3">${label}</td><td class="num">${money(amount)}</td></tr>`)
    .join("");

  const customerBlock = [
    est.Customer_Name_at_Creation__c,
    est.Address_at_Creation__c,
    est.Primary_Phone_at_Creation__c,
    est.Primary_Email_at_Creation__c,
  ]
    .filter(Boolean)
    .map((s) => `<div>${esc(s)}</div>`)
    .join("");

  const accept =
    mode === "customer" && options.acceptUrl
      ? `<div class="accept"><a class="btn" href="${esc(options.acceptUrl)}">Approve this estimate</a><p>Approving lets us schedule the work. You'll be asked for a card to keep on file; nothing is charged until the work is done${est.Deposit_Required__c === true ? ", except the deposit shown above" : ""}.</p></div>`
      : mode === "preview"
        ? `<div class="accept muted"><span class="btn ghost">Approve this estimate</span><p>The customer sees the approve button and card form here.</p></div>`
        : "";

  const watermark = options.watermark || (mode === "preview" ? "PREVIEW" : "");

  const html = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title>
<style>
  body{margin:0;background:#f4f4f5;font:14px/1.45 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#18181b}
  .page{max-width:800px;margin:24px auto;background:#fff;padding:40px 44px;box-shadow:0 1px 3px rgba(0,0,0,.08);position:relative}
  .wm{position:absolute;top:18px;right:24px;font-size:11px;letter-spacing:.2em;color:#a1a1aa;border:1px solid #d4d4d8;padding:2px 8px;border-radius:999px}
  header{display:flex;justify-content:space-between;gap:24px;border-bottom:3px solid ${esc(b.accentColor)};padding-bottom:16px;margin-bottom:20px}
  .brand h1{margin:0;font-size:20px;color:${esc(b.accentColor)}}
  .brand div{color:#52525b;font-size:12px}
  .meta{text-align:right;font-size:12px;color:#52525b}
  .meta .num{font-size:18px;color:#18181b;font-weight:600}
  h2{font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:#71717a;margin:18px 0 6px}
  .two{display:grid;grid-template-columns:1fr 1fr;gap:24px}
  .scope{white-space:pre-wrap}
  table{width:100%;border-collapse:collapse;margin-top:8px}
  th{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#71717a;text-align:left;padding:6px 8px;border-bottom:1px solid #e4e4e7}
  td{padding:8px;border-bottom:1px solid #f1f1f3;vertical-align:top}
  td.desc{width:60%}
  .num{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
  th.num{text-align:right}
  tr.grand td{font-weight:700;font-size:16px;border-top:2px solid #18181b;border-bottom:none}
  .tag{font-size:10px;background:#fef3c7;color:#92400e;padding:1px 6px;border-radius:999px;margin-left:6px;vertical-align:middle}
  .accept{margin-top:28px;padding:18px;border:1px solid #e4e4e7;border-radius:10px;text-align:center}
  .accept.muted{border-style:dashed;color:#71717a}
  .btn{display:inline-block;background:${esc(b.accentColor)};color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:600}
  .btn.ghost{background:#e4e4e7;color:#52525b}
  .accept p{font-size:12px;margin:10px 0 0}
  footer{margin-top:28px;border-top:1px solid #e4e4e7;padding-top:12px;font-size:11px;color:#71717a}
  footer a{color:inherit}
  @media print{body{background:#fff}.page{box-shadow:none;margin:0;padding:24px}.wm{display:none}}
</style></head>
<body><div class="page">
  ${watermark ? `<div class="wm">${esc(watermark)}</div>` : ""}
  <header>
    <div class="brand">
      <h1>${esc(b.companyName || "Estimate")}</h1>
      ${b.tagline ? `<div>${esc(b.tagline)}</div>` : ""}
      ${b.addressLine ? `<div>${esc(b.addressLine)}</div>` : ""}
      ${[b.phone, b.email].filter(Boolean).length ? `<div>${esc([b.phone, b.email].filter(Boolean).join(" · "))}</div>` : ""}
      ${b.licenseLine ? `<div>${esc(b.licenseLine)}</div>` : ""}
    </div>
    <div class="meta">
      <div>Estimate</div>
      <div class="num">${esc(number)}</div>
      ${version ? `<div>Version ${version}</div>` : ""}
      ${est.Last_Sent_At__c ? `<div>Sent ${dateOnly(est.Last_Sent_At__c)}</div>` : ""}
      ${est.Valid_Until__c ? `<div>Valid through ${dateOnly(est.Valid_Until__c)}</div>` : ""}
    </div>
  </header>

  <div class="two">
    <div><h2>Prepared for</h2>${customerBlock || '<div style="color:#a1a1aa">No customer on this estimate</div>'}</div>
    ${est.Scope_Summary__c ? `<div><h2>Scope of work</h2><div class="scope">${esc(est.Scope_Summary__c)}</div></div>` : ""}
  </div>

  <h2>Line items</h2>
  <table>
    <thead><tr><th>Description</th><th class="num">Qty</th><th class="num">${showUnit ? "Unit" : ""}</th><th class="num">Amount</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="4" style="color:#a1a1aa">No line items yet</td></tr>'}</tbody>
    <tfoot>${totalRows}</tfoot>
  </table>

  ${accept}

  <footer>
    ${b.footerNote ? `<p>${esc(b.footerNote)}</p>` : ""}
    ${b.termsUrl ? `<p>Terms and conditions: <a href="${esc(b.termsUrl)}">${esc(b.termsUrl)}</a></p>` : ""}
    <p>Prices are valid through the date shown; work added after approval appears on an updated version for your approval.</p>
  </footer>
</div></body></html>`;

  return { html, title };
}
