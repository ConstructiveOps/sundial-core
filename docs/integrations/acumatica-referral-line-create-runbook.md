# Sandbox hand-proof — creating the REFERRAL budget line (D20)

> ## ✅ DONE — 2026-08-22, sandbox, project `R261065`. All five gates passed.
> `CREATE_GATE.enabled` is now `true`. **[Results are recorded below](#results--2026-08-22).**
> This document is kept as the procedure for the next write-proof, not just a record of
> this one — see the [tenant-identity preamble](#step-2--prove-which-tenant-you-are-on),
> which was added as a result of running it.

**Purpose:** prove, by hand, that Acumatica will let us CREATE a ProjectBudget line, and
that the line comes back shaped the way the mapping expects.

**Nothing here touches Salesforce or the Lambda.** It is a handful of REST calls you make
yourself, so that the first time a write mechanic runs it is not also the first time
anyone has seen it work.

---

**Target for the original run:** sandbox project **`R261065`**. (The runbook was drafted
against `R269999`, the 2026-08-07 harvest project; the actual run used `R261065`. Either
works — any scaffolded project with no existing REFERRAL line will do. Substitute the
project you are using into `$Project` below.)

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
`InventoryID`, so they are two distinct lines under one task — no collision. Step 6 below
verifies exactly that.

> **Prerequisite:** the inventory item `REFERRAL` must exist in the tenant. If step 3
> comes back with *"Inventory item REFERRAL not found"*, that is the real answer and it
> stops here — Harmon has to create the item before anything else is worth trying.
>
> **Answered 2026-08-22:** it exists, and its posting class derives exactly the
> `OTHER`/`Expense` this table expects. See [Results](#results--2026-08-22).

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
$Project = 'R261065'   # any scaffolded project with no existing REFERRAL line

"base: $BaseUrl"
```

> ⚠️ **`$BaseUrl` DOES NOT TELL YOU WHICH TENANT THIS IS.** Sandbox and production share
> it; the secret's contents are what decide, and they change without the URL changing.
> **Step 2 is the check** — do not skip it and do not infer the tenant from this value.

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

## Step 2 — prove which tenant you are on

**Do this before the first write, every time, and paste the output with the results.**

Sandbox and production share a base URL, and the sandbox is a refreshed copy of live, so
**project IDs exist in both**. A transcript showing `R261065` and a `200` therefore does
not say which system it hit — and "which system did that write land in" is not a question
you want to be answering afterwards from memory. The secret's contents decide it, and the
secret changes without the URL changing.

Record something that distinguishes the two:

```powershell
# 1. The tenant the credentials actually authenticate into. client_id is scoped to a
#    tenant (e.g. "...@BizRun Tenant" vs "...@Company"), so this is the primary tell.
"client_id : $($secret.client_id)"
"username  : $($secret.username)"
"base_url  : $BaseUrl"

# 2. A server-side fact, so this does not rest on the secret's labelling alone.
Invoke-RestMethod -Method Get -Uri "$ApiRoot/Company" -Headers $H |
  Select-Object @{n='companyId';e={$_.CompanyID.value}}, @{n='name';e={$_.CompanyName.value}}
```

**Both must agree, and both must say sandbox.** If `client_id` names one tenant and the
company record names another, stop — you do not know where the next write goes.

> If `/Company` is not exposed to the integration user, substitute any read whose value
> differs between the tenants and say which you used. A row count on a table that only
> exists post-refresh works; a project ID does not, because the refresh copies those.

---

## Step 3 — CREATE the line

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
| `Project task GENO not found` | Wrong task code, or the project you chose lacks it. |
| Anything about a key or a duplicate | A line may already exist — jump to step 4 and look. |
| 405 / "not supported" | PUT-without-id is not an insert on this entity. **D20 is not implementable as designed**; report back before anything else. |

---

## Step 4 — RE-READ, and capture the guid

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

## Step 5 — UPDATE the amount by guid

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

## Step 6 — RE-READ, and prove there is no duplicate

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

# Total line count: note what it was BEFORE, and expect exactly one more.
"total lines: $(@($lines2).Count)"
```

**Expect:**

- referral count **1**, amount **750**, guid **same as step 4**
- **two** GENO rows: `OTHER | <N/A>` and `OTHER | REFERRAL` — separate lines, which is the
  no-collision proof
- total lines = **the scaffold's count + 1** (38 + 1 on a standard RS project)

---

## Step 7 — clean up (optional but preferred)

The committed fixtures (`harvest/R261077-rs.json`, `harvest/R261066-rsdc.json`) are
static files captured in 2026-08-20, so a stray line on a live sandbox project breaks
nothing automated. It will still confuse the next person reading a
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
Step 2 tenant        client_id: ____   company: ____   <- must both say SANDBOX
Step 3 create        status: ____   (error text if not 200)
Step 4 count:        ____
Step 4 AccountGroup: ____      <- must be OTHER
Step 4 Type:         ____      <- must be Expense
Step 4 UOM:          ____
Step 4 amount:       ____
Step 5 update        status: ____
Step 6 referral count: ____    amount: ____   guid unchanged: ____
Step 6 GENO rows:    ____      <- expect 2, listed
Step 6 total lines:  ____      <- expect scaffold + 1
```

---

## Results — 2026-08-22

**Run by Tim against the SANDBOX, project `R261065`. All five gates passed.**

| Gate | Result |
|---|---|
| PUT with no `id` inserts | **YES** — the mechanic works |
| `AccountGroup` on re-read | **`OTHER`** — derived from the REFERRAL item's posting class, and agrees with what we send |
| `Type` on re-read | **`Expense`** — likewise derived |
| Update-by-guid | **updates in place**, no new line |
| Duplicates | **none** — count `1` throughout |

**What this settled.** The two open questions were whether Acumatica derives `AccountGroup`
and `Type` from the inventory item rather than taking the body, and if so what it derives.
It does derive them, and it derives exactly what the mapping expects — so
`REFERRAL_LINE_KEY` (`GENO | OTHER | REFERRAL | Expense`) is correct and **no mapping
change was needed**. Had either come back differently, the line would have existed under a
key the mapping could never match, and the fix would have been to re-key the mapping row.

**On the sandbox standing in for live:** the sandbox is a refreshed copy of live, so item
posting classes are live's own configuration. Deriving `OTHER`/`Expense` there is evidence
about live's config, not merely about a sandbox's. That is Tim's assessment and it is
sound for configuration-derived behaviour.

> **One limit of this transcript, recorded because it is the reason step 2 now exists.**
> The run predates the tenant-identity check, and the shared base URL plus a
> refresh-copied project ID mean the transcript cannot self-certify which tenant it hit.
> The sandbox attribution is **Tim's attestation**, not something the output proves. That
> is accepted here — he ran it and knows which credentials were loaded. Step 2 removes the
> need to take anyone's word for it next time.

**Gate opened** in the same commit as this record. Test
`D20: the create gate ships OPEN, on the strength of the sandbox hand-proof` now asserts
`true`, so a change in either direction stays a visible diff.

---

## For the next write-proof

- **Step 2 is not optional.** Any future proof of a write mechanic runs the tenant-identity
  check before the first write and pastes the output. The base URL is not an identifier.
- **The first production job that exercises this should be watched.** `summary.created` is
  `1` on the push that first posts a referral fee for a project and `0` on every push
  after. If it is ever `1` twice for the same project, verification is not doing its job:
  set `CREATE_GATE.enabled` back to `false` and look at the project. Closing the gate is a
  complete rollback to the pre-D20 abort, and there is a test that keeps it that way.
