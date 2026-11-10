# Remove worktrees + local branches whose work is already on main (#61).
#
#   powershell -File scripts/prune-worktrees.ps1           # prune
#   powershell -File scripts/prune-worktrees.ps1 -DryRun   # only list what would go
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

# branch -> worktree path
$paths = @{}
$wt = $null
foreach ($line in git worktree list --porcelain) {
    if ($line -like 'worktree *') { $wt = $line.Substring(9) }
    elseif ($line -like 'branch refs/heads/*') { $paths[$line.Substring(18)] = $wt }
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
git worktree prune
if (-not $DryRun) { Write-Host "$pruned pruned." }
