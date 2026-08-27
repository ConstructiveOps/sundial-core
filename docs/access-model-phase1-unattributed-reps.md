# Access model Phase 1 — reps with records and no dealer

**Generated:** 2026-08-27 by `node scripts/backfill-deal-ownership.mjs` (the "REPS WITH NO
DEALER" section) after `scripts/stamp-dealer-named-users.mjs --apply`. **Read-only report.**
**Tenant:** `a1W7y000007AszBEAS` (harmon).

Companion to [`access-model.md`](access-model.md) §2.4 and D-064 **A1**.

## Why this list exists

A1 derives a deal's dealer from its rep: `Dealer__c := Sales_Rep__r.Dealer__c`. A rep with no
`Dealer__c` therefore contributes nothing, and every record they own stays unattributed —
**visible to tenant scope, invisible to every dealer-scope user**. That is fail-closed and
correct, and it is also the size of what the backfill could not do.

The 37 `Sundial_User__c` records that were *themselves dealers* have already been stamped
(`scripts/stamp-dealer-named-users.mjs`, 2026-08-27) and are not in this list. What remains
is **65 reps holding 9,816 customers and 2,078 solar projects**, and each one is a
question for Harmon rather than something a script may decide. Assigning a rep to a dealer
decides whose sales manager can read that rep's deals; there is no safe default, and
"probably Harmon Solar" is exactly the guess D19's blank-is-never-the-default rule refuses.

## Summary

| | Reps | Customers | Solar |
|---|---:|---:|---:|
| **Active users** | 6 | 3,592 | 1,841 |
| Inactive users | 59 | 6,224 | 237 |
| **Total** | 65 | 9,816 | 2,078 |

## The 6 ACTIVE users — the ones that matter for access

These can log in. Until they carry a `Dealer__c`, a `Sales Dealer` colleague cannot see their
deals.

**None of them is harmed by it today, and it is worth being precise about why.** Every one holds
a tenant-wide access level — `Executive`, `Manager` or `Admin` — which resolves to scope
`tenant`, and tenant scope never reads `Dealer__c` at all (§1.2). Their own view of the portal
is unaffected now and will be unaffected at Phase 3.

The exposure is conditional and worth writing down before it surprises somebody: **the day any
of these people is given a sales access level, they resolve to scope `none` and see nothing** —
§1.2 makes a sales role with a null dealer invisible to itself, deliberately, rather than
letting a null read as "all dealers". Re-levelling a Harmon manager down to `Sales Dealer`
without stamping a dealer in the same edit would blank their portal, and the cause would not be
obvious from the change that caused it. `sundial-user-admin` should require `Dealer__c` on any
PATCH that moves a user INTO a sales role — that is a Phase 4 item and is noted in TASKS.md.

| Rep | Email | `Access_Level__c` | `Hierarchy_Level__c` | Customers | Solar | Total |
|---|---|---|---:|---:|---:|---:|
| Ralph Romano | ralphromano@harmonelectric.net | Executive | Manager | 1,933 | 1,490 | 3,423 |
| Geovanna Macedo | geovannamacedo@harmonelectric.net | Manager | Manager | 780 |  | 780 |
| Lindsay McCormack | lindsaymccormack@harmonelectric.net | Executive | Manager | 311 | 274 | 585 |
| Ben Wollschlager | benwollschlager@harmonelectric.net | Admin | Manager | 348 | 58 | 406 |
| Daniel Reese | danielreese@harmonelectric.net | Manager | Manager | 219 | 19 | 238 |
| Tim Test | tim+test1@constructiveoperations.com | Executive | Client | 1 |  | 1 |

## The 59 INACTIVE users

Cannot log in, so nothing about access turns on them today. They still own records, and those
records stay unattributed until the rep is resolved — which matters the moment a dealer-scope
user expects to see historic work.

**59 of them carry `Hierarchy_Level__c = "Sales Rep"`**, the exact string the TEMP guard in
`sundial-sf-query` keys on. Harmless while they are inactive — `resolveIdentity` refuses an
inactive user before any guard runs — but worth knowing it is there, because "inactive" is one
checkbox away from not being true.

| Rep | Email | `Access_Level__c` | `Hierarchy_Level__c` | Customers | Solar | Total |
|---|---|---|---:|---:|---:|---:|
| Legacy Sales Rep1 | legacy.sales.rep1@migration.invalid | *(blank)* | Sales Rep | 1,956 |  | 1,956 |
| Legacy Sales Rep2 | legacy.sales.rep2@migration.invalid | *(blank)* | Sales Rep | 1,374 |  | 1,374 |
| Slade Carlson | slade.carlson@migration.invalid | *(blank)* | Sales Rep | 757 |  | 757 |
| Thomas Kopp | thomas.kopp@migration.invalid | *(blank)* | Sales Rep | 285 | 61 | 346 |
| Caleb Heerma | caleb.heerma@migration.invalid | *(blank)* | Sales Rep | 309 | 3 | 312 |
| Taylor Horin | taylor.horin@migration.invalid | *(blank)* | Sales Rep | 236 | 8 | 244 |
| Rowdy Meeker | rowdy.meeker@migration.invalid | *(blank)* | Sales Rep | 228 | 9 | 237 |
| Legacy Sales Rep3 | legacy.sales.rep3@migration.invalid | *(blank)* | Sales Rep | 205 |  | 205 |
| Residental Solar Brokers | raphyka999@gmail.com | *(blank)* | Sales Rep | 120 | 48 | 168 |
| Thomas Snow | thomas.snow@migration.invalid | *(blank)* | Sales Rep | 133 | 7 | 140 |
| Legacy Sales Rep4 | legacy.sales.rep4@migration.invalid | *(blank)* | Sales Rep | 108 |  | 108 |
| Jonathon Walker | jonathon.walker@migration.invalid | *(blank)* | Sales Rep | 55 |  | 55 |
| Legacy Sales Rep5 | legacy.sales.rep5@migration.invalid | *(blank)* | Sales Rep | 43 |  | 43 |
| Legacy Sales Rep6 | legacy.sales.rep6@migration.invalid | *(blank)* | Sales Rep | 43 |  | 43 |
| Desert Sun Systems | desert.sun.systems@migration.invalid | *(blank)* | Sales Rep | 22 | 18 | 40 |
| Sunus | sunus@migration.invalid | *(blank)* | Sales Rep | 35 | 2 | 37 |
| Legacy Sales Rep7 | legacy.sales.rep7@migration.invalid | *(blank)* | Sales Rep | 37 |  | 37 |
| I AM ENERGY | danielthesolarpro@gmail.com | *(blank)* | Sales Rep | 21 | 15 | 36 |
| Alternative Energy AZ | alternative.energy.az@migration.invalid | *(blank)* | Sales Rep | 31 | 4 | 35 |
| Solar 4 Les | solar.4.les@migration.invalid | *(blank)* | Sales Rep | 29 | 5 | 34 |
| Legacy Sales Rep8 | legacy.sales.rep8@migration.invalid | *(blank)* | Sales Rep | 34 |  | 34 |
| Machometa | machometa@migration.invalid | *(blank)* | Sales Rep | 19 | 13 | 32 |
| Jose Gomez | jose.gomez@migration.invalid | *(blank)* | Sales Rep | 17 | 10 | 27 |
| AZray Solar | azraysolaraz@gmail.com | *(blank)* | Sales Rep | 10 | 8 | 18 |
| Legacy Sales Rep9 | legacy.sales.rep9@migration.invalid | *(blank)* | Sales Rep | 17 |  | 17 |
| Blueberry Hill | blueberry.hill@migration.invalid | *(blank)* | Sales Rep | 8 | 7 | 15 |
| Legacy Sales Rep10 | legacy.sales.rep10@migration.invalid | *(blank)* | Sales Rep | 12 |  | 12 |
| Joshua Osborn | joshua.osborn@migration.invalid | *(blank)* | Sales Rep | 6 | 5 | 11 |
| Dan King | dan.king@migration.invalid | *(blank)* | Sales Rep | 6 | 5 | 11 |
| Lively Solar | lively.solar@migration.invalid | *(blank)* | Sales Rep | 9 |  | 9 |
| Cohl Energy | cohl.energy@migration.invalid | *(blank)* | Sales Rep | 7 |  | 7 |
| Legacy Sales Rep11 | legacy.sales.rep11@migration.invalid | *(blank)* | Sales Rep | 6 |  | 6 |
| Top Star Energy | top.star.energy@migration.invalid | *(blank)* | Sales Rep | 5 |  | 5 |
| Samuel Gomez | samuel.gomez@migration.invalid | *(blank)* | Sales Rep | 4 |  | 4 |
| Kalvin Pachote | kalvin.pachote@migration.invalid | *(blank)* | Sales Rep | 2 | 2 | 4 |
| Solar & Air | solar.air@migration.invalid | *(blank)* | Sales Rep | 3 |  | 3 |
| Tryan Solar | tryan.solar@migration.invalid | *(blank)* | Sales Rep | 3 |  | 3 |
| Sonoran Solar | sonoran.solar@migration.invalid | *(blank)* | Sales Rep | 2 | 1 | 3 |
| Legacy Sales Rep12 | legacy.sales.rep12@migration.invalid | *(blank)* | Sales Rep | 3 |  | 3 |
| Sales Chaperone | sales.chaperone@migration.invalid | *(blank)* | Sales Rep | 2 |  | 2 |
| Brad Bradley | brad.bradley@migration.invalid | *(blank)* | Sales Rep | 2 |  | 2 |
| Hailco Roofing | hailco.roofing@migration.invalid | *(blank)* | Sales Rep | 2 |  | 2 |
| No Bull Solar | no.bull.solar@migration.invalid | *(blank)* | Sales Rep | 2 |  | 2 |
| Mac McClendon | mac.mcclendon@migration.invalid | *(blank)* | Sales Rep | 2 |  | 2 |
| Solar Buddy | solar.buddy@migration.invalid | *(blank)* | Sales Rep | 1 | 1 | 2 |
| Valley Energy Consoltants | valley.energy.consoltants@migration.invalid | *(blank)* | Sales Rep | 1 | 1 | 2 |
| Humberto Aranda | humberto.aranda@migration.invalid | *(blank)* | Sales Rep | 1 | 1 | 2 |
| Solar Specialists | solar.specialists@migration.invalid | *(blank)* | Sales Rep | 1 | 1 | 2 |
| Volt Energy | volt.energy@migration.invalid | *(blank)* | Sales Rep | 1 | 1 | 2 |
| Wright Solar Solutions | wright.solar.solutions@migration.invalid | *(blank)* | Sales Rep | 1 |  | 1 |
| Matt Shabshov | matt.shabshov@migration.invalid | *(blank)* | Sales Rep | 1 |  | 1 |
| On Communications | on.communications@migration.invalid | *(blank)* | Sales Rep | 1 |  | 1 |
| Lobo | lobo@migration.invalid | *(blank)* | Sales Rep | 1 |  | 1 |
| df6281bd-f98e-4086-9bfe-531fa617452f | df6281bd.f98e.4086.9bfe.531fa617452f@migration.invalid | *(blank)* | Sales Rep | 1 |  | 1 |
| Paul Franco | paul.franco@migration.invalid | *(blank)* | Sales Rep | 1 |  | 1 |
| Sean Macdonald | sean.macdonald@migration.invalid | *(blank)* | Sales Rep | 1 |  | 1 |
| Alfredo Puon | alfredo.puon@migration.invalid | *(blank)* | Sales Rep | 1 |  | 1 |
| Angel Solis | angel.solis@migration.invalid | *(blank)* | Sales Rep |  | 1 | 1 |
| Legacy Sales Rep13 | legacy.sales.rep13@migration.invalid | *(blank)* | Sales Rep | 1 |  | 1 |

## What to ask Harmon

1. **The `Legacy Sales Rep 1–5` placeholders.** Migration artefacts from Sunbase holding a
   large share of the customer book between them. Is there a real rep behind each, or are these
   deliberately anonymous? If anonymous, the honest answer is that those records have no dealer
   and never will — which is fine, and should be recorded as a decision rather than left looking
   like an unfinished backfill.
2. **The active Harmon staff in the first table.** If they sell, they belong to Harmon Solar. If
   they are office staff who happen to be stamped as `Sales_Rep__c` on records, the field is
   being used as "who handled this" rather than "who sold this", and that is worth knowing
   before Phase 3 makes `Sales_Rep__c` load-bearing for visibility.
3. **Anyone here who sells for an outside dealer.** Stamping them is a one-field change in
   Manage Users; re-running `backfill-deal-ownership.mjs` then attributes their records with no
   other change. The script is idempotent and safe to re-run at any time.

## How to close an entry

Set `Dealer__c` on the `Sundial_User__c` record (Manage Users, or Salesforce directly), then:

```
node scripts/backfill-deal-ownership.mjs           # report — shows what would change
node scripts/backfill-deal-ownership.mjs --apply
```

Nothing else needs re-running. The backfill re-reads the org every run and plans only records
that still need a write.
