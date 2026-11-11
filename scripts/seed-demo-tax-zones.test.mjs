// seed-demo-tax-zones.test.mjs — the demo tenant's invented tax zones, against fakes.
//
//   node --test scripts/seed-demo-tax-zones.test.mjs
//
// The fake Supabase here is tax-aware (the four sundial_tax_* tables with their primary
// keys, plus the .delete().eq().not("in") prune syncTaxTables runs); the demo seed's
// FakeSupabase (scripts/demo-seed/fakes.js) is built from probe.json, which predates the
// tax tables. Same idea: every write lands in memory, nothing real is touched.

import { test } from "node:test";
import assert from "node:assert/strict";
import { runSeedDemoTaxZones, buildDemoTaxRaw, demoZones, DEMO_ZONE_PREFIX, COUNTY_STATE_RATE } from "./seed-demo-tax-zones.mjs";
import { CITIES } from "./demo-seed/catalog.js";
import { tablesFromRows, resolveTaxZoneIn, headlineRate, zoneCategoryRates, loadTaxTables, clearTaxTableCache, planJobZones, syncTaxTables, TABLES, buildTaxTableRows } from "../lib/tax-zones.js";

// ---------------------------------------------------------------------------------------
// fakes
// ---------------------------------------------------------------------------------------
const PK = {
  sundial_tax_zones: ["tenant", "zone_code"],
  sundial_tax_rates: ["tenant", "tax_id"],
  sundial_tax_categories: ["tenant", "category_id"],
  sundial_tax_zone_aliases: ["tenant", "alias_key"],
};

class Q {
  constructor(db, table) { this.db = db; this.table = table; this.filters = []; this.action = "select"; this.max = null; this.returning = false; }
  select() { if (this.action !== "select") this.returning = true; return this; }
  eq(col, v) { this.filters.push((r) => r[col] === v); return this; }
  limit(n) { this.max = n; return this; }
  not(col, op, list) {
    assert.equal(op, "in");
    const vals = [...String(list).slice(1, -1).matchAll(/"((?:[^"]|"")*)"/g)].map((m) => m[1].replace(/""/g, '"'));
    this.filters.push((r) => !vals.includes(String(r[col])));
    return this;
  }
  upsert(rows, opts = {}) { this.action = "upsert"; this.rows = Array.isArray(rows) ? rows : [rows]; this.opts = opts; return this; }
  delete() { this.action = "delete"; return this; }
  then(res, rej) { return Promise.resolve(this.run()).then(res, rej); }
  run() {
    const t = this.db.tables.get(this.table);
    if (!t) return { data: null, error: { code: "PGRST205", message: `Could not find the table 'public.${this.table}' in the schema cache` } };
    this.db.calls.push({ table: this.table, action: this.action });
    if (this.action === "select") {
      let rows = t.filter((r) => this.filters.every((f) => f(r)));
      if (this.max !== null) rows = rows.slice(0, this.max);
      return { data: rows.map((r) => ({ ...r })), error: null };
    }
    if (this.action === "delete") {
      const gone = t.filter((r) => this.filters.every((f) => f(r)));
      this.db.tables.set(this.table, t.filter((r) => !gone.includes(r)));
      this.db.deleted.push(...gone.map((r) => ({ table: this.table, ...r })));
      return { data: this.returning ? gone : null, error: null };
    }
    const pk = (this.opts.onConflict ?? "").split(",");
    assert.deepEqual(pk, PK[this.table], `${this.table} upsert names its primary key`);
    for (const row of this.rows) {
      for (const k of Object.keys(row)) if (!this.db.columns.get(this.table).has(k)) return { data: null, error: { code: "PGRST204", message: `Could not find the '${k}' column of '${this.table}'` } };
      const hit = t.find((r) => pk.every((c) => r[c] === row[c]));
      if (hit) Object.assign(hit, row);
      else t.push({ ...row });
      this.db.writes++;
    }
    return { data: null, error: null };
  }
}

const COLUMNS = {
  sundial_tax_zones: ["tenant", "zone_code", "description", "city_key", "county", "state", "combined_rate", "components", "tax_ids", "effective_from", "is_retail", "synced_at"],
  sundial_tax_rates: ["tenant", "tax_id", "description", "schedule", "synced_at"],
  sundial_tax_categories: ["tenant", "category_id", "description", "tax_ids", "active", "exclude_listed", "synced_at"],
  sundial_tax_zone_aliases: ["tenant", "alias_key", "zone_code", "note"],
};

/** The four tax tables (sql/sundial_tax_zones.sql), holding Harmon's rows already. */
function fakeTaxDb({ withTables = true } = {}) {
  const db = { tables: new Map(), columns: new Map(), calls: [], writes: 0, deleted: [], from: (t) => new Q(db, t) };
  if (!withTables) return db;
  for (const [t, cols] of Object.entries(COLUMNS)) { db.columns.set(t, new Set(cols)); db.tables.set(t, []); }
  // Harmon's rows, as the Acumatica refresh leaves them (a representative slice).
  db.tables.get("sundial_tax_zones").push(
    { tenant: "harmon", zone_code: "08PHOENIXR", description: "Phoenix - Retail", city_key: "PHOENIX", county: "Maricopa", state: "AZ", combined_rate: 8.6, components: [], tax_ids: ["08PHXRT", "08MCORT"], effective_from: "2021-01-01", is_retail: true, synced_at: "2026-11-09T12:00:00.000Z" },
    { tenant: "harmon", zone_code: "08MARICOPR", description: "Maricopa County - Retail", city_key: null, county: "Maricopa", state: "AZ", combined_rate: 6.3, components: [], tax_ids: ["08MCORT"], effective_from: "2021-01-01", is_retail: true, synced_at: "2026-11-09T12:00:00.000Z" },
  );
  db.tables.get("sundial_tax_rates").push(
    { tenant: "harmon", tax_id: "08PHXRT", description: "Phoenix Retail", schedule: [{ start: "2021-01-01", rate: 2.3 }], synced_at: "2026-11-09T12:00:00.000Z" },
    { tenant: "harmon", tax_id: "08MCORT", description: "Maricopa County Retail", schedule: [{ start: "2021-01-01", rate: 6.3 }], synced_at: "2026-11-09T12:00:00.000Z" },
  );
  db.tables.get("sundial_tax_categories").push({ tenant: "harmon", category_id: "RETAIL", description: "Retail", tax_ids: ["08MCORT", "08PHXRT"], active: true, exclude_listed: false, synced_at: "2026-11-09T12:00:00.000Z" });
  db.tables.get("sundial_tax_zone_aliases").push({ tenant: "harmon", alias_key: "ANTHEM", zone_code: "08PHOENIXR", note: "from CFO 2026-10-06" });
  return db;
}
const snapshotOf = (db, tenant) => JSON.stringify(Object.fromEntries([...db.tables].map(([t, rows]) => [t, rows.filter((r) => r.tenant === tenant).map((r) => ({ ...r, synced_at: undefined }))])));

const DEMO_ID = "a1W7y00000DemoTenant";
const HARMON_ID = "a1W7y000007AszBEAS";

/** A fake org with both tenants and a job per demo city (plus a closed one and one already zoned). */
function fakeOrg({ extraJobs = [] } = {}) {
  const tenants = [{ Id: HARMON_ID, Name: "harmon" }, { Id: DEMO_ID, Name: "conops-demo" }, { Id: "a1W7y00000OtherTen", Name: "someone-else" }];
  const jobs = [];
  let n = 0;
  for (const c of CITIES) {
    jobs.push({ Id: `a0J${String(++n).padStart(12, "0")}`, Name: `SVC-${n}`, Status__c: "New", Tax_Zone_Code__c: null, Address_at_Creation__c: `100 N Demo St, ${c.city}, AZ, ${c.zips[0]}`, Customer_Name_at_Creation__c: "Demo Person", Sundial_Customer__r: { City__c: c.city }, Client__c: DEMO_ID });
  }
  // The address snapshot has no city → the customer's city, which is the AHJ spelling → alias.
  jobs.push({ Id: `a0J${String(++n).padStart(12, "0")}`, Name: `SVC-${n}`, Status__c: "Scheduled", Tax_Zone_Code__c: null, Address_at_Creation__c: "", Customer_Name_at_Creation__c: "Demo Person", Sundial_Customer__r: { City__c: "City of Mesa" }, Client__c: DEMO_ID });
  jobs.push({ Id: `a0J${String(++n).padStart(12, "0")}`, Name: `SVC-${n}`, Status__c: "Closed", Tax_Zone_Code__c: null, Address_at_Creation__c: "1 E Old Rd, Tempe, AZ, 85281", Customer_Name_at_Creation__c: "Demo Person", Sundial_Customer__r: { City__c: "Tempe" }, Client__c: DEMO_ID });
  jobs.push({ Id: `a0J${String(++n).padStart(12, "0")}`, Name: `SVC-${n}`, Status__c: "New", Tax_Zone_Code__c: "DM-PHX", Address_at_Creation__c: "2 E Set Rd, Phoenix, AZ, 85008", Customer_Name_at_Creation__c: "Demo Person", Sundial_Customer__r: { City__c: "Phoenix" }, Client__c: DEMO_ID });
  jobs.push({ Id: "a0JHarmon0000001", Name: "SVC-H", Status__c: "New", Tax_Zone_Code__c: null, Address_at_Creation__c: "3 W Real St, Yuma, AZ, 85364", Customer_Name_at_Creation__c: "Real Person", Sundial_Customer__r: { City__c: "Yuma" }, Client__c: HARMON_ID });
  jobs.push(...extraJobs.map((j, i) => ({ Id: `a0JExtra${String(i).padStart(8, "0")}`, Name: `SVC-X${i}`, Status__c: "New", Tax_Zone_Code__c: null, Customer_Name_at_Creation__c: "Demo Person", Client__c: DEMO_ID, ...j })));
  const queries = [];
  const sfQuery = async (soql) => {
    queries.push(soql);
    let m;
    if ((m = /FROM Sundial_Tenant__c WHERE Name = '([^']*)'/.exec(soql))) return tenants.filter((t) => t.Name === m[1]);
    if ((m = /FROM Sundial_Service_Job__c WHERE Client__c = '([^']*)'/.exec(soql))) return jobs.filter((j) => j.Client__c === m[1]).map((j) => ({ ...j }));
    throw new Error(`fake org: unsupported SOQL ${soql}`);
  };
  return { sfQuery, queries, jobs };
}

function world(opts = {}) {
  const db = fakeTaxDb(opts);
  const org = fakeOrg(opts);
  const lines = [];
  let getSupabaseCalls = 0;
  const io = { sfQuery: org.sfQuery, getSupabase: async () => { getSupabaseCalls++; return db; }, log: (l) => lines.push(String(l)), now: () => new Date("2026-11-10T17:00:00.000Z"), env: {} };
  return { db, org, io, lines, output: () => lines.join("\n"), get supabaseOpened() { return getSupabaseCalls; } };
}

// ---------------------------------------------------------------------------------------
// the plan
// ---------------------------------------------------------------------------------------
test("one DM- zone per demo city, at exactly the catalog's taxRate; RETAIL taxed, LABSERV / SOLAR / WARRANTY / RESALE 0%", () => {
  const zones = demoZones();
  assert.equal(zones.length, CITIES.length);
  assert.ok(CITIES.length >= 11, `the catalog has ${CITIES.length} cities`);
  for (const z of zones) assert.ok(z.code.startsWith(DEMO_ZONE_PREFIX), z.code);
  assert.equal(new Set(zones.map((z) => z.code)).size, zones.length, "codes are unique");
  const { raw, cityMap } = buildDemoTaxRaw();
  const built = buildTaxTableRows(raw, { tenant: "conops-demo", today: "2026-11-10", cityMap });
  const tables = tablesFromRows(built);
  for (const c of CITIES) {
    const zone = tables.zones.get(zones.find((z) => z.city === c.city).code);
    assert.ok(zone.isRetail, c.city);
    assert.equal(headlineRate({ zone, tables, date: "2026-11-10" }), c.taxRate, `${c.city} headline rate`);
    const rates = zoneCategoryRates({ zone, tables, date: "2026-11-10" });
    assert.deepEqual(rates, { RETAIL: c.taxRate, LABSERV: 0, SOLAR: 0, WARRANTY: 0, RESALE: 0 }, c.city);
    // the stored display rate agrees too
    assert.equal(built.zones.find((z) => z.zone_code === zone.code).combined_rate, c.taxRate);
    assert.equal(built.zones.find((z) => z.zone_code === zone.code).county, "Maricopa");
  }
  assert.deepEqual([...tables.categories.keys()].sort(), ["LABSERV", "RESALE", "RETAIL", "SOLAR", "WARRANTY"]);
  assert.deepEqual(built.drift, { cityTaxNotRetail: [], contractingTaxOnRetail: [], unmappedRetail: [] });
  assert.deepEqual(built.newZones, []);
  // the city share is the catalog rate minus the county + state share, never negative
  for (const z of zones) assert.equal(Math.round((z.cityRate + COUNTY_STATE_RATE) * 1e6) / 1e6, z.rate);
});

test("every demo city resolves — by its city_key, and through an alias for the AHJ and 'City, AZ' spellings", () => {
  const { raw, cityMap } = buildDemoTaxRaw();
  const built = buildTaxTableRows(raw, { tenant: "conops-demo", today: "2026-11-10", cityMap });
  const tables = tablesFromRows(built);
  for (const c of CITIES) {
    const code = demoZones().find((z) => z.city === c.city).code;
    for (const [spelling, via] of [[c.city, "city"], [c.city.toUpperCase(), "city"], [`City of ${c.city}`, "alias"], [`${c.city}, AZ`, "alias"]]) {
      const r = resolveTaxZoneIn(tables, spelling);
      assert.equal(r.matched, true, `${spelling}`);
      assert.equal(r.zone.code, code, spelling);
      assert.equal(r.via, via, spelling);
    }
    assert.ok(built.aliases.some((a) => a.zone_code === code), `${c.city} has an alias row`);
  }
  for (const a of built.aliases) assert.equal(a.tenant, "conops-demo");
  assert.equal(resolveTaxZoneIn(tables, "Yuma").matched, false, "a city the demo does not use stays unresolved — never a guess");
});

// ---------------------------------------------------------------------------------------
// the run
// ---------------------------------------------------------------------------------------
test("dry run (default): prints the zones, the rates and where every demo job lands; opens no Supabase client; writes nothing", async () => {
  const w = world();
  const before = JSON.stringify([...w.db.tables]);
  const code = await runSeedDemoTaxZones(["--tenant", "conops-demo"], w.io);
  assert.equal(code, 0, w.output());
  assert.equal(JSON.stringify([...w.db.tables]), before);
  assert.equal(w.supabaseOpened, 0);
  assert.equal(w.db.writes, 0);
  const out = w.output();
  assert.match(out, /DRY RUN/);
  assert.match(out, /Dry run — nothing written/);
  for (const c of CITIES) assert.match(out, new RegExp(`${c.city} \\(demo\\)`));
  assert.match(out, /DM-PHX +8\.6 +Phoenix \(demo\) +PHOENIX +CITY OF PHOENIX \| PHOENIX AZ/);
  assert.match(out, /RETAIL +8\.6% in Phoenix \(demo\)/);
  assert.match(out, /LABSERV +0% in Phoenix/);
  assert.match(out, /SOLAR +0% in Phoenix/);
  assert.match(out, /WARRANTY +0% in Phoenix/);
  assert.match(out, /RESALE +no taxes — 0%/);
  assert.match(out, /every demo job's city resolves to a demo zone/);
  assert.match(out, /DM-MES +2 job\(s\) \(1 through an alias: CITY OF MESA ×1\)/);
  // the backfill's own planner: the Closed job and the already-zoned one are skipped
  assert.match(out, new RegExp(`would write ${CITIES.length + 1} open job\\(s\\) \\(2 already set or Closed/Cancelled/Paid, 0 unmatched\\)`));
  // only the demo tenant's jobs were read
  assert.ok(w.org.queries.every((q) => !q.includes(HARMON_ID)), w.org.queries.join("\n"));
  assert.doesNotMatch(out, /Real Person|Yuma/);
});

test("dry run names an unmatched city and exits 3 so a new catalog city is noticed before --apply", async () => {
  const w = world({ extraJobs: [{ Address_at_Creation__c: "9 N Nowhere Rd, Fountain Hills, AZ, 85268", Sundial_Customer__r: { City__c: "Fountain Hills" } }] });
  const code = await runSeedDemoTaxZones(["--tenant", "conops-demo"], w.io);
  assert.equal(code, 3);
  assert.match(w.output(), /UNMATCHED cities .*"Fountain Hills" ×1/);
  assert.equal(w.db.writes, 0);
});

test("--apply writes the four tables under conops-demo ONLY, through syncTaxTables, and Harmon's rows are untouched", async () => {
  const w = world();
  const harmonBefore = snapshotOf(w.db, "harmon");
  const code = await runSeedDemoTaxZones(["--tenant", "conops-demo", "--apply"], w.io);
  assert.equal(code, 0, w.output());
  assert.equal(snapshotOf(w.db, "harmon"), harmonBefore, "Harmon's rows are exactly as they were");
  assert.deepEqual(w.db.deleted, [], "nothing was pruned");
  const zones = w.db.tables.get(TABLES.zones).filter((r) => r.tenant === "conops-demo");
  assert.equal(zones.length, CITIES.length);
  for (const z of zones) {
    assert.ok(z.zone_code.startsWith(DEMO_ZONE_PREFIX));
    assert.equal(z.is_retail, true);
    assert.equal(z.state, "AZ");
    assert.equal(z.combined_rate, CITIES.find((c) => c.city === z.description.replace(" (demo) - Retail", "")).taxRate);
  }
  const rates = w.db.tables.get(TABLES.rates).filter((r) => r.tenant === "conops-demo");
  assert.equal(rates.length, 1 + CITIES.length + 3);
  assert.ok(rates.every((r) => r.tax_id.startsWith("DM-")));
  const cats = w.db.tables.get(TABLES.categories).filter((r) => r.tenant === "conops-demo").map((c) => c.category_id).sort();
  assert.deepEqual(cats, ["LABSERV", "RESALE", "RETAIL", "SOLAR", "WARRANTY"]);
  const aliases = w.db.tables.get(TABLES.zone_aliases ?? TABLES.aliases).filter((r) => r.tenant === "conops-demo");
  assert.equal(aliases.length, CITIES.length * 2);
  // every row of every table carries the demo slug or Harmon's — no third value
  for (const [, rows] of w.db.tables) for (const r of rows) assert.ok(["harmon", "conops-demo"].includes(r.tenant), JSON.stringify(r));
  assert.match(w.output(), /written for conops-demo: \{"zones":14,"taxes":18,"categories":5,"aliases":28,"deleted":0\}/);
  assert.match(w.output(), /re-read: 14 zone\(s\) for conops-demo, all DM-\*/);
  assert.match(w.output(), /next: node scripts\/backfill-job-tax-zones\.mjs --tenant conops-demo/);

  // What the Lambdas load for the demo tenant is exactly this, and the backfill's planner
  // resolves every open blank demo job from it.
  clearTaxTableCache();
  const tables = await loadTaxTables("conops-demo", { getSupabaseClient: async () => w.db });
  assert.equal(tables.zones.size, CITIES.length);
  const plan = planJobZones(w.org.jobs.filter((j) => j.Client__c === DEMO_ID), tables);
  assert.equal(plan.unmatched.length, 0);
  assert.equal(plan.matched.length, CITIES.length + 1);
  assert.equal(plan.skipped, 2);
  // and Harmon's tables still resolve Harmon's cities, not the demo's
  clearTaxTableCache();
  const harmon = await loadTaxTables("harmon", { getSupabaseClient: async () => w.db });
  assert.equal(resolveTaxZoneIn(harmon, "Phoenix").zone.code, "08PHOENIXR");
  assert.equal(resolveTaxZoneIn(harmon, "Mesa").matched, false);
  clearTaxTableCache();
});

test("idempotent: a second --apply changes no row and deletes nothing", async () => {
  const w = world();
  assert.equal(await runSeedDemoTaxZones(["--tenant", "conops-demo", "--apply"], w.io), 0);
  const after1 = snapshotOf(w.db, "conops-demo");
  const writes1 = w.db.writes;
  assert.equal(await runSeedDemoTaxZones(["--tenant", "conops-demo", "--apply"], w.io), 0);
  assert.equal(snapshotOf(w.db, "conops-demo"), after1);
  assert.equal(w.db.writes, writes1 * 2, "the same rows were upserted again (no inserts)");
  assert.equal(w.db.tables.get(TABLES.zones).filter((r) => r.tenant === "conops-demo").length, CITIES.length);
  assert.deepEqual(w.db.deleted, []);
});

test("a stale demo zone from an earlier run is pruned on re-apply; Harmon's are not", async () => {
  const w = world();
  w.db.tables.get(TABLES.zones).push({ tenant: "conops-demo", zone_code: "DM-OLD", description: "Old Town (demo) - Retail", city_key: "OLD TOWN", county: "Maricopa", state: "AZ", combined_rate: 9, components: [], tax_ids: [], effective_from: null, is_retail: true, synced_at: "2026-01-01T00:00:00.000Z" });
  assert.equal(await runSeedDemoTaxZones(["--tenant", "conops-demo", "--apply"], w.io), 0);
  assert.deepEqual(w.db.deleted.map((d) => `${d.tenant}:${d.zone_code}`), ["conops-demo:DM-OLD"]);
  assert.ok(w.db.tables.get(TABLES.zones).some((r) => r.tenant === "harmon" && r.zone_code === "08PHOENIXR"));
});

test("Harmon's daily refresh (syncTaxTables for the primary slug) never touches the demo's rows — the refresh is per-slug", async () => {
  const w = world();
  assert.equal(await runSeedDemoTaxZones(["--tenant", "conops-demo", "--apply"], w.io), 0);
  const demoBefore = snapshotOf(w.db, "conops-demo");
  // What runTaxZoneRefresh does, with an Acumatica payload that has FEWER zones than Harmon holds:
  // the prune deletes Harmon's missing zone and must see none of the demo's.
  const raw = {
    zones: [{ TaxZoneID: "08PHOENIXR", Description: "Phoenix - Retail", ApplicableTaxes: [{ TaxID: "08PHXRT" }, { TaxID: "08MCORT" }] }],
    taxes: [
      { TaxID: "08PHXRT", Description: "Phoenix Retail", TaxSchedule: [{ StartDate: "2021-01-01", TaxRate: 2.3 }] },
      { TaxID: "08MCORT", Description: "Maricopa County Retail", TaxSchedule: [{ StartDate: "2021-01-01", TaxRate: 6.3 }] },
    ],
    categories: [{ TaxCategoryID: "RETAIL", Description: "Retail", Active: true, Details: [{ TaxID: "08MCORT" }, { TaxID: "08PHXRT" }] }],
  };
  const r = await syncTaxTables({ supabase: w.db, tenant: "harmon", raw, today: "2026-11-10" });
  assert.equal(r.deleted, 1, "Harmon's own 08MARICOPR was pruned");
  assert.deepEqual(w.db.deleted.map((d) => `${d.tenant}:${d.zone_code}`), ["harmon:08MARICOPR"]);
  assert.equal(snapshotOf(w.db, "conops-demo"), demoBefore, "the demo's rows survived Harmon's refresh");
  // and the demo's "refresh" (a re-apply) does not see Harmon's
  const harmonAfter = snapshotOf(w.db, "harmon");
  assert.equal(await runSeedDemoTaxZones(["--tenant", "conops-demo", "--apply"], w.io), 0);
  assert.equal(snapshotOf(w.db, "harmon"), harmonAfter);
});

// ---------------------------------------------------------------------------------------
// refusals
// ---------------------------------------------------------------------------------------
test("refuses harmon / the primary tenant / an unknown slug / a non-demo slug, and demands --tenant — before any read or write", async () => {
  for (const [argv, re, reads] of [
    [["--apply"], /--tenant is required/, 0],
    [["--tenant", "harmon", "--apply"], /REFUSED: "harmon" is the primary tenant/, 0],
    [["--tenant", "HARMON", "--apply"], /REFUSED: "harmon" is the primary tenant/, 0],
    [["--tenant", "someone-else", "--apply"], /REFUSED: "someone-else" is not the demo tenant/, 0],
    [["--tenant", "nope", "--apply", "--allow-other-slug"], /REFUSED: no Sundial_Tenant__c named "nope"/, 1],
    [["--tenant", "conops-demo", "--apply", "--bogus"], /Unknown argument/, 0],
  ]) {
    const w = world();
    const code = await runSeedDemoTaxZones(argv, w.io);
    assert.notEqual(code, 0, argv.join(" "));
    assert.match(w.output(), re, argv.join(" "));
    assert.equal(w.org.queries.length, reads, argv.join(" "));
    assert.equal(w.db.writes, 0);
    assert.equal(w.supabaseOpened, 0);
  }
  // SUNDIAL_PRIMARY_TENANT names another slug: THAT one is refused too, and "harmon" still is.
  const w = world();
  w.io.env = { SUNDIAL_PRIMARY_TENANT: "conops-demo" };
  assert.equal(await runSeedDemoTaxZones(["--tenant", "conops-demo", "--apply"], w.io), 1);
  assert.match(w.output(), /is the primary tenant/);
  assert.equal(w.db.writes, 0);
});

test("--apply against a project without the tax tables stops with the SQL file to run", async () => {
  const w = world({ withTables: false });
  const code = await runSeedDemoTaxZones(["--tenant", "conops-demo", "--apply"], w.io);
  assert.equal(code, 1);
  assert.match(w.output(), /Run sql\/sundial_tax_zones\.sql in the Supabase SQL editor first/);
});

test("no secret value, password or token ever reaches the output", async () => {
  const w = world();
  await runSeedDemoTaxZones(["--tenant", "conops-demo", "--apply"], w.io);
  assert.doesNotMatch(w.output(), /secret|password|token|service_role|eyJ/i);
});
