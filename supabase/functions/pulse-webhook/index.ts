// DARKROOM — Titanium OS: Phase 1 backend (RenderFlow render-finished notifications)
//
// Deploy via Supabase Dashboard → Edge Functions → pulse-webhook → Code tab →
// replace all content with this file → Deploy. WEBHOOK_SECRET must already be
// set (Edge Functions → Manage secrets) — never commit that value to this repo.
//
// RenderFlow's "Add Integration" dialog only has Type/Name/Webhook URL — no
// custom-header field — so the secret is passed as a query param on the URL
// instead of a header (header check kept too, in case a future caller can
// send one):
//   POST /functions/v1/pulse-webhook?secret=<shared secret>
//
// Phase 1b: RenderFlow's per-job "notify via webhook" checkbox (set in its
// Submitter, per job, every time — confirmed with Pulze support) turned out
// to be far too easy to forget, so real completions stopped arriving days
// after initial testing. A local script on the RenderFlow server now polls
// RenderFlow's own REST API (GET /jobs) instead and re-posts each newly
// completed job here — same endpoint, same parsing, just a second caller.
// It authenticates with its own separate BRIDGE_SECRET (not WEBHOOK_SECRET)
// so the two credentials can be rotated independently — this one lives on a
// shared studio machine, so it's scoped as narrowly as WEBHOOK_SECRET always
// was rather than reusing it.
//
// Confirmed from a real "job-completed" payload: RenderFlow does NOT include
// the submitter's name/email — only an internal `user_id` (its own Mongo-style
// id). That id is resolved to a real person via team_members.renderflow_user_id
// (populated once by hand from RenderFlow's GET /api/v1/users "alias" field —
// see supabase/schema.sql "Phase 2.1"). The job/task name is at root `name`;
// status at root `status`.
//
// There's no discrete project-code field either, but a real payload shows the
// studio's network render paths are consistent:
//   \\DATACENTER\Projekti\P0288 - 55 Deans\Renderi\...
//   \\DATACENTER\Projekti\P0288 - 55 Deans\Max\...
// found in steps[].props[].value.path / .original_path (Scene File / Render
// Output props). extractProjectCode() pulls the "P####" segment straight out
// of the folder name right after "Projekti\", so kind of render notifications
// can land in the right project's own Discord channel (projects.discord_webhook_url,
// Phase 3f) instead of only the general fallback channel.

import { createClient } from "jsr:@supabase/supabase-js@2";

const WEBHOOK_SECRET = Deno.env.get("WEBHOOK_SECRET") ?? "";
const BRIDGE_SECRET = Deno.env.get("BRIDGE_SECRET") ?? "";
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

// Walks every step's props looking for a file path (Scene File's
// original_path, Render Output's path, or any other prop shaped the same
// way) and pulls the "P####" code out of the "...\Projekti\P0288 - 55
// Deans\..." folder segment.
function extractProjectCode(payload: Record<string, unknown>): string | null {
  const steps = Array.isArray(payload.steps) ? payload.steps as Record<string, unknown>[] : [];
  const paths: string[] = [];
  for (const step of steps) {
    const props = Array.isArray(step.props) ? step.props as Record<string, unknown>[] : [];
    for (const prop of props) {
      const value = prop.value;
      if (value && typeof value === "object") {
        const v = value as Record<string, unknown>;
        if (typeof v.path === "string") paths.push(v.path);
        if (typeof v.original_path === "string") paths.push(v.original_path);
      }
    }
  }
  for (const p of paths) {
    const folderMatch = p.match(/\\Projekti\\([^\\]+)/i);
    if (!folderMatch) continue;
    const codeMatch = folderMatch[1].match(/^(P\d+)/i);
    if (codeMatch) return codeMatch[1].toUpperCase();
  }
  return null;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return jsonResponse({ ok: false, error: "method not allowed" }, 405);
  }

  const url = new URL(req.url);
  const providedSecret = req.headers.get("x-webhook-secret") ?? url.searchParams.get("secret") ?? "";
  const validSecret = (!!WEBHOOK_SECRET && providedSecret === WEBHOOK_SECRET)
    || (!!BRIDGE_SECRET && providedSecret === BRIDGE_SECRET);
  if (!validSecret) {
    return jsonResponse({ ok: false, error: "unauthorized" }, 401);
  }

  let payload: Record<string, unknown>;
  try {
    payload = await req.json();
  } catch {
    return jsonResponse({ ok: false, error: "invalid json" }, 400);
  }

  // RenderFlow's confirmed job-completed shape: `user_id` at root identifies the
  // submitter (no name/email in the payload itself) — resolve it against
  // team_members.renderflow_user_id. Falls back to a few plausible alternate
  // field names in case a different job type sends a different shape.
  const renderflowUserId = pick(payload, ["user_id", "userId", "job.user_id"]);
  let employee: string | null = null;
  if (renderflowUserId) {
    const { data: match } = await supabase
      .from("team_members")
      .select("name")
      .eq("renderflow_user_id", renderflowUserId)
      .maybeSingle();
    employee = match?.name ?? null;
  }
  employee ??= pick(payload, [
    "employee", "user", "user.name", "submittedBy", "submitted_by",
    "owner", "owner.name", "artist", "job.user", "job.user.name",
    "job.owner", "job.submittedBy",
  ]) ?? "UNKNOWN_SUBMITTER";
  const projectCode = pick(payload, ["projectCode", "project_code", "job.projectCode"]) ?? extractProjectCode(payload);
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

  // Flag the kind of thing that used to take a manual investigation to
  // notice — a render path whose project code doesn't match any real
  // project (typo'd/renamed folder), or a RenderFlow account never mapped
  // to a team_members row (see team_members.renderflow_user_id) — as an
  // immediate notification to every superadmin, instead of only surfacing
  // once someone happens to notice a missing Discord message days later.
  // Best-effort: any failure here must never affect the response below,
  // since the actual render notification above already succeeded and the
  // RenderFlow bridge only retries on a non-2xx response.
  try {
    const anomalies: string[] = [];
    if (!projectCode) {
      anomalies.push(`Render "${taskLabel}" — nije pronađen kod projekta (P####) u putanji fajla.`);
    } else {
      const { data: projMatch } = await supabase.from("projects").select("code").eq("code", projectCode).maybeSingle();
      if (!projMatch) anomalies.push(`Render "${taskLabel}" — kod "${projectCode}" iz putanje ne odgovara nijednom postojećem projektu.`);
    }
    if (employee === "UNKNOWN_SUBMITTER") {
      anomalies.push(`Render "${taskLabel}"${projectLabel} — izvršilac nije prepoznat (RenderFlow user_id: ${renderflowUserId ?? "nepoznat"}). Proveri mapiranje u Tim.`);
    }
    if (anomalies.length) {
      const { data: superadmins } = await supabase.from("team_members").select("name").eq("access", "superadmin");
      const names = (superadmins ?? []).map((r: { name: string }) => r.name);
      if (names.length) {
        await supabase.from("notifications").insert(
          names.flatMap((name) => anomalies.map((text) => ({ recipient_name: name, kind: "renderflow_anomaly", text, project_code: null }))),
        );
      }
    }
  } catch { /* anomaly notification is best-effort, never blocks the main response */ }

  return jsonResponse({ ok: true, id: data.id, matchedEmployee: employee !== "UNKNOWN_SUBMITTER", projectCode }, 200);
});
