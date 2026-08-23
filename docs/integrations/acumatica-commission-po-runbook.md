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

This is the **third** of three blockers. The other two are not runbook steps and cannot be
worked around here:

1. The §4f write-back fields must exist — see
   [`commission-po-field-gap.md`](commission-po-field-gap.md). Without a stored OrderNbr
   there is no idempotency, and step 6 below is the demonstration of why.
2. Q13 — the two milestone trigger fields must be named.

You can run this runbook before those land; it proves the *write mechanic*. Just don't
open the gate until all three are done.

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

```powershell
"client_id : $($secret.client_id)"
"username  : $($secret.username)"
Invoke-RestMethod -Method Get -Uri "$ApiRoot/Company" -Headers $H |
  Select-Object @{n='companyId';e={$_.CompanyID.value}}, @{n='name';e={$_.CompanyName.value}}
```

**Both must agree, and both must say sandbox.** If they disagree, stop.

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
| header `Branch` / `CurrencyID` / `Terms` / `Location` | `HARMON` / `USD` / `30D` / `MAIN` |
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

$fv = [uri]::EscapeDataString("VendorID eq '$Vendor'")
$mine = Invoke-RestMethod -Method Get -Uri "$ApiRoot/PurchaseOrder?`$filter=$fv&`$expand=Details" -Headers $H |
  Where-Object { $_.Details | Where-Object { $_.Project.value -eq $Project } }
"POs for this vendor+project: $(@($mine).Count)   (expect 1)"
```

**Expect:** `200`, same guid, UnitCost 2400, ExtendedCost 2400, and **exactly one** PO.

---

## Step 8 — the freeze rule

§6 says a released PO is frozen and the delta lands in M2. Confirm Acumatica agrees, so
the engine's refusal matches reality rather than only our reading of it.

In the Acumatica UI: open PO `$Nbr` and **Cancel** it (or Complete it, whichever the
sandbox lets you do without a receipt). Then:

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

---

## What to paste back

```
Step 2  tenant       client_id: ____   company: ____        <- must both say SANDBOX
Step 3  SLPC OUT     budgeted: ____   committed: ____
Step 4  create       status: ____   OrderNbr: ____   (error text if not 200)
Step 5  header       Type/Branch/Currency/Terms/Location: ____
Step 5  status       ____                                    <- Open or On Hold
Step 5  line         Account: ____  Subaccount: ____  TaxCategory: ____   <- 5450 / 02 / LABSERV
Step 5  line         Warehouse: ____  LineType: ____  UOM: ____  Qty: ____
Step 5  line         UnitCost: ____  ExtendedCost: ____
Step 6  budget line  budgeted: ____  revised: ____  committed: ____  actual: ____
Step 6               did OriginalBudgetedAmount move?  ____   <- expect NO
Step 7  update       status: ____  guid unchanged: ____  unitCost: ____
Step 7  PO count for vendor+project: ____                    <- expect 1
Step 8  frozen       status: ____  PUT result: ____  amount changed: ____
```

---

## Then

Opening `PO_GATE` needs **all three** blockers cleared, not just this one:

1. §4f fields deployed ([`commission-po-field-gap.md`](commission-po-field-gap.md)), with
   Read + Edit FLS for the integration user.
2. Q13 answered — the two milestone trigger fields named.
3. This runbook clean, and pasted into a §Results section here.

Then flip `PO_GATE.enabled` in a reviewed commit and update the
`PO_GATE ships CLOSED` test, exactly as D20's gate was opened.

**Watch on the first live job:** exactly one PO per milestone per project, ever. If a
project ever grows a second M1, close the gate before anything else — that is a duplicate
payment, not a reporting glitch.
