# Sundial Access Model — sales reps and dealers

**Status:** BUILDING. Phase 0, **Phase 1 and Phase 1b shipped 2026-08-27** (`feature/access-model-p1`,
`feature/access-model-p1b`). Phase 1: data model, backfills, cache columns, `lib/access.js`, the
`access` block on `/auth/me` — all six gates pass, evidence in §8, **nothing any live user saw
changed**, measured twice. **Phase 1b: the comments/mentions RLS is LIVE and is the first thing in
this design that changes what a live user sees** — the measured cross-user leak is closed, and one
restricted rep went from reading all 511 tenant comments to the 79 on his own records (§8, "Phase 1b
gate"). Amendments **A7** (§5.2) and **A8** (§5.3) were taken while building it. Reads are still
unenforced: `sundial-sf-query` runs the TEMP guard untouched, so Phase 2 is next. Companion ADR: D-064 in
`DECISIONS.md` (§11 here is its text). Supersedes the enforcement sections of D-043 and retires the
TEMP restrict (`sundial-sf-query` "TEMP — Sales Rep hard-restrict", 2026-08-03) and the cosmetic tab
hiding (harmon-crm D-048).

**Six design amendments were decided on 2026-08-27**, after Phase 0 measured the org, and they change
what §2 and §8 say. They are indexed under "Amendments" below and applied **in place** in the sections
they touch, so no section is left contradicting them. The matching ADR text is the "Amended
2026-08-27" block under D-064.

**Why this document exists.** Every portal user reaches Salesforce through one integration user, so
Salesforce profiles, roles, and sharing rules can do nothing per user. Row-level and field-level
security must be decided in the Lambda layer from the verified Supabase JWT, and re-derived in
Supabase RLS for the tables the browser touches directly. This document is the single description of
how that decision is made, where it is enforced, and how each surface behaves for each role.

---

## Amendments — 2026-08-27 (Phase 1)

Decided by Tim after the Phase 0 findings (§2.4a, §5.1a–c). Each is applied in place in the section
named; this table is the index, not a second source of truth.

| # | Amendment | Applied in |
|---|---|---|
| **A1** | **A deal's dealer is derived from its rep**, never from a sales-company picklist: `Dealer__c := Sales_Rep__r.Dealer__c`, stamped by the server on create and re-stamped on any `Sales_Rep__c` change. The picklists (Customer `Dealer_Name__c` / `Sales_Company__c`, Solar `Sales_Company_Harmon_Solar_or_Third__c`) stay the **commission discriminator only** and are not an ownership source. | §2.2, §2.3, §2.4 |
| **A2** | **`Sundial_Dealer__c.Sales_Company_Value__c` is dropped.** Dealer-name aliasing lives in a reviewed CSV, `docs/integrations/dealer-aliases.csv` (`DealerName,Alias,Object,Note`), used **only** by the Solar-side backfill for deals that carry a dealer picklist value but no `Sales_Rep__c`. Exact matches auto-map; near-misses (case, punctuation, whitespace) are listed for Tim's approval and never auto-applied; unmatched stay null. | §2.1, §2.4 |
| **A3** | **Dennis needs no rep backfill.** Phase 0 measured `Sales_Rep__c` as already equal to the legacy name match (3,534 Customer / 777 Solar, zero difference — §2.4a). The backfill still runs that comparison on every run and **aborts** if it is no longer true. | §2.4, §7 |
| **A4** | **The cache-table `REVOKE` moves from Phase 6 to the first SQL of Phase 1.** | §3.3, §5.1b, §8 |
| **A5** | **The comments/mentions RLS (§5.3) moves up to a new Phase 1b**, immediately after Phase 1, because Phase 0 showed a Sales Rep reads all 485 tenant comments today. | §5.3, §8 |
| **A6** | Users mis-stamped `Hierarchy_Level__c = "Sales Rep"` by the old `user-admin` default are repaired by a one-shot script that re-PATCHes each one's **current** `accessLevel` through the live `/admin/users` endpoint as `tim+zz-admin`, so the server-side derivation runs. Report-only by default, `--apply` to run, canary-first, and it skips Dennis and any user whose `Access_Level__c` **is** `Sales Rep`. | §8 |

**Why A1 is the load-bearing one.** §2.2 already *preferred* rep-derivation while §2.4 still specified
the picklist as the source — the document disagreed with itself, and Phase 0 settled which half was
right. Customer `Dealer_Name__c` is populated on **13 of 31,637** rows and does not contain "Harmon
Solar" at all, so a picklist-derived `Dealer__c` would be null on essentially every customer — and
null is invisible to every dealer-scope user. The rep lookup is populated on 14,124 customers and
3,262 solar projects and is a real `Sundial_User__c` reference on **both** objects. One source, one
direction, and no string matching anywhere on a read path.

**A2 is what is left of the string matching, and it is deliberately quarantined.** It runs once, on
one object, for records that have no rep to derive from, out of a CSV a human reviewed — not in a
Lambda, not on a read, and never on a value it had to guess at.

---

## 0. Terms

| Term | Meaning |
|---|---|
| **Tenant** | A Sundial client (`Sundial_Tenant__c`; Harmon is `harmon`). Isolation key is `Client__c` / `client_sf_id` (D-034/D-035). Unchanged by this design. |
| **Dealer** | A selling organization *within* a tenant. Harmon Solar itself is a dealer (the internal one). Modeled as `Sundial_Dealer__c` (§2). |
| **Scope** | The row-visibility class a user resolves to: `tenant`, `dealer`, `own`, or `none` (§1). |
| **Sales roles** | `Access_Level__c` ∈ {`Sales Rep`, `Sales Dealer`}. Everything below "Admin". |
| **Tenant-wide roles** | `Access_Level__c` ∈ {`Executive`, `Admin`, `Manager`}. Harmon staff. |
| **Manifest** | The generated, per-object, per-role table of field visibility (`hidden` / `read` / `edit`) and the per-role table of modules and actions (§4). |
| **AccessContext** | The resolved object `{ level, scope, userId, dealerId, tenantId }` every Lambda computes from identity and passes to the shared helpers (§1.3). |

---

## 1. Identity → role → scope

### 1.1 One field decides the role

`Access_Level__c` on `Sundial_User__c` is the **only** input to role resolution. `Hierarchy_Level__c`,
`Roles__c`, and `Parent_User__c` are not read by the new model (their fate is in §10).

Audit of what those three do today, so retiring them is safe:

| Field | Every reader in both repos | Replaced by |
|---|---|---|
| `Hierarchy_Level__c` | `sf-query/index.js:97` (TEMP guard key) · `list-files/index.js:266` (solar files 403) · `auth-proxy/index.js:124` (`profiles.role`) · `user-admin/index.js:51,298,351` (default `"Sales Rep"` on create; PATCH-disallowed) | `Access_Level__c` → scope, `profiles.access_scope` |
| `Roles__c` | none — zero code references in either repo | nothing (unused) |
| `Parent_User__c` | `lib/identity.js:102` returns it as `parentUserId`; no consumer in any Lambda or in harmon-crm (`api.ts:659` is a type only) | `Sundial_User__c.Dealer__c` |

**The user-admin default bug is real and is what you have been fixing by hand.** `DEFAULT_HIERARCHY_LEVEL
= "Sales Rep"` is stamped on every user created via Manage Users (`user-admin/index.js:298`), the TEMP
guard keys on exactly that value, and the field is PATCH-disallowed. Phase 0 fixes it independently of
everything else (§8, Phase 0).

### 1.2 Scope table

| `Access_Level__c` | Scope | Row visibility | Notes |
|---|---|---|---|
| `Executive`, `Admin`, `Manager` | `tenant` | every record in the tenant | Harmon staff. Manager here is an *office* manager, not a sales manager. |
| `Sales Dealer` | `dealer` | records whose `Dealer__c` = the user's dealer | Dealer sales managers **and** dealer principals — same access. |
| `Sales Rep` | `own` | records whose `Sales_Rep__c` = the user | Dennis and every dealer rep alike. |
| `Technician` | `none` | nothing | Defined in Phase II (Service). Until then a Technician login sees no records. Shadow mode (§7) will report if any live user is affected before this takes effect. |
| null / unknown / not in the list | `none` | nothing | **Fail closed.** The TEMP guard's "no match → unrestricted" is inverted. |

`Super_Admin__c` is unchanged: it gates Manage Users only, is Salesforce-set only, and implies nothing
about scope (a super admin with `Access_Level__c = Sales Rep` is an `own`-scope user who can manage
users — that combination should not exist, and `user-admin` will refuse to create it).

A `dealer` or `own` user with a **null `Dealer__c` resolves to `none`**, not to "all dealers". Same
rule for an inactive dealer (§2.1).

### 1.3 `AccessContext` and the shared helper

`lib/identity.js` gains no new Salesforce round-trip; the identity SOQL already selects
`Access_Level__c` and will add `Dealer__c, Dealer__r.Active__c, Dealer__r.Is_Internal__c`.
`resolveIdentity()` returns the existing shape plus:

```js
access: {
  level:    "Sales Rep",           // Access_Level__c verbatim, or null
  scope:    "own",                 // tenant | dealer | own | none
  userId:   "a0X...",              // Sundial_User__c Id
  dealerId: "a0Y...",              // Sundial_Dealer__c Id or null
  tenantId: "a1W...",              // unchanged
  manifestVersion: "sha256:…",     // §4.5
}
```

New module **`lib/access.js`** is the only place authorization logic lives. Every Lambda that reads or
writes records calls it; none re-implement the rules:

```js
resolveScope(identityUser)                 // → AccessContext.access (pure, unit-tested)
rowFilter(objectKey, access)               // → { cache: {col,val}[], soql: string } | DENY
canReadObject(objectKey, access)           // module gate (§3.1)
fieldsFor(objectKey, access)               // → { visible:Set, editable:Set } from the manifest
projectRecord(objectKey, access, record)   // strips hidden fields (full read)
projectRow(objectKey, access, row)         // strips hidden cache columns (list/search)
canAction(actionKey, access)               // → boolean (§3.6)
assertVisibleRecord(objectKey, id, access) // → SOQL existence check with rowFilter; 404 on miss
```

`rowFilter` composes exactly like `?parentId=` does today: it is applied **first** and every caller
filter (`field/value`, `?q=`, `?parentId=`) is ANDed after it. No request input can widen it.

`/auth/me` returns `user.access` so the client can hide navigation and buttons before the server would
have refused them — the client reflects, never decides.

---

## 2. The dealer data model

### 2.1 `Sundial_Dealer__c` (new custom object)

| Field | Type | Purpose |
|---|---|---|
| `Name` | Text | Display name ("High Desert Energy", "Harmon Solar") |
| `Client__c` | Lookup → `Sundial_Tenant__c` | Tenant scoping, same as every Sundial object |
| `Is_Internal__c` | Checkbox | True for Harmon Solar. Informational; grants nothing. |
| `Active__c` | Checkbox | Inactive dealer → its users resolve to scope `none`. |

Four fields, and `Name` is the only string anything matches on — once, in a backfill (§2.4).

> **A2 (2026-08-27): `Sales_Company_Value__c` is dropped from this object.** It was specified as
> "Text(255), unique per tenant — the exact picklist value this dealer corresponds to", and Phase 0
> proved it cannot exist: the two dealer picklists carry **110** values (Customer `Dealer_Name__c`)
> and **56** (Solar `Sales_Company_Harmon_Solar_or_Third__c`) with only **36** exact matches, plus
> near-miss spellings (`ReFract Solar`/`Refract Solar`, `Sky's the Limit Solar`/`Skys the Limit
> Solar`) that an exact join drops **silently** rather than failing on (§2.4a finding 3). A single
> unique column would have had to pick one spelling and quietly lose the other.
>
> The successor is **not** a second column or an alias child object, because after A1 the dealer of a
> deal comes from its rep and the picklist is not consulted at all on the ownership path. What is
> left is one backfill's worth of name matching, and that lives in a reviewed CSV —
> `docs/integrations/dealer-aliases.csv` — for the same reason `dealer-vendor-map.csv` does: the
> aliases are judgement calls about which two strings are one organization, and a judgement call
> belongs in a file a human diffed, not in normalization code that will one day be "improved".

One row per distinct dealer picklist value seen on any record, across **both** picklists (so the
Customer-only and Solar-only values each get a row). `Active__c = true` only for the dealers who get
portal access — at launch **Harmon Solar**, **Heavenly Power**, **Property Upgrades LLC** (§12.4) —
and every other row is created inactive. `Is_Internal__c` is set on Harmon Solar alone. Creating the
rows is a one-time script (§2.4); new dealers are added by a super admin (Manage Users grows a Dealers
tab in a later phase; until then, the Salesforce UI).

Rejected alternatives: **`Parent_User__c` tree** (D-015's plan) — conflates reporting line with
ownership, has no place to hang `Active__c`/vendor mapping, and a tree walk in SOQL/SQL is slower and
harder to index than an id equality. **Reusing the picklist value as the dealer id** — a string
is what we are escaping; renaming a picklist value would silently re-scope users. **Salesforce
`Account`** — pulls a standard object into a schema that is deliberately all `Sundial_*`.

### 2.2 Links

| Object | Field | Type | Written by |
|---|---|---|---|
| `Sundial_User__c` | `Dealer__c` | Lookup → `Sundial_Dealer__c` | `user-admin` (required when `Access_Level__c` is a sales role; refused otherwise-null). Never writable by the user themselves. |
| `Sundial_Customer__c` | `Dealer__c` | Lookup → `Sundial_Dealer__c` | Server only (§2.3) |
| `Sundial_Solar__c` | `Dealer__c` | Lookup → `Sundial_Dealer__c` | Server only |
| `Sundial_Roofing__c`, `Sundial_Commercial__c`, Service | `Dealer__c` | Lookup | Added in the same package for consistency; these modules are hidden from sales roles entirely (§3.1), so the column is not load-bearing yet. |
| Customer / Solar / Roofing | `Sales_Rep__c` | **existing** Lookup → `Sundial_User__c` | The rep attribution. No new field. |

#### A1 — the deal's dealer comes from its rep, and from nothing else

**`Dealer__c := Sales_Rep__r.Dealer__c`.** The server stamps it on create and **re-stamps it on any
`Sales_Rep__c` change**, in the same write (§2.3). A rep belongs to exactly one dealer — a person who
sells for two gets two `Sundial_User__c` records — so the derivation is total wherever a rep is set.

The deal keeps its own `Dealer__c` column rather than being read through the join for two reasons,
one of which is the whole point of the design: **the cache can carry one indexed column** instead of
resolving a lookup per row, and **a deal with no rep still has somewhere to record a dealer** —
Aurora dealer-originated deals (D-049) arrive with a dealer name and no rep at all.

**The sales-company picklists are not an ownership source.** `Sundial_Customer__c.Dealer_Name__c`,
`Sundial_Customer__c.Sales_Company__c` and `Sundial_Solar__c.Sales_Company_Harmon_Solar_or_Third__c`
remain exactly what D19 made them — **the commission discriminator** — and nothing on a read path
consults them. Three reasons this is not merely a preference:

1. **They are not populated.** Customer `Dealer_Name__c`: 13 of 31,637 rows. Solar's sales company:
   780 of 4,477. Derived ownership would be null almost everywhere, and null is invisible to every
   dealer-scope user.
2. **They disagree with each other.** 110 values against 56, 36 in common, with near-misses that an
   exact join drops silently (§2.4a).
3. **They are editable text-ish values with a different job.** A commission discriminator is allowed
   to be re-spelled or re-scoped when the commission model changes; an ownership key is not. Tying
   them together means a D19 edit silently re-shares records.

The one place a picklist value still reaches `Dealer__c` is the **Solar-side backfill for records
that have no rep** (§2.4, A2) — once, offline, out of a reviewed alias CSV, never in a Lambda.

### 2.3 Invariants the server maintains

1. **Create** (`POST /sf/customer` by a sales-role user): `Sales_Rep__c` and `Dealer__c` are
   force-stamped from `AccessContext` — the body's values are ignored and logged if present, exactly
   like `Client__c` today (harmon-crm D-047). A `Sales Dealer` may name any *active user in their own
   dealer* as `Sales_Rep__c`; default self.
2. **Reassignment** (`PATCH … Sales_Rep__c`): allowed for `tenant` scope only. The server re-stamps
   `Dealer__c := new rep's Dealer__c` in the same PATCH — **A1, and this is the half that is easy to
   forget.** Stamping on create alone would leave a reassigned deal pointing at the *old* rep's
   dealer, i.e. shared with an organization that no longer sells it, and nothing would ever notice:
   the record looks fine, the new rep can see it (their own `Sales_Rep__c` matches), and only the
   losing dealer's manager sees something they should not. Sharing follows the record immediately:
   the old rep's next read 404s (their cache filter no longer matches once the write-through
   stale-flag and re-read land — the existing D-035 write path).
3. **Departure**: super admin deactivates the user (`Active__c=false` + Supabase ban, D-044). The
   records keep `Sales_Rep__c` pointing at the inactive user, and `Dealer__c` is unchanged, so the
   dealer's manager still sees them. A person joining another dealer gets a new user; the old deals
   do not follow.
4. **Create Project** (Customer → Solar) copies `Sales_Rep__c` and `Dealer__c` server-side, closing
   punchlist A5 by construction (`Sales_Representative__c` text is no longer what visibility keys on).
5. `Dealer__c` never disagrees with `Sales_Rep__r.Dealer__c` when a rep is set — that is A1 restated
   as an invariant, and it is checkable. A nightly check in `sundial-cache-sync` reconcile mode
   reports disagreements; it does not silently fix them. (Auto-fixing would hide whichever write path
   is failing to re-stamp, which is the actual defect.)
6. **A rep-less deal's `Dealer__c` is set once and then left alone.** Aurora dealer-originated deals
   (D-049) and the Solar backfill's alias matches (§2.4) are the only writers. When such a deal later
   gets a `Sales_Rep__c`, invariant 2 applies and the rep's dealer wins — the rep is the source, so a
   disagreement is resolved in the rep's favour, not merged.
7. **A sales-company picklist value is never read to decide visibility**, on any path, in any Lambda.
   The only consumer stays the commission model (D19) and the PO vendor map (D-060).

### 2.4a Phase 0 describe results — the live org, 2026-08-27

Produced by `node scripts/describe-access-fields.mjs` (read-only: describes + `COUNT(Id)`),
tenant-scoped to `Client__c = a1W7y000007AszBEAS`. Counts are a point-in-time snapshot of a
live org and drift by a row or two between runs; the shapes below do not.

| Object | Field | Type | Lookup target | Updateable | Populated | Blank | Total |
|---|---|---|---|---|---:|---:|---:|
| `Sundial_Customer__c` | `Sales_Rep__c` | reference | `Sundial_User__c` | yes | 14,124 | 17,513 | 31,637 |
| `Sundial_Customer__c` | `Sunbase_Sales_Rep__c` | **picklist** | — | yes | 14,116 | 17,521 | 31,637 |
| `Sundial_Customer__c` | `Sales_Company__c` | picklist | — | yes | 1,570 | 30,067 | 31,637 |
| `Sundial_Customer__c` | `Dealer_Name__c` | picklist | — | yes | **13** | 31,624 | 31,637 |
| `Sundial_Customer__c` | `Sales_Representative__c` | **ABSENT** | — | — | — | — | — |
| `Sundial_Customer__c` | `Third_Party_Sales_Representative__c` | **ABSENT** | — | — | — | — | — |
| `Sundial_Customer__c` | `Sales_Company_Harmon_Solar_or_Third__c` | **ABSENT** | — | — | — | — | — |
| `Sundial_Solar__c` | `Sales_Rep__c` | reference | `Sundial_User__c` | yes | 3,262 | 1,215 | 4,477 |
| `Sundial_Solar__c` | `Sunbase_Sales_Rep__c` | **ABSENT** | — | — | — | — | — |
| `Sundial_Solar__c` | `Sales_Company__c` | **ABSENT** | — | — | — | — | — |
| `Sundial_Solar__c` | `Dealer_Name__c` | **ABSENT** | — | — | — | — | — |
| `Sundial_Solar__c` | `Sales_Representative__c` | **picklist** | — | yes | 3,264 | 1,213 | 4,477 |
| `Sundial_Solar__c` | `Third_Party_Sales_Representative__c` | string | — | yes | 811 | 3,666 | 4,477 |
| `Sundial_Solar__c` | `Sales_Company_Harmon_Solar_or_Third__c` | picklist | — | yes | 780 | 3,697 | 4,477 |

**Five findings, three of which contradict what §2.4 assumed.**

**(1) `Sales_Representative__c` is a PICKLIST — neither of the two guesses was right.** §2.4 flagged
that "the solar sheet says REFERENCE, `sf-query/test.js` treats it as a string" and asked Phase 0 to
settle it. The answer is a third thing. Behaviourally the test file is closer: a picklist holds a
string and SOQL string equality against it works, which is why the TEMP guard's
`Sales_Representative__c = 'Dennis Alessandro'` clause functions at all. But it is **not** a lookup,
so it can never be filtered on by id, and the backfill must keep treating it as a name string. Same
for Customer's `Sunbase_Sales_Rep__c`, also a picklist. Neither field needs a type-aware backfill —
they need a name→id resolution, exactly as §2.4 describes, and the sheet's REFERENCE label should be
corrected.

**(2) Six of the seven named fields exist on ONE object only.** The brief asked for a describe of all
seven across both objects; the org does not have them that way. Customer carries
`Sunbase_Sales_Rep__c` / `Sales_Company__c` / `Dealer_Name__c`; Solar carries
`Sales_Representative__c` / `Third_Party_Sales_Representative__c` /
`Sales_Company_Harmon_Solar_or_Third__c`. Only `Sales_Rep__c` is on both — and it is a real
`Sundial_User__c` lookup on both, which is the one thing the whole design needed to be true.
`Sales_Company_Harmon_Solar_or_Third__c` is confirmed as the exact API name, **on Solar only**.

**(3) The two dealer picklists are NOT identical, and the join key as specified cannot work.**
§2.4 records "the values are identical across objects"; §12.4 lists the three launch dealers as
living on both. Neither holds:

| | |
|---|---|
| Customer `Dealer_Name__c` | **110** active values |
| Solar `Sales_Company_Harmon_Solar_or_Third__c` | **56** active values |
| exact string matches on both | **36** |
| only on Customer | 72 |
| only on Solar | 18 |

Two are the same dealer spelled two ways, which an exact join silently drops rather than failing on:

| Customer | Solar |
|---|---|
| `ReFract Solar` | `Refract Solar` |
| `Sky's the Limit Solar` | `Skys the Limit Solar` |

(Others differ enough to land in the only-on-one buckets but are plainly the same organization —
`Impact Solar` / `Impact Solar Energy`, `Machometa` / `Machometa Enterprises`, `Residental Solar
Brokers` / `Residential Solar Brokers`, `Valley Energy Consoltants` / `Valley Energy Consultants`,
`James Campbell Consulting` / `James Campbell Consulting LLC`, `Elevate Roofing Pros LLC` / `Elevate
Roofing Pros`. The first of those pairs also contains a typo that `docs/integrations/dealer-vendor-map.csv`
already carries as a deliberate alias — see D-060's "aliased spellings are separate keys reaching the
same vendor".)

So `Sales_Company_Value__c` cannot be *one* unique string per dealer. **This is a Phase 1 design
change, not a Phase 0 fix** — it was recorded here and nothing was built on it.

> **RESOLVED by A1 + A2 (2026-08-27), and not the way this paragraph guessed.** The options weighed
> here — "two value columns (one per object) or a child alias table" — both assume the picklist stays
> the *source* of a deal's dealer. **A1 removes that assumption entirely:** the dealer comes from
> `Sales_Rep__r.Dealer__c`, so no read path ever resolves a picklist string and neither extra column
> nor alias child is needed. **A2 then drops `Sales_Company_Value__c` from the object** and puts the
> residue — one backfill's worth of name matching, on Solar, for rep-less records only — in a reviewed
> CSV (`docs/integrations/dealer-aliases.csv`). See §2.1 and §2.4.

**(4) `Harmon Solar` is not a value on Customer `Dealer_Name__c` at all.** It exists only on Solar
(256 rows). §2.4's "Harmon Solar → `Is_Internal__c`" and §12.4's launch-dealer list both assume it is
selectable on Customer. The internal/external split on Customer is carried by `Sales_Company__c`,
whose two values are exactly `Harmon Solar` and `Third-Party Dealer` — which is what §2.4 already
calls "the internal/external discriminator, not a dealer list". That reading is correct; the
launch-dealer expectation is the part that needs adjusting.

Live rows behind the three launch dealers, for scale:

| Dealer | Solar rows | Customer rows |
|---|---:|---:|
| Harmon Solar | 256 | **0** (value absent from the picklist) |
| Heavenly Power | 7 | 1 |
| Property Upgrades LLC | 97 | 8 |

**(5) Customer-side dealer attribution is effectively nonexistent: 13 rows out of 31,637.**
`Dealer_Name__c` is populated on 0.04% of customers. Solar's sales company is populated on 780 of
4,477 (17.4%), consistent with CLAUDE.md's "83% of Solar records carry a blank sales company". The
consequence for §2.2/§2.3 is worth stating plainly: **deriving a customer's dealer from
`Dealer_Name__c` would leave essentially every customer with a null `Dealer__c`**, and per the
fail-closed rule a null `Dealer__c` is invisible to every dealer-scope user. The workable derivation
is the one §2.2 already prefers — `Sales_Rep__r.Dealer__c`, from the rep — with the deal's own
`Dealer__c` as the exception path. Customer `Dealer_Name__c` is not a viable primary source.

#### Dennis Alessandro — the Phase 1 backfill gate, measured

`Sundial_User__c` **`a1O7y00000s5sK1EAI`** · active · `Access_Level__c` = `Sales Rep` ·
`Hierarchy_Level__c` = `Sales Rep` (the two agree; he is not affected by the user-admin default bug).

| Object | Legacy name field | matches | Authoritative id field | matches | onlyInOld | onlyInNew |
|---|---|---:|---|---:|---:|---:|
| Customer | `Sunbase_Sales_Rep__c` = "Dennis Alessandro" | 3,534 | `Sales_Rep__c` = `a1O7y00000s5sK1EAI` | 3,534 | **0** | **0** |
| Solar | `Sales_Representative__c` = "Dennis Alessandro" | 777 | `Sales_Rep__c` = `a1O7y00000s5sK1EAI` | 777 | **0** | **0** |

The script compares the **id sets**, not just the counts — two disjoint sets of 3,534 rows would pass
a count check and lose him every record he has. They are identical on both objects.

**The §7.2 gate already passes, before any backfill.** Dennis's `Sales_Rep__c` is populated on exactly
the records the TEMP name-match serves him, so `rowFilter` would return the same rows today. Two
consequences: the Phase 1 deal-ownership backfill has **zero work to do for Dennis** (it still has
work for everyone else), and Phase 3's enforce step cannot change what he sees — which is the
evidence behind Phase 0's "no widening, no narrowing" claim.

One caveat that keeps the shadow report honest: this is a point-in-time set comparison, not a
guarantee. A record created or reassigned between now and cutover can break the equality, which is
exactly why §7.2 re-runs the diff at enforce rather than trusting this measurement.


### 2.4 Backfill (once, scripted, canary-first per CLAUDE.md)

**Rewritten 2026-08-27 for A1/A2/A3.** Two scripts, in this order, each report-only by default with an
explicit `--apply`, each canary-first per CLAUDE.md.

#### `scripts/backfill-dealers.mjs` — the dealer rows and the user stamps

- **Dealer rows:** one `Sundial_Dealer__c` per **distinct value seen on any record**, across both
  picklists — Customer `Dealer_Name__c` (110 values) and Solar
  `Sales_Company_Harmon_Solar_or_Third__c` (56). The union, not the intersection: a Customer-only
  value and a Solar-only value are each a real dealer somebody sold through.
  `Active__c = true` for exactly three — **Harmon Solar**, **Heavenly Power**, **Property Upgrades
  LLC** (§12.4) — and `Is_Internal__c` on **Harmon Solar** alone. Everything else is created
  inactive, which under §1.2 means a user attached to it resolves to `none`.
  Plus the three §9 fixtures: `ZZ TEST DEALER A`, `ZZ TEST DEALER B` (active),
  `ZZ TEST DEALER INACTIVE` (inactive — the fixture that proves §2.1's inactive rule fails closed).
- **User `Dealer__c`:** the ten ZZ TEST users per §9's table, and **Dennis → Harmon Solar**. No other
  live user is touched by this script. Harmon staff resolve to `tenant` scope, where the dealer is
  not read at all, so leaving them null is correct rather than merely tolerable.
  `seed-access-test-fixtures.mjs` already carries the intended dealer per test user and marks the
  spot with a TODO; this script is what fills it.
- `Sales_Company__c` on Customer (two values: `Harmon Solar` / `Third-Party Dealer`) is the
  internal/external discriminator and is **not** a dealer list. It produces no rows.

#### `scripts/backfill-deal-ownership.mjs` — `Dealer__c` on Customer and Solar

Runs in two passes, and **the first one is the rule**:

1. **From the rep (A1), both objects.** `Dealer__c := Sales_Rep__r.Dealer__c` for every record with a
   `Sales_Rep__c`. A rep with a null `Dealer__c` leaves the deal null — the derivation is not
   guessed at from anything else.
2. **From the alias CSV (A2), Solar only, rep-less records only.** For a `Sundial_Solar__c` record
   with **no** `Sales_Rep__c` but a populated `Sales_Company_Harmon_Solar_or_Third__c`, resolve the
   value through `docs/integrations/dealer-aliases.csv`. **Exact matches auto-map. Near-misses —
   differing only by case, punctuation or whitespace — are listed in the report for Tim's approval
   and are never applied automatically. Anything else stays null.** Customer is deliberately excluded:
   `Dealer_Name__c` is populated on 13 rows, so the pass would do nothing but add risk.

Blank everywhere else → **left null**, never defaulted to Harmon. A null `Dealer__c` is invisible to
every sales role and visible to tenant scope — fail closed, the same "blank ⇒ NULL, never the default"
rule D19 already applies to commissions.

**`Sales_Rep__c` is not backfilled from the legacy name text.** The previous version of this section
specified a name→id resolution pass over `Sunbase_Sales_Rep__c` / `Sales_Representative__c`. **A3
retires it**: Phase 0 measured the one case it existed for and found nothing to do (below). Records
with no rep and no alias match stay unowned, visibly, in the report — which is the honest state for a
record nobody has attributed, and a far better input to a human decision than a guessed rep.

#### A3 — Dennis, and the abort the script keeps anyway

§2.4a measured it: `Sales_Rep__c` already returns the **identical id set** to the legacy name match —
3,534 on Customer, 777 on Solar, `onlyInOld` and `onlyInNew` both zero. So the migration gate in §7
already passes before any backfill exists, and this backfill has **zero rep work to do for Dennis**.

**The script runs the comparison on every run regardless, and aborts if the sets are no longer
equal.** That is not ceremony. The Phase 0 measurement is a point-in-time snapshot of a live org: one
record created or reassigned between then and the run breaks the equality, and the failure mode is
silent — the backfill would complete, the report would look ordinary, and the one live restricted user
would quietly lose records. An abort is the only way that arrives as a question rather than as a
support ticket.

The gate for the whole migration (§7) is unchanged: after backfill, the set
`{Customer where Sales_Rep__c = Dennis}` ∪ `{Solar where Sales_Rep__c = Dennis}` must equal the set
the TEMP name-match returns today. Any record in the old set and not the new one is a backfill defect
to fix before cutover, not a tolerance.

---

## 3. Row-filter semantics per object

### 3.1 Module gate (whole objects)

| Object key | `tenant` | `dealer` | `own` | `none` |
|---|---|---|---|---|
| `customer` | all | `dealer_sf_id = me.dealer` | `sales_rep_sf_id = me.user` | deny |
| `solar` | all | same | same | deny |
| `roofing` | all | **deny** | **deny** | deny |
| `commercial`, `service`, `service_visit` (when they exist) | all | deny | deny | deny |
| `po`, `po_credit`, `asset` | all | deny | deny | deny |
| `user` (`GET /sf/user`, `GET /sf/users`) | all | §3.5 | §3.5 | deny |
| `meta/*/picklist(s)` | all | only for objects the role can read, and only fields the role can `read`/`edit` (§4.4) | same | deny |

"Deny" is `403 { code: "MODULE_FORBIDDEN" }` on list/search/create and `404 RECORD_NOT_FOUND` on
single-record reads (a record you may not see is indistinguishable from one that does not exist,
same as cross-tenant today). The client hides the Roofing/Service/Commercial navigation items and the
roofing leg of global search from `user.access.modules` (§4.5) so the 403 is never seen in normal use.

### 3.2 The filter, in both dialects

`rowFilter("customer", {scope:"own", userId})` →
- cache: `client_sf_id = :tenant AND sales_rep_sf_id = :userId`
- SOQL: `Client__c = ':tenant' AND Sales_Rep__c = ':userId'`

`rowFilter("solar", {scope:"dealer", dealerId})` →
- cache: `client_sf_id = :tenant AND dealer_sf_id = :dealerId`
- SOQL: `Client__c = ':tenant' AND Dealer__c = ':dealerId'`

Both are id equalities on indexed columns. The filter is applied on every read path:

| Path | Today (rep) | New |
|---|---|---|
| List (cache) | cache bypassed, live SOQL, OFFSET clamp 2000 | cache-served; `rowFilter` ANDed into the PostgREST query; page cap 5000 applies. Dennis's 3,511 customers = **one request**. |
| List (cold-cache SOQL fallback) | live SOQL + name clause | live SOQL + id clause; OFFSET 2000 clamp remains (cold cache only, transient) |
| `?q=` search | name clause ANDed before LIKE group | `rowFilter` ANDed before the ILIKE/LIKE group, both paths. `SEARCH_CAP` unchanged. |
| `?parentId=` | ANDed after rep clause | unchanged mechanism, new clause |
| `?field/value` | ANDed after | unchanged |
| Single read (cache shortcut) | skipped for reps | **allowed**: the cache row now carries `sales_rep_sf_id`/`dealer_sf_id`, so the shortcut checks the filter columns on the row; mismatch → fall through to SOQL with the clause → 404 |
| `?full=true` | live SOQL + name clause, all fields | live SOQL + id clause, then `projectRecord` strips hidden fields (§4.3) |
| Counts / `total` | rep-scoped for 2 objects | cache `COUNT` with the same filter; deny → not called |

### 3.3 Cache changes (the bypass dies here)

Per the established pattern (`sql/sundial_roofing_cache_name_columns.sql`: add column named per
`sfFieldToColumn()`, `cache-sync` picks it up from the OpenAPI spec with no code change, full resync
backfills):

```sql
alter table sundial_customer_cache add column if not exists sales_rep_sf_id text;   -- Sales_Rep__c
alter table sundial_customer_cache add column if not exists dealer_sf_id    text;   -- Dealer__c
alter table sundial_solar_cache    add column if not exists sales_rep_sf_id text;   -- may already exist
alter table sundial_solar_cache    add column if not exists dealer_sf_id    text;
alter table sundial_roofing_cache  add column if not exists dealer_sf_id    text;   -- sales_rep_sf_id exists
create index if not exists idx_customer_cache_rep    on sundial_customer_cache (client_sf_id, sales_rep_sf_id);
create index if not exists idx_customer_cache_dealer on sundial_customer_cache (client_sf_id, dealer_sf_id);
-- same two per object
```

then `sundial-cache-sync {"mode":"full"}` per object (31.9k customers ≈ 27 s, proven). Until the
column exists the endpoint must **deny** sales-role reads (not fall back to unfiltered) — the
opposite of the `created_date` "column absent → stable order" tolerance, because here absence means
the filter cannot be applied.

The cache tables are populated by service-role Lambdas only. Phase 0 verified what PostgREST exposes,
and the answer moved the hardening forward.

> **A4 (2026-08-27): the `REVOKE` is the first SQL of Phase 1, not Phase 6.**
> `sql/sundial_access_p1_cache_hardening.sql` revokes ALL privileges on every `sundial_*_cache` table
> from `anon` and `authenticated`. RLS stays enabled and **no policy is added, changed or dropped** —
> the existing per-table SELECT policy is left exactly as the Phase 0 snapshot found it, so Phase 6's
> diff shows the policy drop alone and is reviewable as one thing.
>
> Why it moved: `anon` and `authenticated` hold `arwdDxtm` — the full privilege set, INSERT/UPDATE/
> DELETE included — on all six tables, and the only thing standing between a browser session and
> 31,640 customer rows is an RLS policy that denies **by accident** (§5.1b). Why it is free: nothing
> reads a cache table from a browser, verified file-by-file (§5.1c), so the revoke is a no-op for the
> portal today and a wall tomorrow.

That is the answer to "what stops a crafted direct query": nothing reads the cache from the browser,
and after Phase 1 nothing **can**.

### 3.4 Writes — `sundial-sf-update`

For every `PATCH /sf/{object}/{id}` and `POST /sf/{object}`, in order, fail closed:

1. `canReadObject` — else 403 `MODULE_FORBIDDEN`.
2. `assertVisibleRecord` — the existing tenant existence SOQL gains the `rowFilter` clause; miss → 404.
3. **Field authorization**: every field in the body must be `edit` for the role in the manifest.
   One forbidden field → the **whole PATCH is rejected** with 403 `FIELD_FORBIDDEN` naming the field,
   and the event is logged with user id (a hidden field in a PATCH body from a sales role is an attack
   signal, not a validation slip). Tenant scope keeps today's behavior (describe-`updateable` only).
4. **Protected fields** are never writable by sales roles regardless of the sheet: `Sales_Rep__c`,
   `Dealer__c`, `Client__c`, `Stage__c`/`Status__c` if the sheet does not say `edit`, and every
   `Sundial_User__c` field (`POST/PATCH /sf/user` is tenant-scope only; user-admin is the real path).
5. Create stamping per §2.3(1). Sales roles may create `customer` only.
6. The existing write-through stale-flag and Realtime broadcast are unchanged.

`DELETE` stays 501.

### 3.5 Users — `GET /sf/users`, `GET /sf/user`, @-mention pickers, rep dropdowns

| Scope | Returned users |
|---|---|
| `tenant` | all active users in tenant (today's behavior) |
| `dealer` / `own` | `(Dealer__c = me.dealer) ∪ (Access_Level__c ∈ tenant-wide set)` — their own dealer's people plus Harmon staff, **never another dealer's reps** |
| `none` | 403 |

The same predicate is materialized for RLS (§5.2) so the mentions picker and the Lambda agree.
`sundial_user_cache` gains `dealer_sf_id` and `access_level` columns so this is cache-served.

### 3.6 Actions and files

| Surface | `tenant` (Admin+) | `Manager`/`Executive` | `dealer` / `own` |
|---|---|---|---|
| Create Project (`POST /sf/solar` from customer) | ✔ | ✔ | ✘ |
| Budget recalc / push / attributes-sync | ✔ | ✔ | ✘ 403 `ACTION_FORBIDDEN` |
| Acumatica sync | ✔ | ✔ | ✘ |
| Aurora design-request submit (`POST /customers/{id}/design-request/submit`) | ✔ | ✔ | ✔ **on visible customer records only** (`assertVisibleRecord`; the dealer's name and the stamped rep flow into the Aurora project) |
| New Customer | ✔ | ✔ | ✔ (stamped, §2.3) |
| Customer files: list / download / upload | ✔ | ✔ | ✔ on visible records only (`assertVisibleRecord` added to `list-files`, `upload-file`, `list-related-files`) |
| Customer files: delete | ✔ | ✔ | ✘ |
| Solar files: any | ✔ | ✔ | ✘ 403 (all four file Lambdas, including `list-related-files` which is ungated today) |
| Copy files to Solar | ✔ | ✔ | ✘ |
| Manage Users | Super Admin only | — | — |
| Welcome Call / Retell, Aurora inbound, comment-notify | webhooks; unchanged | | |

Actions are keyed (`budget.recalc`, `files.solar.list`, …) in one table in `lib/access.js`; each Lambda
calls `canAction` and nothing else. Client buttons render from `user.access.actions`.

### 3.7 Emails and notifications

- `sundial-comment-notify` emails the comment body to the mentioned user. The RLS insert policy on
  `comment_mentions` (§5.3) refuses a mention of a user who cannot see the record, so the Lambda never
  receives one; the Lambda additionally re-checks `record_visible(mentioned_user, record)` via the
  service role before sending (defense in depth, best-effort, never fails the insert).
- `sundial-welcome-call` notifies configured Harmon staff addresses; no rep is a recipient. Assert in
  Phase 5 that `config.js` recipients are tenant-scope users only; no change expected.
- Realtime `postgres_changes` respect RLS; the cache broadcast channels carry ids only.

---

## 4. Field visibility — sheet → manifest → both layers

### 4.1 Source of truth: the field-design workbooks

The three workbooks (`Sundial_Customer__c_Field_Design.xlsx`, `Sundial_Solar_Fields_by_Section.xlsx`,
`Sundial_Roofing_Fields_by_Section.xlsx`) gain one column **per sales role**:

| new column | values | blank means |
|---|---|---|
| `Sales Rep` | `hidden` \| `read` \| `edit` | `hidden` |
| `Sales Dealer` | `hidden` \| `read` \| `edit` | `hidden` |

Tenant-wide roles are not columns: they see every field the sheet places in a section, editable per
the existing `Visibility/Editability` / `readOnly` rule. Adding a future role (`Technician`) is adding a
column. A value other than the three is a **generator error**, not a default.

Rules the generator enforces at generation time (fail the build, not the request):
- A field marked `edit` for a role must be describe-`updateable` (formulas cannot be `edit`).
- `Sales_Rep__c`, `Dealer__c`, `Client__c`, `Stage__c`/`Status__c` cannot be `edit` for sales roles
  (§3.4 protected list) — the generator refuses the sheet.
- Roofing sheet: no role columns needed while the module is denied; the generator emits an
  all-hidden manifest for sales roles and a warning if someone adds the columns anyway.

Sections are not marked; **a section with zero visible fields is hidden**. That replaces the rail-id
hiding whose documented failure mode was "a split silently un-hides" — a split section is two sections
whose fields carry their own marks. The D7 mirror tabs (`solar-adders`, `solar-commissions`) render
Solar fields on the Customer page; they are governed by the *Solar* manifest, which the server applies
to the linked-Solar read those panels perform. The synthetic `files` tab is an action (§3.6), not a field.

### 4.2 Generator — lives in `sundial-core`

`scripts/generate-field-configs.mjs` (moved from harmon-crm's two generators, merged, plus the roofing
sheet) reads the workbooks from `sundial-core/docs/` (they move here; harmon-crm keeps no copy) and
emits:

1. `lib/field-manifest/customer.json`, `solar.json`, `roofing.json` — **server manifest**:
   ```json
   { "version": "sha256:…", "object": "Sundial_Customer__c",
     "roles": { "Sales Rep": { "read": ["First_Name__c", …], "edit": ["Sales_Rep_Notes__c", …] },
                "Sales Dealer": { … } },
     "listColumns": { "Sales Rep": ["first_name", "last_name", "stage", …] } }
   ```
   `listColumns` is derived: cache column ↔ SF field via `sfFieldToColumn()`, kept if the field is
   `read` or `edit`. Cache columns with no sheet row (`sf_id`, `client_sf_id`, control columns,
   `*_at_creation` mirrors) have a fixed allowlist in the generator, reviewed once.
2. `<harmon-crm>/src/config/customer-detail-config.ts` etc. — the **client layout**, unchanged shape
   (`sections[].fields[]`), with the generated file's header carrying the same `version`.
3. `lib/field-manifest/index.js` — a loader that **refuses to start** (throws at cold start) if a JSON
   is missing or malformed, so a deploy with a broken manifest fails loudly instead of serving
   unfiltered data.

Output (2) is written across repos via a `HARMON_CRM_DIR` env/flag. The risks of one repo writing
into another, and how they are handled:

| Risk | Mitigation |
|---|---|
| Two commits in two histories must be coordinated; one can land without the other | Both outputs embed `version`. `/auth/me` returns `access.manifestVersion`; the client compares with its config header and shows a non-blocking "config out of date" banner in DEV and logs in prod. Deploy order is server-first always (§8), and a stale client is *safe* — it only renders what the server sent. |
| Path assumption on one machine; CI cannot run the cross-write | The generator never runs in CI. CI in harmon-crm runs a `check` mode that re-derives the version from the committed sheets in a sibling checkout (or a vendored copy of the JSON manifests) and fails on mismatch. |
| Generator run from the wrong branch of the other repo | The script prints and requires `--confirm-target` with the resolved absolute path and current branch of the target repo. |
| The sheets fork | They live in one place (sundial-core); harmon-crm's `docs/` copies are deleted in Phase 4. |

The alternative — the client having no generated role knowledge at all and rendering purely from the
server's per-response `access` block (§4.3) — is what makes the stale-client case safe. The generated
client config exists for layout (sections, order, labels, types), not for authorization.

### 4.3 Server enforcement on reads

`GET /sf/{object}/{id}?full=true` for a sales role: SOQL selects **only** the manifest's
`read ∪ edit` fields for the role (not "all queryable fields then strip" — the stripped data should
never leave Salesforce), and the response carries:

```json
{ "source": "salesforce", "full": true, "record": { … visible fields only … },
  "access": { "editable": ["Sales_Rep_Notes__c", …], "manifestVersion": "sha256:…" } }
```

Tenant scope: unchanged query; `access.editable` = describe-updateable minus blocklist. List/search rows
go through `projectRow` with `listColumns`. The cache row shortcut on single reads is projected the
same way.

### 4.4 Picklist metadata

`GET /sf/meta/{object}/picklists` today returns every picklist on the object. For sales roles it returns
only fields in the role's `read ∪ edit` set. Values themselves remain org-wide (the one deliberate
exception to tenant scoping stays).

### 4.5 Client: reflect, never decide

- `AuthContext` exposes `user.access` (`scope`, `modules`, `actions`, `manifestVersion`).
- `nav.ts` filters items by `modules`; `GlobalSearch` runs only enabled legs; `DashboardPage` counts
  come from the already-filtered list.
- Detail pages render `sections.filter(s => s.fields.some(f => f.apiName in record))`, and
  `record-editing.ts` treats a field as editable iff `access.editable` includes it (the sheet's
  `readOnly` remains a rendering hint for tenant scope).
- Action buttons render iff `actions` includes the key. They still get a 403 if forced.
- `temp-role-tab-visibility.ts` and its two call sites are **deleted** in Phase 4, not adapted.

---

## 5. Supabase RLS — comments, mentions, preferences, profiles

Comments are browser-direct (D-056). RLS cannot call a Lambda, so scope is **materialized** into
server-owned tables and evaluated by `security definer` functions.

### 5.1 Phase 0 prerequisite

The live policies on `comments`, `comment_mentions`, and `profiles` are not in the repo. Before any
change, `pg_dump --schema-only` of those tables plus `pg_policies` output is committed to
`sql/live-snapshot-2026-08.sql` so the change is reviewable as a diff. The design below assumes the
current policies are tenant-scoped via a `current_user_tenant_id()` helper reading `profiles`; the
snapshot confirms or corrects that.

**DONE, 2026-08-27 — and it CORRECTS the assumption.** The snapshot is
`sql/live-snapshot-2026-08-27.sql`, produced through the read-only Supabase MCP server against
project `qfsdpkwxahakegjnyijj`. There are **two** helpers, not one, and they read different tables:

| helper | reads | used by |
|---|---|---|
| `current_user_tenant()` | `public.profiles` | `comments`, `comment_mentions` |
| `current_user_tenant_id()` | `public.portal_users` | **all six** `sundial_*_cache` tables |

`public.portal_users` exists and holds **0 rows**, so `current_user_tenant_id()` returns NULL for
every session and `tenant_id = NULL` denies every row. The cache tables are closed today **by
accident, not by design** — see §5.1b.

#### 5.1a Reachability — measured, both halves

`scripts/probe-cache-reachability.mjs`. One `GET …?select=*&limit=1` per table over PostgREST.
Exact row counts taken separately through the service role (which bypasses RLS) so that a
200-with-zero-rows answer can be told apart from an empty table.

- **anon half** — 2026-08-26, publishable key only (a logged-out browser).
- **authenticated half** — 2026-08-27, `tim+zz-rep-a1@constructiveoperations.com`
  (ZZ TEST user, `Access_Level__c` = Sales Rep; password from Secrets Manager
  `sundial/test-users`, never written to a file). `auth.uid()` =
  `12ba1387-7b7a-48c8-9d07-b2578f4cbddf`, `profiles.tenant_id` = `a1W7y000007AszBEAS`,
  `sundial_user_id` = `a1O7y00000sfEzBEAU`.

| table | true rows | anon | authenticated (zz-rep-a1) | rows returned | other user's / other tenant's? |
|---|---:|---|---|---:|---|
| `profiles` | 35 | 200, 0 rows | **200, 1 row** | 1 | **No** — own row only (`auth.uid() = id`) |
| `comments` | 485 | 200, 0 rows | **200, 485 rows** | 485 | **YES — other users.** 0 of 485 authored by this rep; 10 distinct authors. Same tenant only. |
| `comment_mentions` | 14 | 200, 0 rows | **200, 14 rows** | 14 | **YES — other users.** 0 of 14 mention this rep; 8 distinct `mentioned_user_id`. Same tenant only. |
| `user_preferences` | 4 | 200, 0 rows | 200, 0 rows | 0 | No |
| `sundial_customer_cache` | 31,640 | 200, 0 rows | 200, 0 rows | 0 | No |
| `sundial_solar_cache` | 4,481 | 200, 0 rows | 200, 0 rows | 0 | No |
| `sundial_roofing_cache` | 2 | 200, 0 rows | 200, 0 rows | 0 | No |
| `sundial_user_cache` | 133 | 200, 0 rows | 200, 0 rows | 0 | No |
| `sundial_po_cache` | 0 | 200, 0 rows | 200, 0 rows | 0 | n/a — genuinely empty, proves nothing |

No cross-**tenant** row was returned anywhere: every row read carried
`tenant_id = a1W7y000007AszBEAS`, the rep's own tenant. Harmon is the only tenant in this project
today, so that is a weak result — it demonstrates the tenant filter is not *inverted*, not that it
would hold against a second tenant's data.

The cross-**user** result is the strong one, and it is a finding:

> A Sales Rep with no elevated access reads **every comment in the tenant** — all 485, on `solar`
> and `customer` records alike, none of them their own, including threads on records the rep cannot
> open in the portal. Same for all 14 mention rows, none of which mention them. `comments`'
> `SELECT` policy is `tenant_id = current_user_tenant()` and nothing more; `comment_mentions`
> inherits that through its parent comment. This is exactly the gap §5.3 closes by ANDing
> `record_visible(record_object, record_id)` into the comments policy and narrowing mentions to
> `mentioned_user_id = auth.uid()`.

Status is **200 on every row of the table above**, for both anon and authenticated. 200 is the
finding: a missing grant answers 401 and a missing route 404, so PostgREST routes all of these and
a SELECT grant exists. RLS is the only thing returning empty.

#### 5.1b The cache-table `revoke` is more urgent than §3.3 assumed

The snapshot's grant block (block 6) is **defective** — `information_schema.role_table_grants` only
shows grants involving a role the querying user belongs to, and the read-only MCP user belongs to
none of `anon`/`authenticated`/`service_role`, so it returned zero rows. Re-asked through
`pg_class.relacl`, the real answer inverts:

**`anon` and `authenticated` hold `arwdDxtm` — the full privilege set, including INSERT, UPDATE and
DELETE — on all six cache tables.** Nothing has ever been revoked. Only the RLS deny stands between
a browser session and 31,640 customer rows, and that deny rests on a policy filtering against an
empty table.

Two edits, each of which reads as an obvious bug fix, would open the whole cache to any
authenticated session in the tenant with no per-rep scoping at all:

1. populating `public.portal_users`, or
2. repointing `current_user_tenant_id()` at `profiles` — which is precisely what this section
   previously assumed had already been done.

A third accident currently blocks (2): `profiles.tenant_id` holds the `Sundial_Tenant__c` record id
(`a1W7y000007AszBEAS`) while the cache tables' `tenant_id` holds the slug (`harmon`) and keep the
record id in `client_sf_id`. So the comparison would still fail — for a reason nobody wrote down.

Three independent accidents, all failing closed, none designed. **A4 (2026-08-27) pulls the §3.3
`revoke` forward into Phase 1**, as its first SQL, rather than leaving it in Phase 6. Blocking
prerequisite: nothing reads these tables from a browser today (verified — §5.1c), so the revoke is a
no-op for the portal.

> **`public.portal_users` and `current_user_tenant_id()` are LOAD-BEARING ACCIDENTS. Populating that
> table, or repointing that helper at `profiles`, would expose the entire cache — 31,640 customer
> rows and 4,481 solar rows — to any authenticated session in the tenant, with no per-rep scoping
> whatsoever. NEITHER MAY BE "FIXED" BEFORE THE REVOKE IS APPLIED.**
>
> This is written in this register because both edits read as obvious housekeeping. `portal_users` is
> an empty table that looks abandoned; `current_user_tenant_id()` reads it while its near-namesake
> `current_user_tenant()` reads `profiles`, which looks like a copy-paste bug someone should tidy.
> Either "fix" is a one-line change, would pass review from anyone who had not read this paragraph,
> and would turn six deny-everything policies into allow-everything policies in the same instant.
> After the revoke, both edits become harmless — the grant is gone, so the policy expression no longer
> decides anything. **Apply the revoke first. Then tidy, if it still seems worth it.**

Fix block 6 of `sql/snapshot-supabase.sql` before the next snapshot, or Phase 6 will "verify" its
revoke against a query that returns zero rows whether or not the revoke happened.

#### 5.1c Who reads the cache tables from a browser — nobody

Grepped `harmon-crm/src` and `sundial-core/{lambdas,lib}` for any read of a `sundial_*_cache` table
from the browser or through a non-service-role client. **Zero hits.**

- `harmon-crm/src` — the only two occurrences of a cache-table name are prose comments
  (`src/config/customer-status-columns.ts:11`, `src/pages/RoofingProjectsPage.tsx:7`), both saying
  the data arrives via the Lambda API.
- The single browser Supabase client (`src/lib/supabase.ts:19`, anon key, `createClient` called
  nowhere else) issues `.from()` against exactly three tables: `comments`, `comment_mentions`,
  `user_preferences`.
- Backend cache access is service-role only: `lib/supabase.js` reads
  `sundial/supabase/service-role`, and the four raw-PostgREST call sites all send
  `apikey: cfg.serviceRoleKey`. No anon or publishable key appears anywhere in `lambdas/` or `lib/`.

Full file:line list in PROGRESS.md, 2026-08-27.

### 5.2 `profiles` gains server-owned scope columns

```sql
alter table public.profiles
  add column if not exists access_scope   text,   -- tenant | dealer | own | none
  add column if not exists access_level   text,
  add column if not exists dealer_sf_id   text;
```

Written **only** by `sundial-auth-proxy`'s existing service-role upsert on every `/auth/me`. No client
`update` grant exists on `profiles` and none is added (the D-056 argument applies verbatim: RLS is
row-level, one `update` policy would let a session rewrite its own scope). `role` keeps carrying
`Hierarchy_Level__c` until Phase 7 removes it.

Helper functions, all `security definer`, `set search_path = public`, `stable`:

```sql
current_profile()                       -- (tenant_id, access_scope, sundial_user_id, dealer_sf_id) for auth.uid()
record_visible(p_object text, p_id text)              -- for the current session
record_visible_for(p_profile_id uuid, p_object, p_id)  -- for another user (mentions)
user_visible(p_profile_id uuid)                        -- same-dealer or tenant-wide user
```

`record_visible` reads the cache tables (service-owned; RLS-denied to clients, §3.3):

```sql
select case p.access_scope
  when 'tenant' then true                                    -- A7, see below
  when 'dealer' then exists(… and c.dealer_sf_id = p.dealer_sf_id)
  when 'own'    then exists(… and c.sales_rep_sf_id = p.sundial_user_id)
  else false end
```

`p_object` is mapped to a table through a fixed `case`; `roofing`/`po`/`user` return false for sales
scopes (module gate). A record absent from the cache is invisible to sales scopes (fail closed; the cache
is populated read-through, so the record's detail page — which a rep must have loaded to comment — has
already put it there).

#### A7 — the `tenant` branch does not consult the cache, and the scope comes from two sources

**Applied 2026-08-27, in Phase 1b, on three measurements taken while building it. Shipped as
`sql/sundial_access_p1b_comment_rls.sql`.**

**A7.1 — `tenant` returns `true` unconditionally.** The pseudocode above originally wrote all three
branches as `exists(select 1 from <cache> …)`. Applied literally that hides comments on any record
missing from the cache from **everyone, admins included** — and **18 commented records (28 comments)
were missing**: 15 solar of 187 commented, 3 customer of 29, all from July 2026, the records
themselves long since deleted in Salesforce and swept by the cache reconcile. The prose immediately
below the block already said "invisible **to sales scopes**"; the prose was right and the pseudocode
was stricter than it meant. For `tenant`, the caller's own `tenant_id` match is the whole control,
which is what §3.1's "tenant | all" row says. A module shipping later therefore cannot silently hide
its comments from staff by not yet being in the object map.

**A7.2 — scope is the NARROWER of `profiles.access_scope` and a `sundial_user_cache` derivation,
nulls ignored** (`none < own < dealer < tenant`). §5.2 named `profiles.access_scope` as the only
source. **That column was NULL on 21 of 35 rows when Phase 1b was built**, because it is written only
on a `/auth/me` since the Phase 1 deploy — so "read profiles, deny NULL" would have hidden every
comment from **17 real Harmon staff, including 11 of 14 Executives and 6 of 8 Managers**, until each
happened to log in again. `profiles` stays the authority (it is the only source that knows
`Sundial_Dealer__c.Active__c`); the cache derivation covers everyone regardless of login. `least()`
is safe in both directions — a stale profile cannot widen past a demotion Salesforce already knows
about, and the cache cannot widen past a narrowing only `lib/access.js` can compute. Verified on the
two rows that need it: 17 staff (profile NULL, cache `tenant`) → `tenant`; `zz-rep-inactive-dealer`
(profile `none`, cache `own`) → `none`.

**A7.3 — `sundial_user_cache` gains `supabase_user_id`,** so a mentioned user with no `profiles` row
still resolves. `Sundial_User__c.Supabase_User_Id__c` is written by `user-admin` at user-**create**
time, before first login, and `cache-sync` picks the column up with no code change. **Not
hypothetical:** after the sync, 34 of 34 active users carry a uuid and exactly one — an active
Executive, provisioned, never signed in (her Salesforce email is misspelled) — has no `profiles`
row. She resolves to `tenant` from the cache alone. Without this column she would have been
permanently unmentionable, with no symptom but a mention row that silently failed to insert.

**Residual, accepted:** the cache derivation cannot see `Dealer__c.Active__c` (there is no
`sundial_dealer_cache`). A sales user whose dealer was deactivated *and* who has no `profiles` row is
scoped by their access level rather than to `none`. It can only affect whether they can be
*mentioned* — `record_visible_for` still requires the record to carry their rep or dealer id — and it
self-corrects at their first login. Zero users today.

### 5.3 Policies

> **A5 (2026-08-27): this section is now Phase 1b, immediately after Phase 1** — not Phase 6.
> Phase 0 measured what it closes: a Sales Rep with no elevated access reads **every comment in the
> tenant**, all 485, none of them their own, on records they cannot open (§5.1a). That is a live
> cross-user leak, not a hardening item, and it does not depend on the field manifest, the module
> gate, or anything else Phases 2–5 build. It needs `record_visible()`, which needs the cache columns
> Phase 1 adds — so Phase 1b is the earliest it can run, and there is no reason for it to run later.
>
> The cache-table half of Phase 6 came forward too, as A4. What is left in Phase 6 is the policy drop
> on the cache tables and the `profiles` policy work.
>
> **SHIPPED 2026-08-27** as `sql/sundial_access_p1b_comment_rls.sql` (Parts A/B/C). Gate evidence in §8.

```sql
-- comments
select : tenant_id = current tenant AND record_visible(record_object, record_id)
insert : tenant_id = current tenant AND author_id = auth.uid() AND record_visible(record_object, record_id)
delete : author_id = auth.uid() AND tenant_id = current tenant     -- unchanged from the old policy
update : none
-- comment_mentions
select : mentioned_user_id = auth.uid()           -- feed. NOTHING ELSE (see below)
insert : created by me on a comment I can see
       AND user_visible(mentioned_user_id)
       AND record_visible_for(mentioned_user_id, record_object, record_id)
update : NONE (see below)
delete : none — the comments cascade is the only path
```

Reps read Harmon staff comments on their own deals (shared thread, per your answer); they cannot mention
a user they cannot see, and nobody can mention a user onto a record that user cannot see, so the
notify email never carries data past its scope. `user_preferences` is unchanged (already per-user).

**Two things this section originally sketched were deliberately NOT built, both under D-064's "a wide
grant is the default and a narrow one is the exception":**

- **No `OR (author is me)` branch on the mentions SELECT.** It was hedged here as "if the UI needs
  it". It does not: `MentionsFeed.tsx` filters on `mentioned_user_id` alone, and `CommentThread.tsx`
  inserts mention rows **without** `.select()`, so nothing reads one back.
- **No mentions UPDATE policy.** There is no read/ack column; the only nullable one is `notified_at`,
  which `sundial-comment-notify` stamps through the service role as its idempotency marker. `anon`
  and `authenticated` hold `arwdDxtm` on this table (Phase 1 revoked the cache tables and `profiles`
  and deliberately left this one), so **the absence of the policy is what makes that UPDATE grant
  inert.** Adding one would let a user stamp their own pending mention and suppress their own alert
  email, and the send path would report a clean skip. Do not "complete" the policy set.

**A8 — the EXECUTE grant on the definer helpers.** `revoke ... from public` is **not** enough on this
project: Supabase ships `alter default privileges in schema public grant all on functions to anon,
authenticated, service_role`, so each new function gets a **direct** grant to each role and the
PUBLIC revoke removes an entry that was not doing the work. V2 caught it after Part B was applied
(`private.resolve_access` was correctly locked down — those defaults are scoped `in schema public`,
which is the tell). Part C revokes `record_visible_for`, `user_visible` and `current_profile` from
`anon`. Only `record_visible_for` was materially exposed: it takes its subject as an **argument**, so
it never consults `auth.uid()` and was an unauthenticated boolean oracle over "does this record exist
and can this user see it". The other two are inert for anon (their `me` side resolves through
`auth.uid()`, which is NULL). **`record_visible` keeps its `anon` grant on purpose** — the
`comments` policies call it and policies evaluate as the invoking role, so revoking it would turn an
anonymous read from "200, 0 rows" into a 42501, changing the anon surface Phase 0 baselined for no
gain. `create or replace` preserves an ACL; a `drop` + `create` re-applies the defaults and silently
re-opens anon, so re-run Part C after any drop.

### 5.4 Realtime

`postgres_changes` on `comments` filtered by `record_id` already honors RLS; a rep subscribed to a
record they lose (reassignment) stops receiving events on their next `/auth/me` profile refresh
because `record_visible` re-evaluates per event.

---

## 6. Surface inventory — the fate of every item

| Surface | Today for a rep | After | Enforced by |
|---|---|---|---|
| List (cache) customer/solar | live SOQL, name match, cache bypass, 2000 cap | cache, id filter, projected columns | `sf-query` + `lib/access` |
| List (cold SOQL) | name match | id clause | same |
| `?q=` | name match ∧ LIKE | id filter ∧ LIKE | same |
| `?parentId=` | ∧ name match | ∧ id filter | same |
| Single read | SOQL only, name match | cache shortcut with column check, else SOQL | same |
| `?full=true` | all ~280 fields | manifest fields only + `access.editable` | same + manifest |
| Roofing / PO / Commercial / Service | **unrestricted** | 403 module deny | `canReadObject` |
| `GET /sf/user`, `/sf/users` | whole tenant user cache | own dealer ∪ Harmon staff | `sf-query` + RLS `user_visible` |
| Picklist meta | every field | manifest fields | `sf-query` |
| `PATCH` | any record, any updateable field | visible record, `edit` fields, whole-patch reject | `sf-update` |
| `POST /sf/customer` | any fields | stamped rep/dealer, `edit` fields | `sf-update` |
| `POST /sf/solar`, `/sf/user`, others | allowed | 403 | `sf-update` |
| Supabase cache tables | no RLS, service-role only | RLS enabled, zero policies, revoked | SQL |
| Comments read | tenant (policy not in repo) | tenant ∧ record_visible | RLS |
| Comments insert/delete | tenant / any | own author ∧ visible / own | RLS |
| Mentions | tenant | visible user ∧ user can see record | RLS + notify re-check |
| Mentions feed | own | own (unchanged) | RLS |
| Files customer list/upload/download | tenant | visible record | file Lambdas + `assertVisibleRecord` |
| Files customer delete | tenant | 403 | `canAction` |
| Files solar (list) | 403 | 403 | `canAction` |
| Files solar (related/upload/delete) | **open** | 403 | `canAction` |
| Copy-to-solar | open | 403 | `canAction` |
| Global search | 2 of 3 legs restricted | 2 legs, roofing leg not run; server 403 regardless | client reflect + server |
| Dashboard / boards / counts | derived from restricted solar list | same, via filtered list + filtered count | `sf-query` |
| CSV / export | none exists | none; any future export goes through `projectRow` | — |
| Create Project, budget recalc/push/attr-sync, Acumatica | **open** | 403 | `canAction` in each Lambda |
| Aurora design-request submit | open | allowed on visible records only | `canAction` + `assertVisibleRecord` |
| Manage Users | super admin | super admin; `Dealer__c` required for sales roles; `Hierarchy_Level__c` derived | `user-admin` |
| Welcome call / notifications | staff-only recipients | unchanged, asserted | config |
| Realtime | RLS | RLS | Supabase |

---

## 7. Migration — retiring the jank without widening Dennis

Principle: **new and old enforcement overlap; nothing is removed until a scripted diff proves the new
set is identical-or-tighter for every live user.**

1. **Shadow mode.** `sf-query` gains `ACCESS_MODEL_MODE = off | shadow | enforce` (env, default
   `off`). In `shadow`, every list/single/full read computes both the TEMP decision and the new
   `rowFilter`, serves the TEMP result, and emits one structured log line per request:
   `{ user, object, path, oldCount, newCount, onlyInOld: [...ids], onlyInNew: [...ids] }`.
2. **Diff report.** `scripts/access-shadow-report.mjs` runs offline against Salesforce + the cache,
   per portal user, per object: old visible id set (TEMP rule for `Hierarchy_Level__c = Sales Rep`
   users; everything for everyone else) vs new set (`rowFilter`). Output is a table plus the two
   difference lists. **Gate:** for Dennis, `onlyInNew` on customer and solar must be **empty**
   (nothing widens); `onlyInOld` is investigated record-by-record (each is a backfill miss) and must
   be empty before enforce. For every other user the report shows what they will lose (e.g. a
   user-admin-created staffer who was never fixed by hand — see Phase 0) so you can set
   `Access_Level__c` before the flip.
3. **Enforce with belt and braces.** Flip to `enforce`: the new `rowFilter` is applied **and** the TEMP
   clause is still ANDed on top for users the TEMP rule matches. Access can only tighten. Re-run the
   report: it must now show zero difference between served and expected.
4. **Remove TEMP.** Delete `repRestrictFor`, the `TEMP_*` constants, the four guarded sites in
   `sf-query`, the `list-files` 403 (replaced by `canAction`), and the TASKS `[~]` entry. Run the
   report once more; run the access matrix (§9) as Dennis's twin test user.
5. **Client.** Only after (4) is deployed and verified: delete `temp-role-tab-visibility.ts` and its
   two call sites; switch to `access.editable`/section auto-hiding. A client deployed early is still
   safe (server already strips); a server deployed early is safe (client hides a superset).

Rollback at any step is `ACCESS_MODEL_MODE=off` (env change, no deploy) until step 4; after step 4
rollback is a redeploy of the previous Lambda zip, which has the TEMP guard.

---

## 8. Phased build plan with test gates

Server first in every phase; the client change of a phase lands only after its server change is
verified in prod. Each phase is one feature branch per repo (`feature/access-model-pN`), PROGRESS /
TASKS / DECISIONS / docs updated in the same commits.

### Phase 0 — Discovery and hardening (no behavior change for Dennis)
sundial-core:
- Snapshot live Supabase policies/grants/table DDL for `profiles`, `comments`, `comment_mentions`, all
  `sundial_*_cache` into `sql/live-snapshot-2026-08.sql`. Verify whether cache tables are exposed to
  `authenticated`.
- Describe `Sales_Representative__c`, `Sales_Rep__c`, `Sunbase_Sales_Rep__c`, `Sales_Company__c`,
  `Sales_Company_Harmon_Solar_or_Third__c`, `Dealer_Name__c` on both objects; record types and
  populated counts in this doc's §2.4.
- **Fix `user-admin`:** derive `Hierarchy_Level__c` from `accessLevel` on create (`Sales Rep` →
  `Sales Rep`, `Sales Dealer` → `Sales Manager`, everything else → `Client`) and allow the same
  derivation on PATCH of `accessLevel`. Report which existing users have `Hierarchy_Level__c = Sales
  Rep` with a non-rep `Access_Level__c`. *This widens newly-created staff to what you set by hand today
  and touches nothing about Dennis.*
- Test fixtures (§9): dealer rows, users, records.
- Record the D-045…D-050 numbering collision as a one-line note in both DECISIONS.md and pick D-064
  here.
**Gate:** snapshot committed; describe results recorded; `verify-provisioning-e2e` extended to assert
the derived hierarchy; test users can log in and `/auth/me` resolves.

### Phase 1 — Data model and cache
sundial-core, branch `feature/access-model-p1`. **Nothing on Dennis's read path is touched:**
`sundial-sf-query`, `repRestrictFor`, its four call sites and `sundial-list-files`'s Solar 403 are
unchanged this phase, which is what makes "nothing changes for Dennis" a fact rather than an intention.

1. **`sql/sundial_access_p1_cache_hardening.sql` (A4, first)** — revoke ALL on every `sundial_*_cache`
   table from `anon` and `authenticated`. RLS stays enabled; **no policy change**. Applied by Tim in
   the Supabase SQL editor, with a verification query. It ships first because it is the one item that
   is strictly a reduction in exposure and depends on nothing else in the phase.
2. **SF package `salesforce/v6-access-model/`** — `Sundial_Dealer__c` (`Name`, `Client__c` →
   `Sundial_Tenant__c`, `Is_Internal__c`, `Active__c`) and the `Dealer__c` lookup on
   `Sundial_User__c`, `Sundial_Customer__c`, `Sundial_Solar__c`, `Sundial_Roofing__c`,
   `Sundial_Commercial__c`; permission-set entries so the integration user can read and write all of
   it. Deployed by Tim from Workbench; every step after this blocks on it being live.
3. **`scripts/backfill-dealers.mjs`** — dealer rows, the ZZ TEST user stamps, and Dennis (§2.4).
   Report-only by default, `--apply`, canary-first. Report reviewed before apply.
4. **`scripts/backfill-deal-ownership.mjs`** — `Dealer__c` on Customer and Solar from the rep (A1),
   then the Solar alias pass for rep-less records (A2), with the A3 abort check. Report-only by
   default; the report carries counts by outcome and the **full** near-miss list. Reviewed first.
5. **`sql/sundial_access_p1_cache_columns.sql`** — `sales_rep_sf_id` + `dealer_sf_id` on the customer,
   solar and roofing caches (add-if-missing), `dealer_sf_id` + `access_level` on
   `sundial_user_cache`, and the `(client_sf_id, <col>)` indexes. Applied by Tim; then
   `sundial-cache-sync` in full mode per object, and counts by `sales_rep_sf_id` reconciled against
   SOQL. **No Lambda change:** `sfFieldToColumn()` already maps `Sales_Rep__c` and `Dealer__c` (both
   `reference`) to `*_sf_id`, and `Access_Level__c` to `access_level`.
6. **`lib/access.js`** — `resolveScope`, `rowFilter`, `canReadObject`, `canAction`,
   `assertVisibleRecord` (§1.3/§3) + unit tests over every access level × every object × null dealer
   × inactive dealer × unknown level, every fail-closed case asserted. **Not wired into any Lambda
   this phase** — Phase 2 does that, behind `ACCESS_MODEL_MODE=shadow`.
7. **`lib/identity.js` + `auth-proxy`** — the identity SOQL adds `Dealer__c, Dealer__r.Active__c,
   Dealer__r.Is_Internal__c` and returns the `access` block; `/auth/me` upserts `access_scope`,
   `access_level` and `dealer_sf_id` into `profiles` (columns via a small SQL file Tim applies — no
   policy change, no client grant). **Deployed last**, after the columns exist.
8. **`scripts/access-shadow-report.mjs`** — per portal user, per object: old visible id set (TEMP
   rule) vs new (`rowFilter` over the cache), with `onlyInOld` / `onlyInNew`. Report only.
9. **`scripts/repair-mis-stamped-users.mjs` (A6)** — report only until approved.

**Gate:** backfill report shows Dennis `onlyInOld = ∅` on customer and solar; cache counts by
`sales_rep_sf_id` match SOQL; unit tests green; `/auth/me` for each ZZ TEST user returns the expected
scope and `dealerId` (§9 matrix); `zz-rep-nodealer` and `zz-tech` resolve to scope `none`;
`verify-access-matrix.mjs` still passes against the unchanged TEMP behaviour.

#### Phase 1 gate — evidence, 2026-08-27

Every gate below is a command anyone can re-run, not a claim. Counts are from a live org
and drift; the invariants do not.

| Gate (§8) | Evidence | Result |
|---|---|---|
| Dennis `onlyInOld = ∅` on customer and solar | `scripts/access-shadow-report.mjs` | customer 3,535 = 3,535, solar 779 = 779, `onlyInOld` **0**, `onlyInNew` **0** |
| Cache counts by `sales_rep_sf_id` match SOQL | `scripts/verify-cache-access-columns.mjs` | **every rep checked individually** — 106 on customer, 70 on solar, 1 on roofing — all agree |
| Unit tests green | `npm test` | **641 pass, 0 fail** (was 503 before Phase 0, 628 before this phase) |
| `/auth/me` returns the expected scope + `dealerId` per §9 | `scripts/verify-auth-me-access.mjs` | all ten fixtures match: `own`×4, `dealer`×1, `tenant`×2, `none`×3 |
| `zz-rep-nodealer` and `zz-tech` resolve to `none` | same | both `scope=none`, **0 modules, 0 actions**; `zz-rep-inactive-dealer` likewise |
| `verify-access-matrix.mjs` passes against unchanged TEMP behaviour | `scripts/verify-access-matrix.mjs` | exit 0. `rep-a1` still served Dennis's 3,535 customers and still 404s on its own record; `tech` still sees all 31,651. 51 rows differ from the NEW-model expectation and are **pending**, which is what "not built yet" looks like |

**The gate that is not in the list, and matters most.** Nothing in Phase 1 changes what any
live user sees. That is not asserted, it is measured twice: the shadow report shows **20 of
34 active users with `no change` on both objects**, and the access matrix shows the TEMP
guard behaving exactly as it did before the deploy. The only live user whose access moved is
`Temp Passtwo`, deliberately, via A6 — and that was a *narrowing* being undone.

Additional evidence not required by §8 but worth recording:

- **`Dealer__c` never disagrees with the rep's dealer** (§2.3.5) — 0 of 4,312 on customer,
  0 of 1,188 on solar. Checked client-side, because SOQL cannot compare two fields.
- **Cache totals equal Salesforce** on every object, and reconcile reports **0 ghosts**
  across all five tables (one was found and removed — see PROGRESS).
- **Widenings: 4, all classified EXPECTED**, each a ZZ fixture gaining its own record from
  a guard that filtered on a hardcoded name. None is a leak.

### Phase 1b — Comments and mentions RLS (A5)
sundial-core `sql/sundial_access_p1b_comments_rls.sql`: the `security definer` helpers
(`current_profile`, `record_visible`, `record_visible_for`, `user_visible`) and the §5.3 policies on
`comments` and `comment_mentions`. Applied by Tim in the dashboard, committed here.

**Why it is here and not in Phase 6.** It closes a measured, live cross-user leak — a Sales Rep reads
all 485 comments in the tenant, none of them their own, on records they cannot open (§5.1a). It
depends on Phase 1's cache columns and on nothing else, so Phase 1b is the earliest it can run;
leaving it at Phase 6 would mean carrying a known leak through four phases of unrelated work.
**Gate:** as each ZZ TEST user via supabase-js: comments on a visible record → rows; on an invisible
record → 0 rows; insert on an invisible record → `42501`; mention an other-dealer rep → `42501`;
mention Harmon staff → ok; the mentions feed still returns the user's own rows.

#### Phase 1b gate — evidence, 2026-08-27

| Gate | Evidence | Result |
|---|---|---|
| Every ZZ user × every read/write/mention surface | `scripts/verify-comment-rls.mjs` | **44 checks, 44 pass, 0 fail, 0 skip** |
| Rep reads own record's thread / another rep's / another dealer's / roofing | same | 1 / **0** / **0** / **0** |
| Dealer scope sees both its reps, never the other dealer | same | a1 1, a2 1, **B1 0**, roofing **0** |
| Tenant scope reads every seeded thread incl. roofing | same | 7 of 7 for admin **and** exec |
| `none` scope (nodealer, inactive-dealer, tech) reads nothing anywhere | same | **0** for all three |
| Insert refusals (other rep, other dealer, roofing, forged author) | same | **42501** on all four |
| Mention refusals (other dealer's rep, same-dealer rep onto an invisible record, `none` user, admin→rep onto another dealer's record) | same | **42501** on all four |
| Mentions allowed (rep→staff, admin→rep on the rep's own record) | same | both ok |
| A rep sees only mentions of themselves (was: all 14) | same | **0** foreign rows |
| Delete own only | same | own 1 row, another's **0 rows, no error** |
| Realtime honours the policies | same | no event on another rep's record; **event delivered** on own |
| Live impact, per user, before vs after | V6 | 23 tenant `unchanged`; **Dennis 511 → 79**; 6 `none` → 0; **no `WIDENED` row** |
| Dennis keeps every comment he authored | V7 | **26 of 26** |
| Mentions feed loses nothing | V8 | **14 of 14** still readable by their recipient |
| Policy set is exactly the intended five | V3 | 5 rows, correct expressions, no old names, no UPDATE row |
| Cache tables still revoked from `authenticated` | V10 | `42501 permission denied for table sundial_customer_cache` |
| Tenant-scope reader is untouched under the real policies | V11 | `comments_visible_as_exec` = `tenant_total` = 511 |
| Write refusals under the real policies, as a real session | V12 (a)–(d) | all four as specified |
| §3.7 re-check, end to end through pg_net and SES | `scripts/verify-mention-notify-e2e.mjs` | **11 pass, 0 fail** — happy path stamped `notified_at`; out-of-scope mention refused `record_not_visible`, nothing sent, **not stamped**; replay idempotent |
| `anon` EXECUTE narrowed after Part C | V2b | `record_visible_for` / `user_visible` / `current_profile` **false** for anon; `record_visible` deliberately **true**; `authenticated` + `service_role` true on all four |
| Part C did not break the anon surface | V14 | comments **0 rows, no error**; mentions **0 rows** — the SECURITY DEFINER inner call runs as the owner, as designed |
| Unit tests | `npm test` | **644 pass, 0 fail** (was 641) |

**Two defects were found by running the gate rather than by reading it** — both after Part B was
already applied — and both are recorded because each would have passed a review:

1. **V2 expected `anon_exec = false` and got `true`** on all four helpers — the default-privileges
   re-grant described in A8 above. `revoke ... from public` looked like it had worked. Closed by
   Part C, applied 2026-08-28; V2b and V14 confirm both the narrowing and that it cost nothing.
2. **V10–V12 resolved the test user's uuid AFTER `set local role authenticated`**, so
   `own_profile_select` hid the row, `sub` was NULL, and the whole block measured a session that was
   nobody. **It returned `uid null / 0 / 0`, which is indistinguishable from a correctly-scoped rep
   with no seeded comments** — a false green. Fixed by setting the claims before the role switch;
   the file now says to assert `uid` is non-null before believing any count beside it.

### Phase 2 — Shadow
sundial-core: `sf-query` wired to `lib/access` behind `ACCESS_MODEL_MODE=shadow`; module gate,
users filter, picklist filter all computed-but-not-served; structured shadow logs.
**Gate:** ≥ 3 business days of shadow logs with zero `onlyInNew` for Dennis; report reconciled for every
other user; Technician/unknown-level users identified and re-leveled.

### Phase 3 — Enforce reads, retire TEMP
sundial-core: `enforce` (step 7.3), then TEMP removal (7.4) as two separate deploys. `/sf/users`,
`/sf/user`, module deny, counts, picklist meta.
harmon-crm: nav/module hiding and global-search legs from `user.access.modules` (safe to ship any time
after Phase 1's `/auth/me`).
**Gate:** shadow report zero-diff after enforce; access matrix (§9) passes for all test users on every
read path; Dennis's twin test user's visible counts equal Dennis's; Sales list for the twin is one
request.

### Phase 4 — Field manifest, writes, client cutover
sundial-core: sheets moved + role columns added (you supply the values); `generate-field-configs.mjs`;
manifest loader; `?full=true` projection + `access.editable`; `projectRow` on lists; `sf-update` row +
field + protected-field + stamping rules; Create Project copies rep/dealer.
harmon-crm: consume `access.editable`; section auto-hide; **delete `temp-role-tab-visibility.ts`**;
`NewCustomerModal` drops the rep dropdown for sales roles; harmon-crm generators + sheet copies deleted;
CI manifest-version check.
**Gate:** generator refuses a sheet with an `edit` on a protected/formula field (test); for the test
rep: every hidden field absent from `?full=true` (scripted assertion against the manifest); PATCH of a
hidden field → 403 and logged; PATCH of a `read` field → 403; PATCH of an `edit` field → 200; PATCH of
a record outside scope → 404; create stamps rep/dealer regardless of body. Dennis's before/after
`?full=true` field set diff reviewed by you.

### Phase 5 — Actions and files
sundial-core: `canAction` in budget, acumatica-push, aurora-push, list-files, list-related-files,
upload-file, delete-file, copy-to-solar; `assertVisibleRecord` in the customer-file paths.
harmon-crm: buttons from `user.access.actions`.
**Gate:** matrix: every action × every test user returns the §3.6 table; solar files 403 on all four
routes for sales roles; customer file upload on another rep's record → 404.

### Phase 6 — Supabase RLS (what is left of it)
**Reduced by A4 and A5.** The cache-table `revoke` shipped in Phase 1; the comments/mentions policies
and their definer helpers shipped in Phase 1b. What remains here:
sundial-core `sql/sundial_access_rls.sql`: **drop** the six accidental cache-table SELECT policies —
the revoke already makes them inert, so this removes a misleading artefact rather than a control —
together with `public.portal_users`, plus the `profiles` policy review. Applied by you in the
dashboard (as D-056 was), committed here.
harmon-crm: none required; `useActiveUsers` switches to `/sf/users` if it reads a table directly.
**Gate:** select from any `sundial_*_cache` as an authenticated session → denied; Realtime event on a
record after reassignment not delivered to the old rep; the Phase 1b comment gates re-run green.

### Phase 7 — Cleanup and docs
`profiles.role` dropped from the upsert; `Hierarchy_Level__c` marked deprecated in `salesforce-schema.md`
(kept, derived, unread); `Roles__c` marked unused; `Access_Level__c`/`Super_Admin__c`/`Dealer__c`
documented; `api-endpoints.md` gains `/sf/users`, `/sf/meta/*`, `POST /sf/{object}`, `?q=`, `?full=`
and the `access` block; `caching-architecture.md` corrected (`client_sf_id`, flat 10-minute TTL, new
columns); CLAUDE.md test-user rule (§9) in both repos; harmon-crm CLAUDE.md re-synced.

---

## 9. Test fixtures — extend the ZZ PORTAL TEST rule to users

Added to CLAUDE.md in both repos under the existing "never test on live records" rule:

> **Access-model testing uses the designated test users and test dealers — never a live user.**
> Never log in as, re-level, or reassign records of a real user to test visibility.

| Fixture | Value |
|---|---|
| Dealers | `ZZ TEST DEALER A` (active), `ZZ TEST DEALER B` (active), `ZZ TEST DEALER INACTIVE` |
| Users (Supabase auth + `Sundial_User__c`, `Active__c` true, password in Secrets Manager `sundial/test-users`) | `zz-rep-a1@` (Sales Rep, Dealer A) · `zz-rep-a2@` (Sales Rep, Dealer A) · `zz-mgr-a@` (Sales Dealer, Dealer A) · `zz-rep-b1@` (Sales Rep, Dealer B) · `zz-rep-harmon@` (Sales Rep, Harmon Solar — Dennis's twin) · `zz-rep-nodealer@` (Sales Rep, `Dealer__c` null — must see nothing) · `zz-rep-inactive-dealer@` · `zz-tech@` (Technician) · `zz-admin@` (Admin) · `zz-exec@` (Executive) |
| Records | existing `ZZ PORTAL TEST — DO NOT USE` (`a1P7y00000AmyXCEAZ`) → `Sales_Rep__c = zz-rep-a1`, Dealer A · new `ZZ PORTAL TEST 2` → `zz-rep-a2` · `ZZ PORTAL TEST B` → `zz-rep-b1` · `ZZ PORTAL TEST HARMON` → `zz-rep-harmon` · one Solar twin per customer (created through Create Project so A5's copy path is exercised; note the recalc trigger fires on Solar writes) · one `ZZ PORTAL TEST ROOFING` |
| Script | `scripts/verify-access-matrix.mjs` — logs in as each user, hits every row in §6, asserts status code and (for reads) the exact id set and field set. Runs in each phase gate and in `verify-provisioning-e2e`. Seeding is idempotent (`--apply`), like the existing test-record script. |

Expected-outcome matrix (excerpt; the script carries the full table):

| user → surface | own record | same-dealer record | other-dealer record | roofing list | `/sf/users` contains |
|---|---|---|---|---|---|
| `zz-rep-a1` | 200 | 404 | 404 | 403 | a1, a2, mgr-a, admin, exec; **not** b1 |
| `zz-mgr-a` | 200 | 200 | 404 | 403 | same as above |
| `zz-rep-nodealer` | 404 | 404 | 404 | 403 | 403 |
| `zz-tech` | 404 | 404 | 404 | 403 | 403 |
| `zz-admin` | 200 | 200 | 200 | 200 | everyone |

---

## 10. Fate of the legacy fields

| Field | After Phase 7 |
|---|---|
| `Hierarchy_Level__c` | Kept (required field). Written by `user-admin` as a derived value. Read by nothing. Documented as deprecated. |
| `Parent_User__c` | Kept, unread. Candidate for removal with the next SF schema cleanup. |
| `Roles__c` | Kept, unread, documented as unused. If it is ever needed for cross-department module access (Dispatcher, PM), that is a new decision — the module gate in §3.1 is the hook. |
| `Sunbase_Sales_Rep__c`, `Sales_Representative__c` (text) | Kept for history and display. Not filtered on. The Create Project copy continues to fill `Sales_Representative__c` for display. |
| `Sales_Company__c`, `Sales_Company_Harmon_Solar_or_Third__c` | Unchanged — still the commission/PO discriminator (D19). `Dealer__c` is derived from them once, then maintained by the server. If a future rule wants them to agree, add it to the reconcile report. |
| `profiles.role` | Dropped from the upsert; column removed after policies no longer reference it. |

---

## 11. ADR — D-064: Sales-rep and dealer access model (row + field security in the Lambda layer and RLS)

**Date:** 2026-08-26 · **Status:** Accepted, **amended 2026-08-27 (A1–A6)** · **Supersedes:**
enforcement scope of D-043; TEMP restrict (TASKS "Sales Rep visibility", shipped 2026-08-03);
harmon-crm D-048 · **Refines:** D-015 (dealer modeled as an object, not a `Parent_User__c` tree),
D-035 (rowFilter composes like tenant scope), D-056 (scope materialized into server-owned `profiles`
columns; no client update grant).

> The canonical ADR is D-064 in `DECISIONS.md`, including its "Amended 2026-08-27" block. This section
> is that text. Decision 2 below now reads with A1: the deal's dealer is **derived from its rep**, and
> the sales-company picklists are the commission discriminator only.

**Context.** One Salesforce integration user serves every portal session, so Salesforce sharing is
inert per user. The only server-side access control is tenant scope plus a TEMP guard that name-matches
one hardcoded rep on two objects, bypasses the cache, keys on a field D-043 reserved for something
else, and defaults open. Manage Users stamps that key on every new user. Field visibility is a
client-side rail-id list that has leaked twice. Harmon is onboarding outside dealers, each with reps
and a manager.

**Decision.**
1. Role comes from `Access_Level__c` alone and resolves to a scope: tenant / dealer / own / none;
   unknown is `none`.
2. Dealers are `Sundial_Dealer__c` rows; users and deals carry `Dealer__c`; reps are `Sales_Rep__c`.
   The server stamps and maintains both on deals; sales roles can never write them. **A1: a deal's
   `Dealer__c` is derived from `Sales_Rep__r.Dealer__c`** on create and re-stamped on every rep change;
   the sales-company picklists are the commission discriminator only and are never an ownership source.
3. `lib/access.js` is the single authority; every read/write/action Lambda calls it. Row filters are
   id equalities on cached, indexed columns and are applied before any caller filter.
4. Field visibility is a per-role column in the field-design workbooks, generated into a server
   manifest and the client layout by one script in sundial-core; the server selects only visible
   fields and returns the editable set; the client renders what it is given.
5. Roofing, Service, Commercial, PO and all action endpoints are denied to sales roles. Customer
   files are read/upload only on visible records; Solar files are denied.
6. Browser-direct tables get RLS built on `security definer` helpers over server-owned scope columns
   on `profiles` and the rep/dealer columns on the cache tables; cache tables are RLS-denied to clients.
7. Cutover runs shadow → enforce-with-overlap → remove, gated by a scripted per-user diff that must
   show no widening for the live rep.

**Consequences.** Two new SF fields per deal object, one new object, five cache columns, a backfill,
a manifest loader that fails cold start on a bad manifest, cross-repo generation with a version check,
`Hierarchy_Level__c`/`Roles__c`/`Parent_User__c` retired from code. Deals with a blank sales company
remain invisible to dealers until attributed — by design. The client keeps no authorization tables.
Adding a role is a sheet column plus one row in the scope table.

**Alternatives rejected.** `Parent_User__c` tree walk (D-015) · name-string filtering (the current
jank) · Salesforce sharing (inert under one integration user) · client-side field hiding (the current
jank) · a `record_access` join table maintained by sync (more state to keep consistent than two
columns; revisit if per-record sharing overrides are ever needed).

---

## 12. Open items for Tim

Resolved 2026-08-26:
1. Sheet columns `Sales Rep` / `Sales Dealer` — Tim is adding them to both config sheets in
   `harmon-crm/docs` (they move to `sundial-core/docs` in Phase 4).
2. Actions: Create Project, budget recalc/push/attributes-sync, and Acumatica sync are hidden from and
   denied to sales roles. **Aurora Design Request is allowed** for sales roles on records they can see.
3. `Technician` → `none` until Phase II — signed off.
4. Active dealers at launch: **Harmon Solar** (Dennis Alessandro, sole rep), **Heavenly Power**,
   **Property Upgrades LLC** — picklist strings exactly as written. All other values get inactive
   rows. *[Corrected by §2.4a(4): "Harmon Solar" is a value on Solar's picklist only — it does not
   exist on Customer `Dealer_Name__c` at all. The `Sundial_Dealer__c` row is created regardless; after
   A1 the row's `Name` is a label, not a join key, so the picklist it came from stops mattering.]*
5. Sheets done (2026-08-26, in `harmon-crm/docs`): Customer — Sales Rep 158 edit / 89 read / 83 hidden,
   Sales Dealer 158 / 93 / 79; Solar — Sales Rep 116 read / 357 hidden, Sales Dealer 119 / 354, zero
   edit (read-only Solar, as specified). Customer `edit` rows are confined to the sale-time sections
   (Proposal & Design Inputs, Property & Site, Utility, Contact, Design Request, Appointment, Lead &
   Source, Marketing); no protected or formula field is marked `edit`.
