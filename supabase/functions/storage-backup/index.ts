// DARKROOM — Titanium OS: Storage backup (Phase 16)
//
// Supabase's Database Backups (Pro plan) explicitly do NOT cover Storage
// objects — only DB metadata about them ("Restoring an old backup does not
// restore objects that have been deleted since then"). Round images,
// project thumbnails, avatars, playbook images, and Dropbox receipts all
// live in Storage, so without this, an accidentally deleted/overwritten
// file would be gone for good even with database backups fully working.
//
// Deploy via Supabase Dashboard → Edge Functions → New function → name it
// "storage-backup" → paste this file's contents → Deploy → disable
// "Enforce JWT Verification" (called by Cron, not a browser client). Then
// set this secret: STORAGE_BACKUP_SECRET — any random string you choose,
// must match the header the Cron job sends.
//
// One-time setup this function depends on (see schema.sql's Phase 16 block,
// which also creates the storage-backups bucket, backup_state table, and
// the list_new_storage_objects() function this calls via .rpc() below —
// walking every bucket's folder tree with the Storage list() API doesn't
// scale here, round-images alone can hold thousands of per-round
// subfolders, so this reads storage.objects through that function instead
// of the Storage API):
//   1. Run schema.sql's Phase 16 SQL block once, in the SQL Editor.
//   2. Schedule it: Database → Cron Jobs (or Integrations → Cron) → New job
//      → HTTP request → this function's URL, POST, header
//      `x-storage-backup-secret: <same value>`, once a day.
//
// What it does, each run:
//  1. Reads the last-processed watermark (backup_state, one row).
//  2. Queries storage.objects for every row with created_at > watermark,
//     across every real bucket (excludes storage-backups itself), oldest
//     first, capped at 500 per run — plenty of headroom for a nightly job
//     at this studio's upload volume; any excess just gets picked up by
//     the next run via the watermark.
//  3. Downloads each one from its source bucket and re-uploads it into
//     storage-backups at "<original bucket>/<original path>", so a file
//     later deleted or overwritten in its live bucket still exists here.
//  4. Advances the watermark to the newest created_at it successfully
//     backed up. Stops at the first failure in a run rather than skipping
//     past it, so nothing after a transient error is silently missed —
//     the failed file (and everything after it) is simply retried in full
//     on the next run.
//
// This only ever adds copies — it doesn't track deletions or prune old
// backups, so storage-backups grows over time. That's the deliberate
// tradeoff for now: the goal is "nothing is ever unrecoverable", not
// "minimal storage cost". Revisit if the bucket size becomes a real cost.

import { createClient } from "jsr:@supabase/supabase-js@2";

const STORAGE_BACKUP_SECRET = Deno.env.get("STORAGE_BACKUP_SECRET") ?? "";
const BACKUP_BUCKET = "storage-backups";
const BATCH_LIMIT = 500;

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

function jsonResponse(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

interface StorageObjectRow {
  id: string;
  bucket_id: string;
  name: string;
  created_at: string;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return jsonResponse({ ok: false, error: "method not allowed" }, 405);
  }
  const providedSecret = req.headers.get("x-storage-backup-secret") ?? "";
  if (!STORAGE_BACKUP_SECRET || providedSecret !== STORAGE_BACKUP_SECRET) {
    return jsonResponse({ ok: false, error: "unauthorized" }, 401);
  }

  const { data: stateRow, error: stateError } = await supabase
    .from("backup_state").select("last_object_created_at").eq("id", 1).single();
  if (stateError) return jsonResponse({ ok: false, error: `backup_state read failed: ${stateError.message}` }, 500);
  const watermark: string = stateRow?.last_object_created_at ?? "1970-01-01T00:00:00Z";

  const { data: objects, error: listError } = await supabase
    .rpc("list_new_storage_objects", { after: watermark, limit_count: BATCH_LIMIT });
  if (listError) return jsonResponse({ ok: false, error: `list_new_storage_objects failed: ${listError.message}` }, 500);

  const rows = (objects ?? []) as StorageObjectRow[];
  let newWatermark = watermark;
  const results: Record<string, unknown>[] = [];

  for (const obj of rows) {
    try {
      const { data: fileBlob, error: downloadError } = await supabase.storage
        .from(obj.bucket_id).download(obj.name);
      if (downloadError) throw new Error(`download failed: ${downloadError.message}`);

      const bytes = new Uint8Array(await fileBlob.arrayBuffer());
      const targetPath = `${obj.bucket_id}/${obj.name}`;
      const { error: uploadError } = await supabase.storage
        .from(BACKUP_BUCKET)
        .upload(targetPath, bytes, { upsert: true, contentType: fileBlob.type || "application/octet-stream" });
      if (uploadError) throw new Error(`backup upload failed: ${uploadError.message}`);

      results.push({ bucket: obj.bucket_id, path: obj.name, ok: true });
      newWatermark = obj.created_at;
    } catch (e) {
      results.push({ bucket: obj.bucket_id, path: obj.name, ok: false, error: String(e) });
      // Don't advance past a failed file, and don't process anything after
      // it either — keeps the watermark a true "everything before this is
      // safely backed up" line, at the cost of retrying a few extra files
      // that may have actually been fine.
      break;
    }
  }

  if (newWatermark !== watermark) {
    const { error: saveError } = await supabase
      .from("backup_state").update({ last_object_created_at: newWatermark, updated_at: new Date().toISOString() }).eq("id", 1);
    if (saveError) results.push({ ok: false, error: `watermark save failed: ${saveError.message}` });
  }

  return jsonResponse({ ok: true, processed: results.length, remaining: rows.length === BATCH_LIMIT, watermark: newWatermark, results }, 200);
});
