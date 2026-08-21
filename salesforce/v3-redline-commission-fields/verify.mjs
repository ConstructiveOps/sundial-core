// Offline validation of the generated D19 formulas.
//
// Salesforce formulas cannot be executed locally, so this reads the ACTUAL <formula>
// text out of the generated .object files, transpiles the small subset of the formula
// language they use into JavaScript, and evaluates it against worked examples.
//
// That is deliberately not the same as re-implementing the maths in JS and comparing:
// the thing under test is the formula TEXT that will be deployed. A typo'd field name,
// a missing adder, a per-watt adder in the flat group or a forgotten /100 on the markup
// all fail here rather than after a deploy.
//
// It does NOT validate Salesforce's compiled-size limit or its parser — only Check Only
// can do that, which is why it is step 1 of the deploy checklist.
//
// Run: node salesforce/v3-redline-commission-fields/verify.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/** Pull { api: formula } out of a generated .object file. */
function readFormulas(objName) {
  const xml = fs.readFileSync(path.join(here, "objects", `${objName}.object`), "utf8");
  const out = {};
  for (const m of xml.matchAll(/<fields>([\s\S]*?)<\/fields>/g)) {
    const api = /<fullName>([^<]+)<\/fullName>/.exec(m[1])[1];
    const f = /<formula>([\s\S]*?)<\/formula>/.exec(m[1]);
    if (f) out[api] = f[1].replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
  }
  return out;
}

/**
 * Transpile the formula subset to JS.
 *
 * Order matters: the comparison shapes are rewritten before the bare BLANKVALUE/TEXT
 * unwrapping, and the formula-field references LAST with a negative lookbehind, or a
 * name already rewritten to `V.Total_Adder_Price__c` gets a second `V.` prefix.
 *
 * Salesforce text comparison with `=` is CASE-INSENSITIVE (that is why EXACT() exists),
 * so eq() mirrors that. It matters here: the Lightreach picklist value is spelled
 * "Lightreach" on Customer and "LightReach" on Solar.
 */
function buildEvaluator(formula) {
  // eq(x,y) for the three comparison shapes used.
  let js = formula
    .replace(/TEXT\(([A-Za-z0-9_]+)\)="([^"]*)"/g, 'eq(str(V.$1),"$2")')
    // numeric equality: the only `=0` comparisons are the zero-watts guards
    .replace(/\)=0/g, ")===0")
    .replace(/\bBLANKVALUE\(([A-Za-z0-9_]+),\s*0\)/g, "num(V.$1)")
    .replace(/\bTEXT\(([A-Za-z0-9_]+)\)/g, "str(V.$1)")
    .replace(/\bISBLANK\(/g, "isBlank(")
    .replace(/\bOR\(/g, "or(")
    .replace(/\bIF\(/g, "iff(")
    .replace(/\bNULL\b/g, "null")
    // Formula-field references resolve through the same value bag. LAST, and with a
    // negative lookbehind: BLANKVALUE(Total_Adder_Price__c,0) has already become
    // num(V.Total_Adder_Price__c) above, and without the guard this would prefix it a
    // second time into V.V.Total_Adder_Price__c.
    .replace(/(?<!V\.)\b(Commission_Redline_PPW__c|Total_Adder_Price__c|Commission_Total__c)\b/g, "V.$1");

  // eslint-disable-next-line no-new-func
  return new Function(
    "V", "num", "str", "isBlank", "or", "iff", "eq",
    `return (${js});`
  );
}

const num = (v) => (v === null || v === undefined || v === "" || Number.isNaN(Number(v)) ? 0 : Number(v));
const str = (v) => (v === null || v === undefined ? "" : String(v));
const isBlank = (v) => v === null || v === undefined || v === "";
const or = (...a) => a.some(Boolean);
// BlankAsBlanks: any blank operand makes the whole arithmetic result blank. iff() is
// where that surfaces, since the formulas guard with it.
const iff = (c, a, b) => (c ? a : b);
const eq = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

/** Evaluate the four fields in dependency order, mimicking Salesforce's inlining. */
function evaluate(objName, values) {
  const F = readFormulas(objName);
  const V = { ...values };
  for (const api of [
    "Commission_Redline_PPW__c",
    "Total_Adder_Price__c",
    "Commission_Total__c",
    "Commission_Total_PPW__c",
  ]) {
    const fn = buildEvaluator(F[api]);
    let out = fn(V, num, str, isBlank, or, iff, eq);
    // BlankAsBlanks propagation: an expression touching a blank formula field is blank.
    if (typeof out === "number" && Number.isNaN(out)) out = null;
    V[api] = out;
  }
  return V;
}

// ---------------------------------------------------------------------------
// Worked examples
// ---------------------------------------------------------------------------
const ADDERS_3110 = {
  Adder_Sub_Panel_Price__c: 500, Adder_Sub_Panel_Qty__c: 1,
  Adder_Structural_Price__c: 500, Adder_Structural_Qty__c: 1,
  Adder_Bird_Blocking_Price__c: 0.1, Adder_Bird_Blocking_Qty__c: 1,
  Adder_Software_Fee_Price__c: 30, Adder_Software_Fee_Qty__c: 1,
  Adder_Active_Monitoring_Price__c: 100, Adder_Active_Monitoring_Qty__c: 1,
  Adder_LR_Battery_Warranty_Price__c: 600, Adder_LR_Battery_Warranty_Qty__c: 1,
  Adder_Referral_Fee_Price__c: 500, Adder_Referral_Fee_Qty__c: 1,
};

let failures = 0;
const check = (label, got, exp, tol = 0.005) => {
  const ok = exp === null ? got === null : typeof got === "number" && Math.abs(got - exp) <= tol;
  if (!ok) { console.error(`  FAIL ${label}: expected ${exp}, got ${got}`); failures++; }
  else console.log(`  ok   ${label} = ${got}`);
};

console.log("\n=== Sundial_Solar__c — the D19 worked example ===");
{
  const v = evaluate("Sundial_Solar__c", {
    System_Size__c: 8.8,
    Contract_Amount__c: 36502,
    Sales_Company_Harmon_Solar_or_Third__c: "Blue Sky Solar", // external
    Sales_Type_Partner__c: "GoodLeap",                        // not Lightreach
    ...ADDERS_3110,
  });
  check("redline (external, non-Lightreach)", v.Commission_Redline_PPW__c, 1.85);
  check("total adder price", v.Total_Adder_Price__c, 3110);
  check("commission total", v.Commission_Total__c, 17112);
  check("commission $/W", v.Commission_Total_PPW__c, 17112 / 8800);
}

console.log("\n=== the other three redlines ===");
for (const [company, finance, expected] of [
  ["Blue Sky Solar", "LightReach", 1.75],
  ["Harmon Solar", "LightReach", 2.1],
  ["Harmon Solar", "GoodLeap", 2.2],
]) {
  const v = evaluate("Sundial_Solar__c", {
    System_Size__c: 8.8, Contract_Amount__c: 36502,
    Sales_Company_Harmon_Solar_or_Third__c: company, Sales_Type_Partner__c: finance,
    ...ADDERS_3110,
  });
  check(`${company} / ${finance}`, v.Commission_Redline_PPW__c, expected);
}

console.log("\n=== Sundial_Customer__c — same example, its own source fields ===");
{
  const v = evaluate("Sundial_Customer__c", {
    Final_System_Size_kW__c: 8.8,
    Contract_Amount__c: 36502,
    Sales_Company__c: "Third-Party Dealer",
    Financing_Partner__c: "GoodLeap",
    ...ADDERS_3110,
  });
  check("redline", v.Commission_Redline_PPW__c, 1.85);
  check("total adder price", v.Total_Adder_Price__c, 3110);
  check("commission total", v.Commission_Total__c, 17112);
}
{
  // The casing trap: Customer's picklist says "Lightreach", Solar's says "LightReach".
  const v = evaluate("Sundial_Customer__c", {
    Final_System_Size_kW__c: 8.8, Contract_Amount__c: 36502,
    Sales_Company__c: "Harmon Solar", Financing_Partner__c: "Lightreach", ...ADDERS_3110,
  });
  check("Customer 'Lightreach' casing resolves", v.Commission_Redline_PPW__c, 2.1);
}

console.log("\n=== blank / degenerate inputs ===");
{
  const v = evaluate("Sundial_Solar__c", {
    System_Size__c: 8.8, Contract_Amount__c: 36502,
    Sales_Company_Harmon_Solar_or_Third__c: null, Sales_Type_Partner__c: "GoodLeap",
    ...ADDERS_3110,
  });
  check("blank sales company -> redline NULL", v.Commission_Redline_PPW__c, null);
  check("blank sales company -> commission NULL", v.Commission_Total__c, null);
}
{
  const v = evaluate("Sundial_Solar__c", {
    System_Size__c: 0, Contract_Amount__c: 36502,
    Sales_Company_Harmon_Solar_or_Third__c: "Harmon Solar", Sales_Type_Partner__c: "Cash",
    ...ADDERS_3110,
  });
  check("zero watts -> commission NULL", v.Commission_Total__c, null);
  check("zero watts -> $/W NULL", v.Commission_Total_PPW__c, null);
}
{
  const v = evaluate("Sundial_Solar__c", {
    System_Size__c: 8.8, Contract_Amount__c: 36502,
    Sales_Company_Harmon_Solar_or_Third__c: "Harmon Solar", Sales_Type_Partner__c: null,
  });
  // No adders at all, no finance source -> internal + "other" = 2.20.
  check("no adders -> adder price 0", v.Total_Adder_Price__c, 0);
  check("blank finance -> internal non-Lightreach", v.Commission_Redline_PPW__c, 2.2);
  check("commission with no adders", v.Commission_Total__c, 36502 - 2.2 * 8800);
}

console.log("\n=== per-watt and NS handling ===");
{
  const v = evaluate("Sundial_Solar__c", {
    System_Size__c: 8.8, Contract_Amount__c: 36502,
    Sales_Company_Harmon_Solar_or_Third__c: "Harmon Solar", Sales_Type_Partner__c: "Cash",
    Adder_Flat_Roof_Price__c: 0.1, Adder_Flat_Roof_Qty__c: 2, // per-watt x qty
  });
  check("per-watt adder = price x watts x qty", v.Total_Adder_Price__c, 0.1 * 8800 * 2);
}
{
  const v = evaluate("Sundial_Solar__c", {
    System_Size__c: 8.8, Contract_Amount__c: 36502,
    Sales_Company_Harmon_Solar_or_Third__c: "Harmon Solar", Sales_Type_Partner__c: "Cash",
    NS_Adder_1_Material_Cost__c: 1000, NS_Adder_1_Markup_Percent__c: 25, NS_Adder_1_Labor_Hours__c: 10,
    NS_Adder_5_Material_Cost__c: 500, NS_Adder_5_Markup_Percent__c: 25, NS_Adder_5_Labor_Hours__c: 4,
  });
  // 1000*1.25 + 10*33*1.75  +  500*1.25 + 4*33*1.75
  check("NS blocks marked up + labour", v.Total_Adder_Price__c, 1250 + 577.5 + 625 + 231);
}

console.log(
  failures === 0
    ? "\nALL FORMULA CHECKS PASS (evaluated against the generated formula text)\n"
    : `\n${failures} CHECK(S) FAILED\n`
);
process.exitCode = failures === 0 ? 0 : 1;
