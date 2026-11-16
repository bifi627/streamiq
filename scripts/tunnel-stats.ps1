#requires -Version 5.1
<#
.SYNOPSIS
  Print tunnel telemetry aggregates across all households (#391): plain-text tables per ISO week.

.DESCRIPTION
  Runs scripts/tunnel-stats.sql (read-only) with psql from the postgres:18 image (no local
  pg tools; needs Docker). Prod: Railway Postgres DATABASE_PUBLIC_URL (add ?sslmode=require
  if missing). A localhost URL (compose Postgres) is reached via host.docker.internal.
  Never put the connection string in the repo: pass it, or set STREAMIQ_STATS_DB.

.EXAMPLE
  ./scripts/tunnel-stats.ps1 -ConnectionString 'postgresql://postgres:pw@host.proxy.rlwy.net:1234/railway?sslmode=require'

.EXAMPLE
  # dev: compose Postgres, last 4 weeks
  ./scripts/tunnel-stats.ps1 -ConnectionString 'postgresql://streamiq:dev@localhost:5432/streamiq' -Weeks 4
#>
param(
    [string]$ConnectionString = $env:STREAMIQ_STATS_DB,
    [ValidateRange(1, 520)][int]$Weeks = 8
)

$ErrorActionPreference = 'Stop'
if (-not $ConnectionString) { throw 'Pass -ConnectionString or set STREAMIQ_STATS_DB.' }

# psql runs in a container: the host's localhost is host.docker.internal there
$url = $ConnectionString -replace '@(localhost|127\.0\.0\.1)([:/])', '@host.docker.internal$2'

# A "-- # Title" line in the .sql becomes a printed heading (plain SQL stays runnable on its own)
$sql = (Get-Content -Raw (Join-Path $PSScriptRoot 'tunnel-stats.sql')) -replace '(?m)^-- # (.*)$', "\qecho`n\qecho == `$1"
"SET default_transaction_read_only = on; SET stats.weeks = $Weeks;`n$sql" | docker run -i --rm postgres:18 psql -q -X -v ON_ERROR_STOP=1 -d $url -f -
if ($LASTEXITCODE -ne 0) { throw "psql failed (exit $LASTEXITCODE)" }
