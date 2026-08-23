// DARKROOM — Titanium OS: Phase 3e/3f backend (relay notifications to Discord)
//
// Deployed under the dashboard-assigned name "smart-service" — see
// schema.sql's notify_discord() for why. Disable "Enforce JWT
// Verification" (same as pulse-webhook/bootstrap-team) and set the
// DISCORD_WEBHOOK_URL and DB_WEBHOOK_SECRET secrets (Edge Functions →
// Manage secrets) — never commit either value to this repo.
//
// Called by the notify_discord() Postgres trigger (via pg_net) on every
// insert into `public.notifications`, so every existing and future
// notification producer reaches Discord with no changes needed here.
// Phase 3f: the studio runs one Discord channel per project, so the
// trigger looks up that project's own webhook URL (projects.discord_webhook_url,
// set through the project's edit form in the app) and passes it as
// `webhook_url` in the body — this function posts there.
// Phase 3g: dropped the DISCORD_WEBHOOK_URL fallback-to-a-single-shared-
// channel behavior — it meant every project without its own webhook
// configured silently posted into whatever channel that secret happened
// to point at (surprising and confusing once there were dozens of
// projects). A project with no webhook set now just gets skipped.
// Phase 10: one specific non-project notification kind (leave-request
// approvals) does get a fixed channel — the studio's own "remote i
// odsustva" Discord group, via its own dedicated webhook secret. This is
// deliberately narrow (checked by `kind`, not a general fallback) so it
// doesn't reintroduce the Phase 3g problem for anything else.

const DB_WEBHOOK_SECRET = Deno.env.get("DB_WEBHOOK_SECRET") ?? "";
const DISCORD_WEBHOOK_LEAVE_URL = Deno.env.get("DISCORD_WEBHOOK_LEAVE_URL") ?? "";

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

  const providedSecret = req.headers.get("x-db-webhook-secret") ?? "";
  if (!DB_WEBHOOK_SECRET || providedSecret !== DB_WEBHOOK_SECRET) {
    return jsonResponse({ ok: false, error: "unauthorized" }, 401);
  }

  let payload: Record<string, unknown>;
  try {
    payload = await req.json();
  } catch {
    return jsonResponse({ ok: false, error: "invalid json" }, 400);
  }

  if (payload.type !== "INSERT" || !payload.record) {
    // Ignore anything that isn't a fresh notification row (defensive — the
    // trigger only ever fires on INSERT, but don't assume).
    return jsonResponse({ ok: true, skipped: true }, 200);
  }

  const row = payload.record as Record<string, unknown>;
  const kind = typeof row.kind === "string" ? row.kind : "";
  const text = typeof row.text === "string" ? row.text : "(bez teksta)";

  let targetUrl = typeof payload.webhook_url === "string" ? payload.webhook_url : "";
  let content: string;
  if (kind === "odsustvo_discord" && DISCORD_WEBHOOK_LEAVE_URL) {
    targetUrl = DISCORD_WEBHOOK_LEAVE_URL;
    content = `🏖️ ${text}`;
  } else {
    const recipient = typeof row.recipient_name === "string" ? row.recipient_name : "Nepoznat";
    const projectCode = typeof row.project_code === "string" ? row.project_code : null;
    content = `🔔 **${recipient}** ${projectCode ? `(${projectCode}) ` : ""}— ${text}`;
  }

  if (!targetUrl) {
    // This project has no Discord channel configured — skip rather than
    // posting into some unrelated shared channel (see Phase 3g note above).
    return jsonResponse({ ok: true, skipped: true, reason: "no webhook url" }, 200);
  }

  const discordResp = await fetch(targetUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content }),
  });

  if (!discordResp.ok) {
    const errText = await discordResp.text();
    return jsonResponse({ ok: false, error: `discord webhook failed: ${discordResp.status} ${errText}` }, 502);
  }

  return jsonResponse({ ok: true }, 200);
});
