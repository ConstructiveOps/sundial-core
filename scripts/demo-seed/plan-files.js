// plan-files.js — about 25 small sample PDFs for the Files tabs (--with-files).
//
// The plan only says WHICH record gets WHICH document and what is printed on it; the PDF
// bytes are generated at write time (files-phase.js). Every page says
// "SAMPLE - DEMO DATA" so a printed page can never be mistaken for a real document.

import { OBJ } from "./policy.js";
import { STEPS } from "./plan-solar.js";

const stepIdx = Object.fromEntries(STEPS.map(([n], i) => [n, i]));
const reached = (profile, step) => stepIdx[step] <= stepIdx[profile.solar.rule.done];

export function planFiles({ profiles, service }) {
  const files = [];
  const add = (recordKey, objectType, title, category, lines) =>
    files.push({
      key: `file:${String(files.length + 1).padStart(2, "0")}`,
      recordKey, objectType, title, category,
      fileName: `${title.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_|_$/g, "")}.pdf`,
      lines,
    });
  const who = (p) => [`Customer: ${p.person.name}`, `Address: ${p.place.street}, ${p.place.city}, ${p.place.state} ${p.place.zip}`];

  const solar = profiles.filter((p) => p.kind === "solar" && !p.solar.rule.cancelled);
  // Customers: the signed contract and a utility bill.
  for (const p of solar.slice(0, 3)) add(p.key, OBJ.customer, "Signed Contract (sample)", "Contract", [...who(p), `System: ${p.solar.sizeKw} kW, ${p.solar.panels} panels`, `Contract amount: $${p.solar.contractAmount.toLocaleString("en-US")}`, `Signed: ${p.solar.timeline.at.sold}`]);
  for (const p of solar.slice(3, 6)) add(p.key, OBJ.customer, "Utility Bill (sample)", "Utility", [...who(p), `Utility: ${p.place.utility}`, `Average bill: $${p.solar.avgBill}`, `Annual usage: ${p.solar.annualUsage.toLocaleString("en-US")} kWh`]);
  // Solar projects: one document per milestone reached.
  const docs = [
    ["audit", "Site Survey Report (sample)", "Audit", (p) => [`Survey date: ${p.solar.timeline.at.audit}`, `Roof: ${p.property.roofType}`, "Findings: no changes to the contracted system."]],
    ["permitReceived", "Permit Approval (sample)", "Permitting", (p) => [`Authority: ${p.place.ahj}`, `Issued: ${p.solar.timeline.at.permitReceived}`]],
    ["utilityApproved", "Interconnection Approval (sample)", "Utility", (p) => [`Utility: ${p.place.utility}`, `Approved: ${p.solar.timeline.at.utilityApproved}`]],
    ["inspectionPass", "Final Inspection (sample)", "Inspection", (p) => [`Authority: ${p.place.ahj}`, `Passed: ${p.solar.timeline.at.inspectionPass}`]],
  ];
  let solarFiles = 0;
  for (const [step, title, category, extra] of docs) {
    for (const p of solar.filter((x) => reached(x, step)).slice(0, 3)) {
      if (solarFiles >= 12) break;
      add(p.solar.key, OBJ.solar, title, category, [...who(p), `Project: ${p.person.last} Residence - ${p.solar.sizeKw} kW`, ...extra(p)]);
      solarFiles++;
    }
  }
  // Service: a job report on finished jobs, the estimate on sent estimates.
  for (const j of service.jobs.filter((x) => ["Paid", "Closed", "Invoiced", "Ready to Bill"].includes(x.status)).slice(0, 4)) {
    add(j.key, OBJ.job, "Service Report (sample)", "Job Report", [...who(j.profile), `Issue: ${j.scenario.issue}`, `Work done: ${j.scenario.work}`]);
  }
  for (const e of service.estimates.filter((x) => x.status !== "Draft").slice(0, 3)) {
    const p = profiles.find((x) => x.key === e.profileKey);
    add(e.key, OBJ.estimate, "Estimate (sample)", "Estimate", [...who(p), `Scope: ${e.scenario.issue}`, `Total: $${e.totals.total.toFixed(2)}`]);
  }
  return files;
}
