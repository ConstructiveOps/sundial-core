// plan-solar.js — the 50 residential solar projects.
//
// Each project sits at one pipeline stage and carries the fields a real project would
// have BY THAT STAGE — and none from later stages. The way that is done:
//
//   1. STEPS is the life of a project as an ordered list of milestones, each a few days
//      after the one before.
//   2. STAGE_RULES says, for every stage of the live pipeline, which milestone was the
//      last one reached (plus the odd extra: a future install date, a hold, a go-back).
//   3. For one project the milestones up to that point get real dates, counted BACKWARDS
//      from the run's anchor date, so the latest milestone was "a few days ago" — a
//      project in "Install Scheduled" was sold about two months ago and installs next
//      week. Milestones after that point get no date at all.
//
// The stage names come from the LIVE picklist. A stage this file has never heard of is
// still used (the pipeline board needs a card in every column); it is filled like a
// freshly sold project and reported in the dry run.

import { addDays, onWeekday, phxTime, addWorkdays } from "./dates.js";
import { ref } from "./tokens.js";
import { OBJ } from "./policy.js";
import { ADDERS, adderSoldTotal, solarBudgetFields } from "./budget-rates.js";
import { INSTALLER_NAME, IN_HOUSE_SALES_COMPANY, SOLAR_PM_KEY, ROOFING_PM_KEY, persona, UTILITY_APS } from "./catalog.js";

export const SOLAR_COUNT = 50;

/** Milestones in order: [name, min days after the previous one, max days]. */
export const STEPS = Object.freeze([
  ["sold", 0, 0],
  ["kickoff", 1, 3],
  ["auditScheduled", 1, 3],
  ["audit", 3, 7],
  ["auditPhotos", 0, 1],
  ["auditFinal", 1, 3],
  ["designApproved", 1, 2],
  ["designReview", 4, 7],
  ["designReviewDone", 1, 2],
  ["pmReady", 0, 1],
  ["pmReviewed", 1, 3],
  ["hoSent", 0, 1],
  ["hoApproved", 1, 4],
  ["permitApproved", 0, 2],
  ["permitApplied", 1, 3],
  ["permitReceived", 9, 18],
  ["utilitySubmitted", 1, 3],
  ["utilityApproved", 7, 14],
  ["scheduledReview", 1, 3],
  ["installStart", 6, 12],
  ["installEnd", 1, 2],
  ["inspectionBooked", 1, 3],
  ["inspection", 4, 9],
  ["inspectionPass", 0, 1],
  ["utilityDocs", 1, 3],
  ["meterSet", 4, 8],
  ["pto", 5, 12],
  ["finalInvoiced", 1, 2],
  ["finalPaid", 5, 14],
  ["closeoutDocs", 2, 5],
  ["closed", 3, 7],
]);
const STEP_INDEX = Object.fromEntries(STEPS.map(([name], i) => [name, i]));

/**
 * Every known stage -> the last milestone reached, and what is special about it.
 *   future: a milestone that is BOOKED but has not happened (its date is after the anchor)
 *   customer: the Status / Stage the customer record shows for a project at this stage
 */
const SOLD = { status: "Customer", stage: "Sold" };
const INSTALLED = { status: "Customer", stage: "Sold - Installed" };
export const STAGE_RULES = Object.freeze({
  "Sold - Pending Review": { done: "sold", customer: { status: "Customer", stage: "Sold - Pending Review" }, note: "Contract in. Waiting on the contract review before kickoff." },
  "Audit": { done: "kickoff", customer: { status: "Customer", stage: "Sold - Final Review" }, note: "Ready to book the site audit with the homeowner." },
  "Site survey scheduled": { done: "auditScheduled", future: "audit", customer: SOLD, note: "Site survey is booked; crew confirmed with the homeowner." },
  "Audit Photos Received": { done: "auditPhotos", customer: SOLD, note: "Audit photos uploaded. Compiling findings." },
  "Design Ordered": { done: "designApproved", customer: SOLD, note: "Design ordered. Expecting the plan set this week." },
  "Utility Input": { done: "designApproved", utilityInput: "open", customer: SOLD, note: "Waiting on the utility to confirm the service size before design is finalised." },
  "Design Received": { done: "designReview", customer: SOLD, note: "Plan set received, internal review under way." },
  "PM Review": { done: "pmReady", customer: SOLD, note: "Plan set with the PM for review against the contract." },
  "Re-Roof Needed": { done: "pmReviewed", reroof: true, customer: SOLD, note: "Audit found the roof needs replacing before install. Roofing quote sent." },
  "Sent HO Design": { done: "hoSent", customer: SOLD, note: "Design sent to the homeowner for sign-off." },
  "HOA Pending": { done: "hoApproved", hoa: "pending", customer: SOLD, note: "Homeowner approved. HOA application submitted, waiting on the board." },
  "Permitting": { done: "permitApproved", customer: SOLD, note: "Approved for permitting. Package being assembled." },
  "Permit Submitted": { done: "permitApplied", customer: SOLD, note: "Permit submitted to the city. Typical turnaround two to three weeks." },
  "Permitting Received": { done: "permitReceived", customer: SOLD, note: "Permit issued." },
  "Interconnection": { done: "permitReceived", interconnectionPrep: true, customer: SOLD, note: "Preparing the interconnection application." },
  "Interconnection Submitted": { done: "utilitySubmitted", customer: SOLD, note: "Interconnection application submitted to the utility." },
  "Scheduling": { done: "utilityApproved", tentativeInstall: true, customer: SOLD, note: "Utility approved. Working out an install date with the homeowner." },
  "Install Scheduled": { done: "scheduledReview", future: "installStart", customer: SOLD, note: "Install date confirmed with the homeowner. Materials staged." },
  "Post Installation": { done: "installEnd", customer: INSTALLED, note: "Install complete. Booking the city inspection." },
  "Post Install/Pending MPU": { done: "installEnd", mpu: true, customer: INSTALLED, note: "Array is up. Main panel upgrade still to be done before inspection." },
  "Post Install/Pending BUS/MSA": { done: "installEnd", busMsa: true, customer: INSTALLED, note: "Array is up. Waiting on the utility's BUS/MSA paperwork." },
  "Inspection Scheduled": { done: "inspectionBooked", future: "inspection", customer: INSTALLED, note: "City inspection booked." },
  "Inspection Completed": { done: "inspection", customer: INSTALLED, note: "Inspector on site. Waiting for the result to post." },
  "Green Tagged": { done: "inspectionPass", customer: INSTALLED, note: "Passed inspection. Sending final documents to the utility." },
  "Go Back Items Needed": { done: "inspection", goBack: "needed", customer: INSTALLED, note: "Inspector asked for two corrections. Go-back being scheduled." },
  "Go Back Items Complete": { done: "inspection", goBack: "complete", customer: INSTALLED, note: "Go-back items done. Re-inspection requested." },
  "Awaiting Bird Blocking": { done: "inspectionPass", birdBlocking: true, customer: INSTALLED, note: "System passed. Bird blocking still to be fitted." },
  "Billing": { done: "finalInvoiced", customer: INSTALLED, note: "Permission to operate received. Final invoice sent." },
  "Billing Complete - Pending Closeout": { done: "finalPaid", customer: INSTALLED, note: "Paid in full. Closeout packet being prepared." },
  "Request to Archive": { done: "closeoutDocs", customer: INSTALLED, note: "Closeout documents sent to the homeowner. Ready to archive." },
  "Archive": { done: "closed", lag: [10, 45], customer: { status: "Past Customer", stage: "Sold - Archived" }, note: "Project complete and archived." },
  "Hold": { done: "permitApplied", hold: true, customer: { status: "Customer", stage: "Hold" }, note: "On hold at the homeowner's request." },
  "Cancelled - Awaiting Sales to Resell": { done: "designReview", cancelled: "resell", lag: [5, 20], customer: { status: "Customer", stage: "Cancelled" }, note: "Cancelled after design. Back with sales to re-present." },
  "Cancelled": { done: "audit", cancelled: "final", lag: [5, 20], customer: { status: "Customer", stage: "Cancelled" }, note: "Cancelled by the homeowner." },
});
/**
 * "Sold - Pending Review" is the stage a fresh sale lands in — on the customer AND on the
 * solar project — and the stage Harmon's Salesforce alerts and record-triggered Flows are
 * built around (docs/salesforce-schema.md). Whether that automation looks at the tenant
 * cannot be read from here (the integration user cannot list Flows), so neither object is
 * put in that stage unless the owner asks with --with-sold-pending-review:
 *   the customer sits one stage EARLIER ("Processing Documents"),
 *   the project one stage LATER ("Audit").
 */
export const GATED_STAGE = "Sold - Pending Review";
export const SAFE_NEWLY_SOLD_CUSTOMER_STAGE = "Processing Documents";
export const SAFE_NEWLY_SOLD_SOLAR_STAGE = "Audit";

/** Where the extra 16 projects go, beyond one per stage: the busy middle of the pipeline. */
const EXTRA_STAGE_WEIGHTS = [
  ["Design Ordered", 1], ["Design Received", 1], ["PM Review", 1], ["Permitting", 1], ["Permit Submitted", 2],
  ["Permitting Received", 1], ["Interconnection Submitted", 1], ["Scheduling", 1], ["Install Scheduled", 2],
  ["Post Installation", 1], ["Inspection Scheduled", 2], ["Inspection Completed", 1], ["Green Tagged", 1],
];

/** 50 stages: every live stage once, the rest weighted to the active middle. */
export function solarStageList(liveStages, count = SOLAR_COUNT) {
  const out = liveStages.slice(0, count);
  const extras = [];
  for (const [stage, n] of EXTRA_STAGE_WEIGHTS) if (liveStages.includes(stage)) for (let i = 0; i < n; i++) extras.push(stage);
  // If the live pipeline has changed shape, keep cycling whatever exists until 50 are placed.
  const pool = extras.length ? extras : liveStages;
  for (let i = 0; out.length < count && pool.length; i++) out.push(pool[i % pool.length]);
  return out;
}

const PANELS = [
  { solar: "Hanwha Q.Peak Duo BLK ML-G10+ 410w", customer: "Qcells - Q.PEAK DUO BLK ML-G10+ 410", watts: 410 },
  { solar: "Hyundai HiN-T440NF(BK)", customer: "Hyundai Energy Solutions - HiN-T440NF(BK)", watts: 440 },
  { solar: "Q.TRON BLK M-G2.H1+/AC 430", customer: "Qcells - Q.TRON BLK M-G2.H1+/AC 430", watts: 430 },
  { solar: "SEG-440-BTD-BG", customer: "SEG Solar Inc - SEG-440-BTD-BG", watts: 440 },
  { solar: "Silfab SIL-440 QD - DCB", customer: "Silfab Solar - SIL-440 QD-DCB 4", watts: 440 },
  { solar: "Jinko JKM430N-54HL4-B", customer: null, watts: 430 },
  { solar: "REC420AA Pure 2", customer: null, watts: 420 },
];
const MICROINVERTERS = ["Enphase IQ8MC-72-M-US", "Enphase IQ8 Plus", "Enphase IQ8HC-72-M-DOM-US", "Enphase IQ8M-72-2-US"];
const BATTERY_INVERTERS = ["Tesla PW3 Integrated", "Tesla 7.6 kW inverter"];

const money = (n) => Math.round(n * 100) / 100;

/** The equipment, the money and the stage of one project — everything but the dates. */
function designSystem(profile, stage, rng, schema) {
  const S = OBJ.solar;
  const livePanels = PANELS.filter((p) => schema.isLive(S, "Panel_Type__c", p.solar));
  const panel = livePanels.length ? rng.pick(livePanels) : { solar: null, customer: null, watts: 410 };
  // 4.8–14.4 kW, in whole panels.
  const targetKw = rng.stepped(4.8, 14.4, 0.4);
  let panels = Math.round((targetKw * 1000) / panel.watts);
  while ((panels * panel.watts) / 1000 < 4.8) panels++;
  while ((panels * panel.watts) / 1000 > 14.4) panels--;
  const watts = panels * panel.watts;
  const sizeKw = money(watts / 1000);

  const hasBattery = rng.chance(0.3);
  const batteryType = hasBattery ? schema.firstLive(S, "Battery_Type__c", rng.shuffle(["Powerwall 3", "FranklinWH aPower2", "Encharge 10"])) : null;
  const batteryQty = hasBattery ? rng.weighted([[1, 3], [2, 1]]) : 0;
  const teslaBattery = batteryType === "Powerwall 3";
  const inverter = teslaBattery
    ? schema.firstLive(S, "Inverter_Type__c", BATTERY_INVERTERS)
    : schema.firstLive(S, "Inverter_Type__c", rng.shuffle(MICROINVERTERS));
  const microinverters = !teslaBattery;

  const roof = profile.property.roofType;
  const flat = /flat|foam/i.test(roof || "");
  const tile = /tile/i.test(roof || "");
  const mounting = schema.firstLive(S, "Mounting__c", flat ? ["Tilt", "Flush/Tilt", "Flush"] : ["Flush"]);

  const finance = rng.weighted([["Cash", 30], ["Finance", 45], ["Lease", 25]]);
  const mpu = rng.chance(0.14);
  const ev = rng.chance(0.1);

  const adderQty = { Software_Fee: 1 };
  if (mpu) adderQty.Upgrade_225 = 1;
  if (rng.chance(0.25)) adderQty.Bird_Blocking = 1;
  if (rng.chance(0.15)) adderQty.Conduit_Attic = 1;
  if (tile && rng.chance(0.6)) adderQty.Roof_Tile = 1;
  if (flat) adderQty.Flat_Roof = 1;
  if (rng.chance(0.4)) adderQty.Active_Monitoring = 1;
  if (rng.chance(0.1)) adderQty.Structural = 1;
  if (panels <= 12) adderQty.Small_System_10_12 = 1;
  else if (panels <= 15) adderQty.Small_System_13_15 = 1;
  if (hasBattery && finance === "Lease") adderQty.LR_Battery_Warranty = 1;
  const ns = rng.chance(0.1) ? { description: "Trenching 40 ft to the detached garage (sample)", material: 400, hours: 8 } : null;

  const ppw = rng.stepped(2.6, 3.4, 0.05);
  const budgetInput = { watts, panelWatts: panel.watts, panels, batteryQty, microinverters, adderQty, ns };
  const contractAmount = money(ppw * watts + adderSoldTotal(budgetInput));
  const termYears = finance === "Cash" ? null : 25;
  const apr = finance === "Finance" ? rng.pick([5.99, 6.49, 6.99, 7.49]) : null;
  const monthly = finance === "Cash" ? null : money(Math.round((contractAmount / (termYears * 12)) * (finance === "Finance" ? 1.75 : 1.2)));
  const annualUsage = Math.round((sizeKw * rng.stepped(1550, 1750, 10)) / 50) * 50;
  const offset = rng.int(88, 104);
  return {
    stage, panel, panels, watts, sizeKw, hasBattery, batteryType, batteryQty, inverter, microinverters, mounting, finance,
    mpu, ev, adderQty, ns, ppw, contractAmount, termYears, apr, monthly, annualUsage, offset, budgetInput,
    avgBill: rng.stepped(140, 420, 5),
    firstYearKwh: Math.round((annualUsage * offset) / 100 / 10) * 10,
    arrays: rng.int(1, 3),
    hoaRequired: rng.chance(0.3),
  };
}

/**
 * Dates for the milestones reached, counted back from the anchor.
 * @returns {{ at: Record<string,string>, future: Record<string,string>, soldDaysAgo:number }}
 */
function buildTimeline(rule, rng, anchorDate) {
  const doneIdx = STEP_INDEX[rule.done];
  const offsets = [];
  let cursor = 0;
  for (let i = 0; i <= doneIdx; i++) {
    const [, lo, hi] = STEPS[i];
    cursor += rng.int(lo, hi);
    offsets.push(cursor);
  }
  const [lagLo, lagHi] = rule.lag || [1, 5];
  const lag = rng.int(lagLo, lagHi);
  const sold = addDays(anchorDate, -(cursor + lag));
  const at = {};
  // Milestones land on working days; moving a weekend date back to Friday keeps the order.
  for (let i = 0; i <= doneIdx; i++) at[STEPS[i][0]] = onWeekday(addDays(sold, offsets[i]));
  const future = {};
  if (rule.future === "audit") future.audit = addWorkdays(anchorDate, rng.int(1, 4));
  if (rule.future === "installStart") future.installStart = addWorkdays(anchorDate, rng.int(4, 8));
  if (rule.future === "inspection") future.inspection = addWorkdays(anchorDate, rng.int(2, 5));
  if (rule.tentativeInstall) future.tentativeInstall = addWorkdays(anchorDate, rng.int(8, 15));
  return { at, future, soldDaysAgo: cursor + lag };
}

/**
 * Design all the projects. Adds `profile.solar` to each of the first 50 profiles.
 * @returns {{ stageMap: Array<{stage, known, count}>, warnings: string[], gated: null | { stage, customerKey, solarKey, used, movedTo } }}
 */
export function designSolarProjects(profiles, { rng, schema, anchorDate, options }) {
  const S = OBJ.solar;
  const warnings = [];
  const liveStages = schema.values(S, "Stage__c");
  const solarProfiles = profiles.filter((p) => p.kind === "solar");
  let stages = rng.shuffle(solarStageList(liveStages, solarProfiles.length));
  // The FIRST project is the canary: written alone and compared field by field. Put a
  // busy mid-pipeline stage there so the canary carries plenty of fields, and its customer
  // is a plain "Sold" one (the welcome-call guard is what a sold-stage Flow would test).
  const canaryStage = ["Permit Submitted", "Permitting Received", "Design Received"].find((s) => stages.includes(s));
  if (canaryStage) {
    const i = stages.indexOf(canaryStage);
    [stages[0], stages[i]] = [stages[i], stages[0]];
  }
  // The project that would sit in the gated stage. Without the opt-in it moves to the next
  // stage — AFTER the shuffle, so every other project is identical with or without the flag.
  const gatedIndex = stages.indexOf(GATED_STAGE);
  let gated = null;
  if (gatedIndex >= 0 && solarProfiles[gatedIndex]) {
    const safe = liveStages.includes(SAFE_NEWLY_SOLD_SOLAR_STAGE) ? SAFE_NEWLY_SOLD_SOLAR_STAGE : liveStages.find((x) => x !== GATED_STAGE) ?? null;
    const profile = solarProfiles[gatedIndex];
    gated = { stage: GATED_STAGE, customerKey: profile.key, solarKey: `solar:${profile.key.split(":")[1]}`, used: !!options.withSoldPendingReview || !safe, movedTo: null };
    if (!gated.used) {
      stages[gatedIndex] = safe;
      gated.movedTo = safe;
    } else if (!options.withSoldPendingReview) {
      warnings.push(`Solar stage "${GATED_STAGE}" is the only live stage, so the demo project stays in it even without --with-sold-pending-review.`);
    }
  }
  solarProfiles.forEach((profile, i) => {
    const stage = stages[i] ?? liveStages[0];
    const r = rng.fork(profile.key);
    const known = STAGE_RULES[stage];
    if (!known && !warnings.some((w) => w.includes(`"${stage}"`))) {
      warnings.push(`Solar stage "${stage}" is not one this script knows; its projects are filled like a freshly sold project.`);
    }
    const rule = known || { done: "sold", customer: { status: "Customer", stage: "Sold" }, note: "Sold." };
    const design = designSystem(profile, stage, r, schema);
    const timeline = buildTimeline(rule, r, anchorDate);
    let customer = rule.customer;
    // Customer "Sold - Pending Review" is the stage Harmon's Salesforce alerts fire on
    // (docs/salesforce-schema.md). Whether those alerts look at the tenant is unknowable
    // from here, so the demo keeps its newly sold customers one stage earlier unless the
    // owner explicitly asks for the real value.
    if (customer.stage === GATED_STAGE && !options.withSoldPendingReview) {
      customer = { status: customer.status, stage: SAFE_NEWLY_SOLD_CUSTOMER_STAGE };
    }
    // The project that was moved on from the gated stage: its CUSTOMER stays the newly sold
    // one (one stage before the gated stage), exactly as when only the customer was gated.
    if (gated && !gated.used && i === gatedIndex) customer = { status: "Customer", stage: SAFE_NEWLY_SOLD_CUSTOMER_STAGE };
    profile.solar = { key: `solar:${profile.key.split(":")[1]}`, stage, rule, known: !!known, customer, ...design, timeline };
  });
  const counts = new Map();
  for (const p of solarProfiles) counts.set(p.solar.stage, (counts.get(p.solar.stage) || 0) + 1);
  const stageMap = liveStages.map((stage) => ({ stage, known: !!STAGE_RULES[stage], count: counts.get(stage) || 0, reached: STAGE_RULES[stage]?.done ?? "sold" }));
  return { stageMap, warnings, gated };
}

const reached = (rule, step) => STEP_INDEX[step] <= STEP_INDEX[rule.done];

/** The Sundial_Solar__c record for one customer. Undefined values are dropped by the caller. */
export function solarFields(profile, { schema, anchorDate, pick }) {
  const S = OBJ.solar;
  const s = profile.solar;
  const { rule, timeline } = s;
  const t = timeline.at;
  const rep = persona(profile.repKey);
  const pm = persona(profile.roofing ? ROOFING_PM_KEY : SOLAR_PM_KEY);
  const inHouse = profile.salesCompany === IN_HOUSE_SALES_COMPANY;
  const address = `${profile.place.street}, ${profile.place.city}, ${profile.place.state} ${profile.place.zip}`;
  const aps = profile.place.utility === UTILITY_APS;
  const n = Number(profile.key.split(":")[1]);
  const has = (step) => reached(rule, step);
  const past = (d) => (d && d <= anchorDate ? d : undefined);

  const f = {
    Client__c: ref("tenant"),
    Sundial_Customer__c: ref(profile.key),
    Project_Name__c: `${profile.person.last} Residence - ${s.sizeKw} kW`,
    Stage__c: s.stage,
    Stage_Notes__c: rule.note,
    // The four snapshots every project object carries (CLAUDE.md "Snapshot Pattern").
    Customer_Name_at_Creation__c: profile.person.name,
    Address_at_Creation__c: address,
    Primary_Phone_at_Creation__c: profile.phone,
    Primary_Email_at_Creation__c: profile.email,
    First_Name__c: profile.person.first,
    Last_Name__c: profile.person.last,
    Email__c: profile.email,
    Phone__c: profile.phone,
    Address__c: address,
    City__c: profile.place.city,
    County__c: profile.place.county,
    State__c: pick.one(S, "State__c", profile.place.state),
    Zip_Code__c: profile.place.zip,
    Authority_Having_Jurisdiction__c: profile.place.ahj,
    Best_Method_to_Contact__c: pick.one(S, "Best_Method_to_Contact__c", profile.contactMethod === "Text" ? "SMS" : profile.contactMethod),
    // Who sold it. Sales roles see a record only when BOTH the rep and the rep's dealer are stamped.
    Sales_Rep__c: ref(profile.repKey),
    Dealer__c: ref(profile.dealerKey),
    Sales_Representative__c: rep.name,
    Sales_Company_Harmon_Solar_or_Third__c: inHouse ? IN_HOUSE_SALES_COMPANY : profile.dealerName,
    PM_Name__c: pm.name,
    Solar_Installer__c: INSTALLER_NAME,
    Job_Type__c: pick.one(S, "Job_Type__c", "new_install"),
    // Contract
    Sales_Type__c: pick.one(S, "Sales_Type__c", s.finance),
    Sales_Type_Partner__c: pick.one(S, "Sales_Type_Partner__c", { Cash: "Cash", Finance: "Credit Human", Lease: "LightReach" }[s.finance]),
    Contract_Type__c: pick.one(S, "Contract_Type__c", { Cash: "Cash Purchase", Finance: "Credit Human", Lease: "Light Reach" }[s.finance]),
    Leasing_Partner__c: s.finance === "Lease" ? pick.one(S, "Leasing_Partner__c", "LightReach") : undefined,
    Lease_ID_Number__c: s.finance === "Lease" ? `LR-DEMO-${String(1000 + n)}` : undefined,
    Contract_Amount__c: s.contractAmount,
    Price_per_Watt__c: s.ppw,
    System_Size__c: s.sizeKw,
    Monthly_Payment__c: s.monthly ?? undefined,
    Annual_Percentage_Rate__c: s.apr ? `${s.apr}%` : undefined,
    Contract_Term_Years_Annual_Percentage__c: s.finance === "Finance" ? `${s.termYears} yrs, ${s.apr}% APR` : s.finance === "Lease" ? `${s.termYears} yr lease` : undefined,
    Contract_Date__c: t.sold,
    Contract_Signed_Date__c: t.sold,
    Sold_Date__c: t.sold,
    Passed_to_Operations_Date__c: past(onWeekday(addDays(t.sold, 1))) ?? t.sold,
    Average_Electric_Bill__c: s.avgBill,
    Annual_Usage__c: s.annualUsage,
    Contract_Offset__c: `${s.offset}%`,
    Contract_Inverter_Model__c: s.inverter ?? undefined,
    Contract_Utility_Account_Holder_Name__c: profile.person.name,
    // Equipment
    Panel_Type__c: s.panel.solar ?? undefined,
    Number_of_Panels__c: s.panels,
    Panel_Quantity__c: s.panels,
    Inverter_Type__c: s.inverter ?? undefined,
    Inverter_Quantity__c: s.microinverters ? s.panels : 1,
    Number_of_Inverters__c: s.microinverters ? s.panels : 1,
    Battery__c: s.hasBattery,
    Battery_Type__c: s.batteryType ?? undefined,
    Battery_Quantity__c: s.hasBattery ? s.batteryQty : undefined,
    Electric_Vehicle_Charger__c: s.ev,
    Electric_Vehicle_Charger_Type__c: s.ev ? pick.any(S, "Electric_Vehicle_Charger_Type__c", ["Chargepoint", "Clipper Creek", "Tesla"], n) : undefined,
    Mounting__c: s.mounting ?? undefined,
    Roof_Type__c: pick.one(S, "Roof_Type__c", profile.property.roofType),
    Home_Construction_Year__c: String(profile.property.yearBuilt),
    Square_Footage__c: String(profile.property.sqft),
    Main_Panel_Upgrade_Required__c: s.mpu,
    Service_Entrance_Section_Upgrade__c: pick.one(S, "Service_Entrance_Section_Upgrade__c", s.mpu ? "Yes" : "No"),
    Bird_Blocking__c: !!s.adderQty.Bird_Blocking,
    Conduit_Run_in_Attic__c: !!s.adderQty.Conduit_Attic,
    // Utility
    Utility_Company__c: pick.one(S, "Utility_Company__c", profile.place.utility),
    Utility_Account_Number__c: profile.utilityAccount,
    Meter_Number__c: profile.meterNumber,
    Equipment_Behind_Fence__c: profile.behindFence,
    Fence_Gate_Code__c: profile.behindFence ? profile.gateCode : undefined,
    Gate_Code__c: profile.behindFence ? profile.gateCode : undefined,
    Animals_on_Location__c: profile.hasDog,
    Last_Contact_Date__c: onWeekday(addDays(anchorDate, -((n % 6) + 1))),
    // Budget INPUTS only — see budget-rates.js. Outputs are left for the calculator.
    ...solarBudgetFields(s.budgetInput),
  };
  if (s.finance !== "Cash") {
    const credit = onWeekday(addDays(t.sold, -2));
    f.Credit_Approved_Date__c = credit;
    f.Credit_Expiration_Date__c = addDays(credit, 180);
  }
  const active = !rule.cancelled && !rule.hold && rule.done !== "closed";
  if (active) f.Next_Customer_Update_Date__c = addWorkdays(anchorDate, (n % 4) + 2);

  if (has("kickoff")) {
    f.Project_Kickoff_Date_Job__c = t.kickoff;
    f.Project_Kickoff_Date_Customer__c = t.kickoff;
    f.Audit_Ready_to_Be_Scheduled__c = true;
    f.Audit_Type__c = pick.one(S, "Audit_Type__c", s.hasBattery && s.panels === 0 ? "Battery Only" : s.adderQty.Structural ? "Structural" : "Standard");
  }
  if (has("auditScheduled")) {
    const auditDay = t.audit ?? timeline.future.audit;
    f.Contract_Signed_to_Audit_Scheduled__c = phxTime(t.auditScheduled, "10:00");
    f.Audit_Scheduled_Date__c = auditDay;
    f.Audit_Scheduled__c = phxTime(auditDay, "09:00");
    f.Audit_Date_and_DateTime__c = auditDay;
  }
  if (has("audit")) {
    f.Audit_Date__c = t.audit;
    f.Preliminary_Audit_Findings__c = `${profile.property.roofType || "Roof"} in ${String(profile.property.roofCondition || "good").toLowerCase()} condition. Main service panel ${s.mpu ? "is 100A and will need an upgrade" : "is 200A with room for the solar breaker"}. Attic access clear.`;
    f.Roof_Review_Required__c = /tile/i.test(profile.property.roofType || "") || !!rule.reroof;
  }
  if (has("auditPhotos")) f.Audit_Photos_Received__c = t.auditPhotos;
  if (has("auditFinal")) {
    f.Compilation_Findings__c = "Roof planes measured, shading checked, electrical photos reviewed. No changes to the contracted system size.";
    f.Compilation_Findings_Complete__c = t.auditFinal;
    f.Audit_Finalized_and_Complete__c = t.auditFinal;
    if (f.Roof_Review_Required__c) f.Roof_Review_Complete__c = pick.one(S, "Roof_Review_Complete__c", "Yes");
  }
  if (has("designApproved")) {
    f.Approved_for_Design_Date__c = t.designApproved;
    f.Expected_Design_Complete_Date__c = addWorkdays(t.designApproved, 5);
  }
  if (rule.utilityInput === "open") {
    f.Utility_Input_Needed__c = t.designApproved;
    f.Utility_Input_Requested__c = t.designApproved;
    f.Utility_Input_Reason__c = "Service size on the utility record does not match the panel label. Asked the utility to confirm before the design is finalised.";
  }
  if (has("designReview")) {
    f.Design_Internal_Review__c = t.designReview;
    f.Number_of_Arrays__c = s.arrays;
    f.Azimuth__c = ["180", "180 / 270", "90 / 180 / 270"][s.arrays - 1];
    f.Pitch__c = /flat|foam/i.test(profile.property.roofType || "") ? "5 (tilt kit 10)" : "18";
    f.Solar_Offset__c = s.offset;
    f.First_Year_Production__c = `${s.firstYearKwh.toLocaleString("en-US")} kWh`;
    f.Requires_Engineering_Stamp__c = !!s.adderQty.Structural;
  }
  if (has("designReviewDone")) f.Design_Internal_Review_Completed__c = t.designReviewDone;
  if (has("pmReady")) f.Plan_Set_Ready_for_Project_Manager__c = t.pmReady;
  if (has("pmReviewed")) {
    f.Project_Manager_Reviewed_Plans_and__c = t.pmReviewed;
    f.Finalized_Budget_Date__c = t.pmReviewed;
    f.Internal_Cost_Adders_Captured__c = t.pmReviewed;
    if (!inHouse) {
      f.Adders_Sent_to_Salesperson_Dealer__c = phxTime(t.pmReviewed, "14:30");
      if (has("hoApproved")) f.Dealer_Responded__c = t.hoSent;
    }
    if (s.finance !== "Cash") {
      f.Notice_to_Proceed_Submitted_Date_When__c = t.pmReviewed;
      f.Notice_to_Proceed_Granted__c = true;
    }
  }
  if (rule.reroof) {
    f.Re_Roof_Needs__c = "Underlayment is at end of life on the south and west planes. Full re-roof recommended before the array goes on.";
    f.Roof_Recommendations__c = "Replace underlayment and broken tiles, then re-inspect.";
    f.Full_Re_Roof_Quoted_Amount__c = 14500;
    f.Roofing_Notes__c = "Roofing quote sent to the homeowner. Solar install waits on the roof.";
  }
  if (has("hoApproved")) {
    f.Homeowner_Approved_Plans__c = t.hoApproved;
    const hoa = rule.hoa === "pending" || s.hoaRequired;
    f.Homeowners_Association_Required__c = pick.one(S, "Homeowners_Association_Required__c", hoa ? "Yes" : "No");
    if (hoa) {
      f.Homeowners_Association_Name__c = `${profile.place.city} Ridge Community Association (sample)`;
      f.Homeowners_Association_Contact__c = "Architectural review committee";
      f.Homeowners_Association_Applied__c = t.hoApproved;
      // The board has answered on every project that moved past the HOA stage.
      if (rule.hoa !== "pending" && has("permitApplied")) f.Homeowners_Association_Approved__c = t.permitApproved;
    }
  }
  if (has("permitApproved")) {
    f.Approved_for_Permitting__c = t.permitApproved;
    f.Permit_Type__c = pick.one(S, "Permit_Type__c", "PV");
    if (s.mpu) f.Permit_Type_2__c = pick.one(S, "Permit_Type_2__c", "MPU");
  }
  if (has("permitApplied")) {
    f.Permit_Applied_Date__c = t.permitApplied;
    f.Permit_Fee__c = 250 + (n % 4) * 25;
    if (s.mpu && f.Permit_Type_2__c) f.Permit_Applied_Date_2__c = t.permitApplied;
  }
  if (has("permitReceived")) {
    f.Permit_Received__c = t.permitReceived;
    f.Permit_Number__c = `PV${t.permitReceived.slice(2, 4)}-${String(40000 + n * 37).slice(0, 5)}`;
    if (s.mpu && f.Permit_Type_2__c) f.Permit_Received_2__c = t.permitReceived;
    f.Permitting_Notes__c = "Approved as submitted.";
  }
  if (rule.interconnectionPrep) f.Utility_Interconnection_Agreement_Notes__c = "Interconnection packet drafted. Waiting on the homeowner's signature on the utility agreement.";
  if (has("utilitySubmitted")) {
    f.Utility_Application_Submitted_Date__c = t.utilitySubmitted;
    f.Utility_Application_Reference__c = `${aps ? "APS" : "SRP"}-DEMO-${String(70000 + n * 113)}`;
    if (aps) f.Arizona_Public_Service_Reservation__c = `RES-DEMO-${String(5000 + n)}`;
  }
  if (has("utilityApproved")) {
    f.Utility_Application_Approved_Date__c = t.utilityApproved;
    if (timeline.future.tentativeInstall) f.Tentative_Install_Date__c = timeline.future.tentativeInstall;
  }
  const dueM1 = money(s.contractAmount * 0.1);
  const dueM2 = money(s.contractAmount * 0.4);
  const dueM3 = money(s.contractAmount - dueM1 - dueM2);
  if (has("scheduledReview")) {
    const installDay = t.installStart ?? timeline.future.installStart;
    const days = s.panels > 26 || s.hasBattery ? 2 : 1;
    f.Reviewed_Job_for_Scheduling__c = true;
    f.Assigned_Crew__c = pick.any(S, "Assigned_Crew__c", ["Crew 1", "Crew 2", "Crew 3"], n);
    f.Tentative_Install_Date__c = installDay;
    f.Scheduled_Install_Date__c = installDay;
    f.Installation_Date_Confirmed_Customer__c = true;
    f.Days_for_Install__c = days;
    f.Estimated_Install_Complete_Date__c = t.installEnd ?? addWorkdays(installDay, days - 1);
    // Milestone 1 (deposit / first funding) is due once the job is ready to schedule.
    f.Down_Payment_10_Amount_Due__c = dueM1;
    f.Down_Payment_Received__c = t.scheduledReview;
  }
  if (has("installStart")) {
    f.Install_Start_DateTime__c = phxTime(t.installStart, "07:00");
    f.Stanchion_Installation__c = t.installStart;
  }
  if (has("installEnd")) {
    f.Install_End_DateTime__c = phxTime(t.installEnd, "15:30");
    f.Install_Complete__c = t.installEnd;
    f.Post_Stanchion_Notes__c = "All attachments flashed and sealed. Array and conduit runs photographed.";
    // Milestone 2 is invoiced at install complete.
    f.Second_Payment_Amount_Due__c = dueM2;
    f.Second_Payment_40_Invoiced__c = past(onWeekday(addDays(t.installEnd, 1))) ?? t.installEnd;
  }
  if (rule.mpu) {
    f.Main_Panel_Upgrade_Required__c = true;
    f.Service_Entrance_Section_Upgrade__c = pick.one(S, "Service_Entrance_Section_Upgrade__c", "Yes");
    f.Service_Entrance_Section_Upgrade_Date__c = addWorkdays(anchorDate, 6);
  }
  if (has("inspectionBooked")) {
    f.QAQC_Inspection_Confirmed_with_Customer__c = t.inspectionBooked;
    f.Final_Inspection_Date__c = t.inspection ?? timeline.future.inspection;
  }
  if (has("inspection")) {
    f.Final_Inspection_Date__c = t.inspection;
    f.Sent_City_Inspection_Complete__c = true;
    f.Second_Payment_Received_Date__c = past(onWeekday(addDays(t.installEnd, 6))) ?? t.inspection;
    f.Inspection_Details__c = rule.goBack
      ? "Inspector asked for two corrections: label the AC disconnect and add a conduit strap at the eave."
      : "Inspector on site, no corrections noted.";
  }
  if (rule.goBack) {
    f.Go_Back_Needed__c = t.inspection;
    f.Go_Back_Description__c = "1) Replace the AC disconnect label. 2) Add one conduit strap at the eave on the east run.";
    if (rule.goBack === "complete") f.Go_Back_Completed__c = past(addWorkdays(t.inspection, 2)) ?? t.inspection;
  }
  if (has("inspectionPass")) {
    f.Inspection_Pass_Date__c = t.inspectionPass;
    f.Web_Inspection_Key_Code__c = `WEB-${String(200000 + n * 911).slice(0, 6)}`;
  }
  if (rule.birdBlocking) f.Bird_Blocking__c = true;
  if (has("utilityDocs")) f.Final_Documents_Uploaded_to_Utility__c = t.utilityDocs;
  if (has("meterSet")) f.Meter_Set_Requested_Notification__c = t.meterSet;
  if (has("pto")) {
    f.Commission_of_System__c = t.pto;
    f.Active_System_Monitoring__c = true;
  }
  if (has("finalInvoiced")) {
    f.Final_Payment_Amount_Due__c = dueM3;
    f.Final_Payment_50_Invoiced__c = t.finalInvoiced;
  }
  if (has("finalPaid")) {
    f.Final_Payment_Received_Date__c = t.finalPaid;
    f.Billing_Notes__c = "All three milestones received.";
  }
  if (has("closeoutDocs")) f.Closeout_Documents_Sent_to_Homeowner__c = t.closeoutDocs;
  if (has("closed")) {
    f.Project_Closeout__c = t.closed;
    f.Close_Date__c = t.closed;
  }
  if (rule.hold) {
    f.Project_on_Hold__c = onWeekday(addDays(anchorDate, -((n % 5) + 3)));
    f.Reason_for_Hold__c = profile.roofing
      ? "Homeowner is re-roofing first. Install resumes when the roof is signed off."
      : "Homeowner asked to pause until the end of the month while they finalise a refinance.";
  }
  if (rule.cancelled) {
    const cancelDay = onWeekday(addDays(anchorDate, -((n % 4) + 2)));
    f.Project_Cancellation_Requested__c = onWeekday(addDays(cancelDay, -2));
    f.Project_Cancelled__c = cancelDay;
    f.Cancel_Notes__c = rule.cancelled === "resell"
      ? "Homeowner cancelled after the design changed the panel count. Sales is preparing a revised offer."
      : "Homeowner decided not to go ahead. No costs incurred beyond the audit.";
    if (rule.cancelled === "resell") f.Sent_to_Sales_to_Resell__c = cancelDay;
  }
  // The adders chosen on this deal, as one readable line for the PM.
  const chosen = ADDERS.filter((a) => (s.adderQty[a.base] ?? 0) > 0).map((a) => a.label);
  f.Notes__c = `DEMO DATA - fictional project. ${s.panels} x ${s.panel.watts} W panels${s.hasBattery ? `, ${s.batteryQty} battery` : ""}. Adders: ${chosen.length ? chosen.join(", ") : "none"}.`;
  void schema;
  return f;
}
