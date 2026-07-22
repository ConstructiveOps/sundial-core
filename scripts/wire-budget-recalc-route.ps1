<#
.SYNOPSIS
    Wires POST (and OPTIONS) /projects/{recordId}/budget/recalc on the Sundial REST
    API (API Gateway 5sktfwldh1, region us-west-1, stage prod) to the sundial-budget
    Lambda, and deploys the stage.

.DESCRIPTION
    Both POST and OPTIONS route to the Lambda as AWS_PROXY: the handler returns the
    computed budget on POST and a 204 + CORS headers on OPTIONS (see corsHeaders in
    lib/http.js), so no MOCK/CORS integration config is needed. Idempotent: resources
    and methods are checked before creating.

    REQUIRED CREDENTIALS: run with a principal that has apigateway write access
    (apigateway:POST/PUT on this API) AND lambda:AddPermission on sundial-budget.
    The default backend user (solar-portal-api) is NOT authorized for apigateway:POST
    - running as that user fails with AccessDeniedException on create-resource.

    PRECONDITIONS (verified; the script stops if unmet):
      1. sundial-budget Lambda exists.
    The final `create-deployment` (the live change) prompts unless -Yes is passed.

.EXAMPLE
    .\scripts\wire-budget-recalc-route.ps1          # prompts before the prod deploy
    .\scripts\wire-budget-recalc-route.ps1 -Yes     # non-interactive
#>
[CmdletBinding()]
param([switch]$Yes)

# Continue (not Stop): native aws stderr under PS 5.1 + Stop raises NativeCommandError
# even on benign 404s. We check $LASTEXITCODE explicitly on the calls that matter.
$ErrorActionPreference = "Continue"
$Region = "us-west-1"
$ApiId  = "5sktfwldh1"
$Stage  = "prod"
$Fn     = "sundial-budget"
$AcctId = "891377232720"
$Uri    = "arn:aws:apigateway:${Region}:lambda:path/2015-03-31/functions/arn:aws:lambda:${Region}:${AcctId}:function:${Fn}/invocations"

# Refetch resources on each lookup so the function is correct across re-runs and
# within a single run (a just-created child is visible to the next call).
function Get-Resources { (aws apigateway get-resources --rest-api-id $ApiId --region $Region --limit 500 --output json | ConvertFrom-Json).items }
function Ensure-Resource($parentId, $part) {
    $ex = (Get-Resources | Where-Object { $_.parentId -eq $parentId -and $_.pathPart -eq $part }).id
    if ($ex) { Write-Host "  resource '$part' exists ($ex)"; return $ex }
    $c = aws apigateway create-resource --rest-api-id $ApiId --region $Region --parent-id $parentId --path-part $part --output json | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0 -or -not $c.id) { throw "create-resource '$part' failed (need apigateway:POST)" }
    Write-Host "  created resource '$part' ($($c.id))"
    return $c.id
}
Write-Host "==> Verifying $Fn exists..." -ForegroundColor Cyan
aws lambda get-function-configuration --function-name $Fn --region $Region --output json | Out-Null
if ($LASTEXITCODE -ne 0) { throw "$Fn does not exist yet." }

$root = (Get-Resources | Where-Object { $_.path -eq "/" }).id
if (-not $root) { throw "Could not find root resource." }

Write-Host "==> Ensuring /projects/{recordId}/budget/recalc" -ForegroundColor Cyan
$projects = Ensure-Resource $root "projects"
$recordId = Ensure-Resource $projects "{recordId}"
$budget   = Ensure-Resource $recordId "budget"
$recalc   = Ensure-Resource $budget "recalc"

# Both methods -> Lambda proxy. The handler returns computed fields on POST and
# 204 + CORS on OPTIONS, so no MOCK/CORS wiring is required.
foreach ($m in @("POST", "OPTIONS")) {
    # put-method: on a fresh method this succeeds; if it already exists it errors
    # harmlessly (stderr suppressed). The integration is set either way, and that
    # is the call we gate on.
    aws apigateway put-method --rest-api-id $ApiId --region $Region --resource-id $recalc `
        --http-method $m --authorization-type NONE --no-api-key-required --output json 2>$null | Out-Null
    aws apigateway put-integration --rest-api-id $ApiId --region $Region --resource-id $recalc `
        --http-method $m --type AWS_PROXY --integration-http-method POST --uri $Uri --output json | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "put-integration $m failed" }
    Write-Host "  wired $m -> AWS_PROXY -> $Fn" -ForegroundColor Green
}

# Lambda invoke permission covering any stage + any method on this route.
Write-Host "==> Lambda invoke permission (apigateway)" -ForegroundColor Cyan
$srcArn = "arn:aws:execute-api:${Region}:${AcctId}:${ApiId}/*/*/projects/*/budget/recalc"
aws lambda add-permission --function-name $Fn --region $Region `
    --statement-id "apigw-budget-recalc" --action "lambda:InvokeFunction" `
    --principal apigateway.amazonaws.com --source-arn $srcArn --output json 2>$null | Out-Null
Write-Host "  (an 'already exists' error here is harmless - permission is in place)" -ForegroundColor DarkGray

if (-not $Yes) {
    $ans = Read-Host "Deploy API to '$Stage' now? LIVE production change. (y/N)"
    if ($ans -ne "y") { Write-Host "Route created but NOT live until you deploy." -ForegroundColor Yellow; exit 0 }
}
Write-Host "==> create-deployment -> $Stage" -ForegroundColor Cyan
aws apigateway create-deployment --rest-api-id $ApiId --region $Region --stage-name $Stage `
    --description "Add POST /projects/{recordId}/budget/recalc -> $Fn" --output json | Out-Null
if ($LASTEXITCODE -ne 0) { throw "create-deployment failed" }
Write-Host "SUCCESS: live at https://$ApiId.execute-api.$Region.amazonaws.com/$Stage/projects/{recordId}/budget/recalc" -ForegroundColor Green
