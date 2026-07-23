<#
.SYNOPSIS
    Wires the user-admin routes on the Sundial REST API (API Gateway 5sktfwldh1,
    region us-west-1, stage prod) to the sundial-user-admin Lambda:
      GET  /admin/users
      POST /admin/users
      PATCH /admin/users/{id}
    plus OPTIONS on both resources for CORS. Every method routes to the Lambda as
    AWS_PROXY (auth + CORS 204 live IN the Lambda; authorization-type NONE at the
    gateway, exactly like the budget-recalc route).

.DESCRIPTION
    Idempotent: resources/methods are checked/created before use. Same PS 5.1-safe
    conventions as scripts/wire-budget-recalc-route.ps1 (ASCII only;
    ErrorActionPreference Continue with explicit $LASTEXITCODE checks, since native
    aws stderr under Stop raises NativeCommandError on benign 404s).

    REQUIRED CREDENTIALS: apigateway write (apigateway:POST/PUT on this API) AND
    lambda:AddPermission on sundial-user-admin.

    PRECONDITION: the sundial-user-admin Lambda must already exist (add-permission
    needs it). The final create-deployment (the live change) prompts unless -Yes.

.EXAMPLE
    .\scripts\wire-user-admin-routes.ps1          # prompts before the prod deploy
    .\scripts\wire-user-admin-routes.ps1 -Yes     # non-interactive
#>
[CmdletBinding()]
param([switch]$Yes)

# Continue (not Stop): native aws stderr under PS 5.1 + Stop raises NativeCommandError
# even on benign 404s. We check $LASTEXITCODE explicitly on the calls that matter.
$ErrorActionPreference = "Continue"
$Region = "us-west-1"
$ApiId  = "5sktfwldh1"
$Stage  = "prod"
$Fn     = "sundial-user-admin"
$AcctId = "891377232720"
$Uri    = "arn:aws:apigateway:${Region}:lambda:path/2015-03-31/functions/arn:aws:lambda:${Region}:${AcctId}:function:${Fn}/invocations"

function Get-Resources { (aws apigateway get-resources --rest-api-id $ApiId --region $Region --limit 500 --output json | ConvertFrom-Json).items }
function Ensure-Resource($parentId, $part) {
    $ex = (Get-Resources | Where-Object { $_.parentId -eq $parentId -and $_.pathPart -eq $part }).id
    if ($ex) { Write-Host "  resource '$part' exists ($ex)"; return $ex }
    $c = aws apigateway create-resource --rest-api-id $ApiId --region $Region --parent-id $parentId --path-part $part --output json | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0 -or -not $c.id) { throw "create-resource '$part' failed (need apigateway:POST)" }
    Write-Host "  created resource '$part' ($($c.id))"
    return $c.id
}
function Wire-Method($resourceId, $method) {
    # put-method: fresh succeeds; existing errors harmlessly (stderr suppressed).
    # The integration is set either way, and that is the call we gate on.
    aws apigateway put-method --rest-api-id $ApiId --region $Region --resource-id $resourceId `
        --http-method $method --authorization-type NONE --no-api-key-required --output json 2>$null | Out-Null
    aws apigateway put-integration --rest-api-id $ApiId --region $Region --resource-id $resourceId `
        --http-method $method --type AWS_PROXY --integration-http-method POST --uri $Uri --output json | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "put-integration $method failed on $resourceId" }
    Write-Host "  wired $method -> AWS_PROXY -> $Fn" -ForegroundColor Green
}

Write-Host "==> Verifying $Fn exists..." -ForegroundColor Cyan
aws lambda get-function-configuration --function-name $Fn --region $Region --output json | Out-Null
if ($LASTEXITCODE -ne 0) { throw "$Fn does not exist yet. Create it, then re-run." }

$root = (Get-Resources | Where-Object { $_.path -eq "/" }).id
if (-not $root) { throw "Could not find root resource." }

Write-Host "==> Ensuring /admin/users and /admin/users/{id}" -ForegroundColor Cyan
$admin   = Ensure-Resource $root "admin"
$users   = Ensure-Resource $admin "users"
$userId  = Ensure-Resource $users "{id}"

Write-Host "==> /admin/users : GET, POST, OPTIONS" -ForegroundColor Cyan
foreach ($m in @("GET", "POST", "OPTIONS")) { Wire-Method $users $m }

Write-Host "==> /admin/users/{id} : PATCH, OPTIONS" -ForegroundColor Cyan
foreach ($m in @("PATCH", "OPTIONS")) { Wire-Method $userId $m }

# One invoke permission covering any stage + any method under /admin/*.
Write-Host "==> Lambda invoke permission (apigateway)" -ForegroundColor Cyan
$srcArn = "arn:aws:execute-api:${Region}:${AcctId}:${ApiId}/*/*/admin/*"
aws lambda add-permission --function-name $Fn --region $Region `
    --statement-id "apigw-user-admin" --action "lambda:InvokeFunction" `
    --principal apigateway.amazonaws.com --source-arn $srcArn --output json 2>$null | Out-Null
Write-Host "  (an 'already exists' error here is harmless - permission is in place)" -ForegroundColor DarkGray

if (-not $Yes) {
    $ans = Read-Host "Deploy API to '$Stage' now? LIVE production change. (y/N)"
    if ($ans -ne "y") { Write-Host "Routes created but NOT live until you deploy." -ForegroundColor Yellow; exit 0 }
}
Write-Host "==> create-deployment -> $Stage" -ForegroundColor Cyan
aws apigateway create-deployment --rest-api-id $ApiId --region $Region --stage-name $Stage `
    --description "Add user-admin routes -> $Fn" --output json | Out-Null
if ($LASTEXITCODE -ne 0) { throw "create-deployment failed" }
Write-Host "SUCCESS: live at https://$ApiId.execute-api.$Region.amazonaws.com/$Stage/admin/users" -ForegroundColor Green
