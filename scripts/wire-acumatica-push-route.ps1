<#
.SYNOPSIS
    Wires the POST /acumatica/push route on the Sundial REST API (API Gateway
    5sktfwldh1, region us-west-1, stage prod) to the sundial-acumatica-push
    Lambda, with a MOCK OPTIONS method for CORS and the Lambda invoke permission.

.DESCRIPTION
    This is the Layer 1 customer + project push: given a Sundial_Customer__c id in
    the request BODY (not the path), the Lambda creates the customer and its linked
    solar project in Acumatica and sets Synced_to_Acumatica__c. The portal's
    "Sync to Acumatica" button on Customer detail calls it, and it is the
    prerequisite for the budget push (which rejects with CUSTOMER_NOT_SYNCED
    until that flag is true).

    Cloned from wire-design-request-route.ps1, which is the pattern that actually
    works in this environment. NOTE: wire-budget-push-route.ps1 and
    wire-budget-recalc-route.ps1 are OLDER and carry two bugs this script avoids -
    see the quoting-workaround note below. Prefer this file (or the design-request
    one) as the template for any new route.

    Idempotent: every step checks for the existing resource/method before creating.
    Mirrors the gateway conventions in docs/api-endpoints.md (REST API v1,
    AWS_PROXY integration, MOCK OPTIONS returning CORS headers).

    Auth is enforced INSIDE the Lambda (resolveIdentity verifies the Supabase JWT),
    so the gateway method uses authorization-type NONE - matching every other
    Sundial route.

    PRECONDITIONS (verified; the script stops if unmet):
      1. The sundial-acumatica-push Lambda must already exist.
      2. Deploying to the PRODUCTION stage is a live change; prompts before the
         final create-deployment unless -Yes is passed.

    Path is built as nested resources:  /acumatica -> /acumatica/push (POST + OPTIONS)

.EXAMPLE
    .\scripts\wire-acumatica-push-route.ps1          # interactive, prompts before prod deploy
    .\scripts\wire-acumatica-push-route.ps1 -Yes     # non-interactive
#>
[CmdletBinding()]
param([switch]$Yes)

# "Continue", not "Stop": PS 5.1 wraps a native command's stderr in ErrorRecords,
# so "Stop" turns every harmless "already exists" message into a fatal throw.
# Real failures are caught by Assert-LastExitOk on the steps that matter.
$ErrorActionPreference = "Continue"
$Region  = "us-west-1"
$ApiId   = "5sktfwldh1"
$Stage   = "prod"
$Fn      = "sundial-acumatica-push"
$AcctId  = "891377232720"
$FnArn   = "arn:aws:lambda:${Region}:${AcctId}:function:${Fn}"
$IntegrationUri = "arn:aws:apigateway:${Region}:lambda:path/2015-03-31/functions/${FnArn}/invocations"

# --- AWS CLI quoting workarounds (see wire-copy-files-route.ps1 for the full note)
#   1. `--api-key-required $false` renders as "False" and the CLI rejects it, so
#      put-method silently no-ops and put-integration then fails. Use the flag form.
#   2. The CLI's shorthand map parser splits on commas regardless of quoting, and
#      PS 5.1's `Out-File -Encoding utf8` adds a BOM the CLI won't parse - so the
#      MOCK template and CORS response params go through no-BOM JSON files.
$TmpDir = Join-Path $env:TEMP "sundial-wire-acumatica-push"
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
    Assert-LastExitOk "create-resource ($pathPart)"
    Write-Host "  created resource '$pathPart' ($($created.id))"
    return $created.id
}

# --- Precondition: Lambda must exist -----------------------------------------
Write-Host "==> Verifying $Fn exists..." -ForegroundColor Cyan
aws lambda get-function-configuration --function-name $Fn --region $Region --output json | Out-Null
Assert-LastExitOk "get-function-configuration ($Fn)"

# --- Root resource id ---------------------------------------------------------
$root = (aws apigateway get-resources --rest-api-id $ApiId --region $Region --limit 500 --output json | ConvertFrom-Json).items |
    Where-Object { $_.path -eq "/" } | Select-Object -First 1
if (-not $root) { throw "Could not find root resource." }

Write-Host "==> Ensuring resource path /acumatica/push" -ForegroundColor Cyan
$acumatica = Ensure-Resource $root.id "acumatica"
$push      = Ensure-Resource $acumatica "push"

# --- POST method + AWS_PROXY integration -------------------------------------
Write-Host "==> POST method -> $Fn (AWS_PROXY)" -ForegroundColor Cyan
aws apigateway put-method --rest-api-id $ApiId --region $Region --resource-id $push `
    --http-method POST --authorization-type NONE --no-api-key-required 2>$null | Out-Null
aws apigateway put-integration --rest-api-id $ApiId --region $Region --resource-id $push `
    --http-method POST --type AWS_PROXY --integration-http-method POST --uri $IntegrationUri | Out-Null
Assert-LastExitOk "put-integration (POST)"
aws apigateway put-method-response --rest-api-id $ApiId --region $Region --resource-id $push `
    --http-method POST --status-code 200 `
    --response-parameters "method.response.header.Access-Control-Allow-Origin=false" 2>$null | Out-Null

# --- OPTIONS (MOCK) for CORS preflight ---------------------------------------
Write-Host "==> OPTIONS method (MOCK CORS)" -ForegroundColor Cyan
aws apigateway put-method --rest-api-id $ApiId --region $Region --resource-id $push `
    --http-method OPTIONS --authorization-type NONE 2>$null | Out-Null
aws apigateway put-integration --rest-api-id $ApiId --region $Region --resource-id $push `
    --http-method OPTIONS --type MOCK --request-templates "file://$MockTemplateFile" | Out-Null
Assert-LastExitOk "put-integration (OPTIONS MOCK)"
aws apigateway put-method-response --rest-api-id $ApiId --region $Region --resource-id $push `
    --http-method OPTIONS --status-code 200 `
    --response-parameters "method.response.header.Access-Control-Allow-Headers=false,method.response.header.Access-Control-Allow-Methods=false,method.response.header.Access-Control-Allow-Origin=false" 2>$null | Out-Null
aws apigateway put-integration-response --rest-api-id $ApiId --region $Region --resource-id $push `
    --http-method OPTIONS --status-code 200 `
    --response-parameters "file://$CorsParamsFile" | Out-Null
Assert-LastExitOk "put-integration-response (OPTIONS)"

# --- Lambda invoke permission for this route ---------------------------------
Write-Host "==> Lambda invoke permission (apigateway)" -ForegroundColor Cyan
$srcArn = "arn:aws:execute-api:${Region}:${AcctId}:${ApiId}/*/POST/acumatica/push"
aws lambda add-permission --function-name $Fn --region $Region `
    --statement-id "apigw-acumatica-push" --action "lambda:InvokeFunction" `
    --principal apigateway.amazonaws.com --source-arn $srcArn 2>$null | Out-Null
Write-Host "  (a 'ResourceConflictException' here just means the permission already exists - safe)" -ForegroundColor DarkGray

# --- Deploy to prod (the live change) ----------------------------------------
if (-not $Yes) {
    $ans = Read-Host "Deploy API to '$Stage' now? This is a LIVE production change. (y/N)"
    if ($ans -ne "y") { Write-Host "Skipped deploy. Route created but NOT live until you deploy." -ForegroundColor Yellow; exit 0 }
}
Write-Host "==> create-deployment -> $Stage" -ForegroundColor Cyan
aws apigateway create-deployment --rest-api-id $ApiId --region $Region --stage-name $Stage `
    --description "Add POST /acumatica/push -> $Fn" | Out-Null
Assert-LastExitOk "create-deployment"
Write-Host "SUCCESS: route live at https://$ApiId.execute-api.$Region.amazonaws.com/$Stage/acumatica/push" -ForegroundColor Green
