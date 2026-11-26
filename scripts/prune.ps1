# Remove worktrees + local branches whose work is already on main (#61), then Docker
# leftovers machine-wide (dangling images, anonymous volumes, stopped testcontainers, old
# emulator tags, build cache > 7 days, managed Jellyfin projects whose folder is gone).
#
#   powershell -File scripts/prune.ps1           # prune
#   powershell -File scripts/prune.ps1 -DryRun   # only list what would go
#
# A branch goes only if it is (a) 0 commits beyond origin/main, or (b) its merged PR's
# head == the branch tip (PRs are squash-merged, so `git branch --merged` can't tell),
# AND its worktree (if any) has no uncommitted changes. Everything else is skipped with
# the reason. Never touches main, the main checkout, the current checkout, or remotes.
# No --force anywhere: git refuses locked / in-use worktrees, which protects live threads.
param([switch]$DryRun)
$ErrorActionPreference = 'Continue'  # PS 5.1: 'Stop' turns git/gh stderr into exceptions; exit codes are checked instead

$main = ((git worktree list --porcelain | Select-Object -First 1) -replace '^worktree ', '')
$here = (git rev-parse --show-toplevel)
Set-Location $main
git fetch --prune -q
if ($LASTEXITCODE -ne 0) { throw 'git fetch failed' }
# Drops registrations whose folder is gone, else `git branch -D` refuses those branches.
if (-not $DryRun) { git worktree prune }

# branch -> worktree path; a registered folder that no longer exists counts as no worktree
$paths = @{}
$wt = $null
foreach ($line in git worktree list --porcelain) {
    if ($line -like 'worktree *') { $wt = $line.Substring(9) }
    elseif ($line -like 'branch refs/heads/*' -and (Test-Path $wt)) { $paths[$line.Substring(18)] = $wt }
}

$pruned = 0
foreach ($b in git for-each-ref --format='%(refname:short)' refs/heads/) {
    if ($b -eq 'main') { continue }
    $path = $paths[$b]
    if ($path -eq $main -or $path -eq $here) { Write-Host "skip  $b (checked out here)"; continue }

    $tip = git rev-parse $b
    $why = $null
    if ((git rev-list --count "origin/main..$b") -eq '0') {
        $why = 'no commits beyond main'
    } else {
        $prs = @(gh pr list --head $b --state merged --json number,headRefOid | ConvertFrom-Json)
        if ($LASTEXITCODE -ne 0) { Write-Host "skip  $b (gh pr list failed)" -ForegroundColor Yellow; continue }
        $pr = $prs | Where-Object { $_.headRefOid -eq $tip } | Select-Object -First 1
        if ($pr) { $why = "merged #$($pr.number)" }
        elseif ($prs) { Write-Host "skip  $b (tip != merged PR head)" -ForegroundColor Yellow; continue }
        else { Write-Host "skip  $b (unmerged)" -ForegroundColor Yellow; continue }
    }

    if ($path) {
        if (git -C $path status --porcelain) { Write-Host "skip  $b (dirty: $path)" -ForegroundColor Yellow; continue }
    }

    if ($DryRun) { Write-Host "would prune  $b ($why)$(if ($path) { " + $path" })"; continue }

    if ($path) {
        # A running preview (#135) holds files + ports in the worktree: stop it first.
        if (Test-Path "$path/e2e/.preview/state.json") { node "$path/e2e/preview.ts" down }
        $out = git worktree remove $path 2>&1
        if ($LASTEXITCODE -ne 0) { Write-Host "skip  $b (removal failed: $out)" -ForegroundColor Yellow; continue }
    }
    git branch -D $b *> $null
    if ($LASTEXITCODE -ne 0) { Write-Host "skip  $b (branch -D failed)" -ForegroundColor Yellow; continue }
    Write-Host "pruned  $b ($why)$(if ($path) { " + $path" })" -ForegroundColor Green
    $pruned++
}
if (-not $DryRun) { Write-Host "$pruned pruned." }

# Docker, machine-wide. No --force on anything in use: Docker refuses running containers and
# the images and volumes they hold, which protects a live preview or e2e run elsewhere.
docker info *> $null
if ($LASTEXITCODE -ne 0) { Write-Host 'Docker not running: Docker part skipped.' -ForegroundColor Yellow; exit 0 }
Write-Host "`nDocker before:"; docker system df

# Same hash as scripts/test-api.sh, apitest and e2e/stack.ts.
$bytes = [IO.File]::ReadAllBytes("$main/dev/firebase/Dockerfile") + [IO.File]::ReadAllBytes("$main/dev/firebase/firebase.json")
$hash = [Security.Cryptography.SHA256]::Create().ComputeHash([byte[]]$bytes)
$current = 'streamiq-firebase-emulator:' + (-join ($hash | ForEach-Object { $_.ToString('x2') })).Substring(0, 12)
$oldTags = @(docker images streamiq-firebase-emulator --format '{{.Repository}}:{{.Tag}}' | Where-Object { $_ -ne $current })

# managed-Jellyfin compose project -> working_dir
$projects = @{}
# inspect, not --format with quoted label keys: PS 5.1 strips the quotes from native args
$ids = @(docker ps -aq --filter label=com.docker.compose.project)
if ($ids) {
    $containers = (docker inspect $ids) -join "`n" | ConvertFrom-Json  # PS 5.1 emits the array as one item
    foreach ($c in $containers) {
        $name = $c.Config.Labels.'com.docker.compose.project'
        if ($name -like 'streamiq-jellyfin-*') { $projects[$name] = $c.Config.Labels.'com.docker.compose.project.working_dir' }
    }
}
$gone = @($projects.Keys | Where-Object { -not (Test-Path $projects[$_]) })
foreach ($p in $projects.Keys | Where-Object { $gone -notcontains $_ }) {
    Write-Host "keep  $p ($($projects[$p]) exists; stop it: docker compose -p $p down)"
}

if ($DryRun) {
    Write-Host 'would remove:'
    Write-Host "  $(@(docker images -q -f dangling=true).Count) dangling images"
    Write-Host "  $(@(docker volume ls -q -f dangling=true -f label=com.docker.volume.anonymous).Count) unused anonymous volumes"
    Write-Host "  $(@(docker ps -aq -f label=org.testcontainers=true -f status=exited -f status=created -f status=dead).Count) stopped testcontainers"
    Write-Host '  build cache unused for 7+ days (no dry-run count; Build Cache above is the ceiling)'
    foreach ($t in $oldTags) { Write-Host "  image $t (current: $current)" }
    foreach ($p in $gone) { Write-Host "  compose project $p ($($projects[$p]) is gone)" }
    exit 0
}

# Order matters: what the downs and rmis leave behind is pruned by the steps after them.
foreach ($p in $gone) { docker compose -p $p down -v }
docker container prune -f --filter label=org.testcontainers=true
if ($oldTags) { docker rmi $oldTags }
docker image prune -f
docker volume prune -f
docker builder prune -f --filter until=168h
Write-Host "`nDocker after:"; docker system df
