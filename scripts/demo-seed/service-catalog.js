// service-catalog.js — the demo tenant's price book and the kinds of service work it does.
//
// A generic solar-service catalog with invented, round-ish prices. Nothing here comes
// from Harmon's price book (salesforce/pricebook-import/).
//
// Kind decides where the price lives (lambdas/sundial-service-estimate/pricebook.js):
//   Labor    -> Labor_Price__c only        (not taxable: labour is not taxed in the demo)
//   Material -> Material_Price__c only     (taxable)
//   Fee      -> Labor_Price__c holds the single price (never discounted, not taxed)

/** [code, name, kind, category, jobType, serviceType, unit, price, cost, estimatedHours, description] */
const ROWS = [
  ["SVC-DIAG", "Service call / diagnostic", "Labor", "Service Call", "Solar", "Repair", "Each", 149, 60, 1, "On-site diagnostic visit: system check, fault codes read, findings explained."],
  ["SVC-TRIP", "Trip charge", "Fee", "Service Call", "Solar", "Repair", "Each", 89, 0, null, "Travel to site."],
  ["LAB-HOUR", "Service labor (per hour)", "Labor", "Service Call", "Solar", "Repair", "Hour", 125, 45, 1, "Technician labor, billed per hour."],
  ["INV-REPL-LAB", "String inverter replacement labor", "Labor", "Inverter", "Solar", "Repair", "Each", 450, 180, 3, "Remove the failed inverter, fit and commission the replacement."],
  ["INV-STRING", "String inverter (7.6 kW)", "Material", "Inverter", "Solar", "Repair", "Each", 1900, 1350, null, "Replacement string inverter, 7.6 kW class."],
  ["MICRO-REPL-LAB", "Microinverter replacement labor", "Labor", "Inverter", "Solar", "Repair", "Each", 225, 90, 1.5, "Lift the panel, swap the microinverter, re-seat and test."],
  ["MICRO-UNIT", "Microinverter unit", "Material", "Inverter", "Solar", "Repair", "Each", 210, 145, null, "Replacement microinverter."],
  ["OPT-REPL-LAB", "Optimizer replacement labor", "Labor", "Inverter", "Solar", "Repair", "Each", 175, 70, 1, "Swap a failed power optimizer."],
  ["OPT-UNIT", "Power optimizer unit", "Material", "Inverter", "Solar", "Repair", "Each", 95, 60, null, "Replacement power optimizer."],
  ["PANEL-RR", "Panel removal & reinstall (per panel)", "Labor", "Panel", "Solar", "Repair", "Each", 150, 65, 0.75, "Remove, store and reinstall one panel (for roof work)."],
  ["PANEL-REPL", "Replacement solar panel (400 W class)", "Material", "Panel", "Solar", "Repair", "Each", 325, 220, null, "Replacement panel matched to the existing array."],
  ["CRITTER-GUARD", "Critter guard (per ft)", "Material", "Panel", "Solar", "Maintenance", "Foot", 8, 3, null, "Coated mesh around the array edge to keep birds and rodents out."],
  ["CRITTER-LAB", "Critter guard installation labor", "Labor", "Panel", "Solar", "Maintenance", "Each", 350, 140, 3, "Clear nesting material and fit the guard."],
  ["PANEL-CLEAN", "Panel cleaning (up to 30 panels)", "Labor", "Cleaning", "Solar", "Maintenance", "Each", 199, 80, 1.5, "De-ionised water wash, no detergents."],
  ["GATEWAY-REPL", "Monitoring gateway replacement", "Material", "Electrical", "Solar", "Repair", "Each", 395, 260, null, "Replacement monitoring gateway."],
  ["MON-RECONFIG", "Monitoring reconfiguration", "Labor", "Electrical", "Solar", "Repair", "Each", 125, 50, 1, "Reconnect the system to the monitoring portal and verify reporting."],
  ["MPU-LAB", "Main panel upgrade labor", "Labor", "Electrical", "Electrical", "Installation", "Each", 1800, 750, 8, "Replace the main service panel, utility coordination included."],
  ["MPU-MAT", "200A main panel & materials", "Material", "Electrical", "Electrical", "Installation", "Lot", 1250, 820, null, "200A panel, breakers and fittings."],
  ["BATT-COMM", "Battery commissioning", "Labor", "Battery", "Solar", "Installation", "Each", 400, 160, 2.5, "Commission or re-commission a home battery."],
  ["EV-INSTALL", "EV charger installation labor", "Labor", "EV Charger", "EV", "Installation", "Each", 650, 260, 4, "Install a Level 2 charger on a dedicated circuit."],
  ["EV-UNIT", "Level 2 EV charger (48A)", "Material", "EV Charger", "EV", "Installation", "Each", 600, 420, null, "48A Level 2 charger."],
  ["RSD-UNIT", "Rapid-shutdown device", "Material", "Electrical", "Solar", "Repair", "Each", 140, 85, null, "Module-level rapid-shutdown device."],
  ["MC4-REPAIR", "MC4 connector repair", "Labor", "Electrical", "Solar", "Repair", "Each", 95, 35, 0.5, "Replace a damaged connector pair."],
  ["ROOF-RESEAL", "Roof penetration reseal (per penetration)", "Labor", "Roofing", "Solar", "Repair", "Each", 45, 15, 0.25, "Clean and reseal one roof attachment."],
  ["PERMIT-FEE", "Permit fee", "Fee", "Other", "Solar", "Installation", "Each", 250, 0, null, "City permit, passed through at cost."],
  ["DISPOSAL-FEE", "Disposal fee", "Fee", "Other", "Solar", "Repair", "Each", 45, 0, null, "Recycling of replaced equipment."],
  ["WIRE-REPAIR", "Conduit & wiring repair materials", "Material", "Materials", "Electrical", "Repair", "Lot", 120, 70, null, "Conduit, wire and fittings."],
  ["SYS-INSPECT", "Annual system inspection", "Labor", "Inspection", "Solar", "Inspection", "Each", 179, 70, 1.5, "Visual and electrical inspection with a written report."],
];

export const PRICE_BOOK = Object.freeze(ROWS.map(([code, name, kind, category, jobType, serviceType, unit, price, cost, hours, description]) => ({
  key: `item:${code}`, code, name, kind, category, jobType, serviceType, unit, price, cost, hours, description,
  taxable: kind === "Material",
})));
export const itemByCode = (code) => {
  const it = PRICE_BOOK.find((i) => i.code === code);
  if (!it) throw new Error(`unknown price book item ${code}`);
  return it;
};

/**
 * The kinds of job the demo service department does. `lines` is [item code, quantity];
 * `requestType` is the customer's Service_Request_Type__c; the texts are what a real job
 * would carry in its issue / diagnosis / notes / customer summary fields.
 */
export const SCENARIOS = Object.freeze([
  {
    id: "inverter", requestType: "Inverter / Equipment Fault", serviceType: "Paid Service", priority: "High",
    issue: "Inverter is showing a red fault light and the system has produced nothing for several days.",
    diagnosis: "Monitoring shows the inverter offline with an isolation fault. Likely a failed unit; site visit needed to confirm.",
    lines: [["SVC-DIAG", 1], ["INV-REPL-LAB", 1], ["INV-STRING", 1], ["DISPOSAL-FEE", 1]],
    work: "Confirmed the inverter had failed internally. Replaced it, re-commissioned and watched all strings come back up.",
    priv: "Old inverter is in the truck for recycling. Homeowner keeps the side gate locked, call ahead.",
    summary: "We found the inverter had failed and replaced it. Your system is producing normally again and is back on monitoring.",
  },
  {
    id: "monitoring", requestType: "Monitoring Offline", serviceType: "Monitoring Follow-up", priority: "Standard",
    issue: "Monitoring app has shown the system offline for over a week. Homeowner is not sure whether it is still producing.",
    diagnosis: "Gateway last reported nine days ago. Production meter at the utility still shows export, so likely a communications fault only.",
    lines: [["SVC-DIAG", 1], ["GATEWAY-REPL", 1], ["MON-RECONFIG", 1]],
    work: "Gateway had lost power from a tripped outlet and would not rejoin the network. Replaced the gateway and re-linked it to the portal.",
    priv: "Router is in the hall cupboard. Wi-Fi details are on a sticker on the router.",
    summary: "Your system never stopped producing, it had only stopped reporting. We replaced the monitoring gateway and it is reporting again.",
  },
  {
    id: "critters", requestType: "Maintenance / Cleaning", serviceType: "Maintenance", priority: "Standard",
    issue: "Pigeons are nesting under the array. Noise and droppings on the patio.",
    diagnosis: "Photos from the homeowner show nesting material under the lower row. Recommend a guard around the full perimeter and a clean.",
    lines: [["CRITTER-GUARD", 120], ["CRITTER-LAB", 1], ["PANEL-CLEAN", 1]],
    work: "Cleared nesting material from under both rows, fitted guard around the whole perimeter and washed the panels.",
    priv: "Two broken roof tiles found under the array, photographed. Not caused by us, mention to the office.",
    summary: "We removed the nests, fitted a guard around the array so birds cannot get back under it, and cleaned the panels.",
  },
  {
    id: "microinverter", requestType: "System Not Producing", serviceType: "Warranty", priority: "Standard",
    issue: "Two panels are showing no production in the app. The rest of the array looks normal.",
    diagnosis: "Two microinverters are not reporting. Both on the same branch, could be a connector or the units themselves.",
    lines: [["SVC-DIAG", 1], ["MICRO-REPL-LAB", 2], ["MICRO-UNIT", 2]],
    work: "Both microinverters were dead. Swapped them, re-seated the branch connector and confirmed all panels reporting.",
    priv: "Warranty claim filed with the manufacturer for both units. Serial numbers photographed.",
    summary: "Two of the small inverters under your panels had failed. We replaced both and every panel is reporting again.",
  },
  {
    id: "reroof", requestType: "Removal & Reinstall", serviceType: "Paid Service", priority: "Standard",
    issue: "Roof is being replaced next month. Homeowner needs the array taken off and put back afterwards.",
    diagnosis: "Eighteen panels on two planes. Removal is one day, reinstall one day once the roofer signs off.",
    lines: [["PANEL-RR", 18], ["ROOF-RESEAL", 12], ["PERMIT-FEE", 1]],
    work: "Array removed and stacked on the side yard on pallets, rails and attachments labelled. Penetrations capped for the roofer.",
    priv: "Roofer's contact is on the fridge. They expect to finish in eight working days.",
    summary: "We removed your panels ahead of the roof work and will reinstall them once the new roof is signed off.",
  },
  {
    id: "evcharger", requestType: "Add-On (Battery, EV Charger, Panels)", serviceType: "Upgrade", priority: "Standard",
    issue: "New electric vehicle arriving soon. Wants a Level 2 charger in the garage.",
    diagnosis: "Panel has capacity for a 60A circuit. Twenty-foot run from the panel to the garage wall.",
    lines: [["EV-INSTALL", 1], ["EV-UNIT", 1], ["WIRE-REPAIR", 1], ["PERMIT-FEE", 1]],
    work: "Ran a dedicated 60A circuit to the garage and mounted the charger at the agreed spot. Tested with the homeowner's car.",
    priv: "Inspection to be booked by the office. Leave the permit card in the panel door.",
    summary: "Your Level 2 charger is installed and tested. The city inspection is the only thing left and we will book it for you.",
  },
  {
    id: "panelupgrade", requestType: "Electrical / Panel Upgrade", serviceType: "Upgrade", priority: "Standard",
    issue: "Main panel is full and the breakers trip when the air conditioning and the dryer run together.",
    diagnosis: "100A panel from the original build. Upgrade to 200A recommended; utility disconnect needed on the day.",
    lines: [["MPU-LAB", 1], ["MPU-MAT", 1], ["PERMIT-FEE", 1]],
    work: "Replaced the 100A panel with a 200A panel, moved every circuit across and labelled the directory.",
    priv: "Utility reconnect was two hours late. Homeowner was patient, worth a thank-you call.",
    summary: "Your main electrical panel has been upgraded to 200 amps. Everything is reconnected and labelled.",
  },
  {
    id: "inspection", requestType: "Maintenance / Cleaning", serviceType: "Maintenance", priority: "Low",
    issue: "Annual check and clean requested before the summer.",
    diagnosis: "No faults on monitoring. Routine visit.",
    lines: [["SYS-INSPECT", 1], ["PANEL-CLEAN", 1]],
    work: "Inspected array, wiring and inverter. Torque checked on the attachments we could reach. Panels washed.",
    priv: "One conduit strap is loose on the west wall. Tightened; keep an eye on it next visit.",
    summary: "Your system passed its annual inspection with nothing to fix, and the panels are clean for the summer.",
  },
  {
    id: "battery", requestType: "Battery Issue", serviceType: "Warranty", priority: "High",
    issue: "Battery did not take over during last week's outage and now shows a standby warning.",
    diagnosis: "Battery reports a firmware mismatch after an update. Needs re-commissioning on site.",
    lines: [["SVC-DIAG", 1], ["BATT-COMM", 1], ["LAB-HOUR", 2]],
    work: "Re-commissioned the battery, updated the gateway and ran a simulated outage. Backup loads held for the full test.",
    priv: "Backed-up loads panel is not labelled. Offered to label it next visit.",
    summary: "Your battery has been re-commissioned and we tested it with a simulated outage. It is ready for the next one.",
  },
  {
    id: "stormdamage", requestType: "Panel Damage", serviceType: "Paid Service", priority: "Emergency",
    issue: "A branch came down in the storm and cracked a panel. Glass is broken, homeowner is worried about safety.",
    diagnosis: "System shut down remotely as a precaution. One panel to replace, neighbours to check.",
    lines: [["SVC-DIAG", 1], ["PANEL-REPL", 1], ["PANEL-RR", 2], ["MC4-REPAIR", 1], ["DISPOSAL-FEE", 1]],
    work: "Removed the broken panel, replaced it and one damaged connector. Checked the two panels next to it, no damage.",
    priv: "Photos taken for the homeowner's insurance claim. They asked for a copy of the invoice as a PDF.",
    summary: "We replaced the storm-damaged panel and a damaged connector, checked the panels around it and turned the system back on.",
  },
  {
    id: "optimizer", requestType: "System Not Producing", serviceType: "Paid Service", priority: "Standard",
    issue: "Production is down about a third compared with last month.",
    diagnosis: "One string shows low voltage. Three optimizers are not reporting.",
    lines: [["SVC-DIAG", 1], ["OPT-REPL-LAB", 3], ["OPT-UNIT", 3]],
    work: "Replaced three failed optimizers on the second string. String voltage back to normal.",
    priv: "Attic is very tight over the garage. Bring the short ladder.",
    summary: "Three small devices under the panels on one string had failed. We replaced them and production is back to normal.",
  },
  {
    id: "rapidshutdown", requestType: "Inverter / Equipment Fault", serviceType: "Paid Service", priority: "High",
    issue: "System keeps shutting itself off around midday with a rapid-shutdown error.",
    diagnosis: "Intermittent rapid-shutdown fault, worse in heat. Two devices suspected.",
    lines: [["SVC-DIAG", 1], ["RSD-UNIT", 2], ["LAB-HOUR", 1.5], ["SVC-TRIP", 1]],
    work: "Found two rapid-shutdown devices failing under heat. Replaced both and ran the system through the afternoon peak.",
    priv: "Homeowner works nights. Do not ring the bell before noon, text instead.",
    summary: "Two safety devices on the roof were failing in the heat and shutting the system down. Both are replaced.",
  },
]);

/** Extra lines a tech sometimes adds by hand — no price book item behind them. */
export const AD_HOC_LINES = Object.freeze([
  { description: "Replace weathered junction box cover", kind: "Material", unitPrice: 35, taxable: true },
  { description: "Re-route conduit around new roof vent", kind: "Labor", unitPrice: 90, taxable: false },
  { description: "Replace cracked roof tile under array (supplied by customer)", kind: "Labor", unitPrice: 60, taxable: false },
]);
