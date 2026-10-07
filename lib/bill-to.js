// lib/bill-to.js — who pays a service job (D-081, 2026-10-07).
//
// `Bill_To_Type__c` says WHAT KIND of payer (Customer / Internal Warranty / Manufacturer /
// Leasing Partner / Other) and keeps driving card-on-file, the hosted-page rule and the
// report marker. `Bill_To_Customer__c` says WHO: a Sundial_Customer__c in the same tenant
// (usually a company — SunRun, APS, a manufacturer). `Bill_To_Name__c` is DERIVED from that
// customer's display name, here and nowhere else, so every reader that already prints it
// (the report marker, the invoice card, the HCP backfill review) keeps working.
//
//   type Customer     → Bill_To_Customer__c null, Bill_To_Name__c null: the payer is the
//                       job's own Sundial_Customer__c
//   any other type    → Bill_To_Customer__c REQUIRED (400 BILL_TO_CUSTOMER_REQUIRED), must
//                       be a customer in the caller's tenant (another tenant's id gets the
//                       same 400 as an id that does not exist), name derived from it
//
// Both job write paths call resolveBillTo: the estimate Lambda's create (New Job / Create
// Job) and sundial-sf-update's PATCH /sf/job/{id} (the job page). A caller can no longer
// set Bill_To_Name__c — stripDerivedBillToName drops it before anything is written.
//
// A rename of the payer customer does NOT flow back to its jobs (D-081, accepted): a job's
// derived name refreshes the next time that job's Bill To is saved; an issued invoice keeps
// the name it was issued with, by design.

import { customerDisplayName } from "./customer-name.js";

export const BILL_TO_SELF = "Customer";
/** What a payer read needs: the display-name inputs, and the address for the invoice snapshot. */
export const BILL_TO_CUSTOMER_SELECT =
  "Id, Name, First_Name__c, Last_Name__c, Is_Company__c, Company_Name__c, Street__c, City__c, State__c, Postal_Code__c, " +
  "Mailing_Street__c, Mailing_City__c, Mailing_State__c, Mailing_Postal_Code__c, Acumatica_Customer_ID__c";
const SF_ID_RE = /^[a-zA-Z0-9]{15,18}$/;
const s = (v) => (v == null ? "" : String(v).trim());

const fail = (code, message) => ({ ok: false, status: 400, code, message });

/** Case-insensitive key lookup — a PATCH body may spell a field in any case. */
export const keyOf = (obj, name) => Object.keys(obj || {}).find((k) => k.toLowerCase() === name.toLowerCase());

/**
 * Remove Bill_To_Name__c from a field map (it is derived). Returns { fields, dropped }.
 * The caller logs `dropped` once for the request; it is never an error.
 */
export function stripDerivedBillToName(fields) {
  const k = keyOf(fields, "Bill_To_Name__c");
  if (!k) return { fields, dropped: false };
  const { [k]: _gone, ...rest } = fields;
  return { fields: rest, dropped: true };
}

/** A tenant-scoped payer loader: (id) → the customer record, or null. */
export function billToCustomerLoader({ sfQuery, soqlEscapeString, tenantId }) {
  return async (id) => {
    if (!SF_ID_RE.test(s(id))) return null;
    const rows = await sfQuery(
      `SELECT ${BILL_TO_CUSTOMER_SELECT} FROM Sundial_Customer__c WHERE Id = '${soqlEscapeString(s(id))}' ` +
        `AND Client__c = '${soqlEscapeString(tenantId)}' LIMIT 1`
    );
    return rows?.[0] ?? null;
  };
}

/**
 * Decide the Bill To fields for a job write.
 *
 * @param {object} args
 * @param {string|undefined}      args.type        Bill_To_Type__c in this write (undefined = not touched)
 * @param {string|null|undefined} args.customerId  Bill_To_Customer__c in this write (undefined = not touched)
 * @param {object|null}           args.before      the job as it is (null on create): { Bill_To_Type__c, Bill_To_Customer__c }
 * @param {(id:string)=>Promise<object|null>} args.loadCustomer  tenant-scoped (billToCustomerLoader)
 * @returns {Promise<{ok:true, fields:object, payer:object|null} | {ok:false, status:number, code:string, message:string}>}
 *   `fields` holds only what this write must set (empty when Bill To is untouched).
 */
export async function resolveBillTo({ type, customerId, before = null, loadCustomer }) {
  if (type === undefined && customerId === undefined) return { ok: true, fields: {}, payer: null };
  const effType = s(type !== undefined ? type : before?.Bill_To_Type__c) || BILL_TO_SELF;
  const effCustomer = customerId !== undefined ? s(customerId) || null : s(before?.Bill_To_Customer__c) || null;
  const fields = {};
  if (type !== undefined) fields.Bill_To_Type__c = effType;

  if (effType === BILL_TO_SELF) {
    // The job's own customer pays: no second record, no derived name.
    fields.Bill_To_Customer__c = null;
    fields.Bill_To_Name__c = null;
    return { ok: true, fields, payer: null };
  }
  if (!effCustomer) {
    return fail("BILL_TO_CUSTOMER_REQUIRED", `Bill To "${effType}" needs the paying customer (Bill_To_Customer__c) — pick the company that pays.`);
  }
  if (!SF_ID_RE.test(effCustomer)) return fail("BILL_TO_CUSTOMER_INVALID", "Bill_To_Customer__c must be a customer record id.");
  const payer = await loadCustomer(effCustomer);
  if (!payer) return fail("BILL_TO_CUSTOMER_NOT_FOUND", "That paying customer was not found.");
  fields.Bill_To_Customer__c = payer.Id;
  fields.Bill_To_Name__c = (customerDisplayName(payer) || "").slice(0, 255) || null;
  return { ok: true, fields, payer };
}
