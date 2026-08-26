# DARKROOM — RenderFlow -> pulse-webhook bridge
#
# RenderFlow's own "notify via webhook" only fires if it's manually checked
# on EVERY individual job in the Submitter (confirmed with Pulze support) --
# too easy to forget, which is why real completions silently stopped
# arriving days after initial testing. This script polls RenderFlow's own
# local REST API instead (GET /jobs) and re-posts any newly-completed job to
# our existing pulse-webhook Supabase Edge Function, which already knows how
# to parse it (project code from the file path, employee from user_id).
#
# Meant to be run every 1-2 minutes via Windows Task Scheduler (see setup
# notes at the bottom) -- NOT as a long-running loop. Each run checks once
# and exits, so a crash or a RenderFlow restart never leaves it permanently
# stuck.
#
# Dedup: a single "last synced" finished_at timestamp (last-synced.txt, one
# plain number), not a growing list of seen job ids. A first version tracked
# a JSON array of seen ids instead, and re-sent the same completed job on
# four consecutive one-minute runs before it aged out of RenderFlow's list --
# PowerShell's ConvertTo-Json silently drops the array brackets for a
# single-element array, so a state file written with exactly one entry reads
# back as a bare value next run, and something along that round-trip was
# never recognized as "already seen". A single timestamp has no such
# ambiguity: only send jobs finished strictly after the last run that
# actually advanced the watermark.
#
# This file lives in the repo as a reference copy with placeholder config --
# the real deployed copy (on the RenderFlow server, C:\DarkroomBridge\) has
# actual credentials filled in below and is NEVER committed anywhere.
#
# SETUP (one-time):
#   1. Copy this file to the RenderFlow server, e.g.
#      C:\DarkroomBridge\darkroom-renderflow-bridge.ps1
#   2. Fill in the three placeholder values below with real credentials.
#   3. Register a Task Scheduler task (see bottom of this file) that runs it
#      every 1-2 minutes.

# ==== CONFIG -- fill these in with real values on the deployed copy ====
$RF_BASE_URL      = "http://<renderflow-server-ip>:44442/api/v1"
$RF_API_KEY       = "<RenderFlow API key — Settings > API Keys>"
$BRIDGE_SECRET    = "<random secret, must match the BRIDGE_SECRET Edge Function secret in Supabase>"
$PULSE_WEBHOOK_URL = "https://gvwvvqiaggvopxsfyfsa.supabase.co/functions/v1/pulse-webhook"
# =========================================================================

$ScriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$StateFile  = Join-Path $ScriptDir "last-synced.txt"
$LogFile    = Join-Path $ScriptDir "bridge.log"

function Write-Log($message) {
    $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $message"
    Add-Content -Path $LogFile -Value $line
}

function Load-Watermark {
    if (Test-Path $StateFile) {
        $content = (Get-Content -Path $StateFile -Raw -ErrorAction SilentlyContinue)
        if ($content) {
            $trimmed = $content.Trim()
            $val = [int64]0
            if ([int64]::TryParse($trimmed, [ref]$val)) { return $val }
            Write-Log "WARN: state file content unreadable ('$trimmed'), treating as 0"
        }
    }
    return [int64]0
}

function Save-Watermark([int64]$ts) {
    Set-Content -Path $StateFile -Value $ts.ToString() -NoNewline
}

try {
    $lastSynced = Load-Watermark
    Write-Log "Starting run. lastSynced=$lastSynced"

    $jobs = Invoke-RestMethod -Uri "$RF_BASE_URL/jobs" `
        -Headers @{ "x-renderflow-api-key" = $RF_API_KEY } `
        -Method Get -TimeoutSec 20

    $maxFinished = $lastSynced
    $sentCount = 0

    foreach ($job in $jobs) {
        $isDone = $job.status -eq "completed" -or $job.status -match "fail|error"
        if (-not $isDone) { continue }
        if (-not $job.finished_at) { continue }
        if ($job.finished_at -le $lastSynced) { continue }

        $body = $job | ConvertTo-Json -Depth 30
        $postUrl = "$PULSE_WEBHOOK_URL`?secret=$BRIDGE_SECRET"

        try {
            $resp = Invoke-RestMethod -Uri $postUrl -Method Post -Body $body -ContentType "application/json" -TimeoutSec 20
            Write-Log "Sent job $($job.id) ($($job.name), status=$($job.status), finished_at=$($job.finished_at)) -> ok=$($resp.ok) employee_matched=$($resp.matchedEmployee) project=$($resp.projectCode)"
            $sentCount++
        } catch {
            Write-Log "ERROR posting job $($job.id) to pulse-webhook: $_"
            # Don't advance the watermark past this job -- retry on the next run.
            continue
        }

        if ($job.finished_at -gt $maxFinished) { $maxFinished = $job.finished_at }
    }

    if ($maxFinished -gt $lastSynced) {
        try {
            Save-Watermark $maxFinished
            Write-Log "Watermark advanced to $maxFinished"
        } catch {
            Write-Log "ERROR: could not save watermark (will likely re-send next run): $_"
        }
    }

    Write-Log "Run complete. Checked $($jobs.Count) jobs, sent $sentCount new notification(s)."
} catch {
    Write-Log "ERROR: bridge run failed: $_"
}

<#
=== Task Scheduler setup (run once) ===

1. Open Task Scheduler (search "Task Scheduler" in Start menu).
2. Action -> Create Task... (not "Basic Task", so we get the Triggers tab's
   repeat-every-N-minutes option).
3. General tab:
   - Name: "Darkroom RenderFlow Bridge"
   - Check "Run whether user is logged on or not"
4. Triggers tab -> New:
   - Begin the task: "On a schedule" -> Daily, starting now
   - Check "Repeat task every: 1 minute" -- "for a duration of: Indefinitely"
5. Actions tab -> New:
   - Action: "Start a program"
   - Program/script: powershell.exe
   - Add arguments:
       -NoProfile -ExecutionPolicy Bypass -File "C:\DarkroomBridge\darkroom-renderflow-bridge.ps1"
     (adjust the path to wherever you actually saved this file)
6. OK (do NOT set "Run with highest privileges" -- Register-ScheduledTask
   with -RunLevel Highest fails with "Access is denied" unless the
   registering PowerShell session is itself elevated, and this script
   doesn't need elevated rights anyway).
7. Right-click the new task -> Run, to test it once immediately.
   Check bridge.log next to this script for the result.
#>
