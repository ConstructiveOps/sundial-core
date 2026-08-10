<#
.SYNOPSIS
    Wires GET /webhooks/aurora/agreement-status on the Sundial REST API
    (API Gateway 5sktfwldh1, region us-west-1, stage prod) to the sundial-aurora-webhook
    Lambda ("doorbell"), with a MOCK OPTIONS method and the Lambda invoke permission.

    This route ALREADY EXISTS in the prod gateway (created when the receive-only
    doorbell shipped). The script is idempotent and is kept so the wiring is
    reproducible for a new tenant/stack — running it against Harmon is a no-op
    apart from the final deployment.

    NOTE ON THE PATH: the spec called this "/webhooks/aurora/agreement". The
    deployed resource is "/webhooks/aurora/agreement-status", which is the same
    endpoint under a more precise name and is what Aurora's subscription points at.
    It was NOT renamed: changing the path would break the live subscription URL for
    no functional gain.

.DESCRIPTION
    Aurora sends a GET with five query attributes and a shared-secret header:
      ?project_id=<PROJECT_ID>&design_id=<DESIGN_ID>&agreement_id=<AGREEMENT_ID>
      &financing_id=<FINANCING_ID>&status=<STATUS>
      X-Aurora-Webhook-Token: <shared secret>

    NO Supabase JWT and NO API-Gateway authorizer: the caller is a machine with no
    portal user. The shared-secret header is the only gate, checked in-Lambda with a
    constant-time compare.

    PRECONDITIONS (the script stops if unmet):
      1. sundial-aurora-webhook must exist.
      2. Deploying to the PRODUCTION stage is a live change; prompts unless -Yes.

    AFTER WIRING — the queue plumbing this doorbell needs (see the runbook in
    docs/integrations/aurora-inbound.md; NOT created by this script because queues
    and event-source mappings are hand-created infrastructure here):
      - SQS queue  sundial-aurora-inbound  + DLQ  sundial-aurora-inbound-dlq
      - redrive policy maxReceiveCount=5 on the main queue
      - env var AURORA_INBOUND_QUEUE_URL on sundial-aurora-webhook
      - event-source mapping: sundial-aurora-inbound -> sundial-aurora-inbound Lambda
        with ReportBatchItemFailures enabled

.EXAMPLE
    .\scripts\wire-aurora-webhook-route.ps1            # prompts before prod deploy
    .\scripts\wire-aurora-webhook-route.ps1 -Yes       # non-interactive
#>
[CmdletBinding()]
param([switch]$Yes)

$ErrorActionPreference = "Continue"
$Region  = "us-west-1"
$ApiId   = "5sktfwldh1"
$Stage   = "prod"
$Fn      = "sundial-aurora-webhook"
$AcctId  = "891377232720"
$FnArn   = "arn:aws:lambda:${Region}:${AcctId}:function:${Fn}"
$IntegrationUri = "arn:aws:apigateway:${Region}:lambda:path/2015-03-31/functions/${FnArn}/invocations"

# AWS CLI quoting workarounds — see the note in wire-copy-files-route.ps1:
# `--api-key-required $false` renders as "False" and is rejected; the shorthand map
# parser splits on commas regardless of quoting; and PS 5.1 `Out-File -Encoding utf8`
# writes a BOM the CLI can't parse. Hence flag form + no-BOM file:// JSON.
$TmpDir = Join-Path $env:TEMP "sundial-wire-aurora-webhook"
New-Item -ItemType Directory -Force -Path $TmpDir | Out-Null
$MockTemplateFile = Join-Path $TmpDir "mock-template.json"
$CorsParamsFile   = Join-Path $TmpDir "cors-response-params.json"
$NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($MockTemplateFile, '{"application/json":"{\"statusCode\": 200}"}', $NoBom)
[System.IO.File]::WriteAllText($CorsParamsFile, @'
{
  "method.response.header.Access-Control-Allow-Headers": "'Content-Type,X-Aurora-Webhook-Token'",
  "method.response.header.Access-Control-Allow-Methods": "'OPTIONS,GET'",
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

Write-Host "==> Ensuring resource path /webhooks/aurora/agreement-status" -ForegroundColor Cyan
$webhooks = Ensure-Resource $root.id "webhooks"
$aurora   = Ensure-Resource $webhooks "aurora"
$agr      = Ensure-Resource $aurora "agreement-status"

Write-Host "==> GET method -> $Fn (AWS_PROXY, NO authorizer - shared secret is the gate)" -ForegroundColor Cyan
aws apigateway put-method --rest-api-id $ApiId --region $Region --resource-id $agr `
    --http-method GET --authorization-type NONE --no-api-key-required 2>$null | Out-Null
aws apigateway put-integration --rest-api-id $ApiId --region $Region --resource-id $agr `
    --http-method GET --type AWS_PROXY --integration-http-method POST --uri $IntegrationUri | Out-Null
Assert-LastExitOk "put-integration (GET)"
aws apigateway put-method-response --rest-api-id $ApiId --region $Region --resource-id $agr `
    --http-method GET --status-code 200 2>$null | Out-Null

Write-Host "==> OPTIONS method (MOCK CORS)" -ForegroundColor Cyan
aws apigateway put-method --rest-api-id $ApiId --region $Region --resource-id $agr `
    --http-method OPTIONS --authorization-type NONE 2>$null | Out-Null
aws apigateway put-integration --rest-api-id $ApiId --region $Region --resource-id $agr `
    --http-method OPTIONS --type MOCK --request-templates "file://$MockTemplateFile" | Out-Null
Assert-LastExitOk "put-integration (OPTIONS MOCK)"
aws apigateway put-method-response --rest-api-id $ApiId --region $Region --resource-id $agr `
    --http-method OPTIONS --status-code 200 `
    --response-parameters "method.response.header.Access-Control-Allow-Headers=false,method.response.header.Access-Control-Allow-Methods=false,method.response.header.Access-Control-Allow-Origin=false" 2>$null | Out-Null
aws apigateway put-integration-response --rest-api-id $ApiId --region $Region --resource-id $agr `
    --http-method OPTIONS --status-code 200 --response-parameters "file://$CorsParamsFile" | Out-Null
Assert-LastExitOk "put-integration-response (OPTIONS)"

Write-Host "==> Lambda invoke permission (apigateway)" -ForegroundColor Cyan
$srcArn = "arn:aws:execute-api:${Region}:${AcctId}:${ApiId}/*/GET/webhooks/aurora/agreement-status"
aws lambda add-permission --function-name $Fn --region $Region `
    --statement-id "apigw-aurora-agreement-status" --action "lambda:InvokeFunction" `
    --principal apigateway.amazonaws.com --source-arn $srcArn 2>$null | Out-Null
Write-Host "  (a 'ResourceConflictException' here just means the permission already exists - safe)" -ForegroundColor DarkGray

if (-not $Yes) {
    $ans = Read-Host "Deploy API to '$Stage' now? This is a LIVE production change. (y/N)"
    if ($ans -ne "y") { Write-Host "Skipped deploy. Route created but NOT live until you deploy." -ForegroundColor Yellow; exit 0 }
}
Write-Host "==> create-deployment -> $Stage" -ForegroundColor Cyan
aws apigateway create-deployment --rest-api-id $ApiId --region $Region --stage-name $Stage `
    --description "Aurora agreement-status doorbell -> $Fn" | Out-Null
Assert-LastExitOk "create-deployment"
Write-Host "SUCCESS: doorbell live at https://$ApiId.execute-api.$Region.amazonaws.com/$Stage/webhooks/aurora/agreement-status" -ForegroundColor Green
