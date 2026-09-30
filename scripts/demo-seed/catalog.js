// catalog.js — the fictional world of the demo tenant.
//
// Everything here is INVENTED: people, streets, the dealers, the staff. Nothing is copied
// from Harmon's data. Phone numbers come from 555-0100…0199 (reserved for fiction) and
// customer emails are @example.com, so a text or an email sent from a demo record can
// never reach a real person (unless the owner passes --demo-phone / --demo-email for the
// three "live demo" customers).

import { demoUserEmail } from "./policy.js";

// --- the three dealers --------------------------------------------------------------
export const DEALERS = Object.freeze([
  { key: "dealer:constructive", name: "Constructive Solar", internal: true },
  { key: "dealer:saguaro", name: "Saguaro Ridge Solar", internal: false },
  { key: "dealer:copperline", name: "Copperline Energy", internal: false },
]);
export const IN_HOUSE_SALES_COMPANY = "Constructive Solar";
export const THIRD_PARTY_SALES_COMPANY = "Third-Party Dealer";
export const INSTALLER_NAME = "Constructive Solar";

// --- the eleven demo users -----------------------------------------------------------
// `accessLevel` is Sundial_User__c.Access_Level__c — the ONLY input to what a login can
// see (lib/access.js). `dealer` is set on sales roles only: a sales user with no dealer
// sees nothing at all.
export const PERSONAS = Object.freeze([
  { key: "user:avery", slug: "avery", first: "Avery", last: "Collins", accessLevel: "Executive", department: "Residential Solar", superAdmin: true, title: "Owner / Executive" },
  { key: "user:dana", slug: "dana", first: "Dana", last: "Kim", accessLevel: "Admin", department: "Service", title: "Office manager / dispatcher" },
  { key: "user:jordan", slug: "jordan", first: "Jordan", last: "Reyes", accessLevel: "Manager", department: "Residential Solar", title: "Solar project manager" },
  { key: "user:casey", slug: "casey", first: "Casey", last: "Tran", accessLevel: "Manager", department: "Roofing", title: "Roofing project manager" },
  { key: "user:sam", slug: "sam", first: "Sam", last: "Whitaker", accessLevel: "Sales Rep", department: "Residential Solar", dealer: "dealer:constructive", title: "In-house sales rep" },
  { key: "user:elena", slug: "elena", first: "Elena", last: "Marsh", accessLevel: "Sales Rep", department: "Residential Solar", dealer: "dealer:constructive", title: "In-house sales rep" },
  { key: "user:tyler", slug: "tyler", first: "Tyler", last: "Brooks", accessLevel: "Sales Dealer", department: "Residential Solar", dealer: "dealer:saguaro", title: "Dealer manager, Saguaro Ridge Solar" },
  { key: "user:nadia", slug: "nadia", first: "Nadia", last: "Flores", accessLevel: "Sales Rep", department: "Residential Solar", dealer: "dealer:copperline", title: "Sales rep, Copperline Energy" },
  { key: "user:marcus", slug: "marcus", first: "Marcus", last: "Bell", accessLevel: "Technician", department: "Service", dispatchOrder: 1, hourlyBillRate: 125, title: "Service technician" },
  { key: "user:priya", slug: "priya", first: "Priya", last: "Nair", accessLevel: "Technician", department: "Service", dispatchOrder: 2, hourlyBillRate: 125, title: "Service technician" },
  { key: "user:diego", slug: "diego", first: "Diego", last: "Alvarez", accessLevel: "Technician", department: "Service", dispatchOrder: 3, hourlyBillRate: 110, title: "Service technician" },
].map((p) => ({ ...p, email: demoUserEmail(p.slug), name: `${p.first} ${p.last}` })));

export const persona = (key) => {
  const p = PERSONAS.find((x) => x.key === key);
  if (!p) throw new Error(`unknown persona ${key}`);
  return p;
};
/** The four people deals are attributed to, with a rough share of the book. */
export const SALES_PEOPLE = Object.freeze([
  { key: "user:sam", share: 28 },
  { key: "user:elena", share: 24 },
  { key: "user:tyler", share: 25 },
  { key: "user:nadia", share: 23 },
]);
export const TECH_KEYS = Object.freeze(["user:marcus", "user:priya", "user:diego"]);
export const DISPATCHER_KEY = "user:dana";
export const ADMIN_KEY = "user:avery";
export const SOLAR_PM_KEY = "user:jordan";
export const ROOFING_PM_KEY = "user:casey";

/** The shop the techs start their day from (an invented spot in central Phoenix). */
export const SHOP = Object.freeze({ lat: 33.4255, lng: -112.005 });
/** The "office line" demo texts appear to come from — a reserved fictional number. */
export const OFFICE_SMS_NUMBER = "+14805550100";

// --- places --------------------------------------------------------------------------
// ZIP codes belong to the city they are listed under; the utility is the one that serves
// most of that city (APS or SRP). lat/lng is the city's rough centre — job pins are
// scattered a few kilometres around it.
export const UTILITY_APS = "Arizona Public Service Company";
export const UTILITY_SRP = "Salt River Project";
export const CITIES = Object.freeze([
  { city: "Phoenix", zips: ["85008", "85016", "85018", "85022", "85032", "85044", "85048", "85085"], utility: UTILITY_APS, lat: 33.4942, lng: -112.0478, weight: 22, taxRate: 8.6 },
  { city: "Scottsdale", zips: ["85250", "85251", "85254", "85255", "85258", "85260"], utility: UTILITY_APS, lat: 33.5722, lng: -111.9077, weight: 10, taxRate: 8.05 },
  { city: "Tempe", zips: ["85281", "85282", "85283", "85284"], utility: UTILITY_SRP, lat: 33.3884, lng: -111.9285, weight: 7, taxRate: 8.1 },
  { city: "Mesa", zips: ["85201", "85203", "85204", "85205", "85207", "85213"], utility: UTILITY_SRP, lat: 33.4152, lng: -111.7815, weight: 12, taxRate: 8.3 },
  { city: "Chandler", zips: ["85224", "85225", "85226", "85248", "85249", "85286"], utility: UTILITY_SRP, lat: 33.2829, lng: -111.8549, weight: 9, taxRate: 7.8 },
  { city: "Gilbert", zips: ["85233", "85234", "85295", "85296", "85297", "85298"], utility: UTILITY_SRP, lat: 33.3291, lng: -111.7602, weight: 9, taxRate: 7.8 },
  { city: "Glendale", zips: ["85301", "85302", "85304", "85306", "85308", "85310"], utility: UTILITY_APS, lat: 33.5791, lng: -112.2026, weight: 7, taxRate: 9.2 },
  { city: "Peoria", zips: ["85345", "85381", "85382", "85383"], utility: UTILITY_APS, lat: 33.6407, lng: -112.2582, weight: 6, taxRate: 8.1 },
  { city: "Surprise", zips: ["85374", "85379", "85387", "85388"], utility: UTILITY_APS, lat: 33.6392, lng: -112.3858, weight: 5, taxRate: 8.5 },
  { city: "Goodyear", zips: ["85338", "85395"], utility: UTILITY_APS, lat: 33.4419, lng: -112.3737, weight: 4, taxRate: 8.8 },
  { city: "Queen Creek", zips: ["85142"], utility: UTILITY_SRP, lat: 33.2487, lng: -111.6343, weight: 3, taxRate: 8.55 },
  { city: "Cave Creek", zips: ["85331"], utility: UTILITY_APS, lat: 33.8333, lng: -111.9507, weight: 2, taxRate: 9.3 },
  { city: "Avondale", zips: ["85323", "85392"], utility: UTILITY_APS, lat: 33.4356, lng: -112.3496, weight: 2, taxRate: 8.8 },
  { city: "Buckeye", zips: ["85326", "85396"], utility: UTILITY_APS, lat: 33.4206, lng: -112.5838, weight: 2, taxRate: 9.3 },
]);
export const COUNTY = "Maricopa";
export const STATE = "AZ";

const STREET_DIRECTIONS = ["N", "S", "E", "W"];
const STREET_NAMES = [
  "Desert Willow", "Saguaro Blossom", "Copper Ridge", "Ocotillo", "Palo Verde", "Mesquite Grove", "Quail Run",
  "Sunburst", "Camelback Vista", "Red Rock", "Ironwood", "Agave", "Sonoran Sky", "Thunderbird Trail",
  "Prickly Pear", "Cholla", "Painted Desert", "Roadrunner", "Coyote Springs", "Jackrabbit", "Hohokam",
  "Sierra Madre", "Monte Cristo", "Sweetwater", "Dobbins Ridge", "Greenway Park", "Juniper", "Tamarisk",
  "Dusty Wren", "Canyon Wren", "Morning Glory", "Silver Cholla", "Desert Lantern", "Arroyo Seco",
  "Moonlight Mesa", "Starlight", "Vista Bonita", "Casa Bonita", "El Camino", "Rancho Verde",
];
const STREET_SUFFIXES = ["Dr", "Ln", "Rd", "Way", "St", "Ave", "Ct", "Pl", "Trl", "Cir"];

const FIRST_NAMES = [
  "Maria", "James", "Aisha", "Wei", "Carlos", "Hannah", "Omar", "Linh", "Robert", "Sofia", "Darnell", "Mei",
  "Patrick", "Fatima", "Andre", "Rachel", "Hiro", "Gabriela", "Thomas", "Nia", "Victor", "Emily", "Rajesh",
  "Olivia", "Miguel", "Grace", "Kwame", "Laura", "Anthony", "Yuki", "Isabel", "Brian", "Amara", "Daniel",
  "Lucia", "Kevin", "Zara", "Michael", "Tanya", "Jorge", "Helen", "Malik", "Susan", "Arjun", "Camila", "Eric",
  "Naomi", "Luis", "Angela", "Dmitri", "Rosa", "Trevor", "Imani", "Paul", "Keiko", "Alan", "Beatriz", "Scott",
  "Leila", "Frank", "Monique", "Sean", "Anita", "Walter",
];
const LAST_NAMES = [
  "Alvarado", "Bennett", "Chen", "Dawson", "Espinoza", "Fitzgerald", "Gupta", "Hoang", "Ibarra", "Jensen",
  "Kowalski", "Lopez", "Mitchell", "Nakamura", "Okafor", "Patel", "Quintero", "Ramirez", "Sandoval",
  "Thompson", "Ueda", "Vasquez", "Washington", "Xiong", "Yamamoto", "Zimmerman", "Abbott", "Barrera",
  "Castillo", "Douglas", "Ellison", "Foster", "Garza", "Hughes", "Iverson", "Johnson", "Lindqvist", "Morales",
  "Nguyen", "Ortiz", "Pham", "Russo", "Singh", "Torres", "Underwood", "Villanueva", "Whitfield", "Yoder",
  "Zamora", "Acosta", "Brennan", "Cordova", "Delgado", "Erickson", "Goldberg", "Hernandez", "Irving",
  "Jimenez", "Khan", "Larsen", "Medina", "Novak", "Owens",
];

/** Staff take 555-0188 and up; customers everything below it. */
export const STAFF_PHONE_FROM = 88;
/** The fictional customer numbers — (602|480|623) 555-0100…0187 — minus the one used as the office line. */
function phonePool() {
  const out = [];
  for (const area of ["602", "480", "623"]) {
    for (let n = 0; n < STAFF_PHONE_FROM; n++) {
      if (area === "480" && n === 0) continue; // +1 480 555 0100 is the demo office line
      out.push(`(${area}) 555-01${String(n).padStart(2, "0")}`);
    }
  }
  return out;
}
export const toE164 = (pretty) => `+1${String(pretty).replace(/\D/g, "").slice(-10)}`;

/**
 * Hands out people, addresses and phone numbers without repeats. One instance per plan,
 * fed by its own random stream so the rest of the plan cannot disturb the names.
 */
export function createCast(rng) {
  const firsts = rng.shuffle(FIRST_NAMES);
  const lasts = rng.shuffle(LAST_NAMES);
  const phones = rng.shuffle(phonePool());
  const usedNames = new Set();
  const usedStreets = new Set();
  let personIdx = 0;
  let phoneIdx = 0;

  function phone() {
    if (phoneIdx >= phones.length) throw new Error("demo cast: ran out of fictional phone numbers");
    return phones[phoneIdx++];
  }
  function person() {
    // Walk the two shuffled lists at different strides so first and last names pair up
    // differently each lap and no full name is used twice.
    for (let tries = 0; tries < FIRST_NAMES.length * LAST_NAMES.length; tries++) {
      const i = personIdx++;
      const first = firsts[i % firsts.length];
      const last = lasts[(i * 5 + Math.floor(i / firsts.length) * 11) % lasts.length];
      const name = `${first} ${last}`;
      if (usedNames.has(name)) continue;
      usedNames.add(name);
      return { first, last, name, email: `${first}.${last}@example.com`.toLowerCase() };
    }
    throw new Error("demo cast: ran out of names");
  }
  function place() {
    const c = rng.weighted(CITIES.map((x) => [x, x.weight]));
    let street;
    do {
      street = `${rng.int(1200, 19999)} ${rng.pick(STREET_DIRECTIONS)} ${rng.pick(STREET_NAMES)} ${rng.pick(STREET_SUFFIXES)}`;
    } while (usedStreets.has(street));
    usedStreets.add(street);
    const zip = rng.pick(c.zips);
    // Scatter the pin up to ~4 km from the city centre so the dispatch map is not one dot.
    const lat = Math.round((c.lat + (rng.next() - 0.5) * 0.07) * 1e6) / 1e6;
    const lng = Math.round((c.lng + (rng.next() - 0.5) * 0.08) * 1e6) / 1e6;
    return { street, city: c.city, state: STATE, zip, county: COUNTY, utility: c.utility, lat, lng, taxRate: c.taxRate, ahj: `City of ${c.city}` };
  }
  return { person, place, phone };
}
