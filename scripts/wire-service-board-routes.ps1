<#
.SYNOPSIS
    Wires the dispatch board routes on the Sundial REST API (API Gateway 5sktfwldh1,
    us-west-1, stage prod) to the sundial-service-board Lambda (D-072, dispatch board):
      GET   /service/board                     techs + calls in a window + the unscheduled tray
      GET   /service/jobs/{id}/calls           a job's calls
      POST  /service/jobs/{id}/calls           schedule a tech onto a job
      PATCH /service/calls/{id}                move / reassign / status / notes
      POST  /service/calls/{id}/cancel         cancel with a reason
      GET   /service/calls/{id}/clock          the call's clock log, numbered, for the office (2026-09-17)
      POST  /service/calls/{id}/clock          the office's time correction (+ optional complete)
    plus OPTIONS everywhere for CORS. AWS_PROXY, authorization NONE at the gateway
    (auth + CORS 204 live IN the Lambda), same as every other Sundial route.

    /service and /service/jobs/{id} already exist (created by wire-service-estimate-
    routes.ps1 for the estimate Lambda); this script only ADDS the child resources it
    needs under them and never touches the estimate Lambda's methods.

.DESCRIPTION
    Idempotent: resources/methods are checked/created before use. PS 5.1-safe.

    PRECONDITION: the sundial-service-board Lambda must already exist (create it in the
    console with the same runtime/role/arch/timeout as sundial-sf-update; env vars
    SERVICE_BRAND_NAME, SERVICE_TIMEZONE (default America/Phoenix), EMAIL_FROM,
    EMAIL_REPLY_TO, SES_REGION, EMAIL_CONFIG_SET), then .\deploy.ps1 sundial-service-board.
    The final create-deployment prompts unless -Yes.

.EXAMPLE
    .\scripts\wire-service-board-routes.ps1
    .\scripts\wire-service-board-routes.ps1 -Yes
#>
[CmdletBinding()]
param([switch]$Yes)

$ErrorActionPreference = "Continue"
$Region = "us-west-1"
$ApiId  = "5sktfwldh1"
$Stage  = "prod"
$Fn     = "sundial-service-board"
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
    aws apigateway put-method --rest-api-id $ApiId --region $Region --resource-id $resourceId `
        --http-method $method --authorization-type NONE --no-api-key-required --output json 2>$null | Out-Null
    aws apigateway put-integration --rest-api-id $ApiId --region $Region --resource-id $resourceId `
        --http-method $method --type AWS_PROXY --integration-http-method POST --uri $Uri --output json | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "put-integration $method failed on $resourceId" }
    Write-Host "  wired $method -> AWS_PROXY -> $Fn" -ForegroundColor Green
}

Write-Host "==> Verifying $Fn exists..." -ForegroundColor Cyan
aws lambda get-function-configuration --function-name $Fn --region $Region --output json | Out-Null
if ($LASTEXITCODE -ne 0) { throw "$Fn does not exist yet. Create it in the Lambda console, deploy it, then re-run." }

$root = (Get-Resources | Where-Object { $_.path -eq "/" }).id
if (-not $root) { throw "Could not find root resource." }

Write-Host "==> Resource tree" -ForegroundColor Cyan
$service = Ensure-Resource $root "service"
$board   = Ensure-Resource $service "board"
$jobs    = Ensure-Resource $service "jobs"
$jobId   = Ensure-Resource $jobs "{id}"
$jobCalls = Ensure-Resource $jobId "calls"
$calls   = Ensure-Resource $service "calls"
$callId  = Ensure-Resource $calls "{id}"
$cancel  = Ensure-Resource $callId "cancel"
$clock   = Ensure-Resource $callId "clock"

Write-Host "==> /service/board : GET, OPTIONS" -ForegroundColor Cyan
foreach ($m in @("GET", "OPTIONS")) { Wire-Method $board $m }
Write-Host "==> /service/jobs/{id}/calls : GET, POST, OPTIONS" -ForegroundColor Cyan
foreach ($m in @("GET", "POST", "OPTIONS")) { Wire-Method $jobCalls $m }
Write-Host "==> /service/calls/{id} : PATCH, OPTIONS" -ForegroundColor Cyan
foreach ($m in @("PATCH", "OPTIONS")) { Wire-Method $callId $m }
Write-Host "==> /service/calls/{id}/cancel : POST, OPTIONS" -ForegroundColor Cyan
foreach ($m in @("POST", "OPTIONS")) { Wire-Method $cancel $m }
Write-Host "==> /service/calls/{id}/clock : GET, POST, OPTIONS" -ForegroundColor Cyan
foreach ($m in @("GET", "POST", "OPTIONS")) { Wire-Method $clock $m }

Write-Host "==> Lambda invoke permission (apigateway)" -ForegroundColor Cyan
$srcArn = "arn:aws:execute-api:${Region}:${AcctId}:${ApiId}/*/*/service/*"
aws lambda add-permission --function-name $Fn --region $Region `
    --statement-id "apigw-service-board" --action "lambda:InvokeFunction" `
    --principal apigateway.amazonaws.com --source-arn $srcArn --output json 2>$null | Out-Null
Write-Host "  (an 'already exists' error here is harmless - permission is in place)" -ForegroundColor DarkGray

if (-not $Yes) {
    $ans = Read-Host "Deploy API to '$Stage' now? LIVE production change. (y/N)"
    if ($ans -ne "y") { Write-Host "Routes created but NOT live until you deploy." -ForegroundColor Yellow; exit 0 }
}
Write-Host "==> create-deployment -> $Stage" -ForegroundColor Cyan
aws apigateway create-deployment --rest-api-id $ApiId --region $Region --stage-name $Stage `
    --description "Add dispatch board routes -> $Fn" --output json | Out-Null
if ($LASTEXITCODE -ne 0) { throw "create-deployment failed" }
Write-Host "SUCCESS: live at https://$ApiId.execute-api.$Region.amazonaws.com/$Stage/service/board" -ForegroundColor Green
