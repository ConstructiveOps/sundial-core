<#
.SYNOPSIS
    Wires the CUSTOMER-facing (no login) estimate routes on the Sundial REST API
    (API Gateway 5sktfwldh1, us-west-1, stage prod) to the sundial-service-public
    Lambda (D-072.7 — the hosted estimate page):
      GET    /public/estimates/{token}            view (marks Sent -> Viewed)
      POST   /public/estimates/{token}/accept     { name }   -> Approved (Online)
      POST   /public/estimates/{token}/decline    { reason } -> Declined
    plus OPTIONS everywhere for CORS. AWS_PROXY, authorization NONE at the gateway
    (there IS no bearer token on these routes — the URL token is the whole credential;
    the Lambda returns 404 for anything it does not recognise), same shape as every
    other Sundial route.

.DESCRIPTION
    Idempotent: resources/methods are checked/created before use. PS 5.1-safe
    conventions copied from scripts/wire-service-estimate-routes.ps1.

    PRECONDITION: the sundial-service-public Lambda must already exist (create it in
    the console with the same runtime/role/arch/timeout as sundial-sf-update, then
    .\deploy.ps1 sundial-service-public). The final create-deployment prompts unless -Yes.

.EXAMPLE
    .\scripts\wire-service-public-routes.ps1
    .\scripts\wire-service-public-routes.ps1 -Yes
#>
[CmdletBinding()]
param([switch]$Yes)

$ErrorActionPreference = "Continue"
$Region = "us-west-1"
$ApiId  = "5sktfwldh1"
$Stage  = "prod"
$Fn     = "sundial-service-public"
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
if ($LASTEXITCODE -ne 0) { throw "$Fn does not exist yet. Create it in the Lambda console, deploy it, then re-run." }

$root = (Get-Resources | Where-Object { $_.path -eq "/" }).id
if (-not $root) { throw "Could not find root resource." }

Write-Host "==> Ensuring the /public/estimates/{token} resource tree" -ForegroundColor Cyan
$public    = Ensure-Resource $root "public"
$estimates = Ensure-Resource $public "estimates"
$token     = Ensure-Resource $estimates "{token}"

Write-Host "==> /public/estimates/{token} : GET, OPTIONS" -ForegroundColor Cyan
foreach ($m in @("GET", "OPTIONS")) { Wire-Method $token $m }
foreach ($action in @("accept", "decline")) {
    Write-Host "==> /public/estimates/{token}/$action : POST, OPTIONS" -ForegroundColor Cyan
    $r = Ensure-Resource $token $action
    foreach ($m in @("POST", "OPTIONS")) { Wire-Method $r $m }
}

# One invoke permission covering any stage + any method under /public/*.
Write-Host "==> Lambda invoke permission (apigateway)" -ForegroundColor Cyan
$srcArn = "arn:aws:execute-api:${Region}:${AcctId}:${ApiId}/*/*/public/*"
aws lambda add-permission --function-name $Fn --region $Region `
    --statement-id "apigw-service-public" --action "lambda:InvokeFunction" `
    --principal apigateway.amazonaws.com --source-arn $srcArn --output json 2>$null | Out-Null
Write-Host "  (an 'already exists' error here is harmless - permission is in place)" -ForegroundColor DarkGray

if (-not $Yes) {
    $ans = Read-Host "Deploy API to '$Stage' now? LIVE production change. (y/N)"
    if ($ans -ne "y") { Write-Host "Routes created but NOT live until you deploy." -ForegroundColor Yellow; exit 0 }
}
Write-Host "==> create-deployment -> $Stage" -ForegroundColor Cyan
aws apigateway create-deployment --rest-api-id $ApiId --region $Region --stage-name $Stage `
    --description "Add public estimate routes -> $Fn" --output json | Out-Null
if ($LASTEXITCODE -ne 0) { throw "create-deployment failed" }
Write-Host "SUCCESS: live at https://$ApiId.execute-api.$Region.amazonaws.com/$Stage/public/estimates/{token}" -ForegroundColor Green
