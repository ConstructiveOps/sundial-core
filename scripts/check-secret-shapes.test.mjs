// node --test scripts/check-secret-shapes.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { examine, readLoose, ShapeError, main } from "./check-secret-shapes.mjs";

const H = { secretKey: "rk_live_HARMONSECRETVALUE", webhookSecret: "whsec_HARMONHOOK" };
const D = { secretKey: "sk_test_DEMOSECRETVALUE", webhookSecret: "whsec_DEMOHOOK" };
const VALUES = [H.secretKey, H.webhookSecret, D.secretKey, D.webhookSecret, "HARMONSECRET", "DEMOSECRET"];
const noValues = (r) => { for (const v of VALUES) assert.ok(!r.lines.join("\n").includes(v), "a value was printed"); };
const run = (text) => { const r = examine("sundial/stripe", text, {}); noValues(r); return r; };

test("a correct secret: both tenants on, nothing to fix", () => {
  const r = run(JSON.stringify({ tenants: { harmon: H, "conops-demo": D } }, null, 2));
  assert.equal(r.ok, true);
  assert.match(r.lines.join("\n"), /harmon\s+payments ON \(LIVE mode\)/);
  assert.match(r.lines.join("\n"), /conops-demo\s+payments ON \(TEST mode\)/);
});

test("a flat primary key plus a tenants block for the demo is fine", () => {
  const r = run(JSON.stringify({ ...H, tenants: { "conops-demo": D } }));
  assert.equal(r.ok, true);
});

test("the tenants block saved as TEXT (Key/value editor): harmon off today, repaired to on, values intact", () => {
  const r = run(JSON.stringify({ tenants: JSON.stringify({ harmon: H, "conops-demo": D }) }));
  assert.equal(r.ok, false);
  assert.equal(r.fixable, true);
  assert.match(r.lines.join("\n"), /saved as TEXT/);
  assert.match(r.lines.join("\n"), /harmon\s+NOT SET UP/);
  assert.deepEqual(r.repaired, { tenants: { harmon: H, "conops-demo": D } });
});

test("a tenant's own block saved as text is repaired too", () => {
  const r = run(JSON.stringify({ tenants: { harmon: JSON.stringify(H), "conops-demo": D } }));
  assert.equal(r.fixable, true);
  assert.deepEqual(r.repaired, { tenants: { harmon: H, "conops-demo": D } });
});

test("two tenants blocks: JSON keeps the last, harmon vanishes; the repair merges them", () => {
  const text = `{ "tenants": { "harmon": ${JSON.stringify(H)} }, "tenants": { "conops-demo": ${JSON.stringify(D)} } }`;
  assert.deepEqual(Object.keys(JSON.parse(text).tenants), ["conops-demo"]);
  const r = run(text);
  assert.equal(r.fixable, true);
  assert.match(r.lines.join("\n"), /appears TWICE/);
  assert.deepEqual(r.repaired, { tenants: { harmon: H, "conops-demo": D } });
});

test("two blocks that disagree about the same tenant are NOT repaired automatically", () => {
  const text = `{ "tenants": { "harmon": ${JSON.stringify(H)} }, "tenants": { "harmon": ${JSON.stringify(D)} } }`;
  const r = run(text);
  assert.equal(r.fixable, false);
  assert.match(r.lines.join("\n"), /CANNOT REPAIR AUTOMATICALLY/);
});

test("a trailing comma and a missing comma: invalid JSON, located, repaired", () => {
  const trailing = `{\n  "tenants": {\n    "harmon": ${JSON.stringify(H)},\n    "conops-demo": ${JSON.stringify(D)},\n  }\n}`;
  assert.throws(() => JSON.parse(trailing));
  let r = run(trailing);
  assert.equal(r.fixable, true);
  assert.match(r.lines.join("\n"), /NOT valid JSON \(an extra comma at line 4/);
  assert.deepEqual(r.repaired, { tenants: { harmon: H, "conops-demo": D } });
  const missing = `{\n  "tenants": {\n    "harmon": ${JSON.stringify(H)}\n    "conops-demo": ${JSON.stringify(D)}\n  }\n}`;
  r = run(missing);
  assert.equal(r.fixable, true);
  assert.match(r.lines.join("\n"), /a missing comma at line 4/);
  assert.deepEqual(r.repaired, { tenants: { harmon: H, "conops-demo": D } });
});

test("text that cannot be read at all gives a position and no content", () => {
  const r = run(`{ "tenants": { "harmon": { "secretKey": "rk_live_HARMONSECRETVALUE } } }`);
  assert.equal(r.fixable, false);
  assert.match(r.lines.join("\n"), /not valid JSON at line 1, column \d+/);
  assert.throws(() => readLoose(`{ "a": “x” }`), ShapeError);
});

test("the primary tenant's block replaced by the demo's: not fixable, says to restore", () => {
  const r = run(JSON.stringify({ tenants: { "conops-demo": D } }));
  assert.equal(r.ok, false);
  assert.equal(r.fixable, false);
  assert.match(r.lines.join("\n"), /primary tenant "harmon" has no usable entry/);
});

test("the demo block put at the top level beside tenants, and a wrongly-cased slug", () => {
  let r = run(JSON.stringify({ tenants: { Harmon: H }, "conops-demo": D }));
  assert.equal(r.fixable, false);
  assert.match(r.lines.join("\n"), /harmon\s+NOT SET UP/);
  r = run(JSON.stringify({ tenants: { harmon: { ...H, secretKey: " " + H.secretKey + "\n" } } }));
  assert.equal(r.ok, true); // lib/stripe.js trims
});

test("other secrets: a stringified block is found and repaired", () => {
  const r = examine("sundial/twilio", JSON.stringify({ accountSid: "ACxxxxSECRET", authToken: "tokSECRET", fromNumber: "+16025550100", defaultTenant: "harmon", tenantNumbers: JSON.stringify({ "conops-demo": "+16025550101" }) }), {});
  assert.equal(r.fixable, true);
  assert.equal(r.repaired.tenantNumbers["conops-demo"], "+16025550101");
  assert.ok(!r.lines.join("\n").includes("SECRET") && !r.lines.join("\n").includes("+1602"));
  assert.equal(examine("sundial/brand", JSON.stringify({ harmon: { companyName: "X" }, "conops-demo": { companyName: "Y" } }), {}).ok, true);
});

// --- the command line, against a stand-in for Secrets Manager ------------------------------
function fakeAws(store) {
  const puts = [];
  class GetSecretValueCommand { constructor(input) { this.input = input; this.kind = "get"; } }
  class PutSecretValueCommand { constructor(input) { this.input = input; this.kind = "put"; } }
  class SecretsManagerClient {
    async send(cmd) {
      const s = store[cmd.input.SecretId];
      if (!s) { const e = new Error("nope"); e.name = "ResourceNotFoundException"; throw e; }
      if (cmd.kind === "get") {
        const text = cmd.input.VersionStage === "AWSPREVIOUS" ? s.previous : s.current;
        if (text == null) { const e = new Error("nope"); e.name = "ResourceNotFoundException"; throw e; }
        return { SecretString: text };
      }
      puts.push(cmd.input);
      s.previous = s.current;
      s.current = cmd.input.SecretString;
      return {};
    }
  }
  return { deps: { SecretsManagerClient, GetSecretValueCommand, PutSecretValueCommand }, puts };
}
async function cli(argv, store) {
  const aws = fakeAws(store);
  const out = [];
  const log = console.log;
  console.log = (...a) => out.push(a.join(" "));
  let code;
  try { code = await main(argv, aws.deps); } finally { console.log = log; }
  const text = out.join("\n");
  for (const v of VALUES) assert.ok(!text.includes(v), "a value was printed");
  return { code, text, puts: aws.puts };
}
const GOOD = JSON.stringify({ tenants: { harmon: H } }, null, 2);

test("cli: the plain check writes nothing, and points at --fix for a stringified block", async () => {
  const store = { "sundial/stripe": { current: JSON.stringify({ tenants: JSON.stringify({ harmon: H, "conops-demo": D }) }), previous: GOOD } };
  const r = await cli(["sundial/stripe"], store);
  assert.equal(r.code, 1);
  assert.equal(r.puts.length, 0);
  assert.match(r.text, /--fix sundial\/stripe/);
});

test("cli: --fix saves the repaired secret with every value intact and prints the restarts", async () => {
  const store = { "sundial/stripe": { current: JSON.stringify({ tenants: JSON.stringify({ harmon: H, "conops-demo": D }) }), previous: GOOD } };
  const r = await cli(["--fix", "sundial/stripe"], store);
  assert.equal(r.code, 0);
  assert.equal(r.puts.length, 1);
  assert.deepEqual(JSON.parse(store["sundial/stripe"].current), { tenants: { harmon: H, "conops-demo": D } });
  assert.match(r.text, /update-function-configuration --function-name sundial-service-estimate/);
  assert.match(r.text, /update-function-configuration --function-name sundial-service-public/);
});

test("cli: --fix refuses when harmon would still be missing; the check then offers the previous version", async () => {
  const store = { "sundial/stripe": { current: JSON.stringify({ tenants: { "conops-demo": D } }), previous: GOOD } };
  let r = await cli(["--fix", "sundial/stripe"], store);
  assert.equal(r.code, 1);
  assert.equal(r.puts.length, 0);
  r = await cli(["sundial/stripe"], store);
  assert.match(r.text, /--restore-previous sundial\/stripe/);
  assert.equal(r.puts.length, 0);
});

test("cli: --restore-previous puts the earlier version back byte for byte, only when it checks out", async () => {
  const store = { "sundial/stripe": { current: JSON.stringify({ tenants: { "conops-demo": D } }), previous: GOOD } };
  let r = await cli(["--restore-previous", "sundial/stripe"], store);
  assert.equal(r.code, 0);
  assert.equal(store["sundial/stripe"].current, GOOD);
  assert.match(r.text, /RESTORED/);
  const broken = { "sundial/stripe": { current: JSON.stringify({ tenants: { "conops-demo": D } }), previous: JSON.stringify({ tenants: { "conops-demo": D } }) } };
  r = await cli(["--restore-previous", "sundial/stripe"], broken);
  assert.equal(r.code, 1);
  assert.equal(r.puts.length, 0);
  const none = { "sundial/stripe": { current: GOOD, previous: null } };
  r = await cli(["--restore-previous", "sundial/stripe"], none);
  assert.equal(r.code, 1);
});

test("cli: a healthy secret and a missing one", async () => {
  const r = await cli([], { "sundial/stripe": { current: JSON.stringify({ tenants: { harmon: H, "conops-demo": D } }), previous: GOOD } });
  assert.equal(r.code, 0);
  assert.match(r.text, /OK — nothing wrong/);
  assert.equal(r.puts.length, 0);
});
