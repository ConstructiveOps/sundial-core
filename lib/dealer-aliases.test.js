// The generated alias copy must match the reviewed CSV (D-085 am. 1).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { DEALER_ALIASES, resolveDealerAlias, normalizeDealerName } from "./dealer-aliases.js";
import { loadDealerAliases, normalizeDealerName as scriptNormalize } from "../scripts/dealer-aliases.mjs";
import { renderDealerAliases } from "../scripts/generate-dealer-aliases.mjs";

test("lib/dealer-aliases.js is not stale against docs/integrations/dealer-aliases.csv", () => {
  const have = fs.readFileSync(new URL("./dealer-aliases.js", import.meta.url), "utf8").split("\r\n").join("\n");
  assert.equal(have, renderDealerAliases(), "run: node scripts/generate-dealer-aliases.mjs");
  assert.deepEqual([...DEALER_ALIASES].sort(), [...loadDealerAliases().byAlias].sort());
});

test("one normalizer: the runtime copy and the backfill loader agree", () => {
  for (const s of ["Blue Sky", "  I AM ENERGY ", "Mr. Clutch Solar", "Sky's the Limit"]) {
    assert.equal(normalizeDealerName(s), scriptNormalize(s));
  }
});

test("an alias resolves to its canonical name; anything else is null, never a guess", () => {
  assert.equal(resolveDealerAlias("blue sky"), "Blue Sky Solar");
  assert.equal(resolveDealerAlias("Blue Sky Solar"), null, "a canonical name is not its own alias");
  assert.equal(resolveDealerAlias("Some Dealer Nobody Reviewed"), null);
});
