// lib/report-assist.js — the report assistant's conversation logic (D-092, R4).
//
// Plain English in → a report DEFINITION out. The model never sees rows and never writes SQL:
// everything it proposes goes through lib/report-def.js normalizeDefinition with the CALLER's
// gates, exactly as a hand-built definition does, and what comes back is
// stripDefinition(def, n.stripped) — the object the editor would hold (relative tokens kept).
//
// THREE MODES:
//   build    messages (+ type?) → a definition, or ONE question. No type: a small router call
//            picks one from TYPE_DESCRIPTIONS first (or asks).
//   refine   messages + currentDefinition (validated first; its type is the type) → a new one.
//   explain  currentDefinition → one plain-English paragraph (no tool call).
//
// TWO ATTEMPTS. A proposal the validator refuses goes back to the model ONCE as an error tool
// result naming the problem; a second refusal (or too little time left) becomes a question.
//
// STRICT, THEN NOT. Tools go out with strict: true. If the API refuses the schema (400), the
// same call is repeated without strict and that type + gate set is remembered for the life of
// the container — the server's validation is authoritative either way.
//
// Sonnet 5.5 refuses forced tool use, so tool_choice is auto (one call at most) and the rules
// say "exactly one tool call"; a turn that ends in text is treated as the question.
//
// The model client is INJECTED ({ beta: { messages: { create } } } — the Anthropic SDK's
// shape), so the tests drive every path with a fake. A thrown client error (5xx, timeout,
// 429, 4xx) propagates as an AssistUpstreamError: the handler releases the budget claim.

import { normalizeDefinition, arizonaToday, MAX_ROWS } from "./report-def.js";
import { stripDefinition } from "./saved-reports.js";
import { reportType } from "./report-types.js";
import {
  proposeTool, ASK_QUESTION, chooseTypeTool, withStrict, definitionFromInput,
  PROPOSE_TOOL, ASK_TOOL, CHOOSE_TYPE_TOOL,
} from "./report-assist-schema.js";
import { typeSystem, routerSystem, contextLine } from "./report-assist-prompt.js";

export const ASSIST_MODES = Object.freeze(["build", "refine", "explain"]);
export const MAX_MESSAGES = 20;
export const MAX_MESSAGE_CHARS = 2000;
export const MAX_ATTEMPTS = 2;
// API Gateway ends a request at 29 s. The whole turn gets REQUEST_BUDGET_MS; a second attempt
// starts only with SECOND_ATTEMPT_MIN_MS left; one call never waits past what is left.
export const REQUEST_BUDGET_MS = 26_000;
export const SECOND_ATTEMPT_MIN_MS = 10_000;
export const MAX_TOKENS = 8000;
export const ROUTER_MAX_TOKENS = 3000;
export const EFFORT = "low";
export const FALLBACK_BETA = "server-side-fallback-2026-07-01";

const BODY_KEYS = new Set(["mode", "type", "messages", "currentDefinition"]);

export class AssistUpstreamError extends Error {
  constructor(cause) {
    super(cause?.message || "upstream error");
    this.name = "AssistUpstreamError";
    this.status = cause?.status ?? null;
    this.cause = cause;
  }
}

const bad = (code, field, message) => ({ ok: false, status: 400, body: { error: "invalid_assist", code, field, message } });

/**
 * Validate a POST /reports/assist body. Nothing here calls the model or counts a turn.
 * Returns { ok: true, plan } or the 400.
 */
export function prepareAssist(body, { heldGates = [], now = new Date() } = {}) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return bad("BAD_ASSIST_REQUEST", "", "Send a JSON object { mode, type?, messages, currentDefinition? }.");
  for (const k of Object.keys(body)) if (!BODY_KEYS.has(k)) return bad("BAD_ASSIST_REQUEST", k, `${k}: not an assist field (mode, type, messages, currentDefinition).`);
  const mode = body.mode;
  if (!ASSIST_MODES.includes(mode)) return bad("BAD_ASSIST_REQUEST", "mode", `mode: one of ${ASSIST_MODES.join(", ")}.`);

  // messages — required for build / refine, optional for explain.
  const msgs = body.messages ?? [];
  if (!Array.isArray(msgs)) return bad("BAD_ASSIST_REQUEST", "messages", "messages: a list of { role, content }.");
  if (mode !== "explain" && msgs.length === 0) return bad("BAD_ASSIST_REQUEST", "messages", "messages: at least the user's request.");
  if (msgs.length > MAX_MESSAGES) return bad("BAD_ASSIST_REQUEST", "messages", `messages: at most ${MAX_MESSAGES}.`);
  const messages = [];
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    const where = `messages[${i}]`;
    if (!m || typeof m !== "object" || !["user", "assistant"].includes(m.role)) return bad("BAD_ASSIST_REQUEST", where, `${where}: { role: "user" | "assistant", content }.`);
    if (typeof m.content !== "string" || m.content.trim() === "" || m.content.length > MAX_MESSAGE_CHARS) {
      return bad("BAD_ASSIST_REQUEST", `${where}.content`, `${where}.content: text of 1–${MAX_MESSAGE_CHARS} characters.`);
    }
    const expected = i % 2 === 0 ? "user" : "assistant";
    if (m.role !== expected) return bad("BAD_ASSIST_REQUEST", `${where}.role`, `${where}.role: the conversation alternates, starting with the user.`);
    messages.push({ role: m.role, content: m.content });
  }
  if (messages.length && messages[messages.length - 1].role !== "user") return bad("BAD_ASSIST_REQUEST", "messages", "messages: the last one is the user's.");

  // type
  let type = null;
  if (body.type !== undefined && body.type !== null) {
    if (!reportType(body.type)) return bad("UNKNOWN_TYPE", "type", "type: name a report type (GET /reports/types).");
    type = body.type;
  }

  // currentDefinition — refine / explain only, validated with the caller's gates.
  let current = null;
  if (mode === "build") {
    if (body.currentDefinition !== undefined && body.currentDefinition !== null) return bad("BAD_ASSIST_REQUEST", "currentDefinition", "currentDefinition: only with mode refine or explain.");
  } else {
    if (!body.currentDefinition) return bad("BAD_ASSIST_REQUEST", "currentDefinition", `currentDefinition: ${mode} needs the report open in the editor.`);
    const n = normalizeDefinition(body.currentDefinition, { heldGates, now });
    if (!n.ok) return { ...n, body: { ...n.body, field: n.body.field ? `currentDefinition.${n.body.field}` : "currentDefinition" } };
    if (type && type !== body.currentDefinition.type) return bad("TYPE_MISMATCH", "type", "type: must be the current definition's type.");
    type = body.currentDefinition.type;
    current = stripDefinition(body.currentDefinition, n.stripped);
  }
  return { ok: true, plan: { mode, type, messages, current } };
}

// --- usage ---------------------------------------------------------------------------------
function newUsage() {
  return { calls: [], inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, ms: 0 };
}
function addUsage(usage, kind, res, ms) {
  const u = res?.usage ?? {};
  const call = {
    kind,
    ms,
    inputTokens: u.input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
    cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
    stopReason: res?.stop_reason ?? null,
    model: res?.model ?? null,
  };
  usage.calls.push(call);
  usage.inputTokens += call.inputTokens;
  usage.outputTokens += call.outputTokens;
  usage.cacheReadTokens += call.cacheReadTokens;
  usage.cacheWriteTokens += call.cacheWriteTokens;
  usage.ms += ms;
}

// The type + gate sets whose schema the API refused under strict (per warm container).
const strictRefused = new Set();
export function _resetStrictMemory() {
  strictRefused.clear();
}

/** A 400 that is about the tool schema (strict mode) — the one error worth a non-strict retry. */
export function isSchemaRefusal(err) {
  return err?.status === 400 && /schema|strict|grammar|complex|too (?:large|many)/i.test(String(err?.message ?? ""));
}

/** One API call, strict first; returns { res, strict, ms }. Throws AssistUpstreamError. */
async function callModel(ctx, { kind, system, tools, toolChoice, messages, maxTokens, strictKey }) {
  const remaining = ctx.deadline - ctx.clock();
  if (remaining < 1500) throw new AssistUpstreamError({ message: "no time left for a model call", status: 504 });
  const send = (strict) => ctx.client.beta.messages.create(
    {
      model: ctx.model,
      max_tokens: maxTokens,
      thinking: { type: "adaptive" },
      output_config: { effort: EFFORT },
      betas: [FALLBACK_BETA],
      fallbacks: "default",
      system,
      tools: withStrict(tools, strict),
      tool_choice: toolChoice,
      messages,
    },
    { timeout: Math.max(1000, ctx.deadline - ctx.clock()), maxRetries: 0 },
  );
  let strict = !strictRefused.has(strictKey);
  const started = ctx.clock();
  try {
    let res;
    try {
      res = await send(strict);
    } catch (err) {
      if (!strict || !isSchemaRefusal(err)) throw err;
      strictRefused.add(strictKey);
      ctx.log?.({ assistStrictRefused: strictKey });
      strict = false;
      res = await send(false);
    }
    const ms = ctx.clock() - started;
    addUsage(ctx.usage, kind, res, ms);
    return { res, strict };
  } catch (err) {
    if (err instanceof AssistUpstreamError) throw err;
    throw new AssistUpstreamError(err);
  }
}

const textOf = (res) => (res?.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
const toolUseOf = (res) => (res?.content ?? []).find((b) => b.type === "tool_use") ?? null;

/** The conversation for the API: the last user message carries today's date (after the cache). */
function apiMessages(plan, ctx, extra) {
  const msgs = plan.messages.map((m) => ({ role: m.role, content: m.content }));
  const ctxLine = contextLine(ctx.now, arizonaToday(ctx.now));
  if (plan.mode === "explain") {
    msgs.length = 0;
    msgs.push({
      role: "user",
      content: `${ctxLine}\nExplain this report to an office user in ONE short paragraph of plain English: which records it lists or counts, the filters and periods (say what a relative period means today), the grouping, totals and sort. No field names in alias.column form, no lists, no tool call.\n\n${JSON.stringify(plan.current, null, 2)}`,
    });
    return msgs;
  }
  const last = msgs[msgs.length - 1];
  const parts = [ctxLine];
  if (plan.mode === "refine") parts.push(`The report open in the editor (refine it; keep everything the user does not ask to change):\n${JSON.stringify(plan.current, null, 2)}`);
  if (extra) parts.push(extra);
  parts.push(last.content);
  msgs[msgs.length - 1] = { role: "user", content: parts.join("\n\n") };
  return msgs;
}

const QUESTION_INVALID = (message) => `I couldn't build a valid report from that (${message}). Could you say it another way — for example which records, which period and how to group them?`;
const QUESTION_REFUSED = "I can't help with that request. Could you describe the report you need — which records, which period, and how to group or total them?";
const QUESTION_NO_TOOL = "Could you tell me a bit more about the report you want — which records, which period, and how to group or total them?";

/**
 * Run one assist turn. `plan` comes from prepareAssist.
 * Returns { outcome, reply, question?, definition?, type, attempts, codes, strict, usage }
 *   outcome: definition | question | explained | invalid | refused
 * Throws AssistUpstreamError when the API could not answer (the claim is released).
 */
export async function runAssist(plan, { heldGates = [], client, model, now = new Date(), clock = () => Date.now(), budgetMs = REQUEST_BUDGET_MS, log, catalogForType } = {}) {
  const ctx = { client, model, now, clock, deadline: clock() + budgetMs, usage: newUsage(), log };
  const gateKey = [...heldGates].sort().join(",");
  const result = (r) => ({ attempts: 0, codes: [], strict: null, ...r, usage: ctx.usage });

  // 1. The type: given, the current definition's, or the router's.
  let type = plan.type;
  if (!type) {
    const tools = [chooseTypeTool(), ASK_QUESTION];
    const { res } = await callModel(ctx, {
      kind: "route", system: routerSystem(), tools, toolChoice: { type: "auto", disable_parallel_tool_use: true },
      messages: apiMessages(plan, ctx), maxTokens: ROUTER_MAX_TOKENS, strictKey: "router",
    });
    if (res.stop_reason === "refusal") return result({ outcome: "refused", reply: QUESTION_REFUSED, question: QUESTION_REFUSED, type: null });
    const use = toolUseOf(res);
    if (use?.name === CHOOSE_TYPE_TOOL && reportType(use.input?.type)) {
      type = use.input.type;
    } else {
      const q = use?.name === ASK_TOOL && typeof use.input?.question === "string" ? use.input.question : textOf(res) || QUESTION_NO_TOOL;
      return result({ outcome: "question", reply: q, question: q, type: null });
    }
  }

  // The type's catalog with its picklist values read live (D-089 am. 2); the generated one
  // when no reader is given (tests). catalogForType never throws — it falls back itself.
  const catalog = catalogForType ? await catalogForType(type) : undefined;
  const tools = [proposeTool(type, heldGates, catalog), ASK_QUESTION];
  const system = typeSystem(type, heldGates, catalog);
  const strictKey = `${type}|${gateKey}`;

  // 2. Explain: the same cached prefix, no tool call.
  if (plan.mode === "explain") {
    const { res, strict } = await callModel(ctx, {
      kind: "explain", system, tools, toolChoice: { type: "none" }, messages: apiMessages(plan, ctx), maxTokens: MAX_TOKENS, strictKey,
    });
    if (res.stop_reason === "refusal") return result({ outcome: "refused", reply: QUESTION_REFUSED, question: QUESTION_REFUSED, type, strict });
    const text = textOf(res);
    return result({ outcome: text ? "explained" : "invalid", reply: text || "I couldn't explain this report.", type, strict, attempts: 1 });
  }

  // 3. Build / refine: up to MAX_ATTEMPTS proposals.
  const messages = apiMessages(plan, ctx);
  const codes = [];
  let strict = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const call = await callModel(ctx, {
      kind: attempt === 1 ? plan.mode : "retry", system, tools, toolChoice: { type: "auto", disable_parallel_tool_use: true },
      messages, maxTokens: MAX_TOKENS, strictKey,
    });
    const { res } = call;
    strict = call.strict;
    if (res.stop_reason === "refusal") return result({ outcome: "refused", reply: QUESTION_REFUSED, question: QUESTION_REFUSED, type, attempts: attempt, codes, strict });
    const use = toolUseOf(res);
    if (!use || use.name === ASK_TOOL) {
      const q = (use && typeof use.input?.question === "string" && use.input.question.trim()) || textOf(res) || QUESTION_NO_TOOL;
      return result({ outcome: "question", reply: q, question: q, type, attempts: attempt, codes, strict });
    }
    // propose_report
    const def = definitionFromInput(use.input);
    let n;
    if (def.type !== type) {
      n = { ok: false, body: { code: "TYPE_MISMATCH", field: "type", message: `type: must be ${type}` } };
    } else {
      n = normalizeDefinition(def, { heldGates, now });
    }
    if (n.ok) {
      const definition = stripDefinition(def, n.stripped);
      const summary = typeof use.input?.summary === "string" ? use.input.summary.trim() : "";
      return result({
        outcome: "definition", reply: summary || "Here is the report.", definition, type,
        attempts: attempt, codes, strict, ...(n.stripped.length ? { stripped: n.stripped } : {}),
      });
    }
    codes.push(n.body.code);
    const lastTry = attempt === MAX_ATTEMPTS || ctx.deadline - ctx.clock() < SECOND_ATTEMPT_MIN_MS;
    if (lastTry) {
      const q = QUESTION_INVALID(n.body.message);
      return result({ outcome: "invalid", reply: q, question: q, type, attempts: attempt, codes, strict });
    }
    // Feed the refusal back once — append-only: the assistant turn exactly as returned.
    messages.push({ role: "assistant", content: res.content });
    messages.push({
      role: "user",
      content: [{
        type: "tool_result", tool_use_id: use.id, is_error: true,
        content: `The server refused this definition: ${n.body.message} (code ${n.body.code}, at ${n.body.field || "the definition"}). Fix it and call ${PROPOSE_TOOL} again, or call ${ASK_TOOL} if it cannot be built.`,
      }],
    });
  }
  /* c8 ignore next */
  throw new Error("unreachable");
}

export { MAX_ROWS };
