// sundial-lead-intake — inbound lead webhooks + the lead vendors' daily reports (D-077).
//
//   POST /webhooks/leads/tcd/{token}   The Cool Down's web form -> a Sundial_Customer__c (intake.js)
//   POST /webhooks/leads/tcd           (no slug) -> the same bare 404 as a wrong slug
//   EventBridge { "report": "tcd" }    6:00 AM Arizona: the cohort CSV emailed to TCD (report.js)
//   Lambda test { "report": "tcd", "dryRun": true }   the CSV in the response, nothing sent
//
// PUBLIC, and deliberately NOT behind resolveIdentity: the caller is TCD's server, with no
// Sundial user and no Supabase token. The only gate is the URL slug (see intake.js).
//
// Config: Secrets Manager `sundial/lead-webhooks` { "tcd": { "token", "tenant" } };
// env EMAIL_FROM / EMAIL_REPLY_TO / EMAIL_CONFIG_SET / SES_REGION (as the estimate Lambda),
// TCD_REPORT_TO, TCD_REPORT_BCC (comma-separated, optional), TCD_REPORT_SINCE (YYYY-MM-DD).
// Runbook: docs/integrations/tcd-leads.md.

import { sfQuery, sfCreateRecord, describeObject, soqlEscapeString } from "../../lib/salesforce.js";
import { getSupabaseClient, getSupabaseConfig } from "../../lib/supabase.js";
import { getSecret, clearSecretCache } from "../../lib/secrets.js";
import { sendEmail, isEmailConfigured } from "../../lib/email.js";
import { createCacheColumnReader } from "../../lib/cache-row.js";
import { createIntakeHandler, LEAD_WEBHOOKS_SECRET } from "./intake.js";
import { createReportHandler } from "./report.js";

// The secret is re-read every 5 minutes, so rotating the slug takes effect without a
// redeploy or waiting for a cold start (the Aurora doorbell's rule, D-045).
const SECRET_TTL_MS = 5 * 60 * 1000;
let secretAt = 0;
async function getLeadConfig(source) {
  if (Date.now() - secretAt >= SECRET_TTL_MS) {
    clearSecretCache();
    secretAt = Date.now();
  }
  try {
    return (await getSecret(LEAD_WEBHOOKS_SECRET))?.[source] ?? null;
  } catch (e) {
    secretAt = 0; // never keep a failed read
    throw e;
  }
}

const deps = {
  getLeadConfig,
  sfQuery,
  sfCreateRecord,
  describeObject,
  soqlEscapeString,
  getSupabaseClient,
  getCacheColumns: createCacheColumnReader({ getSupabaseConfig }),
  sendEmail,
  isEmailConfigured,
};

const handleLead = createIntakeHandler(deps);
const runTcdReport = createReportHandler(deps);

export const handler = async (event) => {
  // Scheduled / manual report run (no HTTP envelope).
  if (event && typeof event.report === "string") {
    if (event.report !== "tcd") throw new Error(`Unknown report "${event.report}"`);
    return runTcdReport({ dryRun: event.dryRun === true });
  }
  try {
    return await handleLead(event);
  } catch (e) {
    console.error("lead-intake unexpected error:", e?.message || String(e));
    return { statusCode: 500, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ok: false, error: "server_error" }) };
  }
};
