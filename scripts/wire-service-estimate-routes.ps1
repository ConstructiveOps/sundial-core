<#
.SYNOPSIS
    Wires the Service module's estimate / job / price-book WRITE routes on the Sundial
    REST API (API Gateway 5sktfwldh1, us-west-1, stage prod) to the
    sundial-service-estimate Lambda (D-072):
      POST   /service/estimates
      GET    /service/estimates/{id}
      PATCH  /service/estimates/{id}
      POST   /service/estimates/{id}/lines
      PATCH  /service/estimates/{id}/lines/{lineId}
      DELETE /service/estimates/{id}/lines/{lineId}
      POST   /service/estimates/{id}/add-template | recalculate | send | approve | decline | create-job
      GET    /service/estimates/{id}/activity | preview
      POST   /service/jobs
      GET    /service/jobs/{id}/activity | street-view | invoice
      POST   /service/jobs/{id}/invoice
      GET    /service/invoices/{id} | /service/invoices/{id}/preview
      POST   /service/invoices/{id}/payments | send | void
      POST   /service/price-book-items
      PATCH  /service/price-book-items/{id}
      POST   /service/price-book-items/{id}/new-version | deactivate
    plus OPTIONS everywhere for CORS. AWS_PROXY, authorization NONE at the gateway
    (auth + CORS 204 live IN the Lambda), same as every other Sundial route.

.DESCRIPTION
    Idempotent: resources/methods are checked/created before use. PS 5.1-safe
    conventions copied from scripts/wire-user-admin-routes.ps1.

    PRECONDITION: the sundial-service-estimate Lambda must already exist (create it in
    the console with the same runtime/role/arch/timeout as sundial-sf-update, then
    .\deploy.ps1 sundial-service-estimate). The final create-deployment prompts unless -Yes.

.EXAMPLE
    .\scripts\wire-service-estimate-routes.ps1
    .\scripts\wire-service-estimate-routes.ps1 -Yes
#>
[CmdletBinding()]
param([switch]$Yes)

# Continue (not Stop): native aws stderr under PS 5.1 + Stop raises NativeCommandError
# even on benign 404s. We check $LASTEXITCODE explicitly on the calls that matter.
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
    # put-method: fresh succeeds; existing errors harmlessly (stderr suppressed).
    # The integration is set either way, and that is the call we gate on.
    aws apigateway put-method --rest-api-id $ApiId --region $Region --resource-id $resourceId `
        --http-method $method --authorization-type NONE --no-api-key-required --output json 2>$null | Out-Null
    aws apigateway put-integration --rest-api-id $ApiId --region $Region --resource-id $resourceId `
        --http-method $method --type AWS_PROXY --integration-http-method POST --uri $Uri --output json | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "put-integration $method failed on $resourceId" }
    Write-Host "  wired $method -> AWS_PROXY -> $Fn" -ForegroundColor Green
}

Write-Host "==> Verifying $Fn exists..." -ForegroundColor Cyan
aws lambda get-function-configuration --function-name $Fn --region $Region --output json | Out-Null
if ($LASTEXITCODE -ne 0) { throw "$Fn does not exist yet. Create it in the Lambda console, deploy it, then re-run." }

$root = (Get-Resources | Where-Object { $_.path -eq "/" }).id
if (-not $root) { throw "Could not find root resource." }

Write-Host "==> Ensuring the /service resource tree" -ForegroundColor Cyan
$service   = Ensure-Resource $root "service"
$estimates = Ensure-Resource $service "estimates"
$estId     = Ensure-Resource $estimates "{id}"
$lines     = Ensure-Resource $estId "lines"
$lineId    = Ensure-Resource $lines "{lineId}"
$jobs      = Ensure-Resource $service "jobs"
$items     = Ensure-Resource $service "price-book-items"
$itemId    = Ensure-Resource $items "{id}"

Write-Host "==> /service/estimates : POST, OPTIONS" -ForegroundColor Cyan
foreach ($m in @("POST", "OPTIONS")) { Wire-Method $estimates $m }
Write-Host "==> /service/estimates/{id} : GET, PATCH, OPTIONS" -ForegroundColor Cyan
foreach ($m in @("GET", "PATCH", "OPTIONS")) { Wire-Method $estId $m }
Write-Host "==> /service/estimates/{id}/lines : POST, OPTIONS" -ForegroundColor Cyan
foreach ($m in @("POST", "OPTIONS")) { Wire-Method $lines $m }
Write-Host "==> /service/estimates/{id}/lines/{lineId} : PATCH, DELETE, OPTIONS" -ForegroundColor Cyan
foreach ($m in @("PATCH", "DELETE", "OPTIONS")) { Wire-Method $lineId $m }
foreach ($action in @("add-template", "recalculate", "send", "approve", "decline", "create-job")) {
    Write-Host "==> /service/estimates/{id}/$action : POST, OPTIONS" -ForegroundColor Cyan
    $r = Ensure-Resource $estId $action
    foreach ($m in @("POST", "OPTIONS")) { Wire-Method $r $m }
}
foreach ($action in @("activity", "preview")) {
    Write-Host "==> /service/estimates/{id}/$action : GET, OPTIONS" -ForegroundColor Cyan
    $r = Ensure-Resource $estId $action
    foreach ($m in @("GET", "OPTIONS")) { Wire-Method $r $m }
}
Write-Host "==> /service/jobs/{id}/activity : GET, OPTIONS" -ForegroundColor Cyan
$jobId = Ensure-Resource $jobs "{id}"
$jobAct = Ensure-Resource $jobId "activity"
foreach ($m in @("GET", "OPTIONS")) { Wire-Method $jobAct $m }
Write-Host "==> /service/jobs/{id}/street-view : GET, OPTIONS" -ForegroundColor Cyan
$jobSv = Ensure-Resource $jobId "street-view"
foreach ($m in @("GET", "OPTIONS")) { Wire-Method $jobSv $m }
Write-Host "==> /service/jobs/{id}/invoice : GET, POST, OPTIONS" -ForegroundColor Cyan
$jobInv = Ensure-Resource $jobId "invoice"
foreach ($m in @("GET", "POST", "OPTIONS")) { Wire-Method $jobInv $m }
Write-Host "==> /service/jobs : POST, OPTIONS" -ForegroundColor Cyan
foreach ($m in @("POST", "OPTIONS")) { Wire-Method $jobs $m }
Write-Host "==> /service/invoices/{id} : GET, OPTIONS" -ForegroundColor Cyan
$invoices = Ensure-Resource $service "invoices"
$invId    = Ensure-Resource $invoices "{id}"
foreach ($m in @("GET", "OPTIONS")) { Wire-Method $invId $m }
Write-Host "==> /service/invoices/{id}/preview : GET, OPTIONS" -ForegroundColor Cyan
$invPv = Ensure-Resource $invId "preview"
foreach ($m in @("GET", "OPTIONS")) { Wire-Method $invPv $m }
foreach ($action in @("payments", "send", "void")) {
    Write-Host "==> /service/invoices/{id}/$action : POST, OPTIONS" -ForegroundColor Cyan
    $r = Ensure-Resource $invId $action
    foreach ($m in @("POST", "OPTIONS")) { Wire-Method $r $m }
}
Write-Host "==> /service/price-book-items : POST, OPTIONS" -ForegroundColor Cyan
foreach ($m in @("POST", "OPTIONS")) { Wire-Method $items $m }
Write-Host "==> /service/price-book-items/{id} : PATCH, OPTIONS" -ForegroundColor Cyan
foreach ($m in @("PATCH", "OPTIONS")) { Wire-Method $itemId $m }
foreach ($action in @("new-version", "deactivate")) {
    Write-Host "==> /service/price-book-items/{id}/$action : POST, OPTIONS" -ForegroundColor Cyan
    $r = Ensure-Resource $itemId $action
    foreach ($m in @("POST", "OPTIONS")) { Wire-Method $r $m }
}

# One invoke permission covering any stage + any method under /service/*.
Write-Host "==> Lambda invoke permission (apigateway)" -ForegroundColor Cyan
$srcArn = "arn:aws:execute-api:${Region}:${AcctId}:${ApiId}/*/*/service/*"
aws lambda add-permission --function-name $Fn --region $Region `
    --statement-id "apigw-service-estimate" --action "lambda:InvokeFunction" `
    --principal apigateway.amazonaws.com --source-arn $srcArn --output json 2>$null | Out-Null
Write-Host "  (an 'already exists' error here is harmless - permission is in place)" -ForegroundColor DarkGray

if (-not $Yes) {
    $ans = Read-Host "Deploy API to '$Stage' now? LIVE production change. (y/N)"
    if ($ans -ne "y") { Write-Host "Routes created but NOT live until you deploy." -ForegroundColor Yellow; exit 0 }
}
Write-Host "==> create-deployment -> $Stage" -ForegroundColor Cyan
aws apigateway create-deployment --rest-api-id $ApiId --region $Region --stage-name $Stage `
    --description "Add service estimate/job/price-book routes -> $Fn" --output json | Out-Null
if ($LASTEXITCODE -ne 0) { throw "create-deployment failed" }
Write-Host "SUCCESS: live at https://$ApiId.execute-api.$Region.amazonaws.com/$Stage/service/estimates" -ForegroundColor Green
