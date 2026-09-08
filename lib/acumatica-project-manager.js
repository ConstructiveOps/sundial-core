// Salesforce picklist -> Acumatica identifier, for the two places that need it.
//
// This lives in lib/ rather than in either Lambda because BOTH write the same field:
// `sundial-acumatica-push` sets `ProjectProperties.ProjectManager` when it creates the
// project, and `sundial-acumatica-budget-push` refreshes it on every budget push to catch
// managers assigned after creation. Two copies of the name map would eventually be two
// different name maps, and the failure would be silent: a job created under one Lambda's
// spelling and refreshed under the other's would just stop having a manager.

/**
 * Normalise a Salesforce picklist value for comparison: trim, collapse internal
 * whitespace, fold every dash-like character to a plain hyphen, lowercase.
 *
 * ⚠️ THE DASH FOLD IS LOAD-BEARING, NOT TIDINESS. The live
 * `Sundial_Customer__c.Financing_Partner__c` picklist contains
 *
 *     "Participate Prepaid Lease U+2013 Cash"      <- EN DASH
 *     "Participate Prepaid Lease - Financed"       <- ASCII hyphen
 *
 * verified against the org 2026-09-08 (4 records and 1 record respectively). The two
 * sibling values do not even agree with each other. A trimmed, case-insensitive match
 * written against the hyphen spelling — which is how the mapping was handed to us, and
 * how it reads in every document — matches `- Financed` and silently misses `– Cash`,
 * so four Participate customers would be created with no parent account and no warning.
 * Folding the dash is what makes "case-insensitive and trimmed" actually true here.
 *
 * It is shared with the project-manager map rather than kept next to the financing
 * partners, because the next picklist someone maps will have the same problem and should
 * not have to rediscover it.
 */
export function normalizePicklist(v) {
  return String(v ?? "")
    .replace(/[‐-―−]/g, "-") // hyphen/en/em/figure/minus -> "-"
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** The Salesforce field this map reads. Exported so callers can build their SELECT. */
export const PROJECT_MANAGER_FIELD = "Project_Manager__c";

/**
 * `Sundial_Solar__c.Project_Manager__c` -> Acumatica `ProjectProperties.ProjectManager`,
 * which holds an EmployeeID string. Both ids read back from the live tenant 2026-09-08:
 *
 *   Lindsay McCormack -> E00675   (Active)
 *   Cameron Labonte   -> E01177   (Active; Acumatica spells it "Cameron LaBonte")
 *
 * These two are exactly the ACTIVE values of the Salesforce multipicklist. The field
 * also carries nine legacy values on existing records (Breana Evans 683, Selena
 * Bribiescas 239, Jessica Patrick 91, …) that are no longer selectable and have no
 * Acumatica employee mapped, which is why an unmapped name omits and warns instead of
 * failing: 3,815 of 4,494 solar records carry a PM and most of them are legacy.
 */
export const PROJECT_MANAGER_EMPLOYEE_IDS = Object.freeze({
  [normalizePicklist("Lindsay McCormack")]: "E00675",
  [normalizePicklist("Cameron Labonte")]: "E01177",
});

/**
 * Resolve the Acumatica employee for a project manager.
 *
 * ⚠️ `Project_Manager__c` IS A MULTIPICKLIST (verified by describe, 2026-09-08:
 * `type: "multipicklist"`, length 4099), so its value can be a semicolon-separated
 * list. Acumatica's project has ONE manager slot. Treating the raw string as a single
 * name would send `"Lindsay McCormack;Cameron Labonte"` and match nothing — which at
 * least fails visibly — but picking silently from a list would put one of two people's
 * name on a job with no record of the coin toss.
 *
 * So: exactly one distinct mapped employee wins. Zero mapped names, or two different
 * ones, omit the field and warn.
 *
 * @returns {{employeeId: string|null, names: string[], unknownNames: string[], ambiguous: boolean}}
 */
export function resolveProjectManager(raw) {
  const names = String(raw ?? "")
    .split(";")
    .map((n) => n.trim())
    .filter((n) => n !== "");
  if (names.length === 0) {
    return { employeeId: null, names: [], unknownNames: [], ambiguous: false };
  }

  const unknownNames = [];
  const matched = new Set();
  for (const name of names) {
    const id = PROJECT_MANAGER_EMPLOYEE_IDS[normalizePicklist(name)];
    if (id) matched.add(id);
    else unknownNames.push(name);
  }
  if (matched.size === 1) {
    return { employeeId: [...matched][0], names, unknownNames, ambiguous: false };
  }
  return { employeeId: null, names, unknownNames, ambiguous: matched.size > 1 };
}
