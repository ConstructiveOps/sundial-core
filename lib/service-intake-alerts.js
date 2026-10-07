// lib/service-intake-alerts.js — the two always-on Service intake alerts (Harmon, 2026-10-02).
//
//   1. A Service customer appears with nobody in Assigned To — created, or brought back from
//      the archive — → every ACTIVE Admin / Manager / Executive whose default department is
//      Service hears it (the person who did it is left out; they know).
//   2. Someone is put in Assigned To → that person hears it (not when they assigned themselves).
//
// Both ride on `lib/notify.js` under ONE category, `service_intake`, which the Settings page
// does not list (TECH_CATEGORIES / OFFICE_CATEGORIES): there is no switch for it, so it is on
// for as long as the person has notifications at all — exactly what Harmon asked. Emitted
// from the estimate Lambda (the Service popups, Add to Service, the un-archive on reuse) and
// from sundial-sf-update (the customer page's own edits: Assigned To, Archive / Unarchive).
// Best-effort like every notification: never a reason to fail the write.

import { CATEGORIES, recordPath } from "./notify.js";

export const SERVICE_INTAKE_CATEGORY = CATEGORIES.SERVICE_INTAKE;
/** Who hears about an unowned Service customer: these levels, in this department. */
export const SERVICE_MANAGER_LEVELS = Object.freeze(["Admin", "Manager", "Executive"]);
export const SERVICE_DEPARTMENT = "Service"; // Default_Department__c — "Service Operations" on the screen

const s = (v) => (v == null ? "" : String(v).trim());
const esc = (v) => s(v).replace(/\\/g, "\\\\").replace(/'/g, "\\'");

/** Is this customer the Service module's (Customer_Type__c includes Service)? */
export function isServiceCustomer(customer) {
  return s(customer?.Customer_Type__c).split(";").map((x) => x.trim()).includes("Service");
}

/** The Sundial_User__c ids that hear about an unowned customer, for one tenant. */
export async function serviceManagerIds(sfQuery, tenantId) {
  if (!tenantId) return [];
  const levels = SERVICE_MANAGER_LEVELS.map((l) => `'${esc(l)}'`).join(", ");
  const rows = await sfQuery(
    `SELECT Id FROM Sundial_User__c WHERE Client__c = '${esc(tenantId)}' AND Active__c = true ` +
      `AND Access_Level__c IN (${levels}) AND Default_Department__c = '${esc(SERVICE_DEPARTMENT)}'`,
  );
  return (rows || []).map((r) => r.Id).filter(Boolean);
}

/** The customer's name for a title: the hub Name, else first + last, else "A customer". */
export function customerLabel(customer) {
  return s(customer?.Name) || [s(customer?.First_Name__c), s(customer?.Last_Name__c)].filter(Boolean).join(" ") || "A customer";
}

/**
 * Alert 1. `reason` is "created" | "unarchived". Returns the notifier's result (or a skip).
 * Guarded: a notifier failure is logged, never thrown.
 */
export async function alertUnassignedCustomer({ notifier, sfQuery, tenantId, customer, reason = "created", actorUserSfId = null, now = new Date() }) {
  try {
    if (!notifier || !customer?.Id || s(customer.Assigned_To__c)) return { inserted: 0, skipped: 0, pushed: 0, reason: "assigned" };
    const managers = (await serviceManagerIds(sfQuery, tenantId)).filter((id) => id !== actorUserSfId);
    if (!managers.length) return { inserted: 0, skipped: 0, pushed: 0, reason: "no_managers" };
    const name = customerLabel(customer);
    const title = reason === "unarchived" ? `${name} is back in Service — nobody assigned` : `New Service customer — nobody assigned`;
    const body = reason === "unarchived" ? `${name} was un-archived and has no one in Assigned To.` : `${name} was added with no one in Assigned To.`;
    return await notifier.toUsers({
      tenantId,
      userSfIds: managers,
      category: SERVICE_INTAKE_CATEGORY,
      kind: "customer_unassigned",
      title,
      body,
      url: recordPath("servicecustomer", customer.Id), // the Service view (2026-10-07) — the alert is about service
      recordType: "customer",
      recordSfId: customer.Id,
      dedupeKey: `service_intake:unassigned:${customer.Id}:${reason}:${now.toISOString().slice(0, 16)}`,
    });
  } catch (e) {
    console.error("service intake alert (unassigned) threw:", e?.message || e);
    return { inserted: 0, skipped: 0, pushed: 0, reason: "threw" };
  }
}

/**
 * Alert 2. `assignedToSfId` is the Sundial_User__c now in Assigned To; the actor assigning
 * themselves hears nothing (they just did it).
 */
export async function alertAssigned({ notifier, tenantId, customer, assignedToSfId, actorUserSfId = null, actorName = null, now = new Date() }) {
  try {
    if (!notifier || !customer?.Id || !s(assignedToSfId)) return { inserted: 0, skipped: 0, pushed: 0, reason: "no_assignee" };
    if (assignedToSfId === actorUserSfId) return { inserted: 0, skipped: 0, pushed: 0, reason: "self" };
    const name = customerLabel(customer);
    return await notifier.toUsers({
      tenantId,
      userSfIds: [assignedToSfId],
      category: SERVICE_INTAKE_CATEGORY,
      kind: "customer_assigned",
      title: `${name} was assigned to you`,
      body: actorName ? `${actorName} put you in Assigned To on this Service customer.` : "You are now in Assigned To on this Service customer.",
      url: recordPath("servicecustomer", customer.Id), // the Service view (2026-10-07) — the alert is about service
      recordType: "customer",
      recordSfId: customer.Id,
      dedupeKey: `service_intake:assigned:${customer.Id}:${assignedToSfId}:${now.toISOString().slice(0, 16)}`,
    });
  } catch (e) {
    console.error("service intake alert (assigned) threw:", e?.message || e);
    return { inserted: 0, skipped: 0, pushed: 0, reason: "threw" };
  }
}
