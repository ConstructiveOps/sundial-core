// sundial-reports/assist.js — POST /reports/assist, the report assistant (D-092, R4).
//
//   { mode: "build" | "refine" | "explain", type?, messages: [{ role, content }], currentDefinition? }
//     → { reply, definition?, question?, type, outcome, usage, budget }
//
// IN ORDER (index.js has already checked identity, reports.read and reports.ai):
//   1. prepareAssist — the body, and for refine / explain the current definition validated with
//      the caller's gates. A 400 here never counts a turn and never calls the model.
//   2. the client — sundial/anthropic. Not configured = 503 ASSIST_NOT_CONFIGURED, no turn.
//   3. THE CLAIM — sundial_report_assist_claim(tenant, profile): one turn on the tenant's month
//      and the user's day, or 429 ASSIST_BUDGET_EXHAUSTED { scope, limit, resetsAt }. The
//      report editor never depends on this route, so it stays usable.
//   4. runAssist (lib/report-assist.js). An upstream failure (the API errored or timed out — the
//      model never answered) RELEASES the claim: 502 ASSIST_UPSTREAM. A refusal or a question
//      still counts.
//   5. the log row (best effort, never a reason to fail the answer): the request text, the
//      reply, the validated definition, the outcome, the tokens. Never a row of data.
//
// CloudWatch gets counts and timings only — never the user's words, a definition or the key.

import { getSupabaseClient } from "../../lib/supabase.js";
import { jsonResponse } from "../../lib/http.js";
import { prepareAssist, runAssist, AssistUpstreamError } from "../../lib/report-assist.js";
import { getAnthropicClient, assistModel, AssistNotConfiguredError } from "../../lib/anthropic.js";

export const LOG_TABLE = "sundial_report_assist_log";
export const USAGE_TABLE = "sundial_report_assist_usage";
export const CLAIM_RPC = "sundial_report_assist_claim";
export const RELEASE_RPC = "sundial_report_assist_release";
export const LOG_RETENTION_DAYS = 90;

// Test seams.
const deps = { getAnthropicClient, runAssist, now: () => new Date() };
export function _setAssistDeps(over) {
  Object.assign(deps, over);
}
export function _resetAssistDeps() {
  Object.assign(deps, { getAnthropicClient, runAssist, now: () => new Date() });
}

const usageOut = (u) => ({
  inputTokens: u.inputTokens, outputTokens: u.outputTokens, cacheReadTokens: u.cacheReadTokens, cacheWriteTokens: u.cacheWriteTokens,
  ms: u.ms, calls: u.calls.map((c) => ({ kind: c.kind, ms: c.ms, inputTokens: c.inputTokens, outputTokens: c.outputTokens, cacheReadTokens: c.cacheReadTokens, cacheWriteTokens: c.cacheWriteTokens })),
});

async function writeLog(supabase, row) {
  try {
    const { error } = await supabase.from(LOG_TABLE).insert(row);
    if (error) console.warn("reports assist: log write failed:", error.message);
  } catch (err) {
    console.warn("reports assist: log write failed:", err?.message || String(err));
  }
}

async function release(supabase, me, claim) {
  try {
    const { error } = await supabase.rpc(RELEASE_RPC, {
      p_client_sf_id: me.tenantId, p_profile_id: me.profileId, p_month_start: claim.month_start, p_day: claim.day,
    });
    if (error) console.error("reports assist: release failed:", error.message);
  } catch (err) {
    console.error("reports assist: release failed:", err?.message || String(err));
  }
}

/** POST /reports/assist. */
export async function assist({ body, me, heldGates, cors }) {
  const now = deps.now();
  const prepared = prepareAssist(body, { heldGates, now });
  if (!prepared.ok) return jsonResponse(prepared.status, cors, prepared.body);
  const { plan } = prepared;

  let client;
  try {
    client = await deps.getAnthropicClient();
  } catch (err) {
    if (err instanceof AssistNotConfiguredError) {
      console.error("reports assist:", err.message);
      return jsonResponse(503, cors, { error: "unavailable", code: "ASSIST_NOT_CONFIGURED" });
    }
    throw err;
  }

  const supabase = await getSupabaseClient();
  const { data: claim, error: claimErr } = await supabase.rpc(CLAIM_RPC, { p_client_sf_id: me.tenantId, p_profile_id: me.profileId });
  if (claimErr) {
    console.error("reports assist: claim failed:", claimErr.message);
    return jsonResponse(500, cors, { error: "server_error" });
  }
  if (!claim?.ok) {
    return jsonResponse(429, cors, {
      error: "budget_exhausted", code: "ASSIST_BUDGET_EXHAUSTED",
      scope: claim?.scope ?? null, limit: claim?.limit ?? null, resetsAt: claim?.resets_at ?? null,
      message: claim?.scope === "tenant"
        ? "The report assistant has used this month's allowance for your company. You can still build reports by hand."
        : "You have used today's report assistant allowance. You can still build reports by hand.",
    });
  }

  const model = assistModel();
  const started = Date.now();
  let r;
  try {
    r = await deps.runAssist(plan, { heldGates, client, model, now });
  } catch (err) {
    if (!(err instanceof AssistUpstreamError)) {
      await release(supabase, me, claim);
      throw err;
    }
    await release(supabase, me, claim);
    console.error(JSON.stringify({ assist: "upstream_error", status: err.status ?? null, ms: Date.now() - started }));
    await writeLog(supabase, {
      client_sf_id: me.tenantId, profile_id: me.profileId, mode: plan.mode, report_type: plan.type,
      request_text: plan.messages.at(-1)?.content ?? null, messages_count: plan.messages.length,
      outcome: "error", codes: [`UPSTREAM_${err.status ?? "ERROR"}`], model, ms: Date.now() - started,
    });
    return jsonResponse(502, cors, { error: "upstream_error", code: "ASSIST_UPSTREAM", message: "The report assistant could not answer just now. Try again, or build the report by hand." });
  }

  const ms = Date.now() - started;
  await writeLog(supabase, {
    client_sf_id: me.tenantId, profile_id: me.profileId, mode: plan.mode, report_type: r.type ?? plan.type,
    request_text: plan.mode === "explain" ? null : plan.messages.at(-1)?.content ?? null,
    messages_count: plan.messages.length,
    reply: r.reply ?? null, question: r.question ?? null, definition: r.definition ?? null,
    outcome: r.outcome, attempts: r.attempts, codes: r.codes, strict: r.strict, model,
    input_tokens: r.usage.inputTokens, output_tokens: r.usage.outputTokens,
    cache_read_tokens: r.usage.cacheReadTokens, cache_write_tokens: r.usage.cacheWriteTokens,
    calls: r.usage.calls, ms,
  });
  console.log(JSON.stringify({
    assist: plan.mode, type: r.type ?? plan.type, outcome: r.outcome, attempts: r.attempts, codes: r.codes, strict: r.strict,
    calls: r.usage.calls.length, in: r.usage.inputTokens, out: r.usage.outputTokens, cacheRead: r.usage.cacheReadTokens, cacheWrite: r.usage.cacheWriteTokens, ms,
  }));

  return jsonResponse(200, cors, {
    outcome: r.outcome,
    reply: r.reply,
    ...(r.definition ? { definition: r.definition } : {}),
    ...(r.question ? { question: r.question } : {}),
    type: r.type ?? plan.type ?? null,
    ...(r.stripped ? { stripped: r.stripped } : {}),
    usage: usageOut(r.usage),
    budget: { tenantUsed: claim.tenant_used, tenantLimit: claim.tenant_limit, userUsed: claim.user_used, userLimit: claim.user_limit },
  });
}

/**
 * The 90-day cleanup, run by the 15-minute tick (schedule.js runTick). Best effort: it never
 * fails the tick. Old log rows and old per-user day counters go; month counters are kept
 * (one row per tenant per month).
 */
export async function cleanupAssist(supabase, now = new Date()) {
  const cutoff = new Date(now.getTime() - LOG_RETENTION_DAYS * 86_400_000);
  const out = { logs: 0, days: 0 };
  try {
    const { data, error } = await supabase.from(LOG_TABLE).delete().lt("created_at", cutoff.toISOString()).select("id");
    if (error) throw new Error(error.message);
    out.logs = data?.length ?? 0;
    const r2 = await supabase.from(USAGE_TABLE).delete().eq("period_kind", "day").lt("period_start", cutoff.toISOString().slice(0, 10)).select("period_start");
    if (r2.error) throw new Error(r2.error.message);
    out.days = r2.data?.length ?? 0;
  } catch (err) {
    console.warn("reports tick: assist cleanup failed:", err?.message || String(err));
    out.error = true;
  }
  return out;
}
