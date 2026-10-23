// GENERATED FILE — DO NOT EDIT BY HAND.
//
// Source:    docs/integrations/dealer-aliases.csv  (14 rows)
// Generator: scripts/generate-dealer-aliases.mjs
// Regenerate: node scripts/generate-dealer-aliases.mjs
//
// Variant dealer spelling -> canonical Sundial_Dealer__c Name. A row means a human judged
// two spellings one organization (D-064 A2). Used at runtime by the Aurora auto-create
// (D-085 am. 1) AFTER an exact Name match fails — never to invent a dealer.

/** Normalized alias -> canonical DealerName. */
export const DEALER_ALIASES = new Map([
  ["alternative energy az", "Alternative Energy"],
  ["azray solar", "Azray Solar LLC"],
  ["blue sky", "Blue Sky Solar"],
  ["blueberry hill", "Blueberry Hill Co LLC"],
  ["i am energy", "I Am Energy Group"],
  ["james campbell consulting", "James Campbell Consulting LLC"],
  ["machometa", "Machometa Enterprises"],
  ["residental solar brokers", "Residential Solar Brokers"],
  ["solar 4 les", "Solar4Les"],
  ["solar buddy", "Solar Buddy AZ"],
  ["solar specialists", "Solar Specialist LLC"],
  ["sonoran solar", "Sonoran Solar - Jared Alberts"],
  ["sunus", "Sunus Technologies"],
  ["valley energy consoltants", "Valley Energy Consultants"],
]);

/** Case, punctuation and whitespace insensitive — the same normalizer as scripts/dealer-aliases.mjs. */
export function normalizeDealerName(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** The canonical name a variant spelling folds into, or null when the CSV has no row for it. */
export function resolveDealerAlias(value) {
  return DEALER_ALIASES.get(normalizeDealerName(value)) ?? null;
}
