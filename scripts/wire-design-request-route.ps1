<#
.SYNOPSIS
    Wires POST /customers/{recordId}/design-request/submit on the Sundial REST API
    (API Gateway 5sktfwldh1, region us-west-1, stage prod) to the sundial-aurora-push
    Lambda, with a MOCK OPTIONS method for CORS and the Lambda invoke permission.

    Also REMOVES the superseded POST /projects/{recordId}/design-request/submit route
    (see -RemoveLegacy below).

    {recordId} here is a Sundial_Customer__c record id. ALL Aurora integration runs on
    Sundial_Customer__c: at design-request time no Sundial_Solar__c record exists yet
    (it is created only after the proposal is done and docs are signed) - D-047. The
    Lambda reads the customer fresh, pushes it to Aurora, and emails the design manager
    the full Design Request field set.

.DESCRIPTION
    Idempotent: every step checks for the existing resource/method before creating.
    Mirrors wire-budget-recalc-route.ps1 (REST API v1, AWS_PROXY integration, MOCK
    OPTIONS returning CORS headers).

    -RemoveLegacy (default ON) deletes the old /projects/{recordId}/design-request
    subtree, which was wired but never referenced by any frontend. It leaves
    /projects/{recordId} itself alone - the budget recalc route lives there.

    PRECONDITIONS (verified; the script stops if unmet):
      1. The sundial-aurora-push Lambda must already exist.
      2. Deploying to the PRODUCTION stage is a live change; prompts before the final
         create-deployment unless -Yes is passed.

    AFTER WIRING, set the notification recipients on the Lambda (required for the
    email step; see docs/api-endpoints.md > Lambda environment variables):
      aws lambda update-function-configuration --function-name sundial-aurora-push `
        --region us-west-1 --environment "Variables={EMAIL_FROM=...,DESIGN_REQUEST_NOTIFY_TO=...,DESIGN_REQUEST_NOTIFY_CC=...}"

.EXAMPLE
    .\scripts\wire-design-request-route.ps1            # interactive, prompts before prod deploy
    .\scripts\wire-design-request-route.ps1 -Yes       # non-interactive
    .\scripts\wire-design-request-route.ps1 -RemoveLegacy:$false   # keep the old route
#>
[CmdletBinding()]
param([switch]$Yes, [bool]$RemoveLegacy = $true)

# Continue (not Stop): the AWS CLI writes benign notices to stderr which PS 5.1
# would otherwise turn into terminating errors. Every step is idempotent (resource
# lookups + overwriting put-method/put-integration), so re-running is safe; the
# precondition + root checks below still throw explicitly on real failure.
$ErrorActionPreference = "Continue"
$Region  = "us-west-1"
$ApiId   = "5sktfwldh1"
$Stage   = "prod"
$Fn      = "sundial-aurora-push"
$AcctId  = "891377232720"
$FnArn   = "arn:aws:lambda:${Region}:${AcctId}:function:${Fn}"
$IntegrationUri = "arn:aws:apigateway:${Region}:lambda:path/2015-03-31/functions/${FnArn}/invocations"

# --- AWS CLI quoting workarounds (see wire-copy-files-route.ps1 for the full note)
#   1. `--api-key-required $false` renders as "False" and the CLI rejects it, so
#      put-method silently no-ops and put-integration then fails. Use the flag form.
#   2. The CLI's shorthand map parser splits on commas regardless of quoting, and
#      PS 5.1's `Out-File -Encoding utf8` adds a BOM the CLI won't parse — so the
#      MOCK template and CORS response params go through no-BOM JSON files.
$TmpDir = Join-Path $env:TEMP "sundial-wire-design-request"
New-Item -ItemType Directory -Force -Path $TmpDir | Out-Null
$MockTemplateFile = Join-Path $TmpDir "mock-template.json"
$CorsParamsFile   = Join-Path $TmpDir "cors-response-params.json"
$NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($MockTemplateFile, '{"application/json":"{\"statusCode\": 200}"}', $NoBom)
[System.IO.File]::WriteAllText($CorsParamsFile, @'
{
  "method.response.header.Access-Control-Allow-Headers": "'Content-Type,Authorization'",
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

Write-Host "==> Ensuring resource path /customers/{recordId}/design-request/submit" -ForegroundColor Cyan
$customers = Ensure-Resource $root.id "customers"
$recordId  = Ensure-Resource $customers "{recordId}"
$dr        = Ensure-Resource $recordId "design-request"
$submit    = Ensure-Resource $dr "submit"

# --- POST method + AWS_PROXY integration -------------------------------------
Write-Host "==> POST method -> $Fn (AWS_PROXY)" -ForegroundColor Cyan
aws apigateway put-method --rest-api-id $ApiId --region $Region --resource-id $submit `
    --http-method POST --authorization-type NONE --no-api-key-required 2>$null | Out-Null
aws apigateway put-integration --rest-api-id $ApiId --region $Region --resource-id $submit `
    --http-method POST --type AWS_PROXY --integration-http-method POST --uri $IntegrationUri | Out-Null
Assert-LastExitOk "put-integration (POST)"
aws apigateway put-method-response --rest-api-id $ApiId --region $Region --resource-id $submit `
    --http-method POST --status-code 200 `
    --response-parameters "method.response.header.Access-Control-Allow-Origin=false" 2>$null | Out-Null

# --- OPTIONS (MOCK) for CORS preflight ---------------------------------------
Write-Host "==> OPTIONS method (MOCK CORS)" -ForegroundColor Cyan
aws apigateway put-method --rest-api-id $ApiId --region $Region --resource-id $submit `
    --http-method OPTIONS --authorization-type NONE 2>$null | Out-Null
aws apigateway put-integration --rest-api-id $ApiId --region $Region --resource-id $submit `
    --http-method OPTIONS --type MOCK --request-templates "file://$MockTemplateFile" | Out-Null
Assert-LastExitOk "put-integration (OPTIONS MOCK)"
aws apigateway put-method-response --rest-api-id $ApiId --region $Region --resource-id $submit `
    --http-method OPTIONS --status-code 200 `
    --response-parameters "method.response.header.Access-Control-Allow-Headers=false,method.response.header.Access-Control-Allow-Methods=false,method.response.header.Access-Control-Allow-Origin=false" 2>$null | Out-Null
aws apigateway put-integration-response --rest-api-id $ApiId --region $Region --resource-id $submit `
    --http-method OPTIONS --status-code 200 `
    --response-parameters "file://$CorsParamsFile" | Out-Null
Assert-LastExitOk "put-integration-response (OPTIONS)"

# --- Lambda invoke permission for this route ---------------------------------
Write-Host "==> Lambda invoke permission (apigateway)" -ForegroundColor Cyan
$srcArn = "arn:aws:execute-api:${Region}:${AcctId}:${ApiId}/*/POST/customers/*/design-request/submit"
aws lambda add-permission --function-name $Fn --region $Region `
    --statement-id "apigw-customer-design-request-submit" --action "lambda:InvokeFunction" `
    --principal apigateway.amazonaws.com --source-arn $srcArn 2>$null | Out-Null
Write-Host "  (a 'ResourceConflictException' here just means the permission already exists - safe)" -ForegroundColor DarkGray

# --- Remove the superseded /projects/{recordId}/design-request route ----------
# Deleting the 'design-request' resource removes its children (submit + methods) too.
# /projects/{recordId} itself is left alone - budget/recalc still hangs off it.
if ($RemoveLegacy) {
    Write-Host "==> Removing legacy /projects/{recordId}/design-request" -ForegroundColor Cyan
    $projects = Get-ChildResource $root.id "projects"
    if ($projects) {
        $legacyRecordId = Get-ChildResource $projects "{recordId}"
        if ($legacyRecordId) {
            $legacyDr = Get-ChildResource $legacyRecordId "design-request"
            if ($legacyDr) {
                aws apigateway delete-resource --rest-api-id $ApiId --region $Region --resource-id $legacyDr | Out-Null
                if ($LASTEXITCODE -eq 0) { Write-Host "  deleted legacy resource ($legacyDr)" -ForegroundColor Yellow }
                else { Write-Host "  WARNING: delete-resource failed for $legacyDr - remove it by hand" -ForegroundColor Red }
            } else { Write-Host "  legacy resource already absent" -ForegroundColor DarkGray }
        }
    }
    # Drop the now-dangling invoke permission for the old path (safe if absent).
    aws lambda remove-permission --function-name $Fn --region $Region `
        --statement-id "apigw-design-request-submit" 2>$null | Out-Null
    Write-Host "  (a 'ResourceNotFoundException' here just means it was already gone - safe)" -ForegroundColor DarkGray
}

# --- Deploy to prod (the live change) ----------------------------------------
if (-not $Yes) {
    $ans = Read-Host "Deploy API to '$Stage' now? This is a LIVE production change. (y/N)"
    if ($ans -ne "y") { Write-Host "Skipped deploy. Route created but NOT live until you deploy." -ForegroundColor Yellow; exit 0 }
}
Write-Host "==> create-deployment -> $Stage" -ForegroundColor Cyan
aws apigateway create-deployment --rest-api-id $ApiId --region $Region --stage-name $Stage `
    --description "Move design-request submit to POST /customers/{recordId}/design-request/submit -> $Fn" | Out-Null
Assert-LastExitOk "create-deployment"
Write-Host "SUCCESS: route live at https://$ApiId.execute-api.$Region.amazonaws.com/$Stage/customers/{recordId}/design-request/submit" -ForegroundColor Green
