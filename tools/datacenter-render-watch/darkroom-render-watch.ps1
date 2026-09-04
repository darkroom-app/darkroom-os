# DARKROOM OS: render watcher (Phase 33)
#
# Runs on the RenderFlow bridge machine — the same machine (and the same
# trust boundary) as darkroom-datacenter-sync.ps1 — via a second Windows
# Task Scheduler job on a recurring interval (10-15 min is reasonable).
#
# Watches "\\DATACENTER\Projekti\<code> - <name>\Renderi\<kadar>\" for new
# .jpg/.jpeg/.png files (that folder layout is exactly what the
# datacenter-folder-plan sync already creates, so this only ever finds
# anything for projects created after that automation went live) and POSTs
# each new one to the render-ingest Edge Function, which uploads it to
# Supabase Storage and queues it as a "pending render" in the app — a human
# still confirms Round vs Rev before it becomes a real, billable round.
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
$FunctionUrl = "https://gvwvvqiaggvopxsfyfsa.supabase.co/functions/v1/render-ingest"
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

$projectFolders = Get-ChildItem -Path $RootPath -Directory -ErrorAction SilentlyContinue
foreach ($projFolder in $projectFolders) {
    # Folder name is "<CODE> - <ime projekta>" (datacenter-folder-plan's own
    # convention) — the code is always the part before the first " - ".
    $projectCode = ($projFolder.Name -split ' - ', 2)[0].Trim()
    if ($projectCode -notmatch '^P\d{4}$') { continue }

    $renderiPath = Join-Path $projFolder.FullName "Renderi"
    if (-not (Test-Path $renderiPath)) { continue }

    $kadarFolders = Get-ChildItem -Path $renderiPath -Directory -ErrorAction SilentlyContinue
    foreach ($kadarFolder in $kadarFolders) {
        $kadarName = $kadarFolder.Name
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
                    Uri         = $FunctionUrl
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
                # Ne dodajemo u $seen — pokušaće ponovo sledeći put.
            }
        }
    }
}

$seen | ConvertTo-Json -Depth 3 | Set-Content -Path $StateFile -Encoding utf8
