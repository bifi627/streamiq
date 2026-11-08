#requires -Version 5.1
<#
.SYNOPSIS
  Restore a StreamIQ Postgres dump (local .dump file) into a Postgres server.

.DESCRIPTION
  Runs pg_restore from the postgres:18 image (client = server major, no local pg tools).
  Pass the target's Railway DATABASE_PUBLIC_URL (TCP proxy on; add ?sslmode=require if
  missing). Runbook: docs/db-recovery.md. Needs Docker.

  A few CREATE EXTENSION / notice lines are benign; the \dt list at the end is the proof.

.EXAMPLE
  ./scripts/restore-db.ps1 -DumpPath .\streamiq-production-20261108T020000Z.dump -TargetUrl 'postgresql://postgres:pw@host.proxy.rlwy.net:1234/railway?sslmode=require'

.EXAMPLE
  # overwrite a NON-empty target (drops existing objects first)
  ./scripts/restore-db.ps1 -DumpPath .\prod.dump -TargetUrl '...' -Clean
#>
param(
    [Parameter(Mandatory)][string]$DumpPath,
    [Parameter(Mandatory)][string]$TargetUrl,
    [switch]$Clean
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path $DumpPath)) { throw "Dump file not found: $DumpPath" }
$local = (Resolve-Path $DumpPath).Path
$dir = Split-Path -Parent $local
$file = Split-Path -Leaf $local

# Confirm the target before anything destructive
$uri = [uri]$TargetUrl
Write-Host ''
Write-Host 'About to restore:' -ForegroundColor Yellow
Write-Host "  dump   : $file"
Write-Host "  target : $($uri.Host):$($uri.Port)$($uri.AbsolutePath)"
Write-Host "  mode   : $(if ($Clean) { '--clean (drops existing objects first)' } else { 'into an empty database' })"
if ((Read-Host "Type 'restore' to proceed") -ne 'restore') { Write-Host 'Aborted.'; return }

$cleanArgs = if ($Clean) { @('--clean', '--if-exists') } else { @() }
Write-Host 'Restoring ...'
docker run --rm -v "${dir}:/d" postgres:18 `
    pg_restore --no-owner --no-privileges @cleanArgs -d $TargetUrl "/d/$file"
if ($LASTEXITCODE -ne 0) { throw "pg_restore failed (exit $LASTEXITCODE)" }

Write-Host 'Restored. Tables now in target:' -ForegroundColor Green
docker run --rm postgres:18 psql -d $TargetUrl -c '\dt'
