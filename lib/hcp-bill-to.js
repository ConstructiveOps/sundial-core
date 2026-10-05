// lib/hcp-bill-to.js — who pays an HCP job, read off its title (Harmon, 2026-10-05).
//
// Housecall Pro has no Bill-To. Harmon's office encoded the payer in the job's one-line
// `description` — "Solar - SunRun Standard Truck Roll", "Solar - SMA RMA", "Other - APS
// Quoted Cost", "Solar - Warranty Repair" — so the first import stamped every job
// `Bill_To_Type__c = Customer` (#7 on Harmon's 2026-10-05 list) and left `Service_Type__c`
// blank. These rules read the title back. They are a best guess from a free-text field:
// every job the rules decide by keyword is listed in `bill-to-review.csv` for the office,
// and a job whose title says nothing stays Customer.
//
// Also here: `jobNotesText` — HCP's `notes` is a LIST of `{ id, content }`, which the first
// import stringified to "[object Object]" (#6 on the same list).

const s = (v) => (v == null ? "" : String(v).trim());

/** The job's notes as one text block, blank-line separated, in HCP's order. */
export function jobNotesText(job) {
  const notes = Array.isArray(job?.notes) ? job.notes : typeof job?.notes === "string" ? [{ content: job.notes }] : [];
  return notes.map((n) => s(n?.content)).filter(Boolean).join("\n\n");
}

/** `Bill_To_Type__c` picklist (Sundial_Service_Job__c). */
export const BILL_TO = Object.freeze({ customer: "Customer", warranty: "Internal Warranty", manufacturer: "Manufacturer", leasing: "Leasing Partner", other: "Other" });
/** `Service_Type__c` picklist. */
export const SERVICE_TYPE = Object.freeze({ warranty: "Warranty", paid: "Paid Service", monitoring: "Monitoring Follow-up", maintenance: "Maintenance", upgrade: "Upgrade", partner: "Partner Work Order" });

/** Partners that appear by name in Harmon's titles, in the order they are tried. */
const PARTNERS = [
  { re: /sun\s*run/i, name: "SunRun", type: BILL_TO.leasing },
  { re: /spruce/i, name: "Spruce Power", type: BILL_TO.leasing },
  { re: /omnidian/i, name: "Omnidian", type: BILL_TO.other },
  { re: /charge\s*point|chpt\b/i, name: "ChargePoint", type: BILL_TO.other },
  { re: /\baps\b/i, name: "APS", type: BILL_TO.other },
];
/** Manufacturers whose RMA (return / replacement authorization) work they pay for. */
const BRANDS = [
  { re: /\bsma\b/i, name: "SMA" },
  { re: /tesla/i, name: "Tesla" },
  { re: /q\s*cells?\b/i, name: "Qcells" },
  { re: /fronius/i, name: "Fronius" },
  { re: /enphase/i, name: "Enphase" },
  { re: /solar\s*edge/i, name: "SolarEdge" },
  { re: /generac/i, name: "Generac" },
  { re: /tigo/i, name: "Tigo" },
];

/**
 * `{ billToType, billToName, serviceType, rule }` for one HCP job title. `rule` names what
 * decided it ("partner:SunRun", "rma:SMA", "rma", "warranty", "maintenance", "paid",
 * "customer") so the review CSV can group by it; `billToName` is null when the title names
 * no payer. A blank title gives `{ … Customer, serviceType: null, rule: "blank" }`.
 */
export function billToFromTitle(description) {
  const title = s(description);
  if (!title) return { billToType: BILL_TO.customer, billToName: null, serviceType: null, rule: "blank" };
  const partner = PARTNERS.find((p) => p.re.test(title));
  if (partner) return { billToType: partner.type, billToName: partner.name, serviceType: SERVICE_TYPE.partner, rule: `partner:${partner.name}` };
  if (/\brma\b/i.test(title)) {
    const brand = BRANDS.find((b) => b.re.test(title));
    return { billToType: BILL_TO.manufacturer, billToName: brand?.name ?? null, serviceType: SERVICE_TYPE.warranty, rule: brand ? `rma:${brand.name}` : "rma" };
  }
  // "Non Warranty Repair" is the customer's; plain "warranty" is Harmon's own workmanship / parts.
  if (/non[\s-]*warran/i.test(title)) return { billToType: BILL_TO.customer, billToName: null, serviceType: SERVICE_TYPE.paid, rule: "non-warranty" };
  if (/warran/i.test(title)) return { billToType: BILL_TO.warranty, billToName: null, serviceType: SERVICE_TYPE.warranty, rule: "warranty" }; // "WARRAN", "WARRANT" too — the titles were typed by hand
  if (/o\s*&\s*m|maintain|maintenance|inspection|cleaning|bird/i.test(title)) return { billToType: BILL_TO.customer, billToName: null, serviceType: SERVICE_TYPE.maintenance, rule: "maintenance" };
  if (/monitoring/i.test(title)) return { billToType: BILL_TO.customer, billToName: null, serviceType: SERVICE_TYPE.monitoring, rule: "monitoring" };
  if (/quoted|standard|service call|labor|dispatch|removal|r&r|reinstall|repair|install|truck roll/i.test(title)) return { billToType: BILL_TO.customer, billToName: null, serviceType: SERVICE_TYPE.paid, rule: "paid" };
  return { billToType: BILL_TO.customer, billToName: null, serviceType: null, rule: "customer" };
}

/** The job fields the title decides — only the ones it can (no `Service_Type__c` for a blank title). */
export function billToFields(description) {
  const r = billToFromTitle(description);
  const out = { Bill_To_Type__c: r.billToType };
  if (r.billToName) out.Bill_To_Name__c = r.billToName;
  if (r.serviceType) out.Service_Type__c = r.serviceType;
  return out;
}
