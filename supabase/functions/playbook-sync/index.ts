// DARKROOM — Titanium OS: Phase 15 backend (Playbook synced from Google Docs)
//
// Deploy via Supabase Dashboard → Edge Functions → New function → name it
// "playbook-sync" → paste this file's contents → Deploy. Leave "Enforce JWT
// Verification" ON (the default) — unlike pulse-webhook/dropbox-expense-sync,
// this is called directly by the logged-in app (initPlaybook() in
// darkroom-app.html) via supabase-js, which already attaches the caller's
// own session token, so no extra shared secret is needed here.
//
// Set this one secret (Edge Functions → Manage secrets):
//   PLAYBOOK_DOC_URL — the Google Doc's "Publish to web" URL (in the Doc:
//     File → Share → Publish to web → Publish → copy the link; looks like
//     https://docs.google.com/document/d/e/2PACX-.../pub). Never commit it
//     here — the doc becomes viewable by anyone with that link once published.
//
// What it does, each call:
//  1. Fetches the published HTML.
//  2. Walks it top to bottom: an <h1> starts a new article, an <h2> (or <h3>,
//     treated the same) starts a new section within the current article, a
//     <p> before the first section heading becomes that article's subtitle,
//     later <p>s become that section's body paragraphs, and <li>s under a
//     section become its list instead (matches the { label, body } /
//     { label, list } shape darkroom-app.html's playbookArticles already use).
//  3. Replaces every row in playbook_articles with the freshly parsed set —
//     small dataset, so a full refresh is simpler than diffing row by row.
//
// If the fetch or parse fails, existing rows are left untouched and an error
// is returned — the app keeps showing the last successful sync rather than
// ever going blank because Google was briefly unreachable.

import { createClient } from "jsr:@supabase/supabase-js@2";

const PLAYBOOK_DOC_URL = Deno.env.get("PLAYBOOK_DOC_URL") ?? "";
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

interface Section {
  label: string;
  body?: string[];
  list?: string[];
}
interface Article {
  icon: string;
  navTitle: string;
  title: string;
  subtitle: string;
  sections: Section[];
}

// Cycled by position — Google Docs has no concept of "icon", this is purely
// decorative in the nav list, same four glyphs the hand-written seed used.
const ICON_ROTATION = ["layers", "coffee", "shield", "settings"];

// Strips real HTML tags but deliberately leaves &lt; / &gt; / &quot; / &#39;
// entity-encoded rather than decoding them back to raw characters. This
// content now comes from a Google Doc anyone with edit access can change
// (unlike the original hand-authored seed, where a raw <code> tag in the
// source was safe because a developer wrote it) and is rendered straight
// into innerHTML client-side with no further escaping — so whatever escaping
// survives this function IS the only thing standing between a doc editor
// and a working <script>/<img onerror> tag. Only `backtick text` gets
// turned into real markup, via formatInline() below, and only as a tag this
// function itself constructs around already-safe text.
// Numeric character refs (&#381; / &#x17D;) decode to their Unicode
// character — EXCEPT the five that could reconstruct markup (< > " ' &),
// which stay entity-encoded for the same reason &lt;/&gt;/&quot;/&#39; are
// never decoded below.
const DANGEROUS_CODEPOINTS = new Set([60, 62, 34, 39, 38]);
function decodeSafeNumericEntities(s: string): string {
  return s.replace(/&#(x[0-9a-f]+|\d+);/gi, (whole, digits) => {
    const codePoint = digits[0] === "x" || digits[0] === "X"
      ? parseInt(digits.slice(1), 16)
      : parseInt(digits, 10);
    if (!Number.isFinite(codePoint) || DANGEROUS_CODEPOINTS.has(codePoint)) return whole;
    try { return String.fromCodePoint(codePoint); } catch { return whole; }
  });
}

function stripTags(html: string): string {
  return decodeSafeNumericEntities(
    html
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/\s+/g, " ")
      .trim(),
  );
}

// The one bit of inline formatting doc editors get: `backtick text` becomes
// a real <code> tag, matching the style the original hand-written seed used
// for file paths/naming examples. Safe because the tag itself is ours, not
// passed through from the document, and the text it wraps went through
// stripTags() first.
function formatInline(text: string): string {
  return text.replace(/`([^`]+)`/g, (_m, code) => `<code>${code}</code>`);
}

function parseDoc(html: string): Article[] {
  // Google's published export wraps everything in <body>...</body> with
  // headings as real <h1>/<h2>/<h3> tags and paragraphs as <p>. Slice out
  // just the body first so a stray <head><style> block can't get swept up
  // by the block matcher below.
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  const body = bodyMatch ? bodyMatch[1] : html;

  const blockRe = /<(h1|h2|h3|p|li)[^>]*>([\s\S]*?)<\/\1>/gi;
  const articles: Article[] = [];
  let current: Article | null = null;
  let currentSection: Section | null = null;
  let sawHeadingInArticle = false;

  let match: RegExpExecArray | null;
  while ((match = blockRe.exec(body)) !== null) {
    const tag = match[1].toLowerCase();
    const text = stripTags(match[2]);
    if (!text) continue;

    if (tag === "h1") {
      current = {
        icon: ICON_ROTATION[articles.length % ICON_ROTATION.length],
        navTitle: text,
        title: text.toUpperCase(),
        subtitle: "",
        sections: [],
      };
      articles.push(current);
      currentSection = null;
      sawHeadingInArticle = false;
      continue;
    }
    if (!current) continue; // text before the first H1 (title page, stray notes) — ignore

    if (tag === "h2" || tag === "h3") {
      currentSection = { label: text };
      current.sections.push(currentSection);
      sawHeadingInArticle = true;
      continue;
    }
    if (tag === "li") {
      if (!currentSection) {
        currentSection = { label: "" };
        current.sections.push(currentSection);
      }
      (currentSection.list ??= []).push(formatInline(text));
      continue;
    }
    // <p>
    if (!sawHeadingInArticle) {
      const withInline = formatInline(text);
      current.subtitle = current.subtitle ? `${current.subtitle} ${withInline}` : withInline;
      continue;
    }
    if (!currentSection) {
      currentSection = { label: "" };
      current.sections.push(currentSection);
    }
    if (currentSection.list) continue; // a stray paragraph inside a list section — drop rather than mixing shapes
    (currentSection.body ??= []).push(formatInline(text));
  }

  return articles;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return jsonResponse({ ok: false, error: "method not allowed" }, 405);
  }
  if (!PLAYBOOK_DOC_URL) {
    return jsonResponse({ ok: false, error: "PLAYBOOK_DOC_URL not configured" }, 500);
  }

  let html: string;
  try {
    const resp = await fetch(PLAYBOOK_DOC_URL);
    if (!resp.ok) throw new Error(`fetch failed: ${resp.status}`);
    html = await resp.text();
  } catch (e) {
    return jsonResponse({ ok: false, error: `could not fetch doc: ${e}` }, 502);
  }

  let articles: Article[];
  try {
    articles = parseDoc(html);
  } catch (e) {
    return jsonResponse({ ok: false, error: `could not parse doc: ${e}` }, 500);
  }

  if (articles.length === 0) {
    return jsonResponse(
      { ok: false, error: "parsed zero articles — check the doc has at least one Heading 1" },
      500,
    );
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
