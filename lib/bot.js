'use strict';
// Orchestrator: wires the Twitch connection to economy + commands + bets,
// and forwards chat to the renderer for TTS. Resilient by design — if the
// DB failed to load, economy/commands are skipped but TTS still flows.

const path = require('path');
const twitch = require('./twitch');
const db = require('./db');
const economy = require('./economy');
const commands = require('./commands');
const bets = require('./bets');
const games = require('./games');
const twitchapi = require('./twitchapi');
const lines = require('./lines');

let onStatus = () => {};
let onChat = () => {};
let onLog = () => {};            // activity feed for the standalone bot UI
let dbOk = false;

// Everything the bot says goes through here so the UI log sees it too.
function botSay(text) {
  twitch.say(text);
  try { onLog('OUT', text); } catch {}
}

// --- Heartbeat: ambient banter on a jittered cadence ---
// Replaces the old 3-tip rotation. Picks from lib/lines.js banter pools,
// context-aware on:
//   - current game on Twitch (Helix `streams`, cached) -> SF6/CotW/ARC/MK pool
//   - hour of day (Europe/London local clock)         -> morning/late pool
//   - chat heat (msgs in the last 30s)                -> hot/cold pool
// Will not talk to a dead room. Anti-repeat lives inside lib/lines.js so a
// !banter now (mod force-fire) also respects the cooldown.
let heartbeatTimer = null;
let heartbeatEnabled = true;
let heartbeatBaseMs   = 5 * 60 * 1000;     // 5 min default
let heartbeatJitterMs = 3 * 60 * 1000;     // ±3 min  -> fires every 2-8 min
let heartbeatMinChatMs = 4 * 60 * 1000;    // skip if no chat in 4 min
let hotChatMsgs        = 8;                 // 8+ msgs in window  -> "hot"
let hotChatWindowMs    = 30000;             // 30s sliding window
let coldChatMs         = 90000;             // 90s+ since last msg -> "cold"
let lastChatTs = 0;
const chatTimestamps = [];                  // sliding window for "hot" detection

function noteChatForHeat(ts) {
  chatTimestamps.push(ts);
  const cutoff = ts - hotChatWindowMs;
  while (chatTimestamps.length && chatTimestamps[0] < cutoff) chatTimestamps.shift();
}
function currentHeat() {
  if (chatTimestamps.length >= hotChatMsgs) return 'hot';
  if (Date.now() - lastChatTs > coldChatMs) return 'cold';
  return undefined;        // "normal" — no heat-pool bias
}

function scheduleHeartbeat() {
  if (heartbeatTimer) clearTimeout(heartbeatTimer);
  // Symmetric jitter; clamp at 60s so a misconfig can't spam.
  const jitter = (Math.random() * 2 - 1) * heartbeatJitterMs;
  const delay = Math.max(60000, heartbeatBaseMs + jitter);
  heartbeatTimer = setTimeout(fireHeartbeat, delay);
}
async function fireHeartbeat() {
  scheduleHeartbeat();                                          // always re-arm
  if (!heartbeatEnabled) return;
  if (!twitch.canWrite() || !twitch.connected) return;
  if (Date.now() - lastChatTs > heartbeatMinChatMs) return;     // dead room
  let game = null;
  try { game = await twitchapi.currentGame(); } catch {}
  const ln = lines.banter({ game, heat: currentHeat() });
  if (ln) botSay(ln);
}
function startHeartbeat() { scheduleHeartbeat(); }
function stopHeartbeat()  { if (heartbeatTimer) { clearTimeout(heartbeatTimer); heartbeatTimer = null; } }

// Public-ish controls for the !banter mod command.
function banterControl(action) {
  if (action === 'on')  { heartbeatEnabled = true;  return 'Banter ON 🎙️'; }
  if (action === 'off') { heartbeatEnabled = false; return 'Banter OFF 🤐'; }
  if (action === 'now') { fireHeartbeat().catch(() => {}); return null; }
  // status / default
  const enabled = heartbeatEnabled ? 'ON' : 'OFF';
  const base = Math.round(heartbeatBaseMs / 60000);
  const jit  = Math.round(heartbeatJitterMs / 60000);
  return `Banter ${enabled} · every ~${base}±${jit} min`;
}

// Auto-lock countdowns and duel timeouts post to chat on their own.
bets.setSay(botSay);
games.setSay(botSay);
// Let the !banter mod command drive the heartbeat without a circular require.
commands.setBanterControl((action) => banterControl(action));

function initDb(userDataDir) {
  try {
    db.init(path.join(userDataDir, 'pumpumbot.db'));
    dbOk = true;
  } catch (e) {
    dbOk = false;
    console.error('[bot] DB unavailable, economy disabled:', e.message);
  }
  return dbOk;
}

// Auto-troll: when a viewer accuses the streamer of cheating, the bot
// instantly claps back at them. Word-bounded so "especially"/"respond"
// don't trip it. Global cooldown so spamming accusations can't spam the bot.
const ACCUSE_RE = /\b(hack(s|er|ing|ed|usations?)?|cheat(s|er|ing)?|aimbot\w*|wall ?hack\w*|walling|esp|soft ?aim|no ?recoil|cronus|rage ?hack\w*|radar hack\w*|stream ?snip\w*|cheater)\b/i;
let autoHackTroll = true;
let hackTrollCooldownMs = 20000;
let lastHackTroll = 0;

let clipToken = '';
let clipChannel = '';

function applyConfig(cfg) {
  const currency = cfg.currency || 'PP';
  clipToken = cfg.writeEnabled ? (cfg.botToken || '') : '';
  clipChannel = cfg.channel || '';
  if (typeof cfg.autoHackTroll === 'boolean') autoHackTroll = cfg.autoHackTroll;
  if (typeof cfg.hackTrollCooldownMs === 'number') hackTrollCooldownMs = cfg.hackTrollCooldownMs;
  // Heartbeat config block. Falls back to old tipIntervalMs so existing
  // installs don't suddenly go silent on upgrade.
  const hb = cfg.heartbeat || {};
  if (typeof hb.enabled === 'boolean')         heartbeatEnabled    = hb.enabled;
  if (typeof hb.baseMs === 'number')           heartbeatBaseMs     = hb.baseMs;
  else if (typeof cfg.tipIntervalMs === 'number') heartbeatBaseMs   = cfg.tipIntervalMs;
  if (typeof hb.jitterMs === 'number')         heartbeatJitterMs   = hb.jitterMs;
  if (typeof hb.minChatMs === 'number')        heartbeatMinChatMs  = hb.minChatMs;
  if (typeof hb.hotChatMsgs === 'number')      hotChatMsgs         = hb.hotChatMsgs;
  if (typeof hb.hotChatWindowMs === 'number')  hotChatWindowMs     = hb.hotChatWindowMs;
  if (typeof hb.coldChatMs === 'number')       coldChatMs          = hb.coldChatMs;
  economy.applyConfig(cfg.economy || {});
  commands.applyConfig({
    currency,
    movesCooldownMs: cfg.movesCooldownMs,
    movesWindowMs: cfg.movesWindowMs,
    modMaxAdjust: cfg.modMaxAdjust,
    clipCooldownMs: cfg.clipCooldownMs,
  });
  bets.configure({
    channel: (cfg.channel || '').toLowerCase(),
    lockSeconds: cfg.betLockSeconds || 30,
    houseMult: cfg.betHouseMultiplier,
    houseMaxLoss: cfg.betHouseMaxLoss,
  });
  games.configure({ currency, ...(cfg.games || {}) });
  twitch.configure({
    channel: cfg.channel,
    botUser: cfg.writeEnabled ? cfg.botUser : '',
    token: cfg.writeEnabled ? cfg.botToken : '',
    // Always passed, even read-only: this is how a TTS-only reader knows to
    // skip the bot account (pumpumbott) and other bots. The bot's own write
    // login is added too, so it's covered however the reader is connected.
    ignoreUsers: [
      ...(Array.isArray(cfg.ignoreUsers) ? cfg.ignoreUsers : []),
      cfg.botUser || '',
    ],
  });
}

function start(cfg) {
  applyConfig(cfg);
  if (dbOk) economy.start();
  startHeartbeat();
  twitch.connect();
}

function stop() {
  economy.stop();
  stopHeartbeat();
  twitch.disconnect();
}

// Wire Twitch events once.
twitch.on('status', (state, label) => { onStatus(state, label); try { onLog('SYS', label); } catch {} });

// Once we know the bot's real login, let "!duel @<botname>" route to it.
twitch.on('ready', () => {
  if (twitch.authedAs) games.configure({ botName: twitch.authedAs.toLowerCase() });
  // Set up the Helix client for !clip (validates token + resolves channel).
  if (clipToken && clipChannel) {
    twitchapi.init(clipToken, clipChannel).catch(() => {});
  }
});

twitch.on('message', (m) => {
  const now = Date.now();
  lastChatTs = now;          // "is chat alive?" gate for the heartbeat
  noteChatForHeat(now);      // sliding-window count for "hot chat" detection
  const isCommand = m.text.trim().startsWith('!');

  // 1) TTS: forward to the renderer — but NEVER speak commands. Anything
  //    starting with "!" (from anyone, incl. mods) is excluded from TTS.
  if (!isCommand) {
    try { onChat(m); } catch {}

    // Auto-troll cheater accusations. Global cooldown so a spam of
    // "HACKER HACKER" can't make the bot spam back.
    if (autoHackTroll && ACCUSE_RE.test(m.text)) {
      const now = Date.now();
      if (now - lastHackTroll >= hackTrollCooldownMs) {
        lastHackTroll = now;
        botSay(lines.hacks());
      }
    }
  }

  if (!dbOk) return;

  // 2) Economy: record presence + roles for accrual (commands still count
  //    as activity — typing !pp means you're here).
  try { economy.noteMessage(m.login, m.user, m.flags); } catch {}

  // 3) Commands / bets.
  if (isCommand) {
    try { onLog('IN', `${m.user}: ${m.text}`); } catch {}
    try {
      commands.handle(m, botSay);
    } catch (e) {
      console.error('[bot] command error:', e.message);
    }
  }
});

module.exports = {
  initDb,
  start,
  stop,
  applyConfig,
  isDbOk: () => dbOk,
  setHandlers: (handlers) => {
    if (handlers.onStatus) onStatus = handlers.onStatus;
    if (handlers.onChat) onChat = handlers.onChat;
    if (handlers.onLog) onLog = handlers.onLog;
  },
  betStatus: () => bets.status(),
  banterControl,        // !banter on/off/now/status hook for commands.js
};
