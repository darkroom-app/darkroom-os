// DARKROOM — Titanium OS: Phase 3e backend (relay notifications to Discord)
//
// Deploy via Supabase Dashboard → Edge Functions → New function → name it
// "discord-relay" → paste this file's contents → Deploy → disable "Enforce
// JWT Verification" (same as pulse-webhook/bootstrap-team) → set the
// DISCORD_WEBHOOK_URL and DB_WEBHOOK_SECRET secrets (Edge Functions →
// Manage secrets) — never commit either value to this repo.
//
// Triggered by a Supabase Database Webhook on `public.notifications`
// (INSERT only). Supabase's Database Webhook payload shape is:
//   { type: "INSERT", table: "notifications", schema: "public", record: {...}, old_record: null }
// so every existing and future producer that inserts into `notifications`
// (pulse-webhook today, pushNotification() once it writes through to
// Supabase) reaches Discord automatically — this function never needs to
// change when a new notification source is added.

const DISCORD_WEBHOOK_URL = Deno.env.get("DISCORD_WEBHOOK_URL") ?? "";
const DB_WEBHOOK_SECRET = Deno.env.get("DB_WEBHOOK_SECRET") ?? "";

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
  if (!DISCORD_WEBHOOK_URL) {
    return jsonResponse({ ok: false, error: "DISCORD_WEBHOOK_URL not configured" }, 500);
  }

  let payload: Record<string, unknown>;
  try {
    payload = await req.json();
  } catch {
    return jsonResponse({ ok: false, error: "invalid json" }, 400);
  }

  if (payload.type !== "INSERT" || !payload.record) {
    // Ignore anything that isn't a fresh notification row (defensive — the
    // Database Webhook is configured for INSERT-only, but don't assume).
    return jsonResponse({ ok: true, skipped: true }, 200);
  }

  const row = payload.record as Record<string, unknown>;
  const recipient = typeof row.recipient_name === "string" ? row.recipient_name : "Nepoznat";
  const text = typeof row.text === "string" ? row.text : "(bez teksta)";
  const projectCode = typeof row.project_code === "string" ? row.project_code : null;

  const content = `🔔 **${recipient}** ${projectCode ? `(${projectCode}) ` : ""}— ${text}`;

  const discordResp = await fetch(DISCORD_WEBHOOK_URL, {
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
