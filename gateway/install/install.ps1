# StreamIQ gateway: install (download + verify + `gateway service install`). The
# web app's Gateways -> Add gateway shows the first-run command (it sets
# STREAMIQ_API_URL + STREAMIQ_ENROLL_TOKEN). Updating later: `gateway update`;
# re-running this script also works. The state dir (cert, credential, paired
# browsers) is never touched.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue' # the progress bar makes downloads ~10x slower
$dir = if ($env:STREAMIQ_DIR) { $env:STREAMIQ_DIR } else { Join-Path $env:LOCALAPPDATA 'streamiq' }
$dl = if ($env:STREAMIQ_DOWNLOAD) { $env:STREAMIQ_DOWNLOAD } else { 'https://github.com/bifi627/streamiq/releases/latest/download' }
$arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'amd64' }
$bin = "streamiq-gateway-windows-$arch.exe"
$exe = Join-Path $dir 'gateway.exe'
$envFile = Join-Path $dir 'gateway.env'

if (-not (Test-Path $envFile) -and -not $env:STREAMIQ_API_URL) {
    throw 'StreamIQ: first install needs the command from the web app (Gateways -> Add gateway)'
}

# Download next to the install, not into %TEMP%: "exe dropped in Temp" is an AV heuristic signal (#69).
New-Item -ItemType Directory -Force (Join-Path $dir 'state') | Out-Null
$new = "$exe.new"
$sums = Join-Path $dir 'SHA256SUMS.new'
try {
    Invoke-WebRequest "$dl/$bin" -OutFile $new
    Invoke-WebRequest "$dl/SHA256SUMS" -OutFile $sums
    $want = (Get-Content $sums | Where-Object { $_ -match "[ *]$([regex]::Escape($bin))$" }) -split '\s+' | Select-Object -First 1
    $got = (Get-FileHash $new -Algorithm SHA256).Hash
    if (-not $want -or $got -ne $want) { throw "StreamIQ: checksum mismatch for $bin, not installing" }

    # Update: the installed (old) binary backs up its own state first, and is kept
    # next to it, for `gateway rollback` (#296). No backup, no update. A gateway
    # older than `gateway backup` (#52) can't: it's replaced without one.
    $keep = $null
    $state = Join-Path $dir 'state'
    if (-not ((Test-Path (Join-Path $state 'cert.pem')) -and (Test-Path (Join-Path $state 'gateway.json')))) {
        # no gateway identity (fresh install, failed enrollment, removed gateway): nothing to roll back to
    } elseif (-not (Test-Path $exe) -or (Get-FileHash $exe).Hash -eq $got) {
        # a re-run of the installed release keeps no copy (it would push the real previous one out)
    } elseif ((& $exe -h) -match '^  backup ') {
        # PowerShell 5.1 turns a native command's redirected stderr into an error: hence the catch.
        $ver = try { & $exe version 2>$null } catch { $null }
        if (-not $ver) { $ver = 'unknown' }
        $keep = Join-Path $dir "backups\$(Get-Date -Format yyyyMMdd-HHmmss)-$ver"
        New-Item -ItemType Directory -Force $keep | Out-Null
        & $exe backup (Join-Path $keep 'state.zip') | Out-Null
        if ($LASTEXITCODE -ne 0) {
            Remove-Item -Recurse -Force $keep
            throw 'StreamIQ: backing up the installed gateway failed, nothing changed'
        }
    } elseif (Test-Path $exe) {
        Write-Warning 'StreamIQ: the installed gateway cannot back itself up; updating without a rollback point'
    }

    # Running copy (update): stop it so the exe can be replaced.
    Get-Process gateway -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $exe } | Stop-Process -Force
    Start-Sleep -Seconds 1
    Remove-Item -Force "$exe.old" -ErrorAction SilentlyContinue # left by a rollback, or an update before #296
    if ($keep) { Move-Item $exe (Join-Path $keep 'gateway.exe') }
    try { Move-Item -Force $new $exe } catch {
        if ($keep) { Move-Item (Join-Path $keep 'gateway.exe') $exe }
        throw
    }
    # The last 3 updates' backups stay (as gateway update keeps them).
    Get-ChildItem -Directory (Join-Path $dir 'backups') -ErrorAction SilentlyContinue |
        Sort-Object Name -Descending | Select-Object -Skip 3 | Remove-Item -Recurse -Force
} finally {
    Remove-Item -Force $new, $sums -ErrorAction SilentlyContinue
}

if (-not (Test-Path $envFile)) {
    $lines = @("STREAMIQ_API_URL=$env:STREAMIQ_API_URL", "STREAMIQ_STATE_DIR=$(Join-Path $dir 'state')")
    # Optional first-install settings persist, so updates keep them.
    foreach ($k in 'STREAMIQ_NAME', 'STREAMIQ_PAGE_PORT') {
        $v = [Environment]::GetEnvironmentVariable($k)
        if ($v) { $lines += "$k=$v" }
    }
    Set-Content -Encoding ascii $envFile $lines
}

# Enrolls on the first install (the token is spent here, never stored), then
# creates the logon task streamiq-gateway and starts it: its own console window
# is the log; closing it stops the gateway (no hidden start: AV heuristic, #69).
Remove-Item (Join-Path $dir 'state\page-link') -ErrorAction SilentlyContinue # wait below for this start's fresh link
# A backup onto this machine (#52): restored before the first start, so it doesn't enroll a new gateway.
if ($env:STREAMIQ_RESTORE) {
    & $exe restore $env:STREAMIQ_RESTORE
    if ($LASTEXITCODE -ne 0) { throw "StreamIQ: gateway restore failed (exit $LASTEXITCODE)" }
}
& $exe service install
$rc = $LASTEXITCODE
Remove-Item Env:STREAMIQ_ENROLL_TOKEN -ErrorAction SilentlyContinue
if ($rc -ne 0) { throw "StreamIQ: gateway service install failed (exit $rc)" }
Write-Host "StreamIQ gateway started (and at every logon)"
Write-Host "  installed:  $dir"
$port = (Get-Content $envFile | Where-Object { $_ -match '^STREAMIQ_PAGE_PORT=' }) -replace '^STREAMIQ_PAGE_PORT=', ''
Write-Host "  local page: http://localhost:$(if ($port) { $port } else { '8097' })"
# The gateway writes its LAN login link once enrolled (page token, item 6 / #42).
$link = Join-Path $dir 'state\page-link'
foreach ($i in 1..10) { if (Test-Path $link) { break }; Start-Sleep 1 }
if (Test-Path $link) { Write-Host "  from another device: $(Get-Content $link)" }
Write-Host "  log:        the gateway's console window (closing it stops the gateway)"
Write-Host "  commands:   $exe status | update | service uninstall"
Write-Host "  Windows Firewall may ask once: allow on private networks."
