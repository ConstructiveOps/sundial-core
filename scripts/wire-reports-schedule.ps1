<#
.SYNOPSIS
    Puts scheduled report delivery live (D-091, Reporting R3):
      1. sundial-reports gets the email settings it needs to send (EMAIL_FROM, EMAIL_REPLY_TO,
         EMAIL_CONFIG_SET, SES_REGION), copied from a Lambda that already sends mail
         (sundial-comment-notify) when it does not have them yet. MERGED into its environment —
         update-function-configuration replaces the whole variable set, so every existing
         variable is read first and written back with them.
      2. An inline role policy "sundial-reports-schedule" on sundial-lambda-execution-role:
         ses:SendEmail (only SendEmail — lib/email.js never sends raw mail). put-role-policy
         adds or replaces THIS policy alone; the role's other policies are untouched.
      3. ONE EventBridge rule, sundial-reports-tick, cron(0/15 * * * ? *) — every quarter hour
         on the clock (:00 :15 :30 :45), so a 7:00 schedule goes at the 7:00 tick — invoking
         sundial-reports with { "task": "tick" }. No per-schedule AWS objects: the tick reads
         public.sundial_reports and queues whatever is due (at most 5 a tick).

.DESCRIPTION
    Idempotent (put-rule / put-targets overwrite; an existing Lambda permission is harmless).
    PRECONDITIONS, in this order:
      1. sql/2026-11-10_report_schedules.sql and sql/sundial_report_run.sql have been run.
      2. .\deploy.ps1 sundial-reports           (the R3 code)
      3. .\scripts\wire-reports-routes.ps1 -Yes (the routes)
    Needs events:PutRule / PutTargets / DescribeRule, lambda:AddPermission /
    GetFunctionConfiguration / UpdateFunctionConfiguration, iam:PutRolePolicy — the same admin
    credentials the other wire-*.ps1 scripts use.

.EXAMPLE
    .\scripts\wire-reports-schedule.ps1
#>
[CmdletBinding()]
param()

$ErrorActionPreference = "Continue"
$Region   = "us-west-1"
$Fn       = "sundial-reports"
$Source   = "sundial-comment-notify"   # a Lambda that already sends mail through lib/email.js
$Rule     = "sundial-reports-tick"
$Schedule = "cron(0/15 * * * ? *)"
$Role     = "sundial-lambda-execution-role"
$EmailVars = @("EMAIL_FROM", "EMAIL_REPLY_TO", "EMAIL_CONFIG_SET", "SES_REGION")

$Tmp = Join-Path $env:TEMP "sundial-reports-schedule-wire"
New-Item -ItemType Directory -Force $Tmp | Out-Null
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
function Write-Json($name, $obj) {
    $path = Join-Path $Tmp $name
    # -InputObject, not a pipe: PowerShell 5.1 unrolls a one-item array in a pipeline.
    [System.IO.File]::WriteAllText($path, (ConvertTo-Json -InputObject $obj -Depth 10 -Compress), $Utf8NoBom)
    return "file://$($path -replace '\\','/')"
}

Write-Host "==> Verifying $Fn exists..." -ForegroundColor Cyan
$fnCfg = aws lambda get-function-configuration --function-name $Fn --region $Region --output json | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or -not $fnCfg.FunctionArn) { throw "$Fn does not exist. Deploy it first: .\deploy.ps1 $Fn" }
Write-Host "  $($fnCfg.FunctionArn) (timeout $($fnCfg.Timeout) s, memory $($fnCfg.MemorySize) MB)" -ForegroundColor Green
if ($fnCfg.Timeout -lt 300) { Write-Host "  WARNING: timeout is $($fnCfg.Timeout) s; wire-reports-routes.ps1 sets 300 s. Run it first." -ForegroundColor Yellow }

# --- 1. Email settings (merged) ----------------------------------------------------------
Write-Host "==> Email settings on $Fn (copied from $Source where missing)" -ForegroundColor Cyan
$vars = @{}
if ($fnCfg.Environment -and $fnCfg.Environment.Variables) {
    foreach ($p in $fnCfg.Environment.Variables.PSObject.Properties) { $vars[$p.Name] = $p.Value }
}
$srcCfg = aws lambda get-function-configuration --function-name $Source --region $Region --output json | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw "could not read $Source's configuration" }
$changed = @()
foreach ($k in $EmailVars) {
    $have = $vars.ContainsKey($k) -and $vars[$k]
    $src = $null
    if ($srcCfg.Environment -and $srcCfg.Environment.Variables) { $src = $srcCfg.Environment.Variables.$k }
    if (-not $have -and $src) { $vars[$k] = $src; $changed += $k }
}
if (-not $vars["EMAIL_FROM"]) { throw "EMAIL_FROM is set on neither $Fn nor $Source - set it on $Fn by hand (the verified sundialcrm.com sender), then re-run." }
if ($changed.Count -gt 0) {
    $before = @($vars.Keys).Count
    $envFile = Write-Json "env.json" @{ Variables = $vars }
    aws lambda update-function-configuration --function-name $Fn --region $Region --environment $envFile --output json | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "update-function-configuration (environment) failed" }
    aws lambda wait function-updated --function-name $Fn --region $Region
    Write-Host "  added: $($changed -join ', ') ($before variables kept in all)" -ForegroundColor Green
} else {
    Write-Host "  already set: $(@($EmailVars | Where-Object { $vars[$_] }) -join ', ')" -ForegroundColor Green
}
Remove-Item (Join-Path $Tmp "env.json") -ErrorAction SilentlyContinue

# --- 2. SES permission --------------------------------------------------------------------
Write-Host "==> IAM: inline policy sundial-reports-schedule on $Role (ses:SendEmail)" -ForegroundColor Cyan
$policy = @{
    Version   = "2012-10-17"
    Statement = @(@{ Sid = "ScheduledReportEmail"; Effect = "Allow"; Action = "ses:SendEmail"; Resource = "*" })
}
$pf = Write-Json "policy.json" $policy
aws iam put-role-policy --role-name $Role --policy-name "sundial-reports-schedule" --policy-document $pf --output json | Out-Null
if ($LASTEXITCODE -ne 0) { throw "put-role-policy failed (need iam:PutRolePolicy)" }
Write-Host "  set (the role's other policies are unchanged)" -ForegroundColor Green

# --- 3. The tick --------------------------------------------------------------------------
Write-Host "==> EventBridge rule '$Rule' ($Schedule) -> $Fn { task: tick }" -ForegroundColor Cyan
$ruleOut = aws events put-rule --name $Rule --region $Region --schedule-expression $Schedule --state ENABLED `
    --description "Sundial reports: deliver scheduled reports that are due (D-091)" --output json | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or -not $ruleOut.RuleArn) { throw "events put-rule $Rule failed (need events:PutRule)" }
$ruleInput = @{ task = "tick" } | ConvertTo-Json -Compress
$targets = Write-Json "targets.json" @(@{ Id = $Fn; Arn = $fnCfg.FunctionArn; Input = $ruleInput })
aws events put-targets --rule $Rule --region $Region --targets $targets --output json | Out-Null
if ($LASTEXITCODE -ne 0) { throw "events put-targets $Rule failed (need events:PutTargets)" }
aws lambda add-permission --function-name $Fn --region $Region `
    --statement-id "events-$Rule" --action "lambda:InvokeFunction" `
    --principal events.amazonaws.com --source-arn $ruleOut.RuleArn --output json 2>$null | Out-Null
Write-Host "  in place (an 'already exists' permission error is harmless)" -ForegroundColor Green

# --- State at the end -----------------------------------------------------------------------
Write-Host "==> Rule state" -ForegroundColor Cyan
$d = aws events describe-rule --name $Rule --region $Region --output json | ConvertFrom-Json
$tg = aws events list-targets-by-rule --rule $Rule --region $Region --output json | ConvertFrom-Json
Write-Host ("  {0,-24} {1,-22} {2,-8} -> {3} input {4}" -f $d.Name, $d.ScheduleExpression, $d.State, ($tg.Targets[0].Arn -split ':')[-1], $tg.Targets[0].Input)
Write-Host ""
Write-Host "SUCCESS. Next: node scripts/verify-report-schedule.mjs" -ForegroundColor Green
