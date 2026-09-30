// run.js — the seed's flow, from command line to final count. scripts/seed-demo-tenant.mjs
// hands it the real outside world; the tests hand it a fake one.
//
//   1. refuse the wrong tenant                      (never harmon, never the primary tenant)
//   2. describe the org LIVE, find the tenant, compare the org with the id-map
//      (an id-map that was LOST is rebuilt here — or the run refuses; recovery.js)
//   3. build the plan (pure) and check ALL of it against the org      -> any problem: stop
//   4. dry run: print the summary, write plan.json, stop
//   5. --apply: write phase by phase (canary first, id-map after every record)
//   6. verify every record carries the demo tenant, report records something else has
//      modified, print what to do next
//
// Every mode ends with either "Nothing was written" or an itemised count.

import { HELP, parseArgs } from "./args.js";
import {
  DEFAULT_TENANT_SLUG, HARMON_TENANT_ID, HARMON_TENANT_SLUG, SEEDED_OBJECTS, OBJ, PHASES, DEMO_USERS_SECRET, objectOfKey,
} from "./policy.js";
import { loadLiveSchema, schemaFromProbe } from "./schema.js";
import { IdMap } from "./idmap.js";
import { buildPlan, summarisePlan, DEFAULT_SEED } from "./plan.js";
import { preflightPlan, lintPlan, naturalKeyClashes } from "./preflight.js";
import { Writer, SeedError, reconcile, assertTenantStamp, auditModifications, describeSfError } from "./writer.js";
import { looksSeeded, restoreSteps, restoreAuthUsers } from "./recovery.js";
import { loadRunRecord, syncRunRecord } from "./run-record.js";
import { ensureAuthUsers, checkAuthCollisions, loadPasswords } from "./users.js";
import { runSupabasePhase, upsertProfiles, checkSupabaseColumns, cleanupStatements, TABLE_OF } from "./supabase-phase.js";
import { runFilesPhase } from "./files-phase.js";
import { collectFreshenState, planFreshen, boardDateOf } from "./freshen.js";
import { phxDateOf } from "./dates.js";
import { PERSONAS, TECH_KEYS } from "./catalog.js";
import { BUDGET_RATES } from "./budget-rates.js";
import { GATED_STAGE, SAFE_NEWLY_SOLD_CUSTOMER_STAGE } from "./plan-solar.js";

const SUPABASE_PHASES = ["users", "supabase", "files"];

/**
 * The incremental cache sync, as one PowerShell line. `--cli-read-timeout 0` matters: the
 * AWS CLI waits 60 seconds for a response by default and then RETRIES the call, so a sync
 * that takes longer would be started again while the first one is still running.
 */
export const CACHE_SYNC_COMMAND = 'aws lambda invoke --function-name sundial-cache-sync --region us-west-1 --cli-binary-format raw-in-base64-out --cli-read-timeout 0 --payload "{}" out-cache-sync.json';

const fileNames = (slug) => (slug === DEFAULT_TENANT_SLUG ? { idmap: "id-map.json", plan: "plan.json" } : { idmap: `id-map.${slug}.json`, plan: `plan.${slug}.json` });

function newCounters() {
  return { created: {}, updated: {}, skipped: {}, supabase: {}, authCreated: 0, authReused: 0, secret: null, secretRun: null, s3: 0, local: [] };
}

/** "Nothing was written" or the itemised count — the last thing every mode prints. */
function printTally(log, c) {
  const sum = (o) => Object.values(o).reduce((s, n) => s + n, 0);
  const wroteRemote = sum(c.created) + sum(c.updated) + sum(c.supabase) + c.authCreated + c.authReused + c.s3 > 0 || !!c.secret || !!c.secretRun;
  log("");
  if (!wroteRemote) {
    log(`Nothing was written to Salesforce, Supabase, Secrets Manager or S3.${c.local.length ? ` (Local file only: ${c.local.join(", ")}.)` : ""}`);
    return;
  }
  log("WRITTEN IN THIS RUN");
  for (const sfObject of SEEDED_OBJECTS) {
    const made = c.created[sfObject] || 0;
    const upd = c.updated[sfObject] || 0;
    const skip = c.skipped[sfObject] || 0;
    if (made || upd || skip) log(`  Salesforce ${sfObject.padEnd(30)} created ${String(made).padStart(4)}   updated ${String(upd).padStart(4)}   already done ${String(skip).padStart(4)}`);
  }
  if (c.authCreated || c.authReused) log(`  Supabase logins                          created ${String(c.authCreated).padStart(4)}   reused  ${String(c.authReused).padStart(4)}`);
  for (const [table, n] of Object.entries(c.supabase)) log(`  Supabase ${table.padEnd(32)} rows    ${String(n).padStart(4)}`);
  if (c.secret || c.secretRun) log(`  Secrets Manager ${DEMO_USERS_SECRET}: ${[c.secret ? `passwords ${c.secret}` : null, c.secretRun].filter(Boolean).join("; ")}`);
  if (c.s3) log(`  S3 objects uploaded: ${c.s3}`);
  if (c.local.length) log(`  Local files: ${c.local.join(", ")}`);
}

function printSummary(log, plan, pre) {
  const s = summarisePlan({ ...plan, ops: pre.ops });
  log("");
  log("PLAN — records per object");
  for (const sfObject of SEEDED_OBJECTS) if (s.perObject[sfObject]) log(`  ${sfObject.padEnd(30)} ${String(s.perObject[sfObject]).padStart(4)}`);
  log(`  follow-up updates               ${String(s.updates).padStart(4)}`);
  for (const [part, n] of Object.entries(s.supabase)) log(`  Supabase ${TABLE_OF[part].padEnd(26)} ${String(n).padStart(4)}`);
  log(`  sample PDFs (--with-files)       ${String(s.files).padStart(4)}`);
  const labels = { [OBJ.customer]: "Customers by status / stage", [OBJ.solar]: "Solar projects by stage", [OBJ.roofing]: "Roofing jobs by stage", [OBJ.estimate]: "Estimates by status", [OBJ.job]: "Service jobs by status", [OBJ.call]: "Service calls by status", [OBJ.invoice]: "Invoices by status" };
  for (const [sfObject, label] of Object.entries(labels)) {
    const b = s.breakdown[sfObject];
    if (!b) continue;
    log("");
    log(label);
    for (const [k, n] of Object.entries(b)) log(`  ${String(n).padStart(4)}  ${k}`);
  }
  const unknown = plan.solarStageMap.filter((x) => !x.known);
  log("");
  const covered = plan.solarStageMap.filter((x) => x.count).length;
  log(`Solar pipeline: ${covered} of ${plan.solarStageMap.length} live stages covered${unknown.length ? `, ${unknown.length} not known to this script (filled as freshly sold): ${unknown.map((x) => x.stage).join(", ")}` : ""}.`);
  const gated = plan.meta.soldPendingReview;
  if (gated && !gated.used) {
    log(`  Not covered on purpose: "${gated.stage}". Harmon's Salesforce alerts and Flows are built around that stage, and`);
    log(`  this script cannot see whether they are limited to Harmon's tenant. So ${gated.solarKey} sits in the next stage,`);
    log(`  "${gated.movedTo}", and its customer ${gated.customerKey} in "${SAFE_NEWLY_SOLD_CUSTOMER_STAGE}". Pass --with-sold-pending-review to use`);
    log(`  the real stage on both (read the docs first: confirm your Flows and email alerts only act on Harmon records).`);
  } else if (gated?.used) {
    log(`  "${gated.stage}" IS used (--with-sold-pending-review): on customer ${gated.customerKey} and on project ${gated.solarKey}.`);
  }

  log(`Roofing pipeline: ${plan.roofingStageMap.map((x) => `${x.stage} (${x.count})`).join(", ") || "no live stages"}.`);
  log(`Canary read-backs: ${s.canaries.total} records are read back in full — the first of each object, and the first in every stage on customers (${s.canaries.customer}) and solar projects (${s.canaries.solar}).`);
  log("");
  log(`Anchor date ${plan.meta.anchorDate} (America/Phoenix); today's dispatch picture is drawn for ${plan.meta.demoNow}; seed ${plan.meta.seed}.`);
  log("Live-demo customers" + (plan.meta.options.demoPhone || plan.meta.options.demoEmail ? " (carry YOUR phone / email):" : " (fake contact details — pass --demo-phone / --demo-email to use your own):"));
  for (const d of plan.meta.liveDemo) log(`  ${d.key}  ${d.name} — ${d.what}`);
}

function printList(log, title, items) {
  if (!items.length) return;
  log("");
  log(title);
  for (const i of items) log(`  - ${i}`);
}

/** What to do once the records are in. */
function printAfterSeed(log, { tenantId, tenantSlug, writer }) {
  log("");
  log("NEXT STEPS");
  log("  1. Pull the new records into the portal's list cache (the list pages read Supabase, not Salesforce).");
  log("     This is an INCREMENTAL sync of every cached object in one call — customers, solar, roofing, users and");
  log("     all the service objects. It only reads records changed since the last sync, so Harmon's 39k customers");
  log("     are not re-read:");
  log("");
  log(`       ${CACHE_SYNC_COMMAND}`);
  log("");
  log("     (--cli-read-timeout 0: the sync can run longer than the AWS CLI's 60-second wait, and a CLI that");
  log("     gives up waiting starts the sync a second time.)");
  log("     Run it soon: an object that has never been synced only looks back 24 hours. Tenants, dealers and");
  log("     tech days are not cached at all (the portal reads them live).");
  log("     If a Service > Jobs row shows a stale estimate status or total, re-sync jobs in full (about 2,300 rows):");
  log("");
  log(`       Set-Content -Encoding ascii payload-job.json '{"object":"job","mode":"full"}'`);
  log("       aws lambda invoke --function-name sundial-cache-sync --region us-west-1 --cli-binary-format raw-in-base64-out --cli-read-timeout 0 --payload file://payload-job.json out-cache-sync-job.json");
  log("");
  log(`  2. Demo tenant: ${tenantSlug}   Sundial_Tenant__c id: ${tenantId}`);
  log("  3. Demo logins (passwords: node scripts/seed-demo-tenant.mjs --show-passwords):");
  for (const p of PERSONAS) log(`       ${p.email.padEnd(52)} ${p.accessLevel.padEnd(13)} ${p.name} — ${p.title}`);
  log("  4. Budget: every demo Solar project carries invented input rates (labor $" + BUDGET_RATES.Blended_Labor_Rate__c + "/h, burden " + BUDGET_RATES.Labor_Burden_Rate__c + " %, …).");
  log("     Budget_Calc_Status__c is blank on purpose — press Recalculate on a project to see the budget.");
  if (writer?.defaulted?.size) {
    log("  5. Fields the ORG filled with its own default on the canary records (not written by this script —");
    log("     check they do not show a client's value):");
    for (const [sfObject, fields] of writer.defaulted) log(`       ${sfObject}: ${fields.join(", ")}`);
  }
  log("");
  log("CLEANUP (documented, NOT run): Supabase rows of the demo tenant —");
  for (const s of cleanupStatements(tenantId)) log(`  ${s}`);
  log("  Salesforce: the integration user cannot delete most Service objects. An admin deletes by");
  log(`  Client__c = '${tenantId}' (Data Loader), children first — see docs/demo-tenant-seed.md.`);
}

const flagOf = (k) => `--${k.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}`;
const id15 = (v) => String(v ?? "").slice(0, 15);

/**
 * The options of the first --apply stand — the plan must stay identical across runs. One
 * exception, because the docs' slow path starts with `--apply --phase tenant` and nobody
 * thinks of their phone number at that point: an option may still be given (or changed)
 * on a LATER run as long as the records it lands on have not been created yet.
 * @returns {{ options: object, changed: string[] }}
 */
function mergeOptions(storedOptions, given) {
  if (!storedOptions) return { options: given, changed: [] };
  const options = { ...storedOptions };
  const changed = [];
  for (const k of Object.keys(given)) {
    if (given[k] && given[k] !== storedOptions[k]) {
      options[k] = given[k];
      changed.push(k);
    }
  }
  return { options, changed };
}

/** For each changed option: is it still allowed (nothing it touches exists), or what to do by hand. */
function checkOptionChanges({ changed, storedOptions, plan, idmap }) {
  const errors = [];
  const notes = [];
  const live = plan.meta.liveDemo;
  const liveExists = live.some((d) => idmap.has(d.key));
  for (const k of changed) {
    const was = storedOptions[k] ? `"${storedOptions[k]}"` : "not set";
    if (k === "demoPhone" || k === "demoEmail") {
      if (!liveExists) { notes.push(`${flagOf(k)} accepted: the three live-demo customers have not been created yet (it was ${was} on the first --apply).`); continue; }
      const what = k === "demoPhone" ? "Primary Phone" : "Primary Email";
      errors.push(
        `${flagOf(k)} differs from the first --apply (${was}), and the live-demo customers already exist — the seed never rewrites a record. ` +
          `Change the ${what} by hand in the portal on these three customers: ` +
          live.map((d) => `${d.name} (${d.key}${idmap.idOf(d.key) ? `, ${idmap.idOf(d.key)}` : ", not created yet"})`).join("; ") +
          `. Then run again WITHOUT ${flagOf(k)}.`
      );
    } else if (k === "withSoldPendingReview") {
      const g = plan.meta.soldPendingReview;
      const made = g ? [g.customerKey, g.solarKey].filter((key) => idmap.has(key)) : [];
      if (!made.length) { notes.push(`${flagOf(k)} accepted: the customer and the project it applies to have not been created yet.`); continue; }
      errors.push(
        `${flagOf(k)} was not given on the first --apply, and ${made.map((key) => `${key} (${idmap.idOf(key)})`).join(" and ")} already exist${made.length === 1 ? "s" : ""} — the seed never rewrites a record. ` +
          `To show "${GATED_STAGE}", set the Stage by hand in the portal on those record(s). Then run again WITHOUT ${flagOf(k)}.`
      );
    }
  }
  return { errors, notes };
}

/** The final pass's second half: records something other than this script has modified. */
async function reportModifications(log, { idmap, stamps }) {
  const audit = await auditModifications({ idmap, stamps });
  log("");
  if (!audit.late.length) {
    log(`  no record was modified after this script's own last write to it (${audit.checked} compared${audit.baselined ? `, ${audit.baselined} seen for the first time` : ""}).`);
    return audit;
  }
  log(`  NOTE — ${audit.late.length} demo record(s) were modified by something OTHER than this script (more than 5 seconds after its own last write):`);
  for (const r of audit.late.slice(0, 25)) log(`    ${r.key.padEnd(34)} ${r.id}  modified ${r.modified}, ${r.lateBySeconds} s after${r.modstampLater ? " (and touched by the system later still)" : ""}`);
  if (audit.late.length > 25) log(`    … and ${audit.late.length - 25} more.`);
  log("  If you, or someone you were showing the portal to, edited these records, that is the explanation.");
  log("  If nobody did, a Flow, a trigger or another integration is reacting to demo records — find out which");
  log("  before the next demo. Nothing was stopped; each change is reported once.");
  return audit;
}

/**
 * @param {string[]} argv   process.argv.slice(2)
 * @param {object} io       see real-io.js
 * @returns {Promise<number>} the exit code
 */
export async function runSeed(argv, io) {
  const log = io.log;
  const args = parseArgs(argv);
  const counters = newCounters();
  const done = (code) => { printTally(log, counters); return code; };

  if (args.help) { log(HELP); return done(0); }
  if (args.problems.length) { printList(log, "The command line has a problem:", args.problems); log(HELP); return done(1); }

  // --- 1. the tenant guard -------------------------------------------------------------------
  const slug = args.tenant;
  const primary = String(io.env?.SUNDIAL_PRIMARY_TENANT || "").trim().toLowerCase();
  if (slug === HARMON_TENANT_SLUG || (primary && slug === primary)) {
    log(`REFUSED: "${slug}" is a real client's tenant. This script only ever seeds a demo tenant.`);
    return done(1);
  }

  if (args.showPasswords) {
    const p = await loadPasswords(io);
    if (!p) log(`No secret "${DEMO_USERS_SECRET}" yet — run with --apply first.`);
    else for (const persona of PERSONAS) log(`  ${persona.email.padEnd(52)} ${p[persona.email] ?? "(no password stored)"}`);
    return done(0);
  }

  const names = fileNames(slug);
  const store = { read: () => io.files.readJson(names.idmap), write: (obj) => io.files.writeJsonAtomic(names.idmap, obj) };
  let idmap;
  try {
    idmap = await IdMap.load(store, slug);
  } catch (e) {
    log(`REFUSED: ${e.message}`);
    return done(1);
  }
  idmap.persist = args.apply;

  log(args.apply ? "*** APPLY MODE — this WRITES ***" : "--- DRY RUN (pass --apply to write) ---");
  log(`tenant slug: ${slug}`);

  try {
    // --- 2. the org, live ---------------------------------------------------------------------
    let schema;
    if (args.offline) {
      const probe = await io.files.readJson("probe.json");
      if (!probe) throw new SeedError("--offline needs migration/demo/probe.json", "NO_PROBE");
      schema = schemaFromProbe(probe);
      log("schema: migration/demo/probe.json (OFFLINE — the live org was not contacted)");
    } else {
      schema = await loadLiveSchema(io.sf.describeObject, SEEDED_OBJECTS);
      log(`schema: ${SEEDED_OBJECTS.length} objects described live`);
    }

    const errors = [];
    const notes = [];
    const stored = idmap.data;
    let tenantId = idmap.idOf("tenant");
    /** Set while an id-map that was lost is being rebuilt from Salesforce (nothing is saved until it is whole). */
    let recovering = false;
    /** true when the tenant did not exist at the start of this run: a brand-new seed. */
    let tenantIsNew = false;
    /** Set when the tenant has been seeded before but this folder cannot know how: nothing at all may go on. */
    let cannotRebuild = false;
    if (!args.offline) {
      const rows = await io.sf.sfQuery(`SELECT Id, Name FROM ${OBJ.tenant} WHERE Name = '${slug}'`);
      const found = rows?.[0] ?? null;
      tenantIsNew = !found;
      if (found && id15(found.Id) === id15(HARMON_TENANT_ID)) throw new SeedError(`REFUSED: tenant "${slug}" resolves to Harmon's tenant record.`, "TENANT_GUARD");
      if (rows.length > 1) errors.push(`${rows.length} tenants are named "${slug}" — there must be exactly one.`);
      if (tenantId && (!found || id15(found.Id) !== id15(tenantId))) {
        errors.push(`The id-map says the demo tenant is ${tenantId}, but Salesforce ${found ? `has ${found.Id} under that name` : "has no tenant of that name"}. The id-map does not belong to this org's demo tenant.`);
      } else if (found && !tenantId) {
        tenantId = found.Id;
        idmap.data.ids.tenant = found.Id;
        if (stored.anchor) {
          // The first --apply created the tenant and stopped before it could be recorded.
          notes.push(`Tenant "${slug}" already exists (${found.Id}); using it.`);
        } else {
          // The tenant exists but this folder has NO id-map for it. Either it was made by
          // hand and never seeded, or the id-map was lost. The run record in the secret
          // (anchor, seed, options) is what tells the two apart — and what makes a rebuild possible.
          const record = await loadRunRecord(io, slug);
          if (record) {
            if (record.tenantId && id15(record.tenantId) !== id15(found.Id)) {
              cannotRebuild = true;
              errors.push(
                `There is no id-map, and the run record in Secrets Manager "${DEMO_USERS_SECRET}" is for a DIFFERENT tenant record (${record.tenantId}; Salesforce has ${found.Id} as "${slug}"). ` +
                  `The anchor date cannot be trusted, so nothing is written. If the earlier demo tenant was removed, delete that secret (docs/demo-tenant-seed.md, "Removing the demo tenant") and run again.`
              );
            } else {
              recovering = true;
              idmap.persist = false;
              stored.anchor = record.anchor;
              stored.seed = record.seed;
              stored.options = record.options ?? null;
              stored.freshen = (record.freshen || []).map((f) => ({ date: f.date, at: f.at, restored: true }));
              stored.recovered = { at: io.now().toISOString(), from: `${DEMO_USERS_SECRET} _run` };
              log(`id-map: NOT FOUND in migration/demo, but tenant "${slug}" exists (${found.Id}).`);
              log(`  Anchor ${record.anchor.date}, seed ${record.seed} and the options of the first --apply were restored from Secrets Manager "${DEMO_USERS_SECRET}".`);
              log("  The id-map is being rebuilt by matching the original plan against the tenant's records.");
            }
          } else {
            const before = await looksSeeded({ sf: io.sf, schema, tenantId: found.Id });
            if (before.seeded) {
              cannotRebuild = true;
              errors.push(
                `Tenant "${slug}" (${found.Id}) has been seeded before (${before.dealers} demo dealer(s), ${before.users} demo user(s), ${before.items} price-book item(s)), ` +
                  `but there is no id-map in migration/demo AND no run record in Secrets Manager "${DEMO_USERS_SECRET}". Without the original anchor date the plan cannot be rebuilt, ` +
                  `and seeding again would duplicate calls, payments and tech days that cannot be deleted. Nothing is written — not even with --allow-unaccounted. ` +
                  `Restore your copy of id-map.json, or have the demo tenant removed and seed it afresh (docs/demo-tenant-seed.md).`
              );
            } else {
              notes.push(`Tenant "${slug}" already exists (${found.Id}) and has never been seeded; using it.`);
            }
          }
        }
      }
      log(tenantId ? `tenant id: ${tenantId}` : `tenant "${slug}" does not exist yet — the first --apply creates it`);
    }

    // The tenant was seeded by a run this folder has no memory of, and the memory cannot be
    // restored. Stop here: not even the id-map is touched (adopting what little can be
    // recognised would leave a half id-map with a NEW anchor — the very thing that duplicates).
    if (cannotRebuild) {
      printList(log, "REFUSED — this folder cannot take over the demo tenant:", errors);
      return done(1);
    }

    // --- freshen is its own mode — but never before the tenant checks above have passed ---------
    if (args.freshen) {
      if (errors.length) {
        printList(log, `REFUSED — ${errors.length} problem(s). --freshen changes nothing until every one is resolved:`, errors);
        return done(1);
      }
      if (recovering) {
        log("");
        log("--freshen needs the id-map, and it is missing. Rebuild it first — this writes nothing new when the seed was complete:");
        log("  node scripts/seed-demo-tenant.mjs --apply");
        log("Then run --freshen again.");
        return done(1);
      }
      return done(await freshenMode({ args, io, idmap, schema, counters, log, slug }));
    }

    // --- 3. the plan, and every check on it ---------------------------------------------------------
    const given = { demoPhone: args.demoPhone, demoEmail: args.demoEmail, withSoldPendingReview: args.withSoldPendingReview };
    const storedOptions = stored.options;
    const { options, changed } = mergeOptions(storedOptions, given);
    if (stored.seed !== null && args.seed !== null && args.seed !== stored.seed) errors.push(`--seed ${args.seed} differs from the seed of the first --apply (${stored.seed}).`);
    const seed = stored.seed ?? args.seed ?? DEFAULT_SEED;
    const nowIso = new Date(Math.floor(io.now().getTime() / 60000) * 60000).toISOString();
    const anchor = stored.anchor ?? { date: phxDateOf(nowIso), now: nowIso };
    const firstApply = !stored.anchor;

    const plan = buildPlan({ schema, tenantSlug: slug, anchorDate: anchor.date, anchorNow: anchor.now, seed, options });
    const pre = preflightPlan(plan, schema);
    errors.push(...pre.errors);
    errors.push(...lintPlan(plan).map((p) => `safety: ${p}`));
    errors.push(...naturalKeyClashes(pre.ops).map((p) => `plan: ${p}`));

    const phases = args.phase ? [args.phase] : PHASES.filter((p) => p !== "files" || args.withFiles);

    let report = null;
    if (!args.offline && !(recovering && errors.length)) {
      // "Nothing is written until every problem is resolved" includes the id-map: a record
      // re-found by its natural key is only recorded by a run that is going ahead.
      idmap.persist = args.apply && !recovering && errors.length === 0;
      report = await reconcile({ sf: io.sf, schema, idmap, ops: pre.ops, tenantId, log, recovering });
      // A rebuild that leaves a planned record unfound NEXT TO an unrecognised one is refused,
      // and --allow-unaccounted does not change that: creating the planned record would very
      // likely make a second copy of a record that was only edited.
      for (const [sfObject, u] of Object.entries(report.unresolved)) {
        const shown = u.pairs.slice(0, 6).map((x) => `${x.key} (expected ${u.natural.map((f) => `${f} = ${JSON.stringify(x.want[f] ?? null).slice(0, 60)}`).join(", ")}) — unrecognised ${u.parentField ? `under the same ${u.parentField}` : "in this object"}: ${x.near.slice(0, 4).join(", ")}${x.near.length > 4 ? ", …" : ""}`);
        errors.push(
          `The id-map cannot be rebuilt for ${sfObject}: ${u.pairs.length} planned record(s) were not found, while record(s) the plan does not recognise sit beside them. ` +
            `One is probably the other after an edit, so the run stops rather than create a duplicate (--allow-unaccounted does not override this). ` +
            `Put the named field(s) back on the record, or restore your copy of id-map.json:\n      ${shown.join("\n      ")}${u.pairs.length > 6 ? `\n      … and ${u.pairs.length - 6} more` : ""}`
        );
      }
      const loose = Object.entries(report.unaccounted);
      if (loose.length) {
        const msg = `The tenant holds records the id-map does not account for: ${loose.map(([o, n]) => `${n} x ${o}`).join(", ")}.`;
        if (args.allowUnaccounted) notes.push(`${msg} Continuing because of --allow-unaccounted; they are left untouched.`);
        else errors.push(`${msg} Refusing to seed into it (use --allow-unaccounted if these are records you made while demoing).`);
      }
      if (recovering) {
        const steps = await restoreSteps({ sf: io.sf, idmap, ops: pre.ops });
        const logins = await restoreAuthUsers({ sf: io.sf, idmap });
        notes.push(`The id-map was missing and has been rebuilt from Salesforce: ${report.adopted.length} record(s) recognised, ${steps} follow-up update(s) found already made, ${logins} login(s) re-linked${stored.freshen.length ? `, last --freshen ${stored.freshen[stored.freshen.length - 1].date}` : ""}.`);
      }
      const opt = checkOptionChanges({ changed, storedOptions, plan, idmap });
      errors.push(...opt.errors);
      notes.push(...opt.notes);
      if (phases.some((p) => SUPABASE_PHASES.includes(p))) {
        try {
          const supabase = await io.getSupabase();
          const cols = await checkSupabaseColumns(supabase, plan);
          errors.push(...cols.errors);
          notes.push(...cols.notes);
          const auth = await checkAuthCollisions({ supabase, sfQuery: io.sf.sfQuery, tenantId });
          errors.push(...auth.blocked);
          if (auth.existing.length) notes.push(`${auth.existing.length} demo login(s) already exist in Supabase and will be reused.`);
        } catch (e) {
          errors.push(`Supabase could not be checked: ${String(e?.message || e).slice(0, 160)}`);
        }
      }
    }

    printSummary(log, plan, pre);
    printList(log, "Notes", [...notes, ...plan.warnings]);
    printList(log, "Optional fields left out (the org does not have them, or not with that value)", pre.warnings);
    printList(log, "Fields the ORG will fill with its own default (not written by the plan — check none shows a client's number)", pre.orgDefaults);
    if (report) {
      const accounted = Object.values(report.perObject).reduce((s, x) => s + x.mapped, 0);
      log("");
      log(`Already in Salesforce for this tenant and recorded in the id-map: ${accounted} record(s).`);
    }

    // The preview file. Written in every mode; it holds fictional data only, no passwords.
    await io.files.writeJsonAtomic(names.plan, { meta: plan.meta, summary: summarisePlan({ ...plan, ops: pre.ops }), warnings: [...plan.warnings, ...pre.warnings], ops: pre.ops, supabase: plan.supabase, files: plan.files });
    counters.local.push(`migration/demo/${names.plan}`);

    if (errors.length) {
      printList(log, `PREFLIGHT FAILED — ${errors.length} problem(s). Nothing is written until every one is resolved:`, errors);
      if (recovering) log("\nThe id-map was NOT rebuilt (nothing was saved); the next run starts the rebuild again.");
      return done(1);
    }
    log("");
    log("Preflight passed: every planned field exists and is writable, every picklist value is live, every lookup points at the right object.");
    if (!args.apply) {
      if (recovering) log("Dry run: the rebuilt id-map was not saved. Run with --apply to save it (nothing new is written to Salesforce when the seed was complete).");
      return done(0);
    }

    // --- 5. write --------------------------------------------------------------------------------------
    // First the run's own memory: the rebuilt id-map, the anchor / seed / options — on this PC
    // and in the secret — BEFORE the first record goes to Salesforce.
    idmap.persist = true;
    if (firstApply) {
      stored.anchor = anchor;
      stored.seed = seed;
    }
    stored.options = options;
    await idmap.save();
    counters.local.push(`migration/demo/${names.idmap}`);
    const record = () => syncRunRecord({ io, slug, idmap, counters, log, replaceStale: firstApply && tenantIsNew });
    await record();

    const writer = new Writer({ sf: io.sf, idmap, schema, ops: pre.ops, log, counters, acceptCanary: new Set(args.acceptCanary), now: io.now, adopted: new Set(report?.adoptedKeys || []), recovering });
    for (const phase of phases) {
      log("");
      log(`=== phase: ${phase} ===`);
      if (phase === "users") await ensureAuthUsers({ io, idmap, tenantSlug: slug, log, counters });
      if (phase === "supabase") { await runSupabasePhase({ io, plan, writer, log, counters }); continue; }
      if (phase === "files") { await runFilesPhase({ io, plan, writer, idmap, log, counters }); continue; }
      const n = await writer.runPhase(phase);
      log(`  ${n} operation(s) in this phase`);
      // The tenant's id is part of the run record: it is what ties the record to this tenant.
      if (phase === "tenant") await record();
      if (phase === "users") await upsertProfiles({ io, plan, writer, log, counters });
    }

    // --- 6. verify --------------------------------------------------------------------------------------
    log("");
    log("=== final check: every record carries the demo tenant ===");
    const check = await assertTenantStamp({ sf: io.sf, schema, idmap, ops: pre.ops, tenantId: idmap.idOf("tenant") });
    for (const [sfObject, n] of Object.entries(check.counts)) log(`  ${sfObject.padEnd(30)} ${String(n).padStart(4)} verified`);
    if (check.problems.length) {
      printList(log, "TENANT CHECK FAILED:", check.problems);
      return done(1);
    }
    log("  all records verified.");
    await reportModifications(log, { idmap, stamps: check.stamps });
    printAfterSeed(log, { tenantId: idmap.idOf("tenant"), tenantSlug: slug, writer });
    return done(0);
  } catch (e) {
    log("");
    if (e instanceof SeedError) log(`STOPPED: ${e.message}`);
    // Anything unexpected: the message only — a Salesforce error body can carry record data.
    else log(`STOPPED: ${e?.sfStatus ? describeSfError(e) : e?.message || String(e)}`);
    if (args.apply) {
      if (idmap.saveFailed) {
        log("The id-map could NOT be saved, so it is BEHIND what was written: the last record this run wrote is in Salesforce but not in the file.");
        log("Close whatever holds migration/demo open (an editor, a sync or backup tool), then run the same command again — the record is re-found by its natural key, not created twice.");
      } else {
        log("The id-map is up to date with everything that was written. Fix the cause and run the same command again — it continues where it stopped.");
      }
    }
    return done(1);
  }
}

/** `--freshen` (dry run unless --apply). */
async function freshenMode({ args, io, idmap, schema, counters, log, slug }) {
  const tenantId = idmap.idOf("tenant");
  const boardDate = boardDateOf(idmap.data);
  if (!tenantId || !boardDate) {
    log("There is nothing to freshen: the demo tenant has not been seeded from this folder (no id-map).");
    return 1;
  }
  if (args.offline) { log("--freshen needs the live org."); return 1; }
  const nowIso = new Date(Math.floor(io.now().getTime() / 60000) * 60000).toISOString();
  const newDate = phxDateOf(nowIso);
  log("");
  log(`FRESHEN — the board is anchored to ${boardDate}; today is ${newDate} (America/Phoenix).`);
  const state = await collectFreshenState({ sf: io.sf, idmap });
  // Tech-day rows that already exist for the days in question (ours or made in a demo) are never duplicated.
  const techIds = new Map(TECH_KEYS.map((k) => [idmap.idOf(k), k]));
  const dayRows = await io.sf.sfQuery(`SELECT Id, Tech__c, Work_Date__c FROM ${OBJ.day} WHERE Client__c = '${tenantId}'`);
  const existingDayKeys = new Set(dayRows.filter((r) => techIds.has(r.Tech__c)).map((r) => `${techIds.get(r.Tech__c)}|${r.Work_Date__c}`));
  const fresh = planFreshen(state, { boardDate, newDate, nowIso, seed: idmap.data.seed, existingDayKeys });
  for (const n of fresh.notes) log(`  note: ${n}`);
  if (!fresh.ops.length) return 0;

  const knownKeys = Object.keys(idmap.ids).map((k) => [k, objectOfKey(k, idmap.data.objects)]).filter(([, o]) => o);
  const pre = preflightPlan({ ops: fresh.ops }, schema, { knownKeys });
  const s = fresh.summary;
  log(`  open calls moved into ${newDate} … +7 days: ${s.moved}${s.reassigned ? ` (${s.reassigned} to another tech)` : ""}`);
  log(`  calls promoted for today's picture:          ${s.promoted}`);
  log(`  Complete calls added (with clock data):      ${s.addedCalls}`);
  log(`  tech days added / closed:                    ${s.addedDays} / ${s.closedDays}`);
  log(`  jobs moved Scheduled -> In Progress:         ${s.jobsStarted}`);
  if (pre.warnings.length) printList(log, "Optional fields left out", pre.warnings);
  if (pre.errors.length) {
    printList(log, `FRESHEN PREFLIGHT FAILED — ${pre.errors.length} problem(s):`, pre.errors);
    return 1;
  }
  if (!args.apply) {
    log("");
    log("Dry run: pass --freshen --apply to make these changes.");
    return 0;
  }
  // The run record in the secret must agree with this id-map before anything is changed.
  await syncRunRecord({ io, slug, idmap, counters, log });
  const writer = new Writer({ sf: io.sf, idmap, schema, ops: pre.ops, log, counters, now: io.now });
  await writer.runPhase("freshen");
  idmap.data.freshen.push({ date: newDate, at: nowIso, ...s });
  await idmap.save();
  counters.local.push("migration/demo/id-map.json");
  // The board's new date is part of what a lost id-map must be rebuilt from.
  await syncRunRecord({ io, slug, idmap, counters, log });
  const check = await assertTenantStamp({ sf: io.sf, schema, idmap, ops: pre.ops, tenantId });
  if (check.problems.length) { printList(log, "TENANT CHECK FAILED:", check.problems); return 1; }
  await reportModifications(log, { idmap, stamps: check.stamps });
  log("");
  log("Done. The dispatch board and the tech app read Salesforce live. For the list pages, run the incremental cache sync:");
  log(`  ${CACHE_SYNC_COMMAND}`);
  return 0;
}
