<#
.SYNOPSIS
    Wires POST /auth/forgot (+ OPTIONS) on the Sundial REST API (API Gateway 5sktfwldh1,
    us-west-1, stage prod) to the sundial-auth-proxy Lambda — the "Forgot password" link
    Sundial sends itself with the token unspent (2026-09-22, lib/auth-email.js).
    AWS_PROXY, authorization NONE: the route is public by design (the person cannot sign
    in), always answers the same 200, and is rate-limited inside the Lambda.

.DESCRIPTION
    Idempotent (same conventions as wire-notify-routes.ps1). PRECONDITIONS:
      1. .\deploy.ps1 sundial-auth-proxy has been run with the 2026-09-22 code.
      2. Lambda env EMAIL_FROM is set on sundial-auth-proxy (the same address the
         estimate Lambda sends from). Without it the route falls back to Supabase's own
         reset email, whose Reset Password template must then be the token_hash shape.

.EXAMPLE
    .\scripts\wire-auth-forgot-route.ps1
    .\scripts\wire-auth-forgot-route.ps1 -Yes
#>
[CmdletBinding()]
param([switch]$Yes)

$ErrorActionPreference = "Continue"
$Region = "us-west-1"
$ApiId  = "5sktfwldh1"
$Stage  = "prod"
$Fn     = "sundial-auth-proxy"
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

Write-Host "==> /auth/forgot : POST, OPTIONS" -ForegroundColor Cyan
$auth   = Ensure-Resource $root "auth"
$forgot = Ensure-Resource $auth "forgot"
foreach ($m in @("POST", "OPTIONS")) { Wire-Method $forgot $m }

Write-Host "==> Lambda invoke permission (apigateway)" -ForegroundColor Cyan
aws lambda add-permission --function-name $Fn --region $Region `
    --statement-id "apigw-auth-forgot" --action "lambda:InvokeFunction" `
    --principal apigateway.amazonaws.com --source-arn "arn:aws:execute-api:${Region}:${AcctId}:${ApiId}/*/POST/auth/forgot" --output json 2>$null | Out-Null
Write-Host "  (an 'already exists' error here is harmless - permission is in place)" -ForegroundColor DarkGray

if (-not $Yes) {
    $ans = Read-Host "Deploy API to '$Stage' now? LIVE production change. (y/N)"
    if ($ans -ne "y") { Write-Host "Route created but NOT live until you deploy." -ForegroundColor Yellow; exit 0 }
}
Write-Host "==> create-deployment -> $Stage" -ForegroundColor Cyan
aws apigateway create-deployment --rest-api-id $ApiId --region $Region --stage-name $Stage `
    --description "Add POST /auth/forgot -> $Fn" --output json | Out-Null
if ($LASTEXITCODE -ne 0) { throw "create-deployment failed" }
Write-Host "SUCCESS. Forgot-password endpoint: https://$ApiId.execute-api.$Region.amazonaws.com/$Stage/auth/forgot" -ForegroundColor Green
