<#
.SYNOPSIS
    Puts sundial-cache-sync on a schedule (D-079): two EventBridge rules, one per tier.
      sundial-cache-sync-incremental       rate(5 minutes)   customer, solar, job, estimate, servicecall, serviceinvoice
      sundial-cache-sync-incremental-cold  rate(30 minutes)  roofing, po, user, pricebookitem, serviceline, servicepayment, serviceplan, membership
    Each rule passes its own input: { "objects": [...], "intervalMinutes": 5 | 30 }.
    The Lambda records the interval on every cache_sync_runs row, and sundial-sf-query
    judges each object by ITS OWN schedule (healthy = last ok run within 3 x interval),
    so a 30-minute object is never judged by the 5-minute bar.

.DESCRIPTION
    Idempotent (put-rule / put-targets overwrite; an existing Lambda permission is
    harmless). PRECONDITIONS, in this order:
      1. sql/sundial_cache_sync_runs.sql has been run in the Supabase SQL editor.
      2. .\deploy.ps1 sundial-cache-sync   (writes the run rows, reads the rule input)
      3. .\deploy.ps1 sundial-sf-query     (reads the run rows; until a run exists it
                                            keeps the old 10-minute rule, so deploying
                                            it first is safe)

    ONE-TIME FULL RESYNC (offered first, answer y the first time): customer, solar and
    roofing are re-read from Salesforce in full BEFORE the rules exist. The moment the
    first scheduled run finishes, sundial-sf-query starts trusting the cache instead of
    re-checking rows older than 10 minutes, so any row that drifted before the schedule
    existed must be corrected first. Each full run takes a few minutes (customer is the
    long one, ~39k rows).

    API cost (D-079 runbook): 6 hot objects x 288 runs/day + 8 cold objects x 48 runs/day
    = 1,728 + 384 = ~2,112 Salesforce queries a day when nothing changes (one query per
    object per run, no cache writes). Before: ~2,300 a day for the customer list alone.

    Needs events:PutRule, events:PutTargets, events:DescribeRule, lambda:AddPermission,
    lambda:InvokeFunction — the same admin credentials the other wire-*.ps1 scripts use.

.EXAMPLE
    .\scripts\wire-cache-sync-schedule.ps1
    .\scripts\wire-cache-sync-schedule.ps1 -SkipResync
#>
[CmdletBinding()]
param([switch]$SkipResync)

$ErrorActionPreference = "Continue"
$Region = "us-west-1"
$Fn     = "sundial-cache-sync"

# The two tiers. Keep in step with docs/caching-architecture.md (§ "Freshness is the
# sync job's health"). An object in neither list is never synced on a schedule.
$Tiers = @(
    @{ Rule = "sundial-cache-sync-incremental";      Rate = "rate(5 minutes)";  Minutes = 5;
       Objects = @("customer", "solar", "job", "estimate", "servicecall", "serviceinvoice") },
    @{ Rule = "sundial-cache-sync-incremental-cold"; Rate = "rate(30 minutes)"; Minutes = 30;
       Objects = @("roofing", "po", "user", "pricebookitem", "serviceline", "servicepayment", "serviceplan", "membership") }
)

# JSON with commas cannot go through the AWS CLI's shorthand syntax from PowerShell;
# write it to a no-BOM file and pass file:// (see the AWS CLI quoting note).
$Tmp = Join-Path $env:TEMP "sundial-cache-sync-wire"
New-Item -ItemType Directory -Force $Tmp | Out-Null
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
function Write-Json($name, $obj) {
    $path = Join-Path $Tmp $name
    # -InputObject, not a pipe: PowerShell 5.1 unrolls a one-item array in a pipeline
    # and put-targets would get an object instead of the list it needs.
    [System.IO.File]::WriteAllText($path, (ConvertTo-Json -InputObject $obj -Depth 10 -Compress), $Utf8NoBom)
    return "file://$($path -replace '\\','/')"
}

Write-Host "==> Verifying $Fn exists..." -ForegroundColor Cyan
$fnCfg = aws lambda get-function-configuration --function-name $Fn --region $Region --output json | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or -not $fnCfg.FunctionArn) { throw "$Fn does not exist. Deploy it first: .\deploy.ps1 $Fn" }
Write-Host "  $($fnCfg.FunctionArn) (timeout $($fnCfg.Timeout) s)" -ForegroundColor Green

# --- One-time full resync (before the rules) ----------------------------------------
if (-not $SkipResync) {
    $ans = Read-Host "Run the one-time FULL resync of customer, solar and roofing now (recommended the first time)? (y/N)"
    if ($ans -eq "y") {
        foreach ($obj in @("customer", "solar", "roofing")) {
            Write-Host "==> Full resync: $obj (this can take a few minutes)..." -ForegroundColor Cyan
            $payload = Write-Json "full-$obj.json" @{ mode = "full"; object = $obj }
            $out = Join-Path $Tmp "full-$obj-out.json"
            aws lambda invoke --function-name $Fn --region $Region --cli-binary-format raw-in-base64-out `
                --cli-read-timeout 0 --payload $payload $out --output json | Out-Null
            if ($LASTEXITCODE -ne 0) { throw "full resync of $obj failed to invoke" }
            $res = Get-Content $out -Raw | ConvertFrom-Json
            $o = $res.objects.$obj
            if ($o.status -ne "ok") { throw "full resync of $obj did not finish ok: $($o.status) $($o.error)" }
            Write-Host "  $obj ok: $($o.processed) rows re-read from Salesforce" -ForegroundColor Green
        }
    } else {
        Write-Host "  skipped (re-run without -SkipResync to be asked again)" -ForegroundColor Yellow
    }
}

# --- The two rules ------------------------------------------------------------------
foreach ($t in $Tiers) {
    $name = $t.Rule
    Write-Host "==> EventBridge rule '$name' ($($t.Rate)) -> $Fn : $($t.Objects -join ', ')" -ForegroundColor Cyan
    $rule = aws events put-rule --name $name --region $Region --schedule-expression $t.Rate --state ENABLED `
        --description "Sundial cache: incremental sync every $($t.Minutes) min (D-079)" --output json | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0 -or -not $rule.RuleArn) { throw "events put-rule $name failed (need events:PutRule)" }

    $ruleInput = @{ objects = $t.Objects; intervalMinutes = $t.Minutes } | ConvertTo-Json -Compress
    $targets = Write-Json "targets-$name.json" @(@{ Id = $Fn; Arn = $fnCfg.FunctionArn; Input = $ruleInput })
    aws events put-targets --rule $name --region $Region --targets $targets --output json | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "events put-targets $name failed (need events:PutTargets)" }

    aws lambda add-permission --function-name $Fn --region $Region `
        --statement-id "events-$name" --action "lambda:InvokeFunction" `
        --principal events.amazonaws.com --source-arn $rule.RuleArn --output json 2>$null | Out-Null
    Write-Host "  in place (an 'already exists' permission error is harmless)" -ForegroundColor Green
}

# --- State at the end -----------------------------------------------------------------
Write-Host "==> Rule state" -ForegroundColor Cyan
foreach ($t in $Tiers) {
    $d = aws events describe-rule --name $t.Rule --region $Region --output json | ConvertFrom-Json
    $tg = aws events list-targets-by-rule --rule $t.Rule --region $Region --output json | ConvertFrom-Json
    Write-Host ("  {0,-38} {1,-18} {2,-8} input {3}" -f $d.Name, $d.ScheduleExpression, $d.State, $tg.Targets[0].Input)
}
Write-Host ""
Write-Host "Within 5 minutes, check in the Supabase SQL editor:" -ForegroundColor Green
Write-Host "  select distinct on (object) object, ok, finished_at, expected_interval_s from cache_sync_runs where mode = 'incremental' order by object, finished_at desc;"
