<#
.SYNOPSIS
    Wires the Payroll tab's fix routes on the Sundial REST API (2026-10-12):

      PUT    /service/payroll/outside   set a tech's Time Outside Calls for the week (Admin / Executive)
      DELETE /service/payroll/outside   clear it (the arithmetic is back)
      GET    /service/calls/{id}        one call as the board sees it (the Fix time editor's input)

    All three -> sundial-service-board (AWS_PROXY). Run AFTER:
      1. sql/2026-10-12_payroll_adjustments.sql in the Supabase SQL editor
      2. .\deploy.ps1 sundial-service-board
    (and lib/access.js gained service.payroll.write — /auth/me advertises it; the portal shows
    the buttons only to Admin / Executive).

.EXAMPLE
    .\scripts\wire-payroll-fix-routes.ps1
    .\scripts\wire-payroll-fix-routes.ps1 -Yes
#>
[CmdletBinding()]
param([switch]$Yes)

$ErrorActionPreference = "Continue"
$Region = "us-west-1"
$ApiId  = "5sktfwldh1"
$Stage  = "prod"
$AcctId = "891377232720"
$Board  = "sundial-service-board"
function Uri-For($fn) { "arn:aws:apigateway:${Region}:lambda:path/2015-03-31/functions/arn:aws:lambda:${Region}:${AcctId}:function:${fn}/invocations" }

function Get-Resources { (aws apigateway get-resources --rest-api-id $ApiId --region $Region --limit 500 --output json | ConvertFrom-Json).items }
function Ensure-Resource($parentId, $part) {
    $ex = (Get-Resources | Where-Object { $_.parentId -eq $parentId -and $_.pathPart -eq $part }).id
    if ($ex) { Write-Host "  resource '$part' exists ($ex)"; return $ex }
    $c = aws apigateway create-resource --rest-api-id $ApiId --region $Region --parent-id $parentId --path-part $part --output json | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0 -or -not $c.id) { throw "create-resource '$part' failed (need apigateway:POST)" }
    Write-Host "  created resource '$part' ($($c.id))"
    return $c.id
}
function Wire-Method($resourceId, $method, $fn) {
    aws apigateway put-method --rest-api-id $ApiId --region $Region --resource-id $resourceId `
        --http-method $method --authorization-type NONE --no-api-key-required --output json 2>$null | Out-Null
    aws apigateway put-integration --rest-api-id $ApiId --region $Region --resource-id $resourceId `
        --http-method $method --type AWS_PROXY --integration-http-method POST --uri (Uri-For $fn) --output json | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "put-integration $method failed on $resourceId" }
    Write-Host "  wired $method -> AWS_PROXY -> $fn" -ForegroundColor Green
}

Write-Host "==> Verifying $Board exists..." -ForegroundColor Cyan
aws lambda get-function-configuration --function-name $Board --region $Region --output json | Out-Null
if ($LASTEXITCODE -ne 0) { throw "$Board does not exist. Deploy it first." }

$root = (Get-Resources | Where-Object { $_.path -eq "/" }).id
if (-not $root) { throw "Could not find root resource." }
$service = Ensure-Resource $root "service"

Write-Host "==> /service/payroll/outside : PUT, DELETE, OPTIONS -> $Board" -ForegroundColor Cyan
$pay     = Ensure-Resource $service "payroll"
$outside = Ensure-Resource $pay "outside"
foreach ($m in @("PUT", "DELETE", "OPTIONS")) { Wire-Method $outside $m $Board }

Write-Host "==> /service/calls/{id} : GET (PATCH + OPTIONS already there) -> $Board" -ForegroundColor Cyan
$calls  = Ensure-Resource $service "calls"
$callId = Ensure-Resource $calls "{id}"
foreach ($m in @("GET", "OPTIONS")) { Wire-Method $callId $m $Board }

Write-Host "==> Lambda invoke permission (apigateway)" -ForegroundColor Cyan
aws lambda add-permission --function-name $Board --region $Region `
    --statement-id "apigw-service-board" --action "lambda:InvokeFunction" `
    --principal apigateway.amazonaws.com --source-arn "arn:aws:execute-api:${Region}:${AcctId}:${ApiId}/*/*/service/*" --output json 2>$null | Out-Null
Write-Host "  (an 'already exists' error here is harmless - permission is in place)" -ForegroundColor DarkGray

if (-not $Yes) {
    $ans = Read-Host "Deploy API to '$Stage' now? LIVE production change. (y/N)"
    if ($ans -ne "y") { Write-Host "Routes created but NOT live until you deploy." -ForegroundColor Yellow; exit 0 }
}
Write-Host "==> create-deployment -> $Stage" -ForegroundColor Cyan
aws apigateway create-deployment --rest-api-id $ApiId --region $Region --stage-name $Stage `
    --description "Add payroll outside-time + GET call routes -> $Board" --output json | Out-Null
if ($LASTEXITCODE -ne 0) { throw "create-deployment failed" }
Write-Host "SUCCESS. Payroll fix routes are live." -ForegroundColor Green
