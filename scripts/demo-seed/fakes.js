// fakes.js — an in-memory Salesforce org, Supabase project, Secrets Manager and S3 bucket
// for the demo seed's tests. NOT used by a real run.
//
// WHY IT EXISTS: the seed cannot be tried against the real org (there is no sandbox of it,
// and most of what it creates cannot be deleted). So the tests run the whole thing against
// a fake org built from migration/demo/probe.json — the live metadata captured from the
// real org — and the fake is deliberately as strict as Salesforce, in places stricter:
//
//   * an unknown field, or a field that is not createable / updateable  -> error
//   * a value that is not in a RESTRICTED picklist                       -> error
//   * a dependent picklist value not allowed under its controlling value -> error
//     (the real API does not enforce this one; the portal's dropdowns do)
//   * a missing required field                                           -> error
//   * a lookup to an id that does not exist, or to the wrong object      -> error
//   * a duplicate value in a unique field                                -> error
//   * text longer than the field, a number wider than the field          -> error
//   * auto-number Names are assigned on insert (SVC-00001 …)
//
// It can also misbehave on purpose: a "Flow" that changes a record after it is created
// (the canary must catch it), and a crash after N writes (the run must resume).

import { encodeValidFor } from "./schema.js";

const AUTO_NUMBER = {
  Sundial_Solar__c: ["SOL-", 5, 10000],
  Sundial_Roofing__c: ["ROOF-", 4, 1000],
  Sundial_Estimate__c: ["EST-", 5, 2600],
  Sundial_Service_Job__c: ["SVC-", 5, 2300],
  Sundial_Service_Call__c: ["SC-", 5, 2900],
  Sundial_Service_Line__c: ["SL-", 5, 5500],
  Sundial_Service_Payment__c: ["PAY-", 5, 1000],
  Sundial_Tech_Day__c: ["DAY-", 5, 10],
  Sundial_Commercial__c: ["COM-", 4, 1],
  Sundial_PO__c: ["PO-", 5, 1],
  Sundial_Membership__c: ["MEM-", 5, 1],
};
const NUMBER_TYPES = new Set(["double", "currency", "percent", "int", "long"]);
const TEXT_TYPES = new Set(["string", "textarea", "phone", "email", "url", "id"]);

/** Formula-style field defaults the probe file could not capture (from the repo's metadata packages). */
export const KNOWN_FORMULA_DEFAULTS = Object.freeze({
  Sundial_Solar__c: {
    Labor_Burden_Rate__c: 75, Commission_Burden_Rate__c: 75, Adder_Upgrade_225_UG_Price__c: 2500, Adder_Upgrade_225_UG_Qty__c: 0,
    Adder_Gateway3_Price__c: 2950, Adder_Gateway3_Qty__c: 0, Adder_Site_Audit_Price__c: 350, Adder_Site_Audit_Qty__c: 0,
    Adder_Travel_Price__c: 750, Adder_Travel_Qty__c: 0, Adder_Active_Monitoring_Price__c: 100, Adder_Active_Monitoring_Qty__c: 0,
    Adder_LR_Battery_Warranty_Price__c: 600, Adder_LR_Battery_Warranty_Qty__c: 0, Adder_Referral_Fee_Price__c: 500,
    Adder_Referral_Fee_Qty__c: 0, NS_Adder_4_Markup_Percent__c: 25, NS_Adder_5_Markup_Percent__c: 25, Internal_Rep_Commission_PPW__c: 0,
    Adder_Sub_Panel_Cost__c: 261.4, Adder_Derate_Cost__c: 341.4, Adder_Heat_Detector_Cost__c: 175.2, Adder_Upgrade_225_Cost__c: 1540.8,
    Adder_Upgrade_400_Cost__c: 3220.8, Adder_Upgrade_225_UG_Cost__c: 1260.8, Adder_Gateway3_Cost__c: 2175.2, Adder_Structural_Cost__c: 250,
    Adder_Conduit_Attic_Cost__c: 0.052, Adder_Flat_Roof_Cost__c: 0.052, Adder_Roof_Tile_Cost__c: 0.009, Adder_Bird_Blocking_Cost__c: 0.06,
    Battery_Unit_Price__c: 9950,
  },
  Sundial_Customer__c: {
    Adder_Upgrade_225_UG_Price__c: 2500, Adder_Upgrade_225_UG_Qty__c: 0, Adder_Gateway3_Price__c: 2950, Adder_Gateway3_Qty__c: 0,
    Adder_Site_Audit_Price__c: 350, Adder_Site_Audit_Qty__c: 0, Adder_Travel_Price__c: 750, Adder_Travel_Qty__c: 0,
    Adder_Active_Monitoring_Price__c: 100, Adder_Active_Monitoring_Qty__c: 0, Adder_LR_Battery_Warranty_Price__c: 600,
    Adder_LR_Battery_Warranty_Qty__c: 0, Adder_Referral_Fee_Price__c: 500, Adder_Referral_Fee_Qty__c: 0,
    NS_Adder_4_Markup_Percent__c: 25, NS_Adder_5_Markup_Percent__c: 25, Internal_Rep_Commission_PPW__c: 0, Battery_Unit_Price__c: 9950,
  },
  Sundial_Roofing__c: { Labor_Rate_Shingle__c: 168, Labor_Rate_Tile__c: 224, Labor_Rate_Modified__c: 112, Labor_Rate_Recoat__c: 140 },
  Sundial_Estimate__c: { Version__c: 0 },
  Sundial_Service_Invoice__c: { Paid_Amount__c: 0 },
  Sundial_Price_Book_Item__c: { Version__c: 1, Default_Quantity__c: 1 },
  Sundial_Service_Line__c: { Quantity__c: 1 },
});

function sfError(status, errorCode, message, fields = []) {
  const e = new Error(`Salesforce request failed (${status})`);
  e.sfStatus = status;
  e.sfBody = JSON.stringify([{ message, errorCode, fields }]);
  e.errorCode = errorCode;
  return e;
}
const sfDateTime = (iso) => new Date(iso).toISOString().replace("Z", "+0000");

export class FakeOrg {
  /**
   * @param {object} probe  migration/demo/probe.json
   * @param {{ formulaDefaults?: object, now?: () => Date }} [opts]
   */
  constructor(probe, opts = {}) {
    this.meta = probe.salesforce;
    this.formulaDefaults = opts.formulaDefaults ?? KNOWN_FORMULA_DEFAULTS;
    this.now = opts.now ?? (() => new Date());
    this.records = new Map(Object.keys(this.meta).map((o) => [o, new Map()]));
    this.objectOfId = new Map();
    this.counters = new Map();
    this.nextId = 1;
    this.calls = { creates: [], updates: [], queries: [], describes: [] };
    /** values written to UNRESTRICTED picklists that were not in the list — "object.field=value" */
    this.addedPicklistValues = new Set();
    /** (sfObject, record) => void — a record-triggered "Flow": may change the record after insert. */
    this.afterCreate = null;
    /** { at: n, mode: "before" | "after" } — blow up on the n-th write (before or after it lands). */
    this.crash = null;
    this.writes = 0;

    // A real client lives in the same org. The seed must never touch any of this.
    this.harmonTenantId = "a1W7y000007AszBEAS";
    this.insertRaw("Sundial_Tenant__c", { Id: this.harmonTenantId, Name: "harmon" });
    this.harmonCustomerId = this.insertRaw("Sundial_Customer__c", { Name: "A Real Harmon Customer", Client__c: this.harmonTenantId, Status__c: "Customer", Stage__c: "Sold", Primary_Phone__c: "(602) 867-5309" });
    this.harmonJobUserId = this.insertRaw("Sundial_User__c", { Last_Name__c: "Realperson", Email__c: "someone@harmon.example", Hierarchy_Level__c: "Client", Client__c: this.harmonTenantId, Supabase_User_Id__c: "99999999-0000-4000-8000-000000000001" });
  }

  // --- helpers --------------------------------------------------------------------------
  newId(sfObject) {
    const prefix = `a${(Object.keys(this.meta).indexOf(sfObject) + 10).toString(36).toUpperCase()}Z`;
    return `${prefix}${String(this.nextId++).padStart(12, "0")}AAA`;
  }
  insertRaw(sfObject, record) {
    const id = record.Id ?? this.newId(sfObject);
    const stamp = this.now().toISOString();
    this.records.get(sfObject).set(id, { CreatedDate: stamp, LastModifiedDate: stamp, SystemModstamp: stamp, ...record, Id: id });
    this.objectOfId.set(id, sfObject);
    return id;
  }
  all(sfObject) {
    return [...this.records.get(sfObject).values()];
  }
  get(id) {
    const o = this.objectOfId.get(id);
    return o ? this.records.get(o).get(id) : null;
  }
  count(sfObject, tenantId) {
    return this.all(sfObject).filter((r) => r.Client__c === tenantId).length;
  }
  /** A snapshot of everything, for "the final state is identical" comparisons. */
  snapshot() {
    const out = {};
    for (const [o, m] of this.records) out[o] = [...m.values()].map((r) => ({ ...r }));
    return out;
  }

  tick(kind) {
    this.writes++;
    if (this.crash && this.writes === this.crash.at) return this.crash.mode;
    void kind;
    return null;
  }

  validate(sfObject, fields, isCreate, existing = null) {
    const o = this.meta[sfObject];
    if (!o || o.absent) throw sfError(404, "NOT_FOUND", "The requested resource does not exist");
    if (isCreate && !o.createable) throw sfError(400, "INSUFFICIENT_ACCESS", `cannot create ${sfObject}`);
    const merged = { ...(existing || {}), ...fields };
    for (const [name, value] of Object.entries(fields)) {
      const f = o.fields[name];
      if (!f) throw sfError(400, "INVALID_FIELD", `No such column '${name}' on sobject of type ${sfObject}`, [name]);
      if (isCreate ? !f.createable : !f.updateable) throw sfError(400, "INVALID_FIELD_FOR_INSERT_UPDATE", `Unable to create/update fields: ${name}`, [name]);
      if (value === null) continue;
      if (f.type === "boolean") {
        if (typeof value !== "boolean") throw sfError(400, "JSON_PARSER_ERROR", `Cannot deserialize boolean for ${name}`, [name]);
      } else if (NUMBER_TYPES.has(f.type)) {
        if (typeof value !== "number" || !Number.isFinite(value)) throw sfError(400, "JSON_PARSER_ERROR", `Cannot deserialize number for ${name}`, [name]);
        if (f.precision && Math.abs(value) >= 10 ** (f.precision - (f.scale ?? 0))) throw sfError(400, "NUMBER_OUTSIDE_VALID_RANGE", `${name}: value outside of valid range`, [name]);
      } else if (f.type === "date") {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value))) throw sfError(400, "JSON_PARSER_ERROR", `Cannot deserialize date for ${name}`, [name]);
      } else if (f.type === "datetime") {
        if (typeof value !== "string" || Number.isNaN(Date.parse(value))) throw sfError(400, "JSON_PARSER_ERROR", `Cannot deserialize dateTime for ${name}`, [name]);
      } else if (f.type === "reference") {
        const target = this.objectOfId.get(value);
        if (!target) throw sfError(400, "FIELD_INTEGRITY_EXCEPTION", `${name}: id value of incorrect type or not found`, [name]);
        if (!(f.referenceTo || []).includes(target)) throw sfError(400, "FIELD_INTEGRITY_EXCEPTION", `${name}: id value of incorrect type (${target})`, [name]);
      } else if (f.type === "picklist" || f.type === "multipicklist") {
        if (typeof value !== "string") throw sfError(400, "JSON_PARSER_ERROR", `Cannot deserialize picklist for ${name}`, [name]);
        const parts = f.type === "multipicklist" ? value.split(";") : [value];
        for (const part of parts) {
          if ((f.values || []).includes(part)) continue;
          if (f.restricted) throw sfError(400, "INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST", `${name}: bad value for restricted picklist field`, [name]);
          this.addedPicklistValues.add(`${sfObject}.${name}=${part}`);
        }
        if (f.controlledBy) {
          const allowed = f.dependentValues?.[String(merged[f.controlledBy])] || [];
          for (const part of parts) if (!allowed.includes(part)) throw sfError(400, "FIELD_INTEGRITY_EXCEPTION", `${name}: value not valid for the controlling field ${f.controlledBy}`, [name]);
        }
      } else if (TEXT_TYPES.has(f.type)) {
        if (typeof value !== "string") throw sfError(400, "JSON_PARSER_ERROR", `Cannot deserialize string for ${name}`, [name]);
        if (f.length && value.length > f.length) throw sfError(400, "STRING_TOO_LONG", `${name}: data value too large (max length=${f.length})`, [name]);
        if (f.type === "email" && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) throw sfError(400, "INVALID_EMAIL_ADDRESS", `${name}: invalid email address`, [name]);
      }
      if (f.unique && value !== null) {
        for (const r of this.records.get(sfObject).values()) {
          if (r[name] === value && r.Id !== existing?.Id) throw sfError(400, "DUPLICATE_VALUE", `duplicate value found: ${name} duplicates value on record with id: ${r.Id}`, [name]);
        }
      }
    }
    if (isCreate) {
      for (const [name, f] of Object.entries(o.fields)) {
        if (f.required && (fields[name] === undefined || fields[name] === null)) throw sfError(400, "REQUIRED_FIELD_MISSING", `Required fields are missing: [${name}]`, [name]);
      }
    }
  }

  // --- the four functions of lib/salesforce.js the seed uses ---------------------------------
  describeObject = async (sfObject) => {
    this.calls.describes.push(sfObject);
    const o = this.meta[sfObject];
    if (!o || o.absent) throw sfError(404, "NOT_FOUND", "The requested resource does not exist");
    const defaults = this.formulaDefaults[sfObject] || {};
    const fields = Object.entries(o.fields).map(([name, f]) => {
      const controlling = f.controlledBy ? o.fields[f.controlledBy].values || [] : [];
      return {
        name, label: f.label, type: f.type, createable: f.createable, updateable: f.updateable,
        nillable: !f.required, defaultedOnCreate: f.type === "boolean" || name === "OwnerId",
        calculated: !!f.formula, autoNumber: !!f.autoNumber, externalId: !!f.externalId, unique: !!f.unique,
        length: f.length ?? 0, precision: f.precision ?? 0, scale: f.scale ?? 0, referenceTo: f.referenceTo ?? [],
        defaultValue: f.defaultValue ?? null,
        defaultValueFormula: defaults[name] !== undefined ? String(defaults[name]) : null,
        restrictedPicklist: !!f.restricted, controllerName: f.controlledBy ?? null, nameField: name === "Name",
        picklistValues: (f.values || []).map((v) => ({
          value: v, active: true, defaultValue: v === f.defaultPicklistValue,
          validFor: f.controlledBy ? encodeValidFor(controlling.map((c, i) => ((f.dependentValues?.[c] || []).includes(v) ? i : -1)).filter((i) => i >= 0), controlling.length) : null,
        })),
      };
    });
    return { name: sfObject, label: o.label, createable: o.createable, updateable: o.updateable, deletable: o.deletable, fields };
  };

  sfCreateRecord = async (sfObject, fields) => {
    const crash = this.tick("create");
    if (crash === "before") throw new Error("fetch failed (simulated network failure before the write)");
    this.validate(sfObject, fields, true);
    const o = this.meta[sfObject];
    const record = {};
    for (const [name, f] of Object.entries(o.fields)) {
      if (f.type === "boolean") record[name] = f.defaultValue === true;
      else if (f.defaultPicklistValue !== undefined) record[name] = f.defaultPicklistValue;
    }
    Object.assign(record, this.formulaDefaults[sfObject] || {});
    for (const [k, v] of Object.entries(fields)) if (v !== null) record[k] = v;
    const id = this.newId(sfObject);
    if (o.nameField?.autoNumber) {
      const [prefix, width, start] = AUTO_NUMBER[sfObject] ?? ["N-", 5, 1];
      const n = (this.counters.get(sfObject) ?? start) + 1;
      this.counters.set(sfObject, n);
      record.Name = `${prefix}${String(n).padStart(width, "0")}`;
    } else if (record.Name === undefined) record.Name = id;
    this.insertRaw(sfObject, { ...record, Id: id });
    this.calls.creates.push({ sfObject, id, fields: { ...fields } });
    if (this.afterCreate) this.afterCreate(sfObject, this.records.get(sfObject).get(id));
    if (crash === "after") throw new Error("fetch failed (simulated network failure AFTER the write landed)");
    return { ok: true, id };
  };

  sfUpdateRecord = async (sfObject, id, fields) => {
    const crash = this.tick("update");
    if (crash === "before") throw new Error("fetch failed (simulated network failure before the write)");
    const existing = this.records.get(sfObject)?.get(id);
    if (!existing) throw sfError(404, "NOT_FOUND", "Provided external ID field does not exist or is not accessible");
    this.validate(sfObject, fields, false, existing);
    Object.assign(existing, fields, { LastModifiedDate: this.now().toISOString(), SystemModstamp: this.now().toISOString() });
    this.calls.updates.push({ sfObject, id, fields: { ...fields } });
    if (crash === "after") throw new Error("fetch failed (simulated network failure AFTER the write landed)");
    return { ok: true, id };
  };

  /** A small SOQL reader: SELECT a, b FROM Obj [WHERE x = 'v' AND y IN ('a','b')] [ORDER BY …] [LIMIT n]. */
  sfQuery = async (soql) => {
    this.calls.queries.push(soql);
    const m = /^SELECT\s+(.+?)\s+FROM\s+(\w+)(?:\s+WHERE\s+(.+?))?(?:\s+ORDER BY\s+.+?)?(?:\s+LIMIT\s+(\d+))?\s*$/is.exec(soql);
    if (!m) throw sfError(400, "MALFORMED_QUERY", "unexpected token");
    const [, selectList, sfObject, where, limit] = m;
    const o = this.meta[sfObject];
    if (!o || o.absent) throw sfError(400, "INVALID_TYPE", `sObject type '${sfObject}' is not supported`);
    const select = selectList.split(",").map((s) => s.trim());
    for (const f of select) if (!o.fields[f]) throw sfError(400, "INVALID_FIELD", `No such column '${f}' on entity '${sfObject}'`, [f]);
    const tests = [];
    for (const cond of where ? where.split(/\s+AND\s+/i) : []) {
      let c;
      if ((c = /^(\w+)\s+IN\s+\((.*)\)$/is.exec(cond.trim()))) {
        const values = [...c[2].matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((x) => x[1]);
        tests.push([c[1], (v) => values.includes(v)]);
      } else if ((c = /^(\w+)\s*(=|!=)\s*'((?:[^'\\]|\\.)*)'$/s.exec(cond.trim()))) {
        const want = c[3].replace(/\\'/g, "'");
        tests.push([c[1], c[2] === "=" ? (v) => v === want : (v) => v !== want]);
      } else throw sfError(400, "MALFORMED_QUERY", `unsupported condition in the fake org: ${cond}`);
      if (!o.fields[tests[tests.length - 1][0]]) throw sfError(400, "INVALID_FIELD", `No such column '${tests[tests.length - 1][0]}' on entity '${sfObject}'`);
    }
    let rows = this.all(sfObject).filter((r) => tests.every(([f, ok]) => ok(r[f] ?? null)));
    if (limit) rows = rows.slice(0, Number(limit));
    return rows.map((r) => {
      const out = { attributes: { type: sfObject } };
      for (const f of select) {
        const v = r[f] ?? null;
        // Salesforce hands date-times back with "+0000", not "Z".
        out[f] = v !== null && o.fields[f].type === "datetime" ? sfDateTime(v) : v;
      }
      return out;
    });
  };

  get sf() {
    return { sfQuery: this.sfQuery, sfCreateRecord: this.sfCreateRecord, sfUpdateRecord: this.sfUpdateRecord, describeObject: this.describeObject };
  }
}

// ---------------------------------------------------------------------------------------
// Supabase
// ---------------------------------------------------------------------------------------

const UNIQUE = {
  profiles: [["id"]],
  comments: [["id"]],
  sundial_sms_messages: [["provider_sid"]],
  sundial_notifications: [["profile_id", "dedupe_key"]],
};
const SERIAL_ID = new Set(["sundial_service_activity", "sundial_sms_messages"]);

class Query {
  constructor(db, table) {
    this.db = db;
    this.table = table;
    this.filters = [];
    this.action = "select";
    this.max = null;
    this.window = null;
    this.one = false;
    this.returning = false;
  }
  select() { if (this.action !== "select") this.returning = true; return this; }
  eq(col, val) { this.filters.push((r) => r[col] === val); return this; }
  in(col, vals) { this.filters.push((r) => vals.includes(r[col])); return this; }
  limit(n) { this.max = n; return this; }
  range(a, b) { this.window = [a, b]; return this; }
  maybeSingle() { this.one = true; return this; }
  single() { this.one = true; return this; }
  insert(rows) { this.action = "insert"; this.rows = Array.isArray(rows) ? rows : [rows]; return this; }
  upsert(rows, opts = {}) { this.action = "upsert"; this.rows = Array.isArray(rows) ? rows : [rows]; this.opts = opts; return this; }
  then(resolve, reject) { return Promise.resolve(this.run()).then(resolve, reject); }

  run() {
    const t = this.db.tables.get(this.table);
    if (!t) return { data: null, error: { code: "42P01", message: `relation "${this.table}" does not exist` } };
    const cols = this.db.columns.get(this.table);
    if (this.action === "select") {
      let rows = t.filter((r) => this.filters.every((f) => f(r)));
      if (this.window) rows = rows.slice(this.window[0], this.window[1] + 1);
      if (this.max !== null) rows = rows.slice(0, this.max);
      return { data: this.one ? rows[0] ?? null : rows.map((r) => ({ ...r })), error: null };
    }
    const written = [];
    for (const row of this.rows) {
      for (const k of Object.keys(row)) if (!cols.has(k)) return { data: null, error: { code: "PGRST204", message: `Could not find the '${k}' column of '${this.table}' in the schema cache` } };
      const conflictCols = this.action === "upsert" && this.opts.onConflict ? this.opts.onConflict.split(",") : null;
      const clash = (cs) => t.find((r) => cs.every((c) => r[c] !== undefined && r[c] !== null && r[c] === row[c]));
      const onConflictHit = conflictCols ? clash(conflictCols) : null;
      if (onConflictHit) {
        if (this.opts.ignoreDuplicates) continue;
        Object.assign(onConflictHit, row);
        written.push(onConflictHit);
        continue;
      }
      for (const cs of UNIQUE[this.table] || []) {
        if (clash(cs)) return { data: null, error: { code: "23505", message: `duplicate key value violates unique constraint on ${this.table} (${cs.join(", ")})` } };
      }
      const full = { ...row };
      if (full.id === undefined) full.id = SERIAL_ID.has(this.table) ? ++this.db.serial : this.db.uuid();
      t.push(full);
      this.db.inserts.push({ table: this.table, row: full });
      written.push(full);
    }
    if (!this.returning) return { data: null, error: null };
    return { data: this.one ? written[0] ?? null : written.map((r) => ({ ...r })), error: null };
  }
}

export class FakeSupabase {
  constructor(probe) {
    this.tables = new Map();
    this.columns = new Map();
    this.inserts = [];
    this.serial = 1000;
    this.users = [];
    // Predictable ids, so two fake worlds that did the same things hold the same data.
    let n = 0;
    this.uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
    for (const [table, info] of Object.entries(probe.supabase)) {
      const cols = Object.keys(info.columns || {});
      this.columns.set(table, new Set(cols));
      // One existing (Harmon) row per table, as in the live project — the seed reads a row to learn the columns.
      const row = Object.fromEntries(cols.map((c) => [c, null]));
      if ("client_sf_id" in row) row.client_sf_id = "a1W7y000007AszBEAS";
      if ("tenant_id" in row) row.tenant_id = table === "profiles" || table === "comments" || table === "sundial_file_metadata" ? "a1W7y000007AszBEAS" : "harmon";
      row.id = SERIAL_ID.has(table) ? 1 : "11111111-1111-4111-8111-111111111111";
      if (table === "sundial_sms_messages") row.provider_sid = "SM00000000000000000000000000000001";
      this.tables.set(table, [row]);
    }
    this.auth = {
      admin: {
        createUser: async ({ email, password, email_confirm }) => {
          if (this.users.some((u) => u.email.toLowerCase() === String(email).toLowerCase())) return { data: { user: null }, error: { message: "A user with this email address has already been registered" } };
          const user = { id: this.uuid(), email, password, email_confirmed: email_confirm === true };
          this.users.push(user);
          return { data: { user: { id: user.id, email } }, error: null };
        },
        listUsers: async ({ page = 1, perPage = 50 } = {}) => ({ data: { users: this.users.slice((page - 1) * perPage, page * perPage).map((u) => ({ id: u.id, email: u.email })) }, error: null }),
        updateUserById: async (id, attrs) => {
          const u = this.users.find((x) => x.id === id);
          if (!u) return { data: null, error: { message: "User not found" } };
          Object.assign(u, attrs);
          return { data: { user: { id } }, error: null };
        },
      },
    };
  }
  from(table) {
    return new Query(this, table);
  }
  /** Rows of a table that belong to one tenant id (either tenant column). */
  rowsFor(table, tenantId) {
    return (this.tables.get(table) || []).filter((r) => r.client_sf_id === tenantId || r.tenant_id === tenantId);
  }
}

// ---------------------------------------------------------------------------------------
// The whole fake world, in the shape real-io.js provides
// ---------------------------------------------------------------------------------------

/**
 * @param {object} probe
 * @param {{ now?: string, env?: object, formulaDefaults?: object }} [opts]
 */
export function createFakeIo(probe, opts = {}) {
  let nowIso = opts.now ?? "2026-09-29T17:40:00.000Z"; // a Tuesday, 10:40 in Phoenix
  const org = new FakeOrg(probe, { formulaDefaults: opts.formulaDefaults, now: () => new Date(nowIso) });
  const supabase = new FakeSupabase(probe);
  const secretStore = new Map();
  const secretWrites = [];
  const objects = new Map();
  const store = new Map([["probe.json", JSON.stringify(probe)]]);
  const lines = [];
  let passwords = 0;
  const io = {
    sf: org.sf,
    getSupabase: async () => supabase,
    secrets: {
      load: async (name) => (secretStore.has(name) ? JSON.parse(secretStore.get(name)) : null),
      save: async (name, obj, existed) => {
        if (existed && !secretStore.has(name)) throw new Error("ResourceNotFoundException");
        if (!existed && secretStore.has(name)) throw new Error("ResourceExistsException");
        secretStore.set(name, JSON.stringify(obj));
        secretWrites.push(name);
      },
    },
    s3: { putObject: async ({ key, body, contentType }) => { objects.set(key, { size: body.byteLength, contentType, head: Buffer.from(body.slice(0, 5)).toString("latin1") }); } },
    files: {
      readJson: async (name) => (store.has(name) ? JSON.parse(store.get(name)) : null),
      writeJsonAtomic: async (name, obj) => { store.set(name, JSON.stringify(obj)); },
    },
    now: () => new Date(nowIso),
    env: opts.env ?? {},
    log: (line) => lines.push(String(line)),
    randomPassword: () => `fake-password-${++passwords}-aA1!`,
  };
  return {
    io, org, supabase, lines,
    secrets: secretStore, secretWrites, s3: objects, files: store,
    setNow: (iso) => { nowIso = iso; },
    output: () => lines.join("\n"),
    idmap: () => (store.has("id-map.json") ? JSON.parse(store.get("id-map.json")) : null),
  };
}
