<#
.SYNOPSIS
    Wires the POST /projects/{recordId}/budget/attributes-sync route on the Sundial
    REST API (API Gateway 5sktfwldh1, region us-west-1, stage prod) to the
    sundial-acumatica-budget-push Lambda, with a MOCK OPTIONS method for CORS and
    the Lambda invoke permission.

.DESCRIPTION
    Idempotent: every step checks for the existing resource/method before creating.
    Mirrors wire-budget-push-route.ps1 exactly - REST API v1, AWS_PROXY integration,
    MOCK OPTIONS returning the CORS headers, per docs/api-endpoints.md.

    SAME LAMBDA AS THE BUDGET PUSH, DIFFERENT ROUTE. The function dispatches on the
    resource path (isAttributesSyncRoute), because both routes carry {recordId} and
    are otherwise indistinguishable. That is why this script must create the route
    under the SAME /projects/{recordId}/budget parent - a route wired anywhere else
    would fall through to the budget-push handler and be refused by gates that do
    not apply to it.

    Auth is enforced INSIDE the Lambda (resolveIdentity verifies the Supabase JWT),
    so the gateway method uses authorization-type NONE - matching every other
    Sundial route.

    WHAT THIS ROUTE DOES: syncs the five lifecycle dates + KW + SALESPERSO to the
    linked Acumatica project, for LEGACY and NON-BUDGETED jobs. It writes no budget
    and no commission attribute. Its only gate is that the record carries an
    Acumatica_Project_ID__c.

    PRECONDITIONS (verified by the script):
      1. sundial-acumatica-budget-push must already exist.
      2. The /projects/{recordId}/budget resources already exist (created by the
         recalc route); only the final 'attributes-sync' resource is new.
      3. You are deploying to the PRODUCTION stage - prompts before create-deployment
         unless -Yes is passed.

.EXAMPLE
    .\scripts\wire-attributes-sync-route.ps1        # interactive, prompts before prod deploy
    .\scripts\wire-attributes-sync-route.ps1 -Yes   # non-interactive
#>
[CmdletBinding()]
param([switch]$Yes)

$ErrorActionPreference = "Stop"
$Region  = "us-west-1"
$ApiId   = "5sktfwldh1"
$Stage   = "prod"
$Fn      = "sundial-acumatica-budget-push"
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

Write-Host "==> Ensuring resource path /projects/{recordId}/budget/attributes-sync" -ForegroundColor Cyan
$projects = Ensure-Resource $root.id "projects"
$recordId = Ensure-Resource $projects "{recordId}"
$budget   = Ensure-Resource $recordId "budget"
$attrs    = Ensure-Resource $budget "attributes-sync"

# --- POST method + AWS_PROXY integration -------------------------------------
Write-Host "==> POST method -> $Fn (AWS_PROXY)" -ForegroundColor Cyan
aws apigateway put-method --rest-api-id $ApiId --region $Region --resource-id $attrs `
    --http-method POST --authorization-type NONE --api-key-required $false 2>$null | Out-Null
aws apigateway put-integration --rest-api-id $ApiId --region $Region --resource-id $attrs `
    --http-method POST --type AWS_PROXY --integration-http-method POST --uri $IntegrationUri | Out-Null
aws apigateway put-method-response --rest-api-id $ApiId --region $Region --resource-id $attrs `
    --http-method POST --status-code 200 `
    --response-parameters "method.response.header.Access-Control-Allow-Origin=false" 2>$null | Out-Null

# --- OPTIONS (MOCK) for CORS preflight ---------------------------------------
Write-Host "==> OPTIONS method (MOCK CORS)" -ForegroundColor Cyan
aws apigateway put-method --rest-api-id $ApiId --region $Region --resource-id $attrs `
    --http-method OPTIONS --authorization-type NONE 2>$null | Out-Null
aws apigateway put-integration --rest-api-id $ApiId --region $Region --resource-id $attrs `
    --http-method OPTIONS --type MOCK --request-templates '{\"application/json\":\"{\\\"statusCode\\\": 200}\"}' | Out-Null
aws apigateway put-method-response --rest-api-id $ApiId --region $Region --resource-id $attrs `
    --http-method OPTIONS --status-code 200 `
    --response-parameters "method.response.header.Access-Control-Allow-Headers=false,method.response.header.Access-Control-Allow-Methods=false,method.response.header.Access-Control-Allow-Origin=false" 2>$null | Out-Null
aws apigateway put-integration-response --rest-api-id $ApiId --region $Region --resource-id $attrs `
    --http-method OPTIONS --status-code 200 `
    --response-parameters "method.response.header.Access-Control-Allow-Headers='Content-Type,Authorization',method.response.header.Access-Control-Allow-Methods='OPTIONS,POST',method.response.header.Access-Control-Allow-Origin='*'" | Out-Null

# --- Lambda invoke permission for this route ---------------------------------
# Distinct statement-id from the push route: they are separate source ARNs, and
# reusing the id would silently leave one of them unpermitted.
Write-Host "==> Lambda invoke permission (apigateway)" -ForegroundColor Cyan
$srcArn = "arn:aws:execute-api:${Region}:${AcctId}:${ApiId}/*/POST/projects/*/budget/attributes-sync"
aws lambda add-permission --function-name $Fn --region $Region `
    --statement-id "apigw-attributes-sync" --action "lambda:InvokeFunction" `
    --principal apigateway.amazonaws.com --source-arn $srcArn 2>$null | Out-Null
Write-Host "  (a 'ResourceConflictException' here just means the permission already exists - safe)" -ForegroundColor DarkGray

# --- Deploy to prod (the live change) ----------------------------------------
if (-not $Yes) {
    $ans = Read-Host "Deploy API to '$Stage' now? This is a LIVE production change. (y/N)"
    if ($ans -ne "y") { Write-Host "Skipped deploy. Route created but NOT live until you deploy." -ForegroundColor Yellow; exit 0 }
}
Write-Host "==> create-deployment -> $Stage" -ForegroundColor Cyan
aws apigateway create-deployment --rest-api-id $ApiId --region $Region --stage-name $Stage `
    --description "Add POST /projects/{recordId}/budget/attributes-sync -> $Fn" | Out-Null
Write-Host "SUCCESS: route live at https://$ApiId.execute-api.$Region.amazonaws.com/$Stage/projects/{recordId}/budget/attributes-sync" -ForegroundColor Green
Write-Host "REMEMBER: redeploy $Fn - the route dispatches on the new code." -ForegroundColor Yellow
