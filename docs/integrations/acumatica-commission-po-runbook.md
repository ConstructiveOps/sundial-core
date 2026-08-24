# Sandbox hand-proof — raising a commission purchase order (Stage D)

**Purpose:** prove by hand that a commission PO built from the minimal body comes back
matching the live specimen, that a re-push updates it rather than duplicating it, and
that the freeze rule behaves as §6 describes. Until this comes back clean,
`PO_GATE.enabled` stays `false` in `lambdas/sundial-acumatica-commission-po/index.js`.

**Specimen being reproduced:** PO **016102**, project **R261078**, vendor **02118**,
captured 2026-08-22. Everything below is judged against it.

> **This runbook creates a document that authorises a PAYMENT.** That is a different
> risk class from the referral budget line: a budget line is a number in a plan, a
> purchase order is an instruction to pay a real company. Step 2 is not a formality.

---

## Step 0 — before you start

This is the **third** of three blockers, and as of 2026-08-24 the **only one left**:

1. ✅ The §4f write-back fields — approved as proposed and packaged at
   `salesforce/v4-commission-po-fields/`. Still to deploy, with Read + Edit FLS.
2. ✅ Q13 — answered, and it dissolved rather than resolving: both POs are raised on the
   first budget push, so the two dates are cargo the PO carries, not triggers (D23).
3. ❌ This runbook. **First run 2026-08-24 — see [§Results](#results). Not clean.**

> **If you are re-running this, you only need steps 7 and 8.** Everything else passed.

---

## Setup — credentials

```powershell
$secret = aws secretsmanager get-secret-value `
  --secret-id sundial/acumatica/connected-app --region us-west-1 `
  --query SecretString --output text | ConvertFrom-Json

$BaseUrl = $secret.base_url.TrimEnd('/')
$ApiRoot = "$BaseUrl/entity/Default/25.200.001"
$Project = 'R261065'     # a sandbox project with an SLPC OUT task; substitute yours
$Vendor  = '01736'       # Blue Sky Solar — an ACTIVE vendor from the D4 map
$NoBom   = New-Object System.Text.UTF8Encoding($false)
```

> ⚠️ **`$BaseUrl` does not tell you which tenant this is.** Sandbox and production share
> it. Step 2 is the check.

---

## Step 1 — mint a token

```powershell
$tok = Invoke-RestMethod -Method Post -Uri "$BaseUrl/identity/connect/token" `
  -ContentType 'application/x-www-form-urlencoded' `
  -Body @{
    grant_type = 'password'; client_id = $secret.client_id; client_secret = $secret.client_secret
    username = $secret.username; password = $secret.password; scope = 'api'
  }
$H = @{ Authorization = "Bearer $($tok.access_token)"; Accept = 'application/json' }
"token length: $($tok.access_token.Length)"
```

---

## Step 2 — prove which tenant you are on

**Mandatory before the first write. Paste the output.** Sandbox is a refreshed copy of
live, so project and vendor IDs exist in both and a transcript cannot self-certify which
system it hit.

> **CORRECTED 2026-08-24.** This step used to call `GET $ApiRoot/Company`, which returns
> `Entity Company not found` — there is no `Company` entity in the `Default/25.200.001`
> endpoint, so the check could never have run. The replacement below is better anyway:
> Acumatica suffixes the ROPC `client_id` with the tenant the grant is scoped to, so the
> credential names its own tenant and cannot be wrong about it.

```powershell
"tenant    : $($secret.client_id.Split('@')[-1])"
"username  : $($secret.username)"
"base_url  : $($secret.base_url)"
```

**`BizRun Tenant` is the sandbox.** Anything else — **stop**, because everything after this
point creates a document that authorises a payment.

> **The secret is a POINTER, not a tenant.** `sundial/acumatica/connected-app` holds BizRun
> through the rework and gets repointed at **live** at the end of the release window. So
> "the sandbox secret" is not a thing you can rely on being true tomorrow, and this check
> is not a formality you can skip once you have seen it pass. See §1 of
> `acumatica-budget-rework-v2.md` (Q15).

---

## Step 3 — confirm the project has an SLPC OUT task

The PO's detail line points at `Project` + `ProjectTask`. If the task is missing the
create will either fail or — worse — succeed with an unallocated line.

```powershell
$f = [uri]::EscapeDataString("ProjectID eq '$Project'")
Invoke-RestMethod -Method Get -Uri "$ApiRoot/ProjectBudget?`$filter=$f" -Headers $H |
  Where-Object { $_.ProjectTaskID.value -eq 'SLPC OUT' } |
  Select-Object @{n='task';e={$_.ProjectTaskID.value}}, @{n='group';e={$_.AccountGroup.value}},
                @{n='inv';e={$_.InventoryID.value}},
                @{n='committed';e={$_.CommittedAmount.value}},
                @{n='budget';e={$_.OriginalBudgetedAmount.value}} | Format-List
```

**Record the committed and budgeted figures — you will compare them in step 6.**

---

## Step 4 — CREATE the M1 purchase order

Minimal body: only what we own. Account 5450, Subaccount 02, TaxCategory LABSERV,
Warehouse/Location MAIN, Terms 30D, Branch HARMON and LineType Non-Stock are **not sent** —
they are derived from the item and the vendor, and this step is partly a test of whether
Acumatica derives the same values the specimen shows.

```powershell
$createBody = @{
  VendorID    = @{ value = $Vendor }
  Description = @{ value = "Sales Commission M1 — $Project" }
  Details     = @(
    @{
      InventoryID     = @{ value = 'M1&M2COM' }
      OrderQty        = @{ value = 1 }
      UOM             = @{ value = 'EA' }
      UnitCost        = @{ value = 2500 }
      Project         = @{ value = $Project }
      ProjectTask     = @{ value = 'SLPC OUT' }
      LineDescription = @{ value = 'Outside Sales commissions' }
    }
  )
} | ConvertTo-Json -Depth 6

[System.IO.File]::WriteAllText("$env:TEMP\po-create.json", $createBody, $NoBom)
Get-Content "$env:TEMP\po-create.json"

$create = Invoke-WebRequest -Method Put -Uri "$ApiRoot/PurchaseOrder" `
  -Headers $H -ContentType 'application/json' -InFile "$env:TEMP\po-create.json" -UseBasicParsing
$create.StatusCode

$created = $create.Content | ConvertFrom-Json
$Nbr = $created.OrderNbr.value
"OrderNbr: $Nbr"
```

**No `id` in the body** — that is what makes it an insert.

**Expect:** `200` and an `OrderNbr`. **Record the number**; if the response has no
`OrderNbr`, say so — the engine treats that as an unverifiable create for the good reason
that a retry would raise a second PO.

Informative failures:

| Response | Means |
|---|---|
| `Inventory item M1&M2COM not found` | Wrong item id, or the ampersand was mangled in transit. |
| `Project task SLPC OUT not found` | Step 3 should have caught this. Check for the two-space spelling. |
| Anything about the vendor being on hold / inactive | Pick a different vendor from the map. |
| 405 / "not supported" | PUT-without-id does not insert on this entity. **Report before doing anything else** — the engine's create path is not implementable as written. |

---

## Step 5 — RE-READ and check every derived value

This is the substance of the proof. `verifyCommissionPo` in the engine checks exactly
this list, so anything that fails here would have failed at runtime too.

```powershell
$f2 = [uri]::EscapeDataString("OrderNbr eq '$Nbr'")
$po = Invoke-RestMethod -Method Get -Uri "$ApiRoot/PurchaseOrder?`$filter=$f2&`$expand=Details" -Headers $H

$po | Select-Object `
  @{n='id';e={$_.id}}, @{n='nbr';e={$_.OrderNbr.value}}, @{n='type';e={$_.Type.value}},
  @{n='status';e={$_.Status.value}}, @{n='branch';e={$_.Branch.value}},
  @{n='currency';e={$_.CurrencyID.value}}, @{n='terms';e={$_.Terms.value}},
  @{n='location';e={$_.Location.value}}, @{n='vendor';e={$_.VendorID.value}},
  @{n='desc';e={$_.Description.value}}, @{n='total';e={$_.OrderTotal.value}} | Format-List

$po.Details | Select-Object `
  @{n='lineId';e={$_.id}}, @{n='inv';e={$_.InventoryID.value}}, @{n='lineType';e={$_.LineType.value}},
  @{n='project';e={$_.Project.value}}, @{n='task';e={$_.ProjectTask.value}},
  @{n='qty';e={$_.OrderQty.value}}, @{n='uom';e={$_.UOM.value}},
  @{n='unit';e={$_.UnitCost.value}}, @{n='ext';e={$_.ExtendedCost.value}},
  @{n='acct';e={$_.Account.value}}, @{n='sub';e={$_.Subaccount.value}},
  @{n='tax';e={$_.TaxCategory.value}}, @{n='whse';e={$_.WarehouseID.value}} | Format-List

$LineId = $po.Details[0].id
"line guid: $LineId"
```

**Must match the specimen:**

| | Expected |
|---|---|
| header `Type` | `Normal` |
| header `Branch` / `CurrencyID` / `Location` | `HARMON` / `USD` / `MAIN` |
| header `Terms` | **whatever the vendor's terms are — record it, do not judge it.** The specimen's `30D` is vendor 02118's; vendor 01736 is `DOR`. Terms was removed from `SPECIMEN_DEFAULTS` on 2026-08-24 for exactly this reason. |
| header `Status` | `Open` (or `On Hold` — both are fine and still updatable) |
| line `Account` / `Subaccount` | **`5450` / `02`** |
| line `TaxCategory` | **`LABSERV`** |
| line `WarehouseID` / `LineType` / `UOM` | `MAIN` / `Non-Stock` / `EA` |
| line `OrderQty` | `1` |
| line `UnitCost` = `ExtendedCost` | `2500` |

> **If `Account` or `Subaccount` differ, do not open the gate.** The PO would post real
> cost to the wrong GL account — nothing downstream flags that, and it is tedious to
> unpick a month later. Report what came back; the fix is either the item's posting class
> in Acumatica or an amended `SPECIMEN_DEFAULTS`, and which one it is depends on why they
> differ.

---

## Step 6 — the committed-amount interaction

A PO creates a **committed** amount against the SLPC OUT budget line. The budget push
writes `OriginalBudgetedAmount`, so there is no write conflict by construction — but we
should know what it looks like before it surprises someone reading a project.

```powershell
$f = [uri]::EscapeDataString("ProjectID eq '$Project'")
Invoke-RestMethod -Method Get -Uri "$ApiRoot/ProjectBudget?`$filter=$f" -Headers $H |
  Where-Object { $_.ProjectTaskID.value -eq 'SLPC OUT' } |
  Select-Object @{n='task';e={$_.ProjectTaskID.value}}, @{n='inv';e={$_.InventoryID.value}},
                @{n='budgeted';e={$_.OriginalBudgetedAmount.value}},
                @{n='revised';e={$_.RevisedBudgetedAmount.value}},
                @{n='committed';e={$_.CommittedAmount.value}},
                @{n='commReceived';e={$_.CommittedReceivedAmount.value}},
                @{n='actual';e={$_.ActualAmount.value}} | Format-List
```

**Record all of it, and the delta from step 3.** Two things worth knowing:

- Which column moved by 2,500 (expected: `CommittedAmount`).
- Whether `OriginalBudgetedAmount` moved **at all** (expected: no). If it did, the PO and
  the budget push are writing the same column and the interaction is a genuine conflict
  rather than a coexistence — which changes the ordering rules between the two stages.

Not a pass/fail gate. It is the thing we would otherwise learn from a confused question
about a project three months from now.

---

## Step 7 — UPDATE by guid, and prove no duplicate

Re-push must update in place. If it duplicates, every recalculated commission raises
another payment.

```powershell
$updateBody = @{
  id      = $po.id
  Details = @( @{ id = $LineId; UnitCost = @{ value = 2400 }; OrderQty = @{ value = 1 } } )
} | ConvertTo-Json -Depth 6

[System.IO.File]::WriteAllText("$env:TEMP\po-update.json", $updateBody, $NoBom)
(Invoke-WebRequest -Method Put -Uri "$ApiRoot/PurchaseOrder" -Headers $H `
  -ContentType 'application/json' -InFile "$env:TEMP\po-update.json" -UseBasicParsing).StatusCode

# Re-read: same guid, new amount, and STILL ONE order for this project+task.
$po2 = Invoke-RestMethod -Method Get -Uri "$ApiRoot/PurchaseOrder?`$filter=$f2&`$expand=Details" -Headers $H
"guid unchanged : $($po2.id -eq $po.id)"
"unit cost      : $($po2.Details[0].UnitCost.value)   (expect 2400)"
"ext cost       : $($po2.Details[0].ExtendedCost.value)"

# CORRECTED 2026-08-24: scope by OUR description. Counting every PO for the vendor+project
# pair returned 28 on the first run — the sandbox is a refreshed copy of live, so the
# dealer's pre-existing orders on that project drown ours and the count proves nothing.
$wantDesc = $po.Description.value    # what Acumatica actually stored, em dash and all
$fv = [uri]::EscapeDataString("VendorID eq '$Vendor'")
$mine = Invoke-RestMethod -Method Get -Uri "$ApiRoot/PurchaseOrder?`$filter=$fv&`$expand=Details" -Headers $H |
  Where-Object { $_.Description.value -eq $wantDesc -and ($_.Details | Where-Object { $_.Project.value -eq $Project }) }
"POs matching our description: $(@($mine).Count)   (expect 1)"
$mine | ForEach-Object { "  $($_.OrderNbr.value)  $($_.Status.value)  $($_.OrderTotal.value)" }
```

> `$wantDesc` is read back off the PO rather than retyped. PowerShell 5.1 mangles the em
> dash in `Sales Commission M1 — R261065` on its way through a file, and Acumatica stores
> the mangled form — so a hand-typed comparison misses its own PO. The engine is not
> affected: it builds the body with `JSON.stringify` and UTF-8 `fetch`.

**Expect:** `200`, same guid, UnitCost 2400, ExtendedCost 2400, and **exactly one** PO
matching our description.

---

## Step 8 — the freeze rule

§6 says a released PO is frozen and the delta lands in M2. Confirm Acumatica agrees, so
the engine's refusal matches reality rather than only our reading of it.

In the Acumatica UI: open PO `$Nbr` and **Cancel** it (or Complete it, whichever the
sandbox lets you do without a receipt). Then:

> ⚠️ **THIS STEP IS WORTHLESS IF THE PO IS STILL `On Hold`.** That is what happened on the
> 2026-08-24 run: the UI step was skipped, the PUT returned 200 and the amount changed —
> which is the *correct* behaviour for an On Hold order, since `On Hold` is in
> `UPDATABLE_STATUSES`. The re-read below prints the status first for this reason. **If it
> does not say Completed / Closed / Cancelled, go back to the UI; do not send the PUT.**

```powershell
$po3 = Invoke-RestMethod -Method Get -Uri "$ApiRoot/PurchaseOrder?`$filter=$f2&`$expand=Details" -Headers $H
"status: $($po3.Status.value)"

$frozenBody = @{ id = $po3.id; Details = @( @{ id = $LineId; UnitCost = @{ value = 9999 } } ) } | ConvertTo-Json -Depth 6
[System.IO.File]::WriteAllText("$env:TEMP\po-frozen.json", $frozenBody, $NoBom)
try {
  $r = Invoke-WebRequest -Method Put -Uri "$ApiRoot/PurchaseOrder" -Headers $H `
    -ContentType 'application/json' -InFile "$env:TEMP\po-frozen.json" -UseBasicParsing
  "status code: $($r.StatusCode)  <- a 200 here means Acumatica ALLOWS it"
} catch { "rejected: $($_.Exception.Message)" }

# Whether it 200'd or not, the question is whether the AMOUNT actually changed.
$po4 = Invoke-RestMethod -Method Get -Uri "$ApiRoot/PurchaseOrder?`$filter=$f2&`$expand=Details" -Headers $H
"unit cost after: $($po4.Details[0].UnitCost.value)   (expect still 2400)"
```

**Either answer is useful.** If Acumatica rejects it, the engine's freeze rule agrees with
the system. If Acumatica *allows* it, the freeze rule is ours alone — still correct as a
business rule (§6), but it is the only thing preventing a silent edit to a released
document, and that is worth knowing rather than assuming.

---

## Step 9 — clean up

Cancel or delete the test PO in the Acumatica UI. Unlike a budget line, a stray purchase
order is a commitment sitting against a real project.

**This is not optional tidiness and it was not done on 2026-08-24 — PO `016442` is still
sitting at $9,999 against R261065.** Do it before the next run, and again after.

---

## What to paste back

```
Step 2  tenant       tenant: ____   username: ____           <- must say SANDBOX
Step 3  SLPC OUT     budgeted: ____   committed: ____
Step 4  create       status: ____   OrderNbr: ____   (error text if not 200)
Step 5  header       Type/Branch/Currency/Location: ____
Step 5  header       Terms: ____                              <- RECORD, do not judge (vendor-derived)
Step 5  status       ____                                     <- Open or On Hold
Step 5  line         Account: ____  Subaccount: ____  TaxCategory: ____   <- 5450 / 02 / LABSERV
Step 5  line         Warehouse: ____  LineType: ____  UOM: ____  Qty: ____
Step 5  line         UnitCost: ____  ExtendedCost: ____
Step 6  budget line  budgeted: ____  revised: ____  committed: ____  actual: ____
Step 6               did OriginalBudgetedAmount move?  ____   <- expect NO
Step 7  update       status: ____  guid unchanged: ____  unitCost: ____
Step 7  POs matching our description: ____                    <- expect 1
Step 8  status BEFORE the frozen PUT: ____                    <- must NOT be On Hold
Step 8  frozen       PUT result: ____  amount changed: ____
Step 9  cleaned up?  ____
```

---

## Then

Opening `PO_GATE` needs **all three** blockers cleared. As of 2026-08-24 two are:

1. ✅ §4f fields — approved and packaged (`salesforce/v4-commission-po-fields/`).
   **Deploy them, with Read + Edit FLS for the integration user.**
2. ✅ Q13 — answered (D23). Both POs are raised on the first budget push; the two dates
   are what each PO carries, not triggers.
3. ❌ **This runbook.** See §Results — steps 7 and 8 need re-running, and the Terms
   question needs a business answer rather than a re-run.

Then flip `PO_GATE.enabled` in a reviewed commit and update the
`PO_GATE ships CLOSED` test, exactly as D20's gate was opened.

**Watch on the first live job:** exactly one PO per milestone per project, ever. If a
project ever grows a second M1, close the gate before anything else — that is a duplicate
payment, not a reporting glitch.

## Results

**Run 2026-08-24 · project `R261065` · vendor `01736` (Blue Sky Solar) · PO `016442`.**

### Verdict: the write mechanic is proven. Two steps did not land, and there is cleanup outstanding.

| Step | | Outcome |
|---|---|---|
| 2 — tenant proof | ⚠️→✅ | **Not run — the command in the runbook does not work.** Settled out of band: BizRun is the sandbox and PO 016442 was confirmed in both UIs (Q15). |
| 3 — SLPC OUT exists | ✅ | Task present with budget lines. |
| 4 — create | ✅ | `200`, `OrderNbr 016442`. PUT-without-id inserts, as on the referral line. |
| 5 — derived values | ✅ | **Every one matched the specimen.** Account `5450` / Subaccount `02` / TaxCategory `LABSERV` / Warehouse `MAIN` / LineType `Non-Stock` / UOM `EA` / Qty 1, header `Normal` / `HARMON` / `USD` / `MAIN`, UnitCost = ExtendedCost = 2500. |
| 5 — Terms | ⚠️→✅ | Came back **`DOR`**, not the specimen's `30D`. Correct — Terms is per-vendor (Q16). Caught a real bug in the verifier; see below. |
| 6 — committed amounts | ✅ | `OriginalBudgetedAmount` did **not** move. No write conflict with the budget push. |
| 7 — update by guid | ✅ | `200`, same guid, UnitCost and ExtendedCost both 2400. |
| 7 — no duplicate | ❌ | **Uninterpretable as run.** Counted 28. See below. |
| 8 — freeze rule | ❌ | **Never tested.** The PO was `On Hold`, not frozen. See below. |
| 9 — clean up | ❌ | **Not done. PO 016442 is still open at $9,999.** See below. |

---

### ⚠️ Step 2 was broken — but the writes did land in the sandbox (Q15, resolved)

`GET $ApiRoot/Company` returns **`Entity Company not found`**: there is no `Company`
entity in the `Default/25.200.001` endpoint. The step could not have worked, which is why
nothing was pasted for it. That is a defect in this runbook, not in the run.

**The tenant check that does work** is the credential itself — Acumatica suffixes the ROPC
`client_id` with the tenant the grant is scoped to:

```powershell
"tenant   : $($secret.client_id.Split('@')[-1])"   # e.g. "BizRun Tenant"
```

Read on this run: **`BizRun Tenant`** / `Constructiveops`, base_url
`harmonelectric.acumatica.com`. **`BizRun Tenant` is the sandbox** (Tim, 2026-08-24 — the
original handoff fact), and PO **016442 was confirmed in both UIs** as a sandbox document.
So the run was safe; it just could not prove itself at the time.

**The contradiction was in the docs, not the world.** `acumatica-budget-push.md` called
BizRun the sandbox while §1 of `acumatica-budget-rework-v2.md` called the same secret
"(live-tenant)". Both were describing a **pointer** as if it were a tenant:
`sundial/acumatica/connected-app` holds BizRun through the rework and gets repointed at
live at the end of the release window. §1 now says so, and neither "the live secret" nor
"the sandbox secret" is a phrase that should appear anywhere.

**Which is why step 2 is not a formality you can skip once you have seen it pass.** The
answer changes.

---

### ❌ Step 7's duplicate count proves nothing — 28, and none of them isolated ours

```
POs for this vendor+project: 28   (expect 1)
```

The query counted **every** purchase order for vendor 01736 that touches project R261065.
The sandbox is a refreshed copy of live, so Blue Sky Solar's existing orders on that
project are in there too — the count never isolated the one we created, and 28 neither
proves nor disproves a duplicate.

The real evidence from step 7 is good: the guid was unchanged, the OrderNbr was unchanged,
and the amount moved. That is consistent with an in-place update. It is just not the same
claim as "no second PO was raised".

**The corrected check** scopes by our own description, which is exactly the M1/M2 label the
engine writes:

```powershell
$wantDesc = "Sales Commission M1 — $Project"
$mine = Invoke-RestMethod -Method Get -Uri "$ApiRoot/PurchaseOrder?`$filter=$fv&`$expand=Details" -Headers $H |
  Where-Object { $_.Description.value -eq $wantDesc -and ($_.Details | Where-Object { $_.Project.value -eq $Project }) }
"POs matching our description: $(@($mine).Count)   (expect 1)"
$mine | ForEach-Object { "  $($_.OrderNbr.value)  $($_.Status.value)  $($_.OrderTotal.value)" }
```

> Note the em dash: `Sales Commission M1 — R261065`. PowerShell 5.1 mangled it into
> `â€”` on the way to the file in this run and Acumatica stored the mangled form, so
> compare against what the PO actually holds rather than what you typed. **The engine does
> not have this problem** — `lib/acumatica.js` builds the body with `JSON.stringify` and
> UTF-8 `fetch`, never a PowerShell file round-trip. Worth knowing anyway, because it
> means a description typed in this runbook will not match one the engine writes.

---

### ❌ Step 8 never tested the freeze rule

The step requires cancelling or completing the PO in the Acumatica UI first. That was not
done — the transcript shows `status: On Hold` immediately before the frozen-PUT:

```
status: On Hold
status code: 200  <- a 200 here means Acumatica ALLOWS it
unit cost after: 9999.000000   (expect still 2400)
```

**`On Hold` is an UPDATABLE status by design** (`UPDATABLE_STATUSES`). A 200 and an amount
change are the *correct* behaviour for an On Hold order, and say nothing about
`Completed` / `Closed` / `Cancelled`. So the open question is exactly as open as it was:
**does Acumatica enforce the freeze, or is our refusal the only thing enforcing it?**

To actually run it: open PO `016442` in the Acumatica UI, **Cancel** it (or Complete it),
confirm the re-read reports a frozen status, and only then send the PUT. Either answer is
useful — see the step's own note.

---

### ✅ Terms came back `DOR`, not the specimen's `30D` — and that is correct (Q16, resolved)

The specimen (PO 016102, vendor 02118) has `Terms: 30D`; this PO (vendor 01736) has
`Terms: DOR`. **Harmon confirmed 2026-08-24: Terms derives from the vendor record, and
per-vendor is correct.** No Acumatica change needed.

The finding mattered because `SPECIMEN_DEFAULTS.header.Terms = "30D"` treated it as a
fixed derived value, so **`verifyCommissionPo` would have rejected a perfectly good Blue
Sky Solar PO** on the first live job — and reported it as a specimen mismatch, pointing
whoever investigated at entirely the wrong thing. The D4 map has 35 resolvable dealers and
they do not share payment terms.

**Fixed:** `Terms` is out of `SPECIMEN_DEFAULTS` and **nothing asserts it**. It is recorded
and returned instead (`RECORDED_HEADER_FIELDS`), so a genuinely odd value is still visible
without being fatal. The rule now drawn: a derived value is **asserted** when it is a
property of the document (Branch, CurrencyID, Location, Type, and the whole line-level set)
and **recorded** when it is a property of the vendor.

---

### ❌ Cleanup is outstanding — PO 016442 is live at $9,999

Verified still present 2026-08-24: **`016442`, On Hold, OrderTotal 9,999.00, one line on
project `R261065`, vendor 01736.** Step 9 was not run. A stray purchase order is a
commitment sitting against a real project — cancel or delete it in the Acumatica UI.

---

### What this does to the gate

`PO_GATE.enabled` stays **`false`**. Q15 and Q16 are both resolved, so **the only thing
left is re-running steps 7 and 8** (plus the tenant line from the corrected step 2, which
is now one command). Tim is doing those, along with the 016442 cleanup; the gate opens in a
reviewed commit once they come back clean.

---

### Raw transcript — 2026-08-24

PS C:\Users\TimMurphy\Projects\sundial-core> $f = [uri]::EscapeDataString("ProjectID eq '$Project'")
PS C:\Users\TimMurphy\Projects\sundial-core> Invoke-RestMethod -Method Get -Uri "$ApiRoot/ProjectBudget?`$filter=$f" -Headers $H |
>>   Where-Object { $_.ProjectTaskID.value -eq 'SLPC OUT' } |
>>   Select-Object @{n='task';e={$_.ProjectTaskID.value}}, @{n='group';e={$_.AccountGroup.value}},
>>                 @{n='inv';e={$_.InventoryID.value}},
>>                 @{n='committed';e={$_.CommittedAmount.value}},
>>                 @{n='budget';e={$_.OriginalBudgetedAmount.value}} | Format-List


task      : {APPT COM, BALANCE, BURDENEXR, BURDENEXR...}
group     : {LABOR, BILLING, LABOR, LABOR...}
inv       : {SALESCOMM, <N/A>, RESIDENTAL, SALESCOMM...}
committed :
budget    : {0.0000, 18621.6600, 732.0000, 344.8500...}



PS C:\Users\TimMurphy\Projects\sundial-core> $createBody = @{
>>   VendorID    = @{ value = $Vendor }
>>   Description = @{ value = "Sales Commission M1 — $Project" }
>>   Details     = @(
>>     @{
>>       InventoryID     = @{ value = 'M1&M2COM' }
>>       OrderQty        = @{ value = 1 }
>>       UOM             = @{ value = 'EA' }
>>       UnitCost        = @{ value = 2500 }
>>       Project         = @{ value = $Project }
>>       ProjectTask     = @{ value = 'SLPC OUT' }
>>       LineDescription = @{ value = 'Outside Sales commissions' }
>>     }
>>   )
>> } | ConvertTo-Json -Depth 6
PS C:\Users\TimMurphy\Projects\sundial-core> [System.IO.File]::WriteAllText("$env:TEMP\po-create.json", $createBody, $NoBom)
PS C:\Users\TimMurphy\Projects\sundial-core> Get-Content "$env:TEMP\po-create.json"
{
    "Description":  {
                        "value":  "Sales Commission M1 â€” R261065"
                    },
    "Details":  [
                    {
                        "ProjectTask":  {
                                            "value":  "SLPC OUT"
                                        },
                        "Project":  {
                                        "value":  "R261065"
                                    },
                        "InventoryID":  {
                                            "value":  "M1\u0026M2COM"
                                        },
                        "LineDescription":  {
                                                "value":  "Outside Sales commissions"
                                            },
                        "UOM":  {
                                    "value":  "EA"
                                },
                        "OrderQty":  {
                                         "value":  1
                                     },
                        "UnitCost":  {
                                         "value":  2500
                                     }
                    }
                ],
    "VendorID":  {
                     "value":  "01736"
                 }
}
PS C:\Users\TimMurphy\Projects\sundial-core> $create = Invoke-WebRequest -Method Put -Uri "$ApiRoot/PurchaseOrder" `
>>   -Headers $H -ContentType 'application/json' -InFile "$env:TEMP\po-create.json" -UseBasicParsing
PS C:\Users\TimMurphy\Projects\sundial-core> $create.StatusCode
200
PS C:\Users\TimMurphy\Projects\sundial-core> $created = $create.Content | ConvertFrom-Json
PS C:\Users\TimMurphy\Projects\sundial-core> $Nbr = $created.OrderNbr.value
PS C:\Users\TimMurphy\Projects\sundial-core> "OrderNbr: $Nbr"
OrderNbr: 016442
PS C:\Users\TimMurphy\Projects\sundial-core> $f2 = [uri]::EscapeDataString("OrderNbr eq '$Nbr'")
PS C:\Users\TimMurphy\Projects\sundial-core> $po = Invoke-RestMethod -Method Get -Uri "$ApiRoot/PurchaseOrder?`$filter=$f2&`$expand=Details" -Headers $H
PS C:\Users\TimMurphy\Projects\sundial-core> $po | Select-Object `
>>   @{n='id';e={$_.id}}, @{n='nbr';e={$_.OrderNbr.value}}, @{n='type';e={$_.Type.value}},
>>   @{n='status';e={$_.Status.value}}, @{n='branch';e={$_.Branch.value}},
>>   @{n='currency';e={$_.CurrencyID.value}}, @{n='terms';e={$_.Terms.value}},
>>   @{n='location';e={$_.Location.value}}, @{n='vendor';e={$_.VendorID.value}},
>>   @{n='desc';e={$_.Description.value}}, @{n='total';e={$_.OrderTotal.value}} | Format-List


id       : 82c2a477-939f-f111-bb13-026107e8d2d9
nbr      : 016442
type     : Normal
status   : On Hold
branch   : HARMON
currency : USD
terms    : DOR
location : MAIN
vendor   : 01736
desc     : Sales Commission M1 — R261065
total    : 2500.0000



PS C:\Users\TimMurphy\Projects\sundial-core> $po.Details | Select-Object `
>>   @{n='lineId';e={$_.id}}, @{n='inv';e={$_.InventoryID.value}}, @{n='lineType';e={$_.LineType.value}},
>>   @{n='project';e={$_.Project.value}}, @{n='task';e={$_.ProjectTask.value}},
>>   @{n='qty';e={$_.OrderQty.value}}, @{n='uom';e={$_.UOM.value}},
>>   @{n='unit';e={$_.UnitCost.value}}, @{n='ext';e={$_.ExtendedCost.value}},
>>   @{n='acct';e={$_.Account.value}}, @{n='sub';e={$_.Subaccount.value}},
>>   @{n='tax';e={$_.TaxCategory.value}}, @{n='whse';e={$_.WarehouseID.value}} | Format-List


lineId   : 89c2a477-939f-f111-bb13-026107e8d2d9
inv      : M1&M2COM
lineType : Non-Stock
project  : R261065
task     : SLPC OUT
qty      : 1.000000
uom      : EA
unit     : 2500.000000
ext      : 2500.0000
acct     : 5450
sub      : 02
tax      : LABSERV
whse     : MAIN



PS C:\Users\TimMurphy\Projects\sundial-core> $LineId = $po.Details[0].id
PS C:\Users\TimMurphy\Projects\sundial-core> "line guid: $LineId"
line guid: 89c2a477-939f-f111-bb13-026107e8d2d9
PS C:\Users\TimMurphy\Projects\sundial-core> $f = [uri]::EscapeDataString("ProjectID eq '$Project'")
PS C:\Users\TimMurphy\Projects\sundial-core> Invoke-RestMethod -Method Get -Uri "$ApiRoot/ProjectBudget?`$filter=$f" -Headers $H |
>>   Where-Object { $_.ProjectTaskID.value -eq 'SLPC OUT' } |
>>   Select-Object @{n='task';e={$_.ProjectTaskID.value}}, @{n='inv';e={$_.InventoryID.value}},
>>                 @{n='budgeted';e={$_.OriginalBudgetedAmount.value}},
>>                 @{n='revised';e={$_.RevisedBudgetedAmount.value}},
>>                 @{n='committed';e={$_.CommittedAmount.value}},
>>                 @{n='commReceived';e={$_.CommittedReceivedAmount.value}},
>>                 @{n='actual';e={$_.ActualAmount.value}} | Format-List


task         : {APPT COM, BALANCE, BURDENEXR, BURDENEXR...}
inv          : {SALESCOMM, <N/A>, RESIDENTAL, SALESCOMM...}
budgeted     : {0.0000, 18621.6600, 732.0000, 344.8500...}
revised      : {0.0000, 18621.6600, 732.0000, 344.8500...}
committed    :
commReceived :
actual       : {0.0000, 0.0000, 368.9000, 258.6400...}



PS C:\Users\TimMurphy\Projects\sundial-core> $updateBody = @{
>>   id      = $po.id
>>   Details = @( @{ id = $LineId; UnitCost = @{ value = 2400 }; OrderQty = @{ value = 1 } } )
>> } | ConvertTo-Json -Depth 6
PS C:\Users\TimMurphy\Projects\sundial-core> [System.IO.File]::WriteAllText("$env:TEMP\po-update.json", $updateBody, $NoBom)
PS C:\Users\TimMurphy\Projects\sundial-core> (Invoke-WebRequest -Method Put -Uri "$ApiRoot/PurchaseOrder" -Headers $H `
>>   -ContentType 'application/json' -InFile "$env:TEMP\po-update.json" -UseBasicParsing).StatusCode
200
PS C:\Users\TimMurphy\Projects\sundial-core> $po2 = Invoke-RestMethod -Method Get -Uri "$ApiRoot/PurchaseOrder?`$filter=$f2&`$expand=Details" -Headers $H
PS C:\Users\TimMurphy\Projects\sundial-core> "guid unchanged : $($po2.id -eq $po.id)"
guid unchanged : True
PS C:\Users\TimMurphy\Projects\sundial-core> "unit cost      : $($po2.Details[0].UnitCost.value)   (expect 2400)"
unit cost      : 2400.000000   (expect 2400)
PS C:\Users\TimMurphy\Projects\sundial-core> "ext cost       : $($po2.Details[0].ExtendedCost.value)"
ext cost       : 2400.0000
PS C:\Users\TimMurphy\Projects\sundial-core> $fv = [uri]::EscapeDataString("VendorID eq '$Vendor'")
PS C:\Users\TimMurphy\Projects\sundial-core> $mine = Invoke-RestMethod -Method Get -Uri "$ApiRoot/PurchaseOrder?`$filter=$fv&`$expand=Details" -Headers $H |
>>   Where-Object { $_.Details | Where-Object { $_.Project.value -eq $Project } }
PS C:\Users\TimMurphy\Projects\sundial-core> "POs for this vendor+project: $(@($mine).Count)   (expect 1)"
POs for this vendor+project: 28   (expect 1)
PS C:\Users\TimMurphy\Projects\sundial-core> $po3 = Invoke-RestMethod -Method Get -Uri "$ApiRoot/PurchaseOrder?`$filter=$f2&`$expand=Details" -Headers $H
PS C:\Users\TimMurphy\Projects\sundial-core> "status: $($po3.Status.value)"
status: On Hold
PS C:\Users\TimMurphy\Projects\sundial-core> $frozenBody = @{ id = $po3.id; Details = @( @{ id = $LineId; UnitCost = @{ value = 9999 } } ) } | ConvertTo-Json -Depth 6
PS C:\Users\TimMurphy\Projects\sundial-core> [System.IO.File]::WriteAllText("$env:TEMP\po-frozen.json", $frozenBody, $NoBom)
PS C:\Users\TimMurphy\Projects\sundial-core> try {
>>   $r = Invoke-WebRequest -Method Put -Uri "$ApiRoot/PurchaseOrder" -Headers $H `
>>     -ContentType 'application/json' -InFile "$env:TEMP\po-frozen.json" -UseBasicParsing
>>   "status code: $($r.StatusCode)  <- a 200 here means Acumatica ALLOWS it"
>> } catch { "rejected: $($_.Exception.Message)" }
status code: 200  <- a 200 here means Acumatica ALLOWS it
PS C:\Users\TimMurphy\Projects\sundial-core> $po4 = Invoke-RestMethod -Method Get -Uri "$ApiRoot/PurchaseOrder?`$filter=$f2&`$expand=Details" -Headers $H
PS C:\Users\TimMurphy\Projects\sundial-core> "unit cost after: $($po4.Details[0].UnitCost.value)   (expect still 2400)"
unit cost after: 9999.000000   (expect still 2400)