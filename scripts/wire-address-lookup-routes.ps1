<#
.SYNOPSIS
    Wires the address-lookup routes on the Sundial REST API (API Gateway 5sktfwldh1,
    us-west-1, stage prod) to the sundial-service-estimate Lambda (2026-09-22,
    lambdas/sundial-service-estimate/address.js):

      GET /service/address/suggest            ?q=&session=      Google Places autocomplete, key server-side
      GET /service/address/place/{placeId}    ?session=         the picked address → street / city / state / ZIP

.DESCRIPTION
    Idempotent (same conventions as wire-service-estimate-routes.ps1). The Lambda's
    invoke permission for /service/* already exists from that script. PRECONDITIONS:
      1. .\deploy.ps1 sundial-service-estimate has been run with the 2026-09-22 code.
      2. Secrets Manager sundial/google-maps holds { "apiKey": "..." } (it does — Street
         View uses it) AND the key's Google Cloud project has "Places API (New)" enabled.
         Without that, the office sees no suggestions and just types the address.

.EXAMPLE
    .\scripts\wire-address-lookup-routes.ps1
    .\scripts\wire-address-lookup-routes.ps1 -Yes
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

$service = Ensure-Resource $root "service"
$address = Ensure-Resource $service "address"
Write-Host "==> /service/address/suggest : GET, OPTIONS" -ForegroundColor Cyan
$suggest = Ensure-Resource $address "suggest"
foreach ($m in @("GET", "OPTIONS")) { Wire-Method $suggest $m }
Write-Host "==> /service/address/place/{placeId} : GET, OPTIONS" -ForegroundColor Cyan
$place   = Ensure-Resource $address "place"
$placeId = Ensure-Resource $place "{placeId}"
foreach ($m in @("GET", "OPTIONS")) { Wire-Method $placeId $m }

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
    --description "Add /service/address/* (address lookup) -> $Fn" --output json | Out-Null
if ($LASTEXITCODE -ne 0) { throw "create-deployment failed" }
Write-Host "SUCCESS. Try: https://$ApiId.execute-api.$Region.amazonaws.com/$Stage/service/address/suggest?q=1+palm+ln (with a bearer token)" -ForegroundColor Green
