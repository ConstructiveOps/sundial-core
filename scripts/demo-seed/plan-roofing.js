// plan-roofing.js — the 10 roofing jobs (7 roofing-only customers + 3 re-roofs tied to a
// solar project).
//
// The roofing STAGE list is read from the live org at run time. Today it holds a single
// placeholder value ("Stage 1"): the roofing-revamp package with the real pipeline
// (New … Paid) is written but not deployed. The jobs are spread over whatever stages exist
// on the day of the run, and the fields from the not-yet-deployed package are planned as
// optional — the preflight drops them with a warning until the package is in.

import { addDays, onWeekday } from "./dates.js";
import { ref } from "./tokens.js";
import { OBJ } from "./policy.js";
import { ROOFING_RATES, roofingMaterialCostFields } from "./budget-rates.js";
import { ROOFING_PM_KEY } from "./catalog.js";

export const ROOFING_COUNT = 10;
export const ROOFING_WITH_SOLAR = 3;

/** How far along a job at each KNOWN stage is. An unknown stage is treated as "Sold". */
const STAGE_RANK = Object.freeze({
  New: 0, "Inspection Scheduled": 1, "Budget In Progress": 2, "Proposal Sent": 3, Sold: 4, Scheduled: 5,
  "In Progress": 6, Complete: 7, Invoiced: 8, Paid: 9, Cancelled: 1,
});
const SOLD_RANK = 4;
const PRICE_PER_SQUARE = { shingle: 550, tile: 850, recoat: 400 };

export function designRoofing(profiles, { rng, schema, anchorDate }) {
  const R = OBJ.roofing;
  const stages = schema.values(R, "Stage__c");
  // Three solar customers whose project is waiting on (or just had) a new roof.
  const solar = profiles.filter((p) => p.kind === "solar" && p.n !== 1);
  const tied = [];
  for (const want of ["Re-Roof Needed", "Hold", "Scheduling"]) {
    const hit = solar.find((p) => p.solar.stage === want && !tied.includes(p));
    if (hit) tied.push(hit);
  }
  for (const p of solar) if (tied.length < ROOFING_WITH_SOLAR && !tied.includes(p)) tied.push(p);
  const owners = [...tied.slice(0, ROOFING_WITH_SOLAR), ...profiles.filter((p) => p.kind === "roofing")].slice(0, ROOFING_COUNT);
  owners.forEach((p, i) => {
    const r = rng.fork(p.key);
    const stage = stages.length ? stages[i % stages.length] : null;
    const rank = stage in STAGE_RANK ? STAGE_RANK[stage] : SOLD_RANK;
    const roofType = p.property.roofType || "Asphalt Shingle";
    const kind = /tile/i.test(roofType) ? "tile" : /flat|foam/i.test(roofType) ? "recoat" : "shingle";
    const squares = Math.round(((p.property.sqft * 1.2) / 100) * 10) / 10;
    const sold = rank >= SOLD_RANK && stage !== "Cancelled";
    p.roofing = {
      key: `roofing:${String(i + 1).padStart(3, "0")}`,
      stage, rank, kind, squares, roofType,
      withSolar: p.kind === "solar",
      scope: kind === "recoat" ? "Repair" : "Full Re-Roof",
      contractAmount: Math.round((squares * PRICE_PER_SQUARE[kind]) / 50) * 50,
      soldDate: sold ? onWeekday(addDays(anchorDate, -r.int(8, 40))) : null,
      known: stage in STAGE_RANK,
    };
  });
  const counts = new Map();
  for (const p of owners) counts.set(p.roofing.stage, (counts.get(p.roofing.stage) || 0) + 1);
  return { owners, stageMap: stages.map((stage) => ({ stage, known: stage in STAGE_RANK, count: counts.get(stage) || 0 })) };
}

/** The Sundial_Roofing__c record. */
export function roofingFields(profile, { pick, anchorDate, schema }) {
  const R = OBJ.roofing;
  const x = profile.roofing;
  const quoted = x.rank >= 3;
  const sold = !!x.soldDate;
  const f = {
    Client__c: ref("tenant"),
    Sundial_Customer__c: ref(profile.key),
    Project_Name__c: `${profile.person.last} ${x.kind === "recoat" ? "Roof Recoat" : "Re-Roof"}`,
    Stage__c: x.stage ?? undefined,
    Customer_Name_at_Creation__c: profile.person.name,
    Address_at_Creation__c: [profile.place.street, profile.place.city, profile.place.state, profile.place.zip].join(", "),
    Primary_Phone_at_Creation__c: profile.phone,
    Primary_Email_at_Creation__c: profile.email,
    Sales_Rep__c: ref(profile.repKey),
    Dealer__c: ref(profile.dealerKey),
    Project_Manager__c: ref(ROOFING_PM_KEY),
    Job_City__c: pick.one(R, "Job_City__c", profile.place.city),
    // How big the roof is, in squares (100 sq ft), under the material it is covered with.
    Squares_Shingle__c: x.kind === "shingle" ? x.squares : undefined,
    Squares_Tile__c: x.kind === "tile" ? x.squares : undefined,
    Squares_Recoat__c: x.kind === "recoat" ? x.squares : undefined,
    Contract_Presented_Amount__c: quoted ? x.contractAmount : undefined,
    // Invented labor rates and material unit costs, so the org's field defaults (Harmon's
    // real rates and supplier costs) never land on a demo record. No quantities are set:
    // the roofing budget itself is left for the owner to fill in during a demo.
    ...ROOFING_RATES,
    ...roofingMaterialCostFields(schema),
    // --- fields of the roofing-revamp package (optional until it is deployed) ---
    Sold_With_Solar__c: pick.one(R, "Sold_With_Solar__c", x.withSolar ? "Yes" : "No"),
    Sourced_From__c: pick.one(R, "Sourced_From__c", x.withSolar ? "Resi Job" : "Direct"),
    Roof_Type__c: pick.one(R, "Roof_Type__c", x.roofType === "Flat/Foam" ? "Foam" : x.roofType),
    Payment_Type__c: sold ? pick.any(R, "Payment_Type__c", ["Check", "Financed", "Credit Card", "Cash"], profile.n) : undefined,
    Deposit_Received__c: sold ? true : undefined,
    Deposit_Amount__c: sold ? Math.round(x.contractAmount * 0.25) : undefined,
    Deposit_Received_Date__c: sold ? x.soldDate : undefined,
    Final_Payment_Status__c: pick.one(R, "Final_Payment_Status__c", x.rank >= 9 ? "Received" : x.rank >= 8 ? "Invoiced" : "Not Billed"),
    Final_Payment_Received_Date__c: x.rank >= 9 ? onWeekday(addDays(anchorDate, -3)) : undefined,
    Notes__c: `DEMO DATA - fictional roofing job. ${x.squares} squares, ${x.roofType.toLowerCase()}.${x.withSolar ? " Solar array goes on after the roof is signed off." : ""}`,
  };
  return f;
}
