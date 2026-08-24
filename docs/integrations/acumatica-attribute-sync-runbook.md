# Sandbox hand-proof — writing Project attributes (Stage E)

> ## ✅ RUN 2026-08-24 — see [§Results](#results). The answer is MERGE. `ATTR_GATE` IS OPEN.
>
> A partial `Attributes` PUT leaves what it did not send alone, so
> `lib/acumatica-attributes.js` was correct as built. The sync is now **wired into the
> budget push worker** (Stage E) and `ATTR_GATE.enabled = true`.
>
> Two things came out of the run and both are in the shipped code: an unknown
> `AttributeID` is **silently ignored**, so every write is verified by re-read
> (`verifyAttributeWrite`); and numbers are padded to Harmon's convention (Q17).
>
> ⚠️ **Step 9 restore on `R261065` was still outstanding at the time of writing** — the
> message reporting it left the status unfilled. The values are in §Results.

**Purpose:** prove that a `PUT Project` with an `Attributes` array updates the values
Harmon's reporting reads, that the date format round-trips, and — the one that actually
worries me — that sending a **partial** attribute set leaves the attributes we did not
send alone.

**Reference:** the live enumeration of project **R251282** (§7 of the rework doc), which
is where the attribute list and the verified commission splits come from.

---

## Why this needs a hand-proof at all

Attributes are not money, so the blast radius is smaller than the PO runbook's. But the
write mechanic has one property that is genuinely unknown and genuinely dangerous:

> **Does PUTting a partial `Attributes` array MERGE, or does it REPLACE the whole set?**

If it replaces, then a sync that sends nine attributes on a job where only nine have
values would **erase the other four** — including ones a human typed into Acumatica. The
builder in `lib/acumatica-attributes.js` deliberately omits blanks rather than sending
`""`, precisely so it never overwrites a value it has no information about. That
protection is worthless if the API treats an absent attribute as a deletion.

Step 5 is that test, and it is the reason this runbook exists.

**It MERGES** (2026-08-24). And the run turned up direct evidence that the protection is
doing real work: R261065's `SLSCOM1`/`SLSCOM2` were `1538.00`/`2138.00`, which match
neither the third-party rule nor the 75/25 one — hand-entered values in exactly the fields
a replace would have wiped.

---

## Setup

```powershell
$secret = aws secretsmanager get-secret-value `
  --secret-id sundial/acumatica/connected-app --region us-west-1 `
  --query SecretString --output text | ConvertFrom-Json

$BaseUrl = $secret.base_url.TrimEnd('/')
$ApiRoot = "$BaseUrl/entity/Default/25.200.001"
$Project = 'R261065'     # a sandbox project; substitute yours
$NoBom   = New-Object System.Text.UTF8Encoding($false)
```

## Step 1 — token

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

## Step 2 — prove which tenant you are on

**Mandatory before the first write.** The base URL does not distinguish sandbox from
production, and the sandbox is a refreshed copy of live.

> **CORRECTED 2026-08-24.** This step used to call `GET $ApiRoot/Company`, which returns
> `Entity Company not found` — there is no `Company` entity in the `Default/25.200.001`
> endpoint, so the check could never have run. Acumatica suffixes the ROPC `client_id`
> with the tenant the grant is scoped to, so the credential names its own tenant.

```powershell
"tenant    : $($secret.client_id.Split('@')[-1])"
"username  : $($secret.username)"
"base_url  : $($secret.base_url)"
```

**`BizRun Tenant` is the sandbox.** Anything else — stop. This runbook **overwrites
existing attribute values**, and step 3's output is the only record of what they were.

> **The secret is a POINTER, not a tenant.** `sundial/acumatica/connected-app` holds BizRun
> through the rework and gets repointed at **live** at the end of the release window, so
> this check is not a formality you can skip once you have seen it pass — the answer
> changes. See §1 of `acumatica-budget-rework-v2.md` (Q15).

---

## Step 3 — read the attributes as they stand

```powershell
$f = [uri]::EscapeDataString("ProjectID eq '$Project'")
$proj = Invoke-RestMethod -Method Get -Uri "$ApiRoot/Project?`$filter=$f&`$expand=Attributes" -Headers $H
$ProjId = $proj.id
"project guid: $ProjId"

$proj.Attributes | Select-Object `
  @{n='id';e={$_.id}}, @{n='attributeId';e={$_.AttributeID.value}},
  @{n='desc';e={$_.Description.value}}, @{n='value';e={$_.Value.value}},
  @{n='valueDesc';e={$_.ValueDescription.value}} | Format-Table -AutoSize

"attribute count: $(@($proj.Attributes).Count)"
```

**Record the full list.** This is the "before" that step 5 compares against, and it also
confirms the AttributeIDs on this project match the §7 table — a project built from a
different template may not carry all of them.

> If an AttributeID from §7 is **absent** here rather than merely empty, note which. The
> question of whether a PUT can add an attribute the project does not have is different
> from whether it can set one that is present but blank.

---

## Step 4 — write TWO attributes and confirm they take

Start small: one date and one number, so a failure is unambiguous.

```powershell
$body = @{
  id         = $ProjId
  Attributes = @(
    @{ AttributeID = @{ value = 'AUDITDATE' };  Value = @{ value = '2026-07-14' } }
    @{ AttributeID = @{ value = 'KW' };         Value = @{ value = '12.76' } }
  )
} | ConvertTo-Json -Depth 6

[System.IO.File]::WriteAllText("$env:TEMP\attr-two.json", $body, $NoBom)
Get-Content "$env:TEMP\attr-two.json"

(Invoke-WebRequest -Method Put -Uri "$ApiRoot/Project" -Headers $H `
  -ContentType 'application/json' -InFile "$env:TEMP\attr-two.json" -UseBasicParsing).StatusCode

$after = Invoke-RestMethod -Method Get -Uri "$ApiRoot/Project?`$filter=$f&`$expand=Attributes" -Headers $H
$after.Attributes | Where-Object { $_.AttributeID.value -in 'AUDITDATE','KW' } |
  Select-Object @{n='attributeId';e={$_.AttributeID.value}}, @{n='value';e={$_.Value.value}} | Format-Table
```

**Expect:** `200`, `AUDITDATE` = something meaning 14 July 2026, `KW` = `12.76`.

**Record the EXACT string `AUDITDATE` comes back as.** The builder sends the ISO date
Salesforce already returns (`2026-07-14`) rather than reformatting, on the grounds that
reformatting is where timezones get introduced into a value that has none. If Acumatica
echoes `7/14/2026` or `2026-07-14T00:00:00`, that is fine — but if it **rejects**
`2026-07-14`, `formatAttributeValue` in `lib/acumatica-attributes.js` is the single place
to change.

---

## Step 5 — ⚠️ THE MERGE-OR-REPLACE TEST

The whole reason for this runbook. Write **one** attribute and see whether the other
twelve survive.

```powershell
$one = @{
  id         = $ProjId
  Attributes = @( @{ AttributeID = @{ value = 'GREENTAG' }; Value = @{ value = '2026-08-10' } } )
} | ConvertTo-Json -Depth 6

[System.IO.File]::WriteAllText("$env:TEMP\attr-one.json", $one, $NoBom)
(Invoke-WebRequest -Method Put -Uri "$ApiRoot/Project" -Headers $H `
  -ContentType 'application/json' -InFile "$env:TEMP\attr-one.json" -UseBasicParsing).StatusCode

$final = Invoke-RestMethod -Method Get -Uri "$ApiRoot/Project?`$filter=$f&`$expand=Attributes" -Headers $H
$final.Attributes | Select-Object `
  @{n='attributeId';e={$_.AttributeID.value}}, @{n='value';e={$_.Value.value}} | Format-Table -AutoSize

"attribute count : $(@($final.Attributes).Count)   (step 3 had ____)"
"AUDITDATE still : $(($final.Attributes | Where-Object { $_.AttributeID.value -eq 'AUDITDATE' }).Value.value)"
"KW still        : $(($final.Attributes | Where-Object { $_.AttributeID.value -eq 'KW' }).Value.value)"
"GREENTAG now    : $(($final.Attributes | Where-Object { $_.AttributeID.value -eq 'GREENTAG' }).Value.value)"
```

**The answer that matters:**

| Outcome | Meaning | Consequence |
|---|---|---|
| `AUDITDATE` and `KW` **survive** | PUT **MERGES** | The design is safe as built. Omitting blanks protects hand-entered values. |
| `AUDITDATE` and `KW` are **gone or blank** | PUT **REPLACES** | **Stop.** The sync must read the current attributes first and send the full set back with only its own values changed, or it will erase things. That is a design change, not a tweak — report it before anything else. |

---

## Step 6 — a blank value, on purpose

We never send `""` (blanks are omitted). But knowing what `""` *does* tells us whether
"omit" and "send empty" are meaningfully different, which is the assumption the omission
rule rests on.

```powershell
$blank = @{
  id         = $ProjId
  Attributes = @( @{ AttributeID = @{ value = 'GREENTAG' }; Value = @{ value = '' } } )
} | ConvertTo-Json -Depth 6
[System.IO.File]::WriteAllText("$env:TEMP\attr-blank.json", $blank, $NoBom)
(Invoke-WebRequest -Method Put -Uri "$ApiRoot/Project" -Headers $H `
  -ContentType 'application/json' -InFile "$env:TEMP\attr-blank.json" -UseBasicParsing).StatusCode

$b = Invoke-RestMethod -Method Get -Uri "$ApiRoot/Project?`$filter=$f&`$expand=Attributes" -Headers $H
"GREENTAG after blank write: '$(($b.Attributes | Where-Object { $_.AttributeID.value -eq 'GREENTAG' }).Value.value)'"
```

**Expect:** it clears. If it clears, the omission rule is doing real work and the comment
in `buildProjectAttributes` is accurate.

---

## Step 7 — an unknown AttributeID

The sync sends a fixed list, but a template change could remove an attribute from a
project. Better to know now whether that is a loud failure or a silent no-op.

```powershell
$bogus = @{
  id         = $ProjId
  Attributes = @( @{ AttributeID = @{ value = 'NOTAREALATTR' }; Value = @{ value = 'x' } } )
} | ConvertTo-Json -Depth 6
[System.IO.File]::WriteAllText("$env:TEMP\attr-bogus.json", $bogus, $NoBom)
try {
  $r = Invoke-WebRequest -Method Put -Uri "$ApiRoot/Project" -Headers $H `
    -ContentType 'application/json' -InFile "$env:TEMP\attr-bogus.json" -UseBasicParsing
  "status: $($r.StatusCode)  <- 200 means unknown attributes are SILENTLY IGNORED"
} catch { "rejected: $($_.Exception.Message)  <- loud, which is better" }
```

**Either answer is useful.** Silently ignored means a template change could quietly stop
half the sync working, and the sync should verify its own writes by re-reading. Rejected
means Acumatica tells us, and it can be simpler.

---

## Step 8 — the full set, as the code would send it

Finally, the real thing: the thirteen attributes for a third-party job, exactly as
`buildProjectAttributes` produces them for R251282's numbers.

```powershell
$full = @{
  id         = $ProjId
  Attributes = @(
    @{ AttributeID = @{ value = 'AUDITDATE'  }; Value = @{ value = '2026-07-14' } }
    @{ AttributeID = @{ value = 'INDESIGN'   }; Value = @{ value = '2026-07-20' } }
    @{ AttributeID = @{ value = 'INCOMDATE'  }; Value = @{ value = '2026-08-01' } }
    @{ AttributeID = @{ value = 'GREENTAG'   }; Value = @{ value = '2026-08-10' } }
    @{ AttributeID = @{ value = 'COMDATE'    }; Value = @{ value = '2026-08-15' } }
    @{ AttributeID = @{ value = 'JOBTYPE'    }; Value = @{ value = 'RS' } }
    @{ AttributeID = @{ value = 'KW'         }; Value = @{ value = '12.76' } }
    @{ AttributeID = @{ value = 'SALESPERSO' }; Value = @{ value = 'Familia Sicairos' } }
    @{ AttributeID = @{ value = 'SLSCOM1'    }; Value = @{ value = '2500' } }
    @{ AttributeID = @{ value = 'SLSCOM2'    }; Value = @{ value = '4814' } }
    @{ AttributeID = @{ value = 'MGRCOM1'    }; Value = @{ value = '382.8' } }
    @{ AttributeID = @{ value = 'MGRCOM2'    }; Value = @{ value = '127.6' } }
    @{ AttributeID = @{ value = 'MGMTOR1'    }; Value = @{ value = '143.55' } }
    @{ AttributeID = @{ value = 'MGMTOR2'    }; Value = @{ value = '47.85' } }
  )
} | ConvertTo-Json -Depth 6

[System.IO.File]::WriteAllText("$env:TEMP\attr-full.json", $full, $NoBom)
(Invoke-WebRequest -Method Put -Uri "$ApiRoot/Project" -Headers $H `
  -ContentType 'application/json' -InFile "$env:TEMP\attr-full.json" -UseBasicParsing).StatusCode

$done = Invoke-RestMethod -Method Get -Uri "$ApiRoot/Project?`$filter=$f&`$expand=Attributes" -Headers $H
$done.Attributes | Select-Object @{n='attributeId';e={$_.AttributeID.value}}, @{n='value';e={$_.Value.value}} |
  Sort-Object attributeId | Format-Table -AutoSize
```

**Expect:** all fourteen present with those values. Note `SALESPERSO` — confirm a
free-text company name is accepted; if the attribute turns out to be a **selector** with a
controlled value list rather than plain text, an unrecognised dealer name will be rejected
and that changes the design.

---

## Step 9 — put it back

**ADDED 2026-08-24. This runbook has no dry run: every step above overwrites real values,
and step 3's output is the only record of what they were.** The 2026-08-24 run left
`R261065` carrying its test data because this step did not exist.

Restore from **your own step 3 output** — build the array from the table you recorded there,
send it as one PUT (step 5 proved a partial PUT merges, so one call is enough), and re-read
to confirm.

Attributes this run **created** cannot be un-created, only emptied — send `''`, which step 6
proved clears them.

```powershell
# EDIT THESE FROM YOUR OWN STEP 3 OUTPUT — the values below are the 2026-08-24 run's.
$restore = @{
  id         = $ProjId
  Attributes = @(
    @{ AttributeID = @{ value = 'AUDITDATE'  }; Value = @{ value = '2026-06-19' } }
    @{ AttributeID = @{ value = 'JOBTYPE'    }; Value = @{ value = 'RS' } }
    @{ AttributeID = @{ value = 'KW'         }; Value = @{ value = '8.360' } }
    @{ AttributeID = @{ value = 'SALESPERSO' }; Value = @{ value = 'Property Upgrades' } }
    @{ AttributeID = @{ value = 'SLSCOM1'    }; Value = @{ value = '1538.00' } }
    @{ AttributeID = @{ value = 'SLSCOM2'    }; Value = @{ value = '2138.00' } }
    @{ AttributeID = @{ value = 'MGRCOM1'    }; Value = @{ value = '250.80' } }
    @{ AttributeID = @{ value = 'MGRCOM2'    }; Value = @{ value = '83.60' } }
    @{ AttributeID = @{ value = 'MGMTOR1'    }; Value = @{ value = '94.05' } }
    @{ AttributeID = @{ value = 'MGMTOR2'    }; Value = @{ value = '31.35' } }
    # Created by this run; blank rather than restore.
    @{ AttributeID = @{ value = 'GREENTAG'   }; Value = @{ value = '' } }
    @{ AttributeID = @{ value = 'COMDATE'    }; Value = @{ value = '' } }
    @{ AttributeID = @{ value = 'INDESIGN'   }; Value = @{ value = '' } }
    @{ AttributeID = @{ value = 'INCOMDATE'  }; Value = @{ value = '' } }
  )
} | ConvertTo-Json -Depth 6

[System.IO.File]::WriteAllText("$env:TEMP\attr-restore.json", $restore, $NoBom)
(Invoke-WebRequest -Method Put -Uri "$ApiRoot/Project" -Headers $H `
  -ContentType 'application/json' -InFile "$env:TEMP\attr-restore.json" -UseBasicParsing).StatusCode

$back = Invoke-RestMethod -Method Get -Uri "$ApiRoot/Project?`$filter=$f&`$expand=Attributes" -Headers $H
$back.Attributes | Select-Object @{n='attributeId';e={$_.AttributeID.value}}, @{n='value';e={$_.Value.value}} |
  Sort-Object attributeId | Format-Table -AutoSize
```

---

## What to paste back

```
Step 2  tenant: ____   username: ____                    <- must say SANDBOX
Step 3  attribute count: ____   list: ____               <- KEEP THIS, step 9 restores from it
Step 3  any §7 attribute ABSENT (not just blank)? ____
Step 4  status: ____   AUDITDATE echoed as: '____'   KW: ____
Step 5  ⚠ MERGE OR REPLACE: AUDITDATE survived? ____  KW survived? ____  count now: ____
Step 6  blank write clears GREENTAG? ____
Step 7  unknown AttributeID -> ____ (200 silently ignored / rejected)
Step 8  all 14 present? ____   SALESPERSO accepted free text? ____
Step 9  restored?  ____
```

---

## Then

**Answered 2026-08-24 — see [§Results](#results).** Recording what each branch meant, since
the answers are what the wiring is built on:

- ~~**Step 5 says MERGE** → the builder is correct as written; wire the sync and move on.~~
  **This is the answer.** No read-modify-write needed.
- ~~**Step 5 says REPLACE** → the sync needs a read-modify-write cycle before it can be
  wired at all.~~ Did not happen.
- ~~If step 8 shows `SALESPERSO` is a controlled selector, the dealer name needs mapping to
  whatever value list it accepts.~~ It is free text. No second lookup table.

**What the answers added:** step 7's silent-ignore means the sync must **verify by re-read**
(comparing dates by date part, not by string) — see D24 in the rework doc.
## Results

**Run 2026-08-24 · project `R261065` · project guid `c35b87e7-636a-f111-bb0f-026107e8d2d9`.**

### Verdict: ✅ the question this runbook exists for is answered, and the answer is the good one.

**A partial `Attributes` PUT MERGES.** `AUDITDATE` and `KW` both survived a write that sent
only `GREENTAG`. The builder in `lib/acumatica-attributes.js` is correct as written, the
omit-blanks rule protects hand-entered values exactly as intended, and **no read-modify-write
redesign is needed.** Stage E's wiring is unblocked.

| Step | | Outcome |
|---|---|---|
| 2 — tenant proof | ⚠️→✅ | **Not run — the command does not work.** Settled out of band: BizRun is the sandbox, writes confirmed in both UIs (Q15). |
| 3 — read current | ✅ | 10 attributes. **4 of the 14 were ABSENT, not blank** — see below. |
| 4 — write two | ✅ | `200`. **ISO `2026-07-14` accepted**, echoed as `2026-07-14 00:00:00.000`. `KW` = `12.76`. |
| 5 — **merge or replace** | ✅ | **MERGE.** Count 10 → 11; `AUDITDATE` and `KW` untouched. And the PUT **created** `GREENTAG`. |
| 6 — blank value | ✅ | Clears. `GREENTAG` → `''`, and it is still returned. Omit ≠ send-empty. |
| 7 — unknown AttributeID | ⚠️ | `200`, **silently ignored**. Useful answer, and it has a consequence — see below. |
| 8 — full set | ✅ | All 14 present with the exact expected values. **`SALESPERSO` accepts free text.** |
| 9 — restore | ❌ | **No such step existed. R261065 is still carrying this run's test data.** Values to restore are below. |

---

### ✅ Step 5 — MERGE, and better than merge: a PUT can CREATE an attribute

The count went 10 → 11 and `GREENTAG` — which was **not in the step 3 list at all** —
appeared with its value. Step 8 then added `COMDATE`, `INDESIGN` and `INCOMDATE` the same
way, finishing at 14.

That answers the side-note in step 3, which flagged "can a PUT add an attribute the project
does not have" as a *different* question from "can it set one that is present but blank".
**Both are yes**, and step 6 is what makes the distinction provable: after the blank write,
`GREENTAG` came back as `''` rather than disappearing — so the API *does* return
empty-valued attributes, and the four missing from step 3 were genuinely absent rather than
merely empty.

**With one boundary, from step 7:** this only works for attributes the project's template
defines. `NOTAREALATTR` got a `200` and never appeared in the final list.

---

### ⚠️ Step 7 — a STANDING HAZARD: unknown AttributeIDs get a 200 and are discarded

An unknown `AttributeID` returns `200` and does nothing. Combined with step 5, the failure
mode is specific and quiet: **if a template change drops an attribute, the sync keeps
sending it, keeps getting `200`, and that value silently stops updating.** Nothing in the
response distinguishes "written" from "discarded".

**This is recorded as a standing hazard, not a one-off finding** — it is how the API
behaves, it will not change, and anything that writes attributes has to assume it.

**Consequence — the sync verifies by re-reading.** Approved and built:
`verifyAttributeWrite(sent, readBack)` in `lib/acumatica-attributes.js` returns `missing`
(accepted then discarded — the template does not define it here) and `mismatched` (present,
holding something else). Same create-then-verify discipline as the referral line and the
commission PO, from the same premise: a `200` is not evidence.

**Compare by DATE PART, not by string.** We send `2026-07-14`; Acumatica returns
`2026-07-14 00:00:00.000`. A naive string comparison would report all five lifecycle dates
as failed writes on every single run — and a check that always cries wolf gets switched
off, which is worse than not having one. `attributeValueMatches` handles it; `datePart()`
in the commission PO engine is the same fix for the same problem.

---

### ✅ Step 4 — the date format is fine, `formatAttributeValue` needs no change

`2026-07-14` was accepted as sent. The builder's decision to pass Salesforce's ISO date
through unreformatted — rather than reformatting and risking a timezone appearing in a
value that has none — holds.

---

### ✅ Step 8 — `SALESPERSO` is free text, so no second lookup table

It moved from `Property Upgrades` to `Familia Sicairos` and was accepted. It is **not** a
controlled selector, so an unrecognised dealer name will not be rejected and there is no
need for a value-list mapping in the shape of the D4 map. That was the other thing that
could have changed the design here, and it did not.

---

### ✅ Finding — our numbers were not formatted the way Harmon's are (Q17, fixed)

Every money attribute already in Acumatica carries two decimal places. Ours did not:

| Attribute | Already on R261065 | The sync wrote | **Now writes** |
|---|---|---|---|
| `SLSCOM1` / `SLSCOM2` | `1538.00` / `2138.00` | `2500` / `4814` | **`2500.00` / `4814.00`** |
| `MGRCOM1` / `MGRCOM2` | `250.80` / `83.60` | `382.8` / `127.6` | **`382.80` / `127.60`** |
| `MGMTOR1` / `MGMTOR2` | `94.05` / `31.35` | `143.55` / `47.85` | `143.55` / `47.85` |
| `KW` | `8.360` (three places) | `12.76` | **`12.760`** |

Attributes are **string-valued**, and step 8 proved Acumatica stores exactly what it is
given — `382.8` came back as `382.8`. So this was never a rounding difference, it was a
formatting one: `formatAttributeValue` used `String(v)`, which drops trailing zeros, and a
report would have shown `2500` sitting next to a hand-entered `1538.00`.

**Harmon ruled 2026-08-24: match the existing convention.** Implemented as
`ATTRIBUTE_DECIMALS` (money 2, KW 3) plus a `decimals` argument on `formatAttributeValue` —
per-attribute rather than one rule for all numbers, because Harmon's convention is not
uniform. A value that does not parse as a number is passed through rather than becoming
`NaN`.

> This also fixes the rework doc's claim that the builder "reproduces R251282's live
> commission attributes exactly". It now does so **textually**, which is what the sentence
> always implied; before the change the values were numerically identical and textually
> different, and the tests pinned the unpadded form.

---

### 🔎 Observation — R261065's existing SLSCOM values follow neither documented rule

`SLSCOM1 = 1538.00`, `SLSCOM2 = 2138.00`, total `3676`. The third-party rule would give
`min(1838, 2500) = 1838`; the internal 75/25 rule would give `2757`. Neither is `1538`.
(The manager and overhead pairs *do* check out: `250.80` / `83.60` is exactly 75/25 of
`334.40`, and `94.05` / `31.35` is 75/25 of `125.40`.)

**Ruled 2026-08-24: Harmon hand-enters these attributes today.** That is the explanation,
and it has a consequence worth stating plainly rather than discovering:

> **⚠️ On integration-managed jobs the sync is AUTHORITATIVE and will overwrite
> hand-entered commission attributes. That is intended — and it is a behaviour change
> Harmon should hear from us before it ships, not notice afterwards.**

It also retroactively justifies the omit-blanks rule and makes the merge answer matter more
than it looked: these are exactly the fields a REPLACE would have wiped, and we now know
they contain values no rule in this repo produced.

---

### ⚠️→✅ Step 2 was never run — but the writes landed in the sandbox (Q15, resolved)

`GET $ApiRoot/Company` returns `Entity Company not found`; there is no `Company` entity in
the `Default/25.200.001` endpoint, so the check could not have worked. **Corrected in the
step above** to read the tenant off the `client_id` suffix, which is authoritative.

It reads **`BizRun Tenant`**, which **is the sandbox** (Tim, 2026-08-24 — the original
handoff fact); the attribute writes on `R261065` were **confirmed in both UIs**. The
contradiction was in the docs: `sundial/acumatica/connected-app` is a **pointer** whose
contents change — BizRun through the rework, live at the end of the release window — and
two docs had each pinned it to a different tenant as though it were fixed. §1 of the rework
doc now describes it as a pointer, and neither "the live secret" nor "the sandbox secret"
should appear anywhere.

---

### ❌ Cleanup — R261065 is carrying this run's test data

There was no cleanup step; there is now (step 9). **These are the original values, and this
transcript is the only place they exist:**

| AttributeID | Restore to |
|---|---|
| `AUDITDATE` | `2026-06-19` |
| `JOBTYPE` | `RS` |
| `KW` | `8.360` |
| `SALESPERSO` | `Property Upgrades` |
| `SLSCOM1` / `SLSCOM2` | `1538.00` / `2138.00` |
| `MGRCOM1` / `MGRCOM2` | `250.80` / `83.60` |
| `MGMTOR1` / `MGMTOR2` | `94.05` / `31.35` |
| `GREENTAG`, `COMDATE`, `INDESIGN`, `INCOMDATE` | **blank** — they did not exist before this run and cannot be un-created, only emptied (step 6 proved `''` works) |

---

### What this unblocks, and what changed as a result

The merge answer means `lib/acumatica-attributes.js` needed **no structural change** — the
omit-blanks builder was right. Two rulings on 2026-08-24 did change it, and both came out
of this run:

- **Q17 — padding.** `ATTRIBUTE_DECIMALS`: money to 2 places, KW to 3.
- **Step 7 — verification.** `verifyAttributeWrite` / `attributeValueMatches` /
  `attributeDatePart`.

**And the sync is now wired.** `syncProjectAttributes` (PUT + verifying re-read, behind
`ATTR_GATE`) runs from the budget push worker after the budget lines are safely written.
**32 tests, up from 15.** See D24 in the rework doc and D-060 for the gate.

**One known gap, carried deliberately:** there is no `Attribute_Sync_Status__c` /
`_Error__c` pair — only the §4f *PO* fields were deployed. A failed attribute verification
therefore surfaces in the worker's note on `Budget_Push_Error__c` and in CloudWatch, which
is thinner than the PO side gets. That is the next field package, and it is exactly the
"a log line nobody reads" problem the §4f document argued against — worth fixing rather
than living with.

---

### Raw transcript — 2026-08-24

PS C:\Users\TimMurphy\Projects\sundial-core> $f = [uri]::EscapeDataString("ProjectID eq '$Project'")
PS C:\Users\TimMurphy\Projects\sundial-core> $proj = Invoke-RestMethod -Method Get -Uri "$ApiRoot/Project?`$filter=$f&`$expand=Attributes" -Headers $H
PS C:\Users\TimMurphy\Projects\sundial-core> $ProjId = $proj.id
PS C:\Users\TimMurphy\Projects\sundial-core> "project guid: $ProjId"
project guid: c35b87e7-636a-f111-bb0f-026107e8d2d9
PS C:\Users\TimMurphy\Projects\sundial-core> $proj.Attributes | Select-Object `
>>   @{n='id';e={$_.id}}, @{n='attributeId';e={$_.AttributeID.value}},
>>   @{n='desc';e={$_.Description.value}}, @{n='value';e={$_.Value.value}},
>>   @{n='valueDesc';e={$_.ValueDescription.value}} | Format-Table -AutoSize

id                                   attributeId desc value                   valueDesc
--                                   ----------- ---- -----                   ---------
d2e141df-8462-4580-a2c7-593832f4bcaf AUDITDATE        2026-06-19 00:00:00.000 2026-06-19 00:00:00.000
d981e4d9-6a5a-4da1-84a2-d2b3a4921610 JOBTYPE          RS                      Residential - Solar
5ec33faf-28ec-4f4a-96d7-3b11e6721b73 KW               8.360                   8.360
0314fc58-91dc-42a0-8256-0c2e708147f9 MGMTOR1          94.05                   94.05
1d459361-68aa-48a0-8607-7916b9fac5c7 MGMTOR2          31.35                   31.35
261b1e61-c3a5-4355-8df2-494c405a8645 MGRCOM1          250.80                  250.80
7a1dca05-d647-43c2-92ab-d8dd43dfed7d MGRCOM2          83.60                   83.60
e0171cb6-e515-49b0-8914-1ada5bfff47b SALESPERSO       Property Upgrades       Property Upgrades
bd510e7e-ce4a-4f39-84cc-baca8ad1abad SLSCOM1          1538.00                 1538.00
ede27c3d-8fce-4173-8e65-ad8b45d403df SLSCOM2          2138.00                 2138.00


PS C:\Users\TimMurphy\Projects\sundial-core> "attribute count: $(@($proj.Attributes).Count)"
attribute count: 10
PS C:\Users\TimMurphy\Projects\sundial-core> $body = @{
>>   id         = $ProjId
>>   Attributes = @(
>>     @{ AttributeID = @{ value = 'AUDITDATE' };  Value = @{ value = '2026-07-14' } }
>>     @{ AttributeID = @{ value = 'KW' };         Value = @{ value = '12.76' } }
>>   )
>> } | ConvertTo-Json -Depth 6
PS C:\Users\TimMurphy\Projects\sundial-core> [System.IO.File]::WriteAllText("$env:TEMP\attr-two.json", $body, $NoBom)
PS C:\Users\TimMurphy\Projects\sundial-core> Get-Content "$env:TEMP\attr-two.json"
{
    "id":  "c35b87e7-636a-f111-bb0f-026107e8d2d9",
    "Attributes":  [
                       {
                           "Value":  {
                                         "value":  "2026-07-14"
                                     },
                           "AttributeID":  {
                                               "value":  "AUDITDATE"
                                           }
                       },
                       {
                           "Value":  {
                                         "value":  "12.76"
                                     },
                           "AttributeID":  {
                                               "value":  "KW"
                                           }
                       }
                   ]
}
PS C:\Users\TimMurphy\Projects\sundial-core> (Invoke-WebRequest -Method Put -Uri "$ApiRoot/Project" -Headers $H `
>>   -ContentType 'application/json' -InFile "$env:TEMP\attr-two.json" -UseBasicParsing).StatusCode
200
PS C:\Users\TimMurphy\Projects\sundial-core> $after = Invoke-RestMethod -Method Get -Uri "$ApiRoot/Project?`$filter=$f&`$expand=Attributes" -Headers $H
PS C:\Users\TimMurphy\Projects\sundial-core> $after.Attributes | Where-Object { $_.AttributeID.value -in 'AUDITDATE','KW' } |
>>   Select-Object @{n='attributeId';e={$_.AttributeID.value}}, @{n='value';e={$_.Value.value}} | Format-Table

attributeId value
----------- -----
AUDITDATE   2026-07-14 00:00:00.000
KW          12.76


PS C:\Users\TimMurphy\Projects\sundial-core> $one = @{
>>   id         = $ProjId
>>   Attributes = @( @{ AttributeID = @{ value = 'GREENTAG' }; Value = @{ value = '2026-08-10' } } )
>> } | ConvertTo-Json -Depth 6
PS C:\Users\TimMurphy\Projects\sundial-core> [System.IO.File]::WriteAllText("$env:TEMP\attr-one.json", $one, $NoBom)
PS C:\Users\TimMurphy\Projects\sundial-core> (Invoke-WebRequest -Method Put -Uri "$ApiRoot/Project" -Headers $H `
>>   -ContentType 'application/json' -InFile "$env:TEMP\attr-one.json" -UseBasicParsing).StatusCode
200
PS C:\Users\TimMurphy\Projects\sundial-core> $final = Invoke-RestMethod -Method Get -Uri "$ApiRoot/Project?`$filter=$f&`$expand=Attributes" -Headers $H
PS C:\Users\TimMurphy\Projects\sundial-core> $final.Attributes | Select-Object `
>>   @{n='attributeId';e={$_.AttributeID.value}}, @{n='value';e={$_.Value.value}} | Format-Table -AutoSize

attributeId value
----------- -----
AUDITDATE   2026-07-14 00:00:00.000
GREENTAG    2026-08-10 00:00:00.000
JOBTYPE     RS
KW          12.76
MGMTOR1     94.05
MGMTOR2     31.35
MGRCOM1     250.80
MGRCOM2     83.60
SALESPERSO  Property Upgrades
SLSCOM1     1538.00
SLSCOM2     2138.00


PS C:\Users\TimMurphy\Projects\sundial-core> "attribute count : $(@($final.Attributes).Count)   (step 3 had ____)"
attribute count : 11   (step 3 had ____)
PS C:\Users\TimMurphy\Projects\sundial-core> "AUDITDATE still : $(($final.Attributes | Where-Object { $_.AttributeID.value -eq 'AUDITDATE' }).Value.value)"
AUDITDATE still : 2026-07-14 00:00:00.000
PS C:\Users\TimMurphy\Projects\sundial-core> "KW still        : $(($final.Attributes | Where-Object { $_.AttributeID.value -eq 'KW' }).Value.value)"
KW still        : 12.76
PS C:\Users\TimMurphy\Projects\sundial-core> "GREENTAG now    : $(($final.Attributes | Where-Object { $_.AttributeID.value -eq 'GREENTAG' }).Value.value)"
GREENTAG now    : 2026-08-10 00:00:00.000
PS C:\Users\TimMurphy\Projects\sundial-core> $blank = @{
>>   id         = $ProjId
>>   Attributes = @( @{ AttributeID = @{ value = 'GREENTAG' }; Value = @{ value = '' } } )
>> } | ConvertTo-Json -Depth 6
PS C:\Users\TimMurphy\Projects\sundial-core> [System.IO.File]::WriteAllText("$env:TEMP\attr-blank.json", $blank, $NoBom)

PS C:\Users\TimMurphy\Projects\sundial-core> (Invoke-WebRequest -Method Put -Uri "$ApiRoot/Project" -Headers $H `
>>   -ContentType 'application/json' -InFile "$env:TEMP\attr-blank.json" -UseBasicParsing).StatusCode
200
PS C:\Users\TimMurphy\Projects\sundial-core> $b = Invoke-RestMethod -Method Get -Uri "$ApiRoot/Project?`$filter=$f&`$expand=Attributes" -Headers $H
PS C:\Users\TimMurphy\Projects\sundial-core> "GREENTAG after blank write: '$(($b.Attributes | Where-Object { $_.AttributeID.value -eq 'GREENTAG' }).Value.value)'"
GREENTAG after blank write: ''
PS C:\Users\TimMurphy\Projects\sundial-core> $bogus = @{
>>   id         = $ProjId
>>   Attributes = @( @{ AttributeID = @{ value = 'NOTAREALATTR' }; Value = @{ value = 'x' } } )
>> } | ConvertTo-Json -Depth 6
PS C:\Users\TimMurphy\Projects\sundial-core> [System.IO.File]::WriteAllText("$env:TEMP\attr-bogus.json", $bogus, $NoBom)

PS C:\Users\TimMurphy\Projects\sundial-core> try {
>>   $r = Invoke-WebRequest -Method Put -Uri "$ApiRoot/Project" -Headers $H `
>>     -ContentType 'application/json' -InFile "$env:TEMP\attr-bogus.json" -UseBasicParsing
>>   "status: $($r.StatusCode)  <- 200 means unknown attributes are SILENTLY IGNORED"
>> } catch { "rejected: $($_.Exception.Message)  <- loud, which is better" }
status: 200  <- 200 means unknown attributes are SILENTLY IGNORED
PS C:\Users\TimMurphy\Projects\sundial-core> $full = @{
>>   id         = $ProjId
>>   Attributes = @(
>>     @{ AttributeID = @{ value = 'AUDITDATE'  }; Value = @{ value = '2026-07-14' } }
>>     @{ AttributeID = @{ value = 'INDESIGN'   }; Value = @{ value = '2026-07-20' } }
>>     @{ AttributeID = @{ value = 'INCOMDATE'  }; Value = @{ value = '2026-08-01' } }
>>     @{ AttributeID = @{ value = 'GREENTAG'   }; Value = @{ value = '2026-08-10' } }
>>     @{ AttributeID = @{ value = 'COMDATE'    }; Value = @{ value = '2026-08-15' } }
>>     @{ AttributeID = @{ value = 'JOBTYPE'    }; Value = @{ value = 'RS' } }
>>     @{ AttributeID = @{ value = 'KW'         }; Value = @{ value = '12.76' } }
>>     @{ AttributeID = @{ value = 'SALESPERSO' }; Value = @{ value = 'Familia Sicairos' } }
>>     @{ AttributeID = @{ value = 'SLSCOM1'    }; Value = @{ value = '2500' } }
>>     @{ AttributeID = @{ value = 'SLSCOM2'    }; Value = @{ value = '4814' } }
>>     @{ AttributeID = @{ value = 'MGRCOM1'    }; Value = @{ value = '382.8' } }
>>     @{ AttributeID = @{ value = 'MGRCOM2'    }; Value = @{ value = '127.6' } }
>>     @{ AttributeID = @{ value = 'MGMTOR1'    }; Value = @{ value = '143.55' } }
>>     @{ AttributeID = @{ value = 'MGMTOR2'    }; Value = @{ value = '47.85' } }
>>   )
>> } | ConvertTo-Json -Depth 6
PS C:\Users\TimMurphy\Projects\sundial-core> [System.IO.File]::WriteAllText("$env:TEMP\attr-full.json", $full, $NoBom)
PS C:\Users\TimMurphy\Projects\sundial-core> (Invoke-WebRequest -Method Put -Uri "$ApiRoot/Project" -Headers $H `
>>   -ContentType 'application/json' -InFile "$env:TEMP\attr-full.json" -UseBasicParsing).StatusCode
200
PS C:\Users\TimMurphy\Projects\sundial-core> $done = Invoke-RestMethod -Method Get -Uri "$ApiRoot/Project?`$filter=$f&`$expand=Attributes" -Headers $H
PS C:\Users\TimMurphy\Projects\sundial-core> $done.Attributes | Select-Object @{n='attributeId';e={$_.AttributeID.value}}, @{n='value';e={$_.Value.value}} |
>>   Sort-Object attributeId | Format-Table -AutoSize

attributeId value
----------- -----
AUDITDATE   2026-07-14 00:00:00.000
COMDATE     2026-08-15 00:00:00.000
GREENTAG    2026-08-10 00:00:00.000
INCOMDATE   2026-08-01 00:00:00.000
INDESIGN    2026-07-20 00:00:00.000
JOBTYPE     RS
KW          12.76
MGMTOR1     143.55
MGMTOR2     47.85
MGRCOM1     382.8
MGRCOM2     127.6
SALESPERSO  Familia Sicairos
SLSCOM1     2500
SLSCOM2     4814

