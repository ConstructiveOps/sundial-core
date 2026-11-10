// node --test lib/report-assist.test.js — the report assistant's turn logic (D-092) with a FAKE
// model client: the request it sends (model, thinking, effort, fallback, caching, tools), the
// router, the two attempts, strict → non-strict, questions, refusals, explain, refine, and that
// every definition returned is the validator's (gates applied, relative tokens kept).

import test from "node:test";
import assert from "node:assert/strict";
import {
  prepareAssist, runAssist, AssistUpstreamError, isSchemaRefusal, _resetStrictMemory,
  MAX_MESSAGES, MAX_MESSAGE_CHARS, EFFORT, FALLBACK_BETA,
} from "./report-assist.js";
import { TYPE_DESCRIPTIONS, typeSystem, catalogBlock, rulesBlock } from "./report-assist-prompt.js";
import { REPORT_TYPES } from "./report-types.js";
import { RELATIVE_TOKENS } from "./report-def.js";
import { GLOSSARY } from "./report-glossary.js";

const NOW = new Date("2026-11-10T17:00:00Z"); // Tuesday 10:00 in Phoenix
const COST = "service.costing.read";
const MODEL = "claude-sonnet-5-5";

/** A fake client: answers from a script, records every request. */
function fakeClient(script) {
  const calls = [];
  let i = 0;
  return {
    calls,
    beta: {
      messages: {
        create: async (req, opts) => {
          calls.push({ req: structuredClone(req), opts });
          const step = script[i++];
          if (!step) throw new Error("script ran out");
          if (step instanceof Error || step.throw) throw step.throw ?? step;
          return typeof step === "function" ? step(req) : step;
        },
      },
    },
  };
}
const usage = (n = 1) => ({ input_tokens: 100 * n, output_tokens: 50 * n, cache_read_input_tokens: 1000 * n, cache_creation_input_tokens: 0 });
const propose = (input, id = "tu_1") => ({ stop_reason: "tool_use", model: MODEL, usage: usage(), content: [{ type: "thinking", thinking: "" }, { type: "tool_use", id, name: "propose_report", input }] });
const ask = (question) => ({ stop_reason: "tool_use", model: MODEL, usage: usage(), content: [{ type: "tool_use", id: "tu_q", name: "ask_question", input: { question } }] });
const choose = (type) => ({ stop_reason: "tool_use", model: MODEL, usage: usage(), content: [{ type: "tool_use", id: "tu_t", name: "choose_type", input: { type } }] });
const text = (t, stop = "end_turn") => ({ stop_reason: stop, model: MODEL, usage: usage(), content: t ? [{ type: "text", text: t }] : [] });

const SOLAR_BY_REP = {
  summary: "Solar projects sold this quarter, totalled by sales rep.",
  type: "solar", columns: [],
  filters: [{ field: "solar.contract_date", op: "between", value: "this_quarter" }],
  groupBy: ["rep.name"],
  aggregates: [{ fn: "count" }, { fn: "sum", field: "solar.contract_amount" }],
  sort: [{ field: "sum_solar_contract_amount", dir: "desc" }],
  limit: 5000,
};

const plan = (body, gates = []) => {
  const p = prepareAssist(body, { heldGates: gates, now: NOW });
  assert.equal(p.ok, true, p.body?.message);
  return p.plan;
};
const run = (p, client, opts = {}) => runAssist(p, { client, model: MODEL, now: NOW, heldGates: [], ...opts });

test.beforeEach(() => _resetStrictMemory());

// --- prepareAssist ---------------------------------------------------------------------------
test("prepareAssist: the body's shape", () => {
  const bad = (body, code, field) => {
    const r = prepareAssist(body, { now: NOW });
    assert.equal(r.ok, false);
    assert.equal(r.status, 400);
    assert.equal(r.body.code, code, r.body.message);
    if (field !== undefined) assert.equal(r.body.field, field);
  };
  bad(null, "BAD_ASSIST_REQUEST");
  bad({ mode: "chat", messages: [{ role: "user", content: "x" }] }, "BAD_ASSIST_REQUEST", "mode");
  bad({ mode: "build", messages: [] }, "BAD_ASSIST_REQUEST", "messages");
  bad({ mode: "build", messages: [{ role: "assistant", content: "x" }] }, "BAD_ASSIST_REQUEST", "messages[0].role");
  bad({ mode: "build", messages: [{ role: "user", content: "a" }, { role: "assistant", content: "b" }] }, "BAD_ASSIST_REQUEST", "messages");
  bad({ mode: "build", messages: [{ role: "user", content: "x".repeat(MAX_MESSAGE_CHARS + 1) }] }, "BAD_ASSIST_REQUEST", "messages[0].content");
  bad({ mode: "build", messages: Array.from({ length: MAX_MESSAGES + 1 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: "x" })) }, "BAD_ASSIST_REQUEST", "messages");
  bad({ mode: "build", messages: [{ role: "user", content: "x" }], tenant: "other" }, "BAD_ASSIST_REQUEST", "tenant");
  bad({ mode: "build", type: "nope", messages: [{ role: "user", content: "x" }] }, "UNKNOWN_TYPE", "type");
  bad({ mode: "build", messages: [{ role: "user", content: "x" }], currentDefinition: { type: "solar" } }, "BAD_ASSIST_REQUEST", "currentDefinition");
  bad({ mode: "refine", messages: [{ role: "user", content: "x" }] }, "BAD_ASSIST_REQUEST", "currentDefinition");
  bad({ mode: "explain", currentDefinition: { type: "solar", columns: ["solar.nope"] } }, "UNKNOWN_FIELD", "currentDefinition.columns[0]");
  bad({ mode: "refine", type: "payments", messages: [{ role: "user", content: "x" }], currentDefinition: { type: "solar" } }, "TYPE_MISMATCH", "type");
});

test("prepareAssist: refine / explain take the current definition's type, gated fields stripped for this caller", () => {
  const p = plan({ mode: "explain", currentDefinition: { type: "estimates", columns: ["estimate.name", "estimate.markup_amount"] } });
  assert.equal(p.type, "estimates");
  assert.deepEqual(p.current, { type: "estimates", columns: ["estimate.name"] });
  const admin = plan({ mode: "explain", currentDefinition: { type: "estimates", columns: ["estimate.name", "estimate.markup_amount"] } }, [COST]);
  assert.deepEqual(admin.current.columns, ["estimate.name", "estimate.markup_amount"]);
});

// --- the request it sends ------------------------------------------------------------------
test("build with a type: one call — Sonnet, adaptive thinking at low effort, refusal fallback, cached catalog, today AFTER the cache", async () => {
  const client = fakeClient([propose(SOLAR_BY_REP)]);
  const r = await run(plan({ mode: "build", type: "solar", messages: [{ role: "user", content: "solar projects sold this quarter by rep with contract totals" }] }), client);
  assert.equal(client.calls.length, 1);
  const { req, opts } = client.calls[0];
  assert.equal(req.model, MODEL);
  assert.deepEqual(req.thinking, { type: "adaptive" });
  assert.deepEqual(req.output_config, { effort: EFFORT });
  assert.equal(EFFORT, "low");
  assert.deepEqual(req.betas, [FALLBACK_BETA]);
  assert.equal(req.fallbacks, "default");
  assert.deepEqual(req.tool_choice, { type: "auto", disable_parallel_tool_use: true }, "Sonnet 5.5 refuses forced tool use");
  assert.deepEqual(req.tools.map((t) => [t.name, t.strict]), [["propose_report", true], ["ask_question", true]]);
  assert.equal(opts.maxRetries, 0);
  assert.ok(opts.timeout > 0 && opts.timeout <= 26_000);
  // System: rules + glossary, then the solar catalog with the ONE cache breakpoint (1 h).
  assert.equal(req.system.length, 2);
  assert.ok(req.system[0].text.includes(GLOSSARY));
  assert.equal(req.system[0].cache_control, undefined);
  assert.equal(req.system[1].text, catalogBlock("solar", []));
  assert.deepEqual(req.system[1].cache_control, { type: "ephemeral", ttl: "1h" });
  // Nothing volatile in the cached prefix; today's date rides on the last user message.
  assert.deepEqual(req.system, typeSystem("solar", []), "the prefix is a pure function of (type, gates) — no clock in it");
  assert.ok(!JSON.stringify(req.system).includes("Tuesday"));
  assert.match(req.messages.at(-1).content, /today is Tuesday 2026-11-10 in Arizona/);
  assert.match(req.messages.at(-1).content, /solar projects sold this quarter/);
  // The answer: the validator's definition, relative token kept, summary as the reply.
  assert.equal(r.outcome, "definition");
  assert.equal(r.reply, SOLAR_BY_REP.summary);
  assert.deepEqual(r.definition, {
    type: "solar",
    filters: [{ field: "solar.contract_date", op: "between", value: "this_quarter" }],
    groupBy: ["rep.name"],
    aggregates: [{ fn: "count" }, { fn: "sum", field: "solar.contract_amount" }],
    sort: [{ field: "sum_solar_contract_amount", dir: "desc" }],
  });
  assert.equal(r.attempts, 1);
  assert.equal(r.strict, true);
  assert.equal(r.usage.calls.length, 1);
  assert.equal(r.usage.cacheReadTokens, 1000);
});

test("the cached prefix is byte-identical across turns and users of the same gates (and differs by gate)", () => {
  assert.deepEqual(typeSystem("estimates", []), typeSystem("estimates", []));
  assert.notDeepEqual(typeSystem("estimates", []), typeSystem("estimates", [COST]));
  assert.ok(!catalogBlock("estimates", []).includes("estimate.markup_amount"));
  assert.ok(catalogBlock("estimates", [COST]).includes("estimate.markup_amount"));
});

test("prompt: one description per type; the rules carry the glossary, the tokens and the one-question rule", () => {
  assert.deepEqual(Object.keys(TYPE_DESCRIPTIONS).sort(), Object.keys(REPORT_TYPES).sort());
  const rules = rulesBlock();
  for (const t of RELATIVE_TOKENS) assert.ok(rules.includes(t), t);
  assert.match(rules, /ONE short question/);
  assert.match(rules, /Never invent a field/);
  assert.match(rules, /ARIZONA/);
  assert.ok(rules.includes(GLOSSARY));
});

// --- the router ----------------------------------------------------------------------------
test("build without a type: the router picks one, then the type call — two calls, usage summed", async () => {
  const client = fakeClient([choose("service_jobs"), propose({
    summary: "Open service jobs, oldest first.", type: "service_jobs", columns: ["job.name", "customer.name", "job.status", "job.created_date"],
    filters: [{ field: "job.status", op: "not_in", value: ["Paid", "Closed"] }, { field: "job.archived", op: "eq", value: false }],
    groupBy: [], aggregates: [], sort: [{ field: "job.created_date", dir: "asc" }], limit: 5000,
  })]);
  const r = await run(plan({ mode: "build", messages: [{ role: "user", content: "service jobs still open, oldest first" }] }), client);
  assert.equal(client.calls.length, 2);
  assert.deepEqual(client.calls[0].req.tools.map((t) => t.name), ["choose_type", "ask_question"]);
  assert.match(client.calls[0].req.system[1].text, /REPORT TYPES/);
  assert.equal(r.type, "service_jobs");
  assert.equal(r.outcome, "definition");
  assert.equal(r.usage.calls.length, 2);
  assert.deepEqual(r.usage.calls.map((c) => c.kind), ["route", "build"]);
  assert.equal(r.usage.inputTokens, 200);
});

test("the router may ask instead — one call, a question, no type", async () => {
  const client = fakeClient([ask("Do you mean solar projects or service jobs?")]);
  const r = await run(plan({ mode: "build", messages: [{ role: "user", content: "show me the big ones" }] }), client);
  assert.equal(client.calls.length, 1);
  assert.equal(r.outcome, "question");
  assert.equal(r.question, "Do you mean solar projects or service jobs?");
  assert.equal(r.type, null);
});

// --- two attempts --------------------------------------------------------------------------
test("a refused proposal goes back ONCE as an error tool result (append-only), then the fix is accepted", async () => {
  const first = propose({ ...SOLAR_BY_REP, groupBy: ["rep.name", "solar.stage"] }, "tu_bad");
  const client = fakeClient([first, propose(SOLAR_BY_REP, "tu_good")]);
  const r = await run(plan({ mode: "build", type: "solar", messages: [{ role: "user", content: "sold by rep and stage" }] }), client);
  assert.equal(client.calls.length, 2);
  const second = client.calls[1].req.messages;
  assert.deepEqual(second.at(-2), { role: "assistant", content: first.content }, "the assistant turn exactly as returned, thinking included");
  const tr = second.at(-1).content[0];
  assert.equal(tr.type, "tool_result");
  assert.equal(tr.tool_use_id, "tu_bad");
  assert.equal(tr.is_error, true);
  assert.match(tr.content, /TOO_MANY_GROUPS/);
  // The first two messages are unchanged (the cache-friendly, append-only rule).
  assert.deepEqual(second.slice(0, 1), client.calls[0].req.messages);
  assert.equal(r.outcome, "definition");
  assert.equal(r.attempts, 2);
  assert.deepEqual(r.codes, ["TOO_MANY_GROUPS"]);
  assert.deepEqual(r.usage.calls.map((c) => c.kind), ["build", "retry"]);
});

test("refused twice → a question that names the problem (outcome invalid)", async () => {
  const badInput = { ...SOLAR_BY_REP, columns: ["solar.nope"], groupBy: [], aggregates: [], sort: [] };
  const client = fakeClient([propose(badInput), propose(badInput)]);
  const r = await run(plan({ mode: "build", type: "solar", messages: [{ role: "user", content: "x" }] }), client);
  assert.equal(client.calls.length, 2);
  assert.equal(r.outcome, "invalid");
  assert.match(r.question, /solar\.nope/);
  assert.deepEqual(r.codes, ["UNKNOWN_FIELD", "UNKNOWN_FIELD"]);
  assert.equal(r.definition, undefined);
});

test("too little time left: no second attempt", async () => {
  let t = 0;
  const clock = () => t;
  const client = fakeClient([(req) => { t += 20_000; return propose({ ...SOLAR_BY_REP, groupBy: ["rep.name", "solar.stage"] }); }]);
  const r = await run(plan({ mode: "build", type: "solar", messages: [{ role: "user", content: "x" }] }), client, { clock });
  assert.equal(client.calls.length, 1);
  assert.equal(r.outcome, "invalid");
});

test("a proposal for another type is refused like any invalid one", async () => {
  const client = fakeClient([propose({ ...SOLAR_BY_REP, type: "payments" }), propose(SOLAR_BY_REP)]);
  const r = await run(plan({ mode: "build", type: "solar", messages: [{ role: "user", content: "x" }] }), client);
  assert.deepEqual(r.codes, ["TYPE_MISMATCH"]);
  assert.equal(r.outcome, "definition");
});

// --- questions, refusals, text ---------------------------------------------------------------
test("ask_question → the question; plain text with no tool → treated as the question", async () => {
  const q = await run(plan({ mode: "build", type: "invoices_payments", messages: [{ role: "user", content: "revenue last month" }] }), fakeClient([ask("Do you mean invoice totals or payments collected?")]));
  assert.equal(q.outcome, "question");
  assert.equal(q.reply, "Do you mean invoice totals or payments collected?");
  const t = await run(plan({ mode: "build", type: "solar", messages: [{ role: "user", content: "hmm" }] }), fakeClient([text("Which period do you mean?")]));
  assert.equal(t.outcome, "question");
  assert.equal(t.question, "Which period do you mean?");
});

test("stop_reason refusal → outcome refused with a neutral question (still a counted turn)", async () => {
  const r = await run(plan({ mode: "build", type: "solar", messages: [{ role: "user", content: "x" }] }), fakeClient([text("", "refusal")]));
  assert.equal(r.outcome, "refused");
  assert.match(r.question, /describe the report/);
});

// --- strict → non-strict ---------------------------------------------------------------------
test("the API refusing the strict schema: same call again without strict, remembered for that type + gates", async () => {
  const refusal = Object.assign(new Error("tools.0.input_schema: schema is too complex for strict mode"), { status: 400 });
  const client = fakeClient([{ throw: refusal }, propose(SOLAR_BY_REP), propose(SOLAR_BY_REP)]);
  const p = plan({ mode: "build", type: "solar", messages: [{ role: "user", content: "x" }] });
  const r = await run(p, client);
  assert.equal(r.outcome, "definition");
  assert.equal(r.strict, false);
  assert.equal(client.calls[0].req.tools[0].strict, true);
  assert.equal("strict" in client.calls[1].req.tools[0], false);
  assert.equal(r.usage.calls.length, 1, "the refused request produced no tokens");
  await run(p, client);
  assert.equal("strict" in client.calls[2].req.tools[0], false, "remembered: no strict attempt next time");
  assert.equal(isSchemaRefusal({ status: 400, message: "messages: bad" }), false);
  assert.equal(isSchemaRefusal({ status: 500, message: "schema" }), false);
});

test("an API error (5xx, timeout, 429, a non-schema 400) is an AssistUpstreamError — the handler releases the turn", async () => {
  for (const e of [{ status: 529, message: "overloaded" }, { status: 429, message: "rate" }, { status: 400, message: "messages.0: bad" }, { message: "Request timed out." }]) {
    await assert.rejects(
      run(plan({ mode: "build", type: "solar", messages: [{ role: "user", content: "x" }] }), fakeClient([{ throw: Object.assign(new Error(e.message), e) }])),
      (err) => err instanceof AssistUpstreamError,
    );
  }
});

// --- refine / explain ------------------------------------------------------------------------
test("refine: the current definition rides in the last user message; the answer replaces it", async () => {
  const current = { type: "solar", groupBy: ["rep.name"], aggregates: [{ fn: "count" }], filters: [{ field: "solar.contract_date", op: "between", value: "this_quarter" }] };
  const client = fakeClient([propose({ ...SOLAR_BY_REP, filters: [{ field: "solar.contract_date", op: "between", value: "last_quarter" }] })]);
  const r = await run(plan({ mode: "refine", messages: [{ role: "user", content: "make it last quarter" }], currentDefinition: current }), client);
  const last = client.calls[0].req.messages.at(-1).content;
  assert.match(last, /The report open in the editor/);
  assert.ok(last.includes(JSON.stringify(current, null, 2)));
  assert.equal(r.type, "solar");
  assert.equal(r.definition.filters[0].value, "last_quarter");
});

test("explain: the same cached prefix, tool_choice none, one paragraph back", async () => {
  const client = fakeClient([text("This report counts solar projects signed this quarter (October 1 to December 31), grouped by sales rep.")]);
  const r = await run(plan({ mode: "explain", currentDefinition: { type: "solar", groupBy: ["rep.name"], aggregates: [{ fn: "count" }] } }), client);
  const { req } = client.calls[0];
  assert.deepEqual(req.tool_choice, { type: "none" });
  assert.deepEqual(req.system, typeSystem("solar", []), "the build prefix — a cache hit");
  assert.equal(req.messages.length, 1);
  assert.match(req.messages[0].content, /ONE short paragraph/);
  assert.equal(r.outcome, "explained");
  assert.match(r.reply, /grouped by sales rep/);
});

test("gates: a definition naming a gated field is stripped for a caller without the gate (non-strict path)", async () => {
  const client = fakeClient([propose({
    summary: "Estimates with markup.", type: "estimates", columns: ["estimate.name", "estimate.markup_amount"],
    filters: [], groupBy: [], aggregates: [], sort: [], limit: 5000,
  })]);
  const r = await run(plan({ mode: "build", type: "estimates", messages: [{ role: "user", content: "estimates with markup" }] }), client);
  assert.equal(r.outcome, "definition");
  assert.deepEqual(r.definition.columns, ["estimate.name"]);
  assert.deepEqual(r.stripped, ["estimate.markup_amount"]);
});
