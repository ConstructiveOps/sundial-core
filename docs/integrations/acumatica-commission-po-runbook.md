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

## Since 2026-10-22 — the vendor is the dealer's (D-085 amendment 1)

The engine pays `Dealer__r.Acumatica_Vendor_ID__c` for any deal with a `Dealer__c`
(`lib/dealer-terms.js`); the D4 CSV map is read only for a deal created before 2026-09-04 with
no dealer, and a later deal with no dealer is refused. Before every **create** it GETs the
Vendor (`VendorID eq '…'`, `lib/acumatica-vendor-check.js`). The refusals a re-push can now
write to `Commission_PO_Error__c` (status `Failed`):

| Reason | Means | Fix |
|---|---|---|
| `dealer_missing` | post-cutover deal, no `Dealer__c` | set the Sales Rep on the customer and project |
| `vendor_missing` | the dealer has no `Acumatica_Vendor_ID__c` | Harmon finance names the vendor; set it on the dealer |
| `vendor_internal` | the dealer is internal but the budget says 3rd Party | recalculate the budget |
| `vendor_not_in_acumatica` | the vendor id does not exist, or is Inactive | correct the id / reactivate the vendor |
| `vendor_lookup_failed` | Acumatica did not answer the check | retry |
| `vendor_unmapped` / `vendor_inactive` / `vendor_blank` | legacy path (D4 map) | as before |

**Work lists:** `node scripts/verify-dealer-vendor-coverage.mjs` (active dealers without a
usable vendor) and `node scripts/list-failed-commission-pos.mjs [--csv out.csv]` (every
Failed project, grouped by the line that failed). **2026-10-22: 32 Failed** — 26 are the
pre-existing "updated but no longer matches" re-read mismatch (an amount PUT that Acumatica
accepted without changing the line; not a vendor problem, see TASKS.md), 6 an unmapped
sales company. Re-push after fixing; `PO_NUMBER_FIELDS` keeps it idempotent.

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

## 2026-10-23 — Why amount updates do not stick: investigation and fix plan (BUILT later the same day — see "The fix as built" below; not deployed)

**Read-only.** Nothing was written to Acumatica or Salesforce. Tools:
`scripts/probe-commission-po-update.mjs <SOL-…>` (one project's POs, every header and
line field) and `--all-failed` (one line per PO for every project with the mismatch).

### The symptom

26 of the 32 `Failed` projects carry `PO … was updated but no longer matches the expected
shape: UnitCost is X, expected Y`: `updateCommissionPo` PUT `{ id, Details: [{ id, UnitCost,
OrderQty: 1, Requested?, Promised? }] }`, got a 2xx, and the verifying re-read showed the
**old** amount.

### What the evidence shows (SOL-10125, SOL-10061, SOL-10130)

| Project | PO | Status / Hold | Error said (re-read → wanted) | Holds now | PO last modified | Our run |
|---|---|---|---|---|---|---|
| SOL-10125 R261137 | M1 016938 | Closed, received (QtyOnReceipts 1, Completed) | frozen 2,500 | 2,500 | 10-13 15:01 | — |
| | M2 016939 | **Open, Hold false**, QtyOnReceipts 0 | 11,868 → 12,508 | **12,508** | **10-16 18:32:43** | ended 18:32:01 |
| SOL-10061 R261123 | M1 016793 | Closed, received | frozen 2,195 (rule M1 2,069) | 2,195 | 09-28 | — |
| | M2 016794 | **Open, Hold false**, QtyOnReceipts 0 | 1,745 → 2,069 | **1,943** | **10-22 17:49:20** | ended 17:48:27 |
| SOL-10130 R261142 | M1 016965 | **Open, Hold false** | 2,007 → 1,899.75 (+ Requested 10-07 → 10-21) | **1,899.75**, Promised 10-21, **Requested still 10-07** | **10-21 15:12:30** | ended 15:10:54 |
| | M2 016966 | **Open, Hold false** | 2,007 → 1,899.75 | **1,899.75** | **10-21 15:12:47** | ended 15:10:54 |

Five things follow:

1. **Every PO that "failed to update" is `Open` with `Hold = false`.** The only update this
   engine has ever seen persist is runbook Step 7 (2026-08-24, PO 016442), and that PO was
   **On Hold** — the step 8 transcript prints `status: On Hold` for it.
2. **The re-read returned the exact previous amount** (11,868 / 1,745 / 2,007) — the value
   our own create wrote — not a price-list or item cost. Nothing recalculated it; the edit
   was simply not there.
3. **Each PO was changed again 40 s – 2 min AFTER our run ended**, and no Sundial Lambda
   ran at those times (`sundial-acumatica-budget-push` / `sundial-acumatica-push`
   CloudWatch, ±70 s: zero events). The values written then are the "expected" figure from
   our error message (SOL-10125, SOL-10130 — and on 016965 only `Promised` moved, not
   `Requested`, the way a person editing one date would) or, on SOL-10061, **commission −
   the real frozen M1** (4,138 − 2,195 = 1,943), the "difference belongs in M2" arithmetic
   our engine reports but does not do. **Someone at Harmon is correcting these POs by hand
   in Acumatica after reading the error.** That explains today's amounts; it does not
   explain why our PUT was ignored.
4. **The PUT body and echo were never logged** — the update path writes no log line
   (only the create does), so CloudWatch cannot say whether the echo already showed the
   old amount. Question 2 of the investigation is unanswerable from existing logs.
5. Lines report `OrderType = RO` (the header says `Type = Normal`; RO is Normal's internal
   code — consistent, not a finding).

### Ranked diagnosis

| | Hypothesis | Evidence | Verdict |
|---|---|---|---|
| **1** | **(a) An Open, not-on-Hold PO silently ignores detail edits through the API unless it is put On Hold first** | All 26 are Open/Hold=false; the one proven update was On Hold; 2xx + untouched line is the API's known silent-discard behaviour (D24: an unknown AttributeID also returns 200 and is dropped); a person CAN change the same POs in the UI | **Best supported. Not proven.** |
| 2 | (c) the header-id / line-id pairing does not address the line | Same body shape persisted in Step 7; the ids sent come from the read in the same run and each PO has exactly one line | Unlikely — but unlogged, so not excluded |
| 3 | (b) UnitCost is recalculated after the PUT (vendor/item price, triggered by sending `OrderQty`) | The re-read value is the exact old manual amount, not a price; hand edits stick | Weak |
| — | (d) people editing the POs afterwards | Timestamps + values above | **True, but a consequence of the failure, not its cause** — and a new risk for any fix (below) |

**The one piece of evidence that confirms (a):** in the **sandbox**, take an Open,
Hold=false commission PO and send the engine's exact update PUT — re-read unchanged; then
PUT `{ id, Hold: true }`, re-read On Hold, send the same PUT — re-read changed. (If the first
PUT's **echo** already shows the old amount, the edit is discarded at save, which is (a) or
(c); if the echo shows the new amount and the re-read the old, something reverts it after
save, which is neither.)

### Received / billed?

**Update, later 2026-10-23 — all 27 checked.** Acumatica answers again (a plain read worked
by mid-morning; the 406 cleared on its own). `--all-failed` now reads every project whose
update failed (27 of 33 Failed — one more than yesterday's count) and grades each PO against
Tim's ruling (D-057 amendment 1, below):

- **Every M1 except SOL-10063's and SOL-10130's is `Closed`, received and billed** (QtyOnReceipts
  1, Completed) — paid; never touched.
- **Every M2, and the two open M1s, is `Open`, Hold false, nothing received** (QtyOnReceipts
  0, Completed false). Nothing is On Hold.
- **Every Open PO already holds the amount the ruling says** — 28 of the 29 to the cent; the
  exception is SOL-10134 M2 **016998**, 4,663.75 against 4,663.74 (commission 7,163.74 −
  2,500), one cent over. Harmon has corrected all of them by hand; the latest
  correction was today (SOL-10066 M2 016814, 2026-10-23 16:26 UTC).
- Three "wanted" figures in the error text are now stale because the commission changed
  after that push (SOL-10063 M1 wanted 2,026, now correctly 2,500 on a 6,128 commission;
  SOL-10064 M2 wanted 2,489, now correctly 2,478 on 4,978 − 2,500). The error text is a
  record of that run, not of what is owed today.

**So the backlog needs no Acumatica write at all** (bar one cent on SOL-10134, which is
Harmon's call). What is out of date is Salesforce: the stored
`Commission_PO_Mn_Amount__c` and the `Failed` status. Item E becomes a Salesforce write-back.

Of the six POs read first: the three `Closed` M1s are **received and billed** (QtyOnReceipts 1,
Completed; Closed = received + billed) — the freeze rule already never touches them. The
four Open M2/M1s have **QtyOnReceipts 0, Completed false** — nothing received. **The other 20
projects are unchecked:** Acumatica's front end began answering every request with an IIS
`406` page at ~07:30 UTC 2026-10-23, after two `$custom` audit-column requests (500, then
406). No retry loop was run. Re-run `node scripts/probe-commission-po-update.mjs --all-failed`
once a plain read answers again; **any PO with QtyOnReceipts > 0 or Completed = true must be
treated as frozen** whatever its status says.

### The fix — proposed, not built

**A. Instrument first** (no behaviour change): log the update PUT body (amount, date, ids)
and the echo's `UnitCost` / `Status` / `Hold`; no secrets in it. Deploy, then the next failure
answers question 2.

**B. Sandbox hand-proof (new Step 10 of this runbook)** — the confirming test above, plus:
the exact name of the release action on this endpoint (`ReleaseFromHold` / `RemoveHold` —
read the endpoint's action list, do not guess), whether Hold → release re-triggers an
**approval map** (Pending Approval would block payment), and whether a PO that has been
**printed / emailed to the vendor** may be put on hold.

**C. Engine change, only if B confirms (a)** — for an `Open`, `Hold = false` PO:
1. PUT `{ id, Hold: true }` → re-read: must be `On Hold`, amount unchanged.
2. PUT the amount (today's body) → re-read: amount and dates as sent.
3. Release with the action from B → re-read: `Open` (or the pre-hold status), amount still as sent.
4. A failure after step 1 **leaves the PO On Hold** and fails loudly naming it — On Hold
   cannot be received or billed, so the failure state is safe; a person releases it.
   `On Hold` POs skip steps 1 and 3 (today's path, already proven).

**D. Two guards that must ship WITH C, or C makes things worse:**
1. **Do not overwrite a hand edit.** If the PO's current amount ≠ the amount we last wrote
   (`Commission_PO_Mn_Amount__c`), someone changed it in Acumatica → refuse
   (`edited_in_acumatica`), never PUT. Without this, the first push after C would replace
   Harmon's corrections — on SOL-10061 it would move M2 from the correct 1,943 to 2,069 and
   **overpay the dealer 126**. If current = what we want now, write the stored amount back
   and mark it fine with no Acumatica write.
2. **A frozen M1 at a different amount moves M2 by the difference** — **RULED 2026-10-23
   (Tim, D-057 amendment 1): M2 = commission − the amount M1 actually holds**, the
   arithmetic Harmon has been applying by hand. The engine today computes commission −
   rule-M1 and only *reports* the difference; C changes that. An M2 that would go negative
   is refused, never written.

**E. Then the re-push pass:** `--all-failed` to snapshot (done 2026-10-23: every Open PO already
holds the ruled amount), then clear the 27 one at a time. Under the D1 guard with the ruled
arithmetic each reads "already right" and needs only the stored amount written back to
Salesforce and the status cleared — no Acumatica PUT. Do it through the fixed engine, not by
hand-editing Salesforce, so the write-back is the engine's own and verified.

**Risks.** Toggling Hold on a live PO (approval re-trigger; a vendor-facing document
changing state); a race with a person editing the same PO (the guard in D1 is the defence);
receipts/bills on POs (treat QtyOnReceipts > 0 or Completed as frozen — none of the 27's Open
POs had any on 2026-10-23); a repeat of the 406 outage (it followed two `$custom` audit-column
reads — do not repeat those).

### The fix as built (2026-10-23, `feature/dealer-terms`, NOT DEPLOYED) — D-057 am. 2

| Plan item | Built as |
|---|---|
| **A. Logging** | Every update PUT logs `commission-po UPDATE {step} M{n} nbr= po= line= amount= date= hold=` and `commission-po UPDATE-ECHO … http= unitCost= status= hold=` (the PUT now asks `$expand=Details`, so the echo carries the line). Ids and amounts only. |
| **B. Sandbox proof** | `scripts/probe-po-hold-update.mjs` — Step 10 below. **Release-from-hold has no action name**: the Default/25.200.001 swagger has no PurchaseOrder hold/release action (`PutOnHold` / `ReleaseFromHold` are Subcontract's). `Hold` is a BooleanValue field, so both steps are `{ id, Hold }` PUTs. |
| **C. Hold → amount → release** | `updateCommissionPo`, behind **`HOLD_UPDATE_GATE = { enabled: false }`**. Open PO + gate open: hold → re-read On Hold, amount unmoved → amount PUT → verify, still On Hold → release → re-read back to the pre-hold status. A failure names its `step`; after the hold the PO is **left On Hold**. Release landing in `Pending Approval` = `approvalReentered`. On Hold POs and gate-closed always get the single PUT. |
| **D1. Manual-edit guard** | Always on. Live ≠ stored → `reconciled` (= ruled) or `manually_set` (≠ ruled), no Acumatica write either way. The Manually Set marker in `Commission_PO_Error__c` is read back by the next run; clear the error to release it. Status `Manually Set` is not in the picklist yet → `Frozen` + a note (`MANUALLY_SET_PICKLIST.deployed`). |
| **D2. Frozen M1** | Frozen = off `Open`/`On Hold` **or** `QtyOnReceipts` / `ReceivedAmount` > 0 / Completed / Cancelled on the line. M2 = commission − M1's live amount; ≤ 0 → `skip_m2_covered_by_m1`. A frozen M1 no longer marks the record Frozen. |
| **E. Clearing the 27** | `{ reconcilePos: true }` on `sundial-acumatica-budget-push` + `scripts/reconcile-commission-pos.mjs` — below. |

**Dry run over all 33 Failed projects** (`--local`, 2026-10-23, read-only): every one of the 27
update-mismatch projects has its amount adopted with **zero Acumatica writes** — **15 →
Both Raised**; **12 → still Failed, now for `dealer_missing`** (created after the 2026-09-04
cutover with no `Dealer__c`: SOL-10050 / 10051 / 10062 / 10063 / 10070 / 10071 / 10124 / 10130 /
10132 / 10133 / 10134 / 10136 — their amounts are right, but the next push refuses until a dealer
is set, so the record says that instead of the stale October text); SOL-10134's M2 is the one
`manually_set` (4,663.75 vs 4,663.74). The other 6 (SOL-10052 / 10072 / 10137 / 10140 / 10141 /
9871) never had POs raised — `needs_push`, untouched.

### Clearing the Failed records — `scripts/reconcile-commission-pos.mjs`

```
node scripts/reconcile-commission-pos.mjs --local            # dry run in-process (works before deploy)
node scripts/reconcile-commission-pos.mjs                    # dry run via the deployed Lambda
node scripts/reconcile-commission-pos.mjs --apply            # writes Salesforce: ONE canary, re-read, then the rest
node scripts/reconcile-commission-pos.mjs SOL-10125 --apply  # just these
```

Never writes to Acumatica. `--apply` writes only the six commission-PO fields; the canary
aborts if anything else on the record moved (budget push status/error, finalized flag,
commission, Created stamps) — the sign a Flow reacted.

## Step 10 — the hold proof (SANDBOX ONLY), before opening `HOLD_UPDATE_GATE`

**There is no sandbox secret today** (2026-10-23): `sundial/acumatica/connected-app` is LIVE
(`client_id` ends `@Harmon Electric`) and `sundial/acumatica/api` holds placeholders. **Do not
repoint `connected-app`.** Create a separate secret, e.g. **`sundial/acumatica/sandbox`**, in
us-west-1, with the same five keys as `connected-app` — `base_url`, `client_id` (ends
`@<sandbox tenant>`, e.g. `@BizRun Tenant`), `client_secret`, `username`, `password` — for a
sandbox connected app with API access. Then pick an Open, not-on-Hold, one-line PO in the
sandbox that nobody minds changing, and:

```
$env:SUNDIAL_ACUMATICA_SECRET_NAME = "sundial/acumatica/sandbox"
node scripts/probe-po-hold-update.mjs --tenant "BizRun Tenant" --po <OrderNbr>          # checks + plan
node scripts/probe-po-hold-update.mjs --tenant "BizRun Tenant" --po <OrderNbr> --apply  # the four PUTs
Remove-Item Env:SUNDIAL_ACUMATICA_SECRET_NAME
```

The script refuses unless the variable is set, the credential's tenant equals `--tenant`, and
that tenant is not the one the deployed pointer holds. It prints the endpoint's PurchaseOrder
actions, then status / hold / amount after: (1) the engine's plain update, (2) `Hold = true`,
(3) the update again, (4) `Hold = false`, and a verdict. **Open the gate only on "Hypothesis
(a) CONFIRMED and the hold path works"** — `HOLD_UPDATE_GATE.enabled = true` in
`lambdas/sundial-acumatica-commission-po/index.js`, its pinning test updated in the same diff.
A plain PUT that sticks means the October cause is elsewhere: leave the gate shut, paste the
output back. `SUNDIAL_ACUMATICA_SECRET_NAME` is for scripts only — never on a Lambda.

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

**✅ DONE 2026-08-24 — all three cleared and the gate is OPEN:**

1. ✅ §4f fields deployed, with Read + Edit FLS for the integration user.
2. ✅ Q13 — answered (D23). Both POs are raised on the first budget push; the two dates
   are what each PO carries, not triggers.
3. ✅ This runbook re-run. See §Results for what steps 7 and 8 actually settled — and for
   the one thing that did **not** get proven.

`PO_GATE.enabled` was flipped in a reviewed commit and the gate test now pins `true`,
exactly as D20's gate was opened. **Re-running this runbook is still the way to
re-validate the write mechanic after any change to the create/update path.**

**Watch on the first live job:** exactly one PO per milestone per project, ever. If a
project ever grows a second M1, close the gate before anything else — that is a duplicate
payment, not a reporting glitch.

## Results

**Run 2026-08-24 · project `R261065` · vendor `01736` (Blue Sky Solar) · PO `016442`.**

> ## ✅ RE-RUN 2026-08-24 — `PO_GATE` IS OPEN
>
> Steps 7 and 8 were re-run and the gate was opened in a reviewed commit. **Step 8 answered
> the freeze question the hard way: Acumatica ALLOWS a PUT to a Canceled PO** — see
> [the step 8 result](#-step-8-re-run--acumatica-allows-it-our-refusal-is-the-only-freeze).
> Step 7's probe remains buggy and was ruled a runbook defect rather than a gate blocker;
> the residual risk is recorded there and in D-060. PO 016442 is confirmed Canceled.
>
> ⚠️ **The re-run transcript was not pasted into this document** — the verdicts below are
> Tim's, recorded as attestation. The step 8 status string was independently confirmed by
> reading PO 016442 back through the API (`Status: "Canceled"`); nothing else in the
> re-run was verified from this side.

### Verdict: the write mechanic is proven. Two steps did not land on the FIRST run, and are resolved below.

| Step | | Outcome |
|---|---|---|
| 2 — tenant proof | ⚠️→✅ | **Not run — the command in the runbook does not work.** Settled out of band: BizRun is the sandbox and PO 016442 was confirmed in both UIs (Q15). |
| 3 — SLPC OUT exists | ✅ | Task present with budget lines. |
| 4 — create | ✅ | `200`, `OrderNbr 016442`. PUT-without-id inserts, as on the referral line. |
| 5 — derived values | ✅ | **Every one matched the specimen.** Account `5450` / Subaccount `02` / TaxCategory `LABSERV` / Warehouse `MAIN` / LineType `Non-Stock` / UOM `EA` / Qty 1, header `Normal` / `HARMON` / `USD` / `MAIN`, UnitCost = ExtendedCost = 2500. |
| 5 — Terms | ⚠️→✅ | Came back **`DOR`**, not the specimen's `30D`. Correct — Terms is per-vendor (Q16). Caught a real bug in the verifier; see below. |
| 6 — committed amounts | ✅ | `OriginalBudgetedAmount` did **not** move. No write conflict with the budget push. |
| 7 — update by guid | ✅ | `200`, same guid, UnitCost and ExtendedCost both 2400. |
| 7 — no duplicate | ❌ | **Probe is buggy — 28 on both runs.** Ruled a runbook defect, not a gate blocker. See below. |
| 8 — freeze rule | ✅ | **Re-run: Acumatica ALLOWS editing a Canceled PO** (200, change persisted). Our refusal is the only freeze. |
| 9 — clean up | ✅ | **016442 Canceled**, confirmed via the API 2026-08-24. |

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

> **RE-RUN 2026-08-24: the corrected probe returned 28 as well** — the vendor's whole PO
> history again, so the description filter is not comparing what it claims to. **The probe
> itself is buggy.** Ruled the same day as a runbook defect to fix separately, and
> explicitly NOT a reason to hold the gate:
>
> - idempotency in the engine is the **stored OrderNbr** and never a scan, so what this
>   probe measures is not what the engine relies on;
> - the first run's **guid and OrderNbr were unchanged** across an update that moved the
>   amount, which is direct evidence of an in-place update;
> - the create/update/no-duplicate behaviour is covered by tests.
>
> **This remains an accepted residual risk rather than a proven negative**, which is why
> the first-live-job watch below is not boilerplate. Fixing the probe is a follow-up.

**The corrected check** scopes by our own description, which is exactly the M1/M2 label the
engine writes — **and note that as written below it still returns the whole vendor
history, so treat this block as the thing to debug, not as a working check:**

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

### ⚠️ Step 8 (re-run) — Acumatica ALLOWS it. Our refusal is the only freeze.

**Re-run 2026-08-24 with the PO properly Canceled first: the PUT returned `200` and the
change PERSISTED.**

That is the answer the step said was useful either way, and it is the less comfortable one:

> **There is no API-side freeze.** `UPDATABLE_STATUSES` in
> `lambdas/sundial-acumatica-commission-po/index.js` is not us agreeing with Acumatica
> about a rule — it is the entire rule. Nothing else, anywhere, prevents a silent edit to
> a released purchase order.

Pinned as **D-060**, and hardened in code:

- The status check is **deny-by-default** (`!UPDATABLE_STATUSES.includes(status)`), so an
  unrecognised, empty, null or missing status is frozen. A future Acumatica release adding
  a status we have never heard of fails safe.
- Tests assert it is unbypassable, including the "no `Status` field at all" shape and
  case variants (`OPEN` ≠ `Open`).
- **Only `Canceled` was tested.** `Completed` and `Closed` were not, and we deliberately do
  not care whether the API happens to refuse them: **every status off the allow-list is
  never-touch.**

**Spelling, found while pinning this:** Acumatica returns **`Canceled`** — one L — read
back off PO 016442. `FROZEN_STATUSES` said `Cancelled` and had therefore never matched
anything. Harmless *only* because it is documentation and the guard is the allow-list; had
anything been written as `FROZEN_STATUSES.includes(status)`, a canceled PO would have gone
straight through. Corrected, and a test now pins the spelling.

---

### ❌ Step 8 on the FIRST run never tested the freeze rule

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

### ✅ Cleanup — PO 016442 is Canceled

Was: `016442`, On Hold, OrderTotal 9,999.00, one line on project `R261065`, vendor 01736.
**Canceled 2026-08-24 and confirmed through the API** (`Status: "Canceled"` — the same read
that settled the spelling above). Cancelling it is what made the step 8 re-run possible, so
the cleanup and the proof were one action.

---

### What this did to the gate

**`PO_GATE.enabled = true`, opened 2026-08-24 in a reviewed commit** (D-060). All three
blockers cleared: §4f fields deployed with Read + Edit FLS, Q13/D23 answered, this runbook
re-run. Q15 and Q16 resolved alongside.

The gate is a repo constant, so **closing it is also a reviewed diff** — and closing it is
the first move if the watch below ever fires.

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