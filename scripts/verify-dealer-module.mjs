#!/usr/bin/env node
// Dealer module step 8 of 9: the end-to-end proof of what steps 0–7 shipped, run against
// the DEPLOYED API and database as the ZZ TEST users.
//
//   node scripts/verify-dealer-module.mjs
//   node scripts/verify-dealer-module.mjs --skip-stage   # read + comment checks only, no Salesforce write
//
// WHAT IT ASSERTS
//   A. LISTS     zz-rep-a1's /dealer/customers is exactly their own customers (minus the ones
//                the shell leaves to the Service module) and their detail read carries the
//                solar twin; zz-mgr-a (Sales Dealer, dealer A) lists every dealer-A customer;
//                zz-rep-b1 (dealer B) gets 404 on dealer-A customers.
//   B. COMMENTS  the rep reads the PUBLIC comments on the customer AND its solar (D-086,
//                solar through its customer) and not the PRIVATE one; the rep's post lands on
//                the CUSTOMER with context 'dealer'; staff set_comment_private() hides a row
//                and the rep's next read loses it.
//   C. STAGE     a tenant user moves ZZ PORTAL TEST 2's Stage__c through PATCH /sf/customer
//                (sf-update flags the cache row stale → the office's re-read refreshes it →
//                trigger → POST /webhooks/stage-change → notifier; the 5-minute sync is the
//                fallback, and the script prints which path delivered):
//                exactly ONE category 'stage' bell row for the deal's rep and one for the
//                dealer's Sales Dealer, none for an unrelated rep, and still one after a second
//                cache sync. Then the stage is restored.
//   D. TECH      a sales login gets 403 from the tech app's routes (/service/tech/*).
//   E. MANIFEST  the manifest version the server advertises equals lib/field-manifest's.
//
// ZZ PORTAL TEST 2 belongs to zz-rep-a2, not zz-rep-a1 (zz-rep-a1 owns only the designated
// record). So C asserts on the record's OWN rep, read from Salesforce, and uses zz-rep-a1 as
// the "not your deal" control.
//
// ⚠️ WRITES, all on ZZ fixtures only (assertZz makes that mechanical):
//   - B inserts four comments on the designated record + its solar twin and deletes each in
//     a finally block, as its author.
//   - C writes Stage__c on ZZ PORTAL TEST 2 ONCE, re-reads the whole record (FIELDS(ALL)) and
//     aborts — restoring first — if a field it did not write changed (the canary rule,
//     CLAUDE.md). Two bell rows per run are created for zz-rep-a2 / zz-mgr-a (one for the
//     move, one for the restore); the script marks them read. Push goes only to ZZ devices.
//   - C invokes sundial-cache-sync for `customer` once (the same run EventBridge makes
//     every 5 minutes).
// Passwords come from Secrets Manager `sundial/test-users`, never a file. Afterwards:
//   node scripts/seed-access-test-fixtures.mjs --apply

import { createClient } from "@supabase/supabase-js";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { sfQuery, soqlEscapeString } from "../lib/salesforce.js";
import { MANIFEST_VERSION } from "../lib/field-manifest/index.js";
import { resolveSupabasePublic, loadTestPasswords } from "./portal-login.mjs";
import { EMAIL } from "./seed-access-test-fixtures.mjs";

const API = (process.env.API_BASE_URL || "https://5sktfwldh1.execute-api.us-west-1.amazonaws.com/prod").replace(/\/+$/, "");
const REGION = "us-west-1";
const TENANT_ID = "a1W7y000007AszBEAS"; // Harmon's Sundial_Tenant__c
const SKIP_STAGE = process.argv.includes("--skip-stage");

// ZZ fixtures. Never substitute a live record or a live user (CLAUDE.md).
const DESIGNATED = "a1P7y00000AmyXCEAZ"; // ZZ PORTAL TEST — DO NOT USE (zz-rep-a1's)
const STAGE_RECORD = "a1P7y00000ApR0PEAV"; // ZZ PORTAL TEST 2 (zz-rep-a2's, dealer A)
const STAGE_TARGETS = ["Contact Attempt Made", "Appointment Set"]; // customer journey steps

// Fields the platform moves on any write; a change here is not "a field we did not write".
const SYSTEM_FIELDS = new Set(["LastModifiedDate", "LastModifiedById", "SystemModstamp", "LastViewedDate", "LastReferencedDate"]);

const results = [];
function check(section, name, pass, detail) {
  results.push({ section, name, pass });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${section}. ${name}`);
  if (detail) console.log(`          ${detail}`);
}
function note(text) {
  console.log(`          ${text}`);
}

// --- fixtures, read live so a re-seed never leaves the script pointing at stale ids ------
async function loadFixtures() {
  const t = soqlEscapeString(TENANT_ID);
  const customers = await sfQuery(
    `SELECT Id, Name, Sales_Rep__c, Dealer__c, Customer_Type__c, Archived__c, Linked_Solar_Project__c ` +
      `FROM Sundial_Customer__c WHERE Client__c = '${t}' AND Name LIKE 'ZZ PORTAL TEST%'`
  );
  const users = await sfQuery(
    `SELECT Id, Email__c, Access_Level__c, Dealer__c FROM Sundial_User__c WHERE Client__c = '${t}' AND Email__c LIKE 'tim+zz-%'`
  );
  const ZZ = new Set(customers.flatMap((c) => [c.Id, c.Linked_Solar_Project__c].filter(Boolean)));
  const userBySlug = (slug) => users.find((u) => u.Email__c?.toLowerCase() === EMAIL(slug).toLowerCase()) ?? null;
  return { customers, users, ZZ, userBySlug };
}

/** The Sales page / dealer shell leave a customer tagged Service and nothing else to the Service module. */
const isServiceOnly = (c) => String(c.Customer_Type__c ?? "").split(";").map((s) => s.trim()).filter(Boolean).join(";") === "Service";

/** Why a customer the row filter admits is not on the dealer list — printed, never silent. */
function exclusionReason(c) {
  if (isServiceOnly(c)) return "Service-only (Customer_Type__c = Service; the shell leaves it to the Service module)";
  return null;
}

// --- sessions ------------------------------------------------------------------------------
async function signIn(cfg, slug, passwords) {
  const email = EMAIL(slug);
  if (!passwords[email]) throw new Error(`No password for ${email} in sundial/test-users — re-seed the fixtures.`);
  const sb = createClient(cfg.url, cfg.key, { auth: { persistSession: false } });
  const { data, error } = await sb.auth.signInWithPassword({ email, password: passwords[email] });
  if (error) throw new Error(`sign-in failed for ${email}: ${error.message}`);
  return { slug, sb, userId: data.user.id, token: data.session.access_token };
}

async function api(actor, method, path, body) {
  try {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: { Authorization: `Bearer ${actor.token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  } catch (err) {
    return { status: null, body: null, error: err.message };
  }
}

/** Every id on the dealer list, following hasMore. null if a page fails. */
async function dealerIds(actor) {
  const ids = new Set();
  for (let offset = 0; offset < 20000; offset += 200) {
    const r = await api(actor, "GET", `/dealer/customers?limit=200&offset=${offset}`);
    if (r.status !== 200 || !Array.isArray(r.body?.records)) return { ids: null, status: r.status };
    for (const rec of r.body.records) ids.add(rec.sf_id ?? rec.id ?? rec.Id);
    if (!r.body.hasMore) break;
  }
  return { ids, status: 200 };
}

function sameSet(a, b) {
  return a.size === b.size && [...a].every((x) => b.has(x));
}

// --- A. lists --------------------------------------------------------------------------------
async function checkLists(fx, s) {
  const repA1 = fx.userBySlug("rep-a1");
  const mgrA = fx.userBySlug("mgr-a");
  const dealerA = mgrA?.Dealer__c ?? null;

  // A1 — the rep: own customers only.
  const ownAll = fx.customers.filter((c) => c.Sales_Rep__c === repA1?.Id);
  const own = await dealerIds(s.repA1);
  if (!own.ids) {
    check("A", "zz-rep-a1 lists only own customers", false, `GET /dealer/customers → ${own.status}`);
  } else {
    const expected = new Set(ownAll.filter((c) => !exclusionReason(c)).map((c) => c.Id));
    const foreign = [...own.ids].filter((id) => !ownAll.some((c) => c.Id === id));
    check(
      "A",
      "zz-rep-a1 lists only own customers (and every own one the shell shows)",
      foreign.length === 0 && sameSet(own.ids, expected),
      `${own.ids.size} row(s); ${foreign.length} not theirs; expected ${expected.size}`
    );
    for (const c of ownAll) {
      const why = exclusionReason(c);
      if (why) note(`excluded: ${c.Name} — ${why}${c.Archived__c ? "; also archived (archive does not hide it here)" : ""}`);
    }
    if (own.ids.size === 0) note("an EMPTY list for this rep is explained by the exclusions above, not by the row filter");
  }

  // A2 — the rep reads their customer's solar through it, on the detail read.
  const withTwin = ownAll.find((c) => c.Linked_Solar_Project__c);
  if (withTwin) {
    const r = await api(s.repA1, "GET", `/dealer/customers/${withTwin.Id}`);
    const got = r.body?.solar?.Id ?? null;
    check(
      "A",
      `zz-rep-a1 reads the solar twin through /dealer/customers/{id} (${withTwin.Name})`,
      r.status === 200 && got === withTwin.Linked_Solar_Project__c,
      `status ${r.status}, solar ${got ?? "none"}, expected ${withTwin.Linked_Solar_Project__c}`
    );
  } else {
    check("A", "zz-rep-a1 reads the solar twin", false, "no customer of zz-rep-a1 has a solar twin — re-seed the fixtures");
  }

  // A3 — the dealer: every dealer-A customer.
  const dealerAll = fx.customers.filter((c) => dealerA && c.Dealer__c === dealerA);
  const mgr = await dealerIds(s.mgrA);
  if (!mgr.ids) {
    check("A", "zz-mgr-a lists every dealer-A customer", false, `GET /dealer/customers → ${mgr.status}`);
  } else {
    const expected = new Set(dealerAll.filter((c) => !exclusionReason(c)).map((c) => c.Id));
    // Also every dealer-A customer outside the ZZ fixtures, from Salesforce, so "every" is
    // not limited to the records this script happens to know by name.
    const sfDealerA = dealerA
      ? await sfQuery(
          `SELECT Id, Name, Customer_Type__c, Archived__c FROM Sundial_Customer__c ` +
            `WHERE Client__c = '${soqlEscapeString(TENANT_ID)}' AND Dealer__c = '${soqlEscapeString(dealerA)}'`
        )
      : [];
    for (const c of sfDealerA) if (!exclusionReason(c)) expected.add(c.Id);
    check(
      "A",
      "zz-mgr-a (Sales Dealer, dealer A) lists every dealer-A customer and nothing else",
      sameSet(mgr.ids, expected),
      `${mgr.ids.size} row(s), expected ${expected.size} (Salesforce has ${sfDealerA.length} dealer-A customers)`
    );
    for (const c of sfDealerA) {
      const why = exclusionReason(c);
      if (why) note(`excluded: ${c.Name} — ${why}`);
    }
  }

  // A4 — another dealer's user: 404 on every dealer-A customer, list and detail.
  for (const c of dealerAll) {
    const r = await api(s.repB1, "GET", `/dealer/customers/${c.Id}`);
    check("A", `zz-rep-b1 (dealer B) gets 404 on dealer-A customer ${c.Name}`, r.status === 404, `status ${r.status}`);
  }
  const b = await dealerIds(s.repB1);
  const leaked = b.ids ? [...b.ids].filter((id) => dealerAll.some((c) => c.Id === id)) : null;
  check("A", "zz-rep-b1's list carries no dealer-A customer", leaked !== null && leaked.length === 0,
    leaked === null ? `GET /dealer/customers → ${b.status}` : `${b.ids.size} row(s), ${leaked.length} dealer-A`);
}

// --- B. comments -------------------------------------------------------------------------------
async function checkComments(fx, s, tenantId) {
  const cust = fx.customers.find((c) => c.Id === DESIGNATED);
  const solarId = cust?.Linked_Solar_Project__c ?? null;
  if (!cust || !solarId) {
    check("B", "comment fixtures", false, "the designated record or its solar twin is missing — re-seed");
    return;
  }
  const assertZz = (id) => {
    if (!fx.ZZ.has(id)) throw new Error(`REFUSING to write to ${id} — not a ZZ PORTAL TEST record.`);
  };
  const post = (actor, { object, id, body, isPrivate, context }) => {
    assertZz(id);
    return actor.sb
      .from("comments")
      .insert({
        tenant_id: tenantId,
        record_object: object,
        record_id: id,
        author_id: actor.userId,
        author_name: "ZZ dealer-module verify",
        body,
        ...(isPrivate ? { is_private: true } : {}),
        ...(context ? { context } : {}),
      })
      .select("id")
      .single();
  };
  const feed = (actor) =>
    actor.sb.from("comments").select("id, record_object, record_id, is_private, context").in("record_id", [cust.Id, solarId]);
  const made = []; // [actor, id, label]

  try {
    // Canary: one staff insert, read back, before anything else is written.
    const pubCust = await post(s.admin, { object: "customer", id: cust.Id, body: "ZZ verify — staff PUBLIC customer comment" });
    if (pubCust.error) {
      check("B", "staff can write a public customer comment (canary)", false, `${pubCust.error.code}: ${pubCust.error.message}`);
      return;
    }
    made.push([s.admin, pubCust.data.id, "staff public customer comment"]);
    const back = await s.admin.sb.from("comments").select("id").eq("id", pubCust.data.id);
    if ((back.data ?? []).length !== 1) {
      check("B", "staff reads back its canary comment", false, "0 rows — stopping the comment checks");
      return;
    }

    const pubSolar = await post(s.admin, { object: "solar", id: solarId, body: "ZZ verify — staff PUBLIC solar comment" });
    const privCust = await post(s.admin, { object: "customer", id: cust.Id, body: "ZZ verify — staff PRIVATE customer comment", isPrivate: true });
    for (const [r, label] of [[pubSolar, "staff public solar comment"], [privCust, "staff private customer comment"]]) {
      if (r.data?.id) made.push([s.admin, r.data.id, label]);
    }
    check("B", "staff seeds a public solar and a private customer comment", !!pubSolar.data?.id && !!privCust.data?.id,
      pubSolar.error || privCust.error ? `${(pubSolar.error ?? privCust.error).message}` : null);

    // The rep's merged feed (the dealer shell's loadFeed shape).
    const r1 = await feed(s.repA1);
    const ids1 = new Set((r1.data ?? []).map((c) => c.id));
    check("B", "the rep reads the PUBLIC comment on the customer", ids1.has(pubCust.data.id), r1.error?.message ?? null);
    check("B", "the rep reads the PUBLIC comment on its solar (solar through its customer, D-086)", !!pubSolar.data?.id && ids1.has(pubSolar.data.id));
    check("B", "the rep does NOT read the PRIVATE customer comment", !!privCust.data?.id && !ids1.has(privCust.data.id),
      `${ids1.size} row(s) in the rep's feed`);

    // The rep's post: on the CUSTOMER, context dealer, public.
    const repPost = await post(s.repA1, { object: "customer", id: cust.Id, body: "ZZ verify — the rep posts from the dealer feed", context: "dealer" });
    if (repPost.data?.id) made.push([s.repA1, repPost.data.id, "rep dealer-feed comment"]);
    const seen = repPost.data?.id
      ? await s.admin.sb.from("comments").select("record_object, record_id, context, is_private").eq("id", repPost.data.id).single()
      : { data: null };
    const row = seen.data;
    check(
      "B",
      "the rep's post lands on the customer with context 'dealer'",
      !!row && row.record_object === "customer" && row.record_id === cust.Id && row.context === "dealer" && row.is_private === false,
      repPost.error ? `${repPost.error.code}: ${repPost.error.message}` : `as staff reads it: ${JSON.stringify(row)}`
    );

    // Staff hides the public customer comment; the rep's next read loses it.
    const flip = await s.admin.sb.rpc("set_comment_private", { p_comment_id: pubCust.data.id, p_private: true });
    const r2 = await feed(s.repA1);
    const ids2 = new Set((r2.data ?? []).map((c) => c.id));
    check(
      "B",
      "staff set_comment_private(true) flips the row and the rep's next read loses it",
      !flip.error && flip.data === true && !ids2.has(pubCust.data.id) && (!pubSolar.data?.id || ids2.has(pubSolar.data.id)),
      flip.error ? `${flip.error.code}: ${flip.error.message}` : `returned ${flip.data}; flipped row in the rep's feed: before ${ids1.has(pubCust.data.id)}, after ${ids2.has(pubCust.data.id)}`
    );
  } finally {
    for (const [actor, id, label] of made.reverse()) {
      const del = await actor.sb.from("comments").delete().eq("id", id).select("id");
      if (del.error || (del.data ?? []).length !== 1) note(`⚠️ ${label} ${id} NOT deleted — remove it by hand`);
    }
  }
}

// --- C. stage-change notifications ---------------------------------------------------------------
async function readAll(id) {
  const rows = await sfQuery(`SELECT FIELDS(ALL) FROM Sundial_Customer__c WHERE Id = '${soqlEscapeString(id)}' LIMIT 1`);
  const r = rows[0] ?? null;
  if (r) delete r.attributes;
  return r;
}

/** Fields that differ between two FIELDS(ALL) reads, minus the ones named and the platform's. */
function changedFields(before, after, written) {
  return Object.keys({ ...before, ...after }).filter(
    (k) => !written.includes(k) && !SYSTEM_FIELDS.has(k) && JSON.stringify(before[k] ?? null) !== JSON.stringify(after[k] ?? null)
  );
}

async function stageRows(actor, recordId, sinceIso) {
  const r = await actor.sb
    .from("sundial_notifications")
    .select("id, category, dedupe_key, title, created_at")
    .eq("record_sf_id", recordId)
    .eq("category", "stage")
    .gte("created_at", sinceIso);
  return r.error ? null : r.data ?? [];
}

async function waitFor(fn, ok, ms = 45000) {
  const end = Date.now() + ms;
  let last = await fn();
  while (!ok(last) && Date.now() < end) {
    await new Promise((res) => setTimeout(res, 3000));
    last = await fn();
  }
  return last;
}

async function checkStage(fx, s) {
  const rec = fx.customers.find((c) => c.Id === STAGE_RECORD);
  if (!rec || !fx.ZZ.has(STAGE_RECORD)) {
    check("C", "stage fixture", false, "ZZ PORTAL TEST 2 not found — re-seed");
    return;
  }
  // Recipients by the RECORD's own rep and dealer, never assumed.
  const owner = fx.users.find((u) => u.Id === rec.Sales_Rep__c);
  const ownerSlug = owner ? Object.keys(s).find((k) => s[k].sfUserId === owner.Id) : null;
  const repActor = ownerSlug ? s[ownerSlug] : null;
  const dealerActor = s.mgrA.dealerId === rec.Dealer__c ? s.mgrA : null;
  const bystander = s.repA1.sfUserId !== rec.Sales_Rep__c ? s.repA1 : null;
  if (!repActor || !dealerActor) {
    check("C", "stage recipients", false, `record rep ${rec.Sales_Rep__c} / dealer ${rec.Dealer__c} are not a signed-in ZZ rep / mgr-a`);
    return;
  }
  note(`record ${rec.Name}: rep = zz-${repActor.slug}, dealer user = zz-${dealerActor.slug}, control = ${bystander ? `zz-${bystander.slug}` : "none"}`);

  const before = await readAll(STAGE_RECORD);
  const original = before?.Stage__c ?? null;

  // The trigger compares the CACHE's old and new stage, so the cache must agree with
  // Salesforce before the write. A previous run's restore can still be waiting for its
  // refresh, and then "moving" the stage to the value the cache already holds is,
  // correctly, silent. A single read refreshes a stale row; the sync is the fallback.
  const cacheStage = async () => (await api(s.admin, "GET", `/sf/customer/${STAGE_RECORD}`)).body?.record?.stage ?? null;
  let cached = await cacheStage();
  if (cached !== original) {
    await new LambdaClient({ region: REGION }).send(
      new InvokeCommand({ FunctionName: "sundial-cache-sync", Payload: Buffer.from(JSON.stringify({ object: "customer" })) })
    );
    cached = await cacheStage();
  }
  if (cached !== original) {
    check("C", "the cache agrees with Salesforce before the write", false, `cache ${cached ?? "(blank)"}, Salesforce ${original ?? "(blank)"} — wait 5 minutes and re-run`);
    return;
  }
  const target = STAGE_TARGETS.find((v) => v !== original && v !== cached);
  const since = new Date(Date.now() - 2000).toISOString();
  let moved = false;

  try {
    // The canary: one write, re-read the whole record.
    const w = await api(s.admin, "PATCH", `/sf/customer/${STAGE_RECORD}`, { fields: { Stage__c: target } });
    if (w.status !== 200) {
      check("C", `PATCH /sf/customer Stage__c → ${target} as zz-admin`, false, `status ${w.status} ${JSON.stringify(w.body)?.slice(0, 200)}`);
      return;
    }
    moved = true;
    const after = await readAll(STAGE_RECORD);
    const drift = changedFields(before, after, ["Stage__c"]);
    if (after?.Stage__c !== target || drift.length) {
      check("C", "canary: the write changed Stage__c and nothing else", false,
        `Stage__c = ${after?.Stage__c}; also changed: ${drift.join(", ") || "none"} — restoring and stopping`);
      return;
    }
    check("C", `canary: PATCH Stage__c ${original ?? "(blank)"} → ${target} changed nothing else`, true);

    // sf-update does not write the new value into the cache: it flags the row is_stale, and
    // the value lands — and the trigger fires — at the next refresh: a single-record read
    // (what the office page does after a save) or the 5-minute sundial-cache-sync. So a
    // dealer hears within seconds of the office re-reading the record, else within 5 min.
    // Follow the read path first, the sync second, and say which one delivered.
    const lambda = new LambdaClient({ region: REGION });
    const sync = async () => {
      const inv = await lambda.send(new InvokeCommand({ FunctionName: "sundial-cache-sync", Payload: Buffer.from(JSON.stringify({ object: "customer" })) }));
      return inv.FunctionError ? `ERROR ${inv.Payload ? Buffer.from(inv.Payload).toString("utf8").slice(0, 160) : ""}` : "ok";
    };
    const prefix = `stage:customer:${STAGE_RECORD}:${target}:`;
    const mine = (rows) => (rows ?? []).filter((r) => r.dedupe_key?.startsWith(prefix));
    await api(s.admin, "GET", `/sf/customer/${STAGE_RECORD}`);
    let path = "the office's re-read (GET /sf/customer/{id} refreshes the stale cache row)";
    let repRows = mine(await waitFor(() => stageRows(repActor, STAGE_RECORD, since), (r) => mine(r).length >= 1, 30000));
    if (repRows.length === 0) {
      path = `the cache sync (sync ${await sync()}) — the re-read did not refresh the row`;
      repRows = mine(await waitFor(() => stageRows(repActor, STAGE_RECORD, since), (r) => mine(r).length >= 1, 30000));
    }
    const dealerRows = mine(await waitFor(() => stageRows(dealerActor, STAGE_RECORD, since), (r) => mine(r).length >= 1, 10000));
    note(`delivered by ${path}`);
    check("C", `exactly one 'stage' bell row for the deal's rep (zz-${repActor.slug})`, repRows.length === 1,
      `${repRows.length} row(s)${repRows[0] ? ` — "${repRows[0].title}"` : " — is private.app_config stage_notify_url set and /webhooks/stage-change live?"}`);
    check("C", `exactly one 'stage' bell row for the dealer's Sales Dealer (zz-${dealerActor.slug})`, dealerRows.length === 1, `${dealerRows.length} row(s)`);
    if (bystander) {
      const other = await stageRows(bystander, STAGE_RECORD, since);
      check("C", `none for a rep whose deal it is not (zz-${bystander.slug})`, other !== null && other.length === 0, `${other?.length ?? "?"} row(s)`);
    }

    // A second sync re-upserts the same stage: the trigger's WHEN clause and the dedupe key
    // must both keep it silent.
    const syncResult = await sync();
    await new Promise((res) => setTimeout(res, 8000));
    const repAgain = mine(await stageRows(repActor, STAGE_RECORD, since));
    const dealerAgain = mine(await stageRows(dealerActor, STAGE_RECORD, since));
    check("C", "no duplicate after a second cache sync", repAgain.length === 1 && dealerAgain.length === 1,
      `rep ${repAgain.length}, dealer ${dealerAgain.length}; sync ${syncResult}`);
  } finally {
    if (moved) {
      const r = await api(s.admin, "PATCH", `/sf/customer/${STAGE_RECORD}`, { fields: { Stage__c: original } });
      const restored = await readAll(STAGE_RECORD);
      const ok = r.status === 200 && (restored?.Stage__c ?? null) === original;
      check("C", `Stage__c restored to ${original ?? "(blank)"}`, ok, ok ? null : `status ${r.status}, Stage__c = ${restored?.Stage__c}`);
      // Refresh the cache row now, so the restore's own bell row arrives before we mark it read.
      await api(s.admin, "GET", `/sf/customer/${STAGE_RECORD}`);
      // Mark this run's bell rows read so the ZZ inboxes stay quiet (the restore makes one more).
      await new Promise((res) => setTimeout(res, 6000));
      for (const a of [repActor, dealerActor]) {
        await a.sb.from("sundial_notifications").update({ read_at: new Date().toISOString() })
          .eq("record_sf_id", STAGE_RECORD).eq("category", "stage").gte("created_at", since).is("read_at", null);
      }
    }
  }
}

// --- D + E ---------------------------------------------------------------------------------------
async function checkTechAndManifest(s) {
  for (const a of [s.repA1, s.mgrA]) {
    for (const path of ["/service/tech/day", "/service/tech/jobs"]) {
      const r = await api(a, "GET", path);
      check("D", `${path} is 403 for zz-${a.slug} (a sales login)`, r.status === 403, `status ${r.status} ${r.body?.code ?? ""}`);
    }
  }

  const me = await api(s.repA1, "GET", "/auth/me");
  const advertised = me.body?.user?.access?.manifestVersion ?? me.body?.access?.manifestVersion ?? null;
  check("E", "/auth/me advertises the manifest version of lib/field-manifest", advertised === MANIFEST_VERSION,
    `/auth/me user.access.manifestVersion: ${advertised ?? "absent (sundial-auth-proxy does not send it)"}; local: ${MANIFEST_VERSION}`);
  const d = await api(s.repA1, "GET", `/dealer/customers/${DESIGNATED}`);
  check("E", "/dealer/customers/{id} access.manifestVersion = lib/field-manifest", d.body?.access?.manifestVersion === MANIFEST_VERSION,
    `deployed sundial-dealer: ${d.body?.access?.manifestVersion ?? `status ${d.status}`}`);
}

async function main() {
  const [passwords, fx] = await Promise.all([loadTestPasswords(), loadFixtures()]);
  const cfg = resolveSupabasePublic();
  console.log("Dealer module — end-to-end verification (step 8 of 9)");
  console.log(`  api      : ${API}`);
  console.log(`  manifest : ${MANIFEST_VERSION}\n`);

  const s = {};
  for (const [key, slug] of [["repA1", "rep-a1"], ["repA2", "rep-a2"], ["mgrA", "mgr-a"], ["repB1", "rep-b1"], ["admin", "admin"]]) {
    s[key] = await signIn(cfg, slug, passwords);
    const u = fx.userBySlug(slug);
    s[key].sfUserId = u?.Id ?? null;
    s[key].dealerId = u?.Dealer__c ?? null;
  }
  const me = await api(s.admin, "GET", "/auth/me");
  const tenantId = me.body?.tenantId ?? me.body?.clientId ?? me.body?.tenant?.clientId ?? TENANT_ID;

  await checkLists(fx, s);
  await checkComments(fx, s, tenantId);
  if (SKIP_STAGE) console.log("  ----  C. skipped (--skip-stage)");
  else await checkStage(fx, s);
  await checkTechAndManifest(s);

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  console.log("Reset the fixtures: node scripts/seed-access-test-fixtures.mjs --apply");
  if (failed.length) {
    console.log("\nFAILED:");
    for (const f of failed) console.log(`  - ${f.section}. ${f.name}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(`\nverify-dealer-module: ${e.stack ?? e.message}`);
  process.exit(1);
});
