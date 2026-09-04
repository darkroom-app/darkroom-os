# DARKROOM OS: render watcher (Phase 33)
#
# Runs on the RenderFlow bridge machine — the same machine (and the same
# trust boundary) as darkroom-datacenter-sync.ps1 — via a second Windows
# Task Scheduler job on a recurring interval (10-15 min is reasonable).
#
# Watches "\\DATACENTER\Projekti\<code> - <name>\Renderi\<kadar>\" for new
# .jpg/.jpeg/.png files and POSTs each new one to the render-ingest Edge
# Function, which uploads it to Supabase Storage and queues it as a
# "pending render" in the app — a human still confirms Round vs Rev before
# it becomes a real, billable round.
#
# Scope is taken directly from datacenter-folder-plan's own GET response
# (the exact same endpoint darkroom-datacenter-sync.ps1 already calls to
# know which folders to create) instead of re-deriving it locally — that
# response already only lists projects at/after SYNC_CUTOFF, and its
# kadarFolders array is the exact set of real kadar names for each project.
# An earlier version of this script scanned every "P####" folder under
# \\DATACENTER\Projekti\ directly, with no cutoff check at all — for a much
# older project whose legacy on-disk folder names happened to exactly match
# real kadar names in the database (pure coincidence, not the new
# convention), that uploaded real files and created real pending_renders
# rows for a project that was never supposed to be in scope. Reusing the
# plan endpoint's own project list closes that gap: nothing outside it is
# ever looked at, regardless of what happens to sit on disk.
#
# State file (render-watch-seen.json, next to this script) is a plain list
# of full file paths already sent — purely a local optimization so a file
# already delivered isn't re-read-and-re-uploaded on every run as the
# archive grows into thousands of files. It is NOT the source of truth for
# "already ingested" — render-ingest itself is idempotent (unique on
# kadar+filename), so losing this file just means some files get harmlessly
# re-sent and skipped server-side, never duplicated.

$ErrorActionPreference = "Stop"

$RootPath = "\\DATACENTER\Projekti"
$PlanUrl = "https://gvwvvqiaggvopxsfyfsa.supabase.co/functions/v1/datacenter-folder-plan"
$IngestUrl = "https://gvwvvqiaggvopxsfyfsa.supabase.co/functions/v1/render-ingest"
# Same secret already set as DATACENTER_SYNC_SECRET for datacenter-folder-plan
# — one secret for the whole bridge machine, not a new one per script.
$SyncSecret = "REPLACE_WITH_DATACENTER_SYNC_SECRET"
$StateFile = Join-Path $PSScriptRoot "render-watch-seen.json"
$AllowedExtensions = @(".jpg", ".jpeg", ".png")

$seen = @{}
if (Test-Path $StateFile) {
    try {
        $loaded = Get-Content $StateFile -Raw | ConvertFrom-Json
        foreach ($prop in $loaded.PSObject.Properties) { $seen[$prop.Name] = $true }
    } catch {
        Write-Warning "Ne mogu da ucitam $StateFile - nastavljam kao da je prazan (server je i dalje idempotentan)."
    }
}

# Scope check FIRST, before touching any file on disk — if this fails for
# any reason, stop entirely rather than falling back to scanning everything.
$planResponse = Invoke-RestMethod -Uri $PlanUrl -Method Get -Headers @{ "x-datacenter-sync-secret" = $SyncSecret }
if (-not $planResponse.ok) {
    Write-Error "datacenter-folder-plan je vratio gresku: $($planResponse.error)"
    exit 1
}

# folderName -> Set(kadarFolders) — both taken verbatim from the plan, not
# derived locally, so this can never drift from what datacenter-folder-plan
# itself considers in-scope.
$validProjects = @{}
foreach ($p in $planResponse.projects) {
    $kadarSet = @{}
    foreach ($kf in $p.kadarFolders) { $kadarSet[$kf] = $true }
    $validProjects[$p.folderName] = $kadarSet
}
Write-Output "U opsegu (posle cutoff-a): $($validProjects.Count) projekata."

$projectFolders = Get-ChildItem -Path $RootPath -Directory -ErrorAction SilentlyContinue
foreach ($projFolder in $projectFolders) {
    if (-not $validProjects.ContainsKey($projFolder.Name)) { continue }
    $projectCode = ($projFolder.Name -split ' - ', 2)[0].Trim()
    $validKadarFolders = $validProjects[$projFolder.Name]

    $renderiPath = Join-Path $projFolder.FullName "Renderi"
    if (-not (Test-Path $renderiPath)) { continue }

    $kadarFolders = Get-ChildItem -Path $renderiPath -Directory -ErrorAction SilentlyContinue
    foreach ($kadarFolder in $kadarFolders) {
        $kadarName = $kadarFolder.Name
        # Extra safety on top of the project-level check: only a folder
        # name the plan itself listed as a real kadar for this project.
        if (-not $validKadarFolders.ContainsKey($kadarName)) { continue }

        $files = Get-ChildItem -Path $kadarFolder.FullName -File -ErrorAction SilentlyContinue |
            Where-Object { $AllowedExtensions -contains $_.Extension.ToLower() }

        foreach ($file in $files) {
            $key = $file.FullName
            if ($seen.ContainsKey($key)) { continue }

            try {
                $bytes = [System.IO.File]::ReadAllBytes($file.FullName)
                $base64 = [Convert]::ToBase64String($bytes)
                $bodyObj = @{
                    projectCode = $projectCode
                    kadarName   = $kadarName
                    fileName    = $file.Name
                    imageBase64 = $base64
                }
                $body = $bodyObj | ConvertTo-Json -Compress

                $restArgs = @{
                    Uri         = $IngestUrl
                    Method      = "Post"
                    Headers     = @{ "x-datacenter-sync-secret" = $SyncSecret }
                    ContentType = "application/json"
                    Body        = $body
                }
                $response = Invoke-RestMethod @restArgs

                if ($response.ok) {
                    $seen[$key] = $true
                    Write-Output "OK: $key"
                } else {
                    Write-Warning "Server je odbio $key : $($response.error)"
                }
            } catch {
                Write-Warning "Slanje nije uspelo za $key : $($_.Exception.Message)"
                # Ne dodajemo u $seen — pokusace ponovo sledeci put.
            }
        }
    }
}

$seen | ConvertTo-Json -Depth 3 | Set-Content -Path $StateFile -Encoding utf8
