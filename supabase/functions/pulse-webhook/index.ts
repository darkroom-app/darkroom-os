// DARKROOM — Titanium OS: Phase 1 backend (Pulse render-finished notifications)
//
// Deploy via Supabase Dashboard → Edge Functions → New function → name it
// "pulse-webhook" → paste this file's contents → Deploy. Then set the
// WEBHOOK_SECRET secret (Edge Functions → Manage secrets) to the value
// given separately — never commit that value to this repo.
//
// Generic contract, adapt once real Pulse webhook docs are available:
//   POST /functions/v1/pulse-webhook
//   Headers: x-webhook-secret: <shared secret>, content-type: application/json
//   Body: { "projectCode": "P007", "taskName": "Enterijer_04 – Round 03",
//           "employee": "Dušan Stević", "status": "completed" }

import { createClient } from "jsr:@supabase/supabase-js@2";

const WEBHOOK_SECRET = Deno.env.get("WEBHOOK_SECRET") ?? "";
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are auto-injected by the Supabase
// Edge Functions runtime — no need to set them as custom secrets.
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

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return jsonResponse({ ok: false, error: "method not allowed" }, 405);
  }

  const providedSecret = req.headers.get("x-webhook-secret") ?? "";
  if (!WEBHOOK_SECRET || providedSecret !== WEBHOOK_SECRET) {
    return jsonResponse({ ok: false, error: "unauthorized" }, 401);
  }

  let payload: Record<string, unknown>;
  try {
    payload = await req.json();
  } catch {
    return jsonResponse({ ok: false, error: "invalid json" }, 400);
  }

  const employee = typeof payload.employee === "string" ? payload.employee : "";
  if (!employee) {
    return jsonResponse({ ok: false, error: "employee is required" }, 400);
  }

  const projectCode = typeof payload.projectCode === "string" ? payload.projectCode : null;
  const taskName = typeof payload.taskName === "string" ? payload.taskName : null;
  const status = typeof payload.status === "string" ? payload.status : null;

  // Placeholder mapping — expected to change once real Pulse status values are known.
  const isFailure = !!status && /fail|error/i.test(status);
  const kind = isFailure ? "render-warning" : "render-done";
  const taskLabel = taskName ?? "render";
  const projectLabel = projectCode ? ` (${projectCode})` : "";
  const text = isFailure
    ? `⚠ Render "${taskLabel}" nije uspeo${projectLabel}`
    : `✅ Render "${taskLabel}" je završen${projectLabel}`;

  const { data, error } = await supabase
    .from("notifications")
    .insert({
      recipient_name: employee,
      kind,
      text,
      project_code: projectCode,
      task_name: taskName,
      status,
      raw_payload: payload,
    })
    .select("id")
    .single();

  if (error) {
    return jsonResponse({ ok: false, error: error.message }, 500);
  }

  return jsonResponse({ ok: true, id: data.id }, 200);
});
