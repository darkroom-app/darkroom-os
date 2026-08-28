// DARKROOM OS: Phase 2 backend (magic-link auth + team_members)
//
// One-time-use admin function: pre-creates a Supabase auth user (email
// pre-verified, no invite email sent) for each team member and inserts the
// matching team_members row. Deploy via Supabase Dashboard → Edge Functions
// → New function → name it "bootstrap-team" → paste this file's contents →
// Deploy → disable "Enforce JWT Verification" (same as pulse-webhook) → set
// the SETUP_SECRET secret (Edge Functions → Manage secrets) to the value
// given separately — never commit that value to this repo.
//
// POST /functions/v1/bootstrap-team
// Headers: x-setup-secret: <shared secret>, content-type: application/json
// Body: [{ "name", "email", "role", "access", "hireDate", "birthDate",
//           "slobodniDani", "sortOrder" }, ...]
//
// Returns per-entry success/failure so a partial failure (e.g. a duplicate
// email) is visible instead of silently dropped.

import { createClient } from "jsr:@supabase/supabase-js@2";

const SETUP_SECRET = Deno.env.get("SETUP_SECRET") ?? "";
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

interface TeamMemberInput {
  name: string;
  email: string;
  role: string;
  access: string;
  hireDate: string | null;
  birthDate: string | null;
  slobodniDani: number;
  sortOrder: number;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return jsonResponse({ ok: false, error: "method not allowed" }, 405);
  }

  const providedSecret = req.headers.get("x-setup-secret") ?? "";
  if (!SETUP_SECRET || providedSecret !== SETUP_SECRET) {
    return jsonResponse({ ok: false, error: "unauthorized" }, 401);
  }

  let entries: TeamMemberInput[];
  try {
    entries = await req.json();
    if (!Array.isArray(entries)) throw new Error("body must be an array");
  } catch {
    return jsonResponse({ ok: false, error: "invalid json" }, 400);
  }

  const results = [];
  for (const entry of entries) {
    if (!entry.name || !entry.email) {
      results.push({ name: entry.name ?? null, ok: false, error: "name and email are required" });
      continue;
    }

    const { data: userData, error: userError } = await supabase.auth.admin.createUser({
      email: entry.email,
      email_confirm: true,
    });
    if (userError || !userData?.user) {
      results.push({ name: entry.name, email: entry.email, ok: false, error: userError?.message ?? "createUser failed" });
      continue;
    }

    const { error: insertError } = await supabase.from("team_members").insert({
      id: userData.user.id,
      name: entry.name,
      role: entry.role ?? "",
      access: entry.access ?? "user",
      hire_date: entry.hireDate ?? null,
      birth_date: entry.birthDate ?? null,
      slobodni_dani: entry.slobodniDani ?? 20,
      email_business: entry.email,
      sort_order: entry.sortOrder ?? 0,
    });
    if (insertError) {
      results.push({ name: entry.name, email: entry.email, ok: false, error: insertError.message });
      continue;
    }

    results.push({ name: entry.name, email: entry.email, ok: true, id: userData.user.id });
  }

  const allOk = results.every((r) => r.ok);
  return jsonResponse({ ok: allOk, results }, allOk ? 200 : 207);
});
