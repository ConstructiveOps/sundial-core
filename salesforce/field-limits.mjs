// Salesforce CustomField metadata limits that a package generator can break silently.
//
// WHY THIS EXISTS: the v5 attribute-sync package failed its first Workbench deploy with
//
//   problem: Value too long for field: Description maximum length is:1000
//
// on a description that was 1,137 characters. Nothing local caught it — the .object file
// was well-formed XML, the generator printed a tidy summary, and the only feedback was a
// componentFailure after a round trip through zip + Workbench + Check Only.
//
// These limits are not a style preference and the failure is not graceful, so the check
// belongs at BUILD time where the cost of being wrong is a re-run rather than a redeploy.
// Every package generator calls assertFieldLimits() before writing anything.
//
// The near miss is the argument: v4's Commission_PO_M1_Number__c description sits at 975
// of 1,000. It deployed fine, and one clarifying sentence would have broken it.

/** Description: 1,000 characters. inlineHelpText: 255. Both are hard Salesforce limits. */
export const FIELD_LIMITS = Object.freeze({
  description: 1000,
  inlineHelpText: 255,
});

/**
 * Throw before writing a package whose metadata Salesforce would reject.
 *
 * Reports EVERY offender with its actual length and overage, not just the first — a
 * generator that fails one field at a time turns a five-minute fix into five deploys.
 *
 * @param {Array<{api: string, description?: string, help?: string}>} fields
 * @param {string} packageName - named in the error so the message stands alone
 */
export function assertFieldLimits(fields, packageName = "package") {
  const problems = [];
  for (const f of fields ?? []) {
    const d = String(f.description ?? "");
    const h = String(f.help ?? "");
    if (d.length > FIELD_LIMITS.description) {
      problems.push(
        `  ${f.api}: description is ${d.length} chars, limit ${FIELD_LIMITS.description} (over by ${d.length - FIELD_LIMITS.description})`
      );
    }
    if (h.length > FIELD_LIMITS.inlineHelpText) {
      problems.push(
        `  ${f.api}: inlineHelpText is ${h.length} chars, limit ${FIELD_LIMITS.inlineHelpText} (over by ${h.length - FIELD_LIMITS.inlineHelpText})`
      );
    }
  }
  if (problems.length > 0) {
    throw new Error(
      `${packageName}: ${problems.length} field(s) exceed Salesforce metadata limits — ` +
        `Workbench would reject this with "Value too long for field".\n${problems.join("\n")}`
    );
  }
}

/** Print how close each field is to the limits, so a near miss is visible before it bites. */
export function reportFieldLimitHeadroom(fields, log = console.log) {
  log("\n  field                          desc/1000   help/255");
  for (const f of fields ?? []) {
    const d = String(f.description ?? "").length;
    const h = String(f.help ?? "").length;
    const tight = d > FIELD_LIMITS.description * 0.9 || h > FIELD_LIMITS.inlineHelpText * 0.9;
    log(
      `  ${f.api.padEnd(30)} ${String(d).padStart(4)}      ${String(h).padStart(4)}${tight ? "   (tight)" : ""}`
    );
  }
}
