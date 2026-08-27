// Loader for docs/integrations/dealer-aliases.csv — the reviewed dealer-name aliases.
// D-064 amendment A2. Backfill-only.
//
// ⚠️ THIS LIVES IN scripts/, NOT lib/, ON PURPOSE. `lib/` is the shared layer bundled
// into every Lambda zip; nothing at runtime resolves a dealer by name, and shipping a
// name-matching helper into the Lambdas would invite exactly that. Both backfill
// scripts import it from here.
//
// THE FILE IS THE DECISION. A row in the CSV means a human looked at two spellings and
// judged them one organization. The script never infers a merge -- it reports
// candidates (see findSuffixCandidates in backfill-dealers.mjs) and applies only what
// the file says. Same contract as docs/integrations/dealer-vendor-map.csv under D-060,
// and for the same reason: "are these the same company" is a fact about the world, not
// a property of the strings.
//
// COLUMNS
//   DealerName  the CANONICAL name. One Sundial_Dealer__c row is created under this.
//   Alias       the variant spelling. Never gets a row of its own; folds into the above.
//   Object      where the alias spelling is seen (Customer | Solar | Both). Informational.
//   Note        why. Free text, quoted.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CSV_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "docs/integrations/dealer-aliases.csv"
);

/**
 * Minimal RFC-4180 field splitter: quoted fields may contain commas and doubled quotes.
 * Written out rather than pulled in, because the alternative is a dependency in the
 * deploy path for four columns of reviewed text.
 */
function splitCsvLine(line) {
  const out = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQuotes = false;
      } else cur += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ",") { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

/**
 * @returns {{rows: Array<{dealerName,alias,object,note}>, byAlias: Map<string,string>, path: string}}
 *   byAlias maps the NORMALIZED alias to the canonical DealerName.
 */
export function loadDealerAliases() {
  const raw = fs.readFileSync(CSV_PATH, "utf8").split("\r\n").join("\n").trim();
  const [header, ...lines] = raw.split("\n");
  const cols = splitCsvLine(header);
  const expected = ["DealerName", "Alias", "Object", "Note"];
  if (cols.join(",") !== expected.join(",")) {
    throw new Error(
      `dealer-aliases.csv header is [${cols.join(", ")}], expected [${expected.join(", ")}]. ` +
        `Refusing to guess which column is which — a swapped DealerName/Alias would merge ` +
        `every dealer into its own variant spelling.`
    );
  }

  const rows = [];
  const byAlias = new Map();
  for (const [i, line] of lines.entries()) {
    if (!line.trim()) continue;
    const [dealerName, alias, object, note] = splitCsvLine(line);
    if (!dealerName || !alias) {
      throw new Error(`dealer-aliases.csv line ${i + 2}: DealerName and Alias are both required.`);
    }
    if (normalizeDealerName(dealerName) === normalizeDealerName(alias)) {
      throw new Error(
        `dealer-aliases.csv line ${i + 2}: "${alias}" and "${dealerName}" normalize identically, ` +
          `so this row does nothing. Remove it, or fix the spelling it was meant to fold.`
      );
    }
    const key = normalizeDealerName(alias);
    if (byAlias.has(key) && byAlias.get(key) !== dealerName) {
      throw new Error(
        `dealer-aliases.csv line ${i + 2}: "${alias}" is already mapped to ` +
          `"${byAlias.get(key)}" and cannot also map to "${dealerName}".`
      );
    }
    byAlias.set(key, dealerName);
    rows.push({ dealerName, alias, object, note });
  }

  // A canonical name that is ITSELF an alias would make resolution order matter, and
  // the file would quietly mean different things depending on row order.
  for (const r of rows) {
    const k = normalizeDealerName(r.dealerName);
    if (byAlias.has(k)) {
      throw new Error(
        `dealer-aliases.csv: "${r.dealerName}" is used as a canonical name AND as an alias ` +
          `of "${byAlias.get(k)}". Chains are not supported — collapse it to one hop.`
      );
    }
  }

  return { rows, byAlias, path: CSV_PATH };
}

/** Case, punctuation and whitespace insensitive. The ONE normalizer both scripts use. */
export function normalizeDealerName(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** Resolve a raw picklist value to its canonical dealer name (identity if unaliased). */
export function resolveDealerName(value, byAlias) {
  return byAlias.get(normalizeDealerName(value)) ?? String(value);
}
