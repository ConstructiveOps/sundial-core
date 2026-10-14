// Put HCP customer notes back on the lead customers the import stripped them from (2026-10-14).
//
// WHY. The HCP import's leads phase wrote the lead block ("HCP lead #… · status", tags, job
// type) into Sundial_Customer__c.Description__c and REPLACED the customer's own HCP notes,
// which the customers phase had just written there (Harmon, Ben: "migrated without the
// historical notes"). lib/hcp-import.js now keeps them (leadDescription); this plans the
// repair of the records already written, for scripts/hcp-restore-lead-notes.mjs.
//
// A record is repaired only when its Description__c is still EXACTLY what the import wrote —
// one of its leads' blocks, optionally followed by the import's archive line. Anything else
// means a person edited it, and a hand edit is never overwritten: it is listed instead.
// The repaired text is leadDescription(notes, existing text): notes, a blank line, then the
// block and archive line exactly as they were.
//
// Pure: no Salesforce, no file reads. Nothing here logs.

import { ARCHIVE_NOTE } from "./hcp-disposition.js";
import { HCP_ID_FIELD, customerNotesText, leadBlock, leadDescription, leadJobTypeName } from "./hcp-import.js";

export const DESCRIPTION_MAX = 32000; // Description__c is Long Text Area(32000)
const s = (v) => (v == null ? "" : String(v).trim());
const nl = (v) => String(v ?? "").replace(/\r\n/g, "\n");

/** Is `desc` exactly the import's text for this lead block (with or without its archive line)? */
export function isImportText(desc, block) {
  const d = nl(desc).trim();
  if (!block) return false;
  if (d === block) return true;
  const prefix = `${block}\n${ARCHIVE_NOTE}: `;
  return d.startsWith(prefix) && !d.slice(prefix.length).includes("\n");
}

/**
 * Plan the repair.
 * @param {object} p
 * @param {Array}  p.records       Sundial customers ({ Id, Name, HCP_Id__c, Description__c })
 * @param {Array}  p.customersHcp  the pull's customers.json
 * @param {Array}  p.leadsHcp      the pull's leads.json
 * @param {Map}    p.jobTypes      HCP job type id → name
 * @param {object} p.idMapCustomers id-map.json `customers` (HCP id → { sfId, created })
 * @returns {{ writes: Array, edited: Array, linked: Array, counts: object }}
 */
export function planLeadNotesRestore({ records, customersHcp, leadsHcp, jobTypes = new Map(), idMapCustomers = {} }) {
  const customerById = new Map(customersHcp.map((c) => [s(c.id), c]));
  // A customer embedded on a lead but missing from customers.json (the import's customerPool does the same)
  for (const l of leadsHcp) if (l.customer?.id && !customerById.has(s(l.customer.id))) customerById.set(s(l.customer.id), l.customer);

  // Every HCP customer id that landed on a Sundial record: its own HCP_Id__c, plus any second
  // HCP record of the same household (a "shared" link) whose leads were written there too.
  const hcpIdsBySf = new Map();
  const add = (sfId, hcpId) => {
    if (!sfId || !hcpId) return;
    if (!hcpIdsBySf.has(sfId)) hcpIdsBySf.set(sfId, new Set());
    hcpIdsBySf.get(sfId).add(hcpId);
  };
  for (const [hcpId, v] of Object.entries(idMapCustomers)) add(v?.sfId, hcpId);
  for (const r of records) add(r.Id, s(r[HCP_ID_FIELD]));
  const leadsByHcp = new Map();
  for (const l of leadsHcp) {
    const cid = s(l.customer?.id);
    if (!leadsByHcp.has(cid)) leadsByHcp.set(cid, []);
    leadsByHcp.get(cid).push(l);
  }

  const counts = { scanned: 0, notLeadBlock: 0, linked: 0, noNotes: 0, alreadyRestored: 0, edited: 0, tooLong: 0, restore: 0 };
  const writes = [];
  const edited = [];
  const linked = [];
  for (const r of records) {
    const hcpId = s(r[HCP_ID_FIELD]);
    if (!hcpId) continue;
    counts.scanned += 1;
    const desc = nl(r.Description__c).trim();
    if (!desc.startsWith("HCP lead #")) {
      counts.notLeadBlock += 1;
      continue;
    }
    // Only a record the import CREATED (create / refresh). A linked record is Sales's: the
    // lead block replaced Sales's own text there, which the pull cannot give back — listed.
    if (idMapCustomers[hcpId]?.created !== true) {
      counts.linked += 1;
      linked.push({ id: r.Id, name: s(r.Name), hcp_id: hcpId });
      continue;
    }
    const notes = customerNotesText(customerById.get(hcpId));
    if (!notes) {
      counts.noNotes += 1;
      continue;
    }
    if (desc.includes(notes.replace(/\r\n/g, "\n"))) {
      counts.alreadyRestored += 1;
      continue;
    }
    const leads = [...(hcpIdsBySf.get(r.Id) || [hcpId])].flatMap((id) => leadsByHcp.get(id) || []);
    const matched = leads.find((l) => isImportText(desc, leadBlock(l, leadJobTypeName(l, jobTypes))));
    if (!matched) {
      counts.edited += 1;
      edited.push({ id: r.Id, name: s(r.Name), hcp_id: hcpId, description: desc });
      continue;
    }
    const clean = nl(notes).trim();
    // leadDescription truncates at the field's limit; a repair must never cut the block off instead
    if (clean.length + 2 + desc.length > DESCRIPTION_MAX) {
      counts.tooLong += 1;
      edited.push({ id: r.Id, name: s(r.Name), hcp_id: hcpId, description: desc, reason: `notes + block over ${DESCRIPTION_MAX} characters` });
      continue;
    }
    counts.restore += 1;
    writes.push({ id: r.Id, name: s(r.Name), hcp_id: hcpId, lead: s(matched.number) || s(matched.id), before: desc, after: leadDescription(clean, desc, null) });
  }
  return { writes, edited, linked, counts };
}
