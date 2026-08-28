// DARKROOM OS: Phase 15 backend (Playbook synced from Google Docs)
//
// Deploy via Supabase Dashboard → Edge Functions → playbook-sync → Code tab
// → paste this file's contents → Deploy. Leave "Enforce JWT Verification" ON
// (the default) — this is called directly by the logged-in app
// (initPlaybook() in darkroom-app.html) via supabase-js, which already
// attaches the caller's own session token, so no extra shared secret is
// needed here.
//
// Rewritten from an earlier "Publish to web" HTML-scraping version once a
// real studio doc turned out to use Google Docs *tabs* (Document tabs panel:
// Workflow & Standardi / Život u Studiju / Hardware & Software / Modelovanje
// / Statut i Pravilnik) — "Publish to web" flattens every tab into one HTML
// blob with zero markers between them, so there was no way to recover which
// content belonged to which tab from that export at all. The Docs API's
// `includeTabsContent=true` returns each tab as its own structured object,
// which is the only way to get this right.
//
// Auth: OAuth refresh token for a real Google account (not a service account
// — this Google Workspace org has an organization policy that blocks
// creating/downloading service account keys entirely). Set these secrets
// (Edge Functions → Manage secrets):
//   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET — from the OAuth client created in
//     Google Cloud Console (APIs & Services → Credentials → OAuth client ID,
//     type "Web application", redirect URI
//     https://developers.google.com/oauthplayground).
//   GOOGLE_REFRESH_TOKEN — obtained once via OAuth Playground: use your own
//     credentials above, scope https://www.googleapis.com/auth/documents.readonly,
//     authorize, "Exchange authorization code for tokens", copy the refresh
//     token. Doesn't expire on its own; only breaks if revoked or the
//     authorizing account loses access to the doc.
//   GOOGLE_DOCUMENT_ID — the id from the doc's edit URL
//     (docs.google.com/document/d/<THIS PART>/edit), not the "Publish to
//     web" link's id — they're different ids for the same document.
// Never commit any of these values to this repo.
//
// Also requires a public Supabase Storage bucket named "playbook-images"
// (Storage → New bucket → Public bucket ON) — embedded images are re-hosted
// there rather than linked directly to Google's contentUri, which is
// documented as a short-lived URL.
//
// What it does, each call:
//  1. Mints a fresh access token from the refresh token (access tokens
//     expire hourly, refresh tokens don't).
//  2. Fetches the document with includeTabsContent=true.
//  3. Treats each tab as one Playbook article — tabProperties.title becomes
//     the article's title directly, no heading-detection guesswork needed
//     for the article level at all.
//  4. Within a tab, a paragraph starts a new section when it's either a
//     real Heading 1-4 style OR (a studio-specific convention found in
//     "Život u Studiju"/"Hardware & Software", which use no heading styles
//     at all) a non-bulleted paragraph whose entire text is bold — e.g.
//     "Radno vreme i pauze" on its own line. A bold *lead-in* on an
//     otherwise-mixed paragraph (like "Assets:" at the start of a bullet
//     whose rest is plain text) does NOT count — only a wholly-bold line.
//     Bold/italic elsewhere are preserved as real <strong>/<em> around the
//     (already-escaped) text they wrap, so mid-sentence emphasis survives
//     instead of being flattened to plain text.
//  5. A short (<=220 char), single-paragraph lead-in before a tab's first
//     section becomes that article's subtitle; anything longer, or any
//     lead-in image, becomes an ordinary unlabeled first section instead.
//  6. Embedded images are downloaded from Google's contentUri immediately
//     (per-tab documentTab.inlineObjects) and re-uploaded to the
//     playbook-images bucket, keyed by objectId so re-syncing overwrites
//     the same file instead of accumulating duplicates.
//  7. Replaces every row in playbook_articles with the freshly parsed set —
//     small dataset, so a full refresh is simpler than diffing row by row.
//
// If any step fails, existing rows are left untouched and an error is
// returned — the app keeps showing the last successful sync rather than
// ever going blank because Google was briefly unreachable.

import { createClient } from "jsr:@supabase/supabase-js@2";

const GOOGLE_CLIENT_ID = Deno.env.get("GOOGLE_CLIENT_ID") ?? "";
const GOOGLE_CLIENT_SECRET = Deno.env.get("GOOGLE_CLIENT_SECRET") ?? "";
const GOOGLE_REFRESH_TOKEN = Deno.env.get("GOOGLE_REFRESH_TOKEN") ?? "";
const GOOGLE_DOCUMENT_ID = Deno.env.get("GOOGLE_DOCUMENT_ID") ?? "";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

// Called directly from the browser (initPlaybook() in darkroom-app.html via
// sb.functions.invoke), so it needs CORS headers on every response and must
// answer the browser's OPTIONS preflight — without this the request never
// even reaches the POST handler below (same pattern gemini-chat uses, the
// other function this app calls straight from the client).
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

interface Section {
  label: string;
  body?: string[];
  list?: string[];
  images?: string[];
}
interface Article {
  icon: string;
  navTitle: string;
  title: string;
  subtitle: string;
  sections: Section[];
}

// Cycled by position — Google Docs tabs have no concept of "icon", this is
// purely decorative in the nav list, same four glyphs the hand-written seed
// this replaced used.
const ICON_ROTATION = ["layers", "coffee", "shield", "settings"];
const SUBTITLE_MAX_CHARS = 220;

// This content is editable by anyone with Doc access rather than
// hand-authored by a developer, and is rendered straight into innerHTML
// client-side with no further escaping — so this escaping is the only thing
// standing between a doc editor and a working <script>/<img onerror> tag.
// Applied to every text run before any <strong>/<em> wrapping, so the tags
// this function itself adds are the only real markup that ever survives.
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// deno-lint-ignore no-explicit-any
type DocParagraph = any;

function paragraphPlainText(paragraph: DocParagraph): string {
  return (paragraph.elements ?? [])
    .map((e: DocParagraph) => e.textRun?.content ?? "")
    .join("");
}

// True only when EVERY non-blank text run in the paragraph is bold — a bold
// *lead-in* on an otherwise-mixed line (e.g. "Assets:" followed by plain
// text) does not count, since that's inline emphasis, not a section label.
function paragraphIsFullyBold(paragraph: DocParagraph): boolean {
  const runs = (paragraph.elements ?? []).filter((e: DocParagraph) => e.textRun && e.textRun.content?.trim());
  if (!runs.length) return false;
  return runs.every((e: DocParagraph) => !!e.textRun.textStyle?.bold);
}

// Plain escaped text, no bold/italic markup — for section labels. Every
// section-starting line is bold by definition (that's the detection rule,
// or it's a real Heading style which Google renders bold by default too),
// so wrapping it in another <strong> would be pure redundant noise on top
// of the .pb-section-label CSS that already bolds it client-side.
function labelText(paragraph: DocParagraph): string {
  return escapeHtml(paragraphPlainText(paragraph)).replace(/\s+/g, " ").trim();
}

// Renders a paragraph's text runs to safe HTML, preserving bold/italic as
// real tags around already-escaped text. Used for body/list content, where
// mid-sentence emphasis (e.g. a bold lead-in word, an italicized example)
// is meaningful and worth keeping — unlike a section label, which is
// wholly-bold by construction.
function renderInline(paragraph: DocParagraph): string {
  let html = "";
  for (const el of paragraph.elements ?? []) {
    if (!el.textRun || !el.textRun.content) continue;
    let piece = escapeHtml(el.textRun.content);
    const style = el.textRun.textStyle ?? {};
    if (style.bold) piece = `<strong>${piece}</strong>`;
    if (style.italic) piece = `<em>${piece}</em>`;
    html += piece;
  }
  return html.replace(/\s+/g, " ").trim();
}

function imageIdsInParagraph(paragraph: DocParagraph): string[] {
  const ids: string[] = [];
  for (const el of paragraph.elements ?? []) {
    if (el.inlineObjectElement?.inlineObjectId) ids.push(el.inlineObjectElement.inlineObjectId);
  }
  return ids;
}

async function getAccessToken(): Promise<string> {
  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: GOOGLE_REFRESH_TOKEN,
      grant_type: "refresh_token",
    }),
  });
  if (!resp.ok) throw new Error(`token refresh failed: ${resp.status} ${await resp.text()}`);
  const data = await resp.json();
  return data.access_token as string;
}

// Downloads an embedded image from Google's (short-lived) contentUri and
// re-uploads it to our own Storage bucket, keyed by objectId so re-syncing
// overwrites the same file instead of accumulating duplicates.
async function rehostImage(contentUri: string, tabId: string, objectId: string): Promise<string | null> {
  try {
    const resp = await fetch(contentUri);
    if (!resp.ok) return null;
    const contentType = resp.headers.get("content-type") || "image/jpeg";
    const ext = contentType.includes("png") ? "png" : contentType.includes("gif") ? "gif" : contentType.includes("webp") ? "webp" : "jpg";
    const bytes = new Uint8Array(await resp.arrayBuffer());
    const path = `${tabId}/${objectId}.${ext}`;
    const { error } = await supabase.storage.from("playbook-images").upload(path, bytes, {
      contentType,
      upsert: true,
    });
    if (error) return null;
    const { data } = supabase.storage.from("playbook-images").getPublicUrl(path);
    return data.publicUrl;
  } catch {
    return null;
  }
}

async function parseTab(tab: DocParagraph): Promise<Article | null> {
  const title = (tab.tabProperties?.title ?? "").trim();
  if (!title) return null;

  const article: Article = {
    icon: ICON_ROTATION[0], // reassigned by caller once article order is known
    navTitle: escapeHtml(title),
    title: escapeHtml(title.toUpperCase()),
    subtitle: "",
    sections: [],
  };

  const inlineObjects = tab.documentTab?.inlineObjects ?? {};
  const content: DocParagraph[] = tab.documentTab?.body?.content ?? [];

  let currentSection: Section | null = null;

  function ensureSection(): Section {
    if (!currentSection) {
      currentSection = { label: "" };
      article.sections.push(currentSection);
    }
    return currentSection;
  }

  for (const el of content) {
    const paragraph = el.paragraph;
    if (!paragraph) continue; // sectionBreak, table, etc. — not handled

    const styleType: string = paragraph.paragraphStyle?.namedStyleType ?? "";
    const isHeadingStyle = /^HEADING_\d/.test(styleType);
    const isBulleted = !!paragraph.bullet;
    const plain = paragraphPlainText(paragraph).trim();
    const fullyBold = !isBulleted && paragraphIsFullyBold(paragraph);
    const imageIds = imageIdsInParagraph(paragraph);

    const isSectionBoundary = !isBulleted && plain.length > 0 && (isHeadingStyle || fullyBold);

    let imageUrls: string[] = [];
    if (imageIds.length) {
      const resolved = await Promise.all(
        imageIds.map(async (id) => {
          const uri = inlineObjects[id]?.inlineObjectProperties?.embeddedObject?.imageProperties?.contentUri;
          if (!uri) return null;
          return await rehostImage(uri, tab.tabProperties.tabId, id);
        }),
      );
      imageUrls = resolved.filter((u): u is string => !!u);
    }

    if (isSectionBoundary) {
      currentSection = { label: labelText(paragraph) };
      article.sections.push(currentSection);
      if (imageUrls.length) currentSection.images = imageUrls;
      continue;
    }

    if (!plain && !imageUrls.length) continue; // blank spacer paragraph

    if (isBulleted) {
      const section = ensureSection();
      if (plain) (section.list ??= []).push(renderInline(paragraph));
      if (imageUrls.length) (section.images ??= []).push(...imageUrls);
      continue;
    }

    // Plain paragraph (not a heading/bold-line, not bulleted).
    const section = ensureSection();
    if (plain && !section.list) (section.body ??= []).push(renderInline(paragraph));
    if (imageUrls.length) (section.images ??= []).push(...imageUrls);
  }

  // If the tab opened with unlabeled content before its first real section
  // (a short one-line tagline, matching the studio's original hand-written
  // style) and nothing else got attached to it, promote it to the article's
  // subtitle instead of leaving it as an anonymous first section.
  const first = article.sections[0];
  if (
    first && first.label === "" && !first.list && !first.images &&
    first.body && first.body.length === 1 && first.body[0].length <= SUBTITLE_MAX_CHARS
  ) {
    article.subtitle = first.body[0];
    article.sections.shift();
  }

  return article;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }
  if (req.method !== "POST") {
    return jsonResponse({ ok: false, error: "method not allowed" }, 405);
  }
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REFRESH_TOKEN || !GOOGLE_DOCUMENT_ID) {
    return jsonResponse({ ok: false, error: "Google OAuth secrets not fully configured" }, 500);
  }

  let doc: DocParagraph;
  try {
    const accessToken = await getAccessToken();
    const resp = await fetch(
      `https://docs.googleapis.com/v1/documents/${GOOGLE_DOCUMENT_ID}?includeTabsContent=true`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    if (!resp.ok) throw new Error(`Docs API fetch failed: ${resp.status} ${await resp.text()}`);
    doc = await resp.json();
  } catch (e) {
    return jsonResponse({ ok: false, error: `could not fetch doc: ${e}` }, 502);
  }

  let articles: Article[];
  try {
    const tabs: DocParagraph[] = doc.tabs ?? [];
    const parsed = await Promise.all(tabs.map((t) => parseTab(t)));
    articles = parsed.filter((a): a is Article => !!a);
    articles.forEach((a, i) => { a.icon = ICON_ROTATION[i % ICON_ROTATION.length]; });
  } catch (e) {
    return jsonResponse({ ok: false, error: `could not parse doc: ${e}` }, 500);
  }

  if (articles.length === 0) {
    return jsonResponse({ ok: false, error: "parsed zero tabs — check the document has at least one named tab" }, 500);
  }

  const rows = articles.map((a, i) => ({
    sort_order: i,
    icon: a.icon,
    nav_title: a.navTitle,
    title: a.title,
    subtitle: a.subtitle || null,
    sections: a.sections,
    updated_at: new Date().toISOString(),
  }));

  const { error: deleteError } = await supabase.from("playbook_articles").delete().not("id", "is", null);
  if (deleteError) {
    return jsonResponse({ ok: false, error: `could not clear old rows: ${deleteError.message}` }, 500);
  }
  const { error: insertError } = await supabase.from("playbook_articles").insert(rows);
  if (insertError) {
    return jsonResponse({ ok: false, error: `could not insert new rows: ${insertError.message}` }, 500);
  }

  return jsonResponse({ ok: true, articleCount: articles.length }, 200);
});
