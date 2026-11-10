// lib/anthropic.js — the Anthropic API client for the report assistant (D-092, R4).
//
// THE KEY is Constructive Ops' own, shared by every tenant (a platform service like SES — not
// a D-078 single-credential integration; each tenant has its own BUDGET instead,
// sundial_report_assist_claim). It lives in Secrets Manager `sundial/anthropic` under
// `api_key` (`apiKey` accepted). It is never logged, never returned, never put in an error.
//
// THE MODEL is configuration: env REPORT_ASSIST_MODEL, default ASSIST_MODEL (a Sonnet).
// maxRetries 0: the assistant has a 29-second gateway to answer inside and keeps its own clock.

import Anthropic from "@anthropic-ai/sdk";
import { getSecret } from "./secrets.js";

export const ANTHROPIC_SECRET_NAME = "sundial/anthropic";
export const ASSIST_MODEL = "claude-sonnet-5-5";

export class AssistNotConfiguredError extends Error {
  constructor(reason) {
    super(`report assistant is not configured: ${reason}`);
    this.name = "AssistNotConfiguredError";
    this.code = "ASSIST_NOT_CONFIGURED";
  }
}

/** The key from a parsed secret: api_key first, apiKey second; null when neither is usable. */
export function keyFromSecret(secret) {
  const k = secret?.api_key ?? secret?.apiKey;
  return typeof k === "string" && k.trim() !== "" ? k.trim() : null;
}

export function assistModel(env = process.env) {
  const m = env.REPORT_ASSIST_MODEL;
  return typeof m === "string" && m.trim() ? m.trim() : ASSIST_MODEL;
}

let cached = null;

/** One client per warm container. Throws AssistNotConfiguredError (never with the key in it). */
export async function getAnthropicClient({ readSecret = getSecret } = {}) {
  if (cached) return cached;
  let secret;
  try {
    secret = await readSecret(ANTHROPIC_SECRET_NAME);
  } catch (err) {
    // The message names the secret, never a value.
    throw new AssistNotConfiguredError(`cannot read ${ANTHROPIC_SECRET_NAME} (${err?.name || "error"})`);
  }
  const apiKey = keyFromSecret(secret);
  if (!apiKey) throw new AssistNotConfiguredError(`${ANTHROPIC_SECRET_NAME} has no api_key`);
  cached = new Anthropic({ apiKey, maxRetries: 0 });
  return cached;
}

export function _resetAnthropicClient() {
  cached = null;
}
