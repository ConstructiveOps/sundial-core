<#
.SYNOPSIS
    Adds a 7-day expiration rule for the REPORTS/ prefix to the sfsolproj bucket's lifecycle
    configuration — WITHOUT touching any rule already there (D-089, Reporting R1b).

.DESCRIPTION
    Why a script and not one command: put-bucket-lifecycle-configuration REPLACES the bucket's
    whole lifecycle configuration. sfsolproj is shared with XFiles Pro and the Dropbox
    copy-back, and any rule someone set for them would silently vanish. So this script:

      1. fetches the current configuration and PRINTS every rule (the "before");
      2. if a rule with the id "sundial-reports-csv-expire-7d" already exists, says so and
         changes nothing (re-running is safe);
      3. otherwise ADDS one rule — Filter Prefix "REPORTS/", Expiration 7 days, plus cleanup
         of abandoned multipart uploads after 1 day — to the rules it fetched;
      4. writes the merged configuration back and PRINTS the rules again (the "after"),
         checking that every rule from step 1 is still there.
    If the bucket has no lifecycle configuration at all, it says so and creates one holding
    just this rule. The configuration's TransitionDefaultMinimumObjectSize setting (outside
    the rules) is written back as it was read.

    As of 2026-11-04 the bucket has ONE rule, "archive-old-files" (SUNDIAL/ → Glacier after
    365 days); it must be in the AFTER list.

    The rule is scoped to REPORTS/ only. Everything under SUNDIAL/ (the Salesforce-record
    folders) is never matched by it. CSV exports live at
    REPORTS/<client_sf_id>/<yyyy-mm-dd>/<id>.csv and the portal's download link lasts 15
    minutes; S3 deletes the file itself after 7 days.

    Needs s3:GetLifecycleConfiguration and s3:PutLifecycleConfiguration on sfsolproj (Tim's
    admin credentials, like the wire-*.ps1 scripts).

.EXAMPLE
    .\scripts\add-reports-lifecycle.ps1            # shows before / after, asks before writing
    .\scripts\add-reports-lifecycle.ps1 -Yes       # no question
#>
[CmdletBinding()]
param([switch]$Yes)

$ErrorActionPreference = "Stop"
$Bucket = "sfsolproj"
$Region = "us-west-1"
$RuleId = "sundial-reports-csv-expire-7d"
$Prefix = "REPORTS/"

function Show-Rules($label, $rules) {
    Write-Host ""
    Write-Host "== $label ==" -ForegroundColor Cyan
    if (-not $rules -or @($rules).Count -eq 0) { Write-Host "  (no rules)"; return }
    foreach ($r in @($rules)) {
        $scope = if ($r.Filter -and $r.Filter.Prefix -ne $null) { "prefix '$($r.Filter.Prefix)'" }
                 elseif ($r.Filter -and $r.Filter.And) { "prefix '$($r.Filter.And.Prefix)' + tags" }
                 elseif ($r.Filter -and $r.Filter.Tag) { "tag $($r.Filter.Tag.Key)=$($r.Filter.Tag.Value)" }
                 elseif ($r.Prefix -ne $null) { "prefix '$($r.Prefix)' (legacy)" }
                 else { "WHOLE BUCKET" }
        $what = @()
        if ($r.Expiration) { $what += "expire " + (($r.Expiration | ConvertTo-Json -Compress)) }
        if ($r.Transitions) { $what += "transitions " + (($r.Transitions | ConvertTo-Json -Compress)) }
        if ($r.NoncurrentVersionExpiration) { $what += "noncurrent-expire " + (($r.NoncurrentVersionExpiration | ConvertTo-Json -Compress)) }
        if ($r.AbortIncompleteMultipartUpload) { $what += "abort-multipart " + (($r.AbortIncompleteMultipartUpload | ConvertTo-Json -Compress)) }
        Write-Host ("  - id '{0}'  [{1}]  {2}  {3}" -f $r.ID, $r.Status, $scope, ($what -join "; "))
    }
}

# --- 1. fetch ---------------------------------------------------------------------------------
Write-Host "==> Reading the lifecycle configuration of $Bucket..." -ForegroundColor Cyan
$raw = aws s3api get-bucket-lifecycle-configuration --bucket $Bucket --region $Region --output json 2>&1
$code = $LASTEXITCODE
$rules = @()
$minSize = $null
$hadConfig = $true
if ($code -ne 0) {
    $text = ($raw | Out-String)
    if ($text -match "NoSuchLifecycleConfiguration") {
        $hadConfig = $false
        Write-Host "  $Bucket has NO lifecycle configuration at all - one will be created holding just the REPORTS/ rule." -ForegroundColor Yellow
    } else {
        throw "get-bucket-lifecycle-configuration failed (need s3:GetLifecycleConfiguration): $text"
    }
} else {
    $cfg = ($raw | Out-String) | ConvertFrom-Json
    $rules = @($cfg.Rules)
    $minSize = $cfg.TransitionDefaultMinimumObjectSize
}
if ($minSize) { Write-Host "  TransitionDefaultMinimumObjectSize = $minSize (kept)" }
Show-Rules "BEFORE" $rules

# --- 2. already there? ----------------------------------------------------------------------------
$existing = $rules | Where-Object { $_.ID -eq $RuleId }
if ($existing) {
    Write-Host ""
    Write-Host "A rule with id '$RuleId' already exists - nothing to do. The configuration was not written." -ForegroundColor Green
    exit 0
}

# --- 3. merge ---------------------------------------------------------------------------------
$newRule = [pscustomobject]@{
    ID                             = $RuleId
    Status                         = "Enabled"
    Filter                         = [pscustomobject]@{ Prefix = $Prefix }
    Expiration                     = [pscustomobject]@{ Days = 7 }
    AbortIncompleteMultipartUpload = [pscustomobject]@{ DaysAfterInitiation = 1 }
}
$merged = @($rules) + $newRule
Show-Rules "AFTER (to be written)" $merged

if (-not $Yes) {
    Write-Host ""
    $ans = Read-Host "Write this configuration to $Bucket? Every rule above is kept; one is added. (y/N)"
    if ($ans -ne "y") { Write-Host "Nothing written." -ForegroundColor Yellow; exit 0 }
}

# --- 4. write back --------------------------------------------------------------------------------
$doc = [pscustomobject]@{ Rules = $merged }
$path = Join-Path $env:TEMP ("sundial-lifecycle-" + [guid]::NewGuid().ToString() + ".json")
# No BOM: the aws cli rejects a BOM in file:// input.
[System.IO.File]::WriteAllText($path, ($doc | ConvertTo-Json -Depth 20), (New-Object System.Text.UTF8Encoding($false)))
try {
    $extra = @()
    if ($minSize) { $extra = @("--transition-default-minimum-object-size", $minSize) }
    aws s3api put-bucket-lifecycle-configuration --bucket $Bucket --region $Region --lifecycle-configuration "file://$path" @extra --output json | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "put-bucket-lifecycle-configuration failed (need s3:PutLifecycleConfiguration). Nothing was changed." }
} finally {
    Remove-Item $path -ErrorAction SilentlyContinue
}

# --- read it back and prove nothing was lost --------------------------------------------------------
$after = @((aws s3api get-bucket-lifecycle-configuration --bucket $Bucket --region $Region --output json | Out-String | ConvertFrom-Json).Rules)
Show-Rules "AFTER (read back from S3)" $after
$missing = @($rules | Where-Object { $id = $_.ID; -not ($after | Where-Object { $_.ID -eq $id }) })
$added = $after | Where-Object { $_.ID -eq $RuleId -and $_.Filter.Prefix -eq $Prefix -and $_.Expiration.Days -eq 7 }
if ($missing.Count -gt 0) { throw "A rule that existed before is missing now: $($missing.ID -join ', ') - restore it from the BEFORE list above." }
if (-not $added) { throw "The REPORTS/ rule is not in the configuration read back." }
$verb = if ($hadConfig) { "added to the existing configuration" } else { "created as the bucket's first lifecycle rule" }
Write-Host ""
Write-Host "SUCCESS. '$RuleId' $verb; all $($rules.Count) earlier rule(s) kept." -ForegroundColor Green
