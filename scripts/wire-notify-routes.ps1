<#
.SYNOPSIS
    Wires the notification routes on the Sundial REST API (API Gateway 5sktfwldh1,
    us-west-1, stage prod) to the sundial-notify Lambda (D-074), and creates the
    EventBridge schedule that runs its reminder sweep every 5 minutes:
      GET    /notify/config          the VAPID public key the browser subscribes with
      POST   /notify/subscriptions   turn push on for this browser / phone
      DELETE /notify/subscriptions   turn it off
      POST   /notify/test            ring yourself (bell + push)
    plus OPTIONS for CORS. AWS_PROXY, authorization NONE at the gateway — the Supabase JWT
    is checked IN the Lambda (action notify.self: every signed-in scope but none).

.DESCRIPTION
    Idempotent (same conventions as wire-sms-routes.ps1). PRECONDITIONS:
      1. The sundial-notify Lambda exists (create it in the console like sundial-sms:
         Node 22.x, handler index.handler, role sundial-lambda-execution-role, 30 s
         timeout) and has been deployed: .\deploy.ps1 sundial-notify
      2. Secrets Manager `sundial/push` holds the VAPID pair:
           { "publicKey": "B…", "privateKey": "…", "subject": "mailto:support@…" }
         (generate with: node -e "console.log(JSON.stringify(require('web-push').generateVAPIDKeys()))"
          from the sundial-core folder — the private key goes in the secret and nowhere else)
      3. sql/sundial_notifications.sql has been run in the Supabase SQL editor.
    Optional Lambda env on sundial-notify: SERVICE_TIMEZONE (default America/Phoenix),
    REMINDER_HOUR (local hour of the day-before digest, default 17).

    The EventBridge rule `sundial-notify-sweep` (rate(5 minutes)) needs events:PutRule,
    events:PutTargets and lambda:AddPermission — the same admin credentials this script
    already uses for API Gateway.

.EXAMPLE
    .\scripts\wire-notify-routes.ps1
    .\scripts\wire-notify-routes.ps1 -Yes
#>
[CmdletBinding()]
param([switch]$Yes)

$ErrorActionPreference = "Continue"
$Region = "us-west-1"
$ApiId  = "5sktfwldh1"
$Stage  = "prod"
$Fn     = "sundial-notify"
$AcctId = "891377232720"
$Uri    = "arn:aws:apigateway:${Region}:lambda:path/2015-03-31/functions/arn:aws:lambda:${Region}:${AcctId}:function:${Fn}/invocations"
$RuleName = "sundial-notify-sweep"

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
$fnCfg = aws lambda get-function-configuration --function-name $Fn --region $Region --output json | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or -not $fnCfg.FunctionArn) { throw "$Fn does not exist yet. Create it in the Lambda console, deploy it, then re-run." }

$root = (Get-Resources | Where-Object { $_.path -eq "/" }).id
if (-not $root) { throw "Could not find root resource." }

Write-Host "==> /notify/config : GET, OPTIONS" -ForegroundColor Cyan
$notify = Ensure-Resource $root "notify"
$config = Ensure-Resource $notify "config"
foreach ($m in @("GET", "OPTIONS")) { Wire-Method $config $m }

Write-Host "==> /notify/subscriptions : POST, DELETE, OPTIONS" -ForegroundColor Cyan
$subs = Ensure-Resource $notify "subscriptions"
foreach ($m in @("POST", "DELETE", "OPTIONS")) { Wire-Method $subs $m }

Write-Host "==> /notify/test : POST, OPTIONS" -ForegroundColor Cyan
$test = Ensure-Resource $notify "test"
foreach ($m in @("POST", "OPTIONS")) { Wire-Method $test $m }

Write-Host "==> Lambda invoke permission (apigateway)" -ForegroundColor Cyan
aws lambda add-permission --function-name $Fn --region $Region `
    --statement-id "apigw-notify" --action "lambda:InvokeFunction" `
    --principal apigateway.amazonaws.com --source-arn "arn:aws:execute-api:${Region}:${AcctId}:${ApiId}/*/*/notify/*" --output json 2>$null | Out-Null
Write-Host "  (an 'already exists' error here is harmless - permission is in place)" -ForegroundColor DarkGray

Write-Host "==> EventBridge schedule '$RuleName' (rate(5 minutes)) -> $Fn" -ForegroundColor Cyan
$rule = aws events put-rule --name $RuleName --region $Region --schedule-expression "rate(5 minutes)" `
    --description "Sundial notifications sweep: one-hour + day-before reminders to techs, late calls to the office (D-074)" --output json | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or -not $rule.RuleArn) { throw "events put-rule failed (need events:PutRule)" }
aws events put-targets --rule $RuleName --region $Region --targets "Id=$Fn,Arn=$($fnCfg.FunctionArn)" --output json | Out-Null
if ($LASTEXITCODE -ne 0) { throw "events put-targets failed (need events:PutTargets)" }
aws lambda add-permission --function-name $Fn --region $Region `
    --statement-id "events-notify-sweep" --action "lambda:InvokeFunction" `
    --principal events.amazonaws.com --source-arn $rule.RuleArn --output json 2>$null | Out-Null
Write-Host "  schedule in place: $($rule.RuleArn)" -ForegroundColor Green

if (-not $Yes) {
    $ans = Read-Host "Deploy API to '$Stage' now? LIVE production change. (y/N)"
    if ($ans -ne "y") { Write-Host "Routes created but NOT live until you deploy." -ForegroundColor Yellow; exit 0 }
}
Write-Host "==> create-deployment -> $Stage" -ForegroundColor Cyan
aws apigateway create-deployment --rest-api-id $ApiId --region $Region --stage-name $Stage `
    --description "Add notification routes -> $Fn" --output json | Out-Null
if ($LASTEXITCODE -ne 0) { throw "create-deployment failed" }
Write-Host "SUCCESS. Try it: GET https://$ApiId.execute-api.$Region.amazonaws.com/$Stage/notify/config (with a portal JWT)" -ForegroundColor Green
