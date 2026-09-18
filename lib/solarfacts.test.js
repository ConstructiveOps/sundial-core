// lib/solarfacts.js — the SolarFax hand-off (D-073.6): config out of the club secret, the
// two POST /users bodies (invite, disconnect), the client's headers and error shapes.
import test from "node:test";
import assert from "node:assert/strict";
import { createSolarFactsClient, disconnectBody, inviteBody, solarFactsConfigFor, splitName, SolarFactsError, SOLARFACTS_API } from "./solarfacts.js";

test("config: needs both credentials; template + base URL + test mode are optional", () => {
  assert.equal(solarFactsConfigFor({}), null);
  assert.equal(solarFactsConfigFor({ solarFacts: { apiKey: "k" } }), null, "no token");
  const c = solarFactsConfigFor({ solarFacts: { apiKey: " k ", accessToken: "t", inviteTemplate: "Harmon Connect" } });
  assert.deepEqual(c, { apiKey: "k", accessToken: "t", inviteTemplate: "Harmon Connect", baseUrl: SOLARFACTS_API, test: false });
  assert.equal(solarFactsConfigFor({ solarFacts: { apiKey: "k", accessToken: "t", baseUrl: "https://x/v1/", test: "1" } }).baseUrl, "https://x/v1");
  assert.equal(solarFactsConfigFor({ solarFacts: { apiKey: "k", accessToken: "t", test: true } }).test, true);
});

test("names: first + last out of a full name", () => {
  assert.deepEqual(splitName("Ann Lee"), { firstName: "Ann", lastName: "Lee" });
  assert.deepEqual(splitName("Mary Jo Kopechne"), { firstName: "Mary Jo", lastName: "Kopechne" });
  assert.deepEqual(splitName("Cher"), { firstName: "Cher", lastName: "" });
  assert.deepEqual(splitName(null), { firstName: "", lastName: "" });
});

test("bodies: the invite creates-or-updates with login + emails + the connect template; the disconnect is the flag SolarFax documents", () => {
  const inv = inviteBody({ firstName: "Ann", lastName: "Lee", email: "ann@example.com", phone: "602-555-0101", street: "9 Oak St", city: "Mesa", state: "AZ", zip: "85201", inviteTemplate: "Harmon Connect", test: true });
  assert.deepEqual(inv, {
    user: { firstName: "Ann", lastName: "Lee", email: "ann@example.com", enableAccess: "1", enableEmails: "1" },
    account: { phone: "602-555-0101", addressOne: "9 Oak St", city: "Mesa", state: "AZ", zip: "85201", isLead: "0" },
    newOnly: "0",
    sendEmailTemplate: { Name: "Harmon Connect" },
    test: "1",
  });
  assert.equal(inviteBody({ email: "a@b.c" }).sendEmailTemplate, undefined, "no template configured → SolarFax's default (nothing) — the runbook says to set it");
  assert.equal(inviteBody({ email: "a@b.c" }).test, undefined);
  assert.deepEqual(disconnectBody({ firstName: "Ann", lastName: "Lee", email: "ann@example.com" }), { user: { firstName: "Ann", lastName: "Lee", email: "ann@example.com" }, disconnect: "1", newOnly: "0" });
});

test("client: both auth headers on every call; SolarFax's success:false is an error with its message; network failure is status 0", async () => {
  const calls = [];
  const fetchUrl = async (url, init) => {
    calls.push({ url, init });
    if (JSON.parse(init.body).disconnect === "1") return { ok: true, status: 200, json: async () => ({ success: false, message: "No such user" }) };
    return { ok: true, status: 200, json: async () => ({ success: true, message: "User 'Ann Lee' created", action: "created", account_id: "A1", user_id: "U1" }) };
  };
  const client = createSolarFactsClient({ apiKey: "key", accessToken: "tok", inviteTemplate: "Harmon Connect", baseUrl: SOLARFACTS_API, test: false }, { fetchUrl });
  const r = await client.invite({ firstName: "Ann", lastName: "Lee", email: "ann@example.com", street: "9 Oak St", zip: "85201" });
  assert.equal(r.account_id, "A1");
  assert.equal(calls[0].url, "https://api.solardatapros.com/api/v1/users");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers["Api-Key"], "key");
  assert.equal(calls[0].init.headers["Access-Token"], "tok");
  assert.equal(JSON.parse(calls[0].init.body).sendEmailTemplate.Name, "Harmon Connect");
  await assert.rejects(() => client.disconnect({ email: "ann@example.com" }), (e) => e instanceof SolarFactsError && /No such user/.test(e.message));
  const down = createSolarFactsClient({ apiKey: "key", accessToken: "tok", baseUrl: SOLARFACTS_API }, { fetchUrl: async () => { throw new Error("ECONNRESET"); } });
  await assert.rejects(() => down.invite({ email: "x@y.z" }), (e) => e instanceof SolarFactsError && e.status === 0);
  assert.throws(() => createSolarFactsClient({ apiKey: "" }), /no credentials/);
});
