// sundial-acumatica-budget-push — Acumatica ProjectBudget population (Layer 2).
//
// STATUS: READ + RECONCILE SCAFFOLDING ONLY. The GUID-write path is intentionally
// NOT finalized and is hard-guarded off (see writeBudgetLines) pending TWO items
// the reconciliation on a live TEST project must resolve first:
//   (A) The mapping tab (docs/Sundial_Solar_Budget_Fields.xlsx » Acumatica Mapping)
//       carries NO InventoryID column. The match key ProjectTaskID+AccountGroup+
//       InventoryID+Type is therefore NOT unique on the mapping side — SLPC (x2),
//       GENO (x3), BURDENEXR (x2) collide without it. InventoryID must be added to
//       the mapping before any write. See docs/integrations/acumatica-budget-push.md.
//   (B) The mapping's income row uses task code BILL, but the live scaffold was
//       reported to carry income on BALANCE + GENM/BILLING with NO BILL task.
//       The income code must be confirmed before writing that line.
//
// WHAT THIS DOES NOW (safe, read-only): given a Salesforce Sundial_Solar__c record
// (or an Acumatica ProjectID), read the EXISTING scaffolded ProjectBudget lines
// (GET $filter, URL-encoded) and return them keyed by the full natural key + GUID
// `id` — the raw material for the Gate 5a reconciliation table. It does NOT create,
// update, or delete anything in Acumatica.
//
// The eventual write path (Layer 2, after Gate 5a): match each of the 17 mapping
// rows to EXACTLY ONE existing line by ProjectTaskID+AccountGroup+InventoryID+Type,
// then PUT /ProjectBudget/{id} updating OriginalBudgetedAmount (+ OriginalBudgetedQty
// / UOM=HOUR on labor lines). Updates by GUID — never key-upsert, never insert.

import { getAcumaticaEntity } from "../../lib/acumatica.js";
import { sfQuery, soqlEscapeString } from "../../lib/salesforce.js";

const PROJECT_BUDGET_ENTITY = "ProjectBudget";
const SOLAR_SF_OBJECT = "Sundial_Solar__c";

// --- The 17 mapping rows (from the Acumatica Mapping tab) -------------------
// inventoryId is null for EVERY row because the mapping tab has no InventoryID
// column (blocker A). Filling these in is a prerequisite to the write path — the
// matcher fails loudly while they are null. amountField/hours are informational
// here (used by the write path later). "(confirm)" codes are isolated in
// UNCONFIRMED so they are never guessed.
export const UNCONFIRMED = {
  // Sheet shows no task code for the Geo commission row — confirm with finance.
  geoCommissionTaskId: null, // TODO(Harmon): Geo commission task code — DO NOT GUESS
  // Dealer fee resolved: DLR is the Dealer-fee line (per the scaffold reference).
};

export const MAPPING_ROWS = [
  // line, taskId, accountGroup, type, inventoryId, amountField, hoursField, note
  // INCOME = TWO lines (there is NO BILL task; it was removed). Both are Income;
  // GENM/BILLING/Income is DISTINCT from GENM/MATERIAL/Expense (material cost)
  // via AccountGroup + Type, so the 4-part key separates them. Account groups,
  // InventoryIDs, and the amount split come from the live scaffold at Gate 5a.
  { line: "Income - Balance of Contract", taskId: "BALANCE", accountGroup: null, type: "Income", inventoryId: null, amountField: null, hoursField: null, note: "Income 1 of 2. Amount source + AccountGroup + InventoryID TBD from live scaffold (Gate 5a)." },
  { line: "Income - Solar Material", taskId: "GENM", accountGroup: "BILLING", type: "Income", inventoryId: null, amountField: null, hoursField: null, note: "Income 2 of 2. GENM/BILLING/Income (not the GENM/MATERIAL cost line). Amount source + InventoryID TBD (Gate 5a)." },
  { line: "Dealer Fee", taskId: "DLR", accountGroup: null, type: "Expense", inventoryId: null, amountField: "Dealer_Fee__c", hoursField: null, note: "DLR is the Dealer-fee line (confirmed). Only send when > 0. AccountGroup/InventoryID from scaffold." },
  { line: "Sales Rep Commission", taskId: "SLPC", accountGroup: "SALESCOMM", type: "Expense", inventoryId: null, amountField: "Sales_Rep_Commission_Amt__c", hoursField: null, note: "SLPC collides with Overhead row — InventoryID required to disambiguate." },
  { line: "Sales Manager Commission", taskId: "SLMC", accountGroup: "SALESCOMM", type: "Expense", inventoryId: null, amountField: "Sales_Mgr_Commission_Amt__c", hoursField: null },
  { line: "Geo Commission", taskId: null, accountGroup: "SALESCOMM", type: "Expense", inventoryId: null, amountField: "Geo_Commission_Amount__c", hoursField: null, note: "Task code unconfirmed (UNCONFIRMED.geoCommissionTaskId)." },
  { line: "Overhead Commission", taskId: "SLPC", accountGroup: "SALESCOMM", type: "Expense", inventoryId: null, amountField: "Overhead_Commission_Amt__c", hoursField: null, note: "SLPC collides with Sales Rep row — InventoryID required." },
  { line: "Commission Burden", taskId: "BURDENEXR", accountGroup: "SALESCOMM", type: "Expense", inventoryId: null, amountField: "Commission_Burden_Amt__c", hoursField: null, note: "BURDENEXR collides with Labor Burden — differs by account group." },
  { line: "Audit + QA Labor", taskId: "GENA", accountGroup: "LABOR", type: "Expense", inventoryId: null, amountField: "Audit_Labor_Cost__c+QA_Labor_Cost__c", hoursField: "GENA_Hours__c", note: "UOM=HOUR." },
  { line: "Roofing Labor", taskId: "ROOFCOM", accountGroup: "LABOR", type: "Expense", inventoryId: null, amountField: "Roofing_Labor_Cost__c", hoursField: null },
  { line: "S1 Install Labor", taskId: "S1", accountGroup: "LABOR", type: "Expense", inventoryId: null, amountField: "S1_Labor_Cost__c", hoursField: "S1_Hours__c" },
  { line: "S2 Install Labor", taskId: "S2", accountGroup: "LABOR", type: "Expense", inventoryId: null, amountField: "S2_Labor_Cost__c", hoursField: "S2_Hours__c" },
  { line: "S3 Labor (Battery + Adders)", taskId: "S3", accountGroup: "LABOR", type: "Expense", inventoryId: null, amountField: "S3_Labor_Cost__c", hoursField: "S3_Hours__c" },
  { line: "Labor Burden", taskId: "BURDENEXR", accountGroup: "(RESIDENTIAL)", type: "Expense", inventoryId: null, amountField: "Total_Labor_Burden_Budget__c", hoursField: null, note: "BURDENEXR collides with Commission Burden — differs by account group." },
  { line: "Total Material", taskId: "GENM", accountGroup: "MATERIAL", type: "Expense", inventoryId: null, amountField: "Total_Material_Budget__c", hoursField: null },
  { line: "Other Material", taskId: "GENO", accountGroup: "OTHER", type: "Expense", inventoryId: null, amountField: "Total_Other_Budget__c", hoursField: null, note: "GENO collides with CO Fee + Permit — InventoryID required." },
  { line: "Constructive Ops Fee", taskId: "GENO", accountGroup: "OTHER", type: "Expense", inventoryId: null, amountField: "Constructive_Ops_Fee__c", hoursField: null, note: "GENO collision." },
  { line: "Permit Pass-Through", taskId: "GENO", accountGroup: "OTHER", type: "Expense", inventoryId: null, amountField: "Permit_Pass_Through_Cost__c", hoursField: null, note: "GENO collision." },
];

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
// (ProjectTaskID + AccountGroup + InventoryID + Type). Two rules:
//  - Several mapping rows sharing ONE key (e.g. the GENO adders: Other Material,
//    CO Fee, Permit) SUM into that single scaffold line — never duplicated.
//  - FAIL LOUDLY (never guess, never merge on a partial key): a row missing any
//    key part (especially InventoryID) is flagged; a key matching 0 or >1 lines
//    is flagged. Only a key matching exactly one line is a match.
export function matchMappingToLines(mappingRows, lines) {
  const matched = [];
  const problems = [];

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
    if (hits.length !== 1) {
      problems.push({
        key,
        count: hits.length,
        rows: rows.map((r) => r.line),
        reason: hits.length === 0 ? "no scaffolded line matched" : "matched multiple lines",
      });
      continue;
    }
    matched.push({
      key,
      lineId: hits[0].id,
      rows: rows.map((r) => r.line),
      summed: rows.length > 1, // multiple mapping rows -> summed into this one line
      amountFields: rows.map((r) => r.amountField).filter(Boolean),
    });
  }
  return { matched, problems };
}

// HARD GUARD: the write path is not built. It throws so nothing can accidentally
// push. Do NOT implement until Gate 5a confirms the reconciliation table, the
// mapping InventoryIDs are filled in, and the income code is confirmed.
export async function writeBudgetLines() {
  throw new Error(
    "BLOCKED: ProjectBudget write path is intentionally not implemented. " +
      "Resolve mapping InventoryIDs + income task code (Gate 5a) first."
  );
}

// Resolve an Acumatica ProjectID from a Sundial_Solar__c record id (read-only).
async function projectIdForRecord(recordId) {
  const soql =
    `SELECT Acumatica_Project_ID__c FROM ${SOLAR_SF_OBJECT} ` +
    `WHERE Id = '${soqlEscapeString(recordId)}' LIMIT 1`;
  const rows = await sfQuery(soql);
  return rows && rows.length ? rows[0].Acumatica_Project_ID__c : null;
}

// --- handler: RECONCILE (read-only) ----------------------------------------
// Input: { recordId } (Sundial_Solar__c) or { acumaticaProjectId }. Returns the
// existing lines + the mapping match result for the Gate 5a table. No writes.
export const handler = async (event) => {
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

    const { matched, problems } = matchMappingToLines(MAPPING_ROWS, lines);
    return {
      ok: true,
      mode: "reconcile_read_only",
      acumaticaProjectId,
      lineCount: lines.length,
      lines, // full existing scaffold, keyed by natural key + GUID (Gate 5a table)
      mappingMatch: { matchedCount: matched.length, matched, problems },
      blockers: [
        "Mapping tab has no InventoryID column — matcher will report all 17 rows as problems until filled in.",
        "Income row task code is BILL — confirm vs BALANCE/GENM before any write.",
      ],
    };
  } catch (err) {
    console.error("acumatica-budget-push reconcile error:", err?.message || String(err));
    return { ok: false, error: "server_error", message: err?.message || String(err) };
  }
};
