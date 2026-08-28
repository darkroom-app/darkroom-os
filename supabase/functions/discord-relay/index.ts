// DARKROOM OS: Phase 3e/3f backend (relay notifications to Discord)
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
// Phase 20: RenderFlow render-done/render-warning notifications used to
// post into the project's Discord channel like everything else, which
// meant every render completion was visible to (and spammed) the whole
// project group, and people ended up checking each other's render
// notifications instead of their own. These two kinds now DM the actual
// recipient directly via a real Discord bot (a webhook can only ever post
// to a fixed channel — there's no such thing as a "webhook DM", so this
// needed an actual bot with its own token, added to the studio's server).
// Falls back to the old channel-webhook behavior if the recipient has no
// discord_user_id on file yet, or if the DM attempt fails for any reason
// (e.g. they've disabled DMs from server members) — a render notification
// should never just silently vanish because the DM mapping isn't set up
// for someone yet.

import { createClient } from "jsr:@supabase/supabase-js@2";

const DB_WEBHOOK_SECRET = Deno.env.get("DB_WEBHOOK_SECRET") ?? "";
const DISCORD_WEBHOOK_LEAVE_URL = Deno.env.get("DISCORD_WEBHOOK_LEAVE_URL") ?? "";
const DISCORD_BOT_TOKEN = Deno.env.get("DISCORD_BOT_TOKEN") ?? "";

const DM_KINDS = new Set(["render-done", "render-warning"]);

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

// Discord bots can't message a user directly by id — you first open (or
// reuse) a DM channel with them, then post into that channel like any
// other. Returns false on any failure so the caller can fall back to the
// project channel instead of losing the notification.
async function sendDiscordDM(discordUserId: string, content: string): Promise<boolean> {
  try {
    const dmResp = await fetch("https://discord.com/api/v10/users/@me/channels", {
      method: "POST",
      headers: { authorization: `Bot ${DISCORD_BOT_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ recipient_id: discordUserId }),
    });
    if (!dmResp.ok) return false;
    const dmChannel = await dmResp.json();

    const msgResp = await fetch(`https://discord.com/api/v10/channels/${dmChannel.id}/messages`, {
      method: "POST",
      headers: { authorization: `Bot ${DISCORD_BOT_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ content }),
    });
    return msgResp.ok;
  } catch {
    return false;
  }
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
  const recipient = typeof row.recipient_name === "string" ? row.recipient_name : "Nepoznat";
  const projectCode = typeof row.project_code === "string" ? row.project_code : null;

  if (DM_KINDS.has(kind) && DISCORD_BOT_TOKEN) {
    const { data: member } = await supabase
      .from("team_members").select("discord_user_id").eq("name", recipient).maybeSingle();
    if (member?.discord_user_id) {
      const dmContent = `${text}${projectCode ? ` (${projectCode})` : ""}`;
      const sent = await sendDiscordDM(member.discord_user_id, dmContent);
      if (sent) return jsonResponse({ ok: true, via: "dm" }, 200);
      // fall through to the channel-webhook path below on DM failure
    }
  }

  let targetUrl = typeof payload.webhook_url === "string" ? payload.webhook_url : "";
  let content: string;
  if (kind === "odsustvo_discord" && DISCORD_WEBHOOK_LEAVE_URL) {
    targetUrl = DISCORD_WEBHOOK_LEAVE_URL;
    content = `🏖️ ${text}`;
  } else {
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

  return jsonResponse({ ok: true, via: "channel" }, 200);
});
