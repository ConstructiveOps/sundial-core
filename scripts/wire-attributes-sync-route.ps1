<#
.SYNOPSIS
    Wires POST /projects/{recordId}/budget/attributes-sync on the Sundial REST API
    (5sktfwldh1, us-west-1, stage prod) to the sundial-acumatica-budget-push Lambda,
    with a MOCK OPTIONS method for CORS and the Lambda invoke permission.

.DESCRIPTION
    Idempotent: every step tolerates the "already exists" outcome, so a partial run
    is repaired by re-running.

    SAME LAMBDA AS THE BUDGET PUSH, DIFFERENT ROUTE. The function dispatches on the
    resource path (isAttributesSyncRoute), because both routes carry {recordId} and
    are otherwise indistinguishable. The route must therefore live under the SAME
    /projects/{recordId}/budget parent - wired anywhere else it would fall through
    to the budget-push handler and be refused by gates that do not apply to it.

    Auth is enforced INSIDE the Lambda (resolveIdentity verifies the Supabase JWT),
    so the gateway method uses authorization-type NONE.

    ---------------------------------------------------------------------------
    THIS SCRIPT FAILED ONCE. Everything below is what that cost.
    ---------------------------------------------------------------------------
    The first version died at put-method having already created the resource,
    leaving a method-less resource behind and printing no usable error, because it
    hit three PowerShell 5.1 / AWS CLI traps at once:

    1. `--api-key-required $false` renders as the bare word "False". The CLI has no
       value-taking form of that option, so it errors with
       "Unknown options: --api-key-required, False" and put-method NEVER RUNS.
       Use the FLAG form: --no-api-key-required.

    2. `2>$null` on a native command wraps stderr in ErrorRecords, which under
       $ErrorActionPreference='Stop' becomes a terminating NativeCommandError -
       killing the script AND discarding the message that would explain why. Never
       redirect a native command's stderr here; capture it and check $LASTEXITCODE.

    3. Inline shorthand for --request-templates / --response-parameters. The CLI's
       map parser splits on commas regardless of quoting, and the CORS values
       legitimately contain commas ('Content-Type,Authorization'). Both go through
       no-BOM JSON files instead. (PS 5.1's Out-File -Encoding utf8 writes a BOM the
       CLI will not parse, hence WriteAllText with an explicit no-BOM encoder.)

    A fourth, non-obvious one: a method with NO integration anywhere on the API
    blocks EVERY create-deployment, not just its own route. This script therefore
    verifies the whole API is integration-complete before deploying.

    Also: keep this file pure ASCII. PowerShell 5.1 reads a BOM-less .ps1 as ANSI,
    so a UTF-8 em dash inside a string breaks the parse.

.EXAMPLE
    .\scripts\wire-attributes-sync-route.ps1        # prompts before the prod deploy
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

# --- no-BOM JSON payloads (trap 3) -------------------------------------------
$TmpDir = Join-Path $env:TEMP "sundial-wire-attributes-sync"
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

<#
    Run an aws call, SHOW its stderr if it fails, and check the exit code (trap 2).

    $Tolerate holds regexes for outcomes that mean "already done" - the whole point
    of an idempotent wiring script is that a re-run after a partial failure is safe.
#>
function Invoke-Aws {
    param(
        [Parameter(Mandatory)][string[]]$AwsArgs,
        [Parameter(Mandatory)][string]$What,
        [string[]]$Tolerate = @()
    )
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'   # or stderr becomes a terminating NativeCommandError
    $out = & aws @AwsArgs 2>&1 | Out-String
    $code = $LASTEXITCODE
    $ErrorActionPreference = $prev

    if ($code -ne 0) {
        foreach ($t in $Tolerate) {
            if ($out -match $t) { Write-Host "  $What - already present, skipped" -ForegroundColor DarkGray; return $null }
        }
        Write-Host "  $What FAILED (exit $code). AWS said:" -ForegroundColor Red
        # Strip PowerShell's ErrorRecord decoration so the actual CLI message stands out.
        foreach ($line in ($out -split "`r?`n")) {
            if ($line -match '^\s*(\+|At line:|\s*\+ CategoryInfo|\s*\+ FullyQualifiedErrorId|aws\.exe :)') { continue }
            if ($line.Trim()) { Write-Host "    $line" -ForegroundColor Red }
        }
        throw "$What failed. The route is NOT fully wired. Fix the cause and re-run - this script is idempotent."
    }
    Write-Host "  $What" -ForegroundColor DarkGray
    return $out
}

function Get-ChildResource($parentId, $pathPart) {
    $json = Invoke-Aws @('apigateway','get-resources','--rest-api-id',$ApiId,'--region',$Region,'--limit','500','--output','json') "read resources"
    foreach ($r in ($json | ConvertFrom-Json).items) {
        if ($r.parentId -eq $parentId -and $r.pathPart -eq $pathPart) { return $r.id }
    }
    return $null
}
function Ensure-Resource($parentId, $pathPart) {
    $existing = Get-ChildResource $parentId $pathPart
    if ($existing) { Write-Host "  resource '$pathPart' exists ($existing)" -ForegroundColor DarkGray; return $existing }
    $json = Invoke-Aws @('apigateway','create-resource','--rest-api-id',$ApiId,'--region',$Region,'--parent-id',$parentId,'--path-part',$pathPart,'--output','json') "create resource '$pathPart'"
    $id = ($json | ConvertFrom-Json).id
    Write-Host "  created resource '$pathPart' ($id)" -ForegroundColor Green
    return $id
}

# --- Precondition -------------------------------------------------------------
Write-Host "==> Verifying $Fn exists" -ForegroundColor Cyan
Invoke-Aws @('lambda','get-function-configuration','--function-name',$Fn,'--region',$Region,'--output','json') "get $Fn" | Out-Null

# --- Resource path ------------------------------------------------------------
Write-Host "==> Ensuring /projects/{recordId}/budget/attributes-sync" -ForegroundColor Cyan
$rootJson = Invoke-Aws @('apigateway','get-resources','--rest-api-id',$ApiId,'--region',$Region,'--limit','500','--output','json') "read resources"
$root = ($rootJson | ConvertFrom-Json).items | Where-Object { $_.path -eq "/" } | Select-Object -First 1
if (-not $root) { throw "Could not find the API root resource." }

$projects = Ensure-Resource $root.id "projects"
$recordId = Ensure-Resource $projects "{recordId}"
$budget   = Ensure-Resource $recordId "budget"
$attrs    = Ensure-Resource $budget "attributes-sync"

# --- POST: method, integration, method-response -------------------------------
# NOTE --no-api-key-required (trap 1). Do not "fix" this to --api-key-required $false.
Write-Host "==> POST -> $Fn (AWS_PROXY)" -ForegroundColor Cyan
Invoke-Aws @('apigateway','put-method','--rest-api-id',$ApiId,'--region',$Region,'--resource-id',$attrs,
    '--http-method','POST','--authorization-type','NONE','--no-api-key-required') "POST put-method" @('ConflictException','already exists') | Out-Null
Invoke-Aws @('apigateway','put-integration','--rest-api-id',$ApiId,'--region',$Region,'--resource-id',$attrs,
    '--http-method','POST','--type','AWS_PROXY','--integration-http-method','POST','--uri',$IntegrationUri) "POST put-integration" | Out-Null
Invoke-Aws @('apigateway','put-method-response','--rest-api-id',$ApiId,'--region',$Region,'--resource-id',$attrs,
    '--http-method','POST','--status-code','200',
    '--response-parameters','method.response.header.Access-Control-Allow-Origin=false') "POST put-method-response" @('ConflictException','already exists') | Out-Null

# --- OPTIONS: MOCK CORS preflight ---------------------------------------------
Write-Host "==> OPTIONS (MOCK CORS)" -ForegroundColor Cyan
Invoke-Aws @('apigateway','put-method','--rest-api-id',$ApiId,'--region',$Region,'--resource-id',$attrs,
    '--http-method','OPTIONS','--authorization-type','NONE','--no-api-key-required') "OPTIONS put-method" @('ConflictException','already exists') | Out-Null
Invoke-Aws @('apigateway','put-integration','--rest-api-id',$ApiId,'--region',$Region,'--resource-id',$attrs,
    '--http-method','OPTIONS','--type','MOCK','--request-templates',"file://$MockTemplateFile") "OPTIONS put-integration (MOCK)" | Out-Null
Invoke-Aws @('apigateway','put-method-response','--rest-api-id',$ApiId,'--region',$Region,'--resource-id',$attrs,
    '--http-method','OPTIONS','--status-code','200',
    '--response-parameters','method.response.header.Access-Control-Allow-Headers=false,method.response.header.Access-Control-Allow-Methods=false,method.response.header.Access-Control-Allow-Origin=false') "OPTIONS put-method-response" @('ConflictException','already exists') | Out-Null
Invoke-Aws @('apigateway','put-integration-response','--rest-api-id',$ApiId,'--region',$Region,'--resource-id',$attrs,
    '--http-method','OPTIONS','--status-code','200','--response-parameters',"file://$CorsParamsFile") "OPTIONS put-integration-response" | Out-Null

# --- Lambda invoke permission -------------------------------------------------
# Distinct statement-id from the push route: different source ARNs, and reusing the
# id would silently leave one of them unpermitted.
Write-Host "==> Lambda invoke permission" -ForegroundColor Cyan
$srcArn = "arn:aws:execute-api:${Region}:${AcctId}:${ApiId}/*/POST/projects/*/budget/attributes-sync"
Invoke-Aws @('lambda','add-permission','--function-name',$Fn,'--region',$Region,
    '--statement-id','apigw-attributes-sync','--action','lambda:InvokeFunction',
    '--principal','apigateway.amazonaws.com','--source-arn',$srcArn) "add-permission" @('ResourceConflictException') | Out-Null

# --- PRE-DEPLOY GATE ----------------------------------------------------------
# A method with no integration ANYWHERE on this API blocks EVERY create-deployment,
# not just its own route. That has bitten this API before, and the symptom (a prod
# deploy failing for a route nobody touched) points nowhere useful. Check first.
Write-Host "==> Verifying every method on the API has an integration" -ForegroundColor Cyan
$all = Invoke-Aws @('apigateway','get-resources','--rest-api-id',$ApiId,'--region',$Region,'--limit','500','--embed','methods','--output','json') "read resources + methods"
$orphans = @()
$methodCount = 0
foreach ($r in ($all | ConvertFrom-Json).items) {
    if (-not $r.resourceMethods) { continue }
    foreach ($m in $r.resourceMethods.PSObject.Properties) {
        $methodCount++
        if (-not $m.Value.methodIntegration) { $orphans += "$($m.Name) $($r.path)" }
    }
}
Write-Host "  $methodCount methods, $($orphans.Count) without an integration"
if ($orphans.Count -gt 0) {
    foreach ($o in $orphans) { Write-Host "    ** $o" -ForegroundColor Red }
    throw "Refusing to deploy: $($orphans.Count) method(s) have no integration. Every create-deployment on this API will fail until they are fixed or removed."
}

# --- Deploy -------------------------------------------------------------------
if (-not $Yes) {
    $ans = Read-Host "Deploy API to '$Stage' now? This is a LIVE production change. (y/N)"
    if ($ans -ne "y") { Write-Host "Skipped. Route wired but NOT live until you deploy." -ForegroundColor Yellow; exit 0 }
}
Write-Host "==> create-deployment -> $Stage" -ForegroundColor Cyan
Invoke-Aws @('apigateway','create-deployment','--rest-api-id',$ApiId,'--region',$Region,'--stage-name',$Stage,
    '--description',"Add POST /projects/{recordId}/budget/attributes-sync -> $Fn") "create-deployment" | Out-Null

$base = "https://$ApiId.execute-api.$Region.amazonaws.com/$Stage"
Write-Host "SUCCESS: $base/projects/{recordId}/budget/attributes-sync" -ForegroundColor Green
Write-Host ""
Write-Host "REMEMBER: redeploy $Fn - the route dispatches on the new code." -ForegroundColor Yellow
Write-Host "Smoke test (expect a JSON 401, NOT 403 Missing Authentication Token):" -ForegroundColor Yellow
Write-Host "  curl -s -X POST '$base/projects/a0X000000000001AAA/budget/attributes-sync' -H 'Authorization: Bearer bad' -d '{}'"
Write-Host "  Deployments can take a few seconds to propagate; a 403 immediately after deploying is worth one retry." -ForegroundColor DarkGray
