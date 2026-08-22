# Sandbox hand-proof — creating the REFERRAL budget line (D20)

**Purpose:** prove, by hand, that Acumatica will let us CREATE a ProjectBudget line, and
that the line comes back shaped the way the mapping expects. Until this is done and the
results are pasted in, `CREATE_GATE.enabled` stays `false` in
`lambdas/sundial-acumatica-budget-push/index.js` and the push refuses to create anything.

**Target:** BizRun sandbox project **`R269999`** (customer `C001311112`) — the canonical
scaffold project, 38 lines, already used for the 2026-08-07 harvest.

**Nothing here touches production, Salesforce, or the Lambda.** It is five REST calls you
make yourself, so that the first time this write mechanic runs it is not also the first
time anyone has seen it work.

---

## Why a hand-proof and not just a test

The unit tests prove the *code* does the right thing given an Acumatica that behaves in
one of five ways. They cannot tell us which way Acumatica actually behaves. Three specific
unknowns need a real server to answer:

| Unknown | Why it matters |
|---|---|
| **Does a PUT with no `id` insert, or 400?** | The whole mechanic. Acumatica's contract-based API treats PUT as upsert-by-key, but "key" for ProjectBudget is not documented as the 4-part natural key we rely on. |
| **Does `AccountGroup` come back as `OTHER`?** | It may be **derived** from the inventory item's posting class and ignore what we send. AccountGroup is part of the natural key, so a derived value means the line exists under a key the mapping will never match — and the next push tries to create a *second* one. |
| **Does `Type` come back as `Expense`?** | Same reasoning. We never send `Type`; Acumatica decides it. |

`createReferralLineAndVerify` checks all three at runtime and fails loudly, so a surprise
cannot post a wrong number. But finding out in a sandbox is free, and finding out during
Harmon's first referral job is not.

---

## The line being created

Harmon's authoritative spec, which is also `REFERRAL_CREATE_SPEC` in the code:

| Field | Value |
|---|---|
| `ProjectTaskID` | `GENO` |
| `AccountGroup` | `OTHER` |
| `InventoryID` | `REFERRAL` |
| `Description` | `Referral Fee` |
| `UOM` | `EA` |
| Currency | USD |
| Qty / rate | **none** |

Natural key: **`GENO | OTHER | REFERRAL | Expense`**. Note this shares `ProjectTaskID`
with the GENO other-costs sum line (`GENO | OTHER | <N/A> | Expense`) but differs on
`InventoryID`, so they are two distinct lines under one task — no collision. Step 5 below
verifies exactly that.

> **Prerequisite:** the inventory item `REFERRAL` must exist in the sandbox. If step 2
> comes back with *"Inventory item REFERRAL not found"*, that is the real answer and it
> stops here — Harmon has to create the item before anything else is worth trying.

---

## Setup — credentials

Same secret the Lambda uses: **`sundial/acumatica/connected-app`** in Secrets Manager
(`us-west-1`). Pull it once into the session rather than typing anything by hand.

```powershell
$secret = aws secretsmanager get-secret-value `
  --secret-id sundial/acumatica/connected-app --region us-west-1 `
  --query SecretString --output text | ConvertFrom-Json

$BaseUrl = $secret.base_url.TrimEnd('/')
$ApiRoot = "$BaseUrl/entity/Default/25.200.001"
$Project = 'R269999'

"base: $BaseUrl"
```

> ⚠️ **Confirm `$BaseUrl` is the SANDBOX (BizRun) tenant before continuing.** If the
> secret points at production, stop — this runbook creates a real budget line.

---

## Step 1 — mint a token

`client_id` contains a space (e.g. `...@BizRun Tenant`). Passing the body as a PowerShell
hashtable lets `Invoke-RestMethod` form-encode it correctly; hand-building the string is
where this breaks.

```powershell
$tok = Invoke-RestMethod -Method Post -Uri "$BaseUrl/identity/connect/token" `
  -ContentType 'application/x-www-form-urlencoded' `
  -Body @{
    grant_type    = 'password'
    client_id     = $secret.client_id
    client_secret = $secret.client_secret
    username      = $secret.username
    password      = $secret.password
    scope         = 'api'
  }

$H = @{ Authorization = "Bearer $($tok.access_token)"; Accept = 'application/json' }
"token length: $($tok.access_token.Length)"
```

**Expect:** a token string of a few hundred characters. A 400 here is a credentials
problem, not a create problem.

---

## Step 2 — CREATE the line

Payload goes via a **no-BOM file**, per this repo's convention: PowerShell 5.1 writes a
UTF-8 BOM by default and JSON parsers reject it.

```powershell
$NoBom = New-Object System.Text.UTF8Encoding($false)
$createBody = @{
  ProjectID              = @{ value = $Project }
  ProjectTaskID          = @{ value = 'GENO' }
  AccountGroup           = @{ value = 'OTHER' }
  InventoryID            = @{ value = 'REFERRAL' }
  Description            = @{ value = 'Referral Fee' }
  UOM                    = @{ value = 'EA' }
  OriginalBudgetedAmount = @{ value = 500 }
} | ConvertTo-Json -Depth 5

[System.IO.File]::WriteAllText("$env:TEMP\referral-create.json", $createBody, $NoBom)
Get-Content "$env:TEMP\referral-create.json"

$create = Invoke-WebRequest -Method Put -Uri "$ApiRoot/ProjectBudget" `
  -Headers $H -ContentType 'application/json' `
  -InFile "$env:TEMP\referral-create.json" -UseBasicParsing

$create.StatusCode
$create.Content | ConvertFrom-Json | ConvertTo-Json -Depth 5
```

**Note there is no `id` in the body.** That is what makes this an insert.

**Expect:** `200`, and a body echoing the created line including an `id` GUID.

**If it 4xx's, paste the error verbatim — that is a complete and useful result.** The most
informative failures:

| Response | Means |
|---|---|
| `Inventory item REFERRAL not found` | The item does not exist in the sandbox. Stop; Harmon creates it first. |
| `Project task GENO not found` | Wrong task code, or R269999 lacks it. |
| Anything about a key or a duplicate | A line may already exist — jump to step 3 and look. |
| 405 / "not supported" | PUT-without-id is not an insert on this entity. **D20 is not implementable as designed**; report back before anything else. |

---

## Step 3 — RE-READ, and capture the guid

The point of the whole exercise: what the *project* looks like now, which is a different
question from what the write claimed.

```powershell
$filter = [uri]::EscapeDataString("ProjectID eq '$Project'")
$lines  = Invoke-RestMethod -Method Get -Uri "$ApiRoot/ProjectBudget?`$filter=$filter" -Headers $H

$ref = $lines | Where-Object {
  $_.ProjectTaskID.value -eq 'GENO' -and $_.InventoryID.value -eq 'REFERRAL'
}

$ref | Select-Object `
  @{n='id';        e={$_.id}},
  @{n='task';      e={$_.ProjectTaskID.value}},
  @{n='group';     e={$_.AccountGroup.value}},
  @{n='inventory'; e={$_.InventoryID.value}},
  @{n='type';      e={$_.Type.value}},
  @{n='uom';       e={$_.UOM.value}},
  @{n='desc';      e={$_.Description.value}},
  @{n='amount';    e={$_.OriginalBudgetedAmount.value}} | Format-List

$Guid = $ref.id
"guid: $Guid"
"count: $(@($ref).Count)"
```

**THE THREE ANSWERS THIS RUNBOOK EXISTS FOR — record all three:**

1. `count` is **1**
2. `group` is **`OTHER`**  ← if it is anything else, say what
3. `type` is **`Expense`** ← if it is anything else, say what

Also worth noting: `uom` (did `EA` stick?) and `amount` (is it `500`?).

> **If `group` or `type` came back different, do NOT flip the gate.** The create works but
> the line's natural key is not what the mapping row says, and `REFERRAL_LINE_KEY` plus
> the mapping row's `accountGroup` need changing to whatever Acumatica actually produced.
> The runtime verifier already refuses this case; the fix is a mapping change, not a
> verifier change.

---

## Step 4 — UPDATE the amount by guid

Proves the created line behaves like every other line afterwards — which is what makes
branch 1 (re-push = ordinary update) true rather than hoped for.

```powershell
$updateBody = @{
  id                     = $Guid
  OriginalBudgetedAmount = @{ value = 750 }
} | ConvertTo-Json -Depth 5

[System.IO.File]::WriteAllText("$env:TEMP\referral-update.json", $updateBody, $NoBom)

$update = Invoke-WebRequest -Method Put -Uri "$ApiRoot/ProjectBudget" `
  -Headers $H -ContentType 'application/json' `
  -InFile "$env:TEMP\referral-update.json" -UseBasicParsing

$update.StatusCode
```

**Expect:** `200`.

---

## Step 5 — RE-READ, and prove there is no duplicate

The failure this catches is the expensive one: if the update inserted a second line
instead of updating the first, the key stops matching uniquely and **every future push on
that project aborts**.

```powershell
$lines2 = Invoke-RestMethod -Method Get -Uri "$ApiRoot/ProjectBudget?`$filter=$filter" -Headers $H

# The referral line: must still be exactly ONE, now at 750.
$ref2 = $lines2 | Where-Object {
  $_.ProjectTaskID.value -eq 'GENO' -and $_.InventoryID.value -eq 'REFERRAL'
}
"referral count: $(@($ref2).Count)   amount: $($ref2.OriginalBudgetedAmount.value)   guid same: $($ref2.id -eq $Guid)"

# The no-collision check: both GENO lines, side by side.
$lines2 | Where-Object { $_.ProjectTaskID.value -eq 'GENO' } |
  Select-Object @{n='group';e={$_.AccountGroup.value}},
                @{n='inventory';e={$_.InventoryID.value}},
                @{n='type';e={$_.Type.value}},
                @{n='amount';e={$_.OriginalBudgetedAmount.value}} | Format-Table

# Total line count: was 38 before this runbook.
"total lines: $(@($lines2).Count)"
```

**Expect:**

- referral count **1**, amount **750**, guid **same as step 3**
- **two** GENO rows: `OTHER | <N/A>` and `OTHER | REFERRAL` — separate lines, which is the
  no-collision proof
- total lines **39** (38 + the one we created)

---

## Step 6 — clean up (optional but preferred)

R269999 is the harvest reference project, and the committed fixtures
(`harvest/R261077-rs.json`, `harvest/R261066-rsdc.json`) come from other projects, so a
stray line here breaks nothing automated. It will still confuse the next person reading a
reconcile. Either delete the line in the Acumatica UI, or zero it:

```powershell
$zeroBody = @{ id = $Guid; OriginalBudgetedAmount = @{ value = 0 } } | ConvertTo-Json -Depth 5
[System.IO.File]::WriteAllText("$env:TEMP\referral-zero.json", $zeroBody, $NoBom)
Invoke-WebRequest -Method Put -Uri "$ApiRoot/ProjectBudget" -Headers $H `
  -ContentType 'application/json' -InFile "$env:TEMP\referral-zero.json" -UseBasicParsing |
  Select-Object -ExpandProperty StatusCode
```

---

## What to paste back

```
Step 2 create        status: ____   (error text if not 200)
Step 3 count:        ____
Step 3 AccountGroup: ____      <- must be OTHER
Step 3 Type:         ____      <- must be Expense
Step 3 UOM:          ____
Step 3 amount:       ____
Step 4 update        status: ____
Step 5 referral count: ____    amount: ____   guid unchanged: ____
Step 5 GENO rows:    ____      <- expect 2, listed
Step 5 total lines:  ____      <- expect 39
```

---

## Then, and only then

Flip `CREATE_GATE.enabled` to `true` in
`lambdas/sundial-acumatica-budget-push/index.js`, **in the same PR that records these
results**, and update the `D20: the create gate ships CLOSED` test to match. Two things to
carry into that PR:

- If `AccountGroup` or `Type` came back different, the mapping row's key changes too —
  `REFERRAL_LINE_KEY`, `REFERRAL_CREATE_SPEC`, and the `Referral Fees` row in
  `MAPPING_ROWS` all have to agree with whatever Acumatica actually produces.
- The first production job that exercises this should be watched. `summary.created` is
  `1` on that push and `0` on every push afterwards; if it is ever `1` twice for the same
  project, something is wrong with the verification and the gate goes back to `false`.
