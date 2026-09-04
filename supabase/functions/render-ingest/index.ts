// DARKROOM OS: render-ingest (Phase 33)
//
// Deploy via Supabase Dashboard → Edge Functions → New function → name it
// "render-ingest" → paste this file's contents → Deploy → disable "Enforce
// JWT Verification" (called by a script on the RenderFlow bridge machine,
// not a logged-in browser client). Reuses the same DATACENTER_SYNC_SECRET
// already set for datacenter-folder-plan — same trust boundary, same
// machine, one secret instead of two.
//
// POST body: { projectCode: string, kadarName: string, fileName: string,
//              imageBase64: string (raw base64, no "data:image/..." prefix) }
//
// Idempotent by design: (kadar_id, file_name) is unique in pending_renders,
// so the bridge script can safely re-scan/retry without creating duplicate
// rows or duplicate notifications — a second POST for an already-ingested
// file just returns {ok:true, skipped:true}.
//
// Deliberately narrow: only creates a *pending* row + a notification. Never
// touches `rounds` directly — a human still opens the app's existing
// round-add modal (prefilled with this image) and picks Round/Rev before it
// becomes a real, billable round. See schema.sql Phase 33 for why.

import { createClient } from "jsr:@supabase/supabase-js@2";

const DATACENTER_SYNC_SECRET = Deno.env.get("DATACENTER_SYNC_SECRET") ?? "";

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

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

const EXT_CONTENT_TYPE: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
};

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return jsonResponse({ ok: false, error: "method not allowed" }, 405);
  }
  const providedSecret = req.headers.get("x-datacenter-sync-secret") ?? "";
  if (!DATACENTER_SYNC_SECRET || providedSecret !== DATACENTER_SYNC_SECRET) {
    return jsonResponse({ ok: false, error: "unauthorized" }, 401);
  }

  let body: { projectCode?: string; kadarName?: string; fileName?: string; imageBase64?: string };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ ok: false, error: "invalid json" }, 400);
  }
  const { projectCode, kadarName, fileName, imageBase64 } = body;
  if (!projectCode || !kadarName || !fileName || !imageBase64) {
    return jsonResponse({ ok: false, error: "nedostaje projectCode/kadarName/fileName/imageBase64" }, 400);
  }
  const ext = (fileName.split(".").pop() ?? "").toLowerCase();
  const contentType = EXT_CONTENT_TYPE[ext];
  if (!contentType) {
    return jsonResponse({ ok: false, error: `nepodržan format fajla: .${ext} (samo jpg/jpeg/png)` }, 400);
  }

  const { data: project, error: projError } = await supabase
    .from("projects").select("id, name, team_members(name)").eq("code", projectCode).maybeSingle();
  if (projError) return jsonResponse({ ok: false, error: projError.message }, 500);
  if (!project) return jsonResponse({ ok: false, error: `Projekat '${projectCode}' nije pronađen.` }, 404);

  const { data: kadar, error: kadError } = await supabase
    .from("kadrovi").select("id, team_members(name)")
    .eq("project_id", project.id).eq("name", kadarName).maybeSingle();
  if (kadError) return jsonResponse({ ok: false, error: kadError.message }, 500);
  if (!kadar) return jsonResponse({ ok: false, error: `Kadar '${kadarName}' nije pronađen u projektu '${projectCode}'.` }, 404);

  // Idempotent: an already-ingested file for this kadar is skipped, not
  // re-uploaded/re-notified — safe for the bridge script to re-scan/retry.
  const { data: existing } = await supabase
    .from("pending_renders").select("id").eq("kadar_id", kadar.id).eq("file_name", fileName).maybeSingle();
  if (existing) return jsonResponse({ ok: true, skipped: true, reason: "already ingested" }, 200);

  const storagePath = `${kadar.id}/${crypto.randomUUID()}-${fileName}`;
  const { error: uploadError } = await supabase.storage
    .from("pending-renders")
    .upload(storagePath, base64ToBytes(imageBase64), { contentType, upsert: false });
  if (uploadError) return jsonResponse({ ok: false, error: `upload nije uspeo: ${uploadError.message}` }, 500);

  const { data: urlData } = supabase.storage.from("pending-renders").getPublicUrl(storagePath);

  const { error: insertError } = await supabase
    .from("pending_renders")
    .insert({ kadar_id: kadar.id, file_name: fileName, image_url: urlData.publicUrl });
  if (insertError) return jsonResponse({ ok: false, error: insertError.message }, 500);

  // deno-lint-ignore no-explicit-any
  const managerName = (project as any).team_members?.name ?? null;
  // deno-lint-ignore no-explicit-any
  const recipientName = (kadar as any).team_members?.name ?? managerName;
  if (recipientName) {
    await supabase.from("notifications").insert({
      recipient_name: recipientName,
      kind: "render_pending",
      text: `Novi render detektovan za kadar "${kadarName}" u projektu ${project.name} — potvrdi da li je runda ili revizija.`,
      project_code: projectCode,
    });
  }

  return jsonResponse({ ok: true }, 200);
});
