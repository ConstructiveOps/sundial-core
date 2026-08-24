# Commission PO — Salesforce field gap list (§4f)

> **✅ APPROVED AS PROPOSED, 2026-08-24. Built.** The package is
> [`salesforce/v4-commission-po-fields/`](../../salesforce/v4-commission-po-fields/) —
> generator, `.object`, `package.xml` and a deploy README. All eight fields exactly as
> listed below, unrenamed.
>
> **Still to do:** deploy it, then grant the integration user **Read + Edit on all eight**
> (see the README — that FLS is the one that costs money if it is missed).

**Verified absent by live describe, 2026-08-22, re-verified 2026-08-24** against 490 fields
on `Sundial_Solar__c` — no collisions. Re-check any time with
`node scripts/probe-commission-po-fields.mjs`.

The nearest existing things are `Bill_Out_in_Acumatica_Requested__c` / `_2__c` ("M1/M2 Bill
Out in Acumatica Requested", both Date) — Harmon's manual *request* markers on the **AR**
side, **not** the AP purchase order this engine raises. **Confirmed unrelated 2026-08-24**;
the eight new fields sit beside them deliberately.

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

## The other blocker — Q13 — ✅ RESOLVED 2026-08-24 (D23)

It dissolved rather than being answered as asked. ~~§6 says M1 fires **at Site Audit
Complete** and M2 **at Glass on Roof**, and neither exists under that name.~~ There are no
triggers to identify, because **both POs are raised on the first budget push** and updated
by later pushes until Acumatica freezes them — which is how `planMilestone()` already
worked.

What the two fields actually decide is which date each PO **carries**:

| Milestone | Field | Type | Also feeds |
|---|---|---|---|
| M1 | `Audit_Date_and_DateTime__c` | Date (despite the name) | the `AUDITDATE` attribute |
| M2 | `Scheduled_Install_Date__c` | Date | the `INCOMDATE` attribute |

Reusing the attribute sources is the point: the PO and the attribute sync cannot end up
disagreeing about when the same milestone happened. They land on the PO line's `Requested`
and `Promised`; a blank date sends nothing and Acumatica defaults to the order date, which
is the ordinary case on a first push. `Days_to_Glass_on_Roof__c` never had to be read.

---

## What is left

1. ~~Approve the list.~~ ✅ 2026-08-24, unchanged.
2. ~~Build the additive package.~~ ✅ `salesforce/v4-commission-po-fields/`.
3. **Deploy it** — Check Only first, expect 8/8.
4. **FLS: the integration user needs Read + Edit on all eight.** Without Edit on
   `Commission_PO_M1_Number__c` the engine raises a real PO and loses its number, and the
   next push raises a second one.
5. ~~Answer Q13.~~ ✅ D23.
6. Re-run [`acumatica-commission-po-runbook.md`](acumatica-commission-po-runbook.md) steps
   7 and 8 — the 2026-08-24 run did not settle either.
7. Open `PO_GATE` in a reviewed commit, same discipline as D20's `CREATE_GATE`.
8. Layout: the eight render read-only at the bottom of the Budget tab. **harmon-crm sheet
   edit, after the deploy — not this repo.**
