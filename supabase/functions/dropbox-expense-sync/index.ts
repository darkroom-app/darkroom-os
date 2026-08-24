// DARKROOM — Titanium OS: Dropbox receipt intake (Phase 12)
//
// Deploy via Supabase Dashboard → Edge Functions → New function → name it
// "dropbox-expense-sync" → paste this file's contents → Deploy → disable
// "Enforce JWT Verification" (same as bootstrap-team/pulse-webhook — this is
// called by Supabase's own Cron scheduler, not a logged-in browser client).
// Then set these secrets (Edge Functions → Manage secrets):
//   DROPBOX_APP_KEY, DROPBOX_APP_SECRET, DROPBOX_REFRESH_TOKEN — from the
//     Dropbox app + OAuth exchange (see the walkthrough this was set up
//     with; never commit any of these values to this repo).
//   DROPBOX_SYNC_SECRET — any random string you choose, must match the
//     header the Cron job sends (see the Cron setup notes below).
//   GEMINI_API_KEY — already set for gemini-chat; reused here as-is.
// Schedule it: Database → Cron Jobs → New job → HTTP request → this
// function's URL, POST, header `x-dropbox-sync-secret: <same value>`, every
// 15 minutes is a reasonable interval.
//
// What it does, each run:
//  1. Mint a fresh Dropbox access token from the refresh token (access
//     tokens expire in 4h, refresh tokens don't).
//  2. List the direct children of "/Darkroom" and keep only folders named
//     like "<year> Arhiva" (e.g. "2026 Arhiva") — never touches anything
//     else under Darkroom (project/render folders etc).
//  3. For each such folder: if we've never watched it before, seed a cursor
//     from its CURRENT state without processing anything already in it (no
//     backfill of existing receipts) — otherwise, continue from the stored
//     cursor and pick up only files added since last run.
//  4. For every new receipt file (pdf/jpg/jpeg/png/heic): download it, ask
//     Gemini to read amount/date/description/category off it, copy the file
//     into Supabase Storage (expense-receipts bucket, superadmin-only), and
//     insert one `expense_inbox` row — status 'na_cekanju', NOT a real
//     transaction yet. A human confirms or corrects each one in the app
//     before it becomes a transactions row (see the app's Finansije →
//     Transakcije "Na čekanju iz Dropbox-a" panel).
//  5. Persist the updated cursor(s) so the next run picks up where this one
//     left off.
//
// A failure on one file (bad download, Gemini couldn't parse it, whatever)
// is caught and reported per-file — it doesn't stop the rest of the batch
// or skip advancing the cursor past files that DID succeed.

import { createClient } from "jsr:@supabase/supabase-js@2";

/* Chunked so a multi-MB receipt doesn't blow the call stack on
   String.fromCharCode(...bytes) — 32k chars per chunk is a safe, common
   size for this. Avoids depending on an external base64 package resolving
   correctly at deploy time for something this small. */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

const DROPBOX_APP_KEY = Deno.env.get("DROPBOX_APP_KEY") ?? "";
const DROPBOX_APP_SECRET = Deno.env.get("DROPBOX_APP_SECRET") ?? "";
const DROPBOX_REFRESH_TOKEN = Deno.env.get("DROPBOX_REFRESH_TOKEN") ?? "";
const DROPBOX_SYNC_SECRET = Deno.env.get("DROPBOX_SYNC_SECRET") ?? "";
const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY") ?? "";
const GEMINI_MODEL = "gemini-3.6-flash";

const WATCH_ROOT = "/Darkroom";
const YEAR_FOLDER_RE = /^\d{4}\s+Arhiva$/i;
const RECEIPT_EXT_MIME: Record<string, string> = {
  pdf: "application/pdf",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  heic: "image/heic",
};
const MAX_FILE_BYTES = 15 * 1024 * 1024; // stay well under Gemini's inline-data limit

const VALID_CATEGORIES = [
  "Plate", "Zakup prostora", "Softver", "Oprema", "Ostalo",
  "Povraćaj poreza", "Porezi firma", "Računi", "Kirija", "Hardver", "Sajt", "Saradnici",
];

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

async function getDropboxAccessToken(): Promise<string> {
  const resp = await fetch("https://api.dropboxapi.com/oauth2/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: DROPBOX_REFRESH_TOKEN,
      client_id: DROPBOX_APP_KEY,
      client_secret: DROPBOX_APP_SECRET,
    }),
  });
  if (!resp.ok) throw new Error(`Dropbox token refresh failed (${resp.status}): ${await resp.text()}`);
  const data = await resp.json();
  return data.access_token as string;
}

interface DbxEntry {
  ".tag": "file" | "folder" | "deleted";
  name: string;
  path_lower: string;
  path_display: string;
  size?: number;
}

async function dbxListFolder(token: string, path: string, recursive: boolean) {
  const resp = await fetch("https://api.dropboxapi.com/2/files/list_folder", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ path, recursive, include_deleted: false }),
  });
  if (!resp.ok) throw new Error(`list_folder failed for ${path} (${resp.status}): ${await resp.text()}`);
  return resp.json();
}

async function dbxListFolderContinue(token: string, cursor: string) {
  const resp = await fetch("https://api.dropboxapi.com/2/files/list_folder/continue", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ cursor }),
  });
  if (!resp.ok) throw new Error(`list_folder/continue failed (${resp.status}): ${await resp.text()}`);
  return resp.json();
}

/* Walks list_folder(/continue) pages to the end. `collect` controls whether
   file entries are accumulated (normal sync) or discarded (initial seed —
   we still have to page through everything to reach the "caught up to now"
   cursor, we just don't want the entries themselves). */
async function drainToCursor(
  token: string,
  first: { entries: DbxEntry[]; cursor: string; has_more: boolean },
  collect: boolean,
): Promise<{ cursor: string; files: DbxEntry[] }> {
  let page = first;
  const files: DbxEntry[] = collect ? page.entries.filter((e) => e[".tag"] === "file") : [];
  while (page.has_more) {
    page = await dbxListFolderContinue(token, page.cursor);
    if (collect) files.push(...page.entries.filter((e) => e[".tag"] === "file"));
  }
  return { cursor: page.cursor, files };
}

async function dbxDownload(token: string, path: string): Promise<Uint8Array> {
  const resp = await fetch("https://content.dropboxapi.com/2/files/download", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "Dropbox-API-Arg": JSON.stringify({ path }) },
  });
  if (!resp.ok) throw new Error(`download failed for ${path} (${resp.status}): ${await resp.text()}`);
  return new Uint8Array(await resp.arrayBuffer());
}

function extOf(name: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(name);
  return m ? m[1].toLowerCase() : "";
}

interface ExtractedReceipt {
  amount: number | null;
  date: string | null;
  description: string;
  category: string | null;
  note: string | null;
}

async function extractReceiptWithGemini(bytes: Uint8Array, mimeType: string, fileName: string): Promise<ExtractedReceipt> {
  const prompt = `Ovo je slika ili PDF računa/fakture troška za 3D vizuelizacioni studio "Darkroom". Pročitaj sa dokumenta i vrati ISKLJUČIVO validan JSON (bez markdown ograde, bez teksta pre/posle) u ovom obliku:
{"amount": <broj u RSD, bez separatora, ili null ako ne možeš da pročitaš>, "date": "<datum računa u YYYY-MM-DD formatu, ili null>", "description": "<kratak opis — ko je izdao račun i za šta, na srpskom>", "category": "<jedna od: ${VALID_CATEGORIES.join(", ")}, ili null ako ništa ne odgovara>", "note": "<kratka napomena SAMO ako nešto nije jasno/pouzdano pročitano (npr. mutan skener, dva moguća iznosa) — inače null>"}
Ako je iznos u drugoj valuti, pretvori u RSD samo ako je kurs eksplicitno naveden na dokumentu, inače stavi amount:null i objasni u note. Naziv fajla je "${fileName}", može da pomogne kao kontekst ali ne veruj mu više nego samom dokumentu.`;

  const body = {
    contents: [{
      role: "user",
      parts: [
        { inline_data: { mime_type: mimeType, data: bytesToBase64(bytes) } },
        { text: prompt },
      ],
    }],
    generationConfig: { temperature: 0.1, maxOutputTokens: 1024 },
  };

  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
  );
  if (!resp.ok) throw new Error(`Gemini extraction failed (${resp.status}): ${await resp.text()}`);
  const data = await resp.json();
  const text = data?.candidates?.[0]?.content?.parts
    ?.filter((p: { thought?: boolean }) => !p.thought)
    ?.map((p: { text?: string }) => p.text ?? "")
    ?.join("") ?? "";
  if (!text) throw new Error("Gemini vratio prazan odgovor");

  const cleaned = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error(`Gemini odgovor nije validan JSON: ${cleaned.slice(0, 200)}`);
  }

  const category = typeof parsed.category === "string" && VALID_CATEGORIES.includes(parsed.category) ? parsed.category : null;
  return {
    amount: typeof parsed.amount === "number" ? parsed.amount : null,
    date: typeof parsed.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(parsed.date) ? parsed.date : null,
    description: typeof parsed.description === "string" ? parsed.description : fileName,
    category,
    note: typeof parsed.note === "string" ? parsed.note : null,
  };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return jsonResponse({ ok: false, error: "method not allowed" }, 405);
  }
  const providedSecret = req.headers.get("x-dropbox-sync-secret") ?? "";
  if (!DROPBOX_SYNC_SECRET || providedSecret !== DROPBOX_SYNC_SECRET) {
    return jsonResponse({ ok: false, error: "unauthorized" }, 401);
  }
  if (!DROPBOX_APP_KEY || !DROPBOX_APP_SECRET || !DROPBOX_REFRESH_TOKEN) {
    return jsonResponse({ ok: false, error: "Dropbox secrets nisu podešeni" }, 500);
  }
  if (!GEMINI_API_KEY) {
    return jsonResponse({ ok: false, error: "GEMINI_API_KEY nije podešen" }, 500);
  }

  const token = await getDropboxAccessToken();

  const { data: stateRow, error: stateError } = await supabase
    .from("dropbox_sync_state").select("cursors").eq("id", 1).single();
  if (stateError) return jsonResponse({ ok: false, error: `dropbox_sync_state read failed: ${stateError.message}` }, 500);
  const cursors: Record<string, string> = stateRow?.cursors ?? {};

  const rootListing = await dbxListFolder(token, WATCH_ROOT, false);
  const yearFolders: DbxEntry[] = rootListing.entries.filter(
    (e: DbxEntry) => e[".tag"] === "folder" && YEAR_FOLDER_RE.test(e.name),
  );

  const results: Record<string, unknown>[] = [];
  const newCursors: Record<string, string> = { ...cursors };

  for (const folder of yearFolders) {
    const path = folder.path_display;
    try {
      if (!cursors[path]) {
        // Never watched before — seed a cursor from the current state
        // without processing what's already there (no backfill).
        const first = await dbxListFolder(token, path, true);
        const { cursor } = await drainToCursor(token, first, false);
        newCursors[path] = cursor;
        results.push({ folder: path, seeded: true, processed: 0 });
        continue;
      }

      const first = await dbxListFolderContinue(token, cursors[path]);
      const { cursor, files } = await drainToCursor(token, first, true);
      newCursors[path] = cursor;

      const receiptFiles = files.filter((f) => extOf(f.name) in RECEIPT_EXT_MIME && (f.size ?? 0) <= MAX_FILE_BYTES);
      const fileResults: Record<string, unknown>[] = [];

      for (const file of receiptFiles) {
        try {
          const { data: existing } = await supabase
            .from("expense_inbox").select("id").eq("dropbox_path", file.path_lower).maybeSingle();
          if (existing) { fileResults.push({ file: file.name, skipped: "already in inbox" }); continue; }

          const bytes = await dbxDownload(token, file.path_lower);
          const mimeType = RECEIPT_EXT_MIME[extOf(file.name)];
          const extracted = await extractReceiptWithGemini(bytes, mimeType, file.name);

          const dateForPath = extracted.date ?? new Date().toISOString().slice(0, 10);
          const storagePath = `${dateForPath.slice(0, 4)}/${dateForPath.slice(5, 7)}/${crypto.randomUUID()}-${file.name}`;
          const { error: uploadError } = await supabase.storage
            .from("expense-receipts").upload(storagePath, bytes, { contentType: mimeType });
          if (uploadError) throw new Error(`storage upload failed: ${uploadError.message}`);

          const { error: insertError } = await supabase.from("expense_inbox").insert({
            dropbox_path: file.path_lower,
            file_name: file.name,
            receipt_storage_path: storagePath,
            extracted_amount: extracted.amount,
            extracted_date: extracted.date,
            extracted_description: extracted.description,
            extracted_category: extracted.category,
            ai_note: extracted.note,
          });
          if (insertError) throw new Error(`expense_inbox insert failed: ${insertError.message}`);

          fileResults.push({ file: file.name, ok: true });
        } catch (e) {
          fileResults.push({ file: file.name, ok: false, error: String(e) });
        }
      }

      results.push({ folder: path, seeded: false, processed: receiptFiles.length, files: fileResults });
    } catch (e) {
      results.push({ folder: path, ok: false, error: String(e) });
    }
  }

  const { error: saveCursorError } = await supabase
    .from("dropbox_sync_state").update({ cursors: newCursors, updated_at: new Date().toISOString() }).eq("id", 1);
  if (saveCursorError) {
    results.push({ ok: false, error: `cursor save failed: ${saveCursorError.message}` });
  }

  return jsonResponse({ ok: true, watchedFolders: yearFolders.map((f) => f.path_display), results }, 200);
});
