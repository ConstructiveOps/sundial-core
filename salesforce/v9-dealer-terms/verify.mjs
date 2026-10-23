// Offline validation of the v9 dealer-terms package (D-085).
//
// Like v3's verify.mjs, this evaluates the ACTUAL <formula> text from the generated
// .object files rather than re-implementing the logic. v9's formulas use more of the
// language than v3's (dates, AND/NOT, relationship paths, a cross-object formula, text
// concatenation), so instead of v3's regex transpiler this has a small real parser for
// the subset: numbers, strings, field paths, = <> < <= > >= + - * / &, and IF / AND /
// OR / NOT / ISBLANK / TEXT / DATEVALUE / DATE / BLANKVALUE / NULL.
//
// THE PARITY CHECKS ARE THE POINT. "Every pre-9/4 record must compute exactly what it
// computes today" is checked by evaluating the LIVE org formula (captured below from the
// describe on 2026-10-22) and the new one over the same grid of inputs and comparing.
//
// It does NOT validate Salesforce's parser or its compiled-size limit — Check Only does.
//
// Run: node salesforce/v9-dealer-terms/verify.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

// The live formulas this package replaces — describe, 2026-10-22. The Customer one has
// an "Invictus Energy" branch on Sales_Company__c that the repo's v8 does not; it could
// never be true (that picklist holds only "Harmon Solar" / "Third-Party Dealer").
const LIVE = {
  customerRedline:
    'IF(ISBLANK(TEXT(Sales_Company__c)),NULL,IF(TEXT(Sales_Company__c)="Harmon Solar",IF(TEXT(Financing_Partner__c)="Lightreach",2.10,2.20),IF(TEXT(Financing_Partner__c)="Lightreach",IF(DATEVALUE(CreatedDate)>=DATE(2026,9,4),1.65,1.75),IF(AND(TEXT(Sales_Company__c)="Invictus Energy",DATEVALUE(CreatedDate)>=DATE(2026,9,4)),1.75,1.85))))',
  solarRedline:
    'IF(ISBLANK(TEXT(Sales_Company_Harmon_Solar_or_Third__c)),NULL,IF(TEXT(Sales_Company_Harmon_Solar_or_Third__c)="Harmon Solar",IF(TEXT(Sales_Type_Partner__c)="LightReach",2.10,2.20),IF(TEXT(Sales_Type_Partner__c)="LightReach",IF(AND(NOT(ISBLANK(Sundial_Customer__c)),DATEVALUE(Sundial_Customer__r.CreatedDate)>=DATE(2026,9,4)),1.65,1.75),1.85)))',
  customerRepName: 'Sales_Rep__r.First_Name__c  + " " +  Sales_Rep__r.Last_Name__c',
  solarRepName: 'Sales_Rep__r.First_Name__c + " " +  Sales_Rep__r.Last_Name__c',
};

const unesc = (s) =>
  String(s).replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

function readFields(dir, obj) {
  const xml = fs.readFileSync(path.join(dir, "objects", `${obj}.object`), "utf8");
  const out = {};
  for (const m of xml.matchAll(/<fields>([\s\S]*?)<\/fields>/g)) {
    const tags = {};
    for (const t of m[1].matchAll(/<([A-Za-z]+)>([\s\S]*?)<\/\1>/g)) tags[t[1]] = unesc(t[2]);
    out[tags.fullName] = tags;
  }
  return out;
}

const V9 = {
  Sundial_Dealer__c: readFields(here, "Sundial_Dealer__c"),
  Sundial_Customer__c: readFields(here, "Sundial_Customer__c"),
  Sundial_Solar__c: readFields(here, "Sundial_Solar__c"),
};
const V8 = {
  Sundial_Customer__c: readFields(path.join(here, "..", "v8-lightreach-redline-date"), "Sundial_Customer__c"),
  Sundial_Solar__c: readFields(path.join(here, "..", "v8-lightreach-redline-date"), "Sundial_Solar__c"),
};
const V3 = {
  Sundial_Customer__c: readFields(path.join(here, "..", "v3-redline-commission-fields"), "Sundial_Customer__c"),
  Sundial_Solar__c: readFields(path.join(here, "..", "v3-redline-commission-fields"), "Sundial_Solar__c"),
};

// ---------------------------------------------------------------------------
// A tiny formula interpreter
// ---------------------------------------------------------------------------
function tokenize(src) {
  const toks = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '"') {
      let j = i + 1, s = "";
      while (src[j] !== '"') { if (j >= src.length) throw new Error("unterminated string"); s += src[j++]; }
      toks.push({ t: "str", v: s }); i = j + 1; continue;
    }
    if (/[0-9]/.test(c)) {
      const m = /^[0-9]+(\.[0-9]+)?/.exec(src.slice(i));
      toks.push({ t: "num", v: Number(m[0]) }); i += m[0].length; continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*/.exec(src.slice(i));
      toks.push({ t: "id", v: m[0] }); i += m[0].length; continue;
    }
    const two = src.slice(i, i + 2);
    if (["<=", ">=", "<>", "!=", "=="].includes(two)) { toks.push({ t: "op", v: two }); i += 2; continue; }
    if ("=<>+-*/&(),".includes(c)) { toks.push({ t: "op", v: c }); i++; continue; }
    throw new Error(`unexpected character ${c} at ${i}`);
  }
  return toks;
}

// Precedence: comparison < additive (+ - &) < multiplicative.
function parse(src) {
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p];
  const take = (v) => {
    const t = toks[p++];
    if (v && (!t || t.v !== v)) throw new Error(`expected ${v}, got ${t?.v}`);
    return t;
  };
  function primary() {
    const t = take();
    if (t.t === "num" || t.t === "str") return { k: "lit", v: t.v };
    if (t.v === "(") { const e = cmp(); take(")"); return e; }
    if (t.v === "-") return { k: "neg", e: primary() };
    if (t.t === "id") {
      if (peek()?.v === "(") {
        take("(");
        const args = [];
        if (peek().v !== ")") { args.push(cmp()); while (peek().v === ",") { take(","); args.push(cmp()); } }
        take(")");
        return { k: "call", f: t.v.toUpperCase(), args };
      }
      if (t.v.toUpperCase() === "NULL") return { k: "lit", v: null };
      return { k: "ref", path: t.v };
    }
    throw new Error(`unexpected token ${t.v}`);
  }
  function mul() {
    let l = primary();
    while (["*", "/"].includes(peek()?.v)) { const op = take().v; l = { k: "bin", op, l, r: primary() }; }
    return l;
  }
  function add() {
    let l = mul();
    while (["+", "-", "&"].includes(peek()?.v)) { const op = take().v; l = { k: "bin", op, l, r: mul() }; }
    return l;
  }
  function cmp() {
    let l = add();
    while (["=", "==", "<>", "!=", "<", "<=", ">", ">="].includes(peek()?.v)) {
      const op = take().v; l = { k: "bin", op, l, r: add() };
    }
    return l;
  }
  const e = cmp();
  if (p !== toks.length) throw new Error(`trailing tokens at ${p}: ${toks[p].v}`);
  return e;
}

const blank = (v) => v === null || v === undefined || v === "";

/**
 * Evaluate a formula against a record.
 *
 * `rec` is a plain object: fields by API name; a relationship is a nested object under
 * its __r name (Dealer__r, Sundial_Customer__r, Sales_Rep__r). `formulas` maps a field
 * name to formula text for the record's object, so a reference to a formula field —
 * including across a relationship (Sundial_Customer__r.Commission_Redline_PPW__c) — is
 * evaluated, mirroring Salesforce's inlining.
 *
 * Dates are ISO strings: a DateTime is "YYYY-MM-DDThh:mm:ssZ", DATEVALUE takes its GMT
 * date ("YYYY-MM-DD"), so string comparison orders them correctly.
 *
 * BlankAsBlank: arithmetic with a blank operand is blank; a comparison with a blank
 * operand is false. Text `=` is case-INsensitive, as in Salesforce.
 */
function evaluate(src, rec, formulasFor) {
  const ast = parse(src);
  const resolve = (p, r, objFormulas) => {
    const parts = p.split(".");
    let cur = r, formulas = objFormulas;
    for (let i = 0; i < parts.length; i++) {
      const name = parts[i];
      if (cur === null || cur === undefined) return null;
      if (i === parts.length - 1) {
        if (formulas?.[name] && !(name in cur)) return evaluate(formulas[name], cur, formulasFor);
        return cur[name] ?? null;
      }
      cur = cur[name];
      formulas = formulasFor(name);
    }
    return null;
  };
  const ev = (n) => {
    switch (n.k) {
      case "lit": return n.v;
      case "ref": return resolve(n.path, rec, formulasFor(null, rec));
      case "neg": { const v = ev(n.e); return blank(v) ? null : -v; }
      case "bin": {
        const a = ev(n.l), b = ev(n.r);
        if (n.op === "&") return String(a ?? "") + String(b ?? "");
        if (n.op === "+" && (typeof a === "string" || typeof b === "string")) return String(a ?? "") + String(b ?? "");
        if (["+", "-", "*", "/"].includes(n.op)) {
          if (blank(a) || blank(b)) return null;
          return n.op === "+" ? a + b : n.op === "-" ? a - b : n.op === "*" ? a * b : b === 0 ? null : a / b;
        }
        if (n.op === "=" || n.op === "==") {
          if (typeof a === "string" || typeof b === "string") return String(a ?? "").toLowerCase() === String(b ?? "").toLowerCase();
          return blank(a) || blank(b) ? false : a === b;
        }
        if (n.op === "<>" || n.op === "!=") {
          if (typeof a === "string" || typeof b === "string") return String(a ?? "").toLowerCase() !== String(b ?? "").toLowerCase();
          return blank(a) || blank(b) ? false : a !== b;
        }
        if (blank(a) || blank(b)) return false;
        return n.op === "<" ? a < b : n.op === "<=" ? a <= b : n.op === ">" ? a > b : a >= b;
      }
      case "call": {
        const A = n.args;
        switch (n.f) {
          case "IF": return ev(A[0]) === true ? ev(A[1]) : ev(A[2]);
          case "AND": return A.every((x) => ev(x) === true);
          case "OR": return A.some((x) => ev(x) === true);
          case "NOT": return !(ev(A[0]) === true);
          case "ISBLANK": return blank(ev(A[0]));
          case "TEXT": { const v = ev(A[0]); return blank(v) ? "" : String(v); }
          case "BLANKVALUE": { const v = ev(A[0]); return blank(v) ? ev(A[1]) : v; }
          case "DATEVALUE": { const v = ev(A[0]); return blank(v) ? null : String(v).slice(0, 10); }
          case "DATE": {
            const [y, m, d] = A.map(ev);
            return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
          }
          default: throw new Error(`function ${n.f} not supported by this harness`);
        }
      }
    }
    throw new Error(`node ${n.k}`);
  };
  return ev(ast);
}

// Which object's formulas apply below a relationship name.
function makeFormulas(variant) {
  const customer = variant === "live"
    ? { Commission_Redline_PPW__c: LIVE.customerRedline }
    : { Commission_Redline_PPW__c: V9.Sundial_Customer__c.Commission_Redline_PPW__c.formula };
  return (rel, rec) => {
    if (rel === "Sundial_Customer__r") return customer;
    if (rel === null) return rec?.__formulas ?? null;
    return null;
  };
}

const F = {
  customerRedline: V9.Sundial_Customer__c.Commission_Redline_PPW__c.formula,
  solarRedline: V9.Sundial_Solar__c.Commission_Redline_PPW__c.formula,
  customerRepName: V9.Sundial_Customer__c.Sales_Rep_Name__c.formula,
  solarRepName: V9.Sundial_Solar__c.Sales_Rep_Name__c.formula,
  customerDealerName: V9.Sundial_Customer__c.Dealer_Display_Name__c.formula,
  solarDealerName: V9.Sundial_Solar__c.Dealer_Display_Name__c.formula,
};
const NEW = makeFormulas("new");
const OLD = makeFormulas("live");
const run = (src, rec, formulas = NEW) => evaluate(src, rec, formulas);

// ---------------------------------------------------------------------------
let failures = 0, checks = 0;
const same = (a, b, tol = 1e-9) =>
  a === null || b === null || typeof a !== "number" || typeof b !== "number" ? a === b : Math.abs(a - b) <= tol;
const check = (label, got, exp) => {
  checks++;
  if (!same(got, exp)) { console.error(`  FAIL ${label}: expected ${JSON.stringify(exp)}, got ${JSON.stringify(got)}`); failures++; }
  else console.log(`  ok   ${label} = ${JSON.stringify(got)}`);
};
// Parity checks print one line per grid, not per case.
const parity = (label, cases) => {
  checks++;
  const bad = cases.filter((c) => !same(c.got, c.exp));
  if (bad.length) {
    failures++;
    console.error(`  FAIL ${label}: ${bad.length} of ${cases.length} differ`);
    for (const b of bad.slice(0, 5)) console.error(`       ${JSON.stringify(b.input)} live=${b.exp} new=${b.got}`);
  } else console.log(`  ok   ${label} (${cases.length} cases identical)`);
};

const HARMON = { Id: "d-harmon", Name: "Harmon Solar", Redline_PPW__c: 2.2, Redline_LightReach_PPW__c: 2.1 };
const INVICTUS = { Id: "d-inv", Name: "Invictus Energy", Redline_PPW__c: 1.75, Redline_LightReach_PPW__c: 1.65 };
const OTHER = { Id: "d-hde", Name: "High Desert Energy", Redline_PPW__c: 1.85, Redline_LightReach_PPW__c: 1.65 };
const UNSEEDED = { Id: "d-new", Name: "New Dealer LLC", Redline_PPW__c: null, Redline_LightReach_PPW__c: null };
const withDealer = (d) => (d ? { Dealer__c: d.Id, Dealer__r: d } : { Dealer__c: null, Dealer__r: null });

const PRE_DATES = ["2025-03-01T12:00:00Z", "2026-09-03T23:59:59Z"];
const POST_DATES = ["2026-09-04T00:00:00Z", "2026-10-22T18:00:00Z"];

// ---------------------------------------------------------------------------
console.log("\n=== Customer redline — pre-cutover parity with the LIVE formula ===");
{
  const cases = [];
  // "Constructive Solar" is on 55 live records although it is not a picklist value
  // (unrestricted picklist) — it must stay "external", as it is today.
  for (const co of [null, "Harmon Solar", "Third-Party Dealer", "Constructive Solar", "Invictus Energy"])
    for (const fin of [null, "Lightreach", "Cash", "GoodLeap"])
      for (const created of PRE_DATES)
        for (const d of [null, HARMON, OTHER]) {
          const rec = { CreatedDate: created, Sales_Company__c: co, Financing_Partner__c: fin, ...withDealer(d) };
          cases.push({ input: { co, fin, created, dealer: d?.Name }, got: run(F.customerRedline, rec), exp: run(LIVE.customerRedline, rec) });
        }
  parity("every pre-2026-09-04 Customer computes what it computes today", cases);
}

console.log("\n=== Customer redline — on/after the cutover reads the dealer ===");
for (const created of POST_DATES) {
  const base = { CreatedDate: created, Sales_Company__c: "Third-Party Dealer" };
  check(`${created.slice(0, 10)} High Desert, Cash -> Redline_PPW__c`, run(F.customerRedline, { ...base, Financing_Partner__c: "Cash", ...withDealer(OTHER) }), 1.85);
  check(`${created.slice(0, 10)} High Desert, Lightreach -> LightReach rate`, run(F.customerRedline, { ...base, Financing_Partner__c: "Lightreach", ...withDealer(OTHER) }), 1.65);
}
{
  const post = { CreatedDate: "2026-10-01T15:00:00Z" };
  check("Harmon Solar dealer, Cash -> 2.20", run(F.customerRedline, { ...post, Financing_Partner__c: "Cash", ...withDealer(HARMON) }), 2.2);
  check("Harmon Solar dealer, Lightreach -> 2.10", run(F.customerRedline, { ...post, Financing_Partner__c: "Lightreach", ...withDealer(HARMON) }), 2.1);
  check("Invictus dealer, Cash -> 1.75", run(F.customerRedline, { ...post, Financing_Partner__c: "Cash", ...withDealer(INVICTUS) }), 1.75);
  check("Invictus dealer, Lightreach -> 1.65", run(F.customerRedline, { ...post, Financing_Partner__c: "Lightreach", ...withDealer(INVICTUS) }), 1.65);
  check("blank finance -> the non-LightReach rate", run(F.customerRedline, { ...post, Financing_Partner__c: null, ...withDealer(OTHER) }), 1.85);
  check("'LIGHTREACH' casing still matches (= is case-insensitive)", run(F.customerRedline, { ...post, Financing_Partner__c: "LIGHTREACH", ...withDealer(OTHER) }), 1.65);
  // The legacy picklist is NOT a fallback after the cutoff.
  check("NO dealer, sales company set -> NULL (picklist ignored)", run(F.customerRedline, { ...post, Sales_Company__c: "Harmon Solar", Financing_Partner__c: "Cash", ...withDealer(null) }), null);
  check("dealer set, NO sales company -> dealer rate", run(F.customerRedline, { ...post, Sales_Company__c: null, Financing_Partner__c: "Cash", ...withDealer(OTHER) }), 1.85);
  check("picklist says Harmon, dealer says High Desert -> dealer wins", run(F.customerRedline, { ...post, Sales_Company__c: "Harmon Solar", Financing_Partner__c: "Cash", ...withDealer(OTHER) }), 1.85);
  check("dealer with BLANK rates -> NULL, never a default", run(F.customerRedline, { ...post, Financing_Partner__c: "Cash", ...withDealer(UNSEEDED) }), null);
  check("dealer with BLANK LightReach rate -> NULL", run(F.customerRedline, { ...post, Financing_Partner__c: "Lightreach", ...withDealer({ ...OTHER, Redline_LightReach_PPW__c: null }) }), null);
}
{
  // The boundary is the GMT date, like the live formula: 23:59:59Z on Sep 3 is legacy.
  const rec = (created) => ({ CreatedDate: created, Sales_Company__c: "Third-Party Dealer", Financing_Partner__c: "Cash", ...withDealer(INVICTUS) });
  check("2026-09-03T23:59:59Z -> legacy 1.85", run(F.customerRedline, rec("2026-09-03T23:59:59Z")), 1.85);
  check("2026-09-04T00:00:00Z -> dealer 1.75", run(F.customerRedline, rec("2026-09-04T00:00:00Z")), 1.75);
}

console.log("\n=== Solar redline — legacy branch parity with the LIVE formula ===");
{
  const cases = [];
  const companies = [null, "Harmon Solar", "Blue Sky Solar", "Invictus Energy", "Harmon Oklahoma"];
  const finances = [null, "LightReach", "Lightreach", "Cash", "Sunrun Monthly"];
  for (const co of companies)
    for (const fin of finances) {
      // (a) no Customer linked
      const unlinked = { Sales_Company_Harmon_Solar_or_Third__c: co, Sales_Type_Partner__c: fin, Sundial_Customer__c: null, Sundial_Customer__r: null };
      cases.push({ input: { co, fin, customer: "none" }, got: run(F.solarRedline, unlinked), exp: run(LIVE.solarRedline, unlinked, OLD) });
      // (b) a Customer created before the cutoff, with or without a dealer
      for (const created of PRE_DATES)
        for (const d of [null, OTHER]) {
          const cust = { CreatedDate: created, Sales_Company__c: "Third-Party Dealer", Financing_Partner__c: "Cash", ...withDealer(d) };
          const rec = { ...unlinked, Sundial_Customer__c: "c1", Sundial_Customer__r: cust };
          cases.push({ input: { co, fin, created, dealer: d?.Name }, got: run(F.solarRedline, rec), exp: run(LIVE.solarRedline, rec, OLD) });
        }
    }
  parity("every Solar record with no Customer or a pre-cutover Customer computes what it computes today", cases);
}

console.log("\n=== Solar redline — post-cutover Customer: one deal, one redline ===");
{
  const cust = (fin, d) => ({ CreatedDate: "2026-10-01T15:00:00Z", Sales_Company__c: "Third-Party Dealer", Financing_Partner__c: fin, ...withDealer(d) });
  const solar = (c, extra = {}) => ({ Sundial_Customer__c: "c1", Sundial_Customer__r: c, Sales_Company_Harmon_Solar_or_Third__c: "Blue Sky Solar", Sales_Type_Partner__c: "Cash", ...extra });
  const s1 = solar(cust("Lightreach", OTHER));
  check("Solar = its Customer's redline (dealer, LightReach)", run(F.solarRedline, s1), run(F.customerRedline, s1.Sundial_Customer__r));
  check("  … which is 1.65", run(F.solarRedline, s1), 1.65);
  check("Solar picklist says Harmon -> ignored, Customer dealer wins", run(F.solarRedline, solar(cust("Cash", OTHER), { Sales_Company_Harmon_Solar_or_Third__c: "Harmon Solar" })), 1.85);
  check("Customer has NO dealer -> Solar NULL even with a Solar sales company", run(F.solarRedline, solar(cust("Cash", null))), null);
  check("Solar's own Sales_Type_Partner__c is NOT read (Customer finance is)", run(F.solarRedline, solar(cust("Cash", OTHER), { Sales_Type_Partner__c: "LightReach" })), 1.85);
  check("Invictus via the Customer -> 1.75", run(F.solarRedline, solar(cust("Cash", INVICTUS))), 1.75);
}

console.log("\n=== Commission_Total__c end to end (v3's formula, unchanged, over the new redline) ===");
{
  // The D19 worked example: 8.8 kW, 36,502 contract, 3,110 of adders -> 17,112 at 1.85.
  const total = (obj, rec) => {
    const tFormulas = { Commission_Redline_PPW__c: V9[obj].Commission_Redline_PPW__c.formula };
    return evaluate(V3[obj].Commission_Total__c.formula, { ...rec, Total_Adder_Price__c: 3110, __formulas: tFormulas }, NEW);
  };
  const cust = { CreatedDate: "2026-10-01T15:00:00Z", Final_System_Size_kW__c: 8.8, Contract_Amount__c: 36502, Financing_Partner__c: "GoodLeap" };
  check("Customer post-cutover, High Desert -> 17,112", total("Sundial_Customer__c", { ...cust, ...withDealer(OTHER) }), 17112);
  check("Customer post-cutover, no dealer -> commission NULL", total("Sundial_Customer__c", { ...cust, Sales_Company__c: "Third-Party Dealer", ...withDealer(null) }), null);
  check("Customer pre-cutover, Third-Party Dealer -> 17,112 (unchanged)", total("Sundial_Customer__c", { ...cust, CreatedDate: "2026-08-01T00:00:00Z", Sales_Company__c: "Third-Party Dealer", ...withDealer(null) }), 17112);
  const solar = { System_Size__c: 8.8, Contract_Amount__c: 36502, Sales_Company_Harmon_Solar_or_Third__c: "Blue Sky Solar", Sales_Type_Partner__c: "GoodLeap" };
  check("Solar unlinked -> 17,112 (unchanged)", total("Sundial_Solar__c", { ...solar, Sundial_Customer__c: null }), 17112);
  check("Solar post-cutover Customer with dealer -> 17,112", total("Sundial_Solar__c", { ...solar, Sundial_Customer__c: "c1", Sundial_Customer__r: { ...cust, ...withDealer(OTHER) } }), 17112);
}

console.log("\n=== Sales_Rep_Name__c — coalesce, and the rep-set case reads exactly as today ===");
{
  const rep = { First_Name__c: "Dennis", Last_Name__c: "Alessandro" };
  check("Customer rep set = live formula", run(F.customerRepName, { Sales_Rep__c: "u1", Sales_Rep__r: rep }), run(LIVE.customerRepName, { Sales_Rep__c: "u1", Sales_Rep__r: rep }));
  check("Customer rep set -> 'Dennis Alessandro'", run(F.customerRepName, { Sales_Rep__c: "u1", Sales_Rep__r: rep, Sunbase_Sales_Rep__c: "Value1", Dealer_Name__c: "Heavenly Power" }), "Dennis Alessandro");
  check("Customer no rep -> Sunbase_Sales_Rep__c", run(F.customerRepName, { Sales_Rep__c: null, Sunbase_Sales_Rep__c: "Dennis Alessandro", Dealer_Name__c: "Heavenly Power" }), "Dennis Alessandro");
  check("Customer no rep, no Sunbase -> Dealer_Name__c", run(F.customerRepName, { Sales_Rep__c: null, Sunbase_Sales_Rep__c: null, Dealer_Name__c: "Heavenly Power" }), "Heavenly Power");
  check("Customer nothing -> blank", run(F.customerRepName, { Sales_Rep__c: null }), "");
  check("Solar rep set = live formula", run(F.solarRepName, { Sales_Rep__c: "u1", Sales_Rep__r: rep }), run(LIVE.solarRepName, { Sales_Rep__c: "u1", Sales_Rep__r: rep }));
  check("Solar no rep -> Sales_Representative__c", run(F.solarRepName, { Sales_Representative__c: "Thomas Kopp", Third_Party_Sales_Representative__c: "Jo", Sales_Company_Harmon_Solar_or_Third__c: "Blue Sky Solar" }), "Thomas Kopp");
  check("Solar -> Third_Party_Sales_Representative__c", run(F.solarRepName, { Sales_Representative__c: null, Third_Party_Sales_Representative__c: "Jo Smith", Sales_Company_Harmon_Solar_or_Third__c: "Blue Sky Solar" }), "Jo Smith");
  check("Solar -> sales company last", run(F.solarRepName, { Sales_Representative__c: null, Third_Party_Sales_Representative__c: null, Sales_Company_Harmon_Solar_or_Third__c: "Blue Sky Solar" }), "Blue Sky Solar");
  check("Solar nothing -> blank", run(F.solarRepName, {}), "");
}

console.log("\n=== Dealer_Display_Name__c ===");
check("Customer -> Dealer__r.Name", run(F.customerDealerName, withDealer(OTHER)), "High Desert Energy");
check("Customer no dealer -> blank", run(F.customerDealerName, withDealer(null)), null);
check("Solar -> Dealer__r.Name", run(F.solarDealerName, withDealer(HARMON)), "Harmon Solar");

console.log("\n=== metadata ===");
{
  const d = V9.Sundial_Dealer__c;
  const want = {
    Redline_PPW__c: { type: "Currency", precision: "18", scale: "4", label: "Redline $/W", inlineHelpText: "Commission redline for every financing partner except LightReach." },
    Redline_LightReach_PPW__c: { type: "Currency", precision: "18", scale: "4", label: "Redline $/W (LightReach)" },
    Acumatica_Vendor_ID__c: { type: "Text", length: "20", label: "Acumatica Vendor ID", inlineHelpText: "The vendor the commission POs are raised against. Set by Constructive Ops once Harmon finance creates the vendor." },
    Acumatica_Vendor_Name__c: { type: "Text", length: "80", label: "Acumatica Vendor Name", required: "false" },
  };
  for (const [api, attrs] of Object.entries(want))
    for (const [k, v] of Object.entries(attrs)) check(`Dealer.${api} ${k}`, d[api]?.[k] ?? null, v);
  check("Dealer fields are not formulas", Object.values(d).filter((f) => f.formula).length, 0);

  // A CustomField deploy replaces the whole field: everything but formula + description must be v8's.
  for (const obj of ["Sundial_Customer__c", "Sundial_Solar__c"]) {
    const a = V9[obj].Commission_Redline_PPW__c, b = V8[obj].Commission_Redline_PPW__c;
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => !["formula", "description"].includes(k));
    const diff = keys.filter((k) => a[k] !== b[k]);
    check(`${obj} Commission_Redline_PPW__c attributes identical to v8 except formula/description`, diff.join(",") || "none", "none");
    check(`${obj} Commission_Redline_PPW__c tag order = v8`, Object.keys(a).join(","), Object.keys(b).join(","));
    check(`${obj} Dealer_Display_Name__c label`, V9[obj].Dealer_Display_Name__c.label, "Dealer (based on Sales Rep)");
    check(`${obj} Dealer_Display_Name__c formula`, V9[obj].Dealer_Display_Name__c.formula, "Dealer__r.Name");
    check(`${obj} Sales_Rep_Name__c label kept`, V9[obj].Sales_Rep_Name__c.label, "Sales Rep Name");
  }
  check("no Commission_Redline_Legacy_PPW__c (the estimate fits; see README)",
    ["Sundial_Customer__c", "Sundial_Solar__c"].some((o) => V9[o].Commission_Redline_Legacy_PPW__c) ? "present" : "absent", "absent");
}

console.log("\n=== package.xml + permission set cover every new field ===");
{
  const pkg = fs.readFileSync(path.join(here, "package.xml"), "utf8");
  const ps = fs.readFileSync(path.join(here, "permissionsets", "Sundial_Dealer_Terms.permissionset"), "utf8");
  const members = [...pkg.matchAll(/<members>([^<]+)<\/members>/g)].map((m) => m[1]);
  const generated = Object.entries(V9).flatMap(([o, fs_]) => Object.keys(fs_).map((f) => `${o}.${f}`));
  check("package.xml lists exactly the generated fields + the permission set",
    [...members].sort().join(","), [...generated, "Sundial_Dealer_Terms"].sort().join(","));
  const perms = [...ps.matchAll(/<fieldPermissions>([\s\S]*?)<\/fieldPermissions>/g)].map((m) => ({
    field: /<field>([^<]+)</.exec(m[1])[1],
    readable: /<readable>true</.test(m[1]),
    editable: /<editable>true</.test(m[1]),
  }));
  const NEW_FIELDS = [
    ...Object.keys(V9.Sundial_Dealer__c).map((f) => `Sundial_Dealer__c.${f}`),
    "Sundial_Customer__c.Dealer_Display_Name__c",
    "Sundial_Solar__c.Dealer_Display_Name__c",
  ];
  for (const f of NEW_FIELDS) check(`Read FLS on ${f}`, perms.find((p) => p.field === f)?.readable ?? false, true);
  check("formula fields are not editable", perms.filter((p) => p.field.endsWith("Dealer_Display_Name__c") && p.editable).length, 0);
  check("the two MODIFIED fields are not in the permission set (they keep their FLS)",
    perms.filter((p) => /Commission_Redline_PPW__c|Sales_Rep_Name__c/.test(p.field)).length, 0);
}

console.log(
  failures === 0
    ? `\nALL ${checks} CHECKS PASS (evaluated against the generated formula text)\n`
    : `\n${failures} of ${checks} CHECKS FAILED\n`
);
process.exitCode = failures === 0 ? 0 : 1;
