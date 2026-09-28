<#
.SYNOPSIS
    Wires the day-clock, tech-locations and payroll routes on the Sundial REST API
    (API Gateway 5sktfwldh1, us-west-1, stage prod) - D-076, 2026-09-28, all on
    sundial-service-board:
      POST /service/tech/day/start      clock in for the day (the warehouse tap)
      POST /service/tech/day/end        clock out for the day (+ the house-hours note)
      POST /service/tech/day/note       rewrite the day's note
      GET  /service/techs/locations     every tech's last clocked spot (the dispatch map)
      GET  /service/payroll             the weekly payroll report (Admin / Executive)
    plus OPTIONS for CORS on every resource. AWS_PROXY, authorization NONE at the gateway -
    the Supabase JWT is checked in the Lambda (actions service.tech.self / service.board.read /
    service.payroll.read).

.DESCRIPTION
    Idempotent (same conventions as wire-service-tech-routes.ps1). PRECONDITIONS:
      1. Workbench: salesforce/tech-day-2026-09-28 deployed, Sundial_Tech_Day assigned to the
         integration user.
      2. .\deploy.ps1 sundial-service-board ; .\deploy.ps1 sundial-auth-proxy  (lib/access.js
         gained service.payroll.read - /auth/me must advertise it or the portal hides the page).
    /service/tech/day already exists from the tech app wiring; this adds its three children.

.EXAMPLE
    .\scripts\wire-tech-day-routes.ps1
    .\scripts\wire-tech-day-routes.ps1 -Yes
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
$tech    = Ensure-Resource $service "tech"
$day     = Ensure-Resource $tech "day"

foreach ($part in @("start", "end", "note")) {
    Write-Host "==> /service/tech/day/$part : POST, OPTIONS -> $Board" -ForegroundColor Cyan
    $r = Ensure-Resource $day $part
    foreach ($m in @("POST", "OPTIONS")) { Wire-Method $r $m $Board }
}

Write-Host "==> /service/techs/locations : GET, OPTIONS -> $Board" -ForegroundColor Cyan
$techs = Ensure-Resource $service "techs"
$loc   = Ensure-Resource $techs "locations"
foreach ($m in @("GET", "OPTIONS")) { Wire-Method $loc $m $Board }

Write-Host "==> /service/payroll : GET, OPTIONS -> $Board" -ForegroundColor Cyan
$pay = Ensure-Resource $service "payroll"
foreach ($m in @("GET", "OPTIONS")) { Wire-Method $pay $m $Board }

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
    --description "Add day clock / tech locations / payroll routes -> $Board" --output json | Out-Null
if ($LASTEXITCODE -ne 0) { throw "create-deployment failed" }
Write-Host "SUCCESS. Day clock, tech locations and payroll routes are live." -ForegroundColor Green
