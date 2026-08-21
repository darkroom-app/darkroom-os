// DARKROOM — Titanium OS: AI chatbot backend (Gemini proxy)
//
// Deploy via Supabase Dashboard → Edge Functions → New function → name it
// "gemini-chat" → paste this file's contents → Deploy → leave "Enforce JWT
// Verification" ON (default) — unlike pulse-webhook/bootstrap-team/discord-relay,
// this one is called directly by logged-in app users via supabase-js
// (sb.functions.invoke), which already attaches their session JWT, so
// Supabase's own verification is the auth gate. Then set the GEMINI_API_KEY
// secret (Edge Functions → Manage secrets) to a Google AI Studio API key —
// never commit that value to this repo, and never send it to the client.
//
// POST /functions/v1/gemini-chat
// Body: { message: string, history: [{role:"user"|"model", text:string}], context: string }
// Returns: { ok: true, reply: string } or { ok: false, error: string }
//
// `context` is a compact JSON snapshot of the studio's current data
// (projects, clients, team, finances, playbook) built client-side in
// buildChatContext() — this function never touches the database itself, it
// only forwards what the already-authenticated, already-RLS-scoped client
// sent it. Swap MODEL below if Google renames/deprecates it.

const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY") ?? "";
const MODEL = "gemini-3.6-flash";
const MAX_HISTORY_TURNS = 12;

const SYSTEM_PROMPT = `Ti si AI asistent unutar DARKROOM — Titanium OS, internog dashboard-a 3D vizuelizacione studija. Korisnici su članovi tima (dizajneri, menadžeri, vlasnik). Uvek odgovaraj na srpskom jeziku, kratko i konkretno — ovo je radni alat, ne ćaskanje.

Dobijaš JSON snimak trenutnih podataka studija (projekti, klijenti, tim, finansije, DR Playbook pravilnik) u nastavku ovog sistemskog uputstva. Koristi isključivo te podatke da odgovoriš na pitanja o projektima, klijentima, timu, finansijama ili internim pravilima. Ako pitanje traži podatak koji nije u snimku, jasno reci da ga nemaš dostupnog — ne izmišljaj brojke, datume ili imena.

Kad pominješ konkretan projekat ili klijenta, koristi njihov tačan naziv iz podataka (korisnik može kliknuti na karticu ispod tvog odgovora da otvori taj projekat/klijenta). Budi precizan sa brojevima (RSD, datumi, procenti) — ovo su stvarni poslovni podaci.`;

// Called directly from the browser (unlike the other three functions, which
// are server/webhook-triggered), so it needs CORS headers on every response
// and must answer the browser's OPTIONS preflight — without this the
// request never even reaches the POST handler below.
const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, x-client-info, apikey, content-type",
  "access-control-allow-methods": "POST, OPTIONS",
};

function jsonResponse(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...CORS_HEADERS },
  });
}

interface ChatTurn {
  role: "user" | "model";
  text: string;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }
  if (req.method !== "POST") {
    return jsonResponse({ ok: false, error: "method not allowed" }, 405);
  }
  if (!GEMINI_API_KEY) {
    return jsonResponse({ ok: false, error: "GEMINI_API_KEY nije podešen na serveru" }, 500);
  }

  let body: { message?: string; history?: ChatTurn[]; context?: string };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ ok: false, error: "invalid json" }, 400);
  }

  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message) {
    return jsonResponse({ ok: false, error: "poruka je prazna" }, 400);
  }
  const context = typeof body.context === "string" ? body.context : "";
  const history = Array.isArray(body.history) ? body.history.slice(-MAX_HISTORY_TURNS) : [];

  const contents = [
    ...history
      .filter((t) => t && (t.role === "user" || t.role === "model") && typeof t.text === "string")
      .map((t) => ({ role: t.role, parts: [{ text: t.text }] })),
    { role: "user", parts: [{ text: message }] },
  ];

  const geminiBody = {
    systemInstruction: {
      parts: [{ text: `${SYSTEM_PROMPT}\n\nPODACI STUDIJA (JSON):\n${context}` }],
    },
    contents,
    generationConfig: { temperature: 0.4, maxOutputTokens: 4096 },
  };

  let geminiResp: Response;
  try {
    geminiResp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(geminiBody),
      },
    );
  } catch (e) {
    return jsonResponse({ ok: false, error: `mrežna greška ka Gemini-ju: ${String(e)}` }, 502);
  }

  if (!geminiResp.ok) {
    const errText = await geminiResp.text();
    return jsonResponse({ ok: false, error: `Gemini API greška (${geminiResp.status}): ${errText}` }, 502);
  }

  const data = await geminiResp.json();
  // Thinking-capable models can return internal reasoning as separate parts
  // (marked `thought: true`) alongside the real answer — only join the
  // non-thought parts, or a truncated/garbled reasoning trace leaks into
  // the chat instead of the actual reply.
  const reply = data?.candidates?.[0]?.content?.parts
    ?.filter((p: { thought?: boolean }) => !p.thought)
    ?.map((p: { text?: string }) => p.text ?? "")
    ?.join("") ?? "";
  if (!reply) {
    const blockReason = data?.promptFeedback?.blockReason;
    return jsonResponse(
      { ok: false, error: blockReason ? `Gemini je blokirao odgovor: ${blockReason}` : "Gemini nije vratio odgovor" },
      502,
    );
  }

  return jsonResponse({ ok: true, reply }, 200);
});
