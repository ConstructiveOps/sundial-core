<#
.SYNOPSIS
    Wires the two Welcome Call routes on the Sundial REST API (API Gateway
    5sktfwldh1, region us-west-1, stage prod) to the sundial-welcome-call Lambda,
    each with a MOCK OPTIONS method and a Lambda invoke permission:

      POST /webhooks/retell            (Retell lifecycle webhook)
      POST /welcome-call/orphan-match  (Zapier orphan sweep)

.DESCRIPTION
    NEITHER ROUTE USES A SUPABASE JWT OR AN API-GATEWAY AUTHORIZER. Both callers are
    machines with no portal user. Each is gated by its own shared secret in a header,
    verified in-Lambda with a constant-time compare:

      POST /webhooks/retell
        X-Retell-Signature: v=<hmac-sha256 of the raw body, keyed with RETELL_WEBHOOK_SECRET>

      POST /welcome-call/orphan-match
        X-Sundial-Zap-Secret: <ZAP_ORPHAN_MATCH_SECRET>
        body { "call_id": "...", "sf_record_id": "a1P..." }

    These are the ONLY routes the Welcome Call feature adds. There is no portal UI and
    no portal-authenticated endpoint. The call-placing side is invoked by EventBridge,
    not HTTP.

    PRECONDITIONS (the script stops if unmet):
      1. sundial-welcome-call must exist (create the function, then deploy code with
         .\deploy.ps1 sundial-welcome-call).
      2. Deploying to the PRODUCTION stage is a live change; prompts unless -Yes.

    NOT CREATED BY THIS SCRIPT (Tim's console/Salesforce steps — see
    docs/integrations/retell-welcome-call.md):
      - the Sundial_Welcome_Call_Request__e platform event + Event Relay
      - the EventBridge rule targeting sundial-welcome-call
      - the sundial/retell/api secret and the env vars

.EXAMPLE
    .\scripts\wire-welcome-call-routes.ps1            # prompts before prod deploy
    .\scripts\wire-welcome-call-routes.ps1 -Yes       # non-interactive
#>
[CmdletBinding()]
param([switch]$Yes)

$ErrorActionPreference = "Continue"
$Region  = "us-west-1"
$ApiId   = "5sktfwldh1"
$Stage   = "prod"
$Fn      = "sundial-welcome-call"
$AcctId  = "891377232720"
$FnArn   = "arn:aws:lambda:${Region}:${AcctId}:function:${Fn}"
$IntegrationUri = "arn:aws:apigateway:${Region}:lambda:path/2015-03-31/functions/${FnArn}/invocations"

# AWS CLI quoting workarounds — same three traps as the other wire-* scripts:
# `--api-key-required $false` renders as "False" and is rejected (use the flag form);
# the shorthand map parser splits on commas regardless of quoting; and PS 5.1
# `Out-File -Encoding utf8` writes a BOM the CLI can't parse. Hence no-BOM file:// JSON.
$TmpDir = Join-Path $env:TEMP "sundial-wire-welcome-call"
New-Item -ItemType Directory -Force -Path $TmpDir | Out-Null
$MockTemplateFile = Join-Path $TmpDir "mock-template.json"
$CorsParamsFile   = Join-Path $TmpDir "cors-response-params.json"
$NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($MockTemplateFile, '{"application/json":"{\"statusCode\": 200}"}', $NoBom)
# One CORS param file for both routes: the allowed-header list is the union of the two
# gates, which is harmless (a caller sending the wrong one is rejected in-Lambda).
[System.IO.File]::WriteAllText($CorsParamsFile, @'
{
  "method.response.header.Access-Control-Allow-Headers": "'Content-Type,X-Retell-Signature,X-Sundial-Zap-Secret'",
  "method.response.header.Access-Control-Allow-Methods": "'OPTIONS,POST'",
  "method.response.header.Access-Control-Allow-Origin": "'*'"
}
'@, $NoBom)

function Assert-LastExitOk($what) {
    if ($LASTEXITCODE -ne 0) { throw "$what failed (exit $LASTEXITCODE). Routes are NOT fully wired." }
}

function Get-ChildResource($parentId, $pathPart) {
    $items = aws apigateway get-resources --rest-api-id $ApiId --region $Region --limit 500 --output json | ConvertFrom-Json
    foreach ($r in $items.items) { if ($r.parentId -eq $parentId -and $r.pathPart -eq $pathPart) { return $r.id } }
    return $null
}
function Ensure-Resource($parentId, $pathPart) {
    $existing = Get-ChildResource $parentId $pathPart
    if ($existing) { Write-Host "  resource '$pathPart' exists ($existing)"; return $existing }
    $created = aws apigateway create-resource --rest-api-id $ApiId --region $Region --parent-id $parentId --path-part $pathPart --output json | ConvertFrom-Json
    Write-Host "  created resource '$pathPart' ($($created.id))"
    return $created.id
}

# Wire POST + MOCK OPTIONS on one resource, and grant API Gateway invoke permission.
function Wire-PostRoute($resourceId, $routePath, $statementId) {
    Write-Host "==> POST $routePath -> $Fn (AWS_PROXY, NO authorizer - shared secret is the gate)" -ForegroundColor Cyan
    aws apigateway put-method --rest-api-id $ApiId --region $Region --resource-id $resourceId `
        --http-method POST --authorization-type NONE --no-api-key-required 2>$null | Out-Null
    aws apigateway put-integration --rest-api-id $ApiId --region $Region --resource-id $resourceId `
        --http-method POST --type AWS_PROXY --integration-http-method POST --uri $IntegrationUri | Out-Null
    Assert-LastExitOk "put-integration (POST $routePath)"
    aws apigateway put-method-response --rest-api-id $ApiId --region $Region --resource-id $resourceId `
        --http-method POST --status-code 200 2>$null | Out-Null

    Write-Host "==> OPTIONS $routePath (MOCK CORS)" -ForegroundColor Cyan
    aws apigateway put-method --rest-api-id $ApiId --region $Region --resource-id $resourceId `
        --http-method OPTIONS --authorization-type NONE 2>$null | Out-Null
    aws apigateway put-integration --rest-api-id $ApiId --region $Region --resource-id $resourceId `
        --http-method OPTIONS --type MOCK --request-templates "file://$MockTemplateFile" | Out-Null
    Assert-LastExitOk "put-integration (OPTIONS $routePath)"
    aws apigateway put-method-response --rest-api-id $ApiId --region $Region --resource-id $resourceId `
        --http-method OPTIONS --status-code 200 `
        --response-parameters "method.response.header.Access-Control-Allow-Headers=false,method.response.header.Access-Control-Allow-Methods=false,method.response.header.Access-Control-Allow-Origin=false" 2>$null | Out-Null
    aws apigateway put-integration-response --rest-api-id $ApiId --region $Region --resource-id $resourceId `
        --http-method OPTIONS --status-code 200 --response-parameters "file://$CorsParamsFile" | Out-Null
    Assert-LastExitOk "put-integration-response (OPTIONS $routePath)"

    Write-Host "==> Lambda invoke permission for $routePath" -ForegroundColor Cyan
    $srcArn = "arn:aws:execute-api:${Region}:${AcctId}:${ApiId}/*/POST$routePath"
    aws lambda add-permission --function-name $Fn --region $Region `
        --statement-id $statementId --action "lambda:InvokeFunction" `
        --principal apigateway.amazonaws.com --source-arn $srcArn 2>$null | Out-Null
    Write-Host "  (a 'ResourceConflictException' here just means the permission already exists - safe)" -ForegroundColor DarkGray
}

Write-Host "==> Verifying $Fn exists..." -ForegroundColor Cyan
aws lambda get-function-configuration --function-name $Fn --region $Region --output json | Out-Null
if ($LASTEXITCODE -ne 0) { throw "$Fn does not exist yet. Create it, then re-run." }

$root = (aws apigateway get-resources --rest-api-id $ApiId --region $Region --limit 500 --output json | ConvertFrom-Json).items |
    Where-Object { $_.path -eq "/" } | Select-Object -First 1
if (-not $root) { throw "Could not find root resource." }

# --- Route 1: /webhooks/retell ------------------------------------------------
Write-Host "==> Ensuring resource path /webhooks/retell" -ForegroundColor Cyan
# /webhooks already exists (Aurora + Acumatica live under it); Ensure-Resource is a no-op there.
$webhooks = Ensure-Resource $root.id "webhooks"
$retell   = Ensure-Resource $webhooks "retell"
Wire-PostRoute $retell "/webhooks/retell" "apigw-retell-webhook"

# --- Route 2: /welcome-call/orphan-match --------------------------------------
Write-Host "==> Ensuring resource path /welcome-call/orphan-match" -ForegroundColor Cyan
$welcomeCall  = Ensure-Resource $root.id "welcome-call"
$orphanMatch  = Ensure-Resource $welcomeCall "orphan-match"
Wire-PostRoute $orphanMatch "/welcome-call/orphan-match" "apigw-welcome-call-orphan-match"

if (-not $Yes) {
    $ans = Read-Host "Deploy API to '$Stage' now? This is a LIVE production change. (y/N)"
    if ($ans -ne "y") { Write-Host "Skipped deploy. Routes created but NOT live until you deploy." -ForegroundColor Yellow; exit 0 }
}
Write-Host "==> create-deployment -> $Stage" -ForegroundColor Cyan
aws apigateway create-deployment --rest-api-id $ApiId --region $Region --stage-name $Stage `
    --description "Welcome Call: Retell webhook + orphan-match -> $Fn" | Out-Null
Assert-LastExitOk "create-deployment"

$base = "https://$ApiId.execute-api.$Region.amazonaws.com/$Stage"
Write-Host "SUCCESS:" -ForegroundColor Green
Write-Host "  $base/webhooks/retell           (point Retell here; secret must match RETELL_WEBHOOK_SECRET)" -ForegroundColor Green
Write-Host "  $base/welcome-call/orphan-match (point the orphan-sweep Zap here; header X-Sundial-Zap-Secret)" -ForegroundColor Green
