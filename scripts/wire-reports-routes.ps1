<#
.SYNOPSIS
    Wires the report engine's routes on the Sundial REST API (API Gateway 5sktfwldh1,
    us-west-1, stage prod) to the sundial-reports Lambda (D-088 R1a, D-089 R1b):
      POST   /reports/run              run a report definition against the cache
      GET    /reports/types            the report types
      GET    /reports/catalog          the fields a report type offers this caller (?type=solar)
      POST   /reports/csv              queue a CSV export          (R1b)
      GET    /reports/csv/{exportId}   an export's status + link    (R1b)
      GET    /reports  POST /reports   saved reports: list / create (R1b)
      GET / PATCH / DELETE /reports/{id}                            (R1b)
      GET    /reports/{id}/run  GET /reports/{id}/csv               (R1b)
    plus OPTIONS (204, CORS) on every resource. AWS_PROXY, authorization NONE at the gateway —
    the Supabase JWT is checked IN the Lambda (reports.read: Executive / Admin / Manager).

    R1b ALSO sets, on the Lambda (the asynchronous CSV export, lambdas/sundial-reports/csv.js):
      - timeout 300 s, memory 1,024 MB (the export worker pages 50,000 rows; API requests
        still end inside API Gateway's 29 s);
      - async-invoke retries 0 (a failed export is marked failed, never silently re-run);
      - an inline role policy "sundial-reports-export" on sundial-lambda-execution-role:
        lambda:InvokeFunction on sundial-reports ITSELF (the worker), and
        s3:PutObject / GetObject / AbortMultipartUpload / ListMultipartUploadParts on
        sfsolproj/REPORTS/* only. put-role-policy adds or replaces THIS policy alone; the
        role's other policies are untouched.

.DESCRIPTION
    Idempotent (same conventions as wire-dealer-routes.ps1). PRECONDITIONS, in order
    (TASKS.md, Reporting R1b):
      1. The R1b SQL files have been run in the Supabase SQL editor.
      2. sundial-reports is deployed with the R1b code: .\deploy.ps1 sundial-reports
      3. sundial-auth-proxy is redeployed (.\deploy.ps1 sundial-auth-proxy) so /auth/me
         advertises reports.write / reports.share.

.EXAMPLE
    .\scripts\wire-reports-routes.ps1
    .\scripts\wire-reports-routes.ps1 -Yes
#>
[CmdletBinding()]
param([switch]$Yes)

$ErrorActionPreference = "Continue"
$Region = "us-west-1"
$ApiId  = "5sktfwldh1"
$Stage  = "prod"
$Fn     = "sundial-reports"
$AcctId = "891377232720"
$Role   = "sundial-lambda-execution-role"
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
function Wire-All($resourceId, $methods) { foreach ($m in ($methods + "OPTIONS")) { Wire-Method $resourceId $m } }
# Write a JSON document to a temp file WITHOUT a BOM (aws cli rejects a BOM in file:// input).
function Write-JsonFile($obj) {
    $path = Join-Path $env:TEMP ("sundial-" + [guid]::NewGuid().ToString() + ".json")
    [System.IO.File]::WriteAllText($path, ($obj | ConvertTo-Json -Depth 10), (New-Object System.Text.UTF8Encoding($false)))
    return $path
}

Write-Host "==> Verifying $Fn exists..." -ForegroundColor Cyan
$fnCfg = aws lambda get-function-configuration --function-name $Fn --region $Region --output json | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or -not $fnCfg.FunctionArn) { throw "$Fn does not exist yet. Run the create-function command in TASKS.md, deploy it, then re-run." }

$root = (Get-Resources | Where-Object { $_.path -eq "/" }).id
if (-not $root) { throw "Could not find root resource." }

Write-Host "==> /reports : GET, POST, OPTIONS" -ForegroundColor Cyan
$reports = Ensure-Resource $root "reports"
Wire-All $reports @("GET", "POST")

Write-Host "==> /reports/run : POST" -ForegroundColor Cyan
Wire-All (Ensure-Resource $reports "run") @("POST")
Write-Host "==> /reports/types : GET" -ForegroundColor Cyan
Wire-All (Ensure-Resource $reports "types") @("GET")
Write-Host "==> /reports/catalog : GET" -ForegroundColor Cyan
Wire-All (Ensure-Resource $reports "catalog") @("GET")

Write-Host "==> /reports/csv : POST ; /reports/csv/{exportId} : GET" -ForegroundColor Cyan
$csv = Ensure-Resource $reports "csv"
Wire-All $csv @("POST")
Wire-All (Ensure-Resource $csv "{exportId}") @("GET")

Write-Host "==> /reports/{id} : GET, PATCH, DELETE ; /{id}/run, /{id}/csv : GET" -ForegroundColor Cyan
$one = Ensure-Resource $reports "{id}"
Wire-All $one @("GET", "PATCH", "DELETE")
Wire-All (Ensure-Resource $one "run") @("GET")
Wire-All (Ensure-Resource $one "csv") @("GET")

Write-Host "==> Lambda invoke permission (apigateway)" -ForegroundColor Cyan
# /reports/* covers every sub-path; /reports itself (GET / POST the list) needs its own ARN.
aws lambda add-permission --function-name $Fn --region $Region `
    --statement-id "apigw-reports" --action "lambda:InvokeFunction" `
    --principal apigateway.amazonaws.com --source-arn "arn:aws:execute-api:${Region}:${AcctId}:${ApiId}/*/*/reports/*" --output json 2>$null | Out-Null
aws lambda add-permission --function-name $Fn --region $Region `
    --statement-id "apigw-reports-root" --action "lambda:InvokeFunction" `
    --principal apigateway.amazonaws.com --source-arn "arn:aws:execute-api:${Region}:${AcctId}:${ApiId}/*/*/reports" --output json 2>$null | Out-Null
Write-Host "  (an 'already exists' error here is harmless - permission is in place)" -ForegroundColor DarkGray

Write-Host "==> Lambda: timeout 300 s, memory 1024 MB (the CSV worker)" -ForegroundColor Cyan
aws lambda update-function-configuration --function-name $Fn --region $Region --timeout 300 --memory-size 1024 --output json | Out-Null
if ($LASTEXITCODE -ne 0) { throw "update-function-configuration failed" }
aws lambda wait function-updated --function-name $Fn --region $Region
Write-Host "  set" -ForegroundColor Green

Write-Host "==> Lambda: async invokes are never retried (a failed export is marked failed)" -ForegroundColor Cyan
aws lambda put-function-event-invoke-config --function-name $Fn --region $Region --maximum-retry-attempts 0 --output json | Out-Null
if ($LASTEXITCODE -ne 0) { throw "put-function-event-invoke-config failed" }
Write-Host "  set" -ForegroundColor Green

Write-Host "==> IAM: inline policy sundial-reports-export on $Role" -ForegroundColor Cyan
$policy = @{
    Version   = "2012-10-17"
    Statement = @(
        @{ Sid = "SelfInvokeReportsCsv"; Effect = "Allow"; Action = "lambda:InvokeFunction"; Resource = "arn:aws:lambda:${Region}:${AcctId}:function:${Fn}" },
        @{ Sid = "ReportsCsvObjects"; Effect = "Allow"
           Action = @("s3:PutObject", "s3:GetObject", "s3:AbortMultipartUpload", "s3:ListMultipartUploadParts")
           Resource = "arn:aws:s3:::sfsolproj/REPORTS/*" }
    )
}
$pf = Write-JsonFile $policy
aws iam put-role-policy --role-name $Role --policy-name "sundial-reports-export" --policy-document "file://$pf" --output json | Out-Null
$ok = $LASTEXITCODE
Remove-Item $pf -ErrorAction SilentlyContinue
if ($ok -ne 0) { throw "put-role-policy failed (need iam:PutRolePolicy)" }
Write-Host "  set (the role's other policies are unchanged)" -ForegroundColor Green

if (-not $Yes) {
    $ans = Read-Host "Deploy API to '$Stage' now? LIVE production change. (y/N)"
    if ($ans -ne "y") { Write-Host "Routes created but NOT live until you deploy." -ForegroundColor Yellow; exit 0 }
}
Write-Host "==> create-deployment -> $Stage" -ForegroundColor Cyan
aws apigateway create-deployment --rest-api-id $ApiId --region $Region --stage-name $Stage `
    --description "Report engine routes (R1b: CSV + saved reports) -> $Fn" --output json | Out-Null
if ($LASTEXITCODE -ne 0) { throw "create-deployment failed" }
Write-Host "SUCCESS. Next: .\scripts\add-reports-lifecycle.ps1, then node scripts/verify-report-run.mjs" -ForegroundColor Green
