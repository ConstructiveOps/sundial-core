# Commission PO — Salesforce field gap list (§4f)

> **For review, not a package.** These fields do not exist on `Sundial_Solar__c`. I have
> not built the metadata for them, because naming Salesforce fields on Harmon's behalf is
> how an org ends up with two fields meaning the same thing. Approve, amend, or rename the
> list below and I will build the additive package.

**Verified absent by live describe, 2026-08-22.** A search of `Sundial_Solar__c` for
`%PO%`, `%Commission%` and `%Milestone%` returns 37 fields, none of which is a commission
PO tracker. The nearest existing things are `Bill_Out_in_Acumatica_Requested__c` /
`_2__c` ("M1/M2 Bill Out in Acumatica Requested", both Date) — those are Harmon's manual
*request* markers on the AR side and are **not** the same thing as the AP purchase order
this engine raises. Worth confirming that reading before we add more M1/M2 fields beside
them.

---

## Why the engine cannot run without these

`lambdas/sundial-acumatica-commission-po/` is built and tested, and is gated off
(`PO_GATE.enabled = false`). Two of the three reasons are here.

**Idempotency has no other answer.** "Have we already raised M1 for this job?" is decided
by a stored order number and nothing else. The alternative — searching Acumatica for a PO
whose description looks right — was considered and rejected: a description scan matches a
hand-typed PO, misses one somebody renamed, and in both cases the failure mode is Harmon
paying a dealer twice. So with nowhere to store the number, every push would create
another purchase order.

**The freeze rule needs somewhere to say what happened.** A released PO cannot be
changed (§6) and the difference belongs in M2. Without a status/error field that outcome
is a log line nobody reads.

---

## Proposed fields — 8, all on `Sundial_Solar__c`

| API name | Type | Purpose |
|---|---|---|
| `Commission_PO_M1_Number__c` | Text(20) | Acumatica `OrderNbr` for the M1 PO. **The idempotency key.** |
| `Commission_PO_M2_Number__c` | Text(20) | Same, for M2. |
| `Commission_PO_M1_Amount__c` | Currency(16,2) | What M1 was raised for. Lets a re-push detect a changed commission without re-reading Acumatica. |
| `Commission_PO_M2_Amount__c` | Currency(16,2) | Same, for M2. |
| `Commission_PO_M1_Created__c` | DateTime | When M1 was raised. |
| `Commission_PO_M2_Created__c` | DateTime | When M2 was raised. |
| `Commission_PO_Status__c` | Restricted picklist | `None` / `M1 Raised` / `Both Raised` / `Failed` / `Frozen` |
| `Commission_PO_Error__c` | LongTextArea(4000) | The refusal or failure message, cleared on success. |

### Notes on the choices

**Text(20), not Number, for the order numbers.** Acumatica order numbers are
zero-padded strings — the live specimen is `016102`. A Number field silently drops the
leading zero and the value stops matching anything in Acumatica. Same trap as the vendor
ids, which are `01926`-shaped for the same reason.

**Two number fields, not one with a milestone flag.** M1 and M2 are separate documents
with separate lifecycles: M1 can be Completed and frozen while M2 has not been raised at
all. One field would make "which PO is this?" a question, and the wrong answer updates
the wrong payment.

**`Commission_PO_Status__c` includes `Frozen`** because that is a real, expected resting
state and not an error: the M1 PO was released, the commission later changed, and the
delta is going to land in M2. Filing that under `Failed` would train people to ignore
failures.

**Amount fields are arguably redundant** — the amount is on the PO in Acumatica. They
earn their place by letting the portal show what was raised without an Acumatica round
trip, and by making "the commission changed since we raised M1" answerable from the
Salesforce record alone. Drop them if you would rather keep the object smaller; nothing
in the engine depends on them.

**No `Commission_PO_Vendor__c`.** The vendor is derivable from
`Sales_Company_Harmon_Solar_or_Third__c` through the D4 map at any time, and a stored
copy would go stale the moment the map changed. If Harmon wants the vendor visible on the
layout, a formula field is the right shape, not a stored one.

---

## The other blocker — Q13, the milestone triggers

Not a field-creation question; a "which existing field means this" question, and it needs
Tim rather than a describe.

§6 says M1 fires **at Site Audit Complete** and M2 **at Glass on Roof**. Neither exists
under that name:

| Milestone | Candidates found on the object | Note |
|---|---|---|
| Site Audit Complete | `Audit_Date_and_DateTime__c` (Date) · `Audit_Photos_Received__c` (Date) · `Audit_Scheduled_Date__c` (Date) | `Audit_Date_and_DateTime__c` is already the AUDITDATE attribute source, so it is the obvious candidate — but "audit happened" and "audit signed off" may be different moments in Harmon's process. |
| Glass on Roof | `Stanchion_Installation__c` (Date) · `Install_Complete__c` (Date) · `Scheduled_Install_Date__c` (Date) | **`Days_to_Glass_on_Roof__c` is a formula field on this object**, so something it references already represents glass-on-roof. Reading that formula's definition would settle it outright — it needs Metadata API access, which the integration user does not have. |

Picking one would be guessing about when a dealer gets paid, so I have not. **Fastest
path: open `Days_to_Glass_on_Roof__c` in Setup and read its formula** — whatever date it
subtracts from is the M2 trigger, and that is a thirty-second answer.

---

## Once these land

1. Deploy the additive package (I will build it from whatever this list becomes).
2. FLS: the integration user needs **Read + Edit** on all eight — it writes them.
3. Answer Q13 so the engine knows when to fire.
4. Run [`acumatica-commission-po-runbook.md`](acumatica-commission-po-runbook.md).
5. Open `PO_GATE` in a reviewed commit, same discipline as D20's `CREATE_GATE`.
