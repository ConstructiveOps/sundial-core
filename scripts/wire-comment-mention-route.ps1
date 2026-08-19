<#
.SYNOPSIS
    Wires POST /webhooks/comment-mention on the Sundial REST API (API Gateway
    5sktfwldh1, region us-west-1, stage prod) to the sundial-comment-notify Lambda,
    with a MOCK OPTIONS method for CORS and the Lambda invoke permission.

.DESCRIPTION
    Modelled on wire-design-request-route.ps1 (the known-good template).
    Deliberately NOT modelled on wire-budget-push-route.ps1 or
    wire-budget-recalc-route.ps1 — both are broken, and the first prints SUCCESS even
    when the deployment failed.

    The caller here is POSTGRES, not a browser and not a portal user: an AFTER INSERT
    trigger on comment_mentions posts through pg_net (sql/sundial_comment_mention_notify.sql).
    So there is NO Supabase JWT and NO API-Gateway authorizer — the only gate is the
    X-Sundial-Comment-Secret header, constant-time compared in-Lambda, which FAILS
    CLOSED when the secret is unreadable.

    Idempotent: every step checks for the existing resource/method before creating, and
    put-method / put-integration overwrite. Re-running is safe.

    PRECONDITIONS (the script stops if unmet):
      1. The sundial-comment-notify Lambda must already exist.
      2. Deploying to the PRODUCTION stage is a live change; prompts before the final
         create-deployment unless -Yes is passed.

    ORDER MATTERS. Wire and verify this route BEFORE applying
    sql/sundial_comment_mention_notify.sql — the trigger starts posting the moment the
    database settings are set, and a 404 from an unwired route is a silently lost
    notification (the trigger swallows it by design).

    AFTER WIRING, set the Lambda's config (see docs/api-endpoints.md > Lambda
    environment variables and docs/integrations/comment-mention-alerts.md):
      - Secrets Manager `sundial/comment-notify` with { "comment_notify_secret": "..." }
      - env PORTAL_BASE_URL (defaults in code to https://sundial.harmonelectric.net)
      - env EMAIL_FROM (until it is set the Lambda reports email_not_configured and
        sends nothing — deliberately non-fatal, so this can ship before SES)
      - the execution role needs ses:SendEmail for the send step to succeed

.EXAMPLE
    .\scripts\wire-comment-mention-route.ps1            # interactive, prompts before prod deploy
    .\scripts\wire-comment-mention-route.ps1 -Yes       # non-interactive
#>
[CmdletBinding()]
param([switch]$Yes)

# Continue (not Stop): the AWS CLI writes benign notices to stderr which PS 5.1 would
# otherwise turn into terminating errors. Every step is idempotent; the explicit
# Assert-LastExitOk calls below still throw on real failure.
$ErrorActionPreference = "Continue"
$Region  = "us-west-1"
$ApiId   = "5sktfwldh1"
$Stage   = "prod"
$Fn      = "sundial-comment-notify"
$AcctId  = "891377232720"
$FnArn   = "arn:aws:lambda:${Region}:${AcctId}:function:${Fn}"
$IntegrationUri = "arn:aws:apigateway:${Region}:lambda:path/2015-03-31/functions/${FnArn}/invocations"

# --- AWS CLI quoting workarounds (see wire-copy-files-route.ps1 for the full note)
#   1. `--api-key-required $false` renders as "False" and the CLI rejects it, so
#      put-method silently no-ops and put-integration then fails. Use the flag form.
#   2. The CLI's shorthand map parser splits on commas regardless of quoting, and
#      PS 5.1's `Out-File -Encoding utf8` adds a BOM the CLI won't parse — so the
#      MOCK template and CORS response params go through no-BOM JSON files.
$TmpDir = Join-Path $env:TEMP "sundial-wire-comment-mention"
New-Item -ItemType Directory -Force -Path $TmpDir | Out-Null
$MockTemplateFile = Join-Path $TmpDir "mock-template.json"
$CorsParamsFile   = Join-Path $TmpDir "cors-response-params.json"
$NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($MockTemplateFile, '{"application/json":"{\"statusCode\": 200}"}', $NoBom)
[System.IO.File]::WriteAllText($CorsParamsFile, @'
{
  "method.response.header.Access-Control-Allow-Headers": "'Content-Type,X-Sundial-Comment-Secret'",
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

# --- Precondition: Lambda must exist -----------------------------------------
Write-Host "==> Verifying $Fn exists..." -ForegroundColor Cyan
aws lambda get-function-configuration --function-name $Fn --region $Region --output json | Out-Null
if ($LASTEXITCODE -ne 0) { throw "$Fn does not exist yet. Create it, then re-run." }

# --- Root resource id ---------------------------------------------------------
$root = (aws apigateway get-resources --rest-api-id $ApiId --region $Region --limit 500 --output json | ConvertFrom-Json).items |
    Where-Object { $_.path -eq "/" } | Select-Object -First 1
if (-not $root) { throw "Could not find root resource." }

Write-Host "==> Ensuring resource path /webhooks/comment-mention" -ForegroundColor Cyan
# /webhooks already exists (aurora, retell, acumatica live under it) — a no-op here.
$webhooks = Ensure-Resource $root.id "webhooks"
$mention  = Ensure-Resource $webhooks "comment-mention"

# --- POST method + AWS_PROXY integration -------------------------------------
Write-Host "==> POST method -> $Fn (AWS_PROXY, NO authorizer - shared secret is the gate)" -ForegroundColor Cyan
aws apigateway put-method --rest-api-id $ApiId --region $Region --resource-id $mention `
    --http-method POST --authorization-type NONE --no-api-key-required 2>$null | Out-Null
aws apigateway put-integration --rest-api-id $ApiId --region $Region --resource-id $mention `
    --http-method POST --type AWS_PROXY --integration-http-method POST --uri $IntegrationUri | Out-Null
Assert-LastExitOk "put-integration (POST)"
aws apigateway put-method-response --rest-api-id $ApiId --region $Region --resource-id $mention `
    --http-method POST --status-code 200 `
    --response-parameters "method.response.header.Access-Control-Allow-Origin=false" 2>$null | Out-Null

# --- OPTIONS (MOCK) for CORS preflight ---------------------------------------
Write-Host "==> OPTIONS method (MOCK CORS)" -ForegroundColor Cyan
aws apigateway put-method --rest-api-id $ApiId --region $Region --resource-id $mention `
    --http-method OPTIONS --authorization-type NONE 2>$null | Out-Null
aws apigateway put-integration --rest-api-id $ApiId --region $Region --resource-id $mention `
    --http-method OPTIONS --type MOCK --request-templates "file://$MockTemplateFile" | Out-Null
Assert-LastExitOk "put-integration (OPTIONS MOCK)"
aws apigateway put-method-response --rest-api-id $ApiId --region $Region --resource-id $mention `
    --http-method OPTIONS --status-code 200 `
    --response-parameters "method.response.header.Access-Control-Allow-Headers=false,method.response.header.Access-Control-Allow-Methods=false,method.response.header.Access-Control-Allow-Origin=false" 2>$null | Out-Null
aws apigateway put-integration-response --rest-api-id $ApiId --region $Region --resource-id $mention `
    --http-method OPTIONS --status-code 200 `
    --response-parameters "file://$CorsParamsFile" | Out-Null
Assert-LastExitOk "put-integration-response (OPTIONS)"

# --- Lambda invoke permission for this route ---------------------------------
Write-Host "==> Lambda invoke permission (apigateway)" -ForegroundColor Cyan
$srcArn = "arn:aws:execute-api:${Region}:${AcctId}:${ApiId}/*/POST/webhooks/comment-mention"
aws lambda add-permission --function-name $Fn --region $Region `
    --statement-id "apigw-comment-mention" --action "lambda:InvokeFunction" `
    --principal apigateway.amazonaws.com --source-arn $srcArn 2>$null | Out-Null
Write-Host "  (a 'ResourceConflictException' here just means the permission already exists - safe)" -ForegroundColor DarkGray

# --- Deploy to prod (the live change) ----------------------------------------
if (-not $Yes) {
    $ans = Read-Host "Deploy API to '$Stage' now? This is a LIVE production change. (y/N)"
    if ($ans -ne "y") { Write-Host "Skipped deploy. Route created but NOT live until you deploy." -ForegroundColor Yellow; exit 0 }
}
Write-Host "==> create-deployment -> $Stage" -ForegroundColor Cyan
aws apigateway create-deployment --rest-api-id $ApiId --region $Region --stage-name $Stage `
    --description "Comment @-mention notification hook -> $Fn" | Out-Null
Assert-LastExitOk "create-deployment"

$url = "https://$ApiId.execute-api.$Region.amazonaws.com/$Stage/webhooks/comment-mention"
Write-Host "SUCCESS: route live at $url" -ForegroundColor Green
Write-Host ""
Write-Host "Verify it fails closed BEFORE enabling the trigger:" -ForegroundColor DarkGray
Write-Host "  curl -i -X POST $url -H 'Content-Type: application/json' -d '{}'   # expect 401" -ForegroundColor DarkGray
Write-Host "Then set the database settings named in sql/sundial_comment_mention_notify.sql." -ForegroundColor DarkGray
