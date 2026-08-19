// Constant-time secret comparison, shared by every public webhook gate.
//
// Sundial now has three public routes whose ONLY protection is a shared secret in a
// header — the Aurora doorbell, the Retell webhook, and the comment-mention hook.
// This is the one comparison they all use, so none of them can quietly drift into a
// `===` that leaks the secret through timing.
//
// It started as a private helper in sundial-welcome-call/webhook.js; that file now
// re-exports from here so its public surface (and its tests) are unchanged.
//
// Value-safety: never logs either operand.

import crypto from "node:crypto";

/**
 * Constant-time equality that is also LENGTH-SAFE.
 *
 * Two problems this solves at once:
 *   - `crypto.timingSafeEqual` THROWS when the buffers differ in length, so it cannot
 *     be handed a caller-supplied string directly.
 *   - Comparing the lengths first to avoid that throw leaks the expected length, which
 *     is itself a useful hint to an attacker.
 *
 * Hashing both sides to a fixed 32 bytes removes both: the digests are always the same
 * size, and only identical inputs produce identical digests.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function constantTimeEquals(a, b) {
  const ha = crypto.createHash("sha256").update(String(a), "utf8").digest();
  const hb = crypto.createHash("sha256").update(String(b), "utf8").digest();
  return crypto.timingSafeEqual(ha, hb);
}
