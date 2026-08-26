# DARKROOM — Datacenter folder sync
#
# Creates the standard folder skeleton for every project on
# \\DATACENTER\Projekti\ so a PM never has to manually create it by hand
# when a project (or a new enterijer/eksterijer/aerial kadar) is added in
# the app: Max, Info, Renderi at the project root, and one folder named
# after each such kadar (e.g. "01 Living Room") under BOTH Max\ and
# Renderi\.
#
# HARD RULE, never to be relaxed: this script is ONLY ever allowed to
# create folders. It must never call Remove-Item, Move-Item, Rename-Item,
# or overwrite the contents of anything that already exists — real render
# output and client deliverables live on this disk, and a bug in a
# "helpful" automation script is exactly the kind of thing that could
# silently destroy irreplaceable work. New-Item -Force on a directory that
# already exists is a safe no-op (it does not touch the directory's
# existing contents), which is the only reason it's used here at all.
#
# If a project is renamed in the app after its folder already exists on
# disk, this script does NOT rename the old folder to match — it just
# leaves it as-is and flags it (see the mismatch check at the bottom):
# every run compares the actual top-level folder names under
# \\DATACENTER\Projekti against the plan's expected names and logs any
# that don't match anything current, so a stale/renamed project doesn't
# just sit there silently drifting unnoticed.
#
# All the naming logic (which kadar types get a folder, what it's named)
# lives in the datacenter-folder-plan Edge Function, not here — this
# script's only job is to turn whatever that function returns into
# folders on disk.
#
# Runs as a full scan every time, not incremental — there's no state file
# to get corrupted or drift out of sync, and it's cheap enough at this
# studio's project count. This also makes it self-healing: if a folder is
# ever missing for any reason, the very next run just recreates it.
#
# The datacenter itself is a NAS/share with no way to run a script on it,
# so this runs from the same machine as the RenderFlow bridge
# (darkroom-renderflow-bridge.ps1) — that machine already has network
# access to \\DATACENTER\Projekti and already has a Task Scheduler set up
# on it, so this is just a second, independent scheduled task there, not
# a new machine.
#
# SETUP (one-time):
#   1. Copy this file onto the RenderFlow bridge machine, alongside (but
#      as a separate file from) darkroom-renderflow-bridge.ps1 — e.g.
#      C:\DarkroomBridge\darkroom-datacenter-sync.ps1
#   2. Fill in the placeholder secret below.
#   3. Register a second Task Scheduler task (see bottom of this file) —
#      this is unrelated to the RenderFlow bridge's own task and runs on
#      its own schedule.
#
# This file contains a real secret once filled in — keep it on this
# machine only, never commit it anywhere.

# ==== CONFIG — fill this in ====
$PROJECTS_ROOT          = "\\DATACENTER\Projekti"
$DATACENTER_SYNC_SECRET = "<random secret — must match DATACENTER_SYNC_SECRET in Supabase>"
$PLAN_URL               = "https://gvwvvqiaggvopxsfyfsa.supabase.co/functions/v1/datacenter-folder-plan"
# =================================

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$LogFile   = Join-Path $ScriptDir "sync.log"

function Write-Log($message) {
    $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $message"
    Add-Content -Path $LogFile -Value $line
}

# Safe by construction: only ever creates. Never deletes, moves, renames,
# or overwrites anything that already exists at $path.
function Ensure-Folder($path) {
    if (-not (Test-Path -LiteralPath $path)) {
        New-Item -ItemType Directory -Path $path -Force | Out-Null
        Write-Log "Created: $path"
    }
}

try {
    $plan = Invoke-RestMethod -Uri $PLAN_URL `
        -Headers @{ "x-datacenter-sync-secret" = $DATACENTER_SYNC_SECRET } `
        -Method Get -TimeoutSec 30

    if (-not $plan.ok) {
        Write-Log "ERROR: plan fetch returned ok=false: $($plan.error)"
        exit
    }

    foreach ($p in $plan.projects) {
        $root = Join-Path $PROJECTS_ROOT $p.folderName
        Ensure-Folder $root
        foreach ($sub in $p.rootSubfolders) { Ensure-Folder (Join-Path $root $sub) }
        foreach ($sub in $p.kadarFolders) {
            Ensure-Folder (Join-Path $root "Max\$sub")
            Ensure-Folder (Join-Path $root "Renderi\$sub")
        }
    }

    # Drift check: any top-level folder on disk that doesn't match a
    # current project name is either a renamed project (app-side rename,
    # folder never followed) or something manually created — either way,
    # worth a human glancing at rather than silently accumulating.
    # Read-only — this never acts on what it finds.
    $expectedNames = $plan.projects | ForEach-Object { $_.folderName }
    $existingDirs = Get-ChildItem -LiteralPath $PROJECTS_ROOT -Directory -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name
    $unmatched = $existingDirs | Where-Object { $expectedNames -notcontains $_ }
    if ($unmatched -and $unmatched.Count -gt 0) {
        Write-Log "MISMATCH: $($unmatched.Count) folder(s) on disk don't match any current project name: $($unmatched -join ', ')"
    }

    Write-Log "Run complete. Checked $($plan.projects.Count) projects."
} catch {
    Write-Log "ERROR: sync run failed: $_"
}

<#
=== Task Scheduler setup (run once) ===

1. Open Task Scheduler on the RenderFlow bridge machine (the one already
   running "Darkroom RenderFlow Bridge") -- this is a second, separate
   task on that same machine, not a new server.
2. Action -> Create Task... (not "Basic Task").
3. General tab:
   - Name: "Darkroom Datacenter Folder Sync"
   - Check "Run whether user is logged on or not"
   - Run as an account that has write access to \\DATACENTER\Projekti.
4. Triggers tab -> New:
   - Begin the task: "On a schedule" -> Daily, starting now
   - Check "Repeat task every: 1 hour" -- "for a duration of: Indefinitely"
     (or just once a day if that's fast enough — this isn't time-critical
     the way render notifications are)
5. Actions tab -> New:
   - Action: "Start a program"
   - Program/script: powershell.exe
   - Add arguments:
       -NoProfile -ExecutionPolicy Bypass -File "C:\DarkroomBridge\darkroom-datacenter-sync.ps1"
     (adjust the path to wherever you actually saved this file)
6. OK. Do NOT set "Run with highest privileges" unless the account that
   creates folders on the share actually needs elevation (normally a
   regular account with write access to that share is enough).
7. Right-click the new task -> Run, to test it once immediately.
   Check sync.log next to this script for what it created.
#>
