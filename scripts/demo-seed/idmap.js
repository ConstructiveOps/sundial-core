// idmap.js — the run's memory: which planned record became which Salesforce Id.
//
// WHY IT MATTERS: most of what this script creates cannot be deleted by the integration
// user, so a second run must never create a record twice. Every planned record has a
// stable key ("customer:017", "job:031", "call:031-2"); the moment Salesforce returns an
// Id, the pair is saved to migration/demo/id-map.json — before the next record is
// attempted. A run that dies half-way picks up exactly where it stopped.
//
// The file is written ATOMICALLY (a temp file, then a rename), so a crash in the middle
// of a save cannot leave a half-written map behind.
//
// It also remembers the run's ANCHOR (the date every other date hangs off) and the random
// SEED from the first --apply, so later runs rebuild the identical plan. A second copy of
// those (and of the options and the --freshen dates) is kept in Secrets Manager
// (run-record.js), because this file lives on one PC only.

export const IDMAP_VERSION = 1;

export function emptyIdMap(tenantSlug) {
  return {
    version: IDMAP_VERSION,
    tenantSlug,
    anchor: null, // { date, now } — set by the first --apply
    seed: null,
    options: null, // { demoPhone, demoEmail, withSoldPendingReview } of the first --apply
    ids: {}, // key -> Salesforce Id
    objects: {}, // key -> sfObject, for records added by --freshen (they are not in the plan)
    steps: {}, // follow-up update key -> true
    canary: {}, // sfObject -> "passed" | "failed" — the canary on the FIRST record of the object
    canaryStages: {}, // sfObject -> { "stage: Sold": "passed", … } — the canary per stage (canary.js canaryTags)
    canaryOpen: {}, // sfObject -> { key, tags, state: "pending" | "failed", fields? } — a canary not settled yet
    canaryAccepted: {}, // sfObject -> [field, …] differences the owner accepted with --accept-canary
    supabase: { authUsers: {}, done: {} }, // persona key -> auth uuid
    files: {}, // file key -> s3 key
    freshen: [], // history of --freshen runs
    lastWrite: {}, // key -> when THIS SCRIPT last wrote the record, on Salesforce's clock (writer.js auditModifications)
    pendingWrites: {}, // key -> { c?: ms, w: ms } — this PC's clock, until the final check converts it
    recovered: null, // { at, from } when this file was rebuilt from Salesforce after it was lost
  };
}

export class IdMap {
  /**
   * @param {{ read:()=>Promise<object|null>, write:(obj)=>Promise<void> }} store
   * @param {object} data
   */
  constructor(store, data) {
    this.store = store;
    this.data = data;
    this.dirty = false;
    /** false in a dry run: nothing is ever saved. */
    this.persist = true;
    /** Set when a save failed: the file on disk is then BEHIND what was written to Salesforce. */
    this.saveFailed = null;
  }
  static async load(store, tenantSlug) {
    const found = await store.read();
    if (found) {
      if (found.version !== IDMAP_VERSION) throw new Error(`id-map version ${found.version} is not one this script understands (${IDMAP_VERSION}).`);
      if (found.tenantSlug !== tenantSlug) throw new Error(`id-map belongs to tenant "${found.tenantSlug}", not "${tenantSlug}". Refusing to mix them.`);
      const base = emptyIdMap(tenantSlug);
      return new IdMap(store, { ...base, ...found, supabase: { ...base.supabase, ...(found.supabase || {}) } });
    }
    return new IdMap(store, emptyIdMap(tenantSlug));
  }
  get ids() { return this.data.ids; }
  get steps() { return this.data.steps; }
  idOf(key) { return this.data.ids[key] ?? null; }
  has(key) { return this.data.ids[key] != null; }
  /** Every Salesforce Id this run owns — the only ids an UPDATE may ever target. */
  ownedIds() { return new Set(Object.values(this.data.ids)); }
  async save() {
    if (!this.persist) return;
    try {
      await this.store.write(this.data);
      this.saveFailed = null;
    } catch (e) {
      this.saveFailed = e;
      const err = new Error(`the id-map could not be saved (${e?.code || e?.message || "write failed"})`);
      err.code = "IDMAP_SAVE_FAILED";
      err.cause = e;
      throw err;
    }
  }
  /** Remember when this script wrote a record (this PC's clock; see auditModifications). */
  noteWrite(key, atMs, created = false) {
    if (!Number.isFinite(atMs)) return;
    const p = this.data.pendingWrites[key] ?? {};
    if (created) p.c = atMs;
    p.w = atMs;
    this.data.pendingWrites[key] = p;
  }
  async setId(key, id, atMs = null) {
    this.data.ids[key] = id;
    if (atMs !== null) this.noteWrite(key, atMs, true);
    await this.save();
  }
  async dropId(key) {
    delete this.data.ids[key];
    delete this.data.lastWrite[key];
    delete this.data.pendingWrites[key];
    for (const step of Object.keys(this.data.steps)) if (step.startsWith(`${key}#`)) delete this.data.steps[step];
    await this.save();
  }
  async setStep(key, target = null, atMs = null) {
    this.data.steps[key] = true;
    if (target && atMs !== null) this.noteWrite(target, atMs, false);
    await this.save();
  }
  /** "first" is the first record of the object; every other tag is one stage / status (canary.js). */
  canaryState(sfObject, tag) {
    return tag === "first" ? this.data.canary[sfObject] ?? null : this.data.canaryStages[sfObject]?.[tag] ?? null;
  }
  markCanary(sfObject, tags, state) {
    for (const tag of tags) {
      if (tag === "first") this.data.canary[sfObject] = state;
      else (this.data.canaryStages[sfObject] ??= {})[tag] = state;
    }
  }
}
