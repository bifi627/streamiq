# Run streamiq locally in one command: Firebase Auth emulator (Docker) + API + frontend.
# The API (Go) on :5028; Vite serves the web app on :5173.
#
#   powershell -File scripts/dev.ps1              # Ctrl+C stops the frontend AND the API windows
#   powershell -File scripts/dev.ps1 -ResetGateway  # also wipe gateway/streamiq-state (= brand-new gateway, re-onboard)
#
# Gateway (separate terminal, from gateway/): web app -> Add gateway -> run the shown
# command. More gateways on one machine: give each its own STREAMIQ_STATE_DIR + STREAMIQ_PAGE_PORT.
#
# Database: DATABASE_URL (a postgres:// URL) from the environment or .env, e.g. a Railway
# dev instance. Unset: this also starts the compose Postgres. Auth is always the emulator.
param([switch]$ResetGateway)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root

if ($ResetGateway -and (Test-Path gateway/streamiq-state)) {
    Remove-Item -Recurse -Force gateway/streamiq-state
    Write-Host 'Gateway state wiped -> next gateway start needs a fresh enrollment token.' -ForegroundColor Yellow
}

docker info *> $null
if ($LASTEXITCODE -ne 0) { throw 'Docker is not running - start Docker Desktop first.' }

$services = @('firebase')
$conn = $env:DATABASE_URL
if (-not $conn -and (Test-Path .env)) {
    $conn = Get-Content .env | ForEach-Object { if ($_ -match '^\s*DATABASE_URL\s*=\s*(\S+)') { $Matches[1] } } | Select-Object -First 1
}
if (-not $conn) {
    Write-Host 'No DATABASE_URL set -> also starting local compose Postgres.' -ForegroundColor Yellow
    $services += 'postgres'
    $conn = 'postgres://streamiq:dev@localhost:5432/streamiq'
}
docker compose -p streamiq up -d --build @services   # -p: one shared stack across clones/worktrees
if ($LASTEXITCODE -ne 0) { throw 'docker compose up failed.' }

if (-not (Test-Path frontend/node_modules/.bin)) { npm ci --prefix frontend }  # no .bin = missing or interrupted install

$env:DATABASE_URL = $conn
# streamiq_app logs in to whatever database this is (a Railway dev instance is public):
# a fresh random password per run, never one from the repo. The API sets it at start.
$appPassword = [guid]::NewGuid().ToString('N')
$api = Start-Process powershell -PassThru -ArgumentList '-NoExit', '-Command', (
    "Set-Location '$root'; `$env:STREAMIQ_ENV='development'; `$env:STREAMIQ_APP_DB_PASSWORD='$appPassword'; " +
    "`$env:STREAMIQ_API_ADDR='localhost:5028'; " +
    "`$env:FIREBASE_AUTH_EMULATOR_HOST='localhost:9099'; `$env:FIREBASE_PROJECT_ID='demo-streamiq'; go run ./api/cmd/api")

Write-Host "`n  app:      http://localhost:5173`n  api:      http://localhost:5028/healthz`n  emulator: http://localhost:9099 (Auth)`n" -ForegroundColor Cyan
try { npm run dev --prefix frontend }
finally { taskkill /T /F /PID $api.Id *> $null }
