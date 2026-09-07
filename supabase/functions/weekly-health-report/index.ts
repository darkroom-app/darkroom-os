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

  // Full rows, not just counts — stored verbatim in raw_payload below so the
  // app can show a detailed breakdown when someone clicks the notification,
  // instead of just the one-line summary text.
  const { data: newProjectRows } = await supabase
    .from("projects").select("code, name, created_at").gte("created_at", since).order("created_at", { ascending: false });
  const { data: newKadarRows } = await supabase
    .from("kadrovi").select("name, type, created_at, projects(code, name)").gte("created_at", since).order("created_at", { ascending: false });
  const { data: newRoundRows } = await supabase
    .from("rounds").select("label, billable, date, created_at, kadrovi(name, projects(code, name))").gte("created_at", since).order("created_at", { ascending: false });
  const { data: newReceiptRows } = await supabase
    .from("expense_inbox").select("file_name, extracted_amount, extracted_date, extracted_description, extracted_category, status, created_at")
    .gte("created_at", since).order("created_at", { ascending: false });
  const { count: pendingReceipts } = await supabase.from("expense_inbox").select("id", { count: "exact", head: true }).eq("status", "na_cekanju");

  const newProjects = newProjectRows?.length ?? 0;
  const newKadrovi = newKadarRows?.length ?? 0;
  const newRounds = newRoundRows?.length ?? 0;
  const newReceipts = newReceiptRows?.length ?? 0;

  const lines: string[] = [
    `📁 ${newProjects} novih projekata, ${newKadrovi} novih kadrova, ${newRounds} novih rundi (poslednjih 7 dana).`,
    `🧾 ${newReceipts} novih računa iz Dropbox-a ove nedelje, ${pendingReceipts ?? 0} trenutno čeka potvrdu.`,
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

  // Flattened into plain fields (no nested embeds) so the client can render
  // this directly without re-deriving anything — stored verbatim in
  // raw_payload, read back by darkroom-app.html when someone clicks the
  // notification to see the detailed breakdown instead of just `text`.
  const detail = {
    // deno-lint-ignore no-explicit-any
    projects: (newProjectRows ?? []).map((p: any) => ({ code: p.code, name: p.name, createdAt: p.created_at })),
    // deno-lint-ignore no-explicit-any
    kadrovi: (newKadarRows ?? []).map((k: any) => ({
      name: k.name, type: k.type, createdAt: k.created_at,
      projectCode: k.projects?.code ?? null, projectName: k.projects?.name ?? null,
    })),
    // deno-lint-ignore no-explicit-any
    rounds: (newRoundRows ?? []).map((r: any) => ({
      label: r.label, billable: r.billable, date: r.date, createdAt: r.created_at,
      kadarName: r.kadrovi?.name ?? null,
      projectCode: r.kadrovi?.projects?.code ?? null, projectName: r.kadrovi?.projects?.name ?? null,
    })),
    // deno-lint-ignore no-explicit-any
    receipts: (newReceiptRows ?? []).map((e: any) => ({
      fileName: e.file_name, amount: e.extracted_amount, date: e.extracted_date,
      description: e.extracted_description, category: e.extracted_category, status: e.status, createdAt: e.created_at,
    })),
    pendingReceipts: pendingReceipts ?? 0,
    warnings,
  };

  const { data: superadmins, error: saError } = await supabase.from("team_members").select("name").eq("access", "superadmin");
  if (saError) return jsonResponse({ ok: false, error: saError.message }, 500);

  const names = (superadmins ?? []).map((r: { name: string }) => r.name);
  if (names.length) {
    const { error: insertError } = await supabase.from("notifications").insert(
      names.map((name) => ({ recipient_name: name, kind: "weekly_report", text, project_code: null, raw_payload: detail })),
    );
    if (insertError) return jsonResponse({ ok: false, error: insertError.message }, 500);
  }

  return jsonResponse({ ok: true, text, warnings, recipients: names.length }, 200);
});
