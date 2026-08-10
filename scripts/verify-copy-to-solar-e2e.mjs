// END-TO-END verification of POST /projects/{customerId}/files/copy-to-solar
// against the REAL API Gateway, Salesforce, and S3.
//
// Nothing pre-existing is touched: this creates its own throwaway customer, solar
// project, portal user, and S3 objects, exercises the live endpoint, then deletes
// all of it. Mirrors scripts/verify-provisioning-e2e.mjs (same self-cleaning shape).
//
// What it proves:
//   1. happy path      — every customer file lands under SUNDIAL/{solarId}/
//   2. nested paths    — a subfolder key keeps its relative path
//   3. idempotency     — a second run overwrites in place, no duplicates
//   4. NO_LINKED_PROJECT — with the link cleared, the copy is refused (400)
//   5. unauthenticated — no token -> 401
//   6. teardown        — SF records, S3 objects, auth user all removed
//
// Run:  node scripts/verify-copy-to-solar-e2e.mjs

import { getSupabaseClient, getSupabaseConfig } from '../lib/supabase.js';
import {
  sfQuery, soqlEscapeString, sfCreateRecord, sfUpdateRecord, sfDeleteRecord,
} from '../lib/salesforce.js';
import { listRecordFiles, S3_BUCKET, S3_REGION, S3_PREFIX } from '../lib/file-access.js';
import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';

const API_BASE = (process.env.API_BASE_URL
  || 'https://5sktfwldh1.execute-api.us-west-1.amazonaws.com/prod').replace(/\/+$/, '');
const EMAIL = process.env.TEST_EMAIL || 'tim+copyfilesverify@constructiveoperations.com';
const TEMP_PW = 'TempPass123!';

const s3 = new S3Client({ region: S3_REGION });

let failures = 0;
const check = (label, pass, extra = '') => {
  if (!pass) failures++;
  console.log(`  ${pass ? 'PASS ✓' : 'FAIL ✗'}  ${label}${extra ? `  (${extra})` : ''}`);
};

const admin = await getSupabaseClient();
const cfg = await getSupabaseConfig();
const apikey = cfg.anonKey || cfg.serviceRoleKey;

const login = async (password) => {
  const r = await fetch(`${cfg.url}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password }),
  });
  return { status: r.status, body: await r.json() };
};

const copyCall = async (customerId, token) => {
  const r = await fetch(`${API_BASE}/projects/${customerId}/files/copy-to-solar`, {
    method: 'POST',
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      'Content-Type': 'application/json',
    },
    body: '{}',
  });
  let body = null;
  try { body = await r.json(); } catch { /* non-JSON */ }
  return { status: r.status, body };
};

const putTestObject = (recordId, name) =>
  s3.send(new PutObjectCommand({
    Bucket: S3_BUCKET,
    Key: `${S3_PREFIX}/${recordId}/${name}`,
    Body: `copy-to-solar e2e test object: ${name}`,
    ContentType: 'text/plain',
  }));

const purgePrefix = async (recordId) => {
  const files = await listRecordFiles(s3, recordId);
  for (const f of files) {
    await s3.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: f.key }));
  }
  return files.length;
};

// Resolve the harmon tenant id (don't hardcode).
const tenants = await sfQuery(`SELECT Id, Name FROM Sundial_Tenant__c WHERE Name = 'harmon' LIMIT 1`);
const HARMON = tenants?.[0]?.Id;
if (!HARMON) { console.error('Could not resolve harmon tenant id; aborting.'); process.exit(1); }
console.log(`Harmon tenant id: ${HARMON}\nAPI base: ${API_BASE}\n`);

// Clean any leftovers from a previous interrupted run.
const { data: l0 } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
const prior = (l0.users || []).find((u) => (u.email || '').toLowerCase() === EMAIL.toLowerCase());
if (prior) await admin.auth.admin.deleteUser(prior.id);

let authUserId = null;
let sfUserId = (await sfQuery(
  `SELECT Id FROM Sundial_User__c WHERE Email__c = '${soqlEscapeString(EMAIL)}'`
))?.[0]?.Id || null;
let customerId = null;
let solarId = null;

try {
  // --- portal user (for a real Supabase JWT) --------------------------------
  const { data: c, error: cErr } = await admin.auth.admin.createUser({
    email: EMAIL, password: TEMP_PW, email_confirm: true,
  });
  authUserId = c?.user?.id ?? null;
  check('create auth user', !cErr && !!authUserId, cErr?.message);

  if (!sfUserId) {
    sfUserId = (await sfCreateRecord('Sundial_User__c', {
      First_Name__c: 'CopyFiles', Last_Name__c: 'Verify', Email__c: EMAIL,
      Access_Level__c: 'Sales Rep', Hierarchy_Level__c: 'Sales Rep',
      Active__c: true, Supabase_User_Id__c: authUserId, Client__c: HARMON,
    })).id;
  } else {
    await sfUpdateRecord('Sundial_User__c', sfUserId, {
      Supabase_User_Id__c: authUserId, Client__c: HARMON, Active__c: true,
    });
  }
  check('create Sundial_User__c bound to harmon', !!sfUserId);

  const auth = await login(TEMP_PW);
  const token = auth.body?.access_token;
  check('login -> JWT', auth.status === 200 && !!token, `HTTP ${auth.status}`);
  if (!token) throw new Error('no token; cannot continue');

  // --- test customer + linked solar project --------------------------------
  customerId = (await sfCreateRecord('Sundial_Customer__c', {
    Name: 'ZZ Copy-To-Solar E2E (delete me)',
    Client__c: HARMON,
    Street__c: '1 Test Way', City__c: 'Mesa', State__c: 'AZ', Postal_Code__c: '85201',
  })).id;
  solarId = (await sfCreateRecord('Sundial_Solar__c', {
    Sundial_Customer__c: customerId,
    Client__c: HARMON,
  })).id;
  await sfUpdateRecord('Sundial_Customer__c', customerId, {
    Linked_Solar_Project__c: solarId,
  });
  check('create test customer + linked solar project', !!customerId && !!solarId,
    `${customerId} -> ${solarId}`);

  // --- seed the customer's folder ------------------------------------------
  await putTestObject(customerId, 'contract.pdf');
  await putTestObject(customerId, 'utility bill (2).txt'); // spaces + parens
  await putTestObject(customerId, 'photos/roof.txt');      // nested path
  const seeded = await listRecordFiles(s3, customerId);
  check('seed 3 files under the customer prefix', seeded.length === 3, `${seeded.length} files`);

  // --- 1) the copy ----------------------------------------------------------
  const res = await copyCall(customerId, token);
  check('POST copy-to-solar -> 200', res.status === 200, `HTTP ${res.status}`);
  check('copied all 3 files', res.body?.copied === 3, `copied=${res.body?.copied}`);
  check('no per-object failures', (res.body?.failedCount ?? -1) === 0,
    JSON.stringify(res.body?.failed || []));
  check('destination is the LINKED solar project', res.body?.solarRecordId === solarId,
    `${res.body?.solarRecordId}`);

  const landed = await listRecordFiles(s3, solarId);
  const names = landed.map((f) => f.fileName).sort();
  check('files present under the solar prefix in S3', landed.length === 3, `${landed.length} files`);
  check('filenames preserved (incl. spaces/parens)',
    names.includes('utility bill (2).txt'), names.join(', '));
  check('nested path preserved', names.includes('photos/roof.txt'), names.join(', '));

  // --- 2) idempotent re-run -------------------------------------------------
  const again = await copyCall(customerId, token);
  const landedAgain = await listRecordFiles(s3, solarId);
  check('re-run is idempotent (no duplicates)',
    again.status === 200 && again.body?.copied === 3 && landedAgain.length === 3,
    `copied=${again.body?.copied}, now ${landedAgain.length} in S3`);

  // --- 3) no linked project -------------------------------------------------
  await sfUpdateRecord('Sundial_Customer__c', customerId, { Linked_Solar_Project__c: null });
  const unlinked = await copyCall(customerId, token);
  check('no Linked_Solar_Project__c -> 400 NO_LINKED_PROJECT',
    unlinked.status === 400 && unlinked.body?.code === 'NO_LINKED_PROJECT',
    `HTTP ${unlinked.status} ${unlinked.body?.code}`);

  // --- 4) unauthenticated ---------------------------------------------------
  const anon = await copyCall(customerId, null);
  check('no token -> 401', anon.status === 401, `HTTP ${anon.status}`);

} catch (e) {
  failures++;
  console.error('\nERROR:', e?.message || e);
} finally {
  // --- teardown: leave prod exactly as we found it --------------------------
  console.log('\nCleanup:');
  try {
    if (customerId) console.log(`  purged ${await purgePrefix(customerId)} customer S3 objects`);
    if (solarId) console.log(`  purged ${await purgePrefix(solarId)} solar S3 objects`);
    if (solarId) { await sfDeleteRecord('Sundial_Solar__c', solarId); console.log('  deleted test Sundial_Solar__c'); }
    if (customerId) { await sfDeleteRecord('Sundial_Customer__c', customerId); console.log('  deleted test Sundial_Customer__c'); }
    if (sfUserId) { await sfDeleteRecord('Sundial_User__c', sfUserId); console.log('  deleted test Sundial_User__c'); }
    if (authUserId) {
      // deleteUser RETURNS { error } rather than throwing — an unchecked call here
      // is how a run leaves an ORPHAN_AUTH user behind (the exact class the
      // provisioning incident was about). Check it, then prove it below.
      const { error: delErr } = await admin.auth.admin.deleteUser(authUserId);
      console.log(`  deleted auth user${delErr ? ` — ERROR: ${delErr.message}` : ''}`);
      if (delErr) failures++;
    }
  } catch (e) {
    console.error('  CLEANUP FAILED — remove by hand:', e?.message || e);
    console.error(`  customer=${customerId} solar=${solarId} sfUser=${sfUserId} authUser=${authUserId}`);
    failures++;
  }

  // Teardown is only "done" if nothing survived. Verify rather than assume.
  try {
    const { data: after } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
    const stillThere = (after.users || [])
      .filter((u) => (u.email || '').toLowerCase() === EMAIL.toLowerCase());
    check('teardown: no auth user left behind', stillThere.length === 0,
      stillThere.map((u) => u.id).join(','));
    const sfLeft = await sfQuery(
      `SELECT Id FROM Sundial_Customer__c WHERE Name LIKE 'ZZ Copy-To-Solar E2E%'`
    );
    check('teardown: no test customer left in Salesforce', sfLeft.length === 0,
      sfLeft.map((r) => r.Id).join(','));
  } catch (e) {
    console.error('  teardown verification failed:', e?.message || e);
    failures++;
  }
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
