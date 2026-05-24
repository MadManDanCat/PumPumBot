'use strict';
// Command router. Designed for a fast stream: one-word betting, viewer
// games, mod economy tools. Cooldowns keep chat clean; mods bypass them.

const db = require('./db');
const bets = require('./bets');
const games = require('./games');
const lines = require('./lines');
const twitchapi = require('./twitchapi');
// const sr = require('./songrequest');  // disabled for now

const GLOBAL_CD_MS = 3000;
const USER_CD_MS = 8000;
const lastGlobal = new Map();
const lastUser = new Map();

let CURRENCY = 'PP';
let MOVES_CD_MS = 45000;       // !moves is a "moment" — longer cooldown
let MOVES_WINDOW_MS = 900000;  // pick from anyone who chatted in last 15 min
let MOD_MAX = 1000000;         // max points a mod can move in one command
let CLIP_CD_MS = 30000;        // global cooldown so !clip can't spam the API
let lastMoves = 0;
let lastClip = 0;

// Injected by bot.js — lets !banter drive the heartbeat without
// creating a circular require (commands <-> bot).
let banterControl = null;
function setBanterControl(fn) { if (typeof fn === 'function') banterControl = fn; }
function applyConfig(c = {}) {
  if (c.currency) CURRENCY = c.currency;
  if (c.movesCooldownMs) MOVES_CD_MS = c.movesCooldownMs;
  if (c.movesWindowMs) MOVES_WINDOW_MS = c.movesWindowMs;
  if (c.modMaxAdjust) MOD_MAX = c.modMaxAdjust;
  if (c.clipCooldownMs) CLIP_CD_MS = c.clipCooldownMs;
}

// Parse a mod-tool amount: integer, finite, within [0, MOD_MAX]. null = bad.
function modAmount(raw) {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n < 0 || n > MOD_MAX) return null;
  return n;
}

function isPriv(flags) { return !!(flags && (flags.mod || flags.broadcaster)); }
function fmt(n) { return Number(n).toLocaleString('en-US'); }

function onCooldown(name, login, flags) {
  if (isPriv(flags)) return false;
  const now = Date.now();
  if (now - (lastGlobal.get(name) || 0) < GLOBAL_CD_MS) return true;
  const uk = name + '|' + login;
  if (now - (lastUser.get(uk) || 0) < USER_CD_MS) return true;
  lastGlobal.set(name, now);
  lastUser.set(uk, now);
  return false;
}

function handle(msg, say) {
  const text = msg.text.trim();
  if (!text.startsWith('!')) return;
  const parts = text.slice(1).split(/\s+/);
  const name = (parts[0] || '').toLowerCase();
  const a = parts.slice(1);
  const { login, user: display, flags } = msg;
  const priv = isPriv(flags);

  switch (name) {
    // ---- Economy lookups ----
    case 'pp': case 'points': case 'bal': case 'balance': {
      if (onCooldown('pp', login, flags)) return;
      const v = db.getViewer(login);
      return say(`${display} you have ${fmt(v ? v.balance : 0)} ${CURRENCY} · rank: ${db.rankFor(v ? v.lifetime : 0)}`);
    }
    case 'rank': {
      if (onCooldown('rank', login, flags)) return;
      const life = db.lifetimeOf(login);
      const r = db.rankInfo(life);
      const tail = r.nextAt == null
        ? ' — MASTER 👑'
        : ` (${fmt(r.toNext)} ${CURRENCY} to next)`;
      return say(`${display} rank: ${r.name}${tail}`);
    }
    case 'top': case 'leaderboard': case 'lb': {
      if (onCooldown('top', login, flags)) return;
      const rows = db.topViewers(5);
      if (!rows.length) return say('No points earned yet — start chatting!');
      return say(`🏆 Top ${CURRENCY}: ` +
        rows.map((r, i) => `${i + 1}. ${r.display} ${fmt(r.balance)}`).join('  ·  '));
    }

    // ---- Betting: one-word place ----
    case 'win':  return placeWinLose('WIN', a[0], msg, say, priv);
    case 'lose': return placeWinLose('LOSE', a[0], msg, say, priv);
    case 'pot': case 'odds': {
      if (onCooldown('pot', login, flags)) return;
      return say(bets.status().msg);
    }

    // ---- Betting: mod settle shortcuts ----
    case 'won': case 'lost': {
      if (!priv) return;
      if (!bets.isActive()) return say('No bet running.');
      if (!bets.isWinLose()) return say('This bet has custom outcomes — use !result <OUTCOME>.');
      return say(bets.settle(name === 'won' ? 'WIN' : 'LOSE').msg);
    }
    case 'result': {
      if (!priv) return;
      return say(bets.settle(a[0]).msg);
    }
    case 'lock': {
      if (!priv) return;
      const r = bets.lock(true);
      if (r.msg) say(r.msg);
      return;
    }
    case 'refund': case 'cancel': {
      if (!priv) return;
      return say(bets.cancel().msg);
    }
    case 'undo': case 'unsettle': {
      if (!priv) return;
      return say(bets.undoLast().msg);
    }
    case 'bet': {
      // !bet (no args): mod -> open default WIN/LOSE bet; viewer -> status.
      if (a.length === 0) {
        if (!priv) return say(bets.status().msg);
        const r = bets.open([]);
        if (r.msg) say(r.msg);
        return;
      }
      // Args while a bet is live and the first token is a valid outcome -> place.
      if (bets.isActive()) {
        const r = bets.place(login, display, a[0], a[1], priv);
        if (r.ok || r.msg) { if (r.msg) say(r.msg); return; }
      }
      // Otherwise a mod is opening a new (possibly custom) bet.
      if (!priv) return say(bets.status().msg);
      const r = bets.open(a);
      if (r.msg) say(r.msg);
      return;
    }

    // ---- Viewer games ----
    case 'gamble': case 'roll': {
      if (onCooldown('gamble', login, flags)) return;
      return say(games.gamble(login, display, a[0]));
    }
    case 'give': {
      return say(games.give(login, display, a[0], a[1]));
    }
    case 'duel': {
      return say(games.duel(login, display, a[0], a[1]));
    }
    case 'duelbot': case 'fightbot': {
      if (onCooldown('duelbot', login, flags)) return;
      return say(games.duelBot(login, display, a[0]));
    }
    case 'accept': {
      const m = games.accept(login, display);
      if (m) say(m);
      return;
    }
    case 'decline': {
      const m = games.decline(login, display);
      if (m) say(m);
      return;
    }

    // ---- Duel records ----
    case 'record': case 'stats': case 'duelrecord': {
      if (onCooldown('record', login, flags)) return;
      // Optional @target — falls back to the caller's own record.
      const raw = a[0] ? a[0].replace(/^@/, '').toLowerCase().replace(/[^a-z0-9_]/g, '') : login;
      const target = raw || login;
      const r = db.duelRecord(target);
      const total = r.wins + r.losses;
      if (total === 0) {
        return say(target === login
          ? `${display} no duels yet — type !duel <user> <amount> to start.`
          : `${target} hasn't duelled yet.`);
      }
      const wr = Math.round((r.wins / total) * 100);
      const streakBit = r.streak > 0 ? ` · 🔥 ${r.streak} streak` : '';
      return say(`${target} — ${r.wins}W ${r.losses}L (${wr}% of ${total})${streakBit} · best ${r.best}`);
    }
    case 'streak': case 'winstreak': {
      if (onCooldown('streak', login, flags)) return;
      const r = db.duelRecord(login);
      if (r.streak === 0) {
        return say(r.best > 0
          ? `${display} no current streak — best ever ${r.best}. Get back on it.`
          : `${display} no duel streak yet — type !duelbot <amount> to start one.`);
      }
      const pb = r.streak === r.best ? ' (personal best!)' : ` (best ${r.best})`;
      return say(`${display} on a ${r.streak}-W streak${pb} 🔥`);
    }
    case 'topduels': case 'topduel': case 'duellb': {
      if (onCooldown('topduels', login, flags)) return;
      const rows = db.topDuelers(5);
      if (!rows.length) return say('No duels yet — somebody throw down!');
      return say('⚔️ Top duelers: ' + rows.map((r, i) =>
        `${i + 1}. ${r.display} ${r.duel_wins}W` + (r.duel_best > 1 ? ` (best ${r.duel_best})` : '')
      ).join(' · '));
    }

    // ---- Mod economy tools ----
    case 'addpp': case 'givepp': {
      if (!priv) return;
      const t = (a[0] || '').replace(/^@/, '').toLowerCase().replace(/[^a-z0-9_]/g, '');
      const n = modAmount(a[1]);
      if (!t || n == null) return say(`Usage: !addpp <user> <amount> (max ${fmt(MOD_MAX)})`);
      db.modAdjust(t, n, t);
      return say(`✅ Gave ${fmt(n)} ${CURRENCY} to ${t}.`);
    }
    case 'rmpp': case 'takepp': {
      if (!priv) return;
      const t = (a[0] || '').replace(/^@/, '').toLowerCase().replace(/[^a-z0-9_]/g, '');
      const n = modAmount(a[1]);
      if (!t || n == null) return say(`Usage: !rmpp <user> <amount> (max ${fmt(MOD_MAX)})`);
      db.modAdjust(t, -n, t);
      return say(`✅ Took ${fmt(n)} ${CURRENCY} from ${t}.`);
    }
    case 'setpp': {
      if (!priv) return;
      const t = (a[0] || '').replace(/^@/, '').toLowerCase().replace(/[^a-z0-9_]/g, '');
      const n = modAmount(a[1]);
      if (!t || n == null) return say(`Usage: !setpp <user> <amount> (max ${fmt(MOD_MAX)})`);
      db.setBalance(t, n, t);
      return say(`✅ Set ${t} to ${fmt(n)} ${CURRENCY}.`);
    }

    // ---- Custom command management ----
    case 'addcom': case 'editcom': {
      if (!priv) return;
      const cmd = (a[0] || '').replace(/^!/, '').toLowerCase();
      const resp = a.slice(1).join(' ');
      if (!cmd || !resp) return say('Usage: !addcom !name your response text');
      db.setCommand(cmd, resp, login);
      return say(`✅ Saved !${cmd}`);
    }
    case 'delcom': {
      if (!priv) return;
      const cmd = (a[0] || '').replace(/^!/, '').toLowerCase();
      return say(db.delCommand(cmd) ? `🗑️ Deleted !${cmd}` : `!${cmd} doesn't exist.`);
    }
    // ---- Stream banter ----
    case 'moves': case 'whosgotthemoves': {
      const now = Date.now();
      if (!priv && now - lastMoves < MOVES_CD_MS) return;
      const v = db.randomActiveViewer(MOVES_WINDOW_MS);
      if (!v) return say("Nobody's got the moves right now... chat's dead, sunshine 💀");
      lastMoves = now;
      return say(lines.moves({ user: v.display }));
    }
    case 'general': case 'g': case 'guvnah': case 'guvnor': case 'sean': {
      if (onCooldown('general', login, flags)) return;
      return say(lines.general());
    }
    case 'mrx': case 'mister x': case 'misterx': {
      if (onCooldown('mrx', login, flags)) return;
      return say(lines.mrx());
    }
    case 'jimmy': {
      if (onCooldown('jimmy', login, flags)) return;
      return say(lines.jimmy());
    }
    case 'ibra': {
      if (onCooldown('ibra', login, flags)) return;
      return say(lines.ibra());
    }
    case 'hacks': case 'hacker': case 'cheating': {
      if (onCooldown('hacks', login, flags)) return;
      return say(lines.hacks());
    }
    case 'hunt': case 'hunted': {
      if (onCooldown('hunt', login, flags)) return;
      return say(lines.hunt());
    }
    // ---- Song Requests (disabled) ----
    case 'sr': case 'songrequest': case 'request':
    case 'skipsong': case 'nextsong': case 'ns':
    case 'queue': case 'songqueue': case 'sq':
    case 'volume': case 'vol':
      return say('Song requests are offline right now.');


    case 'clip': {
      const now = Date.now();
      if (!priv && now - lastClip < CLIP_CD_MS) return;
      lastClip = now;
      twitchapi.createClip()
        .then((url) => say(`📸 Clip! ${url}`))
        .catch((e) => say(`📸 ${e.message}`));
      return;
    }

    // ---- Heartbeat / ambient banter control (mod only) ----
    // !banter            -> status
    // !banter on / off   -> toggle the auto-banter loop
    // !banter now        -> force-fire one line right now (still anti-repeat)
    case 'banter': {
      if (!priv) return;
      if (!banterControl) return say('Banter system not wired yet.');
      const action = (a[0] || 'status').toLowerCase();
      const msg = banterControl(action);
      if (msg) say(msg);
      return;
    }

    case 'commands': case 'help': {
      // Per-user cooldown only (no global) — different viewers must never
      // block each other from getting help.
      if (!priv) {
        const k = 'help|' + login;
        if (Date.now() - (lastUser.get(k) || 0) < 6000) return;
        lastUser.set(k, Date.now());
      }
      const topic = (a[0] || '').toLowerCase();
      const G = {
        bets:   '🎰 BETS — !win <amount> / !lose <amount> · !pot (current odds)',
        games:  '🎮 GAMES — !gamble <amount> · !duel <user> <amount> · !duelbot <amount> · !give <user> <amount> · !accept / !decline · !record · !streak · !topduels',
        points: '💰 POINTS — !pp (balance) · !rank · !top',
        fun:    '😎 FUN — !clip · !moves · !g · !mrx · !jimmy · !ibra · !hacks · !hunt',
        music:  `🎵 MUSIC — !sr <song> (costs ${CURRENCY}) · !queue · Mods: !skipsong · !volume <0-100>`,
      };
      if (G[topic]) return say(G[topic]);
      if (topic === 'custom') {
        const custom = db.listCommands().map(c => '!' + c);
        return say(custom.length ? `📌 CUSTOM — ${custom.join(' · ')}` : 'No custom commands yet.');
      }
      if (topic === 'mod') {
        if (!priv) return;
        return say('🛡️ MOD — !bet [Q] / !won / !lost / !undo / !lock / !refund · !addpp !rmpp !setpp <user> <amount> · !addcom !delcom · !banter on/off/now/status (mods/streamer can\'t place bets)');
      }
      // Default: show the most-used commands inline THEN point to topics, so
      // a brand-new viewer gets something usable in one message.
      return say('💬 Earn PP just by chatting! Check it: !pp · Play: !gamble <amount> · !duel <user> <amount> · 🎵 !sr <song> · More: !commands games / points / music / fun' +
        (priv ? ' / mod' : ''));
    }

    default: {
      const custom = db.getCommand(name);
      if (custom != null) {
        if (onCooldown('c:' + name, login, flags)) return;
        return say(custom.replace(/\$\{user\}/g, display));
      }
    }
  }
}

let lastNoBetHint = 0;
function placeWinLose(choice, amount, msg, say, priv) {
  // No silent failure: tell viewers when there's nothing to bet on.
  if (!bets.isActive()) {
    const now = Date.now();
    if (now - lastNoBetHint > 8000) {
      lastNoBetHint = now;
      say(`${msg.user} no bet running right now — wait for the streamer to open one. Try !pp or !gamble meanwhile.`);
    }
    return;
  }
  const r = bets.place(msg.login, msg.user, choice, amount, priv);
  if (r.msg) say(r.msg);
}

module.exports = { handle, applyConfig, setBanterControl };
