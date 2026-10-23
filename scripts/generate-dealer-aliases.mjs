// Generate lib/dealer-aliases.js from docs/integrations/dealer-aliases.csv.
//
//   node scripts/generate-dealer-aliases.mjs           # rewrite the generated file
//   node scripts/generate-dealer-aliases.mjs --check   # exit 1 if the file is stale
//
// WHY A GENERATED COPY (D-085 am. 1, 2026-10-22). Until now the aliases were backfill-
// only and lived in scripts/ on purpose. The Aurora auto-create now resolves a dealer
// partner's name to a Sundial_Dealer__c at runtime (Tim's spec), and a Lambda bundle
// cannot read a CSV out of docs/. Same pattern as the dealer-vendor map: the CSV stays
// the reviewed source of truth, this file is a build artifact, and --check (plus
// lib/dealer-aliases.test.js) makes a stale copy a loud failure.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadDealerAliases } from "./dealer-aliases.mjs";

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "lib/dealer-aliases.js");

export function renderDealerAliases() {
  const { rows, byAlias } = loadDealerAliases();
  const entries = [...byAlias.entries()].sort(([a], [b]) => a.localeCompare(b));
  return [
    "// GENERATED FILE — DO NOT EDIT BY HAND.",
    "//",
    `// Source:    docs/integrations/dealer-aliases.csv  (${rows.length} rows)`,
    "// Generator: scripts/generate-dealer-aliases.mjs",
    "// Regenerate: node scripts/generate-dealer-aliases.mjs",
    "//",
    "// Variant dealer spelling -> canonical Sundial_Dealer__c Name. A row means a human judged",
    "// two spellings one organization (D-064 A2). Used at runtime by the Aurora auto-create",
    "// (D-085 am. 1) AFTER an exact Name match fails — never to invent a dealer.",
    "",
    "/** Normalized alias -> canonical DealerName. */",
    "export const DEALER_ALIASES = new Map([",
    ...entries.map(([k, v]) => `  [${JSON.stringify(k)}, ${JSON.stringify(v)}],`),
    "]);",
    "",
    "/** Case, punctuation and whitespace insensitive — the same normalizer as scripts/dealer-aliases.mjs. */",
    "export function normalizeDealerName(s) {",
    '  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();',
    "}",
    "",
    "/** The canonical name a variant spelling folds into, or null when the CSV has no row for it. */",
    "export function resolveDealerAlias(value) {",
    "  return DEALER_ALIASES.get(normalizeDealerName(value)) ?? null;",
    "}",
    "",
  ].join("\n");
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const out = renderDealerAliases();
  if (process.argv[2] === "--check") {
    // Compare with line endings normalized: a CRLF checkout is not drift.
    const have = fs.existsSync(OUT) ? fs.readFileSync(OUT, "utf8").split("\r\n").join("\n") : "";
    if (have !== out) {
      console.error("lib/dealer-aliases.js is STALE — run: node scripts/generate-dealer-aliases.mjs");
      process.exit(1);
    }
    console.log("lib/dealer-aliases.js is up to date.");
  } else {
    fs.writeFileSync(OUT, out);
    console.log(`wrote ${OUT}`);
  }
}
