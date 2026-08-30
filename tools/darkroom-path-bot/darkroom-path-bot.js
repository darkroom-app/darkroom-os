// DARKROOM OS: Discord bot that turns pasted datacenter paths into
// clickable "open this folder" links.
//
// Problem this solves: people paste raw Windows paths (e.g.
// \\DATACENTER\Projekti\P0288 - 55 Deans\Renderi) into Discord so a
// colleague can find a file — Discord never makes those clickable, so
// whoever reads it has to manually copy the text into Explorer, which is
// finicky (spaces, easy to mistype). This bot watches messages, finds any
// path-looking text, and replies with a real https:// link (which Discord
// DOES render as clickable) to a small page (open.html, in the main repo)
// that offers a single "Otvori folder" button. Clicking it hands off to a
// custom darkroom-open:// URI, which a one-time per-machine install
// (tools/darkroom-open/) resolves into actually opening Explorer at that
// exact path. See tools/darkroom-open/ for that half of the pipeline.
//
// Setup:
//   1. npm install (installs discord.js)
//   2. Create a bot application at https://discord.com/developers/applications
//      -> Bot tab -> enable "MESSAGE CONTENT INTENT" (required, the bot
//      can't read message text without it) -> copy the bot token.
//   3. OAuth2 -> URL Generator -> scope "bot" -> permissions "Send Messages"
//      + "Read Message History" -> open the generated URL, invite it to the
//      DARKROOM server.
//   4. Copy config.example.json to config.json and paste the token in.
//      (config.json is gitignored — never commit a real token.)
//   5. node darkroom-path-bot.js — or use run.bat, which restarts it
//      automatically if it ever crashes.

const fs = require('fs');
const path = require('path');
const { Client, GatewayIntentBits } = require('discord.js');

const configPath = path.join(__dirname, 'config.json');
if (!fs.existsSync(configPath)) {
  console.error('Nedostaje config.json — kopiraj config.example.json u config.json i popuni discordBotToken.');
  process.exit(1);
}
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
if (!config.discordBotToken || config.discordBotToken === 'PASTE_YOUR_BOT_TOKEN_HERE') {
  console.error('config.json nema pravi discordBotToken — otvori ga i nalepi token bota.');
  process.exit(1);
}

const OPEN_PAGE_BASE = config.openPageBaseUrl || 'https://app.darkroomstudio.com/open.html';
const ALLOWED_CHANNEL_IDS = Array.isArray(config.allowedChannelIds) ? config.allowedChannelIds : [];

// Only ever matches \\DATACENTER\... — deliberately scoped to the one real
// share this is for, not "any UNC path", matching the same allowlist
// darkroom-open.ps1 enforces on the receiving end. Used as a last-resort
// fallback (see extractPaths below) — on its own it stops at the first
// whitespace, which breaks on this studio's own folder convention
// ("P0288 - 55 Deans" has spaces in it).
const PATH_REGEX = /\\\\DATACENTER\\[^\s\\]+(?:\\[^\s\\]+)*/gi;
const TRAILING_PUNCTUATION = /[.,;:!?)\]"'`]+$/;

function looksLikePath(s) {
  return /^\\\\DATACENTER\\.+$/i.test(s);
}

// Three tiers, each consuming what it matches before the next one runs (so
// a space-containing path caught by tier 1/2 doesn't ALSO get picked up,
// truncated at its first space, by tier 3's fallback regex):
//   1. Backtick- or quote-delimited text ("...", `...`) — spaces preserved,
//      the delimiter itself marks exactly where the path ends.
//   2. A line that is (trimmed) essentially just a path — spaces allowed,
//      since there's nothing else on that line to conflict with.
//   3. Whatever's left: the plain no-space regex, for a path pasted inline
//      mid-sentence without any delimiter (this one genuinely can't handle
//      spaces — there's no way to tell where the path ends and the rest of
//      the sentence begins otherwise).
function extractPaths(content) {
  const found = [];
  const seen = new Set();
  const add = (p) => {
    const clean = p.replace(TRAILING_PUNCTUATION, '');
    if (!seen.has(clean)) { seen.add(clean); found.push(clean); }
  };

  let working = content.replace(/`([^`]+)`|"([^"]+)"/g, (whole, a, b) => {
    const inner = (a ?? b).trim();
    if (looksLikePath(inner)) { add(inner); return ' '.repeat(whole.length); }
    return whole;
  });

  const lines = working.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (looksLikePath(trimmed)) { add(trimmed); lines[i] = ''; }
  }
  working = lines.join('\n');

  const inline = working.match(PATH_REGEX) || [];
  for (const m of inline) add(m);

  return found;
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.once('clientReady', () => {
  console.log(`Darkroom path bot je online kao ${client.user.tag}`);
});

client.on('messageCreate', async (message) => {
  try {
    if (message.author.bot) return;
    if (ALLOWED_CHANNEL_IDS.length && !ALLOWED_CHANNEL_IDS.includes(message.channelId)) return;

    const cleaned = extractPaths(message.content);
    if (!cleaned.length) return;

    const lines = cleaned.map((p) => {
      const segments = p.split('\\').filter(Boolean);
      const label = segments[segments.length - 1] || p;
      const url = `${OPEN_PAGE_BASE}?p=${encodeURIComponent(p)}`;
      return `📂 [${label}](${url})`;
    });

    await message.reply({ content: lines.join('\n'), allowedMentions: { repliedUser: false } });
  } catch (err) {
    console.error('Obrada poruke nije uspela:', err);
  }
});

client.login(config.discordBotToken);
