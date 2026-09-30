// plan-customers.js — the 100 demo customers (the hub every project hangs off).
//
//   customer:001–050   have a residential solar project (3 of them also a re-roof)
//   customer:051–072   sales pipeline only — one in every Lead and Opportunity stage
//   customer:073–079   roofing only
//   customer:080–100   service only (an existing system someone else installed)
//
// A customer record is written LAST in the planning (after the solar, roofing and service
// parts are designed) because its status, stage and type follow from what hangs off it.

import { addDays, addWorkdays, onWeekday, phxTime } from "./dates.js";
import { ref } from "./tokens.js";
import { OBJ } from "./policy.js";
import { customerAdderFields } from "./budget-rates.js";
import {
  createCast, persona, DEALERS, SALES_PEOPLE, IN_HOUSE_SALES_COMPANY, THIRD_PARTY_SALES_COMPANY, DISPATCHER_KEY,
} from "./catalog.js";

export const CUSTOMER_COUNT = 100;
export const PIPELINE_COUNT = 22;
export const ROOFING_ONLY_COUNT = 7;
export const SERVICE_ONLY_COUNT = 21;

/** Restricted list on the customer; only the generic values — never one naming a dealer or a person. */
export const GENERIC_LEAD_SOURCES = Object.freeze([
  "Referral", "Google", "Facebook AD", "Door Knocking", "Canvassing", "Web", "Previous Customer", "Google PPC",
  "Landing Page", "Internet", "Referral - External", "Walk-In", "Angi", "Bing", "Door Hanger", "EMAIL CAMPAIGN",
  "Marketing Campaign", "New Homeowner List", "Outbound Campaign", "Referral Partner", "Other",
]);

const C = OBJ.customer;
const pad3 = (n) => String(n).padStart(3, "0");
const money = (n) => Math.round(n * 100) / 100;

/** The people and places, before anything hangs off them. */
export function buildProfiles({ rng, schema, pick }) {
  const cast = createCast(rng.fork("cast"));
  const r = rng.fork("profiles");
  const leadSources = schema.liveSubset(C, "Lead_Source__c", GENERIC_LEAD_SOURCES);
  const roofTypes = [["Concrete Tile", 45], ["Asphalt Shingle", 30], ["Clay Tile", 10], ["Flat/Foam", 10], ["Metal", 5]].filter(([v]) => schema.isLive(C, "Roof_Type__c", v));
  const profiles = [];
  for (let n = 1; n <= CUSTOMER_COUNT; n++) {
    const kind = n <= 50 ? "solar" : n <= 50 + PIPELINE_COUNT ? "pipeline" : n <= 50 + PIPELINE_COUNT + ROOFING_ONLY_COUNT ? "roofing" : "service";
    const person = cast.person();
    const place = cast.place();
    const repKey = r.weighted(SALES_PEOPLE.map((s) => [s.key, s.share]));
    const rep = persona(repKey);
    const dealer = DEALERS.find((d) => d.key === rep.dealer);
    profiles.push({
      n,
      key: `customer:${pad3(n)}`,
      kind,
      person,
      place,
      phone: cast.phone(),
      phone2: r.chance(0.3) ? cast.phone() : null,
      email: person.email,
      repKey,
      dealerKey: dealer.key,
      dealerName: dealer.name,
      salesCompany: dealer.internal ? IN_HOUSE_SALES_COMPANY : THIRD_PARTY_SALES_COMPANY,
      contactMethod: r.weighted([["Phone", 5], ["Text", 3], ["Email", 2]]),
      bestTime: r.pick(["Morning", "Afternoon", "Evening", "Weekends"]),
      language: r.chance(0.12) ? "Spanish" : "English",
      leadSource: leadSources.length ? r.weighted(leadSources.map((v, i) => [v, Math.max(1, 12 - i)])) : null,
      property: {
        type: r.chance(0.9) ? "Single Family" : r.pick(["Townhome", "Multi-Family"]),
        yearBuilt: r.int(1978, 2021),
        sqft: r.stepped(1400, 3800, 50),
        roofType: roofTypes.length ? r.weighted(roofTypes) : null,
        roofAge: r.int(2, 24),
        roofCondition: r.weighted([["Good", 6], ["Fair", 3], ["Poor", 1]]),
        stories: r.chance(0.7) ? "1" : "2",
      },
      utilityAccount: String(r.int(1000000000, 9999999999)),
      meterNumber: `M${r.int(10000000, 99999999)}`,
      behindFence: r.chance(0.35),
      gateCode: `#${r.int(1000, 9999)}`,
      hasDog: r.chance(0.3),
      avgBill: r.stepped(120, 420, 5),
      liveDemo: false,
    });
  }
  void pick;
  return profiles;
}

/**
 * The three "live demo" customers: with --demo-phone / --demo-email they carry the
 * OWNER's phone and email so he can show real texts and emails arriving. They are chosen
 * by what hangs off them (decided in plan.js) and are never customers at a sold solar
 * stage — nothing about them can look like a new sale to an automation.
 */
export function applyLiveDemo(profiles, keys, { demoPhone, demoEmail }) {
  for (const p of profiles) {
    if (!keys.includes(p.key)) continue;
    p.liveDemo = true;
    if (demoPhone) p.phone = demoPhone;
    if (demoEmail) p.email = demoEmail;
  }
}

/** One Lead / Opportunity stage -> the fields a record at that stage would show. */
function pipelineFields(profile, status, stage, { anchorDate, pick, schema }) {
  const n = profile.n;
  const f = {};
  const day = (offset) => onWeekday(addDays(anchorDate, offset));
  const leadAge = { New: 1, "Contact Attempt Made": 5, "Follow Up": 12, "Not Interested": 20, DNQ: 16, "Wants for Free": 9, Hold: 40, Cancelled: 35 }[stage] ?? 25;
  f.Lead_Date__c = day(-(leadAge + (status === "Opportunity" ? 12 : 0)));
  f.Assigned_Date__c = f.Lead_Date__c;
  f.Average_Electric_Bill__c = profile.avgBill;
  f.Utility_Company__c = pick.one(C, "Utility_Company__c", profile.place.utility);
  const kw = money(Math.round(((profile.avgBill * 12) / 0.14 / 1650) * 2.5) / 2.5);
  const sizeKw = Math.min(14.4, Math.max(4.8, kw));

  if (status === "Lead") {
    switch (stage) {
      case "New":
        f.Call_Attempts__c = 0;
        f.Notes__c = "New enquiry. Wants to understand what solar would do to the summer bills.";
        break;
      case "Contact Attempt Made":
        f.Call_Attempts__c = 2;
        f.Last_Call_Attempt_Date__c = day(-1);
        f.Contact_Disposition__c = pick.one(C, "Contact_Disposition__c", "Left Voicemail");
        f.Next_Follow_Up_Date__c = addWorkdays(anchorDate, 1);
        f.Follow_Up_Needed__c = true;
        f.Outreach_Notes__c = "Two calls, voicemail left both times. Try again in the evening.";
        break;
      case "Not Interested":
        f.Call_Attempts__c = 2;
        f.First_Contact_Date__c = day(-8);
        f.Last_Contact_Date__c = day(-8);
        f.Contact_Disposition__c = pick.one(C, "Contact_Disposition__c", "Not Interested");
        f.Disqualification_Reason__c = pick.one(C, "Disqualification_Reason__c", "Not Interested");
        f.Outreach_Notes__c = "Spoke with the homeowner. Planning to move within two years, not interested right now.";
        break;
      case "DNQ":
        f.Call_Attempts__c = 1;
        f.First_Contact_Date__c = day(-10);
        f.Last_Contact_Date__c = day(-10);
        f.Contact_Disposition__c = pick.one(C, "Contact_Disposition__c", "Contacted");
        f.Qualified__c = false;
        f.Is_Homeowner__c = false;
        f.Disqualification_Reason__c = pick.one(C, "Disqualification_Reason__c", "Renter");
        f.Outreach_Notes__c = "Renting the home. Asked us to contact the landlord; no details given.";
        break;
      case "Wants for Free":
        f.Call_Attempts__c = 1;
        f.First_Contact_Date__c = day(-6);
        f.Last_Contact_Date__c = day(-6);
        f.Contact_Disposition__c = pick.one(C, "Contact_Disposition__c", "Contacted");
        f.Outreach_Notes__c = "Saw an advert for no-cost solar. Explained how a lease works; wants to think about it.";
        break;
      case "Follow Up":
        f.Call_Attempts__c = 3;
        f.First_Contact_Date__c = day(-9);
        f.Last_Contact_Date__c = day(-4);
        f.Contact_Disposition__c = pick.one(C, "Contact_Disposition__c", "Contacted");
        f.Next_Follow_Up_Date__c = addWorkdays(anchorDate, 3);
        f.Follow_Up_Needed__c = true;
        f.In_Nurture_Campaign__c = true;
        f.Outreach_Notes__c = "Interested but wants the last twelve months of bills to hand first. Call back Thursday.";
        break;
      case "Hold":
        f.Call_Attempts__c = 2;
        f.First_Contact_Date__c = day(-30);
        f.Last_Contact_Date__c = day(-22);
        f.Next_Follow_Up_Date__c = addWorkdays(anchorDate, 20);
        f.Outreach_Notes__c = "Asked us to call back after the roof inspection next month.";
        break;
      case "Cancelled":
        f.Call_Attempts__c = 4;
        f.Last_Call_Attempt_Date__c = day(-12);
        f.Contact_Disposition__c = pick.one(C, "Contact_Disposition__c", "No Answer");
        f.Cancellation_Date__c = day(-10);
        f.Cancellation_Reason__c = pick.one(C, "Cancellation_Reason__c", "Non-Responsive");
        break;
      default:
        f.Call_Attempts__c = 1;
    }
    return f;
  }

  // Opportunity: the homeowner has been reached, qualified and given an appointment.
  f.First_Contact_Date__c = day(-(leadAge + 8));
  f.Last_Contact_Date__c = day(-((n % 5) + 1));
  f.Contact_Disposition__c = pick.one(C, "Contact_Disposition__c", "Contacted");
  f.Qualified__c = true;
  f.Qualified_Date__c = f.First_Contact_Date__c;
  f.Call_Attempts__c = (n % 3) + 1;
  f.Appointment_Set_Date__c = day(-(leadAge + 6));
  f.Appointment_Type__c = pick.any(C, "Appointment_Type__c", ["In-Home", "Virtual", "In-Home"], n);
  f.Annual_Usage_kWh__c = Math.round((profile.avgBill * 12) / 0.14 / 100) * 100;
  f.Utility_Rate_Plan__c = "Time-of-use";
  f.Project_Type__c = pick.one(C, "Project_Type__c", n % 3 === 0 ? "Battery and Solar" : "Solar Only");
  f.Battery_Interest__c = n % 3 === 0;
  f.Proposed_System_Size_kW__c = sizeKw;
  const apptPast = phxTime(day(-(leadAge + 2)), "17:30");
  const apptFuture = phxTime(addWorkdays(anchorDate, (n % 4) + 1), n % 2 ? "10:00" : "17:30");
  const ppw = 2.9 + (n % 5) * 0.1;
  const proposal = () => {
    f.Proposal_Sent_Date__c = day(-(leadAge - 2));
    f.Proposals_Sent_Count__c = 1;
    f.Proposed_Price_Per_Watt__c = money(ppw);
    f.Proposal_Amount__c = money(ppw * sizeKw * 1000);
    f.Proposed_Offset__c = 95 + (n % 8);
    f.Proposed_Panel_Count__c = Math.round((sizeKw * 1000) / 430);
    f.Proposed_Panel_Type__c = pick.any(C, "Proposed_Panel_Type__c", ["Qcells - Q.TRON BLK M-G2.H1+/AC 430", "Qcells - Q.PEAK DUO BLK ML-G10+ 410"], n);
    f.Credit_Qualified__c = pick.one(C, "Credit_Qualified__c", "Approved");
    f.Estimated_Credit_Tier__c = pick.any(C, "Estimated_Credit_Tier__c", ["720+", "680-719"], n);
    f.Credit_Check_Date__c = f.Proposal_Sent_Date__c;
  };
  const ran = (outcome) => {
    f.Appointment_DateTime__c = apptPast;
    f.Appointment_Status__c = pick.one(C, "Appointment_Status__c", "Completed");
    f.Appointment_Ran__c = true;
    f.Appointment_Outcome__c = pick.one(C, "Appointment_Outcome__c", outcome);
  };
  switch (stage) {
    case "Appointment Set":
      f.Appointment_DateTime__c = apptFuture;
      f.Appointment_Status__c = pick.one(C, "Appointment_Status__c", n % 2 ? "Confirmed" : "Set");
      f.Confirmation_Sent__c = true;
      f.Appointment_Notes__c = "Both homeowners will be home. Bring the last twelve months of usage.";
      break;
    case "Proposal Pending":
      ran("Follow Up Needed");
      f.Proposal_Status__c = pick.one(C, "Proposal_Status__c", "Not Sent");
      f.Design_Turnaround__c = pick.one(C, "Design_Turnaround__c", "Next Day");
      f.Sales_Rep_Notes__c = "Good meeting. Wants the panels kept off the street-facing roof. Design requested.";
      break;
    case "Proposal Complete":
      ran("Follow Up Needed");
      proposal();
      f.Proposal_Status__c = pick.one(C, "Proposal_Status__c", "Sent");
      f.Next_Follow_Up_Date__c = addWorkdays(anchorDate, 2);
      f.Follow_Up_Needed__c = true;
      break;
    case "Reschedule Needed":
      f.Appointment_DateTime__c = apptPast;
      f.Original_Appointment_DateTime__c = apptPast;
      f.Appointment_Status__c = pick.one(C, "Appointment_Status__c", "No-Show");
      f.Appointment_Outcome__c = pick.one(C, "Appointment_Outcome__c", "No-Show");
      f.Reschedule_Count__c = 1;
      f.Next_Follow_Up_Date__c = addWorkdays(anchorDate, 1);
      f.Follow_Up_Needed__c = true;
      f.Appointment_Notes__c = "Nobody home at the appointment time. Left a card; call to rebook.";
      break;
    case "Rescheduled Appointment":
      f.Original_Appointment_DateTime__c = apptPast;
      f.Appointment_DateTime__c = apptFuture;
      f.Appointment_Status__c = pick.one(C, "Appointment_Status__c", "Rescheduled");
      f.Reschedule_Count__c = 1;
      f.Confirmation_Sent__c = true;
      break;
    case "Verbal Yes":
      ran("Follow Up Needed");
      proposal();
      f.Proposal_Status__c = pick.one(C, "Proposal_Status__c", "Accepted");
      f.Financing_Type__c = pick.one(C, "Financing_Type__c", "Loan");
      f.Financing_Partner__c = pick.one(C, "Financing_Partner__c", "Credit Human");
      f.Next_Follow_Up_Date__c = addWorkdays(anchorDate, 1);
      f.Sales_Rep_Notes__c = "Verbal yes on the proposal. Signing appointment to be booked this week.";
      break;
    case "10 Day Revive":
      ran("Follow Up Needed");
      proposal();
      f.Proposal_Sent_Date__c = day(-13);
      f.Proposal_Status__c = pick.one(C, "Proposal_Status__c", "Reviewed");
      f.In_Nurture_Campaign__c = true;
      f.Next_Follow_Up_Date__c = addWorkdays(anchorDate, 2);
      f.Sales_Rep_Notes__c = "Went quiet after the proposal. Ten-day check-in due.";
      break;
    case "Reset":
      f.Original_Appointment_DateTime__c = apptPast;
      f.Appointment_DateTime__c = apptFuture;
      f.Appointment_Status__c = pick.one(C, "Appointment_Status__c", "Set");
      f.Appointment_Outcome__c = pick.one(C, "Appointment_Outcome__c", "Reschedule");
      f.Reschedule_Count__c = 2;
      f.Appointment_Notes__c = "One decision-maker was away. Appointment reset so both can attend.";
      break;
    case "Closed Lost":
      ran("Not Interested");
      proposal();
      f.Proposal_Status__c = pick.one(C, "Proposal_Status__c", "Declined");
      f.Cancellation_Date__c = day(-5);
      f.Cancellation_Reason__c = pick.one(C, "Cancellation_Reason__c", "Went with Competitor");
      break;
    case "Hold":
      ran("Follow Up Needed");
      proposal();
      f.Proposal_Status__c = pick.one(C, "Proposal_Status__c", "Reviewed");
      f.Next_Follow_Up_Date__c = addWorkdays(anchorDate, 30);
      f.Sales_Rep_Notes__c = "Likes the proposal but wants to wait for the tax refund. Revisit next month.";
      break;
    case "Cancelled":
      ran("Not Interested");
      f.Cancellation_Date__c = day(-7);
      f.Cancellation_Reason__c = pick.one(C, "Cancellation_Reason__c", "Buyer's Remorse");
      break;
    default:
      f.Appointment_DateTime__c = apptFuture;
  }
  void schema;
  return f;
}

/** Give each pipeline customer its status + stage: every live Lead and Opportunity stage once, then repeats. */
export function assignPipelineStages(profiles, { schema }) {
  const combos = [];
  for (const status of ["Lead", "Opportunity"]) for (const stage of schema.dependent(C, "Stage__c", status)) combos.push({ status, stage });
  const extras = [{ status: "Lead", stage: "New" }, { status: "Opportunity", stage: "Appointment Set" }, { status: "Opportunity", stage: "Proposal Pending" }]
    .filter((x) => combos.some((c) => c.status === x.status && c.stage === x.stage));
  const pipeline = profiles.filter((p) => p.kind === "pipeline");
  pipeline.forEach((p, i) => {
    const combo = i < combos.length ? combos[i] : (extras.length ? extras : combos)[(i - combos.length) % (extras.length || combos.length)];
    p.pipeline = combo ?? { status: "Lead", stage: null };
  });
}

/** The Sundial_Customer__c record. */
export function customerFields(profile, ctx) {
  const { anchorDate, pick, schema } = ctx;
  const p = profile;
  const n = p.n;
  const day = (offset) => onWeekday(addDays(anchorDate, offset));
  const types = [];
  const requested = [];
  if (p.kind === "solar" || p.kind === "pipeline") { types.push("Solar"); requested.push("Solar"); }
  if (p.solar?.hasBattery) requested.push("Battery");
  if (p.roofing) { types.push("Roofing"); requested.push("Roofing"); }
  if (p.service) { types.push("Service"); requested.push("Service"); }

  const f = {
    Name: p.person.name,
    Client__c: ref("tenant"),
    First_Name__c: p.person.first,
    Last_Name__c: p.person.last,
    Primary_Phone__c: p.phone,
    Primary_Email__c: p.email,
    Secondary_Phone__c: p.phone2 ?? undefined,
    Preferred_Contact_Method__c: pick.one(C, "Preferred_Contact_Method__c", p.contactMethod),
    Best_Time_to_Contact__c: pick.one(C, "Best_Time_to_Contact__c", p.bestTime),
    Preferred_Language__c: pick.one(C, "Preferred_Language__c", p.language),
    Is_Homeowner__c: true,
    Active__c: true,
    Street__c: p.place.street,
    City__c: p.place.city,
    State__c: p.place.state,
    Postal_Code__c: p.place.zip,
    County__c: p.place.county,
    Country__c: pick.one(C, "Country__c", "United States"),
    AHJ__c: p.place.ahj,
    Property_Type__c: pick.one(C, "Property_Type__c", p.property.type),
    Year_Built__c: String(p.property.yearBuilt),
    Square_Footage__c: p.property.sqft,
    Roof_Type__c: pick.one(C, "Roof_Type__c", p.property.roofType),
    Roof_Age_Years__c: p.property.roofAge,
    Roof_Condition__c: pick.one(C, "Roof_Condition__c", p.property.roofCondition),
    Stories__c: pick.one(C, "Stories__c", p.property.stories),
    Equipment_Behind_Fence__c: pick.one(C, "Equipment_Behind_Fence__c", p.behindFence ? "Yes" : "No"),
    Fence_Gate_Code__c: p.behindFence ? p.gateCode : undefined,
    Lead_Source__c: p.leadSource ?? undefined,
    // Sales attribution: the lookup pair is what the access model filters on; the two name
    // picklists are the legacy display fields (the demo writes its own values into them).
    Sales_Rep__c: ref(p.repKey),
    Dealer__c: ref(p.dealerKey),
    Sales_Company__c: p.salesCompany,
    Dealer_Name__c: p.dealerName,
    Customer_Type__c: pick.multi(C, "Customer_Type__c", types),
    Requested_Project_Types__c: pick.multi(C, "Requested_Project_Types__c", requested),
    // The adder PRICE list with invented prices, so the org's field defaults (Harmon's
    // prices) never show on a demo record. Quantities follow the solar deal.
    ...customerAdderFields(p.solar?.adderQty),
  };

  if (p.kind === "pipeline") {
    f.Status__c = p.pipeline.status;
    f.Stage__c = p.pipeline.stage ?? undefined;
    Object.assign(f, pipelineFields(p, p.pipeline.status, p.pipeline.stage, ctx));
  }

  if (p.kind === "solar") {
    const s = p.solar;
    const t = s.timeline.at;
    f.Status__c = s.customer.status;
    f.Stage__c = s.customer.stage;
    f.Lead_Date__c = onWeekday(addDays(t.sold, -(18 + (n % 14))));
    f.Assigned_Date__c = f.Lead_Date__c;
    f.First_Contact_Date__c = onWeekday(addDays(f.Lead_Date__c, 1));
    f.Qualified__c = true;
    f.Qualified_Date__c = f.First_Contact_Date__c;
    f.Call_Attempts__c = (n % 3) + 1;
    f.Contact_Disposition__c = pick.one(C, "Contact_Disposition__c", "Contacted");
    f.Appointment_Set_Date__c = onWeekday(addDays(t.sold, -10));
    f.Appointment_DateTime__c = phxTime(onWeekday(addDays(t.sold, -6)), "17:30");
    f.Appointment_Type__c = pick.one(C, "Appointment_Type__c", "In-Home");
    f.Appointment_Status__c = pick.one(C, "Appointment_Status__c", "Completed");
    f.Appointment_Ran__c = true;
    f.Appointment_Outcome__c = pick.one(C, "Appointment_Outcome__c", "Sold");
    f.Utility_Company__c = pick.one(C, "Utility_Company__c", p.place.utility);
    f.Average_Electric_Bill__c = s.avgBill;
    f.Annual_Usage_kWh__c = s.annualUsage;
    f.Utility_Rate_Plan__c = "Time-of-use";
    f.Utility_Account_Number__c = p.utilityAccount;
    f.Utility_Meter__c = p.meterNumber;
    f.Project_Type__c = pick.one(C, "Project_Type__c", s.hasBattery ? "Battery and Solar" : "Solar Only");
    f.Battery_Interest__c = s.hasBattery;
    f.Battery_Type__c = s.hasBattery ? pick.one(C, "Battery_Type__c", { "Powerwall 3": "Tesla Powerwall 3", "FranklinWH aPower2": "FranklinWH aPower2", "Encharge 10": "Enphase IQ" }[s.batteryType]) : undefined;
    f.Battery_Quantity__c = s.hasBattery ? s.batteryQty : undefined;
    f.Battery_Qty__c = s.batteryQty;
    f.Proposed_Panel_Type__c = s.panel.customer ? pick.one(C, "Proposed_Panel_Type__c", s.panel.customer) : undefined;
    f.Proposed_Panel_Count__c = s.panels;
    f.Proposed_System_Size_kW__c = s.sizeKw;
    f.Proposed_Offset__c = s.offset;
    f.Proposed_Price_Per_Watt__c = s.ppw;
    f.Proposal_Amount__c = s.contractAmount;
    f.Proposal_Sent_Date__c = onWeekday(addDays(t.sold, -5));
    f.Proposals_Sent_Count__c = 1 + (n % 2);
    f.Proposal_Status__c = pick.one(C, "Proposal_Status__c", "Accepted");
    f.Inverter_Type__c = s.inverter ? pick.one(C, "Inverter_Type__c", s.inverter) : undefined;
    f.Inverter_Quantity__c = s.microinverters ? s.panels : 1;
    f.Mounting__c = s.mounting ? pick.one(C, "Mounting__c", s.mounting) : undefined;
    f.First_Year_kW_Production__c = s.firstYearKwh;
    f.Financing_Type__c = pick.one(C, "Financing_Type__c", { Cash: "Cash", Finance: "Loan", Lease: "Lease" }[s.finance]);
    f.Financing_Partner__c = pick.one(C, "Financing_Partner__c", { Cash: "Cash", Finance: "Credit Human", Lease: "Lightreach" }[s.finance]);
    f.Contract_Type__c = pick.one(C, "Contract_Type__c", { Cash: "Cash", Finance: "Other", Lease: "Lease" }[s.finance]);
    if (s.finance !== "Cash") {
      f.Credit_Qualified__c = pick.one(C, "Credit_Qualified__c", "Approved");
      f.Estimated_Credit_Tier__c = pick.any(C, "Estimated_Credit_Tier__c", ["720+", "680-719"], n);
      f.Credit_Check_Date__c = onWeekday(addDays(t.sold, -4));
      f.Credit_Approved_Date__c = onWeekday(addDays(t.sold, -2));
      f.Loan_Term_Years__c = s.termYears;
      f.Monthly_Payment__c = s.monthly;
      if (s.apr) f.APR__c = s.apr;
    } else {
      f.Down_Payment_Amount__c = money(s.contractAmount * 0.1);
    }
    f.Sold_Date__c = t.sold;
    f.Contract_Signed_Date__c = t.sold;
    f.Contract_Price_Per_Watt__c = s.ppw;
    f.Contract_Amount__c = s.contractAmount;
    f.Final_System_Size_kW__c = s.sizeKw;
    f.Final_Panel_Count__c = s.panels;
    f.MPU_Likely_Needed__c = s.mpu;
    f.Re_Roof_Needed__c = !!p.roofing;
    f.Passed_to_Operations__c = true;
    f.Passed_to_Operations_Date__c = onWeekday(addDays(t.sold, 1)) <= anchorDate ? onWeekday(addDays(t.sold, 1)) : t.sold;
    f.Solar_Project_Created__c = true;
    f.Last_Contact_Date__c = day(-((n % 6) + 1));
    if (s.rule.cancelled) {
      f.Cancellation_Date__c = day(-((n % 4) + 2));
      f.Cancellation_Reason__c = pick.one(C, "Cancellation_Reason__c", s.rule.cancelled === "resell" ? "Price" : "Buyer's Remorse");
    }
    f.Notes__c = "DEMO DATA - fictional customer.";
  }

  if (p.kind === "roofing") {
    // A sold roofing job. The customer shows in Sales as a plain sold customer.
    f.Status__c = "Customer";
    f.Stage__c = schema.dependent(C, "Stage__c", "Customer").includes("Sold") ? "Sold" : undefined;
    f.Lead_Date__c = day(-(40 + (n % 20)));
    f.Assigned_Date__c = f.Lead_Date__c;
    f.First_Contact_Date__c = onWeekday(addDays(f.Lead_Date__c, 2));
    f.Sold_Date__c = p.roofing.soldDate ?? undefined;
    f.Last_Contact_Date__c = day(-((n % 6) + 1));
    f.Notes__c = "DEMO DATA - fictional customer. Roofing only.";
  }
  if (p.roofing) {
    f.Roofing_Project_Created__c = true;
    f.Roof_Scope__c = pick.one(C, "Roof_Scope__c", p.roofing.scope);
  }

  if (p.kind === "service") {
    const hasJob = !!p.service?.jobs?.length;
    f.Status__c = hasJob ? "Customer" : "Lead";
    // Stage__c is the SOLAR sales pipeline; a service-only customer has no place in it and
    // is hidden from the Sales page (isServiceOnly), so it is left blank on purpose.
    f.Lead_Date__c = day(-(10 + (n % 25)));
    f.First_Contact_Date__c = f.Lead_Date__c;
    f.Existing_Solar_System__c = true;
    f.Existing_Panel_Count__c = 16 + (n % 14);
    f.Active_System_Monitoring__c = pick.one(C, "Active_System_Monitoring__c", n % 4 === 0 ? "No" : "Yes");
    f.Utility_Company__c = pick.one(C, "Utility_Company__c", p.place.utility);
    f.Notes__c = "DEMO DATA - fictional customer. System installed by another company.";
  }
  if (p.service) {
    const sv = p.service;
    f.Service_Stage__c = sv.stage ?? undefined;
    f.Service_Request_Type__c = sv.requestType ? pick.one(C, "Service_Request_Type__c", sv.requestType) : undefined;
    f.Description__c = sv.description ?? undefined;
    f.Assigned_To__c = ref(DISPATCHER_KEY);
    f.Service_Project_Created__c = !!sv.jobs?.length;
    if (sv.nextFollowUp) { f.Next_Follow_Up_Date__c = sv.nextFollowUp; f.Follow_Up_Needed__c = true; }
    if (sv.lastContact) f.Last_Contact_Date__c = sv.lastContact;
    if (sv.resolution) {
      f.Service_Resolution__c = pick.one(C, "Service_Resolution__c", sv.resolution);
      f.Service_Resolved_Date__c = sv.resolvedDate ?? undefined;
    }
    if (p.kind === "service") f.Assigned_Date__c = f.Lead_Date__c;
  }

  // No automation should ever want to phone a demo customer. The welcome-call Lambda skips
  // anyone already "Verified" (docs/integrations/retell-welcome-call.md, eligibility guard 1),
  // so every customer at or beyond a sale carries that status from the first write.
  if (f.Status__c === "Customer" || f.Status__c === "Past Customer") {
    f.Welcome_Call_Status__c = "Verified";
    f.Welcome_Call_Attempts__c = 1;
  }
  // Every record says what it is, for anyone who opens it in Salesforce.
  if (!String(f.Notes__c ?? "").startsWith("DEMO DATA")) f.Notes__c = `DEMO DATA - fictional customer.${f.Notes__c ? ` ${f.Notes__c}` : ""}`;
  return f;
}
