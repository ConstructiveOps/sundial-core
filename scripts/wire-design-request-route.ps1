<#
.SYNOPSIS
    Wires POST /projects/{recordId}/design-request/submit on the Sundial REST API
    (API Gateway 5sktfwldh1, region us-west-1, stage prod) to the sundial-aurora-push
    Lambda, with a MOCK OPTIONS method for CORS and the Lambda invoke permission.

    {recordId} here is a Sundial_Solar__c record id (the "Submit Design Request"
    button on the Solar Design Request Form tab). The Lambda resolves the linked
    customer server-side and pushes it to Aurora. (Later: also emails the sales
    manager once SES is live - additive, no route change.)

.DESCRIPTION
    Idempotent: every step checks for the existing resource/method before creating.
    Mirrors wire-budget-recalc-route.ps1 exactly (REST API v1, AWS_PROXY integration,
    MOCK OPTIONS returning CORS headers). /projects/{recordId} already exists (created
    by the budget route); Ensure-Resource reuses it and only adds design-request/submit.

    PRECONDITIONS (verified; the script stops if unmet):
      1. The sundial-aurora-push Lambda must already exist.
      2. Deploying to the PRODUCTION stage is a live change; prompts before the final
         create-deployment unless -Yes is passed.

.EXAMPLE
    .\scripts\wire-design-request-route.ps1            # interactive, prompts before prod deploy
    .\scripts\wire-design-request-route.ps1 -Yes       # non-interactive
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
$Fn      = "sundial-aurora-push"
$AcctId  = "891377232720"
$FnArn   = "arn:aws:lambda:${Region}:${AcctId}:function:${Fn}"
$IntegrationUri = "arn:aws:apigateway:${Region}:lambda:path/2015-03-31/functions/${FnArn}/invocations"

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

Write-Host "==> Ensuring resource path /projects/{recordId}/design-request/submit" -ForegroundColor Cyan
$projects = Ensure-Resource $root.id "projects"
$recordId = Ensure-Resource $projects "{recordId}"
$dr       = Ensure-Resource $recordId "design-request"
$submit   = Ensure-Resource $dr "submit"

# --- POST method + AWS_PROXY integration -------------------------------------
Write-Host "==> POST method -> $Fn (AWS_PROXY)" -ForegroundColor Cyan
aws apigateway put-method --rest-api-id $ApiId --region $Region --resource-id $submit `
    --http-method POST --authorization-type NONE --api-key-required $false 2>$null | Out-Null
aws apigateway put-integration --rest-api-id $ApiId --region $Region --resource-id $submit `
    --http-method POST --type AWS_PROXY --integration-http-method POST --uri $IntegrationUri | Out-Null
aws apigateway put-method-response --rest-api-id $ApiId --region $Region --resource-id $submit `
    --http-method POST --status-code 200 `
    --response-parameters "method.response.header.Access-Control-Allow-Origin=false" 2>$null | Out-Null

# --- OPTIONS (MOCK) for CORS preflight ---------------------------------------
Write-Host "==> OPTIONS method (MOCK CORS)" -ForegroundColor Cyan
aws apigateway put-method --rest-api-id $ApiId --region $Region --resource-id $submit `
    --http-method OPTIONS --authorization-type NONE 2>$null | Out-Null
aws apigateway put-integration --rest-api-id $ApiId --region $Region --resource-id $submit `
    --http-method OPTIONS --type MOCK --request-templates '{\"application/json\":\"{\\\"statusCode\\\": 200}\"}' | Out-Null
aws apigateway put-method-response --rest-api-id $ApiId --region $Region --resource-id $submit `
    --http-method OPTIONS --status-code 200 `
    --response-parameters "method.response.header.Access-Control-Allow-Headers=false,method.response.header.Access-Control-Allow-Methods=false,method.response.header.Access-Control-Allow-Origin=false" 2>$null | Out-Null
aws apigateway put-integration-response --rest-api-id $ApiId --region $Region --resource-id $submit `
    --http-method OPTIONS --status-code 200 `
    --response-parameters "method.response.header.Access-Control-Allow-Headers='Content-Type,Authorization',method.response.header.Access-Control-Allow-Methods='OPTIONS,POST',method.response.header.Access-Control-Allow-Origin='*'" | Out-Null

# --- Lambda invoke permission for this route ---------------------------------
Write-Host "==> Lambda invoke permission (apigateway)" -ForegroundColor Cyan
$srcArn = "arn:aws:execute-api:${Region}:${AcctId}:${ApiId}/*/POST/projects/*/design-request/submit"
aws lambda add-permission --function-name $Fn --region $Region `
    --statement-id "apigw-design-request-submit" --action "lambda:InvokeFunction" `
    --principal apigateway.amazonaws.com --source-arn $srcArn 2>$null | Out-Null
Write-Host "  (a 'ResourceConflictException' here just means the permission already exists - safe)" -ForegroundColor DarkGray

# --- Deploy to prod (the live change) ----------------------------------------
if (-not $Yes) {
    $ans = Read-Host "Deploy API to '$Stage' now? This is a LIVE production change. (y/N)"
    if ($ans -ne "y") { Write-Host "Skipped deploy. Route created but NOT live until you deploy." -ForegroundColor Yellow; exit 0 }
}
Write-Host "==> create-deployment -> $Stage" -ForegroundColor Cyan
aws apigateway create-deployment --rest-api-id $ApiId --region $Region --stage-name $Stage `
    --description "Add POST /projects/{recordId}/design-request/submit -> $Fn" | Out-Null
Write-Host "SUCCESS: route live at https://$ApiId.execute-api.$Region.amazonaws.com/$Stage/projects/{recordId}/design-request/submit" -ForegroundColor Green
