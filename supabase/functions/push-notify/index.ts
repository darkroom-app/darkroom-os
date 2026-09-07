// DARKROOM OS: push-notify (Phase 34)
//
// Deploy via Supabase Dashboard → Edge Functions → New function → name it
// "push-notify" → paste this file's contents → Deploy → disable "Enforce
// JWT Verification" (called by the notify_push_on_notification Postgres
// trigger via pg_net, same as discord-relay). Reuses discord-relay's
// DB_WEBHOOK_SECRET value — set it as this function's own
// DB_WEBHOOK_SECRET secret too (same value, one shared "internal trigger"
// secret, not a new one to invent and keep track of). Also set:
//   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY — generated once, the public half
//   is also hardcoded client-side in darkroom-app.html (safe — it's public
//   by design, only the private half is secret).
//   VAPID_SUBJECT — a mailto: or https: URL identifying the app, sent to
//   push services per the VAPID spec. Using mailto:dusan@darkroomstudio.com.
//
// Fires on EVERY notifications insert (see schema.sql Phase 34) — reaches
// every recipient's subscribed devices with an actual OS-level
// notification, even if they have no tab open at all. Looks up the
// recipient's team_members row (notifications only ever store a name, not
// an id) to find their push_subscriptions, then sends to each. A 404/410
// from the push service means that subscription is dead (browser
// uninstalled, permission revoked, site data cleared) — deleted here
// rather than left to fail forever on every future notification.

import { createClient } from "jsr:@supabase/supabase-js@2";
import webpush from "npm:web-push@3";

const DB_WEBHOOK_SECRET = Deno.env.get("DB_WEBHOOK_SECRET") ?? "";
const VAPID_PUBLIC_KEY = Deno.env.get("VAPID_PUBLIC_KEY") ?? "";
const VAPID_PRIVATE_KEY = Deno.env.get("VAPID_PRIVATE_KEY") ?? "";
const VAPID_SUBJECT = Deno.env.get("VAPID_SUBJECT") ?? "mailto:dusan@darkroomstudio.com";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

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
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
    return jsonResponse({ ok: false, error: "VAPID keys not configured" }, 500);
  }

  let payload: Record<string, unknown>;
  try {
    payload = await req.json();
  } catch {
    return jsonResponse({ ok: false, error: "invalid json" }, 400);
  }

  if (payload.type !== "INSERT" || !payload.record) {
    return jsonResponse({ ok: true, skipped: true }, 200);
  }

  const row = payload.record as Record<string, unknown>;
  const recipientName = typeof row.recipient_name === "string" ? row.recipient_name : "";
  const text = typeof row.text === "string" ? row.text : "";
  const projectCode = typeof row.project_code === "string" ? row.project_code : null;
  if (!recipientName || !text) return jsonResponse({ ok: true, skipped: true, reason: "no recipient/text" }, 200);

  const { data: member } = await supabase
    .from("team_members").select("id").eq("name", recipientName).maybeSingle();
  if (!member) return jsonResponse({ ok: true, skipped: true, reason: "recipient not found" }, 200);

  const { data: subs, error: subsError } = await supabase
    .from("push_subscriptions").select("id, endpoint, p256dh, auth").eq("employee_id", member.id);
  if (subsError) return jsonResponse({ ok: false, error: subsError.message }, 500);
  if (!subs || subs.length === 0) return jsonResponse({ ok: true, sent: 0 }, 200);

  const notificationPayload = JSON.stringify({
    title: "DARKROOM OS",
    body: text,
    url: projectCode ? `/darkroom-app.html?view=projekti&project=${encodeURIComponent(projectCode)}` : "/darkroom-app.html",
  });

  let sent = 0;
  const deadIds: string[] = [];
  for (const sub of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        notificationPayload,
      );
      sent++;
    } catch (e) {
      // deno-lint-ignore no-explicit-any
      const statusCode = (e as any)?.statusCode;
      if (statusCode === 404 || statusCode === 410) deadIds.push(sub.id);
      // Any other failure (network blip, push service hiccup) is left alone
      // to just retry naturally next time this person gets a notification —
      // only a confirmed-dead subscription gets removed.
    }
  }

  if (deadIds.length) {
    await supabase.from("push_subscriptions").delete().in("id", deadIds);
  }

  return jsonResponse({ ok: true, sent, removed: deadIds.length }, 200);
});
