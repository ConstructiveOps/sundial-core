// lib/hcp-backfill.js — the targeted fix-up of HCP-imported records (2026-10-05), pure.
//
// Harmon's list of 2026-10-05, items 2, 6 and 7: the imported jobs' notes read
// "[object Object]" (HCP's `notes` is a list), every job bills the Customer (HCP has no
// Bill-To; the payer is in the job's title), and estimates that carried tax have no
// Tax_Rate__c (so the estimate page recomputes them to $0 tax). A full re-import is NOT the
// answer — the office has been working the records since Monday — so this plans the
// smallest write per record and leaves alone anything the office has changed:
//
//   • Office_Notes__c   — "[object Object]" is replaced by the notes text; notes the import
//                         never landed are appended under "HCP notes:"; nothing is removed.
//   • Issue_Description__c — rewritten (title + notes) only while it is still exactly the
//                         HCP title the import wrote; an edited description is kept.
//   • Bill_To_Type__c / Bill_To_Name__c / Service_Type__c — set from the title only while
//                         Bill-To is still the import's "Customer" with no name, and the
//                         service type is still blank.
//   • Estimates: Tax_Rate__c from Tax_Amount__c ÷ the taxable lines' value, only while the
//                         rate is null and the amount is above zero; Tax_Jurisdiction__c from
//                         the HCP tax line's name ("Phoenix", "Maricopa County") while blank.
//
// `scripts/hcp-backfill-notes-billto.mjs` reads the pull, queries Salesforce, feeds each
// record here, writes the review CSV, and applies canary-first.

import { billToFromTitle, jobNotesText } from "./hcp-bill-to.js";
import { jobIssueDescription } from "./hcp-import.js";

const s = (v) => (v == null ? "" : String(v).trim());
const BROKEN = "[object Object]";

/** The field changes for one imported job, or null when nothing needs writing. */
export function planJobFix(sfJob, hcpJob) {
  const out = {};
  const notes = jobNotesText(hcpJob);
  const office = s(sfJob.Office_Notes__c);
  if (office.includes(BROKEN)) {
    // The import's trailing line was the stringified list — put the real notes there.
    out.Office_Notes__c = office.replace(BROKEN, notes).replace(/\n+$/, "").slice(0, 32000);
  } else if (notes && !office.includes(notes.slice(0, 80))) {
    out.Office_Notes__c = [office, `HCP notes:\n${notes}`].filter(Boolean).join("\n\n").slice(0, 32000);
  }
  const title = s(hcpJob.description);
  const issue = s(sfJob.Issue_Description__c);
  const wanted = jobIssueDescription(hcpJob);
  if (wanted && (issue === "" || issue === title || issue === BROKEN) && issue !== wanted) out.Issue_Description__c = wanted;
  const bill = billToFromTitle(title);
  const untouched = (s(sfJob.Bill_To_Type__c) === "Customer" || s(sfJob.Bill_To_Type__c) === "") && s(sfJob.Bill_To_Name__c) === "";
  if (untouched && bill.rule !== "blank") {
    if (bill.billToType !== s(sfJob.Bill_To_Type__c)) out.Bill_To_Type__c = bill.billToType;
    if (bill.billToName) out.Bill_To_Name__c = bill.billToName;
  }
  if (s(sfJob.Service_Type__c) === "" && bill.serviceType) out.Service_Type__c = bill.serviceType;
  return Object.keys(out).length ? out : null;
}

/** What the title decided, for the review CSV row. */
export function describeBillTo(hcpJob) {
  return billToFromTitle(hcpJob?.description);
}

/** The HCP tax line's name on a job ("Phoenix", "Maricopa County"), or null. */
export function taxJurisdictionOf(lineItems) {
  const tax = (Array.isArray(lineItems) ? lineItems : []).find((li) => li?.kind === "tax" && s(li.name));
  return tax ? s(tax.name).replace(/\s+retail tax$/i, "").slice(0, 255) : null;
}

/**
 * The field changes for one imported estimate given its Sundial lines, or null.
 * `rate` is tax ÷ taxable value, as a percent to two places; the fallback is used when
 * the estimate carries tax but no line is taxable (reported, never silent).
 */
export function planEstimateFix(sfEstimate, sfLines, { jurisdiction = null, fallbackRate = null } = {}) {
  const out = {};
  const tax = Number(sfEstimate.Tax_Amount__c) || 0;
  let note = null;
  if (sfEstimate.Tax_Rate__c == null && tax > 0) {
    const taxable = (sfLines || []).filter((l) => l.Taxable__c === true && l.Stage__c !== "Removed").reduce((sum, l) => sum + (Number(l.Line_Total__c) || (Number(l.Quantity__c) || 0) * (Number(l.Unit_Price__c) || 0)), 0);
    if (taxable > 0) out.Tax_Rate__c = Math.round((tax / taxable) * 10000) / 100;
    else if (fallbackRate != null) {
      out.Tax_Rate__c = fallbackRate;
      note = "tax with no taxable line — fallback rate";
    } else note = "tax with no taxable line — no rate written";
  }
  if (jurisdiction && s(sfEstimate.Tax_Jurisdiction__c) === "") out.Tax_Jurisdiction__c = jurisdiction;
  return Object.keys(out).length || note ? { fields: Object.keys(out).length ? out : null, note } : null;
}

/** One CSV line, quoted. */
export const csvLine = (cells) => cells.map((c) => `"${s(c).replace(/"/g, '""')}"`).join(",");
