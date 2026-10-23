<#
.SYNOPSIS
    Wires the dealer shell's routes on the Sundial REST API (API Gateway 5sktfwldh1,
    us-west-1, stage prod) to the sundial-dealer Lambda (dealer module step 3):
      GET /dealer/customers          the customer list (one row per customer + its solar)
      GET /dealer/customers/{id}     one customer + its solar, access block, picklists, journey
    plus OPTIONS (204, CORS) on both. AWS_PROXY, authorization NONE at the gateway — the
    Supabase JWT is checked IN the Lambda (action dealer.read: tenant, dealer, own scope).

.DESCRIPTION
    Idempotent (same conventions as wire-notify-routes.ps1). PRECONDITIONS:
      1. The sundial-dealer Lambda exists. Create it in the console with the SAME role and
         environment as sundial-sf-query: Node 22.x, handler index.handler, role
         sundial-lambda-execution-role, 30 s timeout, and copy sundial-sf-query's
         environment variables. Then deploy it: .\deploy.ps1 sundial-dealer
      2. sql/sundial_dealer_customer_view.sql has been run in the Supabase SQL editor
         (until it is, GET /dealer/customers answers 503 DEALER_VIEW_MISSING).
      3. sundial-auth-proxy has been redeployed (.\deploy.ps1 sundial-auth-proxy) so
         /auth/me advertises dealer.read in access.actions.

.EXAMPLE
    .\scripts\wire-dealer-routes.ps1
    .\scripts\wire-dealer-routes.ps1 -Yes
#>
[CmdletBinding()]
param([switch]$Yes)

$ErrorActionPreference = "Continue"
$Region = "us-west-1"
$ApiId  = "5sktfwldh1"
$Stage  = "prod"
$Fn     = "sundial-dealer"
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
if ($LASTEXITCODE -ne 0 -or -not $fnCfg.FunctionArn) { throw "$Fn does not exist yet. Create it in the Lambda console, deploy it, then re-run." }

$root = (Get-Resources | Where-Object { $_.path -eq "/" }).id
if (-not $root) { throw "Could not find root resource." }

Write-Host "==> /dealer/customers : GET, OPTIONS" -ForegroundColor Cyan
$dealer    = Ensure-Resource $root "dealer"
$customers = Ensure-Resource $dealer "customers"
foreach ($m in @("GET", "OPTIONS")) { Wire-Method $customers $m }

Write-Host "==> /dealer/customers/{id} : GET, OPTIONS" -ForegroundColor Cyan
$one = Ensure-Resource $customers "{id}"
foreach ($m in @("GET", "OPTIONS")) { Wire-Method $one $m }

Write-Host "==> Lambda invoke permission (apigateway)" -ForegroundColor Cyan
aws lambda add-permission --function-name $Fn --region $Region `
    --statement-id "apigw-dealer" --action "lambda:InvokeFunction" `
    --principal apigateway.amazonaws.com --source-arn "arn:aws:execute-api:${Region}:${AcctId}:${ApiId}/*/*/dealer/*" --output json 2>$null | Out-Null
Write-Host "  (an 'already exists' error here is harmless - permission is in place)" -ForegroundColor DarkGray

if (-not $Yes) {
    $ans = Read-Host "Deploy API to '$Stage' now? LIVE production change. (y/N)"
    if ($ans -ne "y") { Write-Host "Routes created but NOT live until you deploy." -ForegroundColor Yellow; exit 0 }
}
Write-Host "==> create-deployment -> $Stage" -ForegroundColor Cyan
aws apigateway create-deployment --rest-api-id $ApiId --region $Region --stage-name $Stage `
    --description "Add dealer shell routes -> $Fn" --output json | Out-Null
if ($LASTEXITCODE -ne 0) { throw "create-deployment failed" }
Write-Host "SUCCESS. Try it: GET https://$ApiId.execute-api.$Region.amazonaws.com/$Stage/dealer/customers (with a portal JWT)" -ForegroundColor Green
