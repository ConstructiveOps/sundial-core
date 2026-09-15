<#
.SYNOPSIS
    Wires the customer-texting routes on the Sundial REST API (API Gateway 5sktfwldh1,
    us-west-1, stage prod) to the sundial-sms Lambda (D-072 amendment 6):
      GET/POST /service/jobs/{id}/sms      the job's text thread / send a text (JWT)
      GET      /service/sms/unmatched      inbound texts nobody could be matched to (JWT)
      POST     /sms/inbound                Twilio webhook: a customer texted us (signed)
      POST     /sms/status                 Twilio webhook: delivery status (signed)
    plus OPTIONS for CORS on the JWT routes. AWS_PROXY, authorization NONE at the
    gateway — auth lives IN the Lambda: a Supabase JWT on the /service routes, Twilio's
    request signature on the two /sms webhooks (constant-time, fails closed).

.DESCRIPTION
    Idempotent (same conventions as wire-service-estimate-routes.ps1). PRECONDITIONS:
      1. The sundial-sms Lambda exists (create it in the console like sundial-service-board:
         same runtime / role / arch / timeout) and has been deployed: .\deploy.ps1 sundial-sms
      2. Secrets Manager `sundial/twilio` holds
           { "accountSid": "AC…", "authToken": "…", "fromNumber": "+1…",
             "tenantNumbers": { "harmon": "+1…" }, "defaultTenant": "harmon" }
         (tenantNumbers is optional until Harmon's own number is approved; defaultTenant
         routes texts to the shared number to Harmon meanwhile.)
      3. Lambda env SMS_WEBHOOK_BASE = https://5sktfwldh1.execute-api.us-west-1.amazonaws.com/prod
         — the signature is computed over the EXACT URL Twilio calls, so this must match
         what you paste into the Twilio console, character for character.
    AFTER deploying: in the Twilio console, set the number's Messaging webhook to
      POST <SMS_WEBHOOK_BASE>/sms/inbound
    (the status callback URL is sent per message by the Lambda; nothing to configure).

.EXAMPLE
    .\scripts\wire-sms-routes.ps1
    .\scripts\wire-sms-routes.ps1 -Yes
#>
[CmdletBinding()]
param([switch]$Yes)

$ErrorActionPreference = "Continue"
$Region = "us-west-1"
$ApiId  = "5sktfwldh1"
$Stage  = "prod"
$Fn     = "sundial-sms"
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

Write-Host "==> /service/jobs/{id}/sms : GET, POST, OPTIONS" -ForegroundColor Cyan
$service = Ensure-Resource $root "service"
$jobs    = Ensure-Resource $service "jobs"
$jobId   = Ensure-Resource $jobs "{id}"
$jobSms  = Ensure-Resource $jobId "sms"
foreach ($m in @("GET", "POST", "OPTIONS")) { Wire-Method $jobSms $m }

Write-Host "==> /service/sms/unmatched : GET, OPTIONS" -ForegroundColor Cyan
$svcSms    = Ensure-Resource $service "sms"
$unmatched = Ensure-Resource $svcSms "unmatched"
foreach ($m in @("GET", "OPTIONS")) { Wire-Method $unmatched $m }

Write-Host "==> /sms/inbound and /sms/status : POST (Twilio)" -ForegroundColor Cyan
$sms     = Ensure-Resource $root "sms"
$inbound = Ensure-Resource $sms "inbound"
$status  = Ensure-Resource $sms "status"
Wire-Method $inbound "POST"
Wire-Method $status "POST"

Write-Host "==> Lambda invoke permissions (apigateway)" -ForegroundColor Cyan
foreach ($pair in @(@("apigw-sms-service", "arn:aws:execute-api:${Region}:${AcctId}:${ApiId}/*/*/service/*"),
                    @("apigw-sms-webhooks", "arn:aws:execute-api:${Region}:${AcctId}:${ApiId}/*/*/sms/*"))) {
    aws lambda add-permission --function-name $Fn --region $Region `
        --statement-id $pair[0] --action "lambda:InvokeFunction" `
        --principal apigateway.amazonaws.com --source-arn $pair[1] --output json 2>$null | Out-Null
}
Write-Host "  (an 'already exists' error here is harmless - permission is in place)" -ForegroundColor DarkGray

if (-not $Yes) {
    $ans = Read-Host "Deploy API to '$Stage' now? LIVE production change. (y/N)"
    if ($ans -ne "y") { Write-Host "Routes created but NOT live until you deploy." -ForegroundColor Yellow; exit 0 }
}
Write-Host "==> create-deployment -> $Stage" -ForegroundColor Cyan
aws apigateway create-deployment --rest-api-id $ApiId --region $Region --stage-name $Stage `
    --description "Add customer texting routes -> $Fn" --output json | Out-Null
if ($LASTEXITCODE -ne 0) { throw "create-deployment failed" }
Write-Host "SUCCESS. Twilio inbound webhook URL: https://$ApiId.execute-api.$Region.amazonaws.com/$Stage/sms/inbound" -ForegroundColor Green
