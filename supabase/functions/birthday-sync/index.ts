// DARKROOM — Titanium OS: Automatic birthday day off (Phase 21)
//
// Deploy via Supabase Dashboard → Edge Functions → New function → name it
// "birthday-sync" → paste this file's contents → Deploy → disable
// "Enforce JWT Verification" (called by Cron, not a browser client). No
// secret of its own — it only ever reads team_members and inserts
// calendar_events, so there's nothing destructive a stray caller could
// trigger; SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY are auto-injected like
// every other function here.
// Schedule it: Cron Jobs → New job → HTTP request → this function's URL,
// POST, once a day (any time — it's idempotent, doesn't matter when it runs).
//
// What it does: for every team member with a birth_date on file, works
// out this calendar year's birthday shifted off weekends (Saturday moves
// to Friday, Sunday moves to Monday) and makes sure a pre-approved
// 'rodjendan' odsustvo entry exists on that date — a real day off that
// never touches anyone's godišnji odmor allotment. darkroom-app.html
// deliberately excludes 'rodjendan' days from the odmor day-count
// (personRodjendanDates()/leaveDaysUsed()), so a birthday takes
// precedence over an overlapping vacation booking regardless of which
// was booked first, and the person doesn't lose a vacation day to it.
// 'rodjendan' is intentionally absent from the leave-request dropdown in
// the app — this function is the only thing meant to create one — and
// darkroom-app.html's openEventModal() forces any 'rodjendan' entry fully
// read-only (no edit, no delete) so it can't be edited or removed by hand.
//
// Deliberately forward-only: skips a birthday whose shifted date has
// already passed this year, so turning this feature on mid-year never
// retroactively drops a "day off" onto someone's calendar for a birthday
// that already happened — same principle as datacenter-folder-plan's
// SYNC_CUTOFF (start from now, don't rewrite history).
// Idempotent: checks for an existing 'rodjendan' entry for that person in
// the current year before inserting, so running this daily forever never
// creates duplicates, and it naturally picks up new hires (or a
// newly-entered birth_date) the next time it runs — no special-casing
// needed.

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

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

Deno.serve(async (req) => {
  if (req.method !== "POST" && req.method !== "GET") {
    return jsonResponse({ ok: false, error: "method not allowed" }, 405);
  }

  const { data: members, error: memErr } = await supabase
    .from("team_members").select("id, name, birth_date").not("birth_date", "is", null);
  if (memErr) return jsonResponse({ ok: false, error: memErr.message }, 500);

  const now = new Date();
  const todayIso = isoDate(now);
  const year = now.getUTCFullYear();
  const results: Record<string, unknown>[] = [];

  for (const m of members ?? []) {
    const [, bm, bd] = (m.birth_date as string).split("-").map(Number);
    // Computed in UTC so the weekday check is stable regardless of the
    // server's local time zone.
    let occurrence = new Date(Date.UTC(year, bm - 1, bd));
    const dow = occurrence.getUTCDay(); // 0 = Sunday, 6 = Saturday
    if (dow === 6) occurrence = new Date(occurrence.getTime() - 86400000); // Saturday -> Friday
    else if (dow === 0) occurrence = new Date(occurrence.getTime() + 86400000); // Sunday -> Monday
    const occIso = isoDate(occurrence);

    if (occIso < todayIso) {
      results.push({ name: m.name, skipped: "already passed this year" });
      continue;
    }

    const { data: existing } = await supabase
      .from("calendar_events")
      .select("id")
      .eq("person", m.name).eq("kind", "odsustvo").eq("leave_type", "rodjendan")
      .gte("start_date", `${year}-01-01`).lte("start_date", `${year}-12-31`)
      .maybeSingle();
    if (existing) {
      results.push({ name: m.name, skipped: "already exists", date: occIso });
      continue;
    }

    const { error: insErr } = await supabase.from("calendar_events").insert({
      kind: "odsustvo",
      person: m.name,
      color: "leave",
      leave_type: "rodjendan",
      approval_status: "odobreno",
      start_date: occIso,
      end_date: occIso,
    });
    if (insErr) {
      results.push({ name: m.name, ok: false, error: insErr.message });
      continue;
    }
    results.push({ name: m.name, ok: true, date: occIso });
  }

  return jsonResponse({ ok: true, results }, 200);
});
