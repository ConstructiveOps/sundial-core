<#
.SYNOPSIS
    Wires The Cool Down (TCD) lead webhook and its daily report to the sundial-lead-intake
    Lambda (D-077), on the Sundial REST API (API Gateway 5sktfwldh1, us-west-1, stage prod):
      POST /webhooks/leads/tcd/{token}   a lead from TCD's website -> a Sundial Customer
      POST /webhooks/leads/tcd           (no slug) -> the Lambda's bare 404, never API Gateway's 403
    both throttled to 5 requests/second (burst 10) at the stage, plus the EventBridge rule
    `sundial-tcd-daily-report` that emails TCD the lead CSV at 6:00 AM Arizona.

    The rule is created (or re-put) DISABLED and enabled only after you answer "y" to the prod
    API deploy, so TCD can never get a report from a half-wired install. A "no" leaves it
    disabled and prints the command that enables it.

.DESCRIPTION
    Idempotent — re-running changes nothing that is already in place. No OPTIONS / CORS:
    TCD calls server-to-server. AWS_PROXY, authorization NONE at the gateway: the ONLY guard
    is the URL slug, which the Lambda compares (constant-time) to Secrets Manager
    `sundial/lead-webhooks`. The slug is a PATH PARAMETER here on purpose — it is never in
    this script or the repo, and a wrong slug reaches the Lambda (bare 404) instead of
    API Gateway answering "Missing Authentication Token" (which would confirm the route).

    PRECONDITIONS (TASKS.md, Tim's steps):
      1. Secret `sundial/lead-webhooks` = { "tcd": { "token": "<the slug handed to TCD>", "tenant": "harmon" } }
      2. The sundial-lead-intake Lambda exists (Node 22.x, arm64, index.handler, role
         sundial-lambda-execution-role, 30 s, 256 MB, env set) and is deployed:
         .\deploy.ps1 sundial-lead-intake

    Request body cap: API Gateway REST cannot cap a body below its fixed 10 MB, so the
    16 KB limit is enforced in the Lambda (413). JSON-only is enforced there too (415).

.EXAMPLE
    .\scripts\wire-lead-intake.ps1
    .\scripts\wire-lead-intake.ps1 -Yes
#>
[CmdletBinding()]
param([switch]$Yes)

$ErrorActionPreference = "Continue"
$Region = "us-west-1"
$ApiId  = "5sktfwldh1"
$Stage  = "prod"
$Fn     = "sundial-lead-intake"
$AcctId = "891377232720"
$Uri    = "arn:aws:apigateway:${Region}:lambda:path/2015-03-31/functions/arn:aws:lambda:${Region}:${AcctId}:function:${Fn}/invocations"
$RuleName = "sundial-tcd-daily-report"
# 13:00 UTC = 6:00 AM Arizona. Arizona is UTC-7 ALL YEAR (no daylight saving time), so
# this never drifts by an hour in summer or winter.
$Schedule = "cron(0 13 * * ? *)"
$RateLimit  = 5
$BurstLimit = 10

$TmpDir = Join-Path $env:TEMP "sundial-wire-lead-intake"
New-Item -ItemType Directory -Force -Path $TmpDir | Out-Null
$NoBom = New-Object System.Text.UTF8Encoding($false)

function Assert-LastExitOk($what) {
    if ($LASTEXITCODE -ne 0) { throw "$what failed (exit $LASTEXITCODE)." }
}
function Get-Resources { (aws apigateway get-resources --rest-api-id $ApiId --region $Region --limit 500 --output json | ConvertFrom-Json).items }
function Ensure-Resource($parentId, $part) {
    $ex = (Get-Resources | Where-Object { $_.parentId -eq $parentId -and $_.pathPart -eq $part }).id
    if ($ex) { Write-Host "  resource '$part' exists ($ex)"; return $ex }
    $c = aws apigateway create-resource --rest-api-id $ApiId --region $Region --parent-id $parentId --path-part $part --output json | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0 -or -not $c.id) { throw "create-resource '$part' failed (need apigateway:POST)" }
    Write-Host "  created resource '$part' ($($c.id))"
    return $c.id
}
function Wire-Method($resourceId, $method) {
    aws apigateway put-method --rest-api-id $ApiId --region $Region --resource-id $resourceId `
        --http-method $method --authorization-type NONE --no-api-key-required --output json 2>$null | Out-Null
    aws apigateway put-integration --rest-api-id $ApiId --region $Region --resource-id $resourceId `
        --http-method $method --type AWS_PROXY --integration-http-method POST --uri $Uri --output json | Out-Null
    Assert-LastExitOk "put-integration $method on $resourceId"
    Write-Host "  wired $method -> AWS_PROXY -> $Fn" -ForegroundColor Green
}

Write-Host "==> Verifying $Fn exists..." -ForegroundColor Cyan
$fnCfg = aws lambda get-function-configuration --function-name $Fn --region $Region --output json | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or -not $fnCfg.FunctionArn) { throw "$Fn does not exist yet. Create it in the Lambda console, deploy it, then re-run." }

$root = (Get-Resources | Where-Object { $_.path -eq "/" }).id
if (-not $root) { throw "Could not find root resource." }

Write-Host "==> /webhooks/leads/tcd and /webhooks/leads/tcd/{token} : POST" -ForegroundColor Cyan
$webhooks = Ensure-Resource $root "webhooks"
$leads    = Ensure-Resource $webhooks "leads"
$tcd      = Ensure-Resource $leads "tcd"
$token    = Ensure-Resource $tcd "{token}"
Wire-Method $tcd "POST"
Wire-Method $token "POST"

Write-Host "==> Lambda invoke permission (apigateway)" -ForegroundColor Cyan
aws lambda add-permission --function-name $Fn --region $Region `
    --statement-id "apigw-lead-webhooks" --action "lambda:InvokeFunction" `
    --principal apigateway.amazonaws.com --source-arn "arn:aws:execute-api:${Region}:${AcctId}:${ApiId}/*/POST/webhooks/leads/*" --output json 2>$null | Out-Null
Write-Host "  (an 'already exists' error here is harmless - permission is in place)" -ForegroundColor DarkGray

Write-Host "==> Stage throttle: $RateLimit rps / burst $BurstLimit on both POST methods" -ForegroundColor Cyan
# Method-setting paths escape "/" in the resource path as "~1". Passed as a no-BOM JSON
# file: the values contain braces and commas PowerShell would otherwise mangle.
$ops = @()
foreach ($p in @("/~1webhooks~1leads~1tcd/POST", "/~1webhooks~1leads~1tcd~1{token}/POST")) {
    $ops += @{ op = "replace"; path = "$p/throttling/rateLimit";  value = "$RateLimit" }
    $ops += @{ op = "replace"; path = "$p/throttling/burstLimit"; value = "$BurstLimit" }
}
$OpsFile = Join-Path $TmpDir "throttle-ops.json"
[System.IO.File]::WriteAllText($OpsFile, (ConvertTo-Json -InputObject $ops -Depth 3), $NoBom)
aws apigateway update-stage --rest-api-id $ApiId --region $Region --stage-name $Stage `
    --patch-operations "file://$OpsFile" --output json | Out-Null
Assert-LastExitOk "update-stage (throttle)"
Write-Host "  throttle set" -ForegroundColor Green

Write-Host "==> EventBridge schedule '$RuleName' ($Schedule = 6:00 AM Arizona) -> $Fn (DISABLED until the deploy)" -ForegroundColor Cyan
# --state DISABLED on every run: a re-run also parks an already-enabled rule until the "y" below.
$rule = aws events put-rule --name $RuleName --region $Region --schedule-expression $Schedule --state DISABLED `
    --description "Daily TCD lead-performance CSV to The Cool Down, 6:00 AM Arizona (D-077)" --output json | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or -not $rule.RuleArn) { throw "events put-rule failed (need events:PutRule)" }
$TargetsFile = Join-Path $TmpDir "targets.json"
$targets = @(@{ Id = $Fn; Arn = $fnCfg.FunctionArn; Input = '{"report":"tcd"}' })
[System.IO.File]::WriteAllText($TargetsFile, (ConvertTo-Json -InputObject $targets -Depth 3), $NoBom)
aws events put-targets --rule $RuleName --region $Region --targets "file://$TargetsFile" --output json | Out-Null
Assert-LastExitOk "events put-targets"
aws lambda add-permission --function-name $Fn --region $Region `
    --statement-id "events-tcd-daily-report" --action "lambda:InvokeFunction" `
    --principal events.amazonaws.com --source-arn $rule.RuleArn --output json 2>$null | Out-Null
Write-Host "  schedule in place, DISABLED: $($rule.RuleArn)" -ForegroundColor Green

$EnableCmd = "aws events enable-rule --name $RuleName --region $Region"
if (-not $Yes) {
    $ans = Read-Host "Deploy API to '$Stage' now and enable the daily report? LIVE production change. (y/N)"
    if ($ans -ne "y") {
        Write-Host "Routes created but NOT live until you deploy. The daily report is DISABLED." -ForegroundColor Yellow
        Write-Host "Re-run this script and answer y, or enable the report by hand after deploying:" -ForegroundColor Yellow
        Write-Host "  $EnableCmd" -ForegroundColor Yellow
        exit 0
    }
}
Write-Host "==> create-deployment -> $Stage" -ForegroundColor Cyan
aws apigateway create-deployment --rest-api-id $ApiId --region $Region --stage-name $Stage `
    --description "Add TCD lead webhook -> $Fn" --output json | Out-Null
Assert-LastExitOk "create-deployment"

Write-Host "==> Enabling '$RuleName'" -ForegroundColor Cyan
aws events enable-rule --name $RuleName --region $Region
Assert-LastExitOk "events enable-rule (the API IS deployed; enable by hand: $EnableCmd)"
Write-Host "  daily report ENABLED (next run 6:00 AM Arizona)" -ForegroundColor Green
Write-Host "SUCCESS. POST https://$ApiId.execute-api.$Region.amazonaws.com/$Stage/webhooks/leads/tcd/<slug> is live." -ForegroundColor Green
