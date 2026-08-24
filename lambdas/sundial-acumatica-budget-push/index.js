// sundial-acumatica-budget-push — Acumatica ProjectBudget population (Layer 2).
//
// STATUS: READ + RECONCILE SCAFFOLDING ONLY. The GUID-write path is still hard-
// guarded off (see writeBudgetLines) — but the DATA BLOCKERS ARE RESOLVED.
//
// Gate 5a (data) — DONE 2026-08-07 via a live harvest of the canonical sandbox
// project R269999 (customer C001311112; see scratchpad/R269999-reconcile.json and
// docs/integrations/acumatica-budget-push.md):
//   (A) InventoryIDs harvested. The sheet's old "AccountGroup" column was actually
//       the InventoryID; the REAL AccountGroup is BILLING/LABOR/OTHER/MATERIAL.
//       MAPPING_ROWS below now carry the full 4-part key verbatim from the scaffold.
//   (B) Geo commission -> APPT COM (LABOR · SALESCOMM · Expense), confirmed from
//       role semantics. Harmon finance sign-off still required before the first
//       PRODUCTION write (PENDING_HARMON_SIGNOFF).
//
// Income is TWO lines — BALANCE (Balance of Contract) and GENM/BILLING (Solar
// Material), both Type=Income, both InventoryID <N/A>. There is NO "BILL" task.
//
// WHAT THIS DOES NOW (safe, read-only): given a Salesforce Sundial_Solar__c record
// (or an Acumatica ProjectID), read the EXISTING scaffolded ProjectBudget lines
// (GET $filter, URL-encoded) and return them keyed by the full natural key + GUID
// `id` — the reconciliation table. It does NOT create, update, or delete anything.
//
// The eventual write path (Layer 2, after Gate 5b sign-off): match each mapping row
// to EXACTLY ONE existing line by ProjectTaskID+AccountGroup+InventoryID+Type, then
// PUT /ProjectBudget/{id} updating OriginalBudgetedAmount (+ OriginalBudgetedQty /
// UOM=HOUR on labor lines). Updates by GUID — never key-upsert.
//
// ONE EXCEPTION, and it is the only one (D20, 2026-08-22): the referral line
// `GENO | OTHER | REFERRAL | Expense` may be CREATED when a job carries a referral fee
// and the project has no such line, because Harmon will not add it to the templates.
// It is create-then-verify-by-re-read, guarded to that single key, and it ships with
// CREATE_GATE closed until the sandbox hand-proof runbook comes back clean.

import { getAcumaticaEntity, putAcumaticaEntity } from "../../lib/acumatica.js";
import { sfQuery, soqlEscapeString, sfUpdateRecord } from "../../lib/salesforce.js";
import { resolveIdentity } from "../../lib/identity.js";
import {
  corsHeaders,
  normalizeHeaders,
  jsonResponse,
  mapIdentityError,
  httpMethod,
} from "../../lib/http.js";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import {
  syncCommissionPos,
  PO_NUMBER_FIELDS,
  MILESTONE_DATE_FIELDS,
} from "../sundial-acumatica-commission-po/index.js";
import {
  syncProjectAttributes,
  attributeFieldNames,
  nonCommissionFieldNames,
  buildAttributeSyncWriteback,
  NON_COMMISSION_ATTRIBUTES,
} from "../../lib/acumatica-attributes.js";

const PROJECT_BUDGET_ENTITY = "ProjectBudget";
const SOLAR_SF_OBJECT = "Sundial_Solar__c";

// The portal "Update Budget" button hits POST /projects/{recordId}/budget/push,
// which returns 202 immediately and hands the work to an async self-invoke of THIS
// same function (InvocationType Event). The runtime always sets these two env vars.
const SELF_FUNCTION_NAME = process.env.AWS_LAMBDA_FUNCTION_NAME;
const lambda = new LambdaClient({ region: process.env.AWS_REGION || "us-west-1" });

// --- The mapping rows (Acumatica Mapping tab, RECONCILED to the live R269999
// scaffold on 2026-08-07) ---------------------------------------------------
// Each row carries the TRUE 4-part natural key: taskId + accountGroup + inventoryId
// + type, taken VERBATIM from the harvested ProjectBudget lines
// (scratchpad/R269999-reconcile.json; table in docs/integrations/acumatica-budget-push.md).
//
// KEY CORRECTION: the sheet's old "AccountGroup" column actually held the
// InventoryID. The REAL AccountGroup is BILLING / LABOR / OTHER / MATERIAL — so the
// commission lines are AccountGroup=LABOR with InventoryID=SALESCOMM (NOT
// AccountGroup=SALESCOMM as the sheet implied). InventoryID is what separates the
// two BURDENEXR lines (SALESCOMM commission-burden vs RESIDENTAL labor-burden).
//
// (!) "RESIDENTAL" IS THE ACUMATICA-SIDE SPELLING (missing the second "I"). It is
// intentionally misspelled here to match the live InventoryID EXACTLY — DO NOT
// "correct" it to RESIDENTIAL, or every RESIDENTAL line will fail to match.
//
// "<N/A>" is a LITERAL InventoryID value on those lines (not null/absent). The
// matcher compares it as the literal string, so it must stay exactly "<N/A>".
//
// 18 rows vs. the sheet's 17: income is split into TWO code rows (BALANCE + GENM/
// BILLING). Intentional SUMS into one scaffold line: the two SLPC rows (Sales Rep +
// Overhead) and the three GENO rows (Other Material + CO Fee + Permit).

// The one item still needing a human YES before the FIRST production write (Gate 5b):
export const PENDING_HARMON_SIGNOFF = {
  // Geo commission -> APPT COM (LABOR · SALESCOMM · Expense). Confirmed from role
  // semantics (appointment-setter flat commission); the code + full key are wired
  // into MAPPING_ROWS below, but Harmon finance must sign off before the first
  // PRODUCTION ProjectBudget push.
  geoCommissionTaskId: "APPT COM",
};

export const MAPPING_ROWS = [
  // line, taskId, accountGroup, type, inventoryId, amountField, hoursField, keyStatus, note.
  //
  // keyStatus: "harvested"   = the 4-part key came verbatim from the R269999 scaffold
  //            "provisional" = v3-only line whose key is this doc's best reading of §5
  //                            and is CONFIRMED OR REFUTED BY THE RE-HARVEST. A
  //                            provisional key that matches nothing aborts the push
  //                            loudly, which is exactly what a guess should do.

  // ---- INCOME (always written, never skip-zero) ---------------------------
  { line: "Income - Balance of Contract", taskId: "BALANCE", accountGroup: "BILLING", type: "Income", inventoryId: "<N/A>", amountField: "Contract_Amount__c-Total_Material_Budget__c", hoursField: null, keyStatus: "harvested", note: "Income 1 of 2. Contract net of the material billing (GENM/BILLING) so the two income lines sum to the contract. DELIBERATELY EXCLUDES the DC rebate: the rebate gets its OWN income line, so adding it here too would double-count the revenue. Confirm at re-harvest (Q12b)." },
  { line: "Income - Solar Material", taskId: "GENM", accountGroup: "BILLING", type: "Income", inventoryId: "<N/A>", amountField: "Total_Material_Budget__c", hoursField: null, keyStatus: "harvested", note: "Income 2 of 2. Distinct from the GENM/MATERIAL cost line via AccountGroup+Type." },

  { line: "Income - DC Rebate (RSDC only)", taskId: "DCREBATE", accountGroup: "BILLING", type: "Income", inventoryId: "<N/A>", amountField: "DC_Rebate_Amount__c", hoursField: null, keyStatus: "harvested", scaffoldOptional: true, missingLineMessage: "Domestic Content is set on a project built from the RS template, which has no DCREBATE line. The project must be created from the RSDC template before the rebate can be pushed.", note: "HARVEST-CONFIRMED 2026-08-20: DCREBATE | BILLING | <N/A> | Income is the ONLY difference between the RSDC scaffold (R261066, 39 lines) and the RS one (R261077, 38). CONDITIONAL: present (RSDC) => income-always, written even at 0; absent (RS) => inactive when the rebate is 0, but ABORTS with missingLineMessage when it is not, because a non-zero rebate on an RS-template project means the wrong template was chosen and the income would silently vanish." },

  // ---- COMMISSIONS (D9/D10/D16/D17) ---------------------------------------
  // FOUR lines now, not two, each with exactly ONE source field. The v1 shape
  // (SLPC = rep + overhead summed) is gone: overhead moved into the SLMC management
  // line, and the rep split in two by deal type.
  { line: "3rd Party Rep Commission", taskId: "SLPC OUT", accountGroup: "OTHER", type: "Expense", inventoryId: "M1&M2COM", amountField: "Sales_Rep_Commission_Amt__c", hoursField: null, keyStatus: "harvested", note: "D9/D16. Sales_Rep_Commission_Amt__c now holds the THIRD-PARTY amount only (the field was relabelled '3rd Party Rep Commission $/W'). ZERO on an internal deal, so skip-zero leaves this line alone. AccountGroup OTHER + InventoryID M1&M2COM per §5 - NOT LABOR/SALESCOMM like the other three. HARVEST-CONFIRMED 2026-08-20 (R261077 + R261066): the live scaffolds both carry 'SLPC OUT' with a SINGLE space. The REVISED sheet's H7 label shows two — that is a typo in the sheet, not the Acumatica task id." },
  { line: "Internal Rep Commission", taskId: "SLPC", accountGroup: "LABOR", type: "Expense", inventoryId: "SALESCOMM", amountField: "Internal_Rep_Commission_Amt__c", hoursField: null, keyStatus: "harvested", note: "D9/D16. Zero on a third-party deal. Same key v1 used for the rep+overhead sum, but the amount source is now the INTERNAL rep alone." },
  { line: "Management Commission", taskId: "SLMC", accountGroup: "LABOR", type: "Expense", inventoryId: "SALESCOMM", amountField: "Management_Commission_Amt__c", hoursField: null, keyStatus: "harvested", note: "D10. ONE line from the COMBINED (.04 + .015) amount. Do NOT sum Sales_Mgr_Commission_Amt__c + Overhead_Commission_Amt__c here - Management_Commission_Amt__c already IS that sum, and adding the components too would double it. The components stay on the record only so the attribute sync can split them (MGRCOM* / MGMTOR*)." },
  { line: "Setter Commission", taskId: "APPT COM", accountGroup: "LABOR", type: "Expense", inventoryId: "SALESCOMM", amountField: "Setter_Commission_Amt__c", hoursField: null, keyStatus: "harvested", note: "D17. Source CHANGED from Geo_Commission_Amount__c (the INPUT rate, always 70) to Setter_Commission_Amt__c (what actually APPLIED - 0 when the Customer has no Setter__c). v1 would have posted 70 to every job regardless. Still needs Harmon sign-off on the APPT COM code (PENDING_HARMON_SIGNOFF)." },
  { line: "Commission Burden", taskId: "BURDENEXR", accountGroup: "LABOR", type: "Expense", inventoryId: "SALESCOMM", amountField: "Commission_Burden_Amt__c", hoursField: null, keyStatus: "harvested", note: "D21 (2026-08-22): 75% of (management + setter) ONLY. NEITHER rep line is burdened - not the external one and not the internal redline commission, which WAS burdened under D19 Stage 2 before Harmon ruled. The amount is read from the single Commission_Burden_Amt__c field, so this row needs no component arithmetic and the ruling reaches it through the calc - but the note is what a reader checks the number against, so it has to be right. InventoryID SALESCOMM separates it from the RESIDENTAL labor burden." },

  // ---- LABOR + HOURS ------------------------------------------------------
  { line: "Audit + QA Labor", taskId: "GENA", accountGroup: "LABOR", type: "Expense", inventoryId: "RESIDENTAL", amountField: "Audit_Labor_Cost__c", hoursField: "GENA_Hours__c", keyStatus: "harvested", note: "WARNING: v1 summed Audit_Labor_Cost__c + QA_Labor_Cost__c. In v2 Audit_Labor_Cost__c IS the whole GENA line (audit + QA, sheet J21), so keeping the v1 sum would DOUBLE-COUNT QA. See budget-v2-output-gap.md section A." },
  { line: "Roofing Labor", taskId: "ROOFCOM", accountGroup: "LABOR", type: "Expense", inventoryId: "RESIDENTAL", amountField: "Roofing_Labor_Cost__c", hoursField: null, keyStatus: "harvested", note: "Piece rate - no hours source, so the scaffold qty is left alone." },
  { line: "S1 Install Labor", taskId: "S1", accountGroup: "LABOR", type: "Expense", inventoryId: "RESIDENTAL", amountField: "S1_Labor_Cost__c", hoursField: "S1_Hours__c", keyStatus: "harvested" },
  { line: "S2 Install Labor", taskId: "S2", accountGroup: "LABOR", type: "Expense", inventoryId: "RESIDENTAL", amountField: "S2_Labor_Cost__c", hoursField: "S2_Hours__c", keyStatus: "harvested" },
  { line: "S3 Labor (Battery + Adders + NS)", taskId: "S3", accountGroup: "LABOR", type: "Expense", inventoryId: "RESIDENTAL", amountField: "S3_Labor_Cost__c", hoursField: "S3_Hours__c", keyStatus: "harvested", note: "v2 S3 = battery + ALL standard-adder + ALL NS-block labor (five blocks now, at the Powerwall rate)." },
  { line: "Labor Burden", taskId: "BURDENEXR", accountGroup: "LABOR", type: "Expense", inventoryId: "RESIDENTAL", amountField: "Total_Labor_Burden_Budget__c", hoursField: null, keyStatus: "harvested", note: "InventoryID RESIDENTAL separates it from the SALESCOMM commission burden." },

  // ---- MATERIAL / OTHER ---------------------------------------------------
  { line: "Total Material", taskId: "GENM", accountGroup: "MATERIAL", type: "Expense", inventoryId: "<N/A>", amountField: "Total_Material_Budget__c", hoursField: null, keyStatus: "harvested", note: "Sheet J15: equipment + BOS + roofing + standard-adder material + NS material (no markup)." },
  { line: "Other (GENO)", taskId: "GENO", accountGroup: "OTHER", type: "Expense", inventoryId: "<N/A>", amountField: "Total_Other_Budget__c", hoursField: null, keyStatus: "harvested", note: "WARNING: ONE ROW, not three. v1 summed Total_Other_Budget__c + Constructive_Ops_Fee__c + Permit_Pass_Through_Cost__c into this key. In v2 Total_Other_Budget__c IS the whole J16 group - Material Other + CO fee + permit + Active Monitoring + LR Battery Warranty (D12) - so the v1 rows would double-count CO fee and permit. This is the GENO group (J16), deliberately NOT Total_Other_Summary__c (N13), which also contains the four standalone lines below and would double-count those instead." },
  { line: "Dealer Fee", taskId: "DLR", accountGroup: "OTHER", type: "Expense", inventoryId: "<N/A>", amountField: "Dealer_Fee__c", hoursField: null, keyStatus: "harvested", note: "CARRIED OVER FROM v1 AND NOT IN THE section 5 v3 TABLE. Kept because the line exists in the live scaffold and dropping it silently would leave a real line unwritten. Note the dealer fee is ALSO subtracted from Balance of Revenue in the calc - confirm at re-harvest whether it belongs as an expense line too, or whether that was a v1 double-count (Q12c)." },

  // ---- STANDALONE COST LINES (D11/D13) - NEW IN v3 ------------------------
  // All four were computed in BRADS and then EXCLUDED from Total Job Cost; D11 fixed
  // that. None existed in the v1 sandbox scaffold; the 2026-08-20 harvest confirmed
  // ENGR / SUBCON / SOFTWARE exist in the LIVE template and REFERRAL does not.
  { line: "Engineer Stamps", taskId: "ENGR", accountGroup: "SUBCON", type: "Expense", inventoryId: "<N/A>", amountField: "Engineer_Stamps_Cost__c", hoursField: null, keyStatus: "harvested", note: "Sheet J17 / E55, from the Structural-Electrical Engineer Stamp adder. HARVEST-CONFIRMED 2026-08-20 (R261077 + R261066): ENGR | SUBCON | <N/A> | Expense is present in both live scaffolds, so the section 5 'ENGR?' guess was right and it is ENGR, not the neighbouring SUBCON line." },
  { line: "Subcontractor", taskId: "SUBCON", accountGroup: "SUBCON", type: "Expense", inventoryId: "<N/A>", amountField: "Subcontractor_Cost__c", hoursField: null, keyStatus: "harvested", note: "Sheet J18 / E56, from the Bird Blocking adder (per-watt cost x watts). HARVEST-CONFIRMED 2026-08-20: present in both live scaffolds." },
  { line: "Audit Software", taskId: "SOFTWARE", accountGroup: "OTHER", type: "Expense", inventoryId: "<N/A>", amountField: "Adder_Software_Fee_Price__c*Adder_Software_Fee_Qty__c", hoursField: null, keyStatus: "harvested", note: "Sheet J19 / E60. HARVEST-CONFIRMED 2026-08-20: present in both live scaffolds. There is NO dedicated SF output field (left extras-only per gap doc section D), so the amount is the PRODUCT of the two adder fields - identical to what the calc computes, where a pass-through row's cost IS price x qty." },
  { line: "Referral Fees", taskId: "GENO", accountGroup: "OTHER", type: "Expense", inventoryId: "REFERRAL", amountField: "Adder_Referral_Fee_Price__c*Adder_Referral_Fee_Qty__c", hoursField: null, keyStatus: "harvested_absent", scaffoldOptional: true, createIfMissing: true, missingLineMessage: "This job carries a referral fee and the project has no GENO | OTHER | REFERRAL line. The push normally CREATES it (D20), so seeing this message means CREATE_GATE has been closed - check why before working around it. Add the line by hand in Acumatica and re-push if you need to unblock the job.", note: "Sheet J20 / E63. KEY CHANGED 2026-08-22 (D20): was REFERRAL | OTHER | <N/A>, now GENO | OTHER | REFERRAL per Harmon's authoritative line spec. Distinct InventoryID means NO collision with the GENO | OTHER | <N/A> sum row - they are different keys under the same task. Harmon will NOT add the line to the RS/RSDC templates, so the push creates it when a job actually carries a referral fee: see REFERRAL_CREATE_SPEC and the three-branch behaviour there. This is the ONLY line the integration may ever create." },
];

/**
 * D20 — the ONE line this integration is allowed to create, and its exact shape.
 *
 * Harmon will not add a REFERRAL line to the RS/RSDC templates (that was D13's ask, and
 * it is superseded). Since a job that carries a referral fee has to post it somewhere,
 * the push creates the line on demand. Three branches, in `writeBudgetLines`:
 *
 *   1. line PRESENT              -> update by guid, business as usual
 *   2. ABSENT + amount 0         -> inactive row, exactly as today (the common case)
 *   3. ABSENT + amount > 0       -> CREATE, then RE-READ AND VERIFY before reporting
 *                                   success. A re-push afterwards takes branch 1.
 *
 * Field values are Harmon's, verbatim. Two deliberate omissions from the body:
 *
 *  - **Currency (USD).** Harmon's spec names it, but currency on a ProjectBudget line
 *    follows the project, this is a single-company install, and guessing a field name
 *    (`CuryID`? `Currency`?) risks a 400 on a write we only get one shot at. The runbook
 *    proves what comes back instead of asserting what to send.
 *  - **Qty / rate.** Harmon's spec says no defaults, and the verify step checks the
 *    created line carries the amount and nothing spurious.
 *
 * `AccountGroup` IS sent, because it is in the authoritative spec — but Acumatica may
 * well derive it from the inventory item's posting class and ignore what we send. That
 * is exactly why verification re-reads and CHECKS it rather than trusting the write.
 */
export const REFERRAL_LINE_KEY = "GENO | OTHER | REFERRAL | Expense";
export const REFERRAL_CREATE_SPEC = {
  key: REFERRAL_LINE_KEY,
  projectTaskId: "GENO",
  accountGroup: "OTHER",
  inventoryId: "REFERRAL",
  description: "Referral Fee",
  uom: "EA",
  type: "Expense",
};

/**
 * THE GATE — **OPEN as of 2026-08-22, on the strength of the sandbox hand-proof.**
 *
 * Line creation was an unproven write mechanic against a system where a bad write is not
 * a bad row in a table, it is a wrong number in Harmon's books. It is now proven by hand:
 * `docs/integrations/acumatica-referral-line-create-runbook.md` §Results, run against
 * sandbox project **R261065**. All five gates passed —
 *
 *   - PUT-without-id DOES insert (the mechanic works at all)
 *   - `AccountGroup` came back **OTHER** and `Type` **Expense**, DERIVED from the
 *     REFERRAL item's posting class and agreeing with what we send, so
 *     `REFERRAL_LINE_KEY` is correct and no mapping change was needed
 *   - update-by-guid updates in place, no duplicate, count 1 throughout
 *
 * Deliberately NOT an environment variable: an env var can be flipped in the AWS console
 * with no commit and no review, and this repo has already been burned once by a
 * load-bearing untracked dashboard setting. A test asserts the committed value, so a
 * change in EITHER direction is a visible diff someone signed off on.
 *
 * TO CLOSE IT AGAIN (and the trigger to watch for): `summary.created` should be `1` on
 * the push that first posts a referral fee for a project and `0` on every push after. If
 * it is ever `1` twice for the same project, verification is not doing its job — set this
 * back to `false` and look at the project before anything else.
 */
export const CREATE_GATE = { enabled: true };

/**
 * Rows whose Acumatica key is not yet known.
 *
 * EMPTY as of 2026-08-20 - the DC rebate was the only occupant and its key came back
 * from the RSDC harvest (DCREBATE | BILLING | <N/A> | Income), so it now lives in
 * MAPPING_ROWS above with scaffoldOptional semantics.
 *
 * The array and its guard in writeBudgetLines are KEPT rather than deleted. They are the
 * mechanism that stopped an unkeyed $0.45/W income line from being silently dropped for
 * the whole time its key was unknown, and the next line in that position (a new task
 * code, another template variant) drops straight in. An empty array costs nothing;
 * re-inventing the guard under time pressure costs a real number on a real job.
 */
export const PENDING_HARVEST_ROWS = [];


// Unwrap an Acumatica field value ({ value: x } or scalar).
function av(v) {
  return v && typeof v === "object" && "value" in v ? v.value : v;
}

// The full natural key for a ProjectBudget line/mapping row.
export function naturalKey({ taskId, accountGroup, inventoryId, type }) {
  return [taskId ?? "", accountGroup ?? "", inventoryId ?? "", type ?? ""].join(" | ");
}

// Read the existing scaffolded ProjectBudget lines for a ProjectID (read-only).
// $filter is URL-encoded by lib/acumatica.js (getAcumaticaEntity -> URLSearchParams).
export async function readProjectBudgetLines(acumaticaProjectId) {
  const res = await getAcumaticaEntity(PROJECT_BUDGET_ENTITY, {
    $filter: `ProjectID eq '${String(acumaticaProjectId).replace(/'/g, "''")}'`,
  });
  if (!res.ok) {
    const err = new Error(`ProjectBudget read failed (${res.status})`);
    err.acuStatus = res.status;
    throw err;
  }
  const lines = Array.isArray(res.data) ? res.data : [];
  return lines.map((l) => ({
    id: l.id, // GUID — the write path addresses lines by this
    taskId: av(l.ProjectTaskID),
    accountGroup: av(l.AccountGroup),
    inventoryId: av(l.InventoryID),
    type: av(l.Type),
    description: av(l.Description),
    originalBudgetedAmount: av(l.OriginalBudgetedAmount),
    originalBudgetedQty: av(l.OriginalBudgetedQty),
    uom: av(l.UOM),
    key: naturalKey({
      taskId: av(l.ProjectTaskID),
      accountGroup: av(l.AccountGroup),
      inventoryId: av(l.InventoryID),
      type: av(l.Type),
    }),
  }));
}

// Match mapping rows to existing scaffold lines by the FULL natural key
// (ProjectTaskID + AccountGroup + InventoryID + Type). The rules, in the order they
// are applied — and the ORDER IS THE POINT (changed 2026-08-20 after the harvest):
//
//  1. SKIP-ZERO IS EVALUATED BEFORE THE MATCH, not after. An expense row whose amount
//     is 0 has nothing to write, so whether a line exists for it is irrelevant. Under
//     the old order (match, then skip) a template that simply lacks a line — REFERRAL,
//     confirmed absent from the live template on 2026-08-20 — failed EVERY push,
//     including the overwhelming majority of jobs that have no referral fee at all.
//     Requiring a line you are not going to write to is not a safety property.
//  2. INCOME IS EXEMPT from that: income-always means an income line must match or the
//     push fails, even at 0. The one exception is a `scaffoldOptional` income row (the
//     DC rebate), which legitimately does not exist on an RS scaffold.
//  3. `scaffoldOptional` rows may be absent. Absent + zero = inactive. Absent +
//     NON-ZERO = a loud abort carrying the row's `missingLineMessage`, because that is
//     the case where a real amount would silently vanish.
// 3b. EXCEPT the referral line (D20), which may CREATE itself instead of aborting —
//     write path only, one specific key only, and only while CREATE_GATE is open. With
//     the gate closed this rule does not exist and rule 3 applies unchanged.
//  4. Several rows sharing ONE key still SUM into that single line (no v3 row does
//     today, but the machinery is intact and the GENO history is why it exists).
//  5. Otherwise: FAIL LOUDLY. A key matching 0 or >1 lines, or a row missing any key
//     part, is a problem. Never guess, never merge on a partial key.
//
// `budgetValues` is OPTIONAL and that distinction matters:
//   - WRITE PATH (values supplied): amount-aware, so rules 1-3 apply.
//   - RECONCILE (omitted): purely STRUCTURAL. Every non-optional row must match or it
//     is reported as a problem, regardless of what any record's amounts happen to be.
//     That keeps the structural safety net intact — the leniency in rule 1 exists only
//     where there is genuinely nothing to write, and reconcile is where a broken key is
//     supposed to be caught.
//
// Returns { matched, problems, inactive, toCreate }. `inactive` is neither success nor failure:
// rows correctly doing nothing on this project (an absent optional line, a zero expense
// with no line). Surfaced rather than swallowed so "why is REFERRAL not in the output"
// has an answer.
export function matchMappingToLines(mappingRows, lines, budgetValues = null) {
  const matched = [];
  const problems = [];
  const inactive = [];
  // D20: absent lines this run is allowed to CREATE. Only ever the referral line, only
  // on the write path, and only with the gate open — see rule 3b below. Empty on every
  // other code path, including reconcile, which passes no budgetValues and therefore
  // cannot know an amount is non-zero in the first place.
  const toCreate = [];

  // Partition out rows we can't key completely (can't match or group them safely).
  const complete = [];
  for (const row of mappingRows) {
    if (
      row.inventoryId == null ||
      row.taskId == null ||
      row.accountGroup == null ||
      row.type == null
    ) {
      problems.push({
        row: row.line,
        reason:
          "mapping row missing a key part (inventoryId/taskId/accountGroup/type) — cannot match uniquely",
      });
    } else {
      complete.push(row);
    }
  }

  // Group complete rows by full key; each group -> exactly one line (amounts summed).
  const groups = new Map();
  for (const row of complete) {
    const k = naturalKey(row);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(row);
  }

  for (const [key, rows] of groups) {
    const hits = lines.filter((l) => l.key === key);
    const isIncome = rows[0].type === "Income";
    const optional = rows.some((r) => r.scaffoldOptional === true);
    const rowNames = rows.map((r) => r.line);

    if (hits.length > 1) {
      problems.push({ key, count: hits.length, rows: rowNames, reason: "matched multiple lines" });
      continue;
    }

    if (hits.length === 0) {
      const amount = budgetValues
        ? sumFields(rows.map((r) => r.amountField).filter(Boolean), budgetValues)
        : null;

      // Rule 3b (D20, WRITE PATH ONLY): the one row allowed to create its own line.
      //
      // Three conditions, ALL required, and they are deliberately redundant with each
      // other: the row must opt in (`createIfMissing`), its key must be THE referral
      // key (not merely "a key belonging to a row that opted in"), and the gate must be
      // open. Any future row that sets `createIfMissing` without also being the referral
      // line falls through to the abort below rather than quietly gaining the power to
      // write new lines into Harmon's books.
      const wantsCreate =
        rows.length === 1 &&
        rows[0].createIfMissing === true &&
        key === REFERRAL_LINE_KEY &&
        REFERRAL_CREATE_SPEC.key === REFERRAL_LINE_KEY;
      if (wantsCreate && CREATE_GATE.enabled && amount !== null && amount !== 0) {
        toCreate.push({ key, rows: rowNames, amount, amountFields: rows.map((r) => r.amountField).filter(Boolean) });
        continue;
      }

      // Rule 3 (write path): an optional line that is absent while carrying a real
      // amount is the dangerous case — abort with the row's own message. With the gate
      // CLOSED the referral row lands here too, which is the point: closed means today's
      // behaviour exactly, not a quieter version of it.
      if (optional && amount !== null && amount !== 0) {
        problems.push({
          key,
          count: 0,
          rows: rowNames,
          amount,
          reason: rows.find((r) => r.missingLineMessage)?.missingLineMessage
            ?? "no scaffolded line matched and the amount is non-zero",
        });
        continue;
      }
      // Rule 3 (write path) / rule 1: absent + nothing to write = inactive.
      if (optional && (amount === 0 || amount === null)) {
        inactive.push({
          key,
          rows: rowNames,
          ...(amount !== null ? { amount } : {}),
          reason: "line is not on this scaffold and there is nothing to write (optional row)",
        });
        continue;
      }
      // Rule 1: a NON-optional expense row with a zero amount. Nothing to write, so a
      // missing line cannot hurt. Reconcile (amount === null) still reports it.
      if (!isIncome && amount === 0) {
        inactive.push({ key, rows: rowNames, amount, reason: "no scaffolded line matched, but the amount is 0" });
        continue;
      }
      problems.push({ key, count: 0, rows: rowNames, ...(amount !== null ? { amount } : {}), reason: "no scaffolded line matched" });
      continue;
    }

    matched.push({
      key,
      lineId: hits[0].id,
      uom: hits[0].uom, // scaffold line UOM; HOUR lines also get an OriginalBudgetedQty
      type: rows[0].type, // Income lines are ALWAYS written (no skip-zero)
      rows: rowNames,
      summed: rows.length > 1, // multiple mapping rows -> summed into this one line
      amountFields: rows.map((r) => r.amountField).filter(Boolean),
      hoursFields: rows.map((r) => r.hoursField).filter(Boolean),
    });
  }
  return { matched, problems, inactive, toCreate };
}

// --- Budget field resolution ------------------------------------------------
function numOf(v) {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}
function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

// Evaluate a field expression against record values.
//
// Grammar: TERMS separated by + / -, each term a PRODUCT of field names joined by *.
//   "Contract_Amount__c-Total_Material_Budget__c"                  (BALANCE income)
//   "Adder_Software_Fee_Price__c*Adder_Software_Fee_Qty__c"        (v3 pass-throughs)
// Salesforce API names contain none of + - *, so splitting on them is unambiguous.
// Missing/blank fields count as 0.
//
// WHY MULTIPLICATION EXISTS (added for v3): the SOFTWARE and REFERRAL budget lines have
// no dedicated Salesforce output field — the gap review left them extras-only because
// they are "trivially price × qty". True, but the push reads FIELDS off the record, not
// the calc's return value, so it needs to do that multiplication itself. The product is
// identical to what budgetCalc computes for a pass-through row.
//
// A missing factor zeroes the whole term, which is a sharper failure than in a sum — but
// every field named here is included in budgetFieldNames() and therefore in the SOQL, so
// a name that does not exist fails loudly at query time rather than quietly returning 0.
function evalFieldExpr(spec, values) {
  let total = 0;
  for (const term of String(spec).match(/[+-]?[^+-]+/g) || []) {
    let t = term.trim();
    if (!t) continue;
    let sign = 1;
    if (t[0] === "+") t = t.slice(1).trim();
    else if (t[0] === "-") { sign = -1; t = t.slice(1).trim(); }
    let product = 1;
    for (const factor of t.split("*")) product *= numOf(values?.[factor.trim()]);
    total += sign * product;
  }
  return total;
}

// Every distinct Sundial_Solar__c field referenced by MAPPING_ROWS (amount + hours
// sources; +/- expressions split), so a caller can SELECT exactly these.
/**
 * Fields the GUARDS need that are not amount sources for any line.
 *
 * `Commission_Deal_Type__c` is the v2-engine marker: only budgetCalc v2 writes it, so a
 * blank value means the record's stored budget numbers came from the v1 engine (or were
 * never calculated). See the guard in writeBudgetLines.
 */
export const GUARD_FIELDS = ["Commission_Deal_Type__c"];

// Includes PENDING_HARVEST_ROWS' sources so the DC-rebate guard below can see
// DC_Rebate_Amount__c on the record, and GUARD_FIELDS for the same reason — a guard
// that cannot read its own trigger field is not a guard.
export function budgetFieldNames() {
  const names = new Set(GUARD_FIELDS);
  for (const r of [...MAPPING_ROWS, ...PENDING_HARVEST_ROWS]) {
    if (r.amountField)
      for (const f of r.amountField.split(/[+\-*]/)) {
        const n = f.trim();
        if (n) names.add(n);
      }
    if (r.hoursField) names.add(r.hoursField.trim());
  }
  return [...names];
}

/**
 * Fields the DOWNSTREAM stages read — commission POs (Stage B) and attributes (Stage E).
 *
 * Derived from each module's own exported constants rather than retyped, so a field
 * rename over there cannot leave this SELECT quietly short. A missing field would not
 * throw: it would arrive as undefined, and the PO engine would read "no stored OrderNbr"
 * and raise a SECOND purchase order. That is the failure this list prevents.
 */
export function downstreamFieldNames() {
  return [
    ...attributeFieldNames(),
    "Acumatica_Project_ID__c",
    ...Object.values(PO_NUMBER_FIELDS),
    ...Object.values(MILESTONE_DATE_FIELDS),
  ];
}

/** Everything the worker must SELECT: budget mapping + both downstream stages. */
export function workerFieldNames() {
  return [...new Set([...budgetFieldNames(), ...downstreamFieldNames()])];
}

// Sum a list of amount-field specs (each may be an A+B or A-B expression).
function sumFields(fieldSpecs, values) {
  let total = 0;
  for (const spec of fieldSpecs || []) total += evalFieldExpr(spec, values);
  return round2(total);
}

// PUT one ProjectBudget line, with exponential backoff on 429 / 5xx (transient).
// A non-429 4xx is a real rejection — do not retry. Never retries a success.
const WRITE_MAX_ATTEMPTS = 4;
async function putBudgetLineWithRetry(body) {
  let lastStatus = 0;
  let lastText = "";
  for (let attempt = 1; attempt <= WRITE_MAX_ATTEMPTS; attempt++) {
    const res = await putAcumaticaEntity(PROJECT_BUDGET_ENTITY, body);
    if (res.ok) return { ok: true, status: res.status };
    lastStatus = res.status;
    lastText = (res.text || "").slice(0, 300);
    const transient = res.status === 429 || res.status >= 500;
    if (transient && attempt < WRITE_MAX_ATTEMPTS) {
      await new Promise((r) => setTimeout(r, 500 * 2 ** (attempt - 1))); // 0.5s,1s,2s
      continue;
    }
    break;
  }
  return { ok: false, status: lastStatus, text: lastText };
}

/**
 * D20 — create the referral budget line, then PROVE it exists before saying so.
 *
 * This is the only function in the integration that adds a row to Acumatica, and the
 * asymmetry with the update path is the reason it is written this way. An update by guid
 * that half-fails leaves a line with a wrong amount, which the next push corrects. A
 * create that half-fails can leave NOTHING (money silently unposted) or TWO lines (the
 * key stops matching uniquely and every future push on that project aborts). Neither is
 * self-healing, so neither is allowed to be reported as success on the strength of a
 * 200 alone.
 *
 * Hence: create, then re-read the project's lines and check four things — exactly one
 * line carries the key, it has a guid, its amount is what we sent, and the fields
 * Acumatica might have derived for itself (AccountGroup, Type) came back as expected.
 * Anything else is a failure, and the failure message says a line may now exist so a
 * human knows to go and look rather than assuming a no-op.
 *
 * @returns {Promise<{ok: boolean, action: string, ...}>} never throws for an API-level
 *   failure; the caller folds the result into the push summary.
 */
async function createReferralLineAndVerify(acumaticaProjectId, amount) {
  const spec = REFERRAL_CREATE_SPEC;

  // Belt and braces at the last possible moment: this function is private, has exactly
  // one caller, and that caller already checked the key — but it is the thing holding
  // the create capability, so it re-checks its own preconditions rather than trusting
  // that a future edit upstream kept them.
  if (!CREATE_GATE.enabled) {
    return { ok: false, action: "create_blocked", key: spec.key, reason: "CREATE_GATE is closed" };
  }
  if (!(Number.isFinite(amount) && amount !== 0)) {
    return { ok: false, action: "create_refused", key: spec.key, reason: `refusing to create a line for amount ${amount}` };
  }

  // NO `id` — that is what makes this an insert rather than an update. Everything else
  // is Harmon's authoritative line spec; see REFERRAL_CREATE_SPEC for the two fields
  // deliberately left out.
  const body = {
    ProjectID: { value: acumaticaProjectId },
    ProjectTaskID: { value: spec.projectTaskId },
    AccountGroup: { value: spec.accountGroup },
    InventoryID: { value: spec.inventoryId },
    Description: { value: spec.description },
    UOM: { value: spec.uom },
    OriginalBudgetedAmount: { value: amount },
  };

  console.log(`budget-push CREATE ${spec.key} project=${acumaticaProjectId} amount=${amount}`);
  const put = await putBudgetLineWithRetry(body);
  if (!put.ok) {
    return {
      ok: false, action: "create_failed", key: spec.key, amount,
      status: put.status, error: put.text,
      message: "Creating the referral line failed. No line was created (the write was rejected), so nothing needs cleaning up — fix the cause and re-push.",
    };
  }

  // VERIFY. A fresh read, not the PUT's echo: what we want to know is what the project
  // looks like now, which is a different question from what the write claims it did.
  let after;
  try {
    after = await readProjectBudgetLines(acumaticaProjectId);
  } catch (err) {
    return {
      ok: false, action: "create_unverified", key: spec.key, amount,
      message:
        "The referral line was created but the verifying re-read FAILED, so this push " +
        "cannot confirm the project's state. A line probably now exists — check the " +
        "project before re-pushing, because a duplicate would break every future push.",
      error: err?.message || String(err),
    };
  }

  const hits = after.filter((l) => l.key === spec.key);
  if (hits.length > 1) {
    return {
      ok: false, action: "create_unverified", key: spec.key, amount, count: hits.length,
      message:
        `The create produced ${hits.length} lines with the referral key. The key must match ` +
        "EXACTLY ONE line or every future push on this project aborts. Delete the duplicates in Acumatica.",
    };
  }

  // ZERO hits does NOT mean "nothing was created". AccountGroup and Type are the two
  // fields Acumatica may derive from the inventory item's posting class instead of
  // taking from the body — and both are part of the natural key, so a derived value
  // produces a real line under a key we did not ask for. Look for it by the two parts
  // Acumatica cannot reinterpret (task + inventory) before concluding nothing exists,
  // or the message sends someone hunting for a missing line that is sitting right there
  // under a different account group.
  let line = hits[0];
  if (!line) {
    const near = after.filter(
      (l) => l.taskId === spec.projectTaskId && l.inventoryId === spec.inventoryId
    );
    if (near.length === 0) {
      return {
        ok: false, action: "create_unverified", key: spec.key, amount, count: 0,
        message:
          "The create returned success but no GENO/REFERRAL line came back on the re-read at " +
          "all. Do not re-push until someone has looked at the project.",
      };
    }
    // Fall through to the field checks with the near-match, which will report exactly
    // WHICH key part Acumatica changed.
    line = near[0];
  }

  const mismatches = [];
  if (!line.id) mismatches.push("the created line came back without a guid, so nothing can update it later");
  if (round2(numOf(line.originalBudgetedAmount)) !== round2(amount))
    mismatches.push(`amount is ${line.originalBudgetedAmount}, expected ${amount}`);
  // The two derived-field checks. If either fires, the line is REAL but keyed
  // differently, so the mapping row would never match it again and the next push would
  // try to create a second one. Settling whether Acumatica does this is the entire
  // purpose of the sandbox hand-proof runbook.
  if (line.accountGroup !== spec.accountGroup)
    mismatches.push(`AccountGroup came back "${line.accountGroup}", expected "${spec.accountGroup}" — the line exists but under key "${line.key}", which the mapping will never match`);
  if (line.type !== spec.type)
    mismatches.push(`Type came back "${line.type}", expected "${spec.type}" — the line exists but under key "${line.key}", which the mapping will never match`);

  if (mismatches.length > 0) {
    return {
      ok: false, action: "create_unverified", key: spec.key, amount, lineId: line.id, mismatches,
      message:
        "A referral line was created but does not match the expected shape: " +
        mismatches.join("; ") +
        ". It exists in Acumatica — review it rather than re-pushing.",
    };
  }

  return { ok: true, action: "created", key: spec.key, lineId: line.id, amount, uom: line.uom, type: line.type };
}

// Write the budget outputs onto the project's EXISTING scaffolded ProjectBudget
// lines. Re-reads the scaffold FRESH in this run (guids never cached/stale),
// re-matches, and ABORTS LOUDLY before any PUT on: 0 scaffold lines, any match
// problem (a key hitting ≠ 1 line), or an income line with no amount source.
//
// Per matched group: amount = sum of its amountField(s) (composites split);
// expense lines whose amount is 0 are SKIPPED (left as-is); income lines are ALWAYS
// written. HOUR lines (per the live scaffold UOM) also write OriginalBudgetedQty
// from their hours source. Re-push is SAFE BY CONSTRUCTION — every write is an
// idempotent update-by-GUID of an existing line (no inserts, deterministic values).
//
// dryRun computes every per-line amount/qty and returns them WITHOUT any PUT.
//
// @param {string} acumaticaProjectId
// @param {object} budgetValues - { <Sundial_Solar__c field>: number } (see budgetFieldNames)
// @param {{ dryRun?: boolean }} [opts]
export async function writeBudgetLines(acumaticaProjectId, budgetValues, opts = {}) {
  const { dryRun = false } = opts;

  // 1) FRESH scaffold read — guids come from THIS run only.
  const lines = await readProjectBudgetLines(acumaticaProjectId);
  if (lines.length === 0) {
    return {
      ok: false,
      aborted: "no_scaffolded_lines",
      acumaticaProjectId,
      message: "ProjectBudget returned 0 lines — never create lines from scratch.",
    };
  }

  // 1z) V2-ENGINE GUARD — the rollout guard. Runs FIRST, before anything else looks at
  // an amount, because if this fails every number below is from the wrong engine.
  //
  // v3 mapping against v1-calculated numbers is the dangerous combination during the
  // rollout window, and it is dangerous SILENTLY: the keys all still match, so the push
  // succeeds and posts a plausible, wrong budget. Concretely a v1 record would post
  // GENO without CO fee and permit (they lived in separate v1 fields that v3 no longer
  // reads), zero to the four D11 standalone lines, and nothing to SLPC OUT — because
  // Internal_Rep_Commission_Amt__c and friends are simply blank on a v1 record.
  //
  // Commission_Deal_Type__c is the marker: ONLY budgetCalc v2/v3 writes it. Blank means
  // v1 (or never calculated). The test is EMPTINESS, not "one of the three labels" —
  // 'None' is a legitimate stored value on a record calculated before D19 (the old rule
  // produced it when neither rep PPW was populated), and such a record is still a v2
  // record whose amounts this mapping can read. Under D19 the calc emits only
  // '3rd Party' or 'Internal', because a blank sales company now throws instead.
  const dealTypeMarker = String(budgetValues?.Commission_Deal_Type__c ?? "").trim();
  if (dealTypeMarker === "") {
    return {
      ok: false,
      aborted: "budget_calculated_by_previous_engine",
      acumaticaProjectId,
      message:
        "Budget was calculated with the previous engine — run Recalculate Budget first.",
      detail:
        "Commission_Deal_Type__c is blank. Only budgetCalc v2 sets it, so the stored " +
        "budget values on this record predate the v2 engine and do not populate the v3 " +
        "mapping's lines (SLPC OUT, the four SUBCON/SOFTWARE/REFERRAL lines, and the " +
        "combined GENO figure). Pushing them would post a plausible but wrong budget.",
    };
  }

  // 1a) DEAL-TYPE GUARD — defense in depth.
  //
  // Under D19 the calc routes ONE commission amount to ONE of the two lines by sales
  // company, so it cannot itself produce both. This guard is therefore purely about
  // STORED amounts being stale or foreign: a record calculated under the old D16 rule,
  // a half-finished migration, or anything writing the fields other than the calc. Two
  // non-zero rep amounts would post commission to BOTH the SLPC OUT and SLPC lines —
  // paying the same commission twice in the budget — and skip-zero would not catch it,
  // because neither is zero. Refuse.
  const thirdPartyAmt = numOf(budgetValues?.Sales_Rep_Commission_Amt__c);
  const internalAmt = numOf(budgetValues?.Internal_Rep_Commission_Amt__c);
  if (thirdPartyAmt > 0 && internalAmt > 0) {
    return {
      ok: false,
      aborted: "commission_deal_type_ambiguous",
      acumaticaProjectId,
      message:
        `Both Sales_Rep_Commission_Amt__c (${thirdPartyAmt}, 3rd party) and ` +
        `Internal_Rep_Commission_Amt__c (${internalAmt}) are non-zero. A deal is either ` +
        "third-party or internal (D16) and they post to different budget lines; writing " +
        "both would double-pay the commission. Recalculate the budget — the calc rejects " +
        "this input — then re-push.",
    };
  }

  // 1b) PENDING-HARVEST GUARD — a line we cannot key yet must not be silently dropped.
  //
  // The DC rebate is the live case: its 4-part key is unknown until an RSDC scaffold is
  // harvested. On a plain RS job the amount is 0 and this is a no-op. On an RSDC job it
  // is real income (0.45 × watts), and pushing without it would understate revenue by
  // thousands with nothing in the output to say so.
  const pendingWithValue = PENDING_HARVEST_ROWS
    .map((r) => ({ row: r, amount: sumFields([r.amountField], budgetValues) }))
    .filter((p) => p.amount !== 0);
  if (pendingWithValue.length > 0) {
    return {
      ok: false,
      aborted: "pending_harvest_line_has_value",
      acumaticaProjectId,
      message:
        "A budget line whose Acumatica key is still unknown has a non-zero amount, so " +
        "pushing would silently drop it. Harvest the key from an RSDC scaffold " +
        "(reconcile), fill it into PENDING_HARVEST_ROWS, and move the row into " +
        "MAPPING_ROWS.",
      lines: pendingWithValue.map((p) => ({ line: p.row.line, amount: p.amount, source: p.row.amountField })),
    };
  }

  // 2) Re-match against the fresh read. Any key not matching exactly one line
  //    aborts BEFORE any PUT.
  // budgetValues IS passed here (unlike reconcile) so the matcher can apply skip-zero
  // before requiring a line — see matchMappingToLines' header.
  const { matched, problems, inactive, toCreate } = matchMappingToLines(MAPPING_ROWS, lines, budgetValues);
  if (problems.length > 0) {
    return { ok: false, aborted: "match_problems", acumaticaProjectId, problems, inactive };
  }

  // 3) Income lines are always written, so their amount source must exist. Refuse
  //    a real write that would otherwise post 0 to an income line.
  const incomeNoSource = matched
    .filter((g) => g.type === "Income" && g.amountFields.length === 0)
    .map((g) => g.rows.join(" + "));
  if (incomeNoSource.length > 0 && !dryRun) {
    return {
      ok: false,
      aborted: "income_amount_source_unresolved",
      acumaticaProjectId,
      message:
        "Income line(s) have no amountField in MAPPING_ROWS; refusing to write 0 to income. " +
        "Fill the amount source for: " + incomeNoSource.join(", "),
    };
  }

  // 4) Per group: compute, then (dry-run record | PUT).
  const results = [];
  let written = 0;
  let skipped = 0;
  let failed = 0;
  let created = 0;

  // 3b) D20 LINE CREATION — before the update loop, and deliberately so.
  //
  // A create that fails verification is the one outcome where the project may be left in
  // a state nobody has looked at, so it must not be buried under twenty successful
  // updates. Doing it first means a failure here aborts with NOTHING else written, which
  // is the state easiest to reason about from the outside.
  //
  // `toCreate` is empty unless the gate is open (see rule 3b in the matcher), so on the
  // shipped configuration this whole block is dead code. That is intentional: the code
  // path is here, tested, and reviewable, and turning it on is one literal.
  for (const c of toCreate) {
    if (c.key !== REFERRAL_LINE_KEY) {
      // Unreachable via the matcher, which already checks this. Kept because "unreachable"
      // is a property of today's code and this is the boundary of the create capability.
      return {
        ok: false, aborted: "create_not_permitted", acumaticaProjectId,
        message: `Only ${REFERRAL_LINE_KEY} may be created by this integration; refused ${c.key}.`,
      };
    }
    if (dryRun) {
      results.push({ key: c.key, action: "would_create", amount: c.amount, rows: c.rows, spec: REFERRAL_CREATE_SPEC });
      continue;
    }
    const res = await createReferralLineAndVerify(acumaticaProjectId, c.amount);
    results.push({ ...res, rows: c.rows });
    if (!res.ok) {
      // Abort the whole push. Not a per-line `failed++`: an unverified create means the
      // project's shape is unknown, and continuing to write to it would be guessing.
      return {
        ok: false, aborted: "referral_line_create_failed", acumaticaProjectId,
        message: res.message || res.reason, create: res, results, inactive,
      };
    }
    created++;
  }
  for (const g of matched) {
    const isIncome = g.type === "Income";
    // Write OriginalBudgetedQty only when the line has an actual hours source in the
    // mapping (GENA/S1/S2/S3). HOUR lines with no source (ROOFCOM piece-rate, Labor
    // Burden) get amount only — we never overwrite the scaffold qty with a bogus 0.
    const hasQty = g.uom === "HOUR" && g.hoursFields.length > 0;
    const amount = sumFields(g.amountFields, budgetValues);
    const qty = hasQty ? sumFields(g.hoursFields, budgetValues) : null;
    // "computed" = the amount is DERIVED, not a plain field/sum — i.e. any spec uses
    // subtraction (BALANCE = Contract_Amount__c - Total_Material_Budget__c). Surfaced
    // in dry-run so a reviewer can see which lines are calculated vs. read straight.
    const computed = g.amountFields.some((s) => s.includes("-"));
    const amountExpr = computed ? g.amountFields.join(" + ") : null;

    // Skip-zero: expense lines at 0 are left as-is; income is always written.
    if (!isIncome && amount === 0) {
      skipped++;
      results.push({ key: g.key, lineId: g.lineId, action: "skip_zero", amount: 0, uom: g.uom, type: g.type, rows: g.rows });
      continue;
    }

    const body = { id: g.lineId, OriginalBudgetedAmount: { value: amount } };
    if (hasQty) body.OriginalBudgetedQty = { value: qty };

    if (dryRun) {
      results.push({
        key: g.key, lineId: g.lineId, action: "would_write",
        amount, ...(hasQty ? { qty } : {}), uom: g.uom, type: g.type, rows: g.rows,
        ...(computed ? { computed: true, amountExpr } : {}),
        ...(isIncome && g.amountFields.length === 0 ? { needsAmountSource: true } : {}),
      });
      continue;
    }

    console.log(
      `budget-push PUT ${g.key} guid=${g.lineId} amount=${amount}` +
        (hasQty ? ` qty=${qty}` : "")
    );
    const put = await putBudgetLineWithRetry(body);
    if (put.ok) {
      written++;
      results.push({ key: g.key, lineId: g.lineId, action: "written", amount, ...(hasQty ? { qty } : {}), uom: g.uom, status: put.status });
    } else {
      failed++;
      results.push({ key: g.key, lineId: g.lineId, action: "failed", amount, status: put.status, error: put.text });
    }
  }

  return {
    ok: failed === 0,
    dryRun,
    acumaticaProjectId,
    summary: {
      matchedGroups: matched.length,
      written,
      skipped,
      failed,
      // D20: lines this run added rather than updated. Expected to be 0 on essentially
      // every push — a non-zero value means a job carried a referral fee onto a project
      // that had no line for it.
      created,
      // Rows correctly doing nothing on this project (absent optional line, or a zero
      // expense with no line). Reported so a missing line is visible rather than just
      // absent from the output.
      inactive: inactive.length,
    },
    results,
    inactive,
  };
}

// Resolve an Acumatica ProjectID from a Sundial_Solar__c record id (read-only).
async function projectIdForRecord(recordId) {
  const soql =
    `SELECT Acumatica_Project_ID__c FROM ${SOLAR_SF_OBJECT} ` +
    `WHERE Id = '${soqlEscapeString(recordId)}' LIMIT 1`;
  const rows = await sfQuery(soql);
  return rows && rows.length ? rows[0].Acumatica_Project_ID__c : null;
}

// --- handler: dispatch by invocation shape ---------------------------------
// Ways this Lambda is entered:
//   1. Async worker self-invoke  -> event.__worker === true       (handleWorker)
//   2. Dry-run write (direct)    -> event.dryRunWrite === true    (handleDryRunWrite)
//   3. Attribute-only (direct)   -> event.attributesSync === true (runAttributeOnlySync)
//   4. API Gateway HTTP request  -> event.requestContext etc.     (handleHttp*)
//   5. Direct payload (reconcile) -> { recordId | acumaticaProjectId } (handleReconcile)
// The reconcile path is UNCHANGED from before; HTTP + worker are the write path.
function isHttpEvent(event) {
  return !!(
    event &&
    (event.requestContext || event.httpMethod || event.routeKey || event.rawPath)
  );
}

/**
 * Which HTTP route this event is for.
 *
 * Matched on the PATH rather than on a pathParameter, because both routes carry the same
 * `{recordId}` and would otherwise be indistinguishable — a push request landing in the
 * attribute handler would silently do a fraction of what the user asked for. The resource
 * path is checked across every shape API Gateway REST and HTTP APIs use for it.
 */
export function isAttributesSyncRoute(event) {
  const path =
    event?.resource ||
    event?.routeKey ||
    event?.requestContext?.resourcePath ||
    event?.requestContext?.http?.path ||
    event?.rawPath ||
    event?.path ||
    "";
  return /\/budget\/attributes-sync\/?$/.test(String(path));
}

export const handler = async (event) => {
  if (event && event.__worker === true) return handleWorker(event);
  if (event && event.dryRunWrite === true) return handleDryRunWrite(event);
  // Direct-invoke equivalent of the HTTP route. No token, so no tenant scoping is
  // possible — this is an operator/back-office entry point, same trust level as the
  // reconcile and dry-run payloads next to it.
  if (event && event.attributesSync === true) {
    return runAttributeOnlySync(event.recordId, event.tenantId ?? null);
  }
  if (isHttpEvent(event)) {
    return isAttributesSyncRoute(event) ? handleAttributesSyncHttp(event) : handleHttp(event);
  }
  return handleReconcile(event);
};

// --- Dry-run write (direct invoke, READ-ONLY) ------------------------------
// Payload: { dryRunWrite:true, recordId:"<Sundial_Solar__c Id>" } (preferred — pulls
// the record's real budget values), or { dryRunWrite:true, acumaticaProjectId:"R269999" }
// (project only; values default to 0). Computes every per-line amount/qty exactly as a
// real push would and returns them WITHOUT any PUT and WITHOUT any SF write-back. The
// runbook's pre-push check. No gates — it's a read.
async function handleDryRunWrite(event) {
  try {
    let acumaticaProjectId = event.acumaticaProjectId || null;
    let budgetValues = {};
    if (event.recordId) {
      const fields = budgetFieldNames();
      const soql =
        `SELECT Acumatica_Project_ID__c, ${fields.join(", ")} FROM ${SOLAR_SF_OBJECT} ` +
        `WHERE Id = '${soqlEscapeString(event.recordId)}' LIMIT 1`;
      const rows = await sfQuery(soql);
      if (!rows || rows.length === 0) return { ok: false, error: "record_not_found" };
      budgetValues = rows[0];
      acumaticaProjectId =
        acumaticaProjectId || String(rows[0].Acumatica_Project_ID__c || "").trim();
    }
    if (!acumaticaProjectId) {
      return {
        ok: false,
        error: "no_project_id",
        message: "Provide recordId (with Acumatica_Project_ID__c set) or acumaticaProjectId.",
      };
    }
    const result = await writeBudgetLines(acumaticaProjectId, budgetValues, { dryRun: true });
    return { mode: "dry_run_write", ...result };
  } catch (err) {
    console.error("budget-push dry-run error:", err?.message || String(err));
    return { ok: false, error: "server_error", message: err?.message || String(err) };
  }
}

// --- HTTP: POST /projects/{recordId}/budget/push ---------------------------
// Validates the gates, flips Budget_Push_Status__c to 'Pushing', fires the async
// worker, and returns 202. Never does the Acumatica writes on the HTTP leg (API
// Gateway caps at ~29s; the worker gets the full function timeout).
async function handleHttp(event) {
  const method = httpMethod(event);
  const headers = normalizeHeaders(event?.headers);
  const cors = corsHeaders(headers["origin"]);

  if (method === "OPTIONS") return { statusCode: 204, headers: cors, body: "" };
  if (method !== "POST") {
    return jsonResponse(405, cors, { error: "method_not_allowed", code: "METHOD_NOT_ALLOWED" });
  }

  const pp = event?.pathParameters || {};
  const recordId = pp.recordId ? decodeURIComponent(pp.recordId) : null;
  if (!recordId || !/^[a-zA-Z0-9]{15,18}$/.test(recordId)) {
    return jsonResponse(400, cors, {
      error: "invalid_record_id",
      code: "INVALID_RECORD_ID",
      message: "Path must carry a Sundial_Solar__c record id.",
    });
  }

  // Auth — tenant derived ONLY from the verified token.
  let identity;
  try {
    identity = await resolveIdentity(headers["authorization"]);
  } catch (err) {
    const m = mapIdentityError(err?.code);
    if (m) return jsonResponse(m.status, cors, m.body);
    throw err;
  }
  const tenantId = identity.tenantId;
  if (!tenantId) return jsonResponse(403, cors, { error: "no_tenant", code: "NO_TENANT" });

  // Load the project TENANT-SCOPED with the two gate inputs + the linked customer's
  // Acumatica-sync flag. Not owned / missing is indistinguishable -> 404.
  const soql =
    `SELECT Id, Acumatica_Project_ID__c, Budget_Calc_Status__c, Commission_Deal_Type__c, ` +
    `Sundial_Customer__r.Synced_to_Acumatica__c ` +
    `FROM ${SOLAR_SF_OBJECT} ` +
    `WHERE Id = '${soqlEscapeString(recordId)}' ` +
    `AND Client__c = '${soqlEscapeString(tenantId)}' LIMIT 1`;
  const rows = await sfQuery(soql);
  if (!rows || rows.length === 0) {
    return jsonResponse(404, cors, { error: "not_found", code: "RECORD_NOT_FOUND" });
  }
  const rec = rows[0];
  const acumaticaProjectId = String(rec.Acumatica_Project_ID__c || "").trim();
  const calcStatus = rec.Budget_Calc_Status__c;
  const customerSynced = rec.Sundial_Customer__r?.Synced_to_Acumatica__c === true;

  // Gate 1: only push CALCULATED numbers — never Pending/Error/blank.
  if (calcStatus !== "Calculated") {
    return jsonResponse(409, cors, {
      error: "budget_not_calculated",
      code: "BUDGET_NOT_CALCULATED",
      message: `Budget_Calc_Status__c is '${calcStatus || "(blank)"}', must be 'Calculated'.`,
    });
  }
  // Gate 1b (v2 ROLLOUT GUARD): 'Calculated' does not say WHICH engine calculated it.
  // A record calculated before the v2 rollout still reads 'Calculated' but carries v1
  // numbers, which the v3 mapping would post as a plausible, wrong budget rather than
  // failing. Commission_Deal_Type__c is only ever written by budgetCalc v2.
  //
  // Checked HERE as well as in writeBudgetLines so the button gets an immediate, honest
  // 409 instead of a 202 followed by an async failure the user has to go find. The
  // deeper guard still stands for the worker / dry-run / direct-invoke paths.
  //
  // The fix is a click: Recalculate Budget, then Update Budget.
  if (String(rec.Commission_Deal_Type__c || "").trim() === "") {
    return jsonResponse(409, cors, {
      error: "budget_calculated_by_previous_engine",
      code: "BUDGET_CALCULATED_BY_PREVIOUS_ENGINE",
      message:
        "Budget was calculated with the previous engine — run Recalculate Budget first.",
    });
  }
  // Gate 2: the Acumatica project + budget scaffold must already exist (Layer 1).
  if (!customerSynced) {
    return jsonResponse(409, cors, {
      error: "customer_not_synced",
      code: "CUSTOMER_NOT_SYNCED",
      message: "Linked customer is not Synced_to_Acumatica__c=true; the Acumatica project/budget scaffold must exist first.",
    });
  }
  // Gate 3: need the project id to target.
  if (!acumaticaProjectId) {
    return jsonResponse(409, cors, {
      error: "no_acumatica_project",
      code: "NO_ACUMATICA_PROJECT",
      message: "Acumatica_Project_ID__c is blank; cannot target a ProjectBudget.",
    });
  }

  // Flip to 'Pushing' so the UI reflects in-flight state, then fire the worker.
  try {
    await sfUpdateRecord(SOLAR_SF_OBJECT, recordId, { Budget_Push_Status__c: "Pushing" });
  } catch (err) {
    console.error("budget-push: could not set Pushing status:", err?.message || String(err));
    return jsonResponse(502, cors, { error: "sf_update_failed", code: "SF_UPDATE_FAILED" });
  }

  try {
    await lambda.send(
      new InvokeCommand({
        FunctionName: SELF_FUNCTION_NAME,
        InvocationType: "Event", // async, fire-and-forget
        Payload: Buffer.from(
          JSON.stringify({ __worker: true, recordId, acumaticaProjectId, tenantId })
        ),
      })
    );
  } catch (err) {
    console.error("budget-push: self-invoke failed:", err?.message || String(err));
    // Roll the status back so the UI isn't stuck on 'Pushing'.
    try {
      await sfUpdateRecord(SOLAR_SF_OBJECT, recordId, {
        Budget_Push_Status__c: "Failed",
        Budget_Push_Error__c: "Async worker could not be started: " + (err?.message || String(err)),
      });
    } catch {}
    return jsonResponse(502, cors, { error: "worker_invoke_failed", code: "WORKER_INVOKE_FAILED" });
  }

  return jsonResponse(202, cors, {
    status: "Pushing",
    recordId,
    acumaticaProjectId,
    message: "Budget push started.",
  });
}

// --- Async worker: the actual read -> match -> write, then SF write-back -----
// Runs off the API Gateway clock. Reads the budget field values, writes the
// ProjectBudget lines, then records the outcome on the Solar record in ONE PATCH.
// Budget_Finalized__c is set true ONLY on success (idempotent — re-pushes leave it
// true). On any failure/abort it records the reason and leaves Finalized untouched.
async function handleWorker(event) {
  const { recordId, acumaticaProjectId, tenantId } = event;
  try {
    // Pull the fields the mapping references PLUS what the downstream stages read
    // (tenant-scoped defense-in-depth).
    const fields = workerFieldNames();
    const soql =
      `SELECT ${fields.join(", ")} FROM ${SOLAR_SF_OBJECT} ` +
      `WHERE Id = '${soqlEscapeString(recordId)}'` +
      (tenantId ? ` AND Client__c = '${soqlEscapeString(tenantId)}'` : "") +
      ` LIMIT 1`;
    const rows = await sfQuery(soql);
    if (!rows || rows.length === 0) {
      await markFailed(recordId, "Record not found or not owned by tenant during worker read.");
      return { ok: false, error: "record_not_found" };
    }

    const result = await writeBudgetLines(acumaticaProjectId, rows[0]);

    if (result.ok) {
      // Downstream stages run ONLY after the budget lines are safely written. A commission
      // PO raised against a budget that failed to push is a payment authorised for numbers
      // that are not in the plan.
      const downstream = await runDownstreamStages(recordId, acumaticaProjectId, rows[0]);
      result.downstream = downstream;

      await sfUpdateRecord(SOLAR_SF_OBJECT, recordId, {
        Budget_Push_Status__c: "Pushed",
        Budget_Pushed_At__c: new Date().toISOString(),
        // Non-null alongside 'Pushed' is a real and intended combination: the budget DID
        // push, and something after it did not. See runDownstreamStages.
        Budget_Push_Error__c: downstream.note,
        Budget_Finalized__c: true, // first success finalizes; re-push leaves it true
        // Stage E's own status, folded into this PATCH rather than sent as a second SF
        // call. Same three fields the attribute-only route writes, from the same mapping
        // function, so the two paths cannot describe the same outcome differently.
        ...(buildAttributeSyncWriteback(downstream.attributes) ?? {}),
      });
    } else {
      const failedKeys = (result.results || [])
        .filter((r) => r.action === "failed")
        .map((r) => `${r.key}(${r.status})`)
        .join(", ");
      const errMsg = result.aborted
        ? `aborted:${result.aborted} ${result.message || ""}`.trim()
        : `${result.summary?.failed || 0} line(s) failed: ${failedKeys}`;
      await markFailed(recordId, errMsg);
    }
    return result;
  } catch (err) {
    console.error("budget-push worker error:", err?.message || String(err));
    try {
      await markFailed(recordId, "worker exception: " + (err?.message || String(err)));
    } catch {}
    return { ok: false, error: "worker_exception", message: err?.message || String(err) };
  }
}

/**
 * Stage B (commission POs) and Stage E (project attributes), after a clean budget write.
 *
 * ---------------------------------------------------------------------------
 * WHY A DOWNSTREAM FAILURE DOES NOT FAIL THE BUDGET PUSH
 * ---------------------------------------------------------------------------
 * The budget lines are written. Reporting that as `Failed` would be untrue, would leave
 * `Budget_Finalized__c` false, and would make the next re-push redo work that succeeded.
 * The two stages also own their own reporting: the PO engine writes
 * Commission_PO_Status__c / Commission_PO_Error__c, which exist precisely so a refusal is
 * not "a log line nobody reads".
 *
 * So the status stays `Pushed` and the PROBLEM still surfaces, via a note on
 * Budget_Push_Error__c. `Pushed` with a non-null error is deliberate and means exactly
 * what it says: the budget pushed, and something after it needs a human.
 *
 * ⚠️ KNOWN GAP — the attribute stage has nowhere of its own to report. There is no
 * Attribute_Sync_Status__c / _Error__c pair (only the §4f PO fields were deployed), so a
 * failed attribute verification lives in this note and in CloudWatch. That is thinner
 * than the PO side and it is the next field package to build; it is not a reason to leave
 * the failure silent, which is why it is in the note at all.
 *
 * ---------------------------------------------------------------------------
 * NEITHER STAGE MAY THROW PAST THIS FUNCTION
 * ---------------------------------------------------------------------------
 * An exception here would land in the worker's catch and mark a SUCCESSFUL budget push as
 * failed. Each stage is therefore wrapped, and an exception is reported as that stage's
 * failure rather than the push's.
 *
 * JOBTYPE is deliberately NOT passed to the attribute sync. RS vs RSDC is authoritative at
 * Layer-1 creation and this worker only infers it from which lines the scaffold has —
 * inference is not authority. Omitting it means the merge leaves whatever Layer-1 wrote
 * intact, which is the correct outcome.
 */
export async function runDownstreamStages(recordId, acumaticaProjectId, values, deps = {}) {
  const runPos = deps.syncCommissionPos ?? syncCommissionPos;
  const runAttrs = deps.syncProjectAttributes ?? syncProjectAttributes;
  const problems = [];

  let pos = null;
  try {
    pos = await runPos(recordId, values);
    // `ok:false` with a benign reason (internal deal, no commission) is the system working
    // correctly and must not read as a problem — syncCommissionPos has already recorded
    // `None` on the record for those.
    if (pos && pos.ok === false && !["gate_closed", "internal_deal", "no_commission"].includes(pos.reason)) {
      problems.push(`commission POs: ${pos.message || pos.status || pos.reason || "failed"}`);
    }
  } catch (err) {
    console.error("commission-po stage threw:", err?.message || String(err));
    pos = { ok: false, reason: "exception", message: err?.message || String(err) };
    problems.push(`commission POs threw: ${pos.message}`);
  }

  let attrs = null;
  try {
    attrs = await runAttrs(acumaticaProjectId, values);
    if (attrs && attrs.ok === false && attrs.action !== "blocked") {
      problems.push(`attributes: ${attrs.message || attrs.reason || attrs.action}`);
    }
  } catch (err) {
    console.error("attribute-sync stage threw:", err?.message || String(err));
    attrs = { ok: false, action: "exception", message: err?.message || String(err) };
    problems.push(`attributes threw: ${attrs.message}`);
  }

  return {
    ok: problems.length === 0,
    commissionPos: pos,
    attributes: attrs,
    // null clears the field on a clean run, which is what Budget_Push_Error__c's contract
    // has always been.
    note: problems.length === 0 ? null : `Budget lines pushed OK. ${problems.join(" | ")}`.slice(0, 32000),
  };
}

// ===========================================================================
// ATTRIBUTE-ONLY SYNC — for legacy and non-budgeted projects
// ===========================================================================
//
// Harmon has projects that will never go through the budget push: jobs that predate the
// integration, jobs budgeted by hand, jobs from before the v2 calc. Their Acumatica
// attributes still need the lifecycle dates and system size kept current, because that is
// what Harmon's accounting reporting reads.
//
// ---------------------------------------------------------------------------
// ONE GATE, AND ONLY ONE: the record must be linked to an Acumatica project
// ---------------------------------------------------------------------------
// No Budget_Calc_Status__c check, no Commission_Deal_Type__c guard, no deal-type logic.
// Those exist to stop a WRONG BUDGET being posted, and this path posts no budget. A legacy
// record legitimately has a blank calc status and a blank deal type; refusing it for that
// would be refusing exactly the records this exists to serve.
//
// ---------------------------------------------------------------------------
// WHAT PROTECTS A LEGACY PROJECT'S HAND-ENTERED COMMISSION FIGURES
// ---------------------------------------------------------------------------
// Three independent things, and it is worth being able to name all three:
//
//   1. SCOPE — only NON_COMMISSION_ATTRIBUTES are built. SLSCOM/MGRCOM/MGMTOR are never
//      in the body. The filter lives inside buildProjectAttributes, so a caller cannot
//      forget it.
//   2. MERGE — a partial Attributes PUT leaves what it did not send alone (D24, proved by
//      hand). An attribute we do not send is not touched, not blanked.
//   3. OMIT-BLANKS — a field with no value is left out entirely rather than sent as "",
//      so an empty legacy record cannot blank anything at all.
//
// Any one of the three would do it. Together they mean this path is incapable of
// disturbing a figure Harmon typed in, which is the whole reason it is safe to point at
// records the integration knows nothing about.
//
// Verification is still mandatory — an unknown AttributeID gets a 200 and is silently
// discarded (D-060), and that is exactly as true here as on the push path.

/**
 * Read the record, sync its non-commission attributes, record the outcome.
 *
 * @param {string} recordId - Sundial_Solar__c id
 * @param {string|null} tenantId - when present, scopes the read (defense in depth)
 */
export async function runAttributeOnlySync(recordId, tenantId = null, deps = {}) {
  const runAttrs = deps.syncProjectAttributes ?? syncProjectAttributes;
  const update = deps.sfUpdateRecord ?? sfUpdateRecord;
  const query = deps.sfQuery ?? sfQuery;
  const now = deps.now ?? (() => new Date().toISOString());

  const fields = ["Acumatica_Project_ID__c", ...nonCommissionFieldNames()];
  const soql =
    `SELECT ${fields.join(", ")} FROM ${SOLAR_SF_OBJECT} ` +
    `WHERE Id = '${soqlEscapeString(recordId)}'` +
    (tenantId ? ` AND Client__c = '${soqlEscapeString(tenantId)}'` : "") +
    ` LIMIT 1`;
  const rows = await query(soql);
  if (!rows || rows.length === 0) {
    return { ok: false, error: "record_not_found", code: "RECORD_NOT_FOUND" };
  }

  const acumaticaProjectId = String(rows[0].Acumatica_Project_ID__c || "").trim();
  if (!acumaticaProjectId) {
    // The one gate. Reported without touching the sync fields: a record that was never
    // linked to Acumatica has not had a failed sync, it has had no sync.
    return {
      ok: false,
      error: "no_acumatica_project",
      code: "NO_ACUMATICA_PROJECT",
      message: "Acumatica_Project_ID__c is blank; there is no project to sync attributes to.",
    };
  }

  const result = await runAttrs(acumaticaProjectId, rows[0], { only: NON_COMMISSION_ATTRIBUTES });

  const writeback = buildAttributeSyncWriteback(result, now());
  if (writeback) {
    try {
      await update(SOLAR_SF_OBJECT, recordId, writeback);
    } catch (err) {
      // The Acumatica write already happened; failing to record it is a reporting
      // problem, not a data problem, and must not be reported as the sync failing.
      console.error("attribute-only sync: write-back failed:", err?.message || String(err));
      return { ...result, acumaticaProjectId, writebackFailed: err?.message || String(err) };
    }
  }
  return { ...result, acumaticaProjectId };
}

// --- HTTP: POST /projects/{recordId}/budget/attributes-sync ----------------
//
// SYNCHRONOUS, unlike the budget push next door, and that is a considered difference
// rather than an inconsistency. The push self-invokes because it writes ~20 budget lines
// with retries and can genuinely approach API Gateway's ~29s cap. This does one SOQL, one
// Acumatica read, one PUT, one verifying re-read and one SF update — five round trips,
// nowhere near the limit. Making it async would buy nothing and cost the caller an
// immediate answer, forcing the UI to poll a status field to learn what a single PUT did.
//
// If the shape ever changes — batching many records, say — this is the first thing to
// revisit, and the worker pattern above is the template.
async function handleAttributesSyncHttp(event) {
  const method = httpMethod(event);
  const headers = normalizeHeaders(event?.headers);
  const cors = corsHeaders(headers["origin"]);

  if (method === "OPTIONS") return { statusCode: 204, headers: cors, body: "" };
  if (method !== "POST") {
    return jsonResponse(405, cors, { error: "method_not_allowed", code: "METHOD_NOT_ALLOWED" });
  }

  const pp = event?.pathParameters || {};
  const recordId = pp.recordId ? decodeURIComponent(pp.recordId) : null;
  if (!recordId || /^[a-zA-Z0-9]{15,18}$/.test(recordId) === false) {
    return jsonResponse(400, cors, {
      error: "invalid_record_id",
      code: "INVALID_RECORD_ID",
      message: "Path must carry a Sundial_Solar__c record id.",
    });
  }

  // Auth — tenant derived ONLY from the verified token, same as every other route.
  let identity;
  try {
    identity = await resolveIdentity(headers["authorization"]);
  } catch (err) {
    const m = mapIdentityError(err?.code);
    if (m) return jsonResponse(m.status, cors, m.body);
    throw err;
  }
  const tenantId = identity.tenantId;
  if (!tenantId) return jsonResponse(403, cors, { error: "no_tenant", code: "NO_TENANT" });

  try {
    const result = await runAttributeOnlySync(recordId, tenantId);
    if (result.error === "record_not_found") {
      // Not owned and not existing are deliberately indistinguishable.
      return jsonResponse(404, cors, { error: "not_found", code: "RECORD_NOT_FOUND" });
    }
    if (result.error === "no_acumatica_project") {
      return jsonResponse(409, cors, { error: result.error, code: result.code, message: result.message });
    }
    return jsonResponse(result.ok ? 200 : 502, cors, {
      mode: "attributes_sync",
      ok: result.ok,
      action: result.action,
      acumaticaProjectId: result.acumaticaProjectId,
      written: result.written ?? 0,
      omitted: result.omitted ?? [],
      missing: result.missing ?? [],
      mismatched: result.mismatched ?? [],
      message: result.message,
      writebackFailed: result.writebackFailed,
    });
  } catch (err) {
    console.error("attributes-sync error:", err?.message || String(err));
    return jsonResponse(500, cors, { error: "server_error", code: "SERVER_ERROR" });
  }
}

// Record a failed push. Budget_Finalized__c is deliberately NOT touched here.
async function markFailed(recordId, message) {
  await sfUpdateRecord(SOLAR_SF_OBJECT, recordId, {
    Budget_Push_Status__c: "Failed",
    Budget_Push_Error__c: String(message).slice(0, 32000),
  });
}

// --- RECONCILE (read-only) -------------------------------------------------
// Input: { recordId } (Sundial_Solar__c) or { acumaticaProjectId }. Returns the
// existing lines + the mapping match result for the Gate 5a table. No writes.
async function handleReconcile(event) {
  const body =
    event && typeof event === "object" && !event.Records ? event : {};
  let acumaticaProjectId = body.acumaticaProjectId || null;
  try {
    if (!acumaticaProjectId && body.recordId) {
      acumaticaProjectId = await projectIdForRecord(body.recordId);
    }
    if (!acumaticaProjectId) {
      return { ok: false, error: "no_project_id", message: "Provide acumaticaProjectId or a recordId with Acumatica_Project_ID__c set." };
    }

    const lines = await readProjectBudgetLines(acumaticaProjectId);
    if (lines.length === 0) {
      // Per spec: zero lines means the project wasn't created / scaffold failed.
      return { ok: false, error: "no_scaffolded_lines", acumaticaProjectId, message: "ProjectBudget returned 0 lines — project not created or scaffold failed. Do NOT create lines from scratch." };
    }

    // No budgetValues: a purely STRUCTURAL check. Every non-optional row must match.
    const { matched, problems, inactive } = matchMappingToLines(MAPPING_ROWS, lines);
    return {
      ok: true,
      mode: "reconcile_read_only",
      acumaticaProjectId,
      lineCount: lines.length,
      lines, // full existing scaffold, keyed by natural key + GUID
      mappingMatch: {
        matchedCount: matched.length,
        matched,
        problems,
        // Expected-absent rows. On an RS project this should be exactly the DC rebate
        // (no DCREBATE line on that template) and Referral Fees (D20: never in the
        // template — the push creates it on demand). Anything else here wants explaining.
        inactive,
      },
      gates: [
        "problems must be EMPTY. A provisional key that matches nothing shows up here.",
        "inactive should contain ONLY: 'Income - DC Rebate (RSDC only)' on an RS project, and 'Referral Fees' on any project that has never carried a referral fee (D20: Harmon is NOT adding the line to the templates; the push creates it when a job needs it).",
        "An RSDC project must show DCREBATE | BILLING | <N/A> | Income in matched, not inactive.",
        "Harmon sign-off on the setter commission -> APPT COM (LABOR/SALESCOMM) mapping (PENDING_HARMON_SIGNOFF).",
        "Q12c: confirm the DLR dealer-fee expense line is correct, given the calc already nets the dealer fee out of Balance of Revenue.",
        "The push itself additionally refuses v1-calculated records (blank Commission_Deal_Type__c) and records with both rep commission amounts set.",
      ],
    };
  } catch (err) {
    console.error("acumatica-budget-push reconcile error:", err?.message || String(err));
    return { ok: false, error: "server_error", message: err?.message || String(err) };
  }
}
