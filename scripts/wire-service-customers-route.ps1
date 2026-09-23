<#
.SYNOPSIS
    Wires POST /service/customers (+ OPTIONS) on the Sundial REST API (API Gateway
    5sktfwldh1, us-west-1, stage prod) to the sundial-service-estimate Lambda — the
    Service module's own New Customer / Add to Service (2026-09-23, D-075,
    docs/service-customer-layout.md).

.DESCRIPTION
    Idempotent (same conventions as wire-service-estimate-routes.ps1). The Lambda's
    invoke permission for /service/* already exists from that script. PRECONDITIONS:
      1. salesforce/service-customer-2026-09-23/ deployed (the four Service_* fields) —
         without it the route still creates the customer and answers with a warning.
      2. .\deploy.ps1 sundial-service-estimate has been run with the 2026-09-23 code.

.EXAMPLE
    .\scripts\wire-service-customers-route.ps1
    .\scripts\wire-service-customers-route.ps1 -Yes
#>
[CmdletBinding()]
param([switch]$Yes)

$ErrorActionPreference = "Continue"
$Region = "us-west-1"
$ApiId  = "5sktfwldh1"
$Stage  = "prod"
$Fn     = "sundial-service-estimate"
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
aws lambda get-function-configuration --function-name $Fn --region $Region --output json | Out-Null
if ($LASTEXITCODE -ne 0) { throw "$Fn does not exist." }

$root = (Get-Resources | Where-Object { $_.path -eq "/" }).id
if (-not $root) { throw "Could not find root resource." }

$service   = Ensure-Resource $root "service"
Write-Host "==> /service/customers : POST, OPTIONS" -ForegroundColor Cyan
$customers = Ensure-Resource $service "customers"
foreach ($m in @("POST", "OPTIONS")) { Wire-Method $customers $m }

Write-Host "==> Lambda invoke permission (apigateway) - the /service/* statement from wire-service-estimate-routes.ps1 covers these" -ForegroundColor Cyan
aws lambda add-permission --function-name $Fn --region $Region `
    --statement-id "apigw-service-estimate" --action "lambda:InvokeFunction" `
    --principal apigateway.amazonaws.com --source-arn "arn:aws:execute-api:${Region}:${AcctId}:${ApiId}/*/*/service/*" --output json 2>$null | Out-Null
Write-Host "  (an 'already exists' error here is harmless - permission is in place)" -ForegroundColor DarkGray

if (-not $Yes) {
    $ans = Read-Host "Deploy API to '$Stage' now? LIVE production change. (y/N)"
    if ($ans -ne "y") { Write-Host "Routes created but NOT live until you deploy." -ForegroundColor Yellow; exit 0 }
}
Write-Host "==> create-deployment -> $Stage" -ForegroundColor Cyan
aws apigateway create-deployment --rest-api-id $ApiId --region $Region --stage-name $Stage `
    --description "Add POST /service/customers (Service New Customer) -> $Fn" --output json | Out-Null
if ($LASTEXITCODE -ne 0) { throw "create-deployment failed" }
Write-Host "SUCCESS. POST https://$ApiId.execute-api.$Region.amazonaws.com/$Stage/service/customers is live." -ForegroundColor Green
