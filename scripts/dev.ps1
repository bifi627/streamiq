# Run streamiq locally in one command: Firebase Auth emulator (Docker) + backend + frontend.
#
#   powershell -File scripts/dev.ps1              # Ctrl+C stops the frontend AND the backend window
#   powershell -File scripts/dev.ps1 -ResetGateway  # also wipe gateway/streamiq-state (= brand-new gateway, re-onboard)
#
# Gateway (separate terminal, from gateway/): web app -> Add gateway -> run the shown
# command. More gateways on one machine: give each its own STREAMIQ_STATE_DIR + STREAMIQ_PAGE_PORT.
#
# Database: whatever the backend is configured with (user-secrets / env), e.g. a
# Railway dev instance. Only when no connection string is set does this also start
# the compose Postgres (the backend's built-in fallback). Auth is always the emulator.
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
$secrets = dotnet user-secrets list --project backend/src/StreamIq.Api 2>$null
if (-not ($secrets -match '^(ConnectionStrings:Default|DATABASE_URL) =') -and
    -not $env:ConnectionStrings__Default -and -not $env:DATABASE_URL) {
    Write-Host 'No DB connection string configured -> also starting local compose Postgres.' -ForegroundColor Yellow
    $services += 'postgres'
}
docker compose -p streamiq up -d --build @services   # -p: one shared stack across clones/worktrees
if ($LASTEXITCODE -ne 0) { throw 'docker compose up failed.' }

if (-not (Test-Path frontend/node_modules/.bin)) { npm ci --prefix frontend }  # no .bin = missing or interrupted install

# Backend in its own window (launch profile: http://localhost:5028 + emulator env).
$backend = Start-Process powershell -PassThru -ArgumentList '-NoExit', '-Command',
    "Set-Location '$root'; dotnet run --project backend/src/StreamIq.Api"

Write-Host "`n  app:      http://localhost:5173`n  api:      http://localhost:5028/healthz`n  emulator: http://localhost:9099 (Auth)`n" -ForegroundColor Cyan
try { npm run dev --prefix frontend }
finally { taskkill /T /F /PID $backend.Id *> $null }
