// Seed the DEMO tenant (default slug `conops-demo`) with plausible, entirely FICTIONAL data,
// so Constructive Operations can show Sundial in a sales meeting without showing a client.
//
// WHAT IT CREATES (all stamped with the demo tenant, all invented):
//   the tenant · 3 dealers · 11 logins · 100 customers · 50 solar projects (33 of the 34
//   stages; all 34 with --with-sold-pending-review) · 10 roofing jobs · a 28-item price
//   book · 45 service jobs + 51 estimates with their lines, calls, invoices, payments and
//   tech days · team notes, activity, texts and bell notifications in Supabase ·
//   (optionally) sample PDFs.
//
// SAFETY, in one paragraph: DRY RUN by default. "harmon" (or whatever
// SUNDIAL_PRIMARY_TENANT names) is refused. Before any write the whole plan is checked
// against LIVE describes — every field, picklist value and lookup — and the run stops on
// the first complete list of problems. The first record of every object — and, on
// customers and solar projects, the first record in every STAGE — is a CANARY: written,
// read back in full, and the run aborts if anything the script did not write has a value
// (CLAUDE.md "canary first"). Every record key -> Salesforce Id is saved to
// migration/demo/id-map.json after EACH create, so a failed run is simply run again; the
// anchor date and seed are also kept in Secrets Manager, so a LOST id-map is rebuilt
// rather than seeded over. The script never updates a record it did not create (it asks
// Salesforce for the record's tenant first), and never prints a password, a token or a
// Salesforce error body.
//
// ⚠️ DO NOT pipe the output of a real run through `head` / `Select-Object -First`: the exit
// status is lost, and the last lines are the ones that matter.
//
// Usage (from the sundial-core repo root, PowerShell):
//   node scripts/seed-demo-tenant.mjs                  # dry run: preflight + plan + summary
//   node scripts/seed-demo-tenant.mjs --apply          # write (resumable)
//   node scripts/seed-demo-tenant.mjs --help           # every option
//
// The work is in scripts/demo-seed/. The plan is pure and tested offline against a fake
// org (each file is named: on Node 22 `node --test <folder>` does not run a folder):
//   node --experimental-test-module-mocks --test scripts/demo-seed/plan.test.js scripts/demo-seed/run.test.js scripts/demo-seed/freshen.test.js
// Runbook: docs/demo-tenant-seed.md.

import { runSeed } from "./demo-seed/run.js";
import { createRealIo } from "./demo-seed/real-io.js";

runSeed(process.argv.slice(2), createRealIo())
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    // Never print a response body here — a Salesforce error body can carry record data.
    console.error(`\nFAILED: ${err?.message || err}\n`);
    process.exitCode = 1;
  });
