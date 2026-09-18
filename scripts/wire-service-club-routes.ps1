<#
.SYNOPSIS
    Wires the Service Club routes (D-073) on the Sundial REST API (API Gateway 5sktfwldh1,
    us-west-1, stage prod) to the sundial-service-estimate Lambda:
      PUBLIC (no login - the tenant slug is in the URL, like the Stripe webhook)
      GET    /public/club/{tenant}/plans
      POST   /public/club/{tenant}/join | truck-roll | request | manage
      GET    /public/club/{tenant}/joined
      OFFICE
      GET    /service/club/plans · PATCH /service/club/plans/{id}
      GET    /service/club/memberships · POST /service/club/memberships
      POST   /service/club/memberships/{id}/cancel | solarfacts
      GET    /service/club/report · GET /service/club/customers/{id}
      POST   /service/estimates/{id}/apply-plan-discount
    plus OPTIONS everywhere for CORS. AWS_PROXY, authorization NONE at the gateway
    (auth + CORS 204 live IN the Lambda), same as every other Sundial route.

.DESCRIPTION
    Idempotent: resources/methods are checked/created before use. Re-run any time.
    The /public resource already exists (the customer estimate page); /public/club is new.

.EXAMPLE
    .\scripts\wire-service-club-routes.ps1
    .\scripts\wire-service-club-routes.ps1 -Yes
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
if ($LASTEXITCODE -ne 0) { throw "$Fn does not exist yet. Deploy it, then re-run." }

$root = (Get-Resources | Where-Object { $_.path -eq "/" }).id
if (-not $root) { throw "Could not find root resource." }

# --- public ---------------------------------------------------------------------
Write-Host "==> /public/club/{tenant}" -ForegroundColor Cyan
$public = Ensure-Resource $root "public"
$club   = Ensure-Resource $public "club"
$tenant = Ensure-Resource $club "{tenant}"
foreach ($leaf in @("plans", "joined")) {
    Write-Host "==> /public/club/{tenant}/$leaf : GET, OPTIONS" -ForegroundColor Cyan
    $r = Ensure-Resource $tenant $leaf
    foreach ($m in @("GET", "OPTIONS")) { Wire-Method $r $m }
}
foreach ($leaf in @("join", "truck-roll", "request", "manage")) {
    Write-Host "==> /public/club/{tenant}/$leaf : POST, OPTIONS" -ForegroundColor Cyan
    $r = Ensure-Resource $tenant $leaf
    foreach ($m in @("POST", "OPTIONS")) { Wire-Method $r $m }
}

# --- office ---------------------------------------------------------------------
$service = Ensure-Resource $root "service"
$sclub   = Ensure-Resource $service "club"
Write-Host "==> /service/club/plans : GET, OPTIONS" -ForegroundColor Cyan
$plans = Ensure-Resource $sclub "plans"
foreach ($m in @("GET", "OPTIONS")) { Wire-Method $plans $m }
Write-Host "==> /service/club/plans/{id} : PATCH, OPTIONS" -ForegroundColor Cyan
$planId = Ensure-Resource $plans "{id}"
foreach ($m in @("PATCH", "OPTIONS")) { Wire-Method $planId $m }
Write-Host "==> /service/club/memberships : GET, POST, OPTIONS" -ForegroundColor Cyan
$mems = Ensure-Resource $sclub "memberships"
foreach ($m in @("GET", "POST", "OPTIONS")) { Wire-Method $mems $m }
$memId = Ensure-Resource $mems "{id}"
foreach ($action in @("cancel", "solarfacts")) {
    Write-Host "==> /service/club/memberships/{id}/$action : POST, OPTIONS" -ForegroundColor Cyan
    $r = Ensure-Resource $memId $action
    foreach ($m in @("POST", "OPTIONS")) { Wire-Method $r $m }
}
Write-Host "==> /service/club/report : GET, OPTIONS" -ForegroundColor Cyan
$report = Ensure-Resource $sclub "report"
foreach ($m in @("GET", "OPTIONS")) { Wire-Method $report $m }
Write-Host "==> /service/club/customers/{id} : GET, OPTIONS" -ForegroundColor Cyan
$custs = Ensure-Resource $sclub "customers"
$custId = Ensure-Resource $custs "{id}"
foreach ($m in @("GET", "OPTIONS")) { Wire-Method $custId $m }
Write-Host "==> /service/estimates/{id}/apply-plan-discount : POST, OPTIONS" -ForegroundColor Cyan
$estimates = Ensure-Resource $service "estimates"
$estId     = Ensure-Resource $estimates "{id}"
$apd       = Ensure-Resource $estId "apply-plan-discount"
foreach ($m in @("POST", "OPTIONS")) { Wire-Method $apd $m }

# Invoke permissions: /service/* is already granted (apigw-service-estimate); the public
# club paths are not under it, so one more statement.
Write-Host "==> Lambda invoke permission for /public/club/*" -ForegroundColor Cyan
$pubArn = "arn:aws:execute-api:${Region}:${AcctId}:${ApiId}/*/*/public/club/*"
aws lambda add-permission --function-name $Fn --region $Region `
    --statement-id "apigw-service-estimate-club" --action "lambda:InvokeFunction" `
    --principal apigateway.amazonaws.com --source-arn $pubArn --output json 2>$null | Out-Null
Write-Host "  (an 'already exists' error here is harmless - permission is in place)" -ForegroundColor DarkGray

if (-not $Yes) {
    $ans = Read-Host "Deploy API to '$Stage' now? LIVE production change. (y/N)"
    if ($ans -ne "y") { Write-Host "Routes created but NOT live until you deploy." -ForegroundColor Yellow; exit 0 }
}
Write-Host "==> create-deployment -> $Stage" -ForegroundColor Cyan
aws apigateway create-deployment --rest-api-id $ApiId --region $Region --stage-name $Stage `
    --description "Add Service Club routes -> $Fn" --output json | Out-Null
if ($LASTEXITCODE -ne 0) { throw "create-deployment failed" }
Write-Host "SUCCESS: live at https://$ApiId.execute-api.$Region.amazonaws.com/$Stage/public/club/harmon/plans" -ForegroundColor Green
