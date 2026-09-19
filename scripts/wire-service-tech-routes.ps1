<#
.SYNOPSIS
    Wires the technician app's routes on the Sundial REST API (API Gateway 5sktfwldh1,
    us-west-1, stage prod) — D-072 amendment 7:
      sundial-service-board:
        GET  /service/tech/day                         my calls for a day
        GET  /service/tech/price-book                  price-book search for "add what I found"
        GET  /service/tech/jobs, /jobs/{id}            read-only lists + records (2026-09-16)
        GET  /service/tech/estimates, /estimates/{id}
        GET  /service/tech/customers, /customers/{id}
        GET  /service/tech/calls/{id}                  one call, everything on it
        POST /service/tech/calls/{id}/status           on my way / clock in / complete / no-show
        POST /service/tech/calls/{id}/notes            stamped, append-only notes
        POST /service/tech/calls/{id}/checklist        tick an item
        POST /service/tech/calls/{id}/photos           presigned PUT for a photo
        POST /service/tech/calls/{id}/photos/confirm   register the photo, bump the count
        GET  /service/tech/calls/{id}/photos           list the call's photos
        GET  /service/tech/jobs/{id}/street-view       the house (estimate Lambda, 2026-09-19)
      sundial-service-estimate:
        POST /service/tech/calls/{id}/estimate-lines   add Proposed "Field" lines to the job's estimate
    plus OPTIONS for CORS on every resource. AWS_PROXY, authorization NONE at the gateway —
    the Supabase JWT is checked in the Lambdas (action `service.tech.self`).

.DESCRIPTION
    Idempotent (same conventions as wire-service-board-routes.ps1). PRECONDITIONS:
      1. .\deploy.ps1 sundial-service-board ; .\deploy.ps1 sundial-service-estimate ;
         .\deploy.ps1 sundial-sms ; .\deploy.ps1 sundial-auth-proxy   (new lib/access.js scope)
      2. Secrets Manager `sundial/google-maps` { "apiKey" } — the key now also needs the
         **Geocoding API** enabled (Street View Static API was already on it).
      3. Optional env on sundial-service-board: SERVICE_GEOFENCE_METERS (default 250),
         SERVICE_SHOP_LATLNG ("33.45,-112.07" — the shop counts as "on site").
    The board Lambda's role must be allowed s3:PutObject (presign) and s3:ListBucket on
    sfsolproj/SUNDIAL/* — the same grant sundial-upload-file and sundial-list-files carry.

.EXAMPLE
    .\scripts\wire-service-tech-routes.ps1
    .\scripts\wire-service-tech-routes.ps1 -Yes
#>
[CmdletBinding()]
param([switch]$Yes)

$ErrorActionPreference = "Continue"
$Region = "us-west-1"
$ApiId  = "5sktfwldh1"
$Stage  = "prod"
$AcctId = "891377232720"
$Board  = "sundial-service-board"
$Est    = "sundial-service-estimate"
function Uri-For($fn) { "arn:aws:apigateway:${Region}:lambda:path/2015-03-31/functions/arn:aws:lambda:${Region}:${AcctId}:function:${fn}/invocations" }

function Get-Resources { (aws apigateway get-resources --rest-api-id $ApiId --region $Region --limit 500 --output json | ConvertFrom-Json).items }
function Ensure-Resource($parentId, $part) {
    $ex = (Get-Resources | Where-Object { $_.parentId -eq $parentId -and $_.pathPart -eq $part }).id
    if ($ex) { Write-Host "  resource '$part' exists ($ex)"; return $ex }
    $c = aws apigateway create-resource --rest-api-id $ApiId --region $Region --parent-id $parentId --path-part $part --output json | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0 -or -not $c.id) { throw "create-resource '$part' failed (need apigateway:POST)" }
    Write-Host "  created resource '$part' ($($c.id))"
    return $c.id
}
function Wire-Method($resourceId, $method, $fn) {
    aws apigateway put-method --rest-api-id $ApiId --region $Region --resource-id $resourceId `
        --http-method $method --authorization-type NONE --no-api-key-required --output json 2>$null | Out-Null
    aws apigateway put-integration --rest-api-id $ApiId --region $Region --resource-id $resourceId `
        --http-method $method --type AWS_PROXY --integration-http-method POST --uri (Uri-For $fn) --output json | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "put-integration $method failed on $resourceId" }
    Write-Host "  wired $method -> AWS_PROXY -> $fn" -ForegroundColor Green
}

foreach ($fn in @($Board, $Est)) {
    Write-Host "==> Verifying $fn exists..." -ForegroundColor Cyan
    aws lambda get-function-configuration --function-name $fn --region $Region --output json | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "$fn does not exist. Deploy it first." }
}

$root = (Get-Resources | Where-Object { $_.path -eq "/" }).id
if (-not $root) { throw "Could not find root resource." }
$service = Ensure-Resource $root "service"
$tech    = Ensure-Resource $service "tech"

Write-Host "==> /service/tech/day and /service/tech/price-book : GET, OPTIONS -> $Board" -ForegroundColor Cyan
$day = Ensure-Resource $tech "day"
$pb  = Ensure-Resource $tech "price-book"
foreach ($r in @($day, $pb)) { foreach ($m in @("GET", "OPTIONS")) { Wire-Method $r $m $Board } }

Write-Host "==> /service/tech/{jobs,estimates,customers} and /{id} : GET, OPTIONS -> $Board" -ForegroundColor Cyan
foreach ($part in @("jobs", "estimates", "customers")) {
    $list = Ensure-Resource $tech $part
    $one  = Ensure-Resource $list "{id}"
    foreach ($r in @($list, $one)) { foreach ($m in @("GET", "OPTIONS")) { Wire-Method $r $m $Board } }
}

Write-Host "==> /service/tech/calls/{id} : GET, OPTIONS -> $Board" -ForegroundColor Cyan
$calls  = Ensure-Resource $tech "calls"
$callId = Ensure-Resource $calls "{id}"
foreach ($m in @("GET", "OPTIONS")) { Wire-Method $callId $m $Board }

foreach ($part in @("status", "notes", "checklist")) {
    Write-Host "==> /service/tech/calls/{id}/$part : POST, OPTIONS -> $Board" -ForegroundColor Cyan
    $r = Ensure-Resource $callId $part
    foreach ($m in @("POST", "OPTIONS")) { Wire-Method $r $m $Board }
}
Write-Host "==> /service/tech/calls/{id}/photos : GET, POST, OPTIONS ; /confirm : POST, OPTIONS -> $Board" -ForegroundColor Cyan
$photos  = Ensure-Resource $callId "photos"
foreach ($m in @("GET", "POST", "OPTIONS")) { Wire-Method $photos $m $Board }
$confirm = Ensure-Resource $photos "confirm"
foreach ($m in @("POST", "OPTIONS")) { Wire-Method $confirm $m $Board }

Write-Host "==> /service/tech/calls/{id}/estimate-lines : POST, OPTIONS -> $Est" -ForegroundColor Cyan
$lines = Ensure-Resource $callId "estimate-lines"
foreach ($m in @("POST", "OPTIONS")) { Wire-Method $lines $m $Est }

# The job's photos + files (2026-09-18): the office reads / adds at the job's top level
# (/service/jobs/{id}/photos[/confirm]); a tech reads every visit's photos and the job's
# files (/service/tech/jobs/{id}/photos, /files).
Write-Host "==> /service/jobs/{id}/photos [+ /confirm] : GET, POST, OPTIONS (board)" -ForegroundColor Cyan
$jobs    = Ensure-Resource $service "jobs"
$jobId   = Ensure-Resource $jobs "{id}"
$jPhotos = Ensure-Resource $jobId "photos"
foreach ($m in @("GET", "POST", "OPTIONS")) { Wire-Method $jPhotos $m $Board }
$jConfirm = Ensure-Resource $jPhotos "confirm"
foreach ($m in @("POST", "OPTIONS")) { Wire-Method $jConfirm $m $Board }
Write-Host "==> /service/tech/jobs/{id}/photos, /files : GET, OPTIONS (board)" -ForegroundColor Cyan
$tJobs  = Ensure-Resource $tech "jobs"
$tJobId = Ensure-Resource $tJobs "{id}"
foreach ($part in @("photos", "files")) {
    $r = Ensure-Resource $tJobId $part
    foreach ($m in @("GET", "OPTIONS")) { Wire-Method $r $m $Board }
}
# The house on the phone (2026-09-19): the same Street View still the office's job page
# fetches, served read-only to the tech app by the ESTIMATE Lambda (the Google key lives there).
Write-Host "==> /service/tech/jobs/{id}/street-view : GET, OPTIONS -> $Est" -ForegroundColor Cyan
$tSv = Ensure-Resource $tJobId "street-view"
foreach ($m in @("GET", "OPTIONS")) { Wire-Method $tSv $m $Est }

Write-Host "==> Lambda invoke permissions (apigateway)" -ForegroundColor Cyan
foreach ($pair in @(@($Board, "apigw-service-board"), @($Est, "apigw-service-estimate"))) {
    aws lambda add-permission --function-name $pair[0] --region $Region `
        --statement-id $pair[1] --action "lambda:InvokeFunction" `
        --principal apigateway.amazonaws.com --source-arn "arn:aws:execute-api:${Region}:${AcctId}:${ApiId}/*/*/service/*" --output json 2>$null | Out-Null
}
Write-Host "  (an 'already exists' error here is harmless - permission is in place)" -ForegroundColor DarkGray

if (-not $Yes) {
    $ans = Read-Host "Deploy API to '$Stage' now? LIVE production change. (y/N)"
    if ($ans -ne "y") { Write-Host "Routes created but NOT live until you deploy." -ForegroundColor Yellow; exit 0 }
}
Write-Host "==> create-deployment -> $Stage" -ForegroundColor Cyan
aws apigateway create-deployment --rest-api-id $ApiId --region $Region --stage-name $Stage `
    --description "Add technician app routes -> $Board / $Est" --output json | Out-Null
if ($LASTEXITCODE -ne 0) { throw "create-deployment failed" }
Write-Host "SUCCESS. The tech app is at https://sundial.harmonelectric.net/tech" -ForegroundColor Green
