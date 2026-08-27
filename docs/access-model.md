# Sundial Access Model — sales reps and dealers

**Status:** DESIGN (2026-08-26). Nothing in this document is built. Companion ADR: D-064 (§11, to be
appended to `DECISIONS.md` when the first phase lands). Supersedes the enforcement sections of D-043
and retires the TEMP restrict (`sundial-sf-query` "TEMP — Sales Rep hard-restrict", 2026-08-03) and the
cosmetic tab hiding (harmon-crm D-048).

**Why this document exists.** Every portal user reaches Salesforce through one integration user, so
Salesforce profiles, roles, and sharing rules can do nothing per user. Row-level and field-level
security must be decided in the Lambda layer from the verified Supabase JWT, and re-derived in
Supabase RLS for the tables the browser touches directly. This document is the single description of
how that decision is made, where it is enforced, and how each surface behaves for each role.

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
| `Sales_Company_Value__c` | Text(255), unique per tenant | The exact `Sales_Company_Harmon_Solar_or_Third__c` picklist value this dealer corresponds to. Join key for backfill and for the commission-PO vendor map (`docs/integrations/dealer-vendor-map.csv`). |
| `Is_Internal__c` | Checkbox | True for Harmon Solar. Informational; grants nothing. |
| `Active__c` | Checkbox | Inactive dealer → its users resolve to scope `none`. |

One row per value in `Sales_Company_Harmon_Solar_or_Third__c` that has ever appeared on a record (~55),
`Active__c = true` only for the several dealers who get portal access plus Harmon Solar. Creating the
rows is a one-time script; new dealers are added by a super admin (Manage Users grows a Dealers tab in
a later phase; until then, Salesforce UI).

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

A rep belongs to exactly one dealer (one `Sundial_User__c` per dealer if a person sells for two). A
deal's dealer is therefore normally `Sales_Rep__r.Dealer__c`; the explicit `Dealer__c` on the deal
exists for the cases where that derivation fails — no rep yet (Aurora dealer-originated deals, D-049,
arrive with a dealer name and no rep), or a rep record that was later deleted — and so the cache can
carry one indexed column rather than a join.

### 2.3 Invariants the server maintains

1. **Create** (`POST /sf/customer` by a sales-role user): `Sales_Rep__c` and `Dealer__c` are
   force-stamped from `AccessContext` — the body's values are ignored and logged if present, exactly
   like `Client__c` today (harmon-crm D-047). A `Sales Dealer` may name any *active user in their own
   dealer* as `Sales_Rep__c`; default self.
2. **Reassignment** (`PATCH … Sales_Rep__c`): allowed for `tenant` scope only. The server re-stamps
   `Dealer__c := new rep's Dealer__c` in the same PATCH. Sharing follows the record immediately: the
   old rep's next read 404s (their cache filter no longer matches once the write-through stale-flag
   and re-read land — the existing D-035 write path).
3. **Departure**: super admin deactivates the user (`Active__c=false` + Supabase ban, D-044). The
   records keep `Sales_Rep__c` pointing at the inactive user, and `Dealer__c` is unchanged, so the
   dealer's manager still sees them. A person joining another dealer gets a new user; the old deals
   do not follow.
4. **Create Project** (Customer → Solar) copies `Sales_Rep__c` and `Dealer__c` server-side, closing
   punchlist A5 by construction (`Sales_Representative__c` text is no longer what visibility keys on).
5. `Dealer__c` never disagrees with `Sales_Rep__r.Dealer__c` when a rep is set. A nightly check in
   `sundial-cache-sync` reconcile mode reports disagreements; it does not silently fix them.

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

So `Sales_Company_Value__c` cannot be *one* unique string per dealer. `Sundial_Dealer__c` needs either
two value columns (one per object) or a child alias table, and the backfill needs the normalize-and-
match step the vendor map already uses. **This is a Phase 1 design change, not a Phase 0 fix** — it is
recorded here and nothing is built on it yet.

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

- **Dealers:** one `Sundial_Dealer__c` per distinct value of the dealer picklists: **Customer
  `Dealer_Name__c`** and **Solar `Sales_Company_Harmon_Solar_or_Third__c`** (Tim, 2026-08-26: these
  two carry the dealer; ~~the values are identical across objects~~ **[CORRECTED by 2.4a: 110 vs 56 values, only 36 exact matches, and "Harmon Solar" is absent from Customer]**, e.g. "Heavenly Power",
  "Property Upgrades LLC"; Phase 0 confirms the Solar API name by describe). Customer `Sales_Company__c`
  (2 values) is the internal/external discriminator, not a dealer list. "Harmon Solar" → `Is_Internal__c`.
- **Deal `Dealer__c`:** from the record's sales-company value via `Sales_Company_Value__c`. Blank
  sales company (83% of Solar, CLAUDE.md:441) → **left null**, never defaulted to Harmon. A null
  `Dealer__c` is invisible to every sales role and visible to tenant scope — fail closed, and the
  same "blank ⇒ NULL, never the default" rule D19 already applies to commissions.
- **Deal `Sales_Rep__c`:** where null, resolved from the legacy name text — `Sunbase_Sales_Rep__c`
  (Customer) and `Sales_Representative__c` (Solar) — by exact, trimmed, case-insensitive match against
  active-or-inactive `Sundial_User__c` first+last name **within the tenant**. Ambiguous or
  unmatched names are written to a report, not guessed. *~~Phase 0 must confirm `Sales_Representative__c`'s
  actual type by describe~~ **[ANSWERED in 2.4a: it is a PICKLIST, neither guess. Not a lookup, so name-resolution is the only route; the sheet's REFERENCE label is wrong.]** — the solar sheet says REFERENCE, `sf-query/test.js` treats it as a string.*
- **Users:** `Dealer__c` set by hand for the handful of existing users (Dennis → Harmon Solar; staff
  → Harmon Solar or null, irrelevant at tenant scope).
- **Dennis specifically:** the gate for the whole migration (§7) is that the set
  `{Customer where Sales_Rep__c = Dennis}` ∪ `{Solar where Sales_Rep__c = Dennis}` after backfill
  equals the set the TEMP name-match returns today. Any record in the old set and not the new one is a
  backfill defect to fix before cutover, not a tolerance.

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

The cache tables are populated by service-role Lambdas only. Phase 0 verifies whether PostgREST
exposes them to `authenticated`; if it does, RLS is enabled with **no policies** (deny) plus `revoke`,
the `private.app_config` pattern (D-056 amendment). That is the answer to "what stops a crafted direct
query": nothing reads the cache from the browser, and after Phase 6 nothing can.

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
  when 'tenant' then exists(select 1 from <cache> c where c.sf_id = p_id and c.client_sf_id = p.tenant_id)
  when 'dealer' then exists(… and c.dealer_sf_id = p.dealer_sf_id)
  when 'own'    then exists(… and c.sales_rep_sf_id = p.sundial_user_id)
  else false end
```

`p_object` is mapped to a table through a fixed `case`; `roofing`/`po`/`user` return false for sales
scopes (module gate). A record absent from the cache is invisible to sales scopes (fail closed; the cache
is populated read-through, so the record's detail page — which a rep must have loaded to comment — has
already put it there).

### 5.3 Policies

```sql
-- comments
select : tenant_id = current tenant AND record_visible(record_object, record_id)
insert : tenant_id = current tenant AND author_id = auth.uid() AND record_visible(record_object, record_id)
delete : author_id = auth.uid()
update : none
-- comment_mentions
select : mentioned_user_id = auth.uid()           -- feed
       OR (author is me)                          -- own outgoing, if the UI needs it
insert : created by me on a comment I can see
       AND user_visible(mentioned_user_id)
       AND record_visible_for(mentioned_user_id, record_object, record_id)
update : mentioned_user_id = auth.uid() (read/ack columns only — separate table if it grows)
```

Reps read Harmon staff comments on their own deals (shared thread, per your answer); they cannot mention
a user they cannot see, and nobody can mention a user onto a record that user cannot see, so the
notify email never carries data past its scope. `user_preferences` is unchanged (already per-user).

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
sundial-core:
- SF package `salesforce/v6-access-model/`: `Sundial_Dealer__c`, `Dealer__c` lookups (User, Customer,
  Solar, Roofing, Commercial), permission set entries for the integration user.
- `scripts/backfill-dealers.mjs`, `scripts/backfill-deal-ownership.mjs` (canary-first, report-only by
  default, `--apply`), `scripts/access-shadow-report.mjs` (report mode only, using the not-yet-wired
  `rowFilter`).
- `sql/sundial_access_cache_columns.sql`; full resync per object.
- `lib/access.js` with `resolveScope`, `rowFilter`, `canReadObject`, `canAction` + unit tests
  (every access level × every object × null-dealer × inactive-dealer, fail-closed cases asserted).
- `lib/identity.js` + `auth-proxy`: `access` block on `/auth/me`; `profiles` new columns (columns only,
  no policy change yet).
**Gate:** backfill report: Dennis's new set ⊇ old set on customer and solar with `onlyInOld = ∅`;
cache counts by `sales_rep_sf_id` match SOQL counts; unit tests green; `/auth/me` for each test user
returns the expected scope.

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

### Phase 6 — Supabase RLS
sundial-core `sql/sundial_access_rls.sql`: helper functions, comments/mentions policies, cache-table
RLS deny + revoke. Applied by you in the dashboard (as D-056 was), committed here.
harmon-crm: none required; `useActiveUsers` switches to `/sf/users` if it reads a table directly.
**Gate:** as each test user via supabase-js: read comments on visible record → rows; on invisible record
→ 0 rows; insert on invisible → `42501`; mention other-dealer rep → `42501`; mention Harmon staff → ok;
select from any `sundial_*_cache` → 0 rows / denied; Realtime event on a record after reassignment not
delivered to the old rep.

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

**Date:** 2026-08-26 · **Status:** Proposed · **Supersedes:** enforcement scope of D-043; TEMP restrict
(TASKS "Sales Rep visibility", shipped 2026-08-03); harmon-crm D-048 · **Refines:** D-015 (dealer
modeled as an object, not a `Parent_User__c` tree), D-035 (rowFilter composes like tenant scope),
D-056 (scope materialized into server-owned `profiles` columns; no client update grant).

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
   The server stamps and maintains both on deals; sales roles can never write them.
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
   **Property Upgrades LLC** — picklist strings exactly as written, on Customer `Dealer_Name__c` and
   Solar `Sales_Company_Harmon_Solar_or_Third__c`. All other values get inactive rows.
5. Sheets done (2026-08-26, in `harmon-crm/docs`): Customer — Sales Rep 158 edit / 89 read / 83 hidden,
   Sales Dealer 158 / 93 / 79; Solar — Sales Rep 116 read / 357 hidden, Sales Dealer 119 / 354, zero
   edit (read-only Solar, as specified). Customer `edit` rows are confined to the sale-time sections
   (Proposal & Design Inputs, Property & Site, Utility, Contact, Design Request, Appointment, Lead &
   Source, Marketing); no protected or formula field is marked `edit`.
