<#
.SYNOPSIS
    Wires POST /projects/{recordId}/files/copy-to-solar on the Sundial REST API
    (API Gateway 5sktfwldh1, region us-west-1, stage prod) to the sundial-list-files
    Lambda, with a MOCK OPTIONS method for CORS and the Lambda invoke permission.

    {recordId} carries a Sundial_Customer__c id. The name is {recordId} rather than
    {customerId} because /projects/{recordId} already exists (budget recalc) and API
    Gateway forbids two sibling path variables with different names at the same
    level. The caller-visible URL is unchanged: POST /projects/<customer id>/files/copy-to-solar

    The Lambda reads the customer's Linked_Solar_Project__c server-side and copies
    SUNDIAL/{customerId}/* to SUNDIAL/{solarId}/* with S3 CopyObject. The destination
    is NEVER taken from the request.

.DESCRIPTION
    Idempotent: every step checks for the existing resource/method before creating.
    Mirrors wire-budget-recalc-route.ps1 exactly (REST API v1, AWS_PROXY integration,
    MOCK OPTIONS returning CORS headers). /projects/{recordId} already exists;
    Ensure-Resource reuses it and only adds files/copy-to-solar.

    PRECONDITIONS (verified; the script stops if unmet):
      1. The sundial-list-files Lambda must already exist.
      2. Deploying to the PRODUCTION stage is a live change; prompts before the final
         create-deployment unless -Yes is passed.

    IAM: the execution role (sundial-lambda-execution-role) needs s3:ListBucket on
    the bucket plus GetObject/PutObject on sfsolproj/SUNDIAL/*. Verified 2026-08-03 —
    the role has AmazonS3FullAccess attached, so no IAM change is required.

.EXAMPLE
    .\scripts\wire-copy-files-route.ps1            # interactive, prompts before prod deploy
    .\scripts\wire-copy-files-route.ps1 -Yes       # non-interactive
#>
[CmdletBinding()]
param([switch]$Yes)

# Continue (not Stop): the AWS CLI writes benign notices to stderr which PS 5.1
# would otherwise turn into terminating errors. Every step is idempotent (resource
# lookups + overwriting put-method/put-integration), so re-running is safe; the
# precondition + root checks below still throw explicitly on real failure.
$ErrorActionPreference = "Continue"
$Region  = "us-west-1"
$ApiId   = "5sktfwldh1"
$Stage   = "prod"
$Fn      = "sundial-list-files"
$AcctId  = "891377232720"
$FnArn   = "arn:aws:lambda:${Region}:${AcctId}:function:${Fn}"
$IntegrationUri = "arn:aws:apigateway:${Region}:lambda:path/2015-03-31/functions/${FnArn}/invocations"

# --- AWS CLI quoting workarounds (learned the hard way, 2026-08-03) -----------
# Two things the older wire-*.ps1 scripts get wrong, which fail SILENTLY there
# because their calls are suppressed with 2>$null:
#   1. `--api-key-required $false` -> PowerShell renders "False", which the CLI
#      rejects ("Unknown options: False"), so put-method never runs and the
#      following put-integration dies with "Invalid Method identifier".
#      Use the explicit --no-api-key-required flag instead.
#   2. The CLI's shorthand map parser splits on commas REGARDLESS of quoting, so
#      inline values like 'OPTIONS,POST' or the MOCK request template blow up.
#      Pass those as JSON files instead.
$TmpDir = Join-Path $env:TEMP "sundial-wire-copy-files"
New-Item -ItemType Directory -Force -Path $TmpDir | Out-Null
$MockTemplateFile = Join-Path $TmpDir "mock-template.json"
$CorsParamsFile   = Join-Path $TmpDir "cors-response-params.json"
# WriteAllText with an explicit no-BOM encoding: PowerShell 5.1's `Out-File -Encoding
# utf8` emits a BOM, and the AWS CLI fails to parse a file:// JSON payload that starts
# with one ("Expected: '=', received: '﻿'"). Same BOM trap as the .mjs bundle.
$NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($MockTemplateFile, '{"application/json":"{\"statusCode\": 200}"}', $NoBom)
[System.IO.File]::WriteAllText($CorsParamsFile, @'
{
  "method.response.header.Access-Control-Allow-Headers": "'Content-Type,Authorization'",
  "method.response.header.Access-Control-Allow-Methods": "'OPTIONS,POST'",
  "method.response.header.Access-Control-Allow-Origin": "'*'"
}
'@, $NoBom)

# Fail loudly instead of printing SUCCESS over a broken route.
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

Write-Host "==> Ensuring resource path /projects/{recordId}/files/copy-to-solar" -ForegroundColor Cyan
$projects = Ensure-Resource $root.id "projects"
$recordId = Ensure-Resource $projects "{recordId}"
$files    = Ensure-Resource $recordId "files"
$copy     = Ensure-Resource $files "copy-to-solar"

# --- POST method + AWS_PROXY integration -------------------------------------
# put-method / put-method-response are ConflictException on re-run (already exists),
# which is fine — so their stderr is suppressed and only the integration (which
# overwrites cleanly) is asserted.
Write-Host "==> POST method -> $Fn (AWS_PROXY)" -ForegroundColor Cyan
aws apigateway put-method --rest-api-id $ApiId --region $Region --resource-id $copy `
    --http-method POST --authorization-type NONE --no-api-key-required 2>$null | Out-Null
aws apigateway put-integration --rest-api-id $ApiId --region $Region --resource-id $copy `
    --http-method POST --type AWS_PROXY --integration-http-method POST --uri $IntegrationUri | Out-Null
Assert-LastExitOk "put-integration (POST)"
aws apigateway put-method-response --rest-api-id $ApiId --region $Region --resource-id $copy `
    --http-method POST --status-code 200 `
    --response-parameters "method.response.header.Access-Control-Allow-Origin=false" 2>$null | Out-Null

# --- OPTIONS (MOCK) for CORS preflight ---------------------------------------
Write-Host "==> OPTIONS method (MOCK CORS)" -ForegroundColor Cyan
aws apigateway put-method --rest-api-id $ApiId --region $Region --resource-id $copy `
    --http-method OPTIONS --authorization-type NONE 2>$null | Out-Null
aws apigateway put-integration --rest-api-id $ApiId --region $Region --resource-id $copy `
    --http-method OPTIONS --type MOCK --request-templates "file://$MockTemplateFile" | Out-Null
Assert-LastExitOk "put-integration (OPTIONS MOCK)"
aws apigateway put-method-response --rest-api-id $ApiId --region $Region --resource-id $copy `
    --http-method OPTIONS --status-code 200 `
    --response-parameters "method.response.header.Access-Control-Allow-Headers=false,method.response.header.Access-Control-Allow-Methods=false,method.response.header.Access-Control-Allow-Origin=false" 2>$null | Out-Null
aws apigateway put-integration-response --rest-api-id $ApiId --region $Region --resource-id $copy `
    --http-method OPTIONS --status-code 200 `
    --response-parameters "file://$CorsParamsFile" | Out-Null
Assert-LastExitOk "put-integration-response (OPTIONS)"

# --- Lambda invoke permission for this route ---------------------------------
Write-Host "==> Lambda invoke permission (apigateway)" -ForegroundColor Cyan
$srcArn = "arn:aws:execute-api:${Region}:${AcctId}:${ApiId}/*/POST/projects/*/files/copy-to-solar"
aws lambda add-permission --function-name $Fn --region $Region `
    --statement-id "apigw-files-copy-to-solar" --action "lambda:InvokeFunction" `
    --principal apigateway.amazonaws.com --source-arn $srcArn 2>$null | Out-Null
Write-Host "  (a 'ResourceConflictException' here just means the permission already exists - safe)" -ForegroundColor DarkGray

# --- Deploy to prod (the live change) ----------------------------------------
if (-not $Yes) {
    $ans = Read-Host "Deploy API to '$Stage' now? This is a LIVE production change. (y/N)"
    if ($ans -ne "y") { Write-Host "Skipped deploy. Route created but NOT live until you deploy." -ForegroundColor Yellow; exit 0 }
}
Write-Host "==> create-deployment -> $Stage" -ForegroundColor Cyan
aws apigateway create-deployment --rest-api-id $ApiId --region $Region --stage-name $Stage `
    --description "Add POST /projects/{recordId}/files/copy-to-solar -> $Fn" | Out-Null
Assert-LastExitOk "create-deployment"
Write-Host "SUCCESS: route live at https://$ApiId.execute-api.$Region.amazonaws.com/$Stage/projects/{customerId}/files/copy-to-solar" -ForegroundColor Green
