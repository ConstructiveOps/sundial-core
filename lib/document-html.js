// lib/document-html.js — the HTML FRAME every customer document shares (D-081, 2026-10-07).
//
// The estimate, the invoice and the job report are one family, laid out after the
// Housecall Pro invoice Harmon sends today:
//
//   ┌ logo                               ┌──────────────────────────┐
//   │ Company name (bold, under the logo)│ INVOICE        SVC-02108 │  ← the meta box:
//   │                                    │ SERVICE DATE  Sep 24 …   │    label / value rows,
//   │ Left block, no label               │ ─────────────────────────│    then one large row
//   │ (bill-to / prepared-for)           │ AMOUNT DUE    $7,065.00  │
//   │                                    └──────────────────────────┘
//   │                                     SERVICE ADDRESS / CONTACT US (labelled blocks)
//   ├ BODY LABEL + paragraph
//   ├ table with an accent header band, then a narrow totals box on the right
//   └ footer: notes · tagline · terms · links · ── name | license   website
//
// Paints a model's FRAME fields only (brand, meta, metaTotal, left, rightBlocks, columns,
// rows, totalRows, footerNotes); the builders in lib/estimate-document.js and
// lib/job-report-document.js decide what goes in them. lib/document-pdf.js is the PDF twin.
// PURE: strings in, strings out, every rule inline (email clients and the PDF need that).

export const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/** The shared stylesheet, coloured by the brand's accent. */
export function frameCss(accentColor) {
  const accent = esc(accentColor);
  return `
  body{margin:0;background:#f4f4f5;font:14px/1.45 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#18181b}
  .page{max-width:800px;margin:24px auto;background:#fff;padding:40px 44px;box-shadow:0 1px 3px rgba(0,0,0,.08);position:relative}
  .wm{position:absolute;top:14px;right:24px;font-size:11px;letter-spacing:.2em;color:#a1a1aa;border:1px solid #d4d4d8;padding:2px 8px;border-radius:999px}
  .head{display:grid;grid-template-columns:1fr 300px;gap:28px;margin-bottom:22px}
  .brand .logo{display:block;max-height:72px;max-width:260px}
  .brand .co{font-weight:700;font-size:15px;margin-top:6px}
  .brand h1{margin:0;font-size:20px;color:${accent}}
  .left{margin-top:16px;font-size:14px}
  .left .first{font-weight:700}
  .metabox{border:1px solid #e4e4e7;border-radius:6px;padding:10px 14px}
  .metabox .row{display:flex;justify-content:space-between;gap:12px;padding:3px 0;font-size:13px}
  .metabox .row .k,.blk .k{font-size:10.5px;letter-spacing:.08em;text-transform:uppercase;color:#71717a}
  .metabox .row .v{text-align:right;font-variant-numeric:tabular-nums}
  .metabox .total{border-top:1px solid #e4e4e7;margin-top:6px;padding-top:8px;font-weight:700}
  .metabox .total .k{color:#18181b;font-weight:700}
  .metabox .total .v{font-size:19px}
  .blk{margin-top:14px;font-size:13px}
  .blk .k{display:block;border-bottom:1px solid #e4e4e7;padding-bottom:3px;margin-bottom:5px}
  h2{font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:#71717a;margin:18px 0 6px;font-weight:600}
  .bodytext{white-space:pre-wrap}
  table.items{width:100%;border-collapse:collapse;margin-top:10px}
  table.items th{background:${accent};color:#fff;font-size:11px;text-transform:uppercase;letter-spacing:.06em;text-align:left;padding:7px 8px;font-weight:600}
  table.items td{padding:8px;border-bottom:1px solid #ececef;vertical-align:top}
  td.desc{width:58%}
  .num{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
  table.items th.num{text-align:right}
  td.lite{color:#71717a}
  .tag{font-size:10px;background:#fef3c7;color:#92400e;padding:1px 6px;border-radius:999px;margin-left:6px;vertical-align:middle}
  table.totals{margin:12px 0 0 auto;min-width:300px;border:1px solid #e4e4e7;border-radius:6px;border-collapse:separate;padding:6px 10px}
  table.totals td{padding:4px 0}
  table.totals td.num{padding-left:24px}
  table.totals tr.sub td{color:#71717a;font-size:12px}
  table.totals tr.sub td:first-child{padding-left:14px}
  table.totals tr.strong td{font-weight:700;border-top:1px solid #d4d4d8;padding-top:7px}
  table.totals tr.big td{font-weight:700;font-size:18px}
  .accept{margin-top:28px;padding:18px;border:1px solid #e4e4e7;border-radius:10px;text-align:center}
  .accept.muted{border-style:dashed;color:#71717a}
  .btn{display:inline-block;background:${accent};color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:600}
  .btn.ghost{background:#e4e4e7;color:#52525b}
  .accept p{font-size:12px;margin:10px 0 0}
  footer{margin-top:28px;font-size:11px;color:#71717a}
  footer p{margin:4px 0}
  footer a{color:inherit}
  .links{margin-top:8px;display:grid;gap:6px}
  .links p{margin:0}
  .links strong{color:#3f3f46}
  .fline{display:flex;justify-content:space-between;gap:12px;border-top:1px solid #e4e4e7;margin-top:14px;padding-top:8px}
  @media (max-width:640px){.page{padding:22px 16px;margin:0}.head{grid-template-columns:1fr}table.totals{min-width:0;width:100%}}
  @media print{body{background:#fff}.page{box-shadow:none;margin:0;padding:24px}.wm{display:none}}`;
}

/** Logo + name + left block | meta box + labelled blocks. */
export function headerHtml(m) {
  const b = m.brand;
  const brand = b.logoUrl
    ? `<img class="logo" src="${esc(b.logoUrl)}" alt="${esc(b.displayName)}">${b.companyName ? `<div class="co">${esc(b.companyName)}</div>` : ""}`
    : `<h1>${esc(b.displayName)}</h1>`;
  const left = (m.left?.lines || []).map((l, i) => `<div${i === 0 || l.bold ? ' class="first"' : ""}>${esc(l.text)}</div>`).join("");
  const meta = (m.meta || []).map((r) => `<div class="row"><span class="k">${esc(r.label)}</span><span class="v">${esc(r.value)}</span></div>`).join("");
  const total = m.metaTotal ? `<div class="row total"><span class="k">${esc(m.metaTotal.label)}</span><span class="v">${esc(m.metaTotal.value)}</span></div>` : "";
  const blocks = (m.rightBlocks || [])
    .filter((blk) => blk.lines?.length)
    .map((blk) => `<div class="blk"><span class="k">${esc(blk.label)}</span>${blk.lines.map((s) => `<div>${esc(s)}</div>`).join("")}</div>`)
    .join("");
  return `<div class="head">
    <div><div class="brand">${brand}</div>${left ? `<div class="left">${left}</div>` : ""}</div>
    <div><div class="metabox">${meta}${total}</div>${blocks}</div>
  </div>`;
}

/** A labelled paragraph (Invoice / Scope of work / Summary of work); nothing when empty. */
export function bodyHtml(label, text) {
  return text ? `<h2>${esc(label)}</h2><div class="bodytext">${esc(text)}</div>` : "";
}

/** The line-item table: accent header band; qty and unit price in grey, amount in black. */
export function itemsTableHtml(columns, rows, emptyText = "No line items yet") {
  const body = rows
    .map(
      (r) => `<tr>
        <td class="desc">${esc(r.description)}${r.isNew ? ' <span class="tag">new</span>' : ""}</td>
        <td class="num lite">${esc(r.qty)}</td>
        <td class="num lite">${esc(r.unit)}</td>
        <td class="num">${esc(r.amount)}</td>
      </tr>`
    )
    .join("");
  return `<table class="items">
    <thead><tr><th>${esc(columns.description)}</th><th class="num">${esc(columns.qty)}</th><th class="num">${esc(columns.unit)}</th><th class="num">${esc(columns.amount)}</th></tr></thead>
    <tbody>${body || `<tr><td colspan="4" style="color:#a1a1aa">${esc(emptyText)}</td></tr>`}</tbody>
  </table>`;
}

/** The totals in their own narrow box under the table. */
export function totalsHtml(totalRows) {
  if (!totalRows?.length) return "";
  return `<table class="totals">${totalRows
    .map((r) => `<tr class="${[r.sub ? "sub" : "", r.strong ? "strong" : "", r.big ? "big" : ""].filter(Boolean).join(" ")}"><td>${esc(r.label)}</td><td class="num">${esc(r.amount)}</td></tr>`)
    .join("")}</table>`;
}

/** Terms as one line, every other link with its copy. */
export function footerLinksHtml(brand) {
  if (!brand?.links?.length) return "";
  return `<div class="links">${brand.links
    .map((l) =>
      l.kind === "terms"
        ? `<p>See our Terms &amp; Conditions (<a href="${esc(l.url)}">${esc(l.url)}</a>)</p>`
        : `<p><strong>${esc(l.label)}</strong> — ${esc(l.blurb)} <a href="${esc(l.url)}">${esc(l.url)}</a></p>`
    )
    .join("")}</div>`;
}

/** Notes, tagline, links, then the one-line footer (name | license · website). */
export function footerHtml(m, extra = "") {
  const b = m.brand;
  const line = b.footerLine?.left || b.footerLine?.center
    ? `<div class="fline"><span>${esc(b.footerLine.left)}</span><span>${b.websiteUrl ? `<a href="${esc(b.websiteUrl)}">${esc(b.footerLine.center)}</a>` : ""}</span><span></span></div>`
    : "";
  return `<footer>
    ${(m.footerNotes || []).map((s) => `<p>${esc(s)}</p>`).join("")}
    ${extra}
    ${b.tagline ? `<p>${esc(b.tagline)}</p>` : ""}
    ${footerLinksHtml(b)}
    ${line}
  </footer>`;
}
