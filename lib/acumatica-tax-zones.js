// Acumatica RETAIL tax-zone lookup for Sundial customers.
//
// Maps an Arizona city name to the Acumatica retail tax-zone code Harmon uses on
// the customer record. Kept as a plain config object so new cities/aliases can be
// added here without touching the sundial-acumatica-push handler.
//
// MATCHING RULE: city names are normalized before lookup (uppercase, punctuation
// -> space, internal whitespace collapsed, trimmed) so "Prescott Valley",
// "  prescott   valley " and "PRESCOTT VALLEY" all resolve identically. The map
// keys are normalized with the SAME function at load time, so keys and inputs are
// always compared on equal footing.
//
// NEVER guess a zone: an unmatched city returns { matched:false, zone:null } and
// the caller OMITS TaxZone entirely (leaving it blank in Acumatica).

// Raw city -> retail zone code. Human-readable keys; normalized at load below.
const RAW_TAX_ZONES = {
  "APACHE JUNCTION": "12APACHEJR",
  AVONDALE: "08AVONDALR",
  BENSON: "02BENSONR",
  BISBEE: "02BISBEER",
  BUCKEYE: "08BUCKEYER",
  "CAMP VERDE": "14CAMPVERR",
  CAREFREE: "08CAREFRER",
  "CASA GRANDE": "12CASAGRAR",
  "CAVE CREEK": "08CAVECRER",
  CHANDLER: "08CHANDLER",
  "CHINO VALLEY": "14CHINOVAR",
  CLARKDALE: "14CLARKDAR",
  COOLIDGE: "12CLDGER",
  COTTONWOOD: "14COTTONWR",
  DOUGLAS: "02DOUGLASR",
  "EL MIRAGE": "08ELMIRAGR",
  ELOY: "12ELOYR",
  FLAGSTAFF: "03FLAGSTAR",
  FLORENCE: "12FLORENCR",
  "FOUNTAIN HILLS": "08FOUNTAIR",
  "GILA BEND": "08GILABENR",
  GILBERT: "08GILBERTR",
  GLENDALE: "08GLENDALR",
  GLOBE: "04GLOBER",
  GOODYEAR: "08GOODYEAR",
  HOLBROOK: "10HOLBROOR",
  KINGMAN: "09KINGMANR",
  "LA PAZ": "07LAPAZR",
  "LAKE HAVASU": "09LAKEHAVR",
  "LITCHFIELD PARK": "08LITCHFIR",
  MARANA: "11MARANAR",
  MARICOPA: "12MARICCR",
  MESA: "08MESAR",
  "ORO VALLEY": "11OROVALR",
  "PARADISE VALLEY": "08PARADISR",
  PARKER: "07PARKERR",
  PAYSON: "04PAYSONR",
  PEORIA: "08PEORIAR",
  PHOENIX: "08PHOENIXR",
  PRESCOTT: "14PRESCOTR",
  "PRESCOTT VALLEY": "14PRESVALR",
  "QUEEN CREEK": "08QUEENCRR",
  SAHUARITA: "11SAHUARR",
  "SAN LUIS": "15SANLUISR",
  "SANTA CRUZ": "13SANTACRR",
  SCOTTSDALE: "08SCOTTSDR",
  SEDONA: "14SEDONAR",
  "SHOW LOW": "10SHOWLOWR",
  "SIERRA VISTA": "02SIERRAVR",
  SNOWFLAKE: "10SNOWFLKR",
  SOMERTON: "15SOMERRT",
  SURPRISE: "08SURPRISR",
  TEMPE: "08TEMPER",
  THATCHER: "16THATCHRT",
  TOLLESON: "08TOLLESOR",
  TOMBSTONE: "02TOMBSTOR",
  TUCSON: "11TUCSONR",
  WICKENBURG: "08WICKENBR",
  WILLIAMS: "03WILLIAMR",
  WINSLOW: "10WINSLOWR",
  YOUNGTOWN: "08YOUNGTOR",

  // Alias spellings mapping to the same codes as their canonical city.
  DEWEY: "14DEWEYHUR",
  "DEWEY-HUMBOLDT": "14DEWEYHUR",
  "SNOW FLAKE": "10SNOWFLKR", // two-word form; SNOWFLAKE also above
};

/**
 * Normalize a city name for matching: uppercase, punctuation -> space, collapse
 * internal whitespace, trim. Turning punctuation into a space (rather than
 * deleting it) keeps "Dewey-Humboldt" as two words ("DEWEY HUMBOLDT") instead of
 * fusing them, which matters for multi-word city names.
 *
 * @param {*} city
 * @returns {string} normalized city ("" for null/blank input)
 */
export function normalizeCity(city) {
  return String(city ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9\s]/g, " ") // punctuation/symbols -> space
    .replace(/\s+/g, " ")
    .trim();
}

// Build the normalized lookup once at module load. Keys are normalized with the
// exact function used on inputs, so e.g. the "DEWEY-HUMBOLDT" key becomes
// "DEWEY HUMBOLDT" and matches an input of "Dewey-Humboldt".
const NORMALIZED_TAX_ZONES = new Map();
for (const [rawCity, zone] of Object.entries(RAW_TAX_ZONES)) {
  NORMALIZED_TAX_ZONES.set(normalizeCity(rawCity), zone);
}

/**
 * Look up the retail tax zone for a city.
 *
 * @param {*} city - the raw City__c value (any casing/spacing/punctuation)
 * @returns {{ zone: string|null, matched: boolean, normalized: string }}
 *   zone: the matched retail zone code, or null if no match (caller OMITS TaxZone)
 *   matched: true iff a zone was found
 *   normalized: the normalized city string (for logging an unmatched city)
 */
export function lookupTaxZone(city) {
  const normalized = normalizeCity(city);
  if (normalized === "") return { zone: null, matched: false, normalized };
  const zone = NORMALIZED_TAX_ZONES.get(normalized) ?? null;
  return { zone, matched: zone !== null, normalized };
}
