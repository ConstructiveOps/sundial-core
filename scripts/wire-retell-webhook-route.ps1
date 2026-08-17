<#
.SYNOPSIS
    Wires POST /webhooks/retell on the Sundial REST API (API Gateway 5sktfwldh1,
    region us-west-1, stage prod) to the sundial-welcome-call Lambda, with a MOCK
    OPTIONS method and the Lambda invoke permission.

.DESCRIPTION
    Retell posts its call lifecycle webhook here:
      POST /webhooks/retell
      X-Retell-Signature: v=<hmac-sha256 of the raw body, keyed with the webhook secret>

    NO Supabase JWT and NO API-Gateway authorizer: the caller is Retell, a machine
    with no portal user. The signature header is the ONLY gate, verified in-Lambda
    with a constant-time compare (see lambdas/sundial-welcome-call/webhook.js).

    THIS IS THE ONLY ROUTE THE WELCOME CALL FEATURE ADDS. There is no portal UI and
    no portal-authenticated endpoint. The place-call side is invoked by EventBridge,
    not HTTP.

    PRECONDITIONS (the script stops if unmet):
      1. sundial-welcome-call must exist (create the function, then deploy code with
         .\deploy.ps1 sundial-welcome-call).
      2. Deploying to the PRODUCTION stage is a live change; prompts unless -Yes.

    NOT CREATED BY THIS SCRIPT (Tim's console/Salesforce steps — see
    docs/integrations/retell-welcome-call.md):
      - the Sundial_Welcome_Call_Request__e platform event + Event Relay
      - the EventBridge rule targeting sundial-welcome-call
      - the sundial/retell/api secret and the three env vars

.EXAMPLE
    .\scripts\wire-retell-webhook-route.ps1            # prompts before prod deploy
    .\scripts\wire-retell-webhook-route.ps1 -Yes       # non-interactive
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
$TmpDir = Join-Path $env:TEMP "sundial-wire-retell-webhook"
New-Item -ItemType Directory -Force -Path $TmpDir | Out-Null
$MockTemplateFile = Join-Path $TmpDir "mock-template.json"
$CorsParamsFile   = Join-Path $TmpDir "cors-response-params.json"
$NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($MockTemplateFile, '{"application/json":"{\"statusCode\": 200}"}', $NoBom)
[System.IO.File]::WriteAllText($CorsParamsFile, @'
{
  "method.response.header.Access-Control-Allow-Headers": "'Content-Type,X-Retell-Signature'",
  "method.response.header.Access-Control-Allow-Methods": "'OPTIONS,POST'",
  "method.response.header.Access-Control-Allow-Origin": "'*'"
}
'@, $NoBom)

function Assert-LastExitOk($what) {
    if ($LASTEXITCODE -ne 0) { throw "$what failed (exit $LASTEXITCODE). Route is NOT wired." }
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

Write-Host "==> Verifying $Fn exists..." -ForegroundColor Cyan
aws lambda get-function-configuration --function-name $Fn --region $Region --output json | Out-Null
if ($LASTEXITCODE -ne 0) { throw "$Fn does not exist yet. Create it, then re-run." }

$root = (aws apigateway get-resources --rest-api-id $ApiId --region $Region --limit 500 --output json | ConvertFrom-Json).items |
    Where-Object { $_.path -eq "/" } | Select-Object -First 1
if (-not $root) { throw "Could not find root resource." }

Write-Host "==> Ensuring resource path /webhooks/retell" -ForegroundColor Cyan
# /webhooks already exists (Aurora + Acumatica live under it); Ensure-Resource is a no-op there.
$webhooks = Ensure-Resource $root.id "webhooks"
$retell   = Ensure-Resource $webhooks "retell"

Write-Host "==> POST method -> $Fn (AWS_PROXY, NO authorizer - the signature is the gate)" -ForegroundColor Cyan
aws apigateway put-method --rest-api-id $ApiId --region $Region --resource-id $retell `
    --http-method POST --authorization-type NONE --no-api-key-required 2>$null | Out-Null
aws apigateway put-integration --rest-api-id $ApiId --region $Region --resource-id $retell `
    --http-method POST --type AWS_PROXY --integration-http-method POST --uri $IntegrationUri | Out-Null
Assert-LastExitOk "put-integration (POST)"
aws apigateway put-method-response --rest-api-id $ApiId --region $Region --resource-id $retell `
    --http-method POST --status-code 200 2>$null | Out-Null

Write-Host "==> OPTIONS method (MOCK CORS)" -ForegroundColor Cyan
aws apigateway put-method --rest-api-id $ApiId --region $Region --resource-id $retell `
    --http-method OPTIONS --authorization-type NONE 2>$null | Out-Null
aws apigateway put-integration --rest-api-id $ApiId --region $Region --resource-id $retell `
    --http-method OPTIONS --type MOCK --request-templates "file://$MockTemplateFile" | Out-Null
Assert-LastExitOk "put-integration (OPTIONS MOCK)"
aws apigateway put-method-response --rest-api-id $ApiId --region $Region --resource-id $retell `
    --http-method OPTIONS --status-code 200 `
    --response-parameters "method.response.header.Access-Control-Allow-Headers=false,method.response.header.Access-Control-Allow-Methods=false,method.response.header.Access-Control-Allow-Origin=false" 2>$null | Out-Null
aws apigateway put-integration-response --rest-api-id $ApiId --region $Region --resource-id $retell `
    --http-method OPTIONS --status-code 200 --response-parameters "file://$CorsParamsFile" | Out-Null
Assert-LastExitOk "put-integration-response (OPTIONS)"

Write-Host "==> Lambda invoke permission (apigateway)" -ForegroundColor Cyan
$srcArn = "arn:aws:execute-api:${Region}:${AcctId}:${ApiId}/*/POST/webhooks/retell"
aws lambda add-permission --function-name $Fn --region $Region `
    --statement-id "apigw-retell-webhook" --action "lambda:InvokeFunction" `
    --principal apigateway.amazonaws.com --source-arn $srcArn 2>$null | Out-Null
Write-Host "  (a 'ResourceConflictException' here just means the permission already exists - safe)" -ForegroundColor DarkGray

if (-not $Yes) {
    $ans = Read-Host "Deploy API to '$Stage' now? This is a LIVE production change. (y/N)"
    if ($ans -ne "y") { Write-Host "Skipped deploy. Route created but NOT live until you deploy." -ForegroundColor Yellow; exit 0 }
}
Write-Host "==> create-deployment -> $Stage" -ForegroundColor Cyan
aws apigateway create-deployment --rest-api-id $ApiId --region $Region --stage-name $Stage `
    --description "Retell welcome-call webhook -> $Fn" | Out-Null
Assert-LastExitOk "create-deployment"
Write-Host "SUCCESS: webhook live at https://$ApiId.execute-api.$Region.amazonaws.com/$Stage/webhooks/retell" -ForegroundColor Green
Write-Host "Point Retell's webhook URL at that address, and make sure RETELL_WEBHOOK_SECRET matches." -ForegroundColor DarkGray
