<#
.SYNOPSIS
    Wires the report engine's routes on the Sundial REST API (API Gateway 5sktfwldh1,
    us-west-1, stage prod) to the sundial-reports Lambda (D-088, Reporting R1a):
      POST /reports/run        run a report definition against the cache
      GET  /reports/types      the report types
      GET  /reports/catalog    the fields a report type offers this caller (?type=solar)
    plus OPTIONS (204, CORS) on all three. AWS_PROXY, authorization NONE at the gateway — the
    Supabase JWT is checked IN the Lambda (action reports.read: Executive / Admin / Manager).

.DESCRIPTION
    Idempotent (same conventions as wire-dealer-routes.ps1). PRECONDITIONS, in order
    (TASKS.md, Reporting R1a):
      1. sql/2026-11-03_report_catalog.sql and sql/sundial_report_run.sql have been run in
         the Supabase SQL editor.
      2. The sundial-reports Lambda exists (the aws lambda create-function command in
         TASKS.md) and is deployed: .\deploy.ps1 sundial-reports
      3. sundial-auth-proxy has been redeployed (.\deploy.ps1 sundial-auth-proxy) so
         /auth/me advertises reports.read in access.actions.

.EXAMPLE
    .\scripts\wire-reports-routes.ps1
    .\scripts\wire-reports-routes.ps1 -Yes
#>
[CmdletBinding()]
param([switch]$Yes)

$ErrorActionPreference = "Continue"
$Region = "us-west-1"
$ApiId  = "5sktfwldh1"
$Stage  = "prod"
$Fn     = "sundial-reports"
$AcctId = "891377232720"
$Uri    = "arn:aws:apigateway:${Region}:lambda:path/2015-03-31/functions/arn:aws:lambda:${Region}:${AcctId}:function:${Fn}/invocations"

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
    if ($LASTEXITCODE -ne 0) { throw "put-integration $method failed on $resourceId" }
    Write-Host "  wired $method -> AWS_PROXY -> $Fn" -ForegroundColor Green
}

Write-Host "==> Verifying $Fn exists..." -ForegroundColor Cyan
$fnCfg = aws lambda get-function-configuration --function-name $Fn --region $Region --output json | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or -not $fnCfg.FunctionArn) { throw "$Fn does not exist yet. Run the create-function command in TASKS.md, deploy it, then re-run." }

$root = (Get-Resources | Where-Object { $_.path -eq "/" }).id
if (-not $root) { throw "Could not find root resource." }

$reports = Ensure-Resource $root "reports"

Write-Host "==> /reports/run : POST, OPTIONS" -ForegroundColor Cyan
$run = Ensure-Resource $reports "run"
foreach ($m in @("POST", "OPTIONS")) { Wire-Method $run $m }

Write-Host "==> /reports/types : GET, OPTIONS" -ForegroundColor Cyan
$types = Ensure-Resource $reports "types"
foreach ($m in @("GET", "OPTIONS")) { Wire-Method $types $m }

Write-Host "==> /reports/catalog : GET, OPTIONS" -ForegroundColor Cyan
$catalog = Ensure-Resource $reports "catalog"
foreach ($m in @("GET", "OPTIONS")) { Wire-Method $catalog $m }

Write-Host "==> Lambda invoke permission (apigateway)" -ForegroundColor Cyan
aws lambda add-permission --function-name $Fn --region $Region `
    --statement-id "apigw-reports" --action "lambda:InvokeFunction" `
    --principal apigateway.amazonaws.com --source-arn "arn:aws:execute-api:${Region}:${AcctId}:${ApiId}/*/*/reports/*" --output json 2>$null | Out-Null
Write-Host "  (an 'already exists' error here is harmless - permission is in place)" -ForegroundColor DarkGray

if (-not $Yes) {
    $ans = Read-Host "Deploy API to '$Stage' now? LIVE production change. (y/N)"
    if ($ans -ne "y") { Write-Host "Routes created but NOT live until you deploy." -ForegroundColor Yellow; exit 0 }
}
Write-Host "==> create-deployment -> $Stage" -ForegroundColor Cyan
aws apigateway create-deployment --rest-api-id $ApiId --region $Region --stage-name $Stage `
    --description "Add report engine routes -> $Fn" --output json | Out-Null
if ($LASTEXITCODE -ne 0) { throw "create-deployment failed" }
Write-Host "SUCCESS. Next: node scripts/verify-report-run.mjs" -ForegroundColor Green
