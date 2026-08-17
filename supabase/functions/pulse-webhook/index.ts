// DARKROOM — Titanium OS: Phase 1 backend (RenderFlow render-finished notifications)
//
// Deploy via Supabase Dashboard → Edge Functions → New function → name it
// "pulse-webhook" → paste this file's contents → Deploy. Then set the
// WEBHOOK_SECRET secret (Edge Functions → Manage secrets) to the value
// given separately — never commit that value to this repo.
//
// RenderFlow's "Add Integration" dialog only has Type/Name/Webhook URL —
// no custom-header field — so the secret is passed as a query param on the
// URL instead of a header (the header check is kept too, in case a future
// caller can send one):
//   POST /functions/v1/pulse-webhook?secret=<shared secret>
//
// DISCOVERY MODE: RenderFlow's exact webhook JSON shape isn't documented
// (docs only say "sends a JSON payload with all job details"). Until we've
// seen one real payload, this function is deliberately permissive: it tries
// several plausible field names/paths for each value, and — critically —
// still inserts the row (with a placeholder recipient if none is found)
// rather than rejecting, so raw_payload always captures what really arrived
// for inspection. Tighten the field-guessing once the real shape is known.

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

// Reads a dotted path ("job.user.name") out of a nested object, if present.
function pick(obj: unknown, paths: string[]): string | null {
  for (const path of paths) {
    let cur: unknown = obj;
    for (const key of path.split(".")) {
      if (cur == null || typeof cur !== "object") { cur = undefined; break; }
      cur = (cur as Record<string, unknown>)[key];
    }
    if (typeof cur === "string" && cur.trim()) return cur;
  }
  return null;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return jsonResponse({ ok: false, error: "method not allowed" }, 405);
  }

  const url = new URL(req.url);
  const providedSecret = req.headers.get("x-webhook-secret") ?? url.searchParams.get("secret") ?? "";
  if (!WEBHOOK_SECRET || providedSecret !== WEBHOOK_SECRET) {
    return jsonResponse({ ok: false, error: "unauthorized" }, 401);
  }

  let payload: Record<string, unknown>;
  try {
    payload = await req.json();
  } catch {
    return jsonResponse({ ok: false, error: "invalid json" }, 400);
  }

  // Best-effort guesses across a few plausible RenderFlow shapes — refine
  // once a real payload has been inspected (see raw_payload on the row).
  const employee = pick(payload, [
    "employee", "user", "user.name", "submittedBy", "submitted_by",
    "owner", "owner.name", "artist", "job.user", "job.user.name",
    "job.owner", "job.submittedBy",
  ]) ?? "UNKNOWN_SUBMITTER";
  const projectCode = pick(payload, ["projectCode", "project_code", "job.projectCode"]);
  const taskName = pick(payload, ["taskName", "task_name", "name", "job.name", "file", "job.file"]);
  const status = pick(payload, ["status", "job.status", "event"]);

  // Placeholder mapping — expected to change once real RenderFlow status values are known.
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

  return jsonResponse({ ok: true, id: data.id, matchedEmployee: employee !== "UNKNOWN_SUBMITTER" }, 200);
});
