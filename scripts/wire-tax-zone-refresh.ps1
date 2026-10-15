<#
.SYNOPSIS
    Puts the Acumatica tax-table refresh on a schedule (D-083): ONE EventBridge rule,
      sundial-cache-sync-taxzones   cron(0 12 * * ? *)  = 5:00 AM Arizona, every day
    targeting sundial-cache-sync with { "task": "taxzones", "intervalMinutes": 1440 }.
    The Lambda pulls TaxZone / Tax / TaxCategory from Acumatica (read-only GETs), rewrites
    the sundial_tax_* tables and logs one cache_sync_runs row (object = 'taxzones').

.DESCRIPTION
    Idempotent (put-rule / put-targets overwrite; an existing permission is harmless).
    PRECONDITIONS, in this order:
      1. sql/sundial_tax_zones.sql has been run in the Supabase SQL editor.
      2. node scripts/seed-tax-zones.mjs --apply   (the first copy)
      3. .\deploy.ps1 sundial-cache-sync           (knows the "taxzones" task)
      4. sundial-cache-sync's role may read the secret sundial/acumatica/connected-app
         (the script checks by invoking once and stops if the run is not ok).

    Needs events:PutRule, events:PutTargets, lambda:AddPermission, lambda:InvokeFunction —
    the same admin credentials the other wire-*.ps1 scripts use.

.EXAMPLE
    .\scripts\wire-tax-zone-refresh.ps1
#>
[CmdletBinding()]
param()

$ErrorActionPreference = "Continue"
$Region = "us-west-1"
$Fn     = "sundial-cache-sync"
$Rule   = "sundial-cache-sync-taxzones"
$Cron   = "cron(0 12 * * ? *)"   # 12:00 UTC = 5:00 AM Arizona (no daylight saving)

$Tmp = Join-Path $env:TEMP "sundial-taxzones-wire"
New-Item -ItemType Directory -Force $Tmp | Out-Null
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
function Write-Json($name, $obj) {
    $path = Join-Path $Tmp $name
    [System.IO.File]::WriteAllText($path, (ConvertTo-Json -InputObject $obj -Depth 10 -Compress), $Utf8NoBom)
    return "file://$($path -replace '\\','/')"
}

Write-Host "==> Verifying $Fn exists..." -ForegroundColor Cyan
$fnCfg = aws lambda get-function-configuration --function-name $Fn --region $Region --output json | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or -not $fnCfg.FunctionArn) { throw "$Fn does not exist. Deploy it first: .\deploy.ps1 $Fn" }

# One real run first: proves the deploy knows the task AND the role can read the Acumatica secret.
Write-Host "==> Test run: { task: taxzones } ..." -ForegroundColor Cyan
$payload = Write-Json "test.json" @{ task = "taxzones" }
$out = Join-Path $Tmp "test-out.json"
aws lambda invoke --function-name $Fn --region $Region --cli-binary-format raw-in-base64-out `
    --cli-read-timeout 0 --payload $payload $out --output json | Out-Null
if ($LASTEXITCODE -ne 0) { throw "invoke failed" }
$res = Get-Content $out -Raw | ConvertFrom-Json
if ($res.status -ne "ok") { throw "the refresh did not finish ok: $($res.error). If it names the secret, give the $Fn role secretsmanager:GetSecretValue on sundial/acumatica/connected-app." }
Write-Host "  ok: $($res.zones) zones, $($res.taxes) taxes, $($res.categories) categories" -ForegroundColor Green

Write-Host "==> EventBridge rule '$Rule' ($Cron) -> $Fn" -ForegroundColor Cyan
$r = aws events put-rule --name $Rule --region $Region --schedule-expression $Cron --state ENABLED `
    --description "Sundial: Acumatica tax tables, daily (D-083)" --output json | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or -not $r.RuleArn) { throw "events put-rule failed (need events:PutRule)" }
$ruleInput = @{ task = "taxzones"; intervalMinutes = 1440 } | ConvertTo-Json -Compress
$targets = Write-Json "targets.json" @(@{ Id = $Fn; Arn = $fnCfg.FunctionArn; Input = $ruleInput })
aws events put-targets --rule $Rule --region $Region --targets $targets --output json | Out-Null
if ($LASTEXITCODE -ne 0) { throw "events put-targets failed (need events:PutTargets)" }
aws lambda add-permission --function-name $Fn --region $Region `
    --statement-id "events-$Rule" --action "lambda:InvokeFunction" `
    --principal events.amazonaws.com --source-arn $r.RuleArn --output json 2>$null | Out-Null

$d = aws events describe-rule --name $Rule --region $Region --output json | ConvertFrom-Json
Write-Host ("  {0}  {1}  {2}" -f $d.Name, $d.ScheduleExpression, $d.State) -ForegroundColor Green
Write-Host ""
Write-Host "Check tomorrow in the Supabase SQL editor:" -ForegroundColor Green
Write-Host "  select ok, finished_at, rows_upserted, error from public.cache_sync_runs where object = 'taxzones' order by started_at desc limit 3;"
