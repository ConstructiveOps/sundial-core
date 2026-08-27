# Access model — Phase 0 user audit

**Generated:** 2026-08-27 by `node scripts/audit-user-levels.mjs --markdown` (read-only).
**Tenant:** `a1W7y000007AszBEAS` (harmon) · **Scope:** active users only · **24 user(s)**

Companion to [`access-model.md`](access-model.md) §8 Phase 0. This report changes
nothing — re-levelling a user changes what they can see, which is a per-user decision,
not a side effect of an audit.

## Why this exists

`sundial-user-admin` stamped `Hierarchy_Level__c = "Sales Rep"` on **every** user it
created, regardless of the access level chosen in Manage Users. The TEMP guard in
`sundial-sf-query` keys on exactly that value. So any user created through Manage Users
and not hand-corrected in Salesforce afterwards has been served a Sales Rep's restricted
view of Customer and Solar — a **narrowing**, not a widening, which is why it presented
as "why can't this person see anything" rather than as a security incident.

## Summary

| Finding | Count |
|---|---:|
| Users **wrongly restricted today** (hierarchy `Sales Rep`, access level is not) | **1** |
| Users whose stored hierarchy differs from the derived value (cosmetic — nothing reads it) | 13 |
| Users restricted **today** by the TEMP guard (`Hierarchy_Level__c = "Sales Rep"`) | **3** |
| Users with no `Access_Level__c` at all (→ scope `none` after Phase 3) | **0** |
| Super admins | 10 |
| Super admins holding a **sales** access level (the combination §1.2 says must not exist) | **0** |

## Every user

`derived` is what `user-admin` will write going forward. `scope` is what §1.2 resolves
the access level to once `lib/access.js` exists.

| User | Access_Level__c | Hierarchy_Level__c | derived | future scope | flags |
|---|---|---|---|---|---|
| Dennis Alessandro <br><sub>azsolarexpert@live.com</sub> | Sales Rep | Sales Rep | Sales Rep | `own` | restricted today |
| David Coleman <br><sub>davidcoleman@harmonelectric.net</sub> | Manager | Manager | Client | `tenant` | derivation differs |
| John Heckert <br><sub>johnheckert@harmonelectric.net</sub> | Manager | Manager | Client | `tenant` | derivation differs |
| Troy Johnston <br><sub>troyjohnston@harmonelectric.net</sub> | Manager | Manager | Client | `tenant` | derivation differs |
| Dan King <br><sub>danking@harmonelectric.net</sub> | Executive | Client | Client | `tenant` | super admin |
| Julie King <br><sub>julieking@harmonelectric.net</sub> | Executive | Client | Client | `tenant` | super admin |
| Paige King <br><sub>paigeking@harmonelecetric.net</sub> | Executive | Client | Client | `tenant` | super admin |
| Ryan King <br><sub>ryanking@harmonelectric.net</sub> | Executive | Client | Client | `tenant` | super admin |
| Marjorie Kopp <br><sub>marjoriekopp@harmonelectric.net</sub> | Manager | Manager | Client | `tenant` | derivation differs |
| Jake Korslien <br><sub>jake@constructiveoperations.com</sub> | Executive | Client | Client | `tenant` |  |
| Cameron Labonte <br><sub>cameronlabonte@harmonelectric.net</sub> | Executive | Manager | Client | `tenant` | derivation differs |
| Geovanna Macedo <br><sub>geovannamacedo@harmonelectric.net</sub> | Manager | Manager | Client | `tenant` | derivation differs |
| Lindsay McCormack <br><sub>lindsaymccormack@harmonelectric.net</sub> | Executive | Manager | Client | `tenant` | derivation differs |
| Matt Murphy <br><sub>matt@constructiveoperations.com</sub> | Executive | Client | Client | `tenant` | super admin |
| Tim Murphy <br><sub>tim@constructiveoperations.com</sub> | Executive | Client | Client | `tenant` | super admin |
| Brian Nowak <br><sub>brian@constructiveoperations.com</sub> | Executive | Manager | Client | `tenant` | derivation differs, super admin |
| Temp Passtwo <br><sub>tmurphy5213+temppass1@gmail.com</sub> | Manager | Sales Rep | Client | `tenant` | **WRONGLY RESTRICTED**, derivation differs, restricted today |
| Daniel Reese <br><sub>danielreese@harmonelectric.net</sub> | Manager | Manager | Client | `tenant` | derivation differs |
| Ralph Romano <br><sub>ralphromano@harmonelectric.net</sub> | Executive | Manager | Client | `tenant` | derivation differs, super admin |
| Tim Test <br><sub>tim+test1@constructiveoperations.com</sub> | Executive | Client | Client | `tenant` | super admin |
| Invite Testone <br><sub>tmurphy5213+inviteuser1@gmail.com</sub> | Sales Rep | Sales Rep | Sales Rep | `own` | restricted today |
| Ben Wollschlager <br><sub>benwollschlager@harmonelectric.net</sub> | Admin | Manager | Client | `tenant` | derivation differs |
| Brad Yant <br><sub>bradleyyant@harmonelectric.net</sub> | Executive | Client | Client | `tenant` | super admin |
| Arnold Yazzie <br><sub>arnoldyazzie@harmonelectric.net</sub> | Manager | Manager | Client | `tenant` | derivation differs |

## The distinction that matters

Two different things look like "the fields disagree", and only one of them has any
effect on what a user can see:

**Wrongly restricted (1)** — `Hierarchy_Level__c = "Sales Rep"` while
`Access_Level__c` is something else. The TEMP guard keys on that exact value, so these
users are being served **Dennis's records** on Customer and Solar right now, whatever
their real role. This is the user-admin default bug actually biting someone.

| User | Access_Level__c | stored hierarchy | sees today |
|---|---|---|---|
| Temp Passtwo | Manager | `Sales Rep` | Dennis's records only |

**Derivation differs (13)** — cosmetic. The stored value is not what the new
derivation would write, but nothing reads `Hierarchy_Level__c` except the TEMP guard and
the guard only cares about one value. A `Manager` stored as `Manager` differs from the
derived `Client` and is entirely harmless. **No existing record is changed by this work** —
the derivation applies to creates and to `accessLevel` PATCHes from here on.

Note the direction of that: PATCHing `accessLevel` on one of these users will rewrite
their hierarchy from `Manager` to `Client`, because "anything not a sales role" collapses
to `Client`. Harmless for the same reason, but it is a real write and worth knowing about.

