<#
.SYNOPSIS
    Wires GET /sf/{object}/pipeline on the Sundial REST API (API Gateway 5sktfwldh1,
    us-west-1, stage prod) to the sundial-sf-query Lambda (D-080): the Sales page's
    status badges, stage columns and Rep / Source options in one small answer.
      GET     /sf/{object}/pipeline   counts (customer only; other objects answer 400)
      OPTIONS /sf/{object}/pipeline   CORS preflight (answered by the Lambda)
    AWS_PROXY, authorization NONE at the gateway — the Supabase JWT is checked IN the
    Lambda, through the same access path as the list.

.DESCRIPTION
    WHY A RESOURCE OF ITS OWN: without it the request lands on /sf/{object}/{id} (which
    also carries PATCH and DELETE for sundial-sf-update). The Lambda recognises the literal
    there too, but a fixed resource keeps "pipeline" from ever being treated as a record id
    by anything else. API Gateway matches the literal ahead of the {id} sibling.

    Idempotent (same conventions as wire-notify-routes.ps1). PRECONDITIONS, in order:
      1. sql/sundial_customer_pipeline.sql and sql/2026-10-05_sales_pipeline_indexes.sql
         have been run in the Supabase SQL editor.
      2. .\deploy.ps1 sundial-sf-query

.EXAMPLE
    .\scripts\wire-sales-pipeline-route.ps1
    .\scripts\wire-sales-pipeline-route.ps1 -Yes
#>
[CmdletBinding()]
param([switch]$Yes)

$ErrorActionPreference = "Continue"
$Region = "us-west-1"
$ApiId  = "5sktfwldh1"
$Stage  = "prod"
$Fn     = "sundial-sf-query"
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
if ($LASTEXITCODE -ne 0 -or -not $fnCfg.FunctionArn) { throw "$Fn not found." }

$object = (Get-Resources | Where-Object { $_.path -eq "/sf/{object}" }).id
if (-not $object) { throw "Could not find the /sf/{object} resource." }

Write-Host "==> /sf/{object}/pipeline : GET, OPTIONS" -ForegroundColor Cyan
$pipeline = Ensure-Resource $object "pipeline"
foreach ($m in @("GET", "OPTIONS")) { Wire-Method $pipeline $m }

Write-Host "==> Lambda invoke permission (apigateway)" -ForegroundColor Cyan
aws lambda add-permission --function-name $Fn --region $Region `
    --statement-id "apigw-sf-pipeline" --action "lambda:InvokeFunction" `
    --principal apigateway.amazonaws.com --source-arn "arn:aws:execute-api:${Region}:${AcctId}:${ApiId}/*/*/sf/*/pipeline" --output json 2>$null | Out-Null
Write-Host "  (an 'already exists' error here is harmless - permission is in place)" -ForegroundColor DarkGray

if (-not $Yes) {
    $ans = Read-Host "Deploy API to '$Stage' now? LIVE production change. (y/N)"
    if ($ans -ne "y") { Write-Host "Route created but NOT live until you deploy." -ForegroundColor Yellow; exit 0 }
}
Write-Host "==> create-deployment -> $Stage" -ForegroundColor Cyan
aws apigateway create-deployment --rest-api-id $ApiId --region $Region --stage-name $Stage `
    --description "Add GET /sf/{object}/pipeline -> $Fn (D-080)" --output json | Out-Null
if ($LASTEXITCODE -ne 0) { throw "create-deployment failed" }
Write-Host "SUCCESS. Try it: GET https://$ApiId.execute-api.$Region.amazonaws.com/$Stage/sf/customer/pipeline (with a portal JWT)" -ForegroundColor Green
