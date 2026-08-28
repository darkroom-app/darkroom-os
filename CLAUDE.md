# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A single self-contained HTML file (`darkroom-app.html`, ~3,600 lines) implementing "DARKROOM OS": a front-end-only mock dashboard/prototype for a 3D visualization/rendering studio. All markup, CSS, and JavaScript live in this one file — there is no build system, package manager, bundler, framework, or backend. All application data (projects, clients, team, finances, portfolio) is hardcoded in JS arrays/objects and lives only in memory; nothing persists across a page reload (no localStorage, no API calls).

UI copy and content are in Serbian (`lang="sr"`).

## Running / developing

There is no build or test tooling. To work on the app, just open `darkroom-app.html` directly in a browser (or serve the directory with any static file server) and reload after edits.

## Architecture

The file has three sections, in order:

1. **`<style>` (head)** — all CSS, organized into clearly delimited blocks per view, e.g. `/* ==== PROJEKTI VIEW ==== */`, `/* ==== FINANSIJE VIEW ==== */`, `/* ==== AI ASSISTANT ==== */`. CSS custom properties for the whole design system (colors, fonts, radii) are defined once on `:root`.
2. **`<body>`** — a `.shell` grid with a fixed `.sidebar` (nav) and `.main` content area containing one `<div class="view-panel" id="view-{name}">` per section (`pregled`, `kalendar`, `projekti`, `klijenti`, `playbook`, `portfolio`, `statistika`, `tim`, `finansije`), plus a floating AI-assistant chat widget (`.chat-fab` / `.chat-panel`).
3. **`<script>` (end of body, one big script block starting ~line 1831)** — all app logic.

### Navigation / view model

This is a client-rendered single-page app with no router: `showView(name)` (near the end of the script) toggles the `.active` class on the matching `#view-{name}` panel and hides the rest; `.nav a[data-view]` clicks drive it. Two views (`statistika`, `finansije`) are expensive to render and are lazy-initialized on first visit via `statistikaInited`/`finansijeInited` guards calling `initStatistika()` / `initFinansije()`.

### Per-view pattern

Each view follows the same convention and they are largely independent of one another — when changing one view's behavior you generally don't need to touch the others:
- A mock data array/object near the top of the script (e.g. `allProjects`, `allClients`, `teamMembers`, `allTransactions`, `portfolioItems`, `playbookArticles`).
- A filter/search state object (e.g. `filters`, `clientState`, `teamState`, `txState`, `priceState`) mutated by UI event handlers.
- A `render*Page()` / `render*()` function that reads the data + state and re-generates the relevant DOM via template strings (`innerHTML`).
- Add/edit/delete flows go through a shared `.modal-overlay` pattern (e.g. `modalOverlay`, `clientModalOverlay`, `teamModalOverlay`, `txModalOverlay`, `kadarModalOverlay`, `salModalOverlay`) — a hidden overlay toggled with the `.open` class, populated and wired per-entity.

### Cross-cutting pieces

- **AI assistant / search** — `chatbotSearch(query)` does a naive substring search across `allProjects`, `allClients`, `portfolioItems`, `playbookArticles`, and artist names, returning up to 7 results with an `action()` callback. `sendChat()` / `pushChatMessage()` / `renderChatMessages()` drive the chat UI; `toggleChat()` opens/closes the panel. Result `action()` callbacks (`openProject`, `openClient`, `openPortfolioItem`, `openPlaybookArticle`, `openPersonStats`) navigate to the relevant view and pre-apply a search filter, so the chat assistant is really a cross-view deep-link mechanism.
- **Charts** are hand-rolled with divs/SVG and CSS transitions (no charting library) — see `renderMonthChart`, `renderDonut`, `renderFinFlowChart`, `renderLineChart`, `animateCountUp` for the animation conventions (heights/values animated in on render).
- **Shared color/label maps** used across views: `artistColors`/`artistGrad`/`artistInitials` (per-person color + initials, used in avatars everywhere), `statusTag` (status → CSS tag class), `categoryColorVar`/`typeColorVar` (finance/portfolio category → CSS var).
- **Formatting helpers**: `fmtRSD` (Serbian Dinar currency formatting with `.` thousands separator), `fmtK`, `escapeHtml` (used whenever user-entered text is interpolated into `innerHTML`).

### Conventions to follow when editing

- Keep new views/features self-contained in the same three-section structure (styles in `<style>`, markup as a new `view-panel` in `<body>`, logic in the trailing `<script>`) rather than introducing separate files or a build step — this project is intentionally a single portable HTML file.
- Follow the existing per-view pattern (data array → state object → `render*()` function → modal for mutations) when adding CRUD-like functionality to a view.
- Reuse the existing CSS custom properties (`--gold`, `--teal`, `--coral`, `--plum`, `--sky`, `--sage` and their `-soft`/`-deep` variants, plus `--ink*`/`--bg*`/`--card*`) and font vars (`--font-display`, `--font-body`, `--font-mono`) instead of introducing new colors/fonts, to stay consistent with the existing design system.
- Any user-supplied string interpolated into `innerHTML` should go through `escapeHtml()`.
