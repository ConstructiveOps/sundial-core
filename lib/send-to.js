// lib/send-to.js — who an estimate or an invoice is SENT to (2026-10-16, D-072 amendment 12).
//
// The portal always shows a send box (email + text), prefilled from `sendDefaults` and
// editable. The server decides, in this order, for the email and the phone separately:
//
//   1. what the office typed in the box (`to` / `toPhone` in the request body);
//   2. the PAYER — the Bill_To_Customer__c record, when someone other than the homeowner
//      pays (the estimate's own Bill To; for an invoice, the payer it froze at issue);
//   3. the document's own customer (the Sundial_Customer__c record), then its snapshot.
//
// A `via` that needs an address the order cannot supply is a 400 RECIPIENT_REQUIRED naming
// which (`missing: ["email"]`, `["phone"]` or both) — refused BEFORE anything is recorded.
// A typed address that is not an email / a North American phone is a 400 RECIPIENT_INVALID.
//
// Pure: the caller loads the records, this decides. Value-safety: nothing here logs.

import { customerDisplayName } from "./customer-name.js";
import { toE164 } from "./twilio.js";

export const SEND_VIAS = Object.freeze(["Email", "SMS", "Both"]);
/** The customer fields the resolution reads, for the payer and the customer alike. */
export const RECIPIENT_SELECT = "Id, Name, First_Name__c, Last_Name__c, Is_Company__c, Company_Name__c, Primary_Email__c, Primary_Phone__c";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const s = (v) => (v == null ? "" : String(v).trim());

export const isEmail = (v) => EMAIL_RE.test(s(v));
export const needsEmail = (via) => via === "Email" || via === "Both";
export const needsPhone = (via) => via === "SMS" || via === "Both";

/** A body's `via`, defaulting to Email; "Manual" (record only) passes through for the estimate. */
export function viaFrom(body, { allowManual = false } = {}) {
  const v = body?.via;
  if (SEND_VIAS.includes(v)) return v;
  if (allowManual && v === "Manual") return v;
  return "Email";
}

/**
 * What the send box prefills: the payer's address when a payer record pays, else the
 * customer's (then the snapshot). `source` says whose it is; `name` is what to call them.
 *
 * @param {object} args
 * @param {object|null} args.payer     the Bill_To_Customer__c record (null when the homeowner pays)
 * @param {object|null} args.customer  the document's Sundial_Customer__c record
 * @param {object}      [args.snapshot] { email, phone, name } from the document's own snapshot fields
 */
export function sendDefaults({ payer = null, customer = null, snapshot = {} }) {
  const email = (payer && s(payer.Primary_Email__c)) || s(customer?.Primary_Email__c) || s(snapshot.email) || null;
  const phone = (payer && toE164(payer.Primary_Phone__c)) || toE164(customer?.Primary_Phone__c) || toE164(snapshot.phone) || null;
  const source = payer ? "billTo" : "customer";
  const name = (payer ? customerDisplayName(payer) : customerDisplayName(customer) || s(snapshot.name)) || null;
  return { email, phone, source, name };
}

/**
 * The recipients one send uses.
 * @returns {{ ok:true, email:string|null, phone:string|null, source:string, name:string|null }
 *          | { ok:false, status:400, code:"RECIPIENT_REQUIRED"|"RECIPIENT_INVALID", missing?:string[], invalid?:string[], message:string }}
 *   `email` / `phone` are set only when the `via` uses them.
 */
export function resolveRecipients({ via, to, toPhone, payer = null, customer = null, snapshot = {} }) {
  const invalid = [];
  const typedEmail = s(to);
  const typedPhone = s(toPhone);
  if (typedEmail && !isEmail(typedEmail)) invalid.push("email");
  if (typedPhone && !toE164(typedPhone)) invalid.push("phone");
  if (invalid.length) {
    return { ok: false, status: 400, code: "RECIPIENT_INVALID", invalid, message: `That ${invalid.join(" and ")} is not valid.` };
  }
  const defaults = sendDefaults({ payer, customer, snapshot });
  const email = needsEmail(via) ? typedEmail || defaults.email : null;
  const phone = needsPhone(via) ? (typedPhone ? toE164(typedPhone) : defaults.phone) : null;
  const missing = [];
  if (needsEmail(via) && !email) missing.push("email");
  if (needsPhone(via) && !phone) missing.push("phone");
  if (missing.length) {
    return {
      ok: false,
      status: 400,
      code: "RECIPIENT_REQUIRED",
      missing,
      message: `There is no ${missing.join(" or ")} on file to send to — type one in the send box.`,
    };
  }
  return { ok: true, email, phone, source: defaults.source, name: defaults.name };
}
