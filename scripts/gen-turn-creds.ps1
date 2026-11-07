<#
.SYNOPSIS
  Mint short-lived Cloudflare Realtime TURN credentials for the gateway, and
  print the env vars ready to paste. Gateway-only: browsers get a per-session
  TURN credential from the API's broker (`ready` message).

.DESCRIPTION
  Calls Cloudflare's generate-ice-servers endpoint with your TURN key, saves the
  full iceServers response to dev/.cloudflare-turn.json (git-ignored), and emits:
    - the gateway env vars (start the home gateway with TURN enabled)
  Throwaway dev tooling: creds expire (default 24h); re-run to refresh.

.EXAMPLE
  ./scripts/gen-turn-creds.ps1 -KeyId <key-id> -ApiToken <api-token>

  Or run with no args and it will prompt for both.
#>
[CmdletBinding()]
param(
  [string]$KeyId,
  [string]$ApiToken,
  [int]$Ttl = 86400 # 24h field-test window
)

$ErrorActionPreference = "Stop"

if (-not $KeyId)    { $KeyId    = Read-Host "Cloudflare TURN Key ID (from Realtime -> TURN)" }
if (-not $ApiToken) { $ApiToken = Read-Host "Cloudflare TURN API token" }

$uri = "https://rtc.live.cloudflare.com/v1/turn/keys/$KeyId/credentials/generate-ice-servers"
Write-Host "`nRequesting TURN credentials (ttl ${Ttl}s)..." -ForegroundColor Cyan

try {
  $resp = Invoke-RestMethod -Method Post -Uri $uri `
    -Headers @{ Authorization = "Bearer $ApiToken" } `
    -ContentType "application/json" `
    -Body (@{ ttl = $Ttl } | ConvertTo-Json)
}
catch {
  Write-Host "`nRequest failed: $($_.Exception.Message)" -ForegroundColor Red
  Write-Host "  401 -> API token wrong/expired.  404 -> Key ID wrong (it's the URL part, not the token)." -ForegroundColor Yellow
  exit 1
}

# Persist the raw response (git-ignored).
$outFile = Join-Path $PSScriptRoot "..\dev\.cloudflare-turn.json"
$resp | ConvertTo-Json -Depth 8 | Set-Content -Path $outFile -Encoding utf8
Write-Host "Saved: dev/.cloudflare-turn.json" -ForegroundColor Green

# Pull the TURN entry (the one carrying username/credential) out of iceServers.
$turn = $resp.iceServers | Where-Object { $_.username } | Select-Object -First 1
if (-not $turn) { Write-Host "No TURN entry with credentials in response." -ForegroundColor Red; exit 1 }

$urls     = @($turn.urls) -join ","
$user     = $turn.username
$cred     = $turn.credential

Write-Host "`n=== ICE servers ===" -ForegroundColor Cyan
$resp.iceServers | ConvertTo-Json -Depth 6

# --- Gateway env (run the home gateway with Cloudflare TURN) --------------------
Write-Host "`n=== Home gateway (PowerShell) ===" -ForegroundColor Cyan
Write-Host @"
`$env:STREAMIQ_ICE_URLS     = "$urls"
`$env:STREAMIQ_ICE_USERNAME = "$user"
`$env:STREAMIQ_ICE_CREDENTIAL = "$cred"
go run ./cmd/gateway      # from the gateway/ directory
"@
