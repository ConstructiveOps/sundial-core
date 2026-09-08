// Acumatica Project ATTRIBUTE sync (Stage E).
//
// Attributes are the Acumatica-side summary of a job: five lifecycle dates, the job
// type, the system size, who sold it, and the six commission milestone amounts. Harmon's
// reporting reads them, so they are how a job looks from the accounting side.
//
// Enumerated live from project R251282 (§7 of the rework doc) — this is not a guess at
// what exists, it is a list of what does.
//
// ---------------------------------------------------------------------------
// SALESPERSO — resolved 2026-08-22 (Q10, the last open item here)
// ---------------------------------------------------------------------------
// Source is `Sales_Company_Harmon_Solar_or_Third__c`, the same field D19 uses as the
// deal-type discriminator. Confirmed against the live example: R251282's SALESPERSO
// reads "Familia Sicairos", which is a value of that picklist.
//
// Worth being clear about what the attribute therefore means, because the AttributeID
// says "Sales Person": for a dealer deal it carries the DEALER COMPANY, not an
// individual's name, and for an internal deal it carries the literal "Harmon Solar"
// rather than the Harmon rep who sold it. That matches the live data and Harmon's
// reporting; it is not a placeholder waiting for a better field.
//
// ---------------------------------------------------------------------------
// THE COMMISSION SPLITS ARE NOT ALL THE SAME SPLIT
// ---------------------------------------------------------------------------
// Three pairs of milestone attributes, and the rep pair follows a DIFFERENT rule from
// the other two:
//
//   SLSCOM1/2  rep        third-party: min(50%, $2,500) then the balance   (§6)
//                         internal:    75 / 25                             (D16)
//   MGRCOM1/2  manager    75 / 25 of the .04 component
//   MGMTOR1/2  overhead   75 / 25 of the .015 component
//
// An internal deal raises NO purchase order (D16) but STILL gets SLSCOM1/2 — the money
// is paid through payroll and the attributes still have to show it. Filling them from
// the third-party milestone rule would understate the first payment on every internal
// job whose commission exceeds $5,000, which under D19's redline model is most of them.

import { PROJECT_MANAGER_FIELD } from "./acumatica-project-manager.js";

/** 75/25 is the split for manager, overhead, and the internal rep commission. */
export const M1_SHARE = 0.75;

/** Third-party rep milestone rule (§6). Kept in step with the PO engine's constants. */
export const REP_M1_RATE = 0.5;
export const REP_M1_CAP = 2500;

function numOf(v) {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}
function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * Split a total into M1/M2 at 75/25, with M2 as the remainder.
 *
 * Same reasoning as the PO engine: round the first part, subtract for the second, so the
 * two always sum to the total. Rounding both independently loses a cent on odd amounts,
 * and a cent that appears in a report and not in a payment is somebody's afternoon.
 */
export function split7525(total) {
  const t = round2(numOf(total));
  if (t <= 0) return { m1: 0, m2: 0 };
  const m1 = round2(t * M1_SHARE);
  return { m1, m2: round2(t - m1) };
}

/** Third-party rep split: capped half, then the balance (§6). */
export function splitRepThirdParty(total) {
  const t = round2(numOf(total));
  if (t <= 0) return { m1: 0, m2: 0 };
  const m1 = Math.min(round2(t * REP_M1_RATE), REP_M1_CAP);
  return { m1: round2(m1), m2: round2(t - m1) };
}

/**
 * Decimal places per attribute — Harmon's existing convention, not ours (Q17).
 *
 * Attributes are STRING-valued and Acumatica stores exactly what it is given, so
 * `String(2500)` really does land in the reporting field as `2500` next to a
 * hand-entered `1538.00`. That is a formatting difference, not a rounding one, and the
 * live data is unambiguous about which format Harmon uses: every money attribute already
 * in Acumatica carries two decimals (`1538.00`, `250.80`, `94.05`) and KW carries three
 * (`8.360`). Verified on R261065, 2026-08-24; Harmon ruled the same day that we match it.
 *
 * Anything absent from this map is not a number — dates, JOBTYPE, SALESPERSO — and is
 * passed through untouched.
 */
export const ATTRIBUTE_DECIMALS = Object.freeze({
  SLSCOM1: 2, SLSCOM2: 2,
  MGRCOM1: 2, MGRCOM2: 2,
  MGMTOR1: 2, MGMTOR2: 2,
  KW: 3,
});

/**
 * Format a value for an Acumatica attribute, which is always a STRING.
 *
 * Dates pass through as the ISO date Salesforce already returns (`2026-07-14`) rather
 * than being reformatted. Two reasons: reformatting is where timezones get introduced
 * into a value that has none, and the accepted format is exactly the sort of thing the
 * hand-proof runbook is for. **The 2026-08-24 hand-proof confirmed Acumatica accepts it
 * as sent**, so this stays.
 *
 * `decimals` pads a numeric value to a fixed width (see ATTRIBUTE_DECIMALS). It is only
 * applied to something that actually parses as a number — a text attribute that somehow
 * arrived with a decimals rule set would be passed through rather than turned into `NaN`.
 *
 * @param {unknown} v
 * @param {number} [decimals] - fixed decimal places, for numeric attributes only
 */
export function formatAttributeValue(v, decimals) {
  if (v === null || v === undefined || v === "") return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);

  if (Number.isInteger(decimals)) {
    const n = typeof v === "number" ? v : Number(String(v).trim());
    if (Number.isFinite(n)) return n.toFixed(decimals);
    // Fall through: not a number, so padding is meaningless and NaN would be worse.
  }

  if (typeof v === "number") return String(v);
  const s = String(v);
  // Salesforce DateTime -> date only. Attributes here are all calendar dates; keeping
  // the time would put a meaningless 00:00:00Z in a reporting field.
  const m = /^(\d{4}-\d{2}-\d{2})T/.exec(s);
  return m ? m[1] : s;
}

/**
 * The five lifecycle dates (§7, Q10 resolved). Every source field verified present on
 * Sundial_Solar__c by live describe, 2026-08-22.
 */
export const DATE_ATTRIBUTES = Object.freeze([
  { attributeId: "AUDITDATE", field: "Audit_Date_and_DateTime__c", label: "Audit Date" },
  { attributeId: "INDESIGN", field: "Approved_for_Design_Date__c", label: "In Design Date" },
  { attributeId: "INCOMDATE", field: "Scheduled_Install_Date__c", label: "Install Complete Date" },
  { attributeId: "GREENTAG", field: "Inspection_Pass_Date__c", label: "Green Tag Date" },
  { attributeId: "COMDATE", field: "Commission_of_System__c", label: "Commissioning Date" },
]);

/**
 * The attributes the ATTRIBUTE-ONLY path may write: the five lifecycle dates, the system
 * size, and who sold it. Deliberately everything that is a FACT ABOUT THE JOB and nothing
 * that is a fact about a budget.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS EXCLUDED, AND WHY IT MATTERS MORE THAN WHAT IS INCLUDED
 * ---------------------------------------------------------------------------
 * SLSCOM1/2, MGRCOM1/2 and MGMTOR1/2 are absent on purpose. Legacy and non-budgeted
 * projects carry commission attributes Harmon entered BY HAND — R261065's
 * `SLSCOM1 = 1538.00` / `SLSCOM2 = 2138.00` match neither the third-party rule nor the
 * 75/25 one, which is what hand-entry looks like. Those values are only safe to overwrite
 * on a job the integration actually calculates, which is why the push worker owns them and
 * this path does not.
 *
 * Two mechanics make that exclusion airtight rather than merely intended:
 *   - the PUT MERGES (D24), so an attribute we do not send is not touched; and
 *   - blanks are omitted rather than sent as "", so a field we have no value for cannot
 *     blank one that has a value.
 * Both were proved by hand, and together they mean this path is incapable of disturbing a
 * hand-entered commission figure even on a record where every other field is empty.
 *
 * ~~JOBTYPE is excluded for a different reason: RS vs RSDC is authoritative at Layer-1
 * project creation, and neither this path nor the push worker can do better than infer
 * it. Saying nothing lets the merge preserve what created the project.~~
 *
 * ⚠️ **THAT REASONING IS DEAD — superseded 2026-09-08 by the owner's ruling (D31 /
 * ADR D-067).** It rested on JOBTYPE tracking RS vs RSDC, so that anything downstream of
 * creation would be guessing. It does not: JOBTYPE is a Combo attribute whose allowed
 * ValueIDs are `CE CS EV RE RS SE`. **There is no RSDC job type**, and all 35 live
 * RSDC-template projects carry `RS`. The template records the domestic-content election;
 * the attribute records what kind of job it is, and for every job either Lambda touches
 * that is the constant `RS` (see JOBTYPE_VALUE). Nothing is inferred, so there is nothing
 * for inference-is-not-authority to object to, and **the push worker's Stage E now writes
 * it on every budget push.**
 *
 * JOBTYPE stays out of THIS list anyway, for the reason the list exists: scope. The
 * attribute-only path serves legacy and hand-budgeted projects, and its whole claim to
 * safety is that it writes only what it was asked to. Adding a field to it because the
 * field happens to be safe is how that claim erodes. If Harmon wants legacy projects
 * back-filled with JOBTYPE, that is a decision to take deliberately, not a side effect of
 * this one.
 */
export const NON_COMMISSION_ATTRIBUTES = Object.freeze([
  ...DATE_ATTRIBUTES.map((a) => a.attributeId),
  "KW",
  "SALESPERSO",
]);

/**
 * JOBTYPE — a CONSTANT for every job Sundial touches, and the value is the CODE.
 *
 * ⚠️ NOT THE LABEL. JOBTYPE is a Combo attribute: it stores a `ValueID` and the UI shows
 * a description. Read live 2026-09-08, the allowed ValueIDs are `CE`, `CS`, `EV`, `RE`,
 * `RS`, `SE`, and sampled projects carry `Value: "RS"` beside `ValueDescription:
 * "Residential - Solar"`. Writing the human phrase — "Residential Solar", or even the
 * exact label "Residential - Solar" — would be accepted with a 200 and thrown away, which
 * is what Acumatica does with a value it does not recognise (the standing hazard on
 * verifyAttributeWrite, proved 2026-08-24 with `NOTAREALATTR`).
 *
 * ONE definition, imported by both writers. A second string literal in the other Lambda
 * would be a second thing to keep right, and the way it goes wrong is silent.
 */
export const JOBTYPE_ATTRIBUTE_ID = "JOBTYPE";
export const JOBTYPE_VALUE = "RS";

/** Every Salesforce field the attribute-only path reads. A strict subset of the below. */
export function nonCommissionFieldNames() {
  return [
    ...DATE_ATTRIBUTES.map((a) => a.field),
    "System_Size__c",
    "Sales_Company_Harmon_Solar_or_Third__c",
  ];
}

/** Every Salesforce field this module reads, so a caller can SELECT exactly these. */
export function attributeFieldNames() {
  return [
    ...DATE_ATTRIBUTES.map((a) => a.field),
    "System_Size__c",
    "Sales_Company_Harmon_Solar_or_Third__c",
    "Commission_Deal_Type__c",
    "Sales_Rep_Commission_Amt__c",
    "Internal_Rep_Commission_Amt__c",
    "Sales_Mgr_Commission_Amt__c",
    "Overhead_Commission_Amt__c",
    // Not an attribute — it goes to ProjectProperties.ProjectManager — but it is read on
    // the same pass by the same stage, and this is the list the worker's SELECT is built
    // from. Listing it here is what stops the refresh arriving as `undefined`, which
    // would read as "no manager assigned" and be indistinguishable from the real thing.
    PROJECT_MANAGER_FIELD,
  ];
}

/**
 * Build the attribute set for a job.
 *
 * BLANK VALUES ARE OMITTED, NOT SENT AS "". A date that has not happened yet is not the
 * same as a date that was cleared, and writing "" to every unreached milestone would
 * make the sync capable of erasing a value someone entered in Acumatica by hand. The
 * sync only ever moves information in the direction it has some.
 *
 * `opts.only` restricts the output to a named set of AttributeIDs — see
 * NON_COMMISSION_ATTRIBUTES. It filters at the point of emission rather than the caller
 * filtering afterwards, so a caller cannot accidentally send a commission attribute by
 * forgetting the filter: the restriction travels with the build.
 *
 * @param {object} values - Sundial_Solar__c field values
 * @param {{jobType?: string, only?: ReadonlyArray<string>}} [opts] - RS / RSDC, known at Layer-1 push time
 * @returns {{attributes: Array<{AttributeID: string, Value: string}>, omitted: string[], dealType: string}}
 */
export function buildProjectAttributes(values, opts = {}) {
  const out = [];
  const omitted = [];
  const allow = opts.only ? new Set(opts.only) : null;
  const push = (attributeId, raw) => {
    // Out of scope is not the same as omitted-because-blank: an attribute this path does
    // not own is not reported as missing data.
    if (allow && !allow.has(attributeId)) return;
    const v = formatAttributeValue(raw, ATTRIBUTE_DECIMALS[attributeId]);
    if (v === "") omitted.push(attributeId);
    else out.push({ AttributeID: attributeId, Value: v });
  };
  // Same scope rule for the branches that record an omission without going through
  // push() — an attribute this path does not own is out of scope, not missing.
  const skip = (...ids) => {
    for (const id of ids) if (!allow || allow.has(id)) omitted.push(id);
  };

  for (const a of DATE_ATTRIBUTES) push(a.attributeId, values?.[a.field]);

  if (opts.jobType) push("JOBTYPE", opts.jobType);
  else skip("JOBTYPE");

  push("KW", values?.System_Size__c);
  push("SALESPERSO", values?.Sales_Company_Harmon_Solar_or_Third__c);

  // --- the six commission milestone attributes ---
  const dealType = String(values?.Commission_Deal_Type__c ?? "").trim();
  const isInternal = dealType === "Internal";

  // The rep pair, and the one place the two rules diverge.
  const repTotal = isInternal
    ? numOf(values?.Internal_Rep_Commission_Amt__c)
    : numOf(values?.Sales_Rep_Commission_Amt__c);
  const rep = isInternal ? split7525(repTotal) : splitRepThirdParty(repTotal);
  if (repTotal > 0) {
    push("SLSCOM1", rep.m1);
    push("SLSCOM2", rep.m2);
  } else {
    skip("SLSCOM1", "SLSCOM2");
  }

  // Manager and overhead are 75/25 regardless of deal type. They are kept as SEPARATE
  // components on the record precisely so this split is possible — the budget's SLMC
  // line sums them (D10), and summing them here too would lose the distinction that
  // MGRCOM and MGMTOR are different attributes.
  for (const [field, a1, a2] of [
    ["Sales_Mgr_Commission_Amt__c", "MGRCOM1", "MGRCOM2"],
    ["Overhead_Commission_Amt__c", "MGMTOR1", "MGMTOR2"],
  ]) {
    const total = numOf(values?.[field]);
    if (total > 0) {
      const s = split7525(total);
      push(a1, s.m1);
      push(a2, s.m2);
    } else {
      skip(a1, a2);
    }
  }

  return { attributes: out, omitted, dealType: dealType || null };
}

// ===========================================================================
// Verify by re-read — required, not optional (D24)
// ===========================================================================

/**
 * ⚠️ THE STANDING HAZARD THIS EXISTS FOR: an unknown `AttributeID` gets a **200 and is
 * silently discarded.**
 *
 * Proved on 2026-08-24 — `NOTAREALATTR` was accepted and never appeared. Nothing in the
 * response distinguishes "written" from "thrown away", so if a template change ever drops
 * an attribute, the sync keeps sending it, keeps getting 200, and that value silently
 * stops updating. A status code is not evidence that a write happened; only a re-read is.
 *
 * The same run also proved a PUT can CREATE an attribute the project does not yet carry —
 * but only where the project's template defines it. So "absent from the read-back" means
 * "the template does not define it here", which is exactly the case worth reporting.
 */

/** `2026-07-14T00:00:00+00:00` / `2026-07-14 00:00:00.000` / `2026-07-14` -> `2026-07-14`. */
export function attributeDatePart(v) {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(v ?? "").trim());
  return m ? m[1] : null;
}

/**
 * Compare one sent value against what came back.
 *
 * DATES ARE COMPARED BY DATE PART, and that is load-bearing rather than lenient. We send
 * `2026-07-14`; Acumatica echoes `2026-07-14 00:00:00.000`. A string comparison would
 * report every single date attribute as a failed write, every run — which is worse than
 * no verification at all, because a check that always cries wolf gets switched off.
 *
 * Everything else compares as a trimmed string, because that is what an attribute is.
 */
export function attributeValueMatches(sent, got) {
  const a = String(sent ?? "").trim();
  const b = String(got ?? "").trim();
  if (a === b) return true;
  const da = attributeDatePart(a);
  const db = attributeDatePart(b);
  return da !== null && da === db;
}

/**
 * Check a completed attribute PUT against a fresh read of the project.
 *
 * @param {Array<{AttributeID: string, Value: string}>} sent - what buildProjectAttributes produced
 * @param {Array<object>} readBack - the `Attributes` array from a re-read (raw Acumatica shape)
 * @returns {{ok: boolean, missing: string[], mismatched: Array<{attributeId, sent, got}>}}
 *   missing    - accepted with a 200 and then discarded; the template does not define it
 *   mismatched - present but holding something else
 */
export function verifyAttributeWrite(sent, readBack) {
  const got = new Map(
    (Array.isArray(readBack) ? readBack : []).map((a) => [
      String(a?.AttributeID?.value ?? a?.AttributeID ?? ""),
      a?.Value?.value ?? a?.Value,
    ])
  );

  const missing = [];
  const mismatched = [];
  for (const { AttributeID, Value } of sent ?? []) {
    if (!got.has(AttributeID)) {
      missing.push(AttributeID);
      continue;
    }
    const back = got.get(AttributeID);
    if (!attributeValueMatches(Value, back)) {
      mismatched.push({ attributeId: AttributeID, sent: Value, got: back ?? null });
    }
  }
  return { ok: missing.length === 0 && mismatched.length === 0, missing, mismatched };
}

// ===========================================================================
// The write path
// ===========================================================================

/**
 * THE GATE. Same mechanism and reasoning as CREATE_GATE and PO_GATE: a repo constant, not
 * an environment variable, so a change in either direction is a diff someone reviewed. A
 * test pins the committed value.
 *
 * ⚠️ OPENED 2026-08-24, after the hand-proof
 * (docs/integrations/acumatica-attribute-sync-runbook.md §Results) established the one
 * thing that could have made this unsafe: **a partial PUT merges**, so omitting a blank
 * cannot erase a value somebody typed in by hand.
 *
 * Attributes are not money — the blast radius is smaller than the PO engine's — but they
 * ARE what Harmon's accounting reporting reads, and this sync now overwrites values
 * Harmon enters manually today. Closing this is the emergency stop for that.
 */
export const ATTR_GATE = { enabled: true };

const PROJECT_ENTITY = "Project";

/**
 * Push a job's attributes to its Acumatica project, then PROVE they landed.
 *
 * The re-read is not optional politeness — see the hazard note on verifyAttributeWrite.
 * An unknown AttributeID returns 200 and is silently discarded, so without this a
 * template change would stop an attribute updating and nothing would ever say so.
 *
 * The project GUID is read fresh on every call and never stored. Same discipline as the
 * budget push and the PO engine: guids come from this run.
 *
 * ---------------------------------------------------------------------------
 * THE PROJECT MANAGER RIDES ALONG — same PUT, same verifying re-read
 * ---------------------------------------------------------------------------
 * `opts.projectManager` is an Acumatica EmployeeID, not an attribute: it goes to
 * `ProjectProperties.ProjectManager`. It travels with the attributes because it is the
 * same write, to the same project, needing the same proof — sending it separately would
 * be a second round trip and a second thing that could half-succeed.
 *
 * ⚠️ **A NULL projectManager MEANS "SAY NOTHING", NEVER "CLEAR IT".** The caller passes
 * null for a blank field, an unmapped name, and an ambiguous multi-select alike — three
 * ways of not knowing, and none of them is a reason to wipe a manager somebody assigned
 * in Acumatica. This is the same omit-rather-than-blank rule the attributes follow, and it
 * matters more here: there is exactly one manager slot, so a wrong clear is total.
 *
 * @param {string} acumaticaProjectId - e.g. "R261065"
 * @param {object} values - Sundial_Solar__c field values
 * @param {{jobType?: string, projectManager?: string|null, only?: ReadonlyArray<string>, deps?: object}} [opts]
 *   only           - restrict to a named attribute set (NON_COMMISSION_ATTRIBUTES for the
 *                    attribute-only path). Omit for the full set, which only the push
 *                    worker sends.
 *   projectManager - Acumatica EmployeeID to write to ProjectProperties.ProjectManager.
 *                    Null/absent writes nothing and never clears.
 */
export async function syncProjectAttributes(acumaticaProjectId, values, opts = {}) {
  const { getAcumaticaEntity, putAcumaticaEntity } = opts.deps ?? (await import("./acumatica.js"));

  if (!ATTR_GATE.enabled) {
    return { ok: false, action: "blocked", reason: "ATTR_GATE is closed — attribute sync is not enabled" };
  }
  const projectId = String(acumaticaProjectId ?? "").trim();
  if (!projectId) {
    return { ok: false, action: "refused", reason: "no Acumatica project id" };
  }

  const { attributes, omitted } = buildProjectAttributes(values, { jobType: opts.jobType, only: opts.only });
  const projectManager = String(opts.projectManager ?? "").trim() || null;
  if (attributes.length === 0 && !projectManager) {
    // Not a failure. A job with nothing known yet has nothing to say, and writing a set of
    // empty strings would be the one thing the omit rule exists to prevent.
    return { ok: true, action: "nothing_to_write", omitted, sent: [], projectManager: null };
  }

  // ProjectProperties must be EXPANDED to come back at all — without it the object is
  // simply absent from the response, so a verification reading `project.ProjectProperties
  // .ProjectManager` would see undefined and report every successful write as failed.
  // Confirmed live 2026-09-08.
  const EXPAND = "Attributes,ProjectProperties";
  const read = await getAcumaticaEntity(PROJECT_ENTITY, {
    $filter: `ProjectID eq '${projectId.replace(/'/g, "''")}'`,
    $expand: EXPAND,
  });
  if (!read.ok) {
    return { ok: false, action: "read_failed", status: read.status, error: (read.text || "").slice(0, 300) };
  }
  const project = (Array.isArray(read.data) ? read.data : [])[0];
  if (!project?.id) {
    return { ok: false, action: "project_not_found", message: `No Acumatica project ${projectId}, or it came back without a guid.` };
  }

  const body = { id: project.id };
  if (attributes.length > 0) {
    body.Attributes = attributes.map((a) => ({
      AttributeID: { value: a.AttributeID },
      Value: { value: a.Value },
    }));
  }
  if (projectManager) body.ProjectProperties = { ProjectManager: { value: projectManager } };

  const put = await putAcumaticaEntity(PROJECT_ENTITY, body);
  if (!put.ok) {
    return {
      ok: false, action: "write_failed", status: put.status,
      error: (put.text || "").slice(0, 300), sent: attributes, projectManager,
    };
  }

  // Verify against a FRESH read, not the PUT's echo. The echo is the write's own account
  // of itself, and the failure mode here is precisely a write that reports success.
  const after = await getAcumaticaEntity(PROJECT_ENTITY, {
    $filter: `ProjectID eq '${projectId.replace(/'/g, "''")}'`,
    $expand: EXPAND,
  });
  if (!after.ok) {
    return {
      ok: false, action: "unverified", status: after.status, sent: attributes, projectManager,
      message: `Attributes were accepted for ${projectId} but the verifying re-read failed, so we cannot say which of them landed.`,
    };
  }
  const afterProject = (Array.isArray(after.data) ? after.data : [])[0];
  const check = verifyAttributeWrite(attributes, afterProject?.Attributes);

  // The manager gets the same treatment as an attribute, and for the same reason: a 200
  // is the write's own account of itself. `ProjectManager` is a plain field rather than a
  // combo, so a bad EmployeeID is likelier to be rejected outright than silently dropped —
  // but "likelier" is not "always", and this costs nothing on a read we already do.
  const managerGot = projectManager
    ? String(afterProject?.ProjectProperties?.ProjectManager?.value ?? "").trim()
    : null;
  const managerOk = !projectManager || managerGot === projectManager;

  if (!check.ok || !managerOk) {
    const parts = [];
    if (check.missing.length) {
      parts.push(
        `accepted with a 200 and then discarded (the project template does not define them): ${check.missing.join(", ")}`
      );
    }
    if (check.mismatched.length) {
      parts.push(
        `came back holding something else: ${check.mismatched.map((m) => `${m.attributeId} = ${JSON.stringify(m.got)} (sent ${JSON.stringify(m.sent)})`).join("; ")}`
      );
    }
    if (!managerOk) {
      parts.push(
        `project manager did not land: sent ${JSON.stringify(projectManager)}, read back ${JSON.stringify(managerGot || null)}`
      );
    }
    console.error(`attribute-sync UNVERIFIED project=${projectId}: ${parts.join(" | ")}`);
    return {
      sent: attributes, omitted, projectManager,
      ...check,
      // AFTER the spread, deliberately. `check` carries its own `ok`, and when the
      // attributes verified but the MANAGER did not, that `ok: true` would overwrite a
      // leading `ok: false` and report a failed write as a clean sync. Harmless while
      // this branch only ran on `!check.ok`; not harmless once a second thing can fail.
      ok: false,
      action: "unverified",
      managerVerified: managerOk,
      message: `Attribute sync on ${projectId}: ${parts.join(" | ")}`,
    };
  }

  console.log(
    `attribute-sync OK project=${projectId} wrote=${attributes.length} omitted=${omitted.length} ` +
      `projectManager=${JSON.stringify(projectManager)}`
  );
  return {
    ok: true, action: "synced", sent: attributes, omitted,
    written: attributes.length, projectManager, managerVerified: projectManager ? true : null,
  };
}

// ===========================================================================
// Salesforce write-back — ONE mapping, used by BOTH paths
// ===========================================================================

/**
 * The three fields that record what the last attribute sync did.
 *
 * They exist because the Stage E observability gap was shipped knowingly on 2026-08-24
 * (D-060) and this closes it: until now a silently-discarded attribute surfaced only in
 * the push worker's shared `Budget_Push_Error__c` note and in CloudWatch, which is the
 * "log line nobody reads" problem the §4f document argued against.
 */
export const ATTRIBUTE_SYNC_FIELDS = Object.freeze({
  status: "Attribute_Sync_Status__c",
  error: "Attribute_Sync_Error__c",
  syncedAt: "Attribute_Synced_At__c",
});

/** The four values Attribute_Sync_Status__c is restricted to. Blank = never attempted. */
export const ATTRIBUTE_SYNC_STATUSES = Object.freeze([
  "Synced",
  "Nothing to Sync",
  "Unverified",
  "Failed",
]);

/**
 * Map a syncProjectAttributes result onto those three fields.
 *
 * A FUNCTION RATHER THAN EACH CALLER BUILDING ITS OWN MAP, because two paths now write
 * these fields — the attribute-only route and the push worker's Stage E — and a record
 * that says `Synced` after one path and `Failed` after the other for the same outcome
 * would be worse than no field at all.
 *
 * `Unverified` is deliberately not `Failed`. They need different responses: a failure
 * means the write did not happen, an unverified means it may have happened and Acumatica
 * did not confirm it — the silent-200 case. Collapsing them would hide the one this
 * whole verification exists to surface.
 *
 * @param {object} result - what syncProjectAttributes returned
 * @param {string} [now] - ISO timestamp; injected so tests are not clock-dependent
 */
export function buildAttributeSyncWriteback(result, now = new Date().toISOString()) {
  const F = ATTRIBUTE_SYNC_FIELDS;
  const action = result?.action;

  if (result?.ok === true) {
    return {
      [F.status]: action === "nothing_to_write" ? "Nothing to Sync" : "Synced",
      [F.error]: null,
      // Stamped on "Nothing to Sync" too: the sync DID run and found nothing to say,
      // which is a different fact from never having run, and the blank status is what
      // carries "never ran".
      [F.syncedAt]: now,
    };
  }

  // The gate being shut is not a fact about the job — same reasoning as the PO engine's
  // gate check. Write nothing at all rather than stamping every record with a failure.
  if (action === "blocked") return null;

  return {
    [F.status]: action === "unverified" ? "Unverified" : "Failed",
    [F.error]: String(
      result?.message || result?.error || result?.reason || action || "attribute sync failed"
    ).slice(0, 4000),
    // NOT stamped on failure: Attribute_Synced_At__c means "when the attributes were last
    // known good", so moving it on a failed run would make a stale record look fresh.
  };
}
