// DARKROOM OS: kalendar-podsetnik (calendar fill-in reminder)
//
// Deploy via Supabase Dashboard → Edge Functions → New function → name it
// "kalendar-podsetnik" → paste this file's contents → Deploy → disable
// "Enforce JWT Verification". No secret of its own — same reasoning as
// weekly-health-report: it only ever reads and only ever inserts
// notifications. SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY are auto-injected
// like every other function here.
// Schedule it: Cron Jobs → New job → HTTP request → this function's URL,
// POST, every Friday morning (e.g. 08:00 — pick the UTC time that lands at
// 08:00 in Belgrade for the season, since Supabase Cron schedules run in UTC).
//
// What it does: for every active team member, checks Monday through
// Thursday of the current week for a day where they had a "zadatak"
// scheduled on the Kalendar but never logged an hours entry for it — the
// exact same gap the app's own Moji sati view makes visible one person at
// a time (see renderCalendarMySati() in darkroom-app.html), just checked
// for the whole team at once instead of waiting for someone to notice.
// Friday isn't itself checked since its own hours aren't due until the
// week is actually over. A day covered by an approved leave (odsustvo) or
// a public holiday (praznik) is never counted as missing. Sends one
// notification per person with a gap, listing which day(s) — reuses the
// existing notifications table, so it reaches the same in-app bell and
// (via the notify_push_on_notification trigger + push-notify function)
// the same push notification as every other notification in the app.
// Sends nothing to someone with no gaps.

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
const isoDate = (d: Date) => d.toISOString().slice(0, 10);
const overlaps = (row: { start_date: string; end_date: string }, dateStr: string) =>
  row.start_date <= dateStr && row.end_date >= dateStr;

const WEEKDAY_NAMES = ["nedelja", "ponedeljak", "utorak", "sreda", "četvrtak", "petak", "subota"];

Deno.serve(async (req) => {
  if (req.method !== "POST" && req.method !== "GET") {
    return jsonResponse({ ok: false, error: "method not allowed" }, 405);
  }

  const now = new Date();
  const dow = (now.getUTCDay() + 6) % 7; // Monday=0..Sunday=6
  const monday = new Date(now.getTime() - dow * DAY_MS);
  // Mon..Thu only — Friday's own hours aren't due yet the morning this runs.
  const checkDates = [0, 1, 2, 3].map((i) => isoDate(new Date(monday.getTime() + i * DAY_MS)));
  const weekStart = checkDates[0];
  const weekEnd = checkDates[checkDates.length - 1];

  const { data: members, error: membersError } = await supabase
    .from("team_members").select("id, name").eq("status", "Aktivan");
  if (membersError) return jsonResponse({ ok: false, error: membersError.message }, 500);

  const { data: events, error: eventsError } = await supabase
    .from("calendar_events").select("kind, person, start_date, end_date, approval_status")
    .lte("start_date", weekEnd).gte("end_date", weekStart);
  if (eventsError) return jsonResponse({ ok: false, error: eventsError.message }, 500);

  const { data: entries, error: entriesError } = await supabase
    .from("time_entries").select("employee_id, date")
    .gte("date", weekStart).lte("date", weekEnd);
  if (entriesError) return jsonResponse({ ok: false, error: entriesError.message }, 500);

  const holidays = (events ?? []).filter((e) => e.kind === "praznik");
  const leaves = (events ?? []).filter((e) => e.kind === "odsustvo" && e.approval_status !== "odbijeno");
  const tasks = (events ?? []).filter((e) => e.kind === "zadatak");

  const missingByPerson = new Map<string, string[]>();
  for (const member of members ?? []) {
    for (const dateStr of checkDates) {
      if (holidays.some((h) => overlaps(h, dateStr))) continue;
      if (leaves.some((l) => l.person === member.name && overlaps(l, dateStr))) continue;
      if (!tasks.some((t) => t.person === member.name && overlaps(t, dateStr))) continue;
      const hasEntry = (entries ?? []).some((e) => e.employee_id === member.id && e.date === dateStr);
      if (hasEntry) continue;
      if (!missingByPerson.has(member.name)) missingByPerson.set(member.name, []);
      missingByPerson.get(member.name)!.push(dateStr);
    }
  }

  const fmtDay = (dateStr: string) => {
    const d = new Date(dateStr + "T00:00:00Z");
    const dayNum = dateStr.slice(8, 10);
    const monthNum = dateStr.slice(5, 7);
    return `${WEEKDAY_NAMES[d.getUTCDay()]} ${dayNum}.${monthNum}.`;
  };

  const rows = [...missingByPerson.entries()].map(([name, dates]) => ({
    recipient_name: name,
    kind: "kalendar_podsetnik",
    text: `Podseća te da popuniš kalendar (Moji sati) za: ${dates.map(fmtDay).join(", ")}.`,
    project_code: null,
  }));

  if (rows.length) {
    const { error: insertError } = await supabase.from("notifications").insert(rows);
    if (insertError) return jsonResponse({ ok: false, error: insertError.message }, 500);
  }

  return jsonResponse({ ok: true, notified: rows.length, checkedDates: checkDates }, 200);
});
