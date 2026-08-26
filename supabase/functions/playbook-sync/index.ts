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
//  1. Fetches the published HTML and parses it with a real DOM parser
//     (deno-dom) rather than regex — tested against a real studio doc that
//     had a Heading-1-styled line nested inside a numbered-list <li> (an
//     easy accident when restructuring an outline in Google Docs); a
//     regex-based tag matcher using a backreference for the closing tag
//     swallows a nested heading like that as the enclosing <li>'s own text
//     and never sees it as a heading at all, silently dropping the whole
//     article. A DOM parser finds every <h1> regardless of what it's
//     nested inside.
//  2. Walks the parsed body in document order: an <h1> starts a new
//     article, an <h2> (or <h3>, treated the same) starts a new section
//     within it, text before the first section heading becomes that
//     article's subtitle if short (a one-line tagline, like the original
//     hand-written articles) or its own lead-in section if long (e.g. a
//     multi-paragraph legal preamble), later paragraphs become that
//     section's body, and list items become its list instead — matching
//     the { label, body } / { label, list } shape darkroom-app.html's
//     playbookArticles already use.
//  3. Replaces every row in playbook_articles with the freshly parsed set —
//     small dataset, so a full refresh is simpler than diffing row by row.
//
// If the fetch or parse fails, existing rows are left untouched and an error
// is returned — the app keeps showing the last successful sync rather than
// ever going blank because Google was briefly unreachable.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { DOMParser, Element } from "jsr:@b-fuze/deno-dom";

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

// This content is now editable by anyone with Doc access rather than
// hand-authored by a developer (the original seed's raw <code> tags in
// source were safe because a developer wrote them), and it's rendered
// straight into innerHTML client-side with no further escaping — so this
// escaping is the only thing standing between a doc editor and a working
// <script>/<img onerror> tag. .textContent already gives fully-decoded
// plain text (a DOM parser, unlike regex, can't be tricked by entities
// into producing a live tag), so escaping it here is what makes it safe to
// store and later interpolate unescaped.
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// The one bit of inline formatting doc editors get: `backtick text` becomes
// a real <code> tag, matching the style the original hand-written seed used
// for file paths/naming examples. Safe because the tag itself is ours, not
// passed through from the document, and it wraps already-escaped text.
function formatInline(text: string): string {
  return text.replace(/`([^`]+)`/g, (_m, code) => `<code>${code}</code>`);
}

function cleanText(raw: string): string {
  const collapsed = raw.replace(/\s+/g, " ").trim();
  return formatInline(escapeHtml(collapsed));
}

// True when this <li>'s only meaningful content is a single nested heading —
// the "heading style applied to a numbered-list line" artifact confirmed in
// a real studio doc (Google represents it as <li><h1 style="display:inline">
// ...</h1></li> when someone applies Heading 1 to one line of an outline
// list). Such an <li> should be skipped entirely and the heading handled on
// its own when the walk reaches it as a separate node — otherwise it's
// double-counted as both a stray list item and the next article/section.
function liWrapsHeading(node: Element): boolean {
  const elementChildren = Array.from(node.children).filter((c) => (c.textContent ?? "").trim());
  if (elementChildren.length !== 1) return false;
  const tag = elementChildren[0].tagName.toLowerCase();
  return tag === "h1" || tag === "h2" || tag === "h3";
}

function parseDoc(html: string): Article[] {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const body = doc?.body;
  if (!body) return [];

  const nodes = Array.from(body.querySelectorAll("h1, h2, h3, p, li")) as Element[];

  const articles: Article[] = [];
  let current: Article | null = null;
  let currentSection: Section | null = null;
  let sawHeadingInArticle = false;
  // Paragraphs between an H1 and that article's first H2/H3. A short one
  // (the original hand-written articles' style — a single tagline sentence)
  // becomes the subtitle; a real one-off document dropped in wholesale
  // (e.g. a Pravilnik's multi-paragraph legal preamble) is too long to sit
  // under the title as a subtitle, so it becomes an ordinary lead-in section
  // instead.
  let preamble: string[] = [];
  const SUBTITLE_MAX_CHARS = 220;

  function finalizePreamble(article: Article) {
    if (!preamble.length) return;
    const joined = preamble.join(" ");
    if (preamble.length === 1 && joined.length <= SUBTITLE_MAX_CHARS) {
      article.subtitle = joined;
    } else {
      article.sections.unshift({ label: "", body: preamble });
    }
    preamble = [];
  }

  for (const node of nodes) {
    const tag = node.tagName.toLowerCase();
    if (tag === "li" && liWrapsHeading(node)) continue;
    const rawText = node.textContent ?? "";
    const text = cleanText(rawText);
    if (!text) continue;

    if (tag === "h1") {
      if (current) finalizePreamble(current);
      const plainUpper = rawText.replace(/\s+/g, " ").trim().toUpperCase();
      current = {
        icon: ICON_ROTATION[articles.length % ICON_ROTATION.length],
        navTitle: text,
        title: escapeHtml(plainUpper),
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
      if (!sawHeadingInArticle) finalizePreamble(current);
      currentSection = { label: text };
      current.sections.push(currentSection);
      sawHeadingInArticle = true;
      continue;
    }
    if (tag === "li") {
      if (!sawHeadingInArticle) { preamble.push(text); continue; }
      if (!currentSection) {
        currentSection = { label: "" };
        current.sections.push(currentSection);
      }
      (currentSection.list ??= []).push(text);
      continue;
    }
    // <p>
    if (!sawHeadingInArticle) {
      preamble.push(text);
      continue;
    }
    if (!currentSection) {
      currentSection = { label: "" };
      current.sections.push(currentSection);
    }
    if (currentSection.list) continue; // a stray paragraph inside a list section — drop rather than mixing shapes
    (currentSection.body ??= []).push(text);
  }
  if (current) finalizePreamble(current);

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
