<#
.SYNOPSIS
    Bundles a single Sundial Lambda function with esbuild and pushes the bundled
    code into an existing, hand-created AWS Lambda function. Never creates or
    recreates infrastructure.

.DESCRIPTION
    Given a function name, this script:
      1. Ensures repo-root dependencies (incl. esbuild) are installed
      2. Bundles lambdas/<name>/index.js with esbuild into ONE self-contained
         file (target node22, format esm, platform node, bundle=true, minify off,
         sourcemap off). Shared lib/ code and npm dependencies are inlined, so the
         deployed artifact is a single handler file.
      3. Writes the bundle as index.mjs into a per-function temp build dir
      4. Zips the build dir CONTENTS so index.mjs sits at the ZIP ROOT
      5. Runs `aws lambda update-function-code` with that zip
      6. Waits for the function update to settle (so a follow-up invoke is safe)
      7. Cleans up the temp build dir and zip

    The function name argument must match BOTH the folder name under lambdas/
    AND the AWS Lambda function name exactly (e.g. sundial-auth-proxy).

    Region is pinned to us-west-1 explicitly on every AWS call.

    NOTE ON THE .mjs EXTENSION: esbuild emits ESM. Lambda only treats a bare
    `index.js` as ESM if a package.json with {"type":"module"} is shipped next to
    it AND parsed cleanly (a UTF-8 BOM breaks that detection and the runtime falls
    back to CommonJS, which then fails on `export`). Naming the single bundle
    `index.mjs` makes Lambda load it as ESM natively with no manifest, keeping the
    zip to exactly one self-contained handler file. The handler stays
    `index.handler` — the runtime resolves it to index.mjs automatically.

.EXAMPLE
    .\deploy.ps1 sundial-auth-proxy
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string]$FunctionName
)

# Stop on the first unhandled error so we never report a false success.
$ErrorActionPreference = "Stop"

# Region is pinned here and passed explicitly to every AWS call below.
$Region = "us-west-1"

# Resolve paths relative to this script so it works from any working directory.
$RepoRoot = $PSScriptRoot
$FuncDir  = Join-Path $RepoRoot "lambdas\$FunctionName"
$EntryFile = Join-Path $FuncDir "index.js"
$BuildDir = Join-Path $RepoRoot ".build\$FunctionName"
$ZipPath  = Join-Path $RepoRoot "$FunctionName.zip"

# Optional per-function postbuild hook: remove transient prebuild output so the
# working tree returns to normal (e.g. sundial-budget's template.generated.js).
# Defined up front so both the success and failure cleanup paths can call it.
$PostBuild = Join-Path $FuncDir "postbuild.mjs"
$RunPostBuild = {
    if (Test-Path $PostBuild) {
        Write-Host "==> postbuild hook: node postbuild.mjs" -ForegroundColor DarkGray
        Push-Location $FuncDir
        try { node postbuild.mjs } finally { Pop-Location }
    }
}

Write-Host "==> Deploying '$FunctionName' to AWS Lambda (region $Region)" -ForegroundColor Cyan

# --- Validate the function entry point exists ---------------------------------
if (-not (Test-Path $EntryFile)) {
    Write-Host "FAILURE: entry file not found: $EntryFile" -ForegroundColor Red
    Write-Host "The argument must match a folder under lambdas/ containing index.js." -ForegroundColor Red
    exit 1
}

try {
    # --- Ensure repo-root deps (esbuild + bundled runtime deps) are present ----
    Write-Host "==> npm install (repo root)" -ForegroundColor Cyan
    Push-Location $RepoRoot
    try {
        npm install
        if ($LASTEXITCODE -ne 0) { throw "npm install failed with exit code $LASTEXITCODE" }
    }
    finally {
        Pop-Location
    }

    # --- Bundle with esbuild ---------------------------------------------------
    # Clean any prior build output for this function.
    if (Test-Path $BuildDir) { Remove-Item $BuildDir -Recurse -Force }
    New-Item -ItemType Directory -Path $BuildDir | Out-Null

    # --- Optional per-function prebuild hook -----------------------------------
    # If the function folder contains prebuild.mjs, run it before bundling. Used by
    # sundial-budget to generate template.generated.js (base64-embedded workbook
    # template) from its source .xlsx so the single bundle carries the exact bytes.
    # Functions without a prebuild.mjs are unaffected.
    $PreBuild = Join-Path $FuncDir "prebuild.mjs"
    if (Test-Path $PreBuild) {
        Write-Host "==> prebuild hook: node prebuild.mjs" -ForegroundColor Cyan
        Push-Location $FuncDir
        try {
            node prebuild.mjs
            if ($LASTEXITCODE -ne 0) { throw "prebuild.mjs failed with exit code $LASTEXITCODE" }
        }
        finally {
            Pop-Location
        }
    }

    $OutFile = Join-Path $BuildDir "index.mjs"

    # ESM output can still contain CJS dependencies (jsonwebtoken, aws-sdk, etc.)
    # that reference require/__dirname/__filename at runtime. This banner shims
    # those into the ESM bundle so they resolve correctly.
    $Banner = "import { createRequire as __sundialCreateRequire } from 'module'; const require = __sundialCreateRequire(import.meta.url); import { fileURLToPath as __sundialFileURLToPath } from 'url'; import { dirname as __sundialDirname } from 'path'; const __filename = __sundialFileURLToPath(import.meta.url); const __dirname = __sundialDirname(__filename);"

    Write-Host "==> esbuild bundle -> $OutFile" -ForegroundColor Cyan
    npx esbuild "$EntryFile" `
        --bundle `
        --platform=node `
        --format=esm `
        --target=node22 `
        "--outfile=$OutFile" `
        "--banner:js=$Banner"
    if ($LASTEXITCODE -ne 0) { throw "esbuild bundle failed with exit code $LASTEXITCODE" }

    # --- Zip the build dir CONTENTS (index.mjs at the ZIP ROOT) ----------------
    if (Test-Path $ZipPath) { Remove-Item $ZipPath -Force }
    Write-Host "==> Zipping bundle to $ZipPath" -ForegroundColor Cyan
    Compress-Archive -Path (Join-Path $BuildDir "*") -DestinationPath $ZipPath -Force

    # --- Push code into the existing Lambda function ---------------------------
    Write-Host "==> aws lambda update-function-code" -ForegroundColor Cyan
    $response = aws lambda update-function-code `
        --function-name $FunctionName `
        --zip-file "fileb://$ZipPath" `
        --region $Region `
        --output json
    if ($LASTEXITCODE -ne 0) { throw "aws lambda update-function-code failed with exit code $LASTEXITCODE" }

    Write-Host "--- AWS response ---------------------------------------------" -ForegroundColor DarkGray
    Write-Host $response
    Write-Host "--------------------------------------------------------------" -ForegroundColor DarkGray

    # --- Wait for the update to settle so a follow-up invoke is safe -----------
    Write-Host "==> Waiting for function update to settle..." -ForegroundColor Cyan
    aws lambda wait function-updated --function-name $FunctionName --region $Region
    if ($LASTEXITCODE -ne 0) { throw "wait function-updated failed with exit code $LASTEXITCODE" }

    Write-Host "SUCCESS: '$FunctionName' bundled and code updated in region $Region." -ForegroundColor Green
}
catch {
    Write-Host "FAILURE: deploy of '$FunctionName' did not complete." -ForegroundColor Red
    Write-Host $_.Exception.Message -ForegroundColor Red
    if (Test-Path $ZipPath) { Remove-Item $ZipPath -Force }
    if (Test-Path $BuildDir) { Remove-Item $BuildDir -Recurse -Force }
    & $RunPostBuild
    exit 1
}

# --- Clean up temp artifacts --------------------------------------------------
if (Test-Path $ZipPath) { Remove-Item $ZipPath -Force }
if (Test-Path $BuildDir) { Remove-Item $BuildDir -Recurse -Force }
& $RunPostBuild
Write-Host "==> Cleaned up temp build dir and zip." -ForegroundColor DarkGray
