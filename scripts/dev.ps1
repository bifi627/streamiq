# Run streamiq locally in one command: Firebase Auth emulator (Docker) + API + frontend.
# The API is the Go one on :5028, in front of the .NET one on :5029 (the routes Go doesn't
# serve yet), both on the same database.
#
#   powershell -File scripts/dev.ps1              # Ctrl+C stops the frontend AND the API windows
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
$conn = @($env:DATABASE_URL, $env:ConnectionStrings__Default) + @($secrets | ForEach-Object {
    if ($_ -match '^(ConnectionStrings:Default|DATABASE_URL) = (.*)$') { $Matches[2] } }) | Where-Object { $_ } | Select-Object -First 1
if (-not $conn) {
    Write-Host 'No DB connection string configured -> also starting local compose Postgres.' -ForegroundColor Yellow
    $services += 'postgres'
    $conn = 'postgres://streamiq:dev@localhost:5432/streamiq'
}
# The Go API takes a URL; the .NET user-secret may be Npgsql's Key=Value form.
if ($conn -notmatch '^postgres(ql)?://') {
    $kv = @{}
    foreach ($part in $conn -split ';') { if ($part -match '^\s*([^=]+?)\s*=\s*(.*)$') { $kv[$Matches[1].ToLower()] = $Matches[2] } }
    $port = if ($kv['port']) { $kv['port'] } else { 5432 }
    $ssl = if ($kv['ssl mode']) { "?sslmode=$($kv['ssl mode'].ToLower())" } else { '' }
    $conn = "postgres://$([uri]::EscapeDataString($kv['username'])):$([uri]::EscapeDataString($kv['password']))@$($kv['host']):$port/$($kv['database'])$ssl"
}
docker compose -p streamiq up -d --build @services   # -p: one shared stack across clones/worktrees
if ($LASTEXITCODE -ne 0) { throw 'docker compose up failed.' }

if (-not (Test-Path frontend/node_modules/.bin)) { npm ci --prefix frontend }  # no .bin = missing or interrupted install

# .NET API in its own window (launch profile: http://localhost:5029 + emulator env). It
# migrates the database (EF) on start; the Go API adopts that schema, so it waits for it.
$backend = Start-Process powershell -PassThru -ArgumentList '-NoExit', '-Command',
    "Set-Location '$root'; dotnet run --project backend/src/StreamIq.Api"
Write-Host 'Waiting for the .NET API (EF migrations) ...'
while ($true) {
    try { Invoke-WebRequest -UseBasicParsing http://localhost:5029/healthz *> $null; break } catch { Start-Sleep 1 }
}
$env:DATABASE_URL = $conn
# streamiq_app logs in to whatever database this is (a Railway dev instance is public):
# a fresh random password per run, never one from the repo. The API sets it at start.
$appPassword = [guid]::NewGuid().ToString('N')
$api = Start-Process powershell -PassThru -ArgumentList '-NoExit', '-Command', (
    "Set-Location '$root'; `$env:STREAMIQ_ENV='development'; `$env:STREAMIQ_APP_DB_PASSWORD='$appPassword'; " +
    "`$env:STREAMIQ_API_ADDR='localhost:5028'; `$env:STREAMIQ_LEGACY_API_URL='http://localhost:5029'; " +
    "`$env:FIREBASE_AUTH_EMULATOR_HOST='localhost:9099'; `$env:FIREBASE_PROJECT_ID='demo-streamiq'; go run ./api/cmd/api")

Write-Host "`n  app:      http://localhost:5173`n  api:      http://localhost:5028/healthz`n  emulator: http://localhost:9099 (Auth)`n" -ForegroundColor Cyan
try { npm run dev --prefix frontend }
finally { taskkill /T /F /PID $backend.Id *> $null; taskkill /T /F /PID $api.Id *> $null }
