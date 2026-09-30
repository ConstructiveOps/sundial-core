// lib/http.test.js — the CORS allowlist answers for each portal that calls this API.
//
// WHY: the allowlist is a literal in six files (this one and five Lambdas' inline
// copies). A portal whose origin is missing from it cannot make a single call — the
// browser blocks every response — so the origins that must work are pinned here, and
// the five inline copies are checked to carry the same list.

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { isAllowedOrigin, corsHeaders } from "./http.js";

const PORTALS = [
  "https://sundial.harmonelectric.net", // Harmon (the primary tenant)
  "https://sundial.constructiveoperations.com", // the Constructive Operations demo
];

test("every portal origin, local dev and Vercel deploys are allowed", () => {
  for (const o of [...PORTALS, "http://localhost:5173", "https://conops-demo.vercel.app", "https://harmon-crm.vercel.app"]) {
    assert.equal(isAllowedOrigin(o), true, o);
    assert.equal(corsHeaders(o)["Access-Control-Allow-Origin"], o);
  }
});

test("anything else is refused and never echoed back", () => {
  for (const o of [
    undefined,
    "",
    "https://example.com",
    "http://sundial.constructiveoperations.com", // http, not https
    "https://sundial.constructiveoperations.com.evil.example",
    "https://evil-vercel.app",
    "https://constructiveoperations.com",
  ]) {
    assert.equal(isAllowedOrigin(o), false, String(o));
    assert.equal(corsHeaders(o)["Access-Control-Allow-Origin"], "http://localhost:5173");
  }
});

test("the five inline copies of the allowlist name the same portals", async () => {
  const copies = [
    "lambdas/sundial-auth-proxy/index.js",
    "lambdas/sundial-sf-query/index.js",
    "lambdas/sundial-sf-update/index.js",
    "lambdas/sundial-aurora-push/index.js",
    "lambdas/sundial-acumatica-push/index.js",
  ];
  for (const rel of copies) {
    const src = await readFile(new URL(`../${rel}`, import.meta.url), "utf8");
    const block = src.match(/const STATIC_ALLOWED_ORIGINS = new Set\(\[([\s\S]*?)\]\);/);
    assert.ok(block, `${rel}: no STATIC_ALLOWED_ORIGINS block`);
    for (const o of PORTALS) assert.ok(block[1].includes(`"${o}"`), `${rel} is missing ${o}`);
  }
});
