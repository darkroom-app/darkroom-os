# Datacenter Render Watch

Watches `\\DATACENTER\Projekti\<code> - <name>\Renderi\<kadar>\` for new
`.jpg`/`.jpeg`/`.png` files and sends each new one to the app so a human can
quickly confirm it as a real round (Round/Rev) — reduces the "someone has to
remember to manually upload the render" step to "someone has to click
confirm once it's already there."

Deliberately keeps a human in the loop rather than auto-creating billable
rounds: a detected file becomes a `pending_renders` row + a notification to
the kadar's assigned artist (falling back to the project manager), and shows
up as a "🎬 render čeka potvrdu" badge on that kadar in the app's Projekti
detail page. Clicking it opens the normal round-add modal, prefilled with
the image — the person still picks Round vs. Rev and clicks the app's own
"Dodaj" button, exactly as if they'd uploaded it by hand.

Only applies to projects created after the `datacenter-folder-plan`
automation went live (2026-08-26) — the `Renderi\<kadar>\` folder-per-kadar
layout this depends on doesn't exist for older projects.

## How it fits together

1. **This script**, on the RenderFlow bridge machine, scans the folders and
   POSTs each new file (as base64 JSON) to the `render-ingest` Edge
   Function, authenticated with the same `DATACENTER_SYNC_SECRET` already
   used by `datacenter-folder-plan`.
2. **`render-ingest`** (`supabase/functions/render-ingest/index.ts`) looks
   up the project/kadar by code+name, uploads the image to the
   `pending-renders` Storage bucket, inserts a `pending_renders` row, and
   notifies the right person. Idempotent — re-sending an already-ingested
   file is a safe no-op.
3. **The app** (`darkroom-app.html`) shows the badge and, on confirm, does a
   completely normal round insert — this script and Edge Function never
   touch `rounds` directly.

See `supabase/schema.sql` (Phase 33) for the table/bucket/RLS.

## Setting it up on the bridge machine

1. Copy `darkroom-render-watch.ps1` next to `darkroom-datacenter-sync.ps1`
   (same machine, same folder is fine).
2. Open it and replace `REPLACE_WITH_DATACENTER_SYNC_SECRET` with the actual
   secret value (Supabase Dashboard → Edge Functions → `datacenter-folder-plan`
   → Manage secrets → `DATACENTER_SYNC_SECRET`).
3. Deploy the `render-ingest` Edge Function (Dashboard → Edge Functions →
   New function → name it `render-ingest` → paste
   `supabase/functions/render-ingest/index.ts` → Deploy → disable "Enforce
   JWT Verification"). It reuses `DATACENTER_SYNC_SECRET`,
   `SUPABASE_URL`, and `SUPABASE_SERVICE_ROLE_KEY` — all already set as
   secrets from earlier functions, nothing new to add there.
4. Run the Phase 33 block in `supabase/schema.sql` (SQL Editor) — creates
   `pending_renders`, the `pending-renders` Storage bucket, and updates
   `notify_discord()` to skip this notification kind (same as
   kadar/round/approved/cancelled — stays in the app's own bell, doesn't
   spam Discord).
5. Add a second Windows Task Scheduler job (alongside the existing
   datacenter-folder-plan one) running `darkroom-render-watch.ps1` every
   10-15 minutes.

`render-watch-seen.json` (created next to the script on first run) is a
local cache of already-sent files — purely a speed optimization so the
script doesn't re-read-and-re-upload every file on every run as the archive
grows. Safe to delete: worst case is a one-time re-scan where already-known
files get resent and harmlessly skipped server-side (render-ingest is
idempotent on kadar+filename), never duplicated.
