# Sandbox hand-proof — writing Project attributes (Stage E)

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

```powershell
"client_id : $($secret.client_id)"
"username  : $($secret.username)"
Invoke-RestMethod -Method Get -Uri "$ApiRoot/Company" -Headers $H |
  Select-Object @{n='companyId';e={$_.CompanyID.value}}, @{n='name';e={$_.CompanyName.value}}
```

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

## What to paste back

```
Step 2  tenant        client_id: ____   company: ____     <- must both say SANDBOX
Step 3  attribute count: ____   list: ____
Step 3  any §7 attribute ABSENT (not just blank)? ____
Step 4  status: ____   AUDITDATE echoed as: '____'   KW: ____
Step 5  ⚠ MERGE OR REPLACE: AUDITDATE survived? ____  KW survived? ____  count now: ____
Step 6  blank write clears GREENTAG? ____
Step 7  unknown AttributeID -> ____ (200 silently ignored / rejected)
Step 8  all 14 present? ____   SALESPERSO accepted free text? ____
```

---

## Then

- **Step 5 says MERGE** → the builder is correct as written; wire the sync and move on.
- **Step 5 says REPLACE** → the sync needs a read-modify-write cycle before it can be
  wired at all. Report before any code changes; that is a design decision, not a fix.
- If step 8 shows `SALESPERSO` is a controlled selector, the dealer name needs mapping to
  whatever value list it accepts — a second lookup table, in the shape of the D4 map.

Record the results in a §Results section here, the same way the referral-line runbook
does, and note the tenant-identity output alongside them.
