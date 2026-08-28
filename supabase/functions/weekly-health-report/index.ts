// DARKROOM OS: Weekly health report (Phase 19)
//
// Deploy via Supabase Dashboard → Edge Functions → New function → name it
// "weekly-health-report" → paste this file's contents → Deploy → disable
// "Enforce JWT Verification". No secret of its own — it only ever reads
// and only ever inserts notifications, so there's nothing destructive a
// stray caller could trigger; SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY are
// auto-injected like every other function here.
// Schedule it: Cron Jobs → New job → HTTP request → this function's URL,
// POST, once a week (e.g. Monday 08:00).
//
// What it does: summarizes the last 7 days of activity (new projects,
// kadrovi, rounds, Dropbox receipts) and checks two automated pipelines
// this studio now depends on — storage-backup and dropbox-expense-sync —
// for a stale watermark. Both of those update their own state row's
// updated_at on every successful run regardless of whether they found
// anything new to do, so a stale timestamp here means the Cron job itself
// stopped firing, not just "a quiet week" — exactly the kind of silent
// failure that's easy to never notice until someone asks "wait, when did
// that last actually run?" Sends one summary notification to every
// superadmin. Never writes anything except that notification.

import { createClient } from "jsr:@supabase/supabase-js@2";

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

const DAY_MS = 24 * 60 * 60 * 1000;

Deno.serve(async (req) => {
  if (req.method !== "POST" && req.method !== "GET") {
    return jsonResponse({ ok: false, error: "method not allowed" }, 405);
  }

  const since = new Date(Date.now() - 7 * DAY_MS).toISOString();

  const { count: newProjects } = await supabase.from("projects").select("id", { count: "exact", head: true }).gte("created_at", since);
  const { count: newKadrovi } = await supabase.from("kadrovi").select("id", { count: "exact", head: true }).gte("created_at", since);
  const { count: newRounds } = await supabase.from("rounds").select("id", { count: "exact", head: true }).gte("created_at", since);
  const { count: newReceipts } = await supabase.from("expense_inbox").select("id", { count: "exact", head: true }).gte("created_at", since);
  const { count: pendingReceipts } = await supabase.from("expense_inbox").select("id", { count: "exact", head: true }).eq("status", "na_cekanju");

  const lines: string[] = [
    `📁 ${newProjects ?? 0} novih projekata, ${newKadrovi ?? 0} novih kadrova, ${newRounds ?? 0} novih rundi (poslednjih 7 dana).`,
    `🧾 ${newReceipts ?? 0} novih računa iz Dropbox-a ove nedelje, ${pendingReceipts ?? 0} trenutno čeka potvrdu.`,
  ];

  const warnings: string[] = [];

  const { data: backupState } = await supabase.from("backup_state").select("updated_at").eq("id", 1).maybeSingle();
  if (backupState?.updated_at) {
    const ageDays = (Date.now() - new Date(backupState.updated_at).getTime()) / DAY_MS;
    if (ageDays > 2) warnings.push(`⚠️ storage-backup se nije uspešno pokrenuo ${ageDays.toFixed(1)} dana — proveri Cron job.`);
  } else {
    warnings.push(`⚠️ storage-backup nikad nije zabeležio uspešan run.`);
  }

  const { data: dropboxState } = await supabase.from("dropbox_sync_state").select("updated_at").eq("id", 1).maybeSingle();
  if (dropboxState?.updated_at) {
    const ageHours = (Date.now() - new Date(dropboxState.updated_at).getTime()) / (60 * 60 * 1000);
    if (ageHours > 24) warnings.push(`⚠️ dropbox-expense-sync se nije uspešno pokrenuo ${(ageHours / 24).toFixed(1)} dana — proveri Cron job.`);
  } else {
    warnings.push(`⚠️ dropbox-expense-sync nikad nije zabeležio uspešan run.`);
  }

  const text = [...lines, ...warnings].join(" ");

  const { data: superadmins, error: saError } = await supabase.from("team_members").select("name").eq("access", "superadmin");
  if (saError) return jsonResponse({ ok: false, error: saError.message }, 500);

  const names = (superadmins ?? []).map((r: { name: string }) => r.name);
  if (names.length) {
    const { error: insertError } = await supabase.from("notifications").insert(
      names.map((name) => ({ recipient_name: name, kind: "weekly_report", text, project_code: null })),
    );
    if (insertError) return jsonResponse({ ok: false, error: insertError.message }, 500);
  }

  return jsonResponse({ ok: true, text, warnings, recipients: names.length }, 200);
});
