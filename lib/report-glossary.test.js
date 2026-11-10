// node --test lib/report-glossary.test.js — the glossary the assistant reads (D-092).

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { GLOSSARY } from "./report-glossary.js";
import { SOLAR_TERMINAL_STAGES, SOLAR_ACTIVE_DESPITE_TERM } from "./stage-rules.js";
import { RELATIVE_TOKENS } from "./report-def.js";
import { CATALOG } from "./report-catalog/index.js";
import { moduleFor } from "../scripts/generate-report-glossary.mjs";

const md = (await readFile(new URL("../docs/reporting-glossary.md", import.meta.url), "utf8")).replace(/\r\n/g, "\n");

test("lib/report-glossary.js is the doc, regenerated (run scripts/generate-report-glossary.mjs)", async () => {
  assert.equal(GLOSSARY, md);
  const mod = (await readFile(new URL("./report-glossary.js", import.meta.url), "utf8")).replace(/\r\n/g, "\n");
  assert.equal(mod, moduleFor(md));
});

test("the terminal solar stage line is exactly lib/stage-rules.js", () => {
  const line = GLOSSARY.split("\n").find((l) => l.trim().startsWith("Terminal solar stages:"));
  assert.ok(line, "the glossary has a 'Terminal solar stages:' line");
  const listed = line.split(":")[1].split(";").map((s) => s.trim()).filter(Boolean);
  assert.deepEqual(listed, [...SOLAR_TERMINAL_STAGES]);
  for (const s of SOLAR_ACTIVE_DESPITE_TERM) assert.ok(GLOSSARY.includes(`"${s}"`), `${s} is named as active`);
});

test("every relative token is listed", () => {
  for (const t of RELATIVE_TOKENS) assert.ok(GLOSSARY.includes(`\`${t}\``), t);
  assert.ok(GLOSSARY.includes("`last_n_days:N`"));
});

test("every <alias>.<column> the glossary names is a real catalog column of that alias's object", () => {
  const aliasObject = {
    solar: "solar", customer: "customer", job: "job", invoice: "serviceinvoice", payment: "servicepayment",
    payments: null, estimate: "estimate", call: "servicecall", rep: "user", dealer: "dealer", tech: "user", sold_by: "user",
  };
  const refs = [...GLOSSARY.matchAll(/`([a-z_]+)\.([a-z_0-9]+)`/g)].map((m) => [m[1], m[2]]);
  assert.ok(refs.length > 20);
  for (const [alias, column] of refs) {
    assert.ok(alias in aliasObject, `unknown alias ${alias}`);
    if (aliasObject[alias] === null) continue; // a rollup's measures (payments.amount_paid …)
    const f = CATALOG[aliasObject[alias]].fields.find((x) => x.column === column);
    assert.ok(f && f.reportable, `${alias}.${column}`);
  }
});

test("every picklist value the glossary quotes for a status list exists", () => {
  const pv = (o, c) => CATALOG[o].fields.find((f) => f.column === c).picklistValues.map((p) => (typeof p === "string" ? p : p.value));
  for (const v of pv("job", "status")) assert.ok(GLOSSARY.includes(v), `job.status ${v}`);
  for (const v of pv("serviceinvoice", "status")) assert.ok(GLOSSARY.includes(v), `invoice.status ${v}`);
  for (const v of pv("solar", "stage")) assert.ok(GLOSSARY.includes(v), `solar.stage ${v}`);
  for (const v of pv("customer", "stage")) assert.ok(GLOSSARY.includes(v), `customer.stage ${v}`);
});
