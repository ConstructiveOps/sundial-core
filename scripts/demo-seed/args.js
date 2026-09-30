// args.js — the command line of scripts/seed-demo-tenant.mjs.

import { DEFAULT_TENANT_SLUG, PHASES, SEEDED_OBJECTS } from "./policy.js";

export const HELP = `
Seed the Sundial DEMO tenant with plausible, entirely fictional data.

  node scripts/seed-demo-tenant.mjs                 DRY RUN (the default): checks the live org,
                                                    builds the plan, prints a summary, writes
                                                    migration/demo/plan.json. Writes nothing else.
  node scripts/seed-demo-tenant.mjs --apply         write it (resumable: run again after a failure)

Options
  --apply                     actually write. Without it nothing is written anywhere.
  --tenant <slug>             the demo tenant's slug (default ${DEFAULT_TENANT_SLUG}). "harmon" is refused.
  --phase <name>              run ONE phase: ${PHASES.join(", ")}
                              (default: all, in that order; "files" only with --with-files)
  --with-files                also upload ~25 sample PDFs to the Files tabs (phase "files").
                              "--phase files" is refused without it.
  --demo-phone +1XXXXXXXXXX   put YOUR phone on the three "live demo" customers
  --demo-email you@x.com      put YOUR email on the three "live demo" customers
                              (both: pass them on the FIRST --apply. They are still accepted on a
                              later run as long as those three customers have not been created.)
  --with-sold-pending-review  use the stage "Sold - Pending Review" on ONE demo customer and ONE
                              demo solar project (the stage Harmon's Salesforce alerts fire on).
                              Without it the customer sits in "Processing Documents", the project
                              in "Audit", and 33 of the 34 solar stages are covered.
  --show-passwords            print the demo logins' passwords from Secrets Manager, then stop
  --freshen                   move the dispatch board / payroll to the current week (see the docs)
  --accept-canary <Object>    after a canary failure you have investigated: accept THAT difference
                              on that object and continue. <Object> is one of:
                              ${SEEDED_OBJECTS.join(", ")}
  --allow-unaccounted         continue although the tenant holds records this script did not create
  --seed <number>             the random seed (only before the first --apply; stored after it)
  --offline                   dry run against migration/demo/probe.json instead of the live org
  --help                      this text

If migration/demo/id-map.json is lost: run the dry run. It restores the anchor date and seed from
Secrets Manager and rebuilds the id-map from the tenant's records — or says exactly why it cannot.
Runbook: docs/demo-tenant-seed.md ("If the id-map is lost").
`;

export function parseArgs(argv) {
  const a = {
    apply: false, tenant: DEFAULT_TENANT_SLUG, phase: null, withFiles: false, demoPhone: null, demoEmail: null,
    withSoldPendingReview: false, showPasswords: false, freshen: false, acceptCanary: [], allowUnaccounted: false,
    seed: null, offline: false, help: false, problems: [],
  };
  const value = (i, flag) => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) a.problems.push(`${flag} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const f = argv[i];
    switch (f) {
      case "--apply": a.apply = true; break;
      case "--with-files": a.withFiles = true; break;
      case "--with-sold-pending-review": a.withSoldPendingReview = true; break;
      case "--show-passwords": a.showPasswords = true; break;
      case "--freshen": a.freshen = true; break;
      case "--allow-unaccounted": a.allowUnaccounted = true; break;
      case "--offline": a.offline = true; break;
      case "--help": case "-h": a.help = true; break;
      case "--tenant": a.tenant = value(i, f); i++; break;
      case "--phase": a.phase = value(i, f); i++; break;
      case "--demo-phone": a.demoPhone = value(i, f); i++; break;
      case "--demo-email": a.demoEmail = value(i, f); i++; break;
      case "--accept-canary": a.acceptCanary.push(value(i, f)); i++; break;
      case "--seed": a.seed = Number(value(i, f)); i++; break;
      default: a.problems.push(`unknown option ${f}`);
    }
  }
  if (a.phase && !PHASES.includes(a.phase)) a.problems.push(`--phase must be one of ${PHASES.join(", ")}`);
  // The sample PDFs go to S3, which the seed cannot clean up: they are uploaded only when asked for by name.
  if (a.phase === "files" && !a.withFiles) a.problems.push(`--phase files uploads the sample PDFs to S3, so it must be asked for explicitly: add --with-files`);
  // A typo here would otherwise be silently ignored and the canary would simply fail again.
  for (const o of a.acceptCanary) {
    if (o !== undefined && !o.startsWith("--") && !SEEDED_OBJECTS.includes(o)) a.problems.push(`--accept-canary ${o}: not an object this script seeds. Valid names: ${SEEDED_OBJECTS.join(", ")}`);
  }
  if (a.demoPhone && !/^\+1\d{10}$/.test(a.demoPhone)) a.problems.push("--demo-phone must look like +1XXXXXXXXXX");
  if (a.demoEmail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(a.demoEmail)) a.problems.push("--demo-email is not an email address");
  if (a.seed !== null && !Number.isInteger(a.seed)) a.problems.push("--seed must be a whole number");
  if (a.offline && a.apply) a.problems.push("--offline is for a dry run only; it cannot be combined with --apply");
  if (!a.tenant || !/^[a-z0-9][a-z0-9-]{1,38}$/.test(a.tenant)) a.problems.push("--tenant must be a lower-case slug");
  return a;
}
