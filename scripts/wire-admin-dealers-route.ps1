<#
.SYNOPSIS
    Wires GET /admin/dealers on the Sundial REST API (API Gateway 5sktfwldh1,
    region us-west-1, stage prod) to the sundial-user-admin Lambda, plus OPTIONS
    for CORS. Same shape as scripts/wire-user-admin-routes.ps1: AWS_PROXY,
    authorization-type NONE at the gateway (auth + the CORS 204 live IN the Lambda,
    which gates every route on requireSuperAdmin).

.DESCRIPTION
    Idempotent: the /admin/dealers resource and its methods are checked before they
    are created, so re-running is safe. Same PS 5.1-safe conventions as the other
    wire-* scripts (ASCII only; ErrorActionPreference Continue with explicit
    $LASTEXITCODE checks, because native aws stderr under Stop raises
    NativeCommandError on benign 404s).

    THIS SCRIPT DEPLOYS THE STAGE ITSELF. The final create-deployment is the live
    change and prompts unless -Yes. There is no "Actions -> Deploy API" step to do
    afterwards in the console.

    THE INVOKE PERMISSION IS ALREADY IN PLACE. wire-user-admin-routes.ps1 granted
    apigateway invoke on arn:...:${ApiId}/*/*/admin/* -- a wildcard that already
    covers /admin/dealers. The add-permission below is re-issued anyway for the case
    where this route is wired into a fresh API before the users routes; an
    "already exists" error from it is expected and harmless.

    WHY THIS ROUTE IS OPTIONAL, AND WHAT DEPENDS ON IT. GET /admin/users already
    returns a `dealers` array from the same listActiveDealers() function, so the
    create/edit user modal works WITHOUT this route. That piggyback exists because
    dealer onboarding was blocked and a new gateway route is a manual step. This
    route is the clean API surface; the piggyback is the one that unblocked the
    night. Both call the same function and cannot disagree.

    REQUIRED CREDENTIALS: apigateway write (apigateway:POST/PUT on this API) and,
    for the permission call, lambda:AddPermission on sundial-user-admin.

.EXAMPLE
    .\scripts\wire-admin-dealers-route.ps1          # prompts before the prod deploy
    .\scripts\wire-admin-dealers-route.ps1 -Yes     # non-interactive
#>
[CmdletBinding()]
param([switch]$Yes)

# Continue (not Stop): native aws stderr under PS 5.1 + Stop raises NativeCommandError
# even on benign 404s. $LASTEXITCODE is checked explicitly on the calls that matter.
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
if ($LASTEXITCODE -ne 0) { throw "$Fn does not exist yet. Deploy it, then re-run." }

$root = (Get-Resources | Where-Object { $_.path -eq "/" }).id
if (-not $root) { throw "Could not find root resource." }

Write-Host "==> Ensuring /admin/dealers" -ForegroundColor Cyan
# /admin already exists (wire-user-admin-routes.ps1 created it). Ensure-Resource is
# idempotent, so this reuses it rather than failing.
$admin   = Ensure-Resource $root "admin"
$dealers = Ensure-Resource $admin "dealers"

Write-Host "==> /admin/dealers : GET, OPTIONS" -ForegroundColor Cyan
foreach ($m in @("GET", "OPTIONS")) { Wire-Method $dealers $m }

# The /admin/* wildcard from wire-user-admin-routes.ps1 already covers this path.
# Re-issued for the fresh-API case; "already exists" here is expected.
Write-Host "==> Lambda invoke permission (apigateway)" -ForegroundColor Cyan
$srcArn = "arn:aws:execute-api:${Region}:${AcctId}:${ApiId}/*/*/admin/*"
aws lambda add-permission --function-name $Fn --region $Region `
    --statement-id "apigw-user-admin" --action "lambda:InvokeFunction" `
    --principal apigateway.amazonaws.com --source-arn $srcArn --output json 2>$null | Out-Null
Write-Host "  (an 'already exists' error here is harmless - permission is in place)" -ForegroundColor DarkGray

if (-not $Yes) {
    $ans = Read-Host "Deploy API to '$Stage' now? LIVE production change. (y/N)"
    if ($ans -ne "y") { Write-Host "Route created but NOT live until you deploy." -ForegroundColor Yellow; exit 0 }
}
Write-Host "==> create-deployment -> $Stage" -ForegroundColor Cyan
aws apigateway create-deployment --rest-api-id $ApiId --region $Region --stage-name $Stage `
    --description "Add GET /admin/dealers -> $Fn" --output json | Out-Null
if ($LASTEXITCODE -ne 0) { throw "create-deployment failed" }
Write-Host "SUCCESS: live at https://$ApiId.execute-api.$Region.amazonaws.com/$Stage/admin/dealers" -ForegroundColor Green
Write-Host "  Verify:  curl -H 'Authorization: Bearer <super-admin-jwt>' https://$ApiId.execute-api.$Region.amazonaws.com/$Stage/admin/dealers" -ForegroundColor DarkGray
