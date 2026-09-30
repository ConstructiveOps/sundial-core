// writer.js — turns the plan's operations into Salesforce writes, safely.
//
// What "safely" means here (the non-negotiable rules of the seed):
//
//   * RESUMABLE: a record whose key is already in the id-map is never created again; a
//     follow-up update already marked done is never repeated.
//   * WRITE-THROUGH: the id-map is saved after EVERY successful create, before the next.
//   * TENANT STAMP: a record is refused locally unless its Client__c is the demo tenant.
//   * OWN RECORDS ONLY: an update is refused unless its target is a key of the id-map (of
//     the right object) AND Salesforce itself says the record behind that id carries the
//     demo tenant — asked once per object per run, for every update target at once.
//   * CANARY: the first record of every object — and, on customers and solar projects,
//     the first record in every stage — is read back in full before another is written
//     (canary.js).
//   * VALUE-SAFE ERRORS: a Salesforce error body can carry record data, so only the error
//     code, the field names and the message are ever printed.

import { jobNotesFieldsFor } from "../../lambdas/sundial-service-board/job-notes.js";
import { resolveFields } from "./tokens.js";
import { checkCanary, sameValue, canaryTags, describeTags } from "./canary.js";
import { recoverFreshenRecords, recoverCallsByPosition, PARENT_FIELD, RECOVERY_EXTRA_FIELDS } from "./recovery.js";
import { OBJ, NATURAL_KEYS, SEEDED_OBJECTS, objectOfKey } from "./policy.js";
import { PHOENIX_TZ } from "./dates.js";

export class SeedError extends Error {
  constructor(message, code = "SEED_ERROR") {
    super(message);
    this.name = "SeedError";
    this.code = code;
  }
}

/** A Salesforce failure as one printable line: status, error codes, field names, messages. Never the body. */
export function describeSfError(e) {
  const status = e?.sfStatus ? `HTTP ${e.sfStatus}` : e?.message || "error";
  let detail = "";
  try {
    const body = typeof e?.sfBody === "string" ? JSON.parse(e.sfBody) : e?.sfBody;
    const list = Array.isArray(body) ? body : body ? [body] : [];
    detail = list
      .map((x) => `${x.errorCode || x.error || "?"}${x.fields?.length ? ` [${x.fields.join(", ")}]` : ""}: ${String(x.message || x.error_description || "").slice(0, 200)}`)
      .join(" | ");
  } catch {
    detail = "(unreadable error body)";
  }
  return detail ? `${status} — ${detail}` : status;
}

const chunk = (arr, n) => {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
};
/** Ids per `WHERE Id IN (…)` — about 3,500 characters of SOQL, far inside the URL limit (canary.js). */
export const ID_CHUNK = 150;
const id15 = (v) => String(v ?? "").slice(0, 15);
const inList = (ids) => ids.map((id) => `'${id}'`).join(", ");

export class Writer {
  /**
   * @param {object} p
   *   sf        { sfQuery, sfCreateRecord, sfUpdateRecord }
   *   idmap     IdMap
   *   schema    Schema (live)
   *   ops       the preflighted operations (every phase — needed to name a missing reference)
   *   log       (line) => void
   *   counters  { created: {}, updated: {}, skipped: {} } — filled in as the run goes
   *   acceptCanary  Set of object names whose failed canary the owner has reviewed
   *   now       () => Date — this PC's clock, stamped on every write (auditModifications)
   *   adopted   Set of keys this run re-found by natural key after a crash (their canary is still due)
   *   recovering  true while the id-map is being rebuilt after it was lost (adopted records are NOT canaried)
   */
  constructor({ sf, idmap, schema, ops, log, counters, acceptCanary = new Set(), now = () => new Date(), adopted = new Set(), recovering = false }) {
    this.sf = sf;
    this.idmap = idmap;
    this.schema = schema;
    this.ops = ops;
    this.log = log;
    this.counters = counters;
    this.acceptCanary = acceptCanary;
    this.now = now;
    this.adopted = recovering ? new Set() : adopted;
    this.opByKey = new Map(ops.filter((o) => o.op === "create").map((o) => [o.key, o]));
    this.names = new Map();
    this.defaulted = new Map();
    /** Ids Salesforce has confirmed carry the demo tenant (or that this run created itself). */
    this.verified = new Set();
    this.verifiedObjects = new Set();
    /** Per object: the read-back query size that worked (canary.js readRecordInFull). */
    this.canaryLimits = {};
    this.canaries = 0;
    this.acceptancesApplied = false;
  }

  get tenantId() {
    return this.idmap.idOf("tenant");
  }

  idOf(key) {
    const id = this.idmap.idOf(key);
    if (!id) {
      const phase = this.opByKey.get(key)?.phase;
      throw new SeedError(`"${key}" has not been created yet${phase ? ` — run the "${phase}" phase first` : ""}.`, "MISSING_REFERENCE");
    }
    return id;
  }

  /** The auto-number / Name of a record this run created (SVC-00042). Read once, remembered. */
  async nameOf(key) {
    if (this.names.has(key)) return this.names.get(key);
    const id = this.idOf(key);
    const sfObject = this.opByKey.get(key)?.object ?? objectOfKey(key, this.idmap.data.objects);
    const rows = await this.sf.sfQuery(`SELECT Id, Name FROM ${sfObject} WHERE Id = '${id}'`);
    const name = rows?.[0]?.Name;
    if (!name) throw new SeedError(`could not read the number of "${key}" back from Salesforce`, "NAME_UNREADABLE");
    this.names.set(key, name);
    return name;
  }

  /** The job's call-notes roll-up, built by the board Lambda's own function once the call numbers exist. */
  async jobNotes(spec) {
    const job = {};
    if (spec.mergeInto) {
      // --freshen adds a call to a job that already has notes: merge into what is there now,
      // the way the board does (a block per call, an existing block replaced, never doubled).
      const rows = await this.sf.sfQuery(`SELECT Id, Notes_for_Summary__c, Notes_From_Service_Calls__c FROM ${OBJ.job} WHERE Id = '${this.idOf(spec.mergeInto)}'`);
      Object.assign(job, rows?.[0] || {});
    }
    for (const c of spec.calls) {
      const call = { Name: await this.nameOf(c.key), Work_Notes__c: c.work, Private_Notes__c: c.priv };
      const fields = jobNotesFieldsFor(job, call, { techName: c.techName, at: c.at, timeZone: PHOENIX_TZ });
      if (fields) Object.assign(job, fields);
    }
    return (spec.kind === "work" ? job.Notes_for_Summary__c : job.Notes_From_Service_Calls__c) ?? null;
  }

  resolver() {
    return {
      idOf: (k) => this.idOf(k),
      nameOf: (k) => this.nameOf(k),
      authOf: (k) => {
        const id = this.idmap.data.supabase.authUsers[k];
        if (!id) throw new SeedError(`the login for "${k}" has not been created yet — run the "users" phase first.`, "MISSING_AUTH_USER");
        return id;
      },
      jobNotes: (spec) => this.jobNotes(spec),
    };
  }

  async resolve(op) {
    const fields = await resolveFields(op.fields, this.resolver());
    for (const k of Object.keys(fields)) {
      // A blank that was PLANNED on an update (a literal null) clears the field. A value
      // that merely turned out empty (no private notes to roll up) is simply not sent.
      const plannedBlank = op.op === "update" && op.fields[k] === null;
      if ((fields[k] === null || fields[k] === undefined) && !plannedBlank) delete fields[k];
    }
    return fields;
  }

  bump(kind, sfObject) {
    this.counters[kind][sfObject] = (this.counters[kind][sfObject] || 0) + 1;
  }

  /**
   * --accept-canary <Object>: the owner has looked at the difference the last canary on that
   * object found and says it is harmless. Exactly THOSE fields are tolerated from now on —
   * on the record that failed (it is read back again) and on every later canary of the
   * object. Any other difference still stops the run.
   */
  async applyAcceptances() {
    if (this.acceptancesApplied) return;
    this.acceptancesApplied = true;
    const d = this.idmap.data;
    for (const sfObject of this.acceptCanary) {
      const open = d.canaryOpen[sfObject];
      if (open?.state === "failed" && open.fields?.length) {
        d.canaryAccepted[sfObject] = [...new Set([...(d.canaryAccepted[sfObject] || []), ...open.fields])].sort();
        this.log(`  --accept-canary ${sfObject}: accepting the difference found on ${open.key} in ${open.fields.join(", ")}. The record is read back again; anything else still stops the run.`);
      } else if (open?.state === "failed") {
        this.log(`  --accept-canary ${sfObject}: the canary on ${open.key} failed because the record could not be read back — there is no difference to accept. It is tried again.`);
      } else if (!open && d.canary[sfObject] === "failed") {
        // An id-map written before differences were recorded field by field.
        d.canary[sfObject] = "passed";
        this.log(`  canary ${sfObject}: ACCEPTED by --accept-canary (not re-checked)`);
      } else {
        this.log(`  --accept-canary ${sfObject}: no failed canary is recorded for it — nothing to accept.`);
      }
    }
    if (this.acceptCanary.size) await this.idmap.save();
  }

  /** Read one canary record back in full; settle its tags, or stop the run. */
  async canary(op, id, fields, tags) {
    const sfObject = op.object;
    const d = this.idmap.data;
    const r = await checkCanary({
      sfQuery: this.sf.sfQuery, schema: this.schema, sfObject, id, written: fields,
      accepted: d.canaryAccepted[sfObject] || [], limits: (this.canaryLimits[sfObject] ??= {}),
    });
    this.canaries++;
    if (!r.ok) {
      d.canaryOpen[sfObject] = { key: op.key, tags, state: "failed", fields: r.fields };
      this.idmap.markCanary(sfObject, tags, "failed");
      await this.idmap.save();
      const lines = [
        `CANARY FAILED on ${sfObject} (${op.key}, ${id}) — ${describeTags(tags)}. The record was written and then read back in full:`,
        ...r.mismatches.map((m) => `    did not read back as written — ${m}`),
        ...r.surprises.map((m) => `    changed by something else     — ${m}`),
        `  Nothing else of this object was written. Something in the org (a Flow, a trigger, a`,
        `  validation or a default this script does not know) reacts to demo records. Find out`,
        `  what, then re-run; if the difference is understood and harmless, re-run with`,
        `  --accept-canary ${sfObject} (it accepts exactly the field(s) named above, nothing else).`,
      ];
      throw new SeedError(lines.join("\n"), "CANARY_FAILED");
    }
    this.idmap.markCanary(sfObject, tags, "passed");
    delete d.canaryOpen[sfObject];
    await this.idmap.save();
    if (r.defaulted.length) this.defaulted.set(sfObject, [...new Set([...(this.defaulted.get(sfObject) || []), ...r.defaulted])]);
    const accepted = r.tolerated.length ? `; accepted difference(s): ${r.tolerated.join(", ")}` : "";
    this.log(`  canary ${sfObject} [${describeTags(tags)}]: ${op.key} read back exactly as written (${Object.keys(fields).length} fields written, ${r.checked} checked, nothing else changed${accepted})`);
  }

  async create(op) {
    const d = this.idmap.data;
    const tags = canaryTags(op.object, op.fields);
    const unsettled = () => tags.filter((t) => this.idmap.canaryState(op.object, t) !== "passed");
    const open = d.canaryOpen[op.object];
    const existing = this.idmap.idOf(op.key);
    if (existing) {
      this.bump("skipped", op.object);
      // A canary that never finished is settled before anything else of this object is
      // written: the record whose canary failed (or was cut short by a crash), and a record
      // this run re-found by its natural key (it landed, but was never read back).
      let due = [];
      if (open?.key === op.key) due = open.tags;
      else if (this.adopted.has(op.key)) due = unsettled();
      else if (!open && d.canary[op.object] === "failed" && Array.isArray(op.canary) && op.canary.includes("first")) due = ["first"];
      if (due.length) await this.canary(op, existing, await this.resolve(op), due);
      return existing;
    }
    if (open && open.key !== op.key) {
      throw new SeedError(`${op.key}: the canary on ${op.object} (${open.key}) is not settled yet — nothing more of this object is written until it is. Re-run the phase that wrote ${open.key}.`, "CANARY_OPEN");
    }
    // The canary record itself is gone from Salesforce (deleted by an admin): it is written again, and read back again.
    if (open) delete d.canaryOpen[op.object];
    const fields = await this.resolve(op);
    if (op.object !== OBJ.tenant && this.schema.hasField(op.object, "Client__c") && fields.Client__c !== this.tenantId) {
      throw new SeedError(`${op.key}: refusing to write a record that is not stamped with the demo tenant.`, "TENANT_STAMP");
    }
    const due = unsettled();
    // Saved together with the id: a crash between "written" and "read back" leaves a note
    // that this record's canary is still to be done.
    if (due.length) d.canaryOpen[op.object] = { key: op.key, tags: due, state: "pending" };
    let created;
    try {
      created = await this.sf.sfCreateRecord(op.object, fields);
    } catch (e) {
      delete d.canaryOpen[op.object];
      throw new SeedError(`${op.key} (${op.object}) could not be created: ${describeSfError(e)}`, "SF_CREATE_FAILED");
    }
    if (!created?.id) {
      delete d.canaryOpen[op.object];
      throw new SeedError(`${op.key}: Salesforce returned no id.`, "SF_NO_ID");
    }
    // Records added by --freshen are not in the seed plan, so the id-map also remembers what they are.
    if (op.key.startsWith("fresh:")) d.objects[op.key] = op.object;
    this.verified.add(created.id);
    await this.idmap.setId(op.key, created.id, this.now().getTime());
    this.bump("created", op.object);
    if (due.length) await this.canary(op, created.id, fields, due);
    return created.id;
  }

  /** Ask Salesforce: do these records exist, and is each one's Client__c the demo tenant? */
  async verifyTenant(sfObject, ids, why) {
    if (!ids.length) return;
    if (!this.schema.hasField(sfObject, "Client__c")) throw new SeedError(`${why}: ${sfObject} has no Client__c, so an update there cannot be verified as the demo's. Refusing.`, "NOT_OWNED");
    for (const part of chunk(ids, ID_CHUNK)) {
      const rows = await this.sf.sfQuery(`SELECT Id, Client__c FROM ${sfObject} WHERE Id IN (${inList(part)})`);
      const found = new Map((rows || []).map((r) => [id15(r.Id), r.Client__c]));
      for (const id of part) {
        if (!found.has(id15(id))) throw new SeedError(`${why}: refusing to update ${sfObject} ${id} — Salesforce has no such record.`, "NOT_OWNED");
        if (id15(found.get(id15(id))) !== id15(this.tenantId)) throw new SeedError(`${why}: refusing to update ${sfObject} ${id} — its Client__c is not the demo tenant.`, "NOT_OWNED");
        this.verified.add(id);
      }
    }
  }

  /**
   * Safety rule 4, enforced where the write happens. Two independent conditions:
   *   1. the target is a key of the id-map, recorded for THIS object, and that is the id;
   *   2. Salesforce confirms the record carries the demo tenant. On the FIRST update of an
   *      object in a run, every update target of that object that exists by then is read
   *      back in one query (two for more than 150) — including records this run has just
   *      created. A target created later in the same run was written by this process with
   *      the tenant stamp a moment ago and is not read a second time; anything else is.
   */
  async assertOwned(op, id) {
    const mappedObject = this.opByKey.get(op.target)?.object ?? objectOfKey(op.target, this.idmap.data.objects);
    if (!id || this.idmap.idOf(op.target) !== id || mappedObject !== op.object) {
      throw new SeedError(`${op.key}: refusing to update ${id} — "${op.target}" is not a ${op.object} recorded in the id-map.`, "NOT_OWNED");
    }
    if (!this.verifiedObjects.has(op.object)) {
      const targets = new Set();
      for (const o of this.ops) {
        if (o.op !== "update" || o.object !== op.object || this.idmap.steps[o.key]) continue;
        const t = this.idmap.idOf(o.target);
        if (t) targets.add(t);
      }
      await this.verifyTenant(op.object, [...targets], `${op.key} (checking every ${op.object} this run updates)`);
      this.verifiedObjects.add(op.object);
    }
    if (!this.verified.has(id)) await this.verifyTenant(op.object, [id], op.key);
  }

  async update(op) {
    if (this.idmap.steps[op.key]) {
      this.bump("skipped", op.object);
      return;
    }
    const id = this.idOf(op.target);
    await this.assertOwned(op, id);
    const fields = await this.resolve(op);
    if (Object.keys(fields).length) {
      try {
        await this.sf.sfUpdateRecord(op.object, id, fields);
      } catch (e) {
        throw new SeedError(`${op.key} (${op.object}) could not be updated: ${describeSfError(e)}`, "SF_UPDATE_FAILED");
      }
      this.bump("updated", op.object);
      await this.idmap.setStep(op.key, op.target, this.now().getTime());
      return;
    }
    await this.idmap.setStep(op.key);
  }

  /** Run one phase's operations in plan order. */
  async runPhase(phase) {
    await this.applyAcceptances();
    const ops = this.ops.filter((o) => o.phase === phase);
    let n = 0;
    for (const op of ops) {
      if (op.op === "create") await this.create(op);
      else await this.update(op);
      n++;
      if (n % 100 === 0) this.log(`    … ${n}/${ops.length}`);
    }
    return ops.length;
  }
}

// ---------------------------------------------------------------------------------------
// What is already in the org for this tenant, and does the id-map account for it?
// ---------------------------------------------------------------------------------------

const keyValue = (v) => (v === null || v === undefined ? null : v);
const sfMs = (v) => Date.parse(String(v ?? "").replace(/\+0000$/, "Z"));
/** Oldest first; an auto-number Name breaks a tie inside one second. */
const byCreated = (a, b) => (sfMs(a.CreatedDate) || 0) - (sfMs(b.CreatedDate) || 0) || String(a.Name ?? "").localeCompare(String(b.Name ?? ""), "en", { numeric: true }) || String(a.Id).localeCompare(String(b.Id));

/**
 * Compare the org with the id-map.
 *
 *   missing     ids in the id-map that are no longer in the org (someone deleted them)
 *               -> forgotten, so the record is created again
 *   unaccounted records in the demo tenant the id-map does not know
 *               -> tried against the plan's not-yet-mapped records by natural key (this is
 *                  how a crash between "created" and "saved" heals); whatever cannot be
 *                  matched is reported, and an --apply refuses to continue
 *
 * `recovering` — the id-map was LOST and is being rebuilt from nothing (run.js restored the
 * anchor and seed from the secret, so the plan is the original one). Then two more ways of
 * recognising a record are used, because the demo has been lived in since the seed:
 *   * records --freshen added carry their own key in their clock / day log (recovery.js);
 *   * a job's calls are matched by the ORDER they were created in (--freshen and the
 *     dispatch board change a call's time, tech and status — its natural key — but never
 *     its place in that order).
 * And one more outcome:
 *   unresolved  a planned record that was not found, while an unrecognised record sits
 *               under the same parent (or, for objects without a parent, in the same
 *               object): one is very likely the other after an edit, so creating the
 *               planned record would DUPLICATE it. The caller must refuse — and
 *               --allow-unaccounted does not override this.
 *
 * READ-ONLY apart from the id-map itself.
 */
export async function reconcile({ sf, schema, idmap, ops, tenantId, log, recovering = false }) {
  const report = { perObject: {}, adopted: [], adoptedKeys: [], forgotten: [], unaccounted: {}, unresolved: {}, byPosition: 0, fromFreshen: 0 };
  if (!tenantId) return report;
  const createOps = ops.filter((o) => o.op === "create");
  const objects = SEEDED_OBJECTS.filter((o) => o !== OBJ.tenant && schema.has(o) && schema.hasField(o, "Client__c"));
  const keysByObject = new Map();
  for (const op of createOps) {
    if (!keysByObject.has(op.object)) keysByObject.set(op.object, []);
    keysByObject.get(op.object).push(op);
  }
  // Records added by --freshen are in the id-map (with their object) but not in the plan.
  const keyOfId = new Map(Object.entries(idmap.ids).map(([k, v]) => [v, k]));
  const adopt = async (key, id, sfObject, how) => {
    await idmap.setId(key, id);
    keyOfId.set(id, key);
    report.adopted.push(`${key} = ${id}`);
    report.adoptedKeys.push(key);
    report.perObject[sfObject].mapped++;
    if (how === "position") report.byPosition++;
    if (how === "freshen") report.fromFreshen++;
  };

  for (const sfObject of objects) {
    const natural = (NATURAL_KEYS[sfObject] || []).filter((f) => schema.hasField(sfObject, f));
    const extra = recovering ? RECOVERY_EXTRA_FIELDS[sfObject] || [] : [];
    const select = [...new Set(["Id", "Name", "CreatedDate", ...natural, ...extra])].filter((f) => f === "Id" || schema.hasField(sfObject, f));
    const rows = await sf.sfQuery(`SELECT ${select.join(", ")} FROM ${sfObject} WHERE Client__c = '${tenantId}'`);
    // Oldest first, so that of two look-alikes (an invoice and its reissue) the seed's own
    // record — the older one — is the one recognised.
    rows.sort(byCreated);
    const inOrg = new Set(rows.map((r) => r.Id));
    report.perObject[sfObject] = { inOrg: rows.length, mapped: 0 };

    // 1. mapped ids that are gone
    const planned = keysByObject.get(sfObject) || [];
    const planKeys = new Set(planned.map((o) => o.key));
    for (const [key, id] of Object.entries(idmap.ids)) {
      const isThisObject = planKeys.has(key) || objectOfKey(key, idmap.data.objects) === sfObject;
      if (!isThisObject) continue;
      if (inOrg.has(id)) report.perObject[sfObject].mapped++;
      else {
        report.forgotten.push(key);
        keyOfId.delete(id);
        await idmap.dropId(key);
      }
    }

    // 2. records the id-map does not know
    const orphans = rows.filter((r) => !keyOfId.has(r.Id));
    if (!orphans.length) continue;
    const unmapped = planned.filter((o) => !idmap.has(o.key));
    // A natural key that points at a record which itself is not mapped yet cannot be compared.
    const need = (v) => { if (!v) throw new Error("unresolved"); return v; };
    const resolver = { idOf: (k) => need(idmap.idOf(k)), nameOf: async () => need(null), authOf: (k) => need(idmap.data.supabase.authUsers[k]), jobNotes: async () => null };
    const candidates = [];
    for (const op of unmapped) {
      const want = {};
      let usable = natural.length > 0;
      for (const f of natural) {
        const v = op.fields[f];
        try {
          want[f] = keyValue(v === undefined ? null : await resolveFields({ v }, resolver).then((x) => x.v));
        } catch {
          usable = false;
        }
      }
      if (usable) candidates.push({ op, want });
    }
    for (const orphan of orphans) {
      const hits = candidates.filter((c) => !c.taken && natural.every((f) => sameValue(c.want[f], orphan[f], schema.field(sfObject, f))));
      if (hits.length === 1) {
        hits[0].taken = true;
        await adopt(hits[0].op.key, orphan.Id, sfObject, "natural");
      }
    }

    if (recovering) {
      for (const hit of recoverFreshenRecords({ sfObject, rows, idmap, keyOfId })) {
        idmap.data.objects[hit.key] = sfObject;
        await adopt(hit.key, hit.id, sfObject, "freshen");
      }
      if (sfObject === OBJ.call) {
        for (const hit of recoverCallsByPosition({ rows, planned, idmap, keyOfId })) await adopt(hit.key, hit.id, sfObject, "position");
      }
    }

    const left = rows.filter((r) => !keyOfId.has(r.Id));
    if (left.length) report.unaccounted[sfObject] = left.length;

    // 3. (rebuilding only) a planned record still not found, next to a record nobody recognises
    if (recovering && left.length) {
      const parentField = PARENT_FIELD[sfObject];
      const pairs = [];
      for (const c of candidates) {
        if (idmap.has(c.op.key)) continue;
        const near = left.filter((r) => !parentField || sameValue(c.want[parentField], r[parentField], schema.field(sfObject, parentField)));
        if (near.length) pairs.push({ key: c.op.key, want: c.want, near: near.map((r) => `${r.Id}${r.Name && r.Name !== r.Id ? ` "${String(r.Name).slice(0, 40)}"` : ""}`) });
      }
      if (pairs.length) report.unresolved[sfObject] = { natural, parentField: parentField ?? null, pairs };
    }
  }
  if (report.adopted.length) {
    if (recovering) log(`  id-map rebuilt: ${report.adopted.length} record(s) recognised in Salesforce${report.byPosition ? ` (${report.byPosition} service call(s) by their order under the job)` : ""}${report.fromFreshen ? ` (${report.fromFreshen} added by --freshen)` : ""}.`);
    else log(`  recovered ${report.adopted.length} record(s) a previous run created but did not get to record: ${report.adopted.join(", ")}`);
  }
  if (report.forgotten.length) log(`  ${report.forgotten.length} record(s) in the id-map are no longer in Salesforce and will be created again: ${report.forgotten.slice(0, 12).join(", ")}${report.forgotten.length > 12 ? " …" : ""}`);
  return report;
}

/**
 * The final check (safety rule 3): every record in the id-map exists and carries the demo
 * tenant. Returns a list of problems (empty = all good) — and, from the same queries (no
 * extra API call), each record's CreatedDate / LastModifiedDate / SystemModstamp for
 * auditModifications() below.
 */
export async function assertTenantStamp({ sf, schema, idmap, ops, tenantId }) {
  const problems = [];
  const stamps = new Map();
  const byObject = new Map();
  const objectOf = new Map(ops.filter((o) => o.op === "create").map((o) => [o.key, o.object]));
  for (const [key, id] of Object.entries(idmap.ids)) {
    const sfObject = objectOf.get(key) ?? objectOfKey(key, idmap.data.objects);
    if (!sfObject) continue;
    if (!byObject.has(sfObject)) byObject.set(sfObject, []);
    byObject.get(sfObject).push({ key, id });
  }
  const counts = {};
  for (const [sfObject, list] of byObject) {
    const isTenant = sfObject === OBJ.tenant;
    if (!isTenant && !schema.hasField(sfObject, "Client__c")) { problems.push(`${sfObject}: has no Client__c — records cannot be verified`); continue; }
    const select = ["Id", ...(isTenant ? [] : ["Client__c"]), ...["CreatedDate", "LastModifiedDate", "SystemModstamp"].filter((f) => schema.hasField(sfObject, f))];
    const found = new Map();
    for (const part of chunk(list, ID_CHUNK)) {
      const rows = await sf.sfQuery(`SELECT ${select.join(", ")} FROM ${sfObject} WHERE Id IN (${inList(part.map((x) => x.id))})`);
      for (const r of rows) found.set(r.Id, r);
    }
    if (!isTenant) counts[sfObject] = found.size;
    for (const { key, id } of list) {
      const row = found.get(id);
      if (!row) problems.push(`${key} (${id}) is in the id-map but not in Salesforce`);
      else if (!isTenant && id15(row.Client__c) !== id15(tenantId)) problems.push(`${key} (${id}) does NOT carry the demo tenant in Client__c`);
      if (row) stamps.set(key, { id, object: sfObject, created: row.CreatedDate ?? null, modified: row.LastModifiedDate ?? null, modstamp: row.SystemModstamp ?? null });
    }
  }
  return { problems, counts, stamps };
}

export const MODIFIED_TOLERANCE_MS = 5000;

/**
 * "Has something ELSE touched a demo record?" — the question the canary cannot answer
 * for automation that runs later (a scheduled Flow path, another integration, a person).
 *
 * For every record in the id-map: is Salesforce's LastModifiedDate later than this
 * script's own last write to it, by more than five seconds? Those records are REPORTED —
 * never a reason to stop: someone editing a demo record in the portal is the everyday cause.
 *
 * The two clocks: a write is stamped with THIS PC's clock (id-map `pendingWrites`), which
 * may be off from Salesforce's by more than the tolerance. So the difference between the
 * two is measured, not assumed: for the records created since the last check, Salesforce's
 * own CreatedDate is compared with the local time of the create, and the median gap is
 * applied to every pending stamp, which is then kept on Salesforce's clock (`lastWrite`).
 * A record with no stamp at all (an id-map rebuilt after a loss, or written by an older
 * version of this script) cannot be judged: what Salesforce shows now becomes its baseline.
 * A reported record is re-baselined too, so each run reports what changed since the last.
 *
 * @returns {Promise<{ late: Array<{key,id,object,lateBySeconds,modified,modstampLater}>, baselined:number, checked:number, offsetMs:number }>}
 */
export async function auditModifications({ idmap, stamps, toleranceMs = MODIFIED_TOLERANCE_MS }) {
  const d = idmap.data;
  const pending = Object.entries(d.pendingWrites || {});
  const samples = [];
  for (const [key, p] of pending) {
    const s = stamps.get(key);
    if (s?.created && Number.isFinite(p.c)) samples.push(sfMs(s.created) - p.c);
  }
  let offsetMs = 0;
  if (samples.length) {
    samples.sort((a, b) => a - b);
    offsetMs = samples[Math.floor(samples.length / 2)];
  } else {
    // Nothing was created since the last check (updates only): the smallest gap between an
    // update and what Salesforce recorded for it is the clocks' difference, as long as one
    // of those records was not touched again afterwards.
    const gaps = pending.map(([key, p]) => (stamps.get(key)?.modified ? sfMs(stamps.get(key).modified) - p.w : NaN)).filter(Number.isFinite);
    if (gaps.length) offsetMs = Math.min(...gaps);
  }
  for (const [key, p] of pending) if (stamps.has(key)) d.lastWrite[key] = new Date(p.w + offsetMs).toISOString();
  d.pendingWrites = Object.fromEntries(pending.filter(([key]) => !stamps.has(key)));

  const late = [];
  let baselined = 0;
  let checked = 0;
  for (const [key, s] of stamps) {
    if (!s.modified) continue;
    const modified = sfMs(s.modified);
    const iso = new Date(modified).toISOString();
    if (!d.lastWrite[key]) {
      d.lastWrite[key] = iso;
      baselined++;
      continue;
    }
    checked++;
    const lateBy = modified - Date.parse(d.lastWrite[key]);
    if (lateBy > toleranceMs) {
      late.push({ key, id: s.id, object: s.object, lateBySeconds: Math.round(lateBy / 1000), modified: iso, modstampLater: s.modstamp ? sfMs(s.modstamp) - modified > toleranceMs : false });
      d.lastWrite[key] = iso;
    }
  }
  await idmap.save();
  return { late, baselined, checked, offsetMs };
}
