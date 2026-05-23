'use strict';
// Hype Bets — built for speed on a live fighting/extraction stream.
//   !bet                 -> opens "Will <channel> win?" WIN/LOSE
//   !bet <question>      -> same, custom question, still WIN/LOSE
//   !bet Q | A | B | C   -> advanced: custom outcomes
// Auto-locks after a timer (no manual !lock needed). Settle with one word:
//   !won  -> WIN wins   ·   !lost -> LOSE wins   ·   !result <X> for custom
// Pari-mutuel: winners split the loser pool proportional to stake.

const db = require('./db');

let state = 'idle';            // idle | open | locked
let question = '';
let outcomes = [];             // upper-cased
let entries = new Map();        // login -> { display, choice, amount }
let lockTimer = null;
let warnTimer = null;
let channelName = '';

let say = () => {};            // injected by bot.js
let lockSeconds = 30;

// House-backed fixed odds: a winning bet pays stake x MULT. MULT < 2.0 is
// the house edge (1.9 = 5%), so betting the obvious side is -EV long-term.
// The bot covers the other side so even ONE bet pays out — but its net
// loss on a single bet is hard-capped so it can't be drained.
let houseMult = 1.9;
let houseMaxLoss = 5000;

// Snapshot of the last settlement so a mis-fired !won/!lost can be reversed.
let lastSettlement = null;     // { entries, outcomes, question, payouts, ts }
const UNDO_WINDOW_MS = 120000; // 2 min to catch a mistake

function configure({ channel, lockSeconds: ls, houseMult: hm, houseMaxLoss: hl }) {
  if (channel) channelName = channel;
  if (ls && isFinite(ls)) lockSeconds = Math.max(10, Math.min(600, ls));
  if (hm && isFinite(hm)) houseMult = Math.max(1.05, Math.min(3, hm));
  if (hl != null && isFinite(hl)) houseMaxLoss = Math.max(0, hl);
}
function setSay(fn) { if (typeof fn === 'function') say = fn; }

function norm(s) { return String(s || '').trim().toUpperCase(); }
function isActive() { return state === 'open' || state === 'locked'; }
// Shared sanity ceiling — rejects scientific-notation / overflow abuse.
const MAX_AMOUNT = 1e12;
function parseAmount(raw) {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n <= 0 || n > MAX_AMOUNT) return null;
  return n;
}
const RESERVED = new Set(['OPEN', 'LOCK', 'CANCEL', 'RESULT', 'STATUS', 'WON', 'LOST']);

function clearTimers() {
  if (lockTimer) { clearTimeout(lockTimer); lockTimer = null; }
  if (warnTimer) { clearTimeout(warnTimer); warnTimer = null; }
}

// rawArgs: array after "!bet". Supports "Q | A | B" advanced form.
function open(rawArgs) {
  if (isActive()) return { ok: false, msg: 'A bet is already running. !won / !lost / !refund first.' };

  const joined = (rawArgs || []).join(' ').trim();
  let q, outs;
  if (joined.includes('|')) {
    const segs = joined.split('|').map(s => s.trim()).filter(Boolean);
    q = segs[0] || `Will ${channelName} win?`;
    outs = [...new Set(segs.slice(1).map(norm))].filter(o => o && !RESERVED.has(o));
    if (outs.length < 2) return { ok: false, msg: `Need 2+ outcomes; none can be: ${[...RESERVED].join(', ')}` };
  } else {
    q = joined || `Will ${channelName} win?`;
    outs = ['WIN', 'LOSE'];
  }

  question = q;
  outcomes = outs;
  entries = new Map();
  state = 'open';
  lastSettlement = null;   // a new bet voids any pending undo

  const how = outcomes.length === 2 && outcomes[0] === 'WIN'
    ? `type !win <amount> or !lose <amount>`
    : `type !bet <${outcomes.join('/')}> <amount>`;
  say(`🎰 BET OPEN — ${question} | ${how}. Win pays ${houseMult}x. Closes in ${lockSeconds}s!`);

  clearTimers();
  if (lockSeconds > 15) {
    warnTimer = setTimeout(() => {
      try { if (state === 'open') say(`⏳ 10 seconds left to bet on: ${question}`); } catch {}
    }, (lockSeconds - 10) * 1000);
  }
  // Auto-lock MUST be bulletproof — a failed chat-send can't leave a bet open.
  lockTimer = setTimeout(() => {
    try { if (state === 'open') autoLock(); } catch (e) { state = 'locked'; }
  }, lockSeconds * 1000);

  return { ok: true, msg: null };
}

function place(login, display, choiceRaw, amountRaw, priv) {
  if (state !== 'open') return { ok: false, msg: null };
  // Anti-rig: whoever can settle a bet must not be able to wager in it.
  if (priv) {
    return { ok: false, msg: `${display} mods/streamer can't bet — you run the show 😎` };
  }
  const choice = norm(choiceRaw);
  if (!outcomes.includes(choice)) {
    return { ok: false, msg: `${display} options: ${outcomes.join(', ')}` };
  }
  const amount = parseAmount(amountRaw);
  if (amount == null) {
    return { ok: false, msg: `${display} bet a positive amount, e.g. !${choice.toLowerCase()} 100` };
  }
  if (entries.has(login)) {
    return { ok: false, msg: `${display} you already bet this round.` };
  }
  if (!db.spendPoints(login, amount)) {
    return { ok: false, msg: `${display} not enough — you have ${db.balanceOf(login)}.` };
  }
  entries.set(login, { display, choice, amount });
  return { ok: true, msg: null };
}

function totals() {
  const byChoice = {};
  let pot = 0;
  for (const e of entries.values()) {
    byChoice[e.choice] = (byChoice[e.choice] || 0) + e.amount;
    pot += e.amount;
  }
  return { byChoice, pot };
}

function lock(manual) {
  if (state !== 'open') return { ok: false, msg: manual ? 'No open bet to lock.' : null };
  state = 'locked';            // flip FIRST — betting is closed no matter what
  clearTimers();
  try {
    const t = totals();
    const parts = outcomes.map(o => `${o} ${t.byChoice[o] || 0}`);
    say(`🔒 BETS CLOSED. Pot ${t.pot} — ${parts.join(' · ')}. Awaiting result…`);
  } catch {}
  return { ok: true, msg: null };
}
function autoLock() { lock(false); }

function settle(winnerRaw) {
  if (!isActive()) return { ok: false, msg: 'No bet to settle.' };
  const winner = norm(winnerRaw);
  if (!outcomes.includes(winner)) {
    return { ok: false, msg: `Result must be one of: ${outcomes.join(', ')}` };
  }
  clearTimers();

  const snapEntries = new Map(entries);
  const snapOutcomes = [...outcomes];
  const snapQ = question;
  const payouts = [];

  if (entries.size === 0) {
    _reset();
    return { ok: true, msg: `No bets were placed. ${winner} it is.` };
  }

  const winners = [...entries.entries()].filter(([, e]) => e.choice === winner);
  const losers  = [...entries.entries()].filter(([, e]) => e.choice !== winner);
  const loseStake = losers.reduce((s, [, e]) => s + e.amount, 0);

  // Nobody backed the winning side — every stake was already debited, the
  // house just keeps them. Nothing to pay out.
  if (winners.length === 0) {
    _reset();
    lastSettlement = { entries: snapEntries, outcomes: snapOutcomes, question: snapQ, payouts: [], ts: Date.now() };
    return { ok: true, msg: `🏠 ${winner} wins — nobody backed it. House keeps ${loseStake}. (mods: !undo within 2 min)` };
  }

  // House-backed fixed odds: each winner is paid stake x houseMult.
  // Bot net = recovered loser stakes − total paid. If the bot would lose
  // more than houseMaxLoss on this bet, scale payouts down to the cap.
  let gross = 0;
  for (const [, e] of winners) gross += Math.floor(e.amount * houseMult);
  let scale = 1;
  const botLoss = gross - loseStake;
  if (botLoss > houseMaxLoss) {
    scale = (loseStake + houseMaxLoss) / gross;   // bot loss == cap exactly
  }

  let top = null;
  for (const [login, e] of winners) {
    const payout = Math.max(1, Math.floor(e.amount * houseMult * scale));
    db.addBalance(login, payout, e.display);
    payouts.push({ login, amount: payout });
    if (!top || payout > top.payout) top = { display: e.display, payout };
  }

  const odds = scale < 1 ? `${(houseMult * scale).toFixed(2)}x (house cap hit)` : `${houseMult}x`;
  const msg = `🏆 ${winner} WINS! ${winners.length} paid out at ${odds}` +
    (top ? ` — biggest: ${top.display} +${top.payout}.` : '.');
  _reset();
  lastSettlement = { entries: snapEntries, outcomes: snapOutcomes, question: snapQ, payouts, ts: Date.now() };
  return { ok: true, msg: msg + ' (mods: !undo within 2 min)' };
}

function cancel() {
  if (!isActive()) return { ok: false, msg: 'No bet to cancel.' };
  clearTimers();
  for (const [login, e] of entries) db.addBalance(login, e.amount, e.display);
  _reset();
  return { ok: true, msg: '❌ Bet cancelled — all stakes refunded.' };
}

// Reverse the last settlement (mod mis-fired !won/!lost). Claws back each
// payout (clamped at 0 if already spent) and re-locks the bet so the mod
// can call the correct result.
function undoLast() {
  if (!lastSettlement) return { ok: false, msg: 'Nothing to undo.' };
  if (isActive()) return { ok: false, msg: "Can't undo — a new bet is already running." };
  if (Date.now() - lastSettlement.ts > UNDO_WINDOW_MS) {
    lastSettlement = null;
    return { ok: false, msg: 'Too late to undo (over 2 min).' };
  }
  for (const p of lastSettlement.payouts) db.modAdjust(p.login, -p.amount, p.login);
  entries = new Map(lastSettlement.entries);
  outcomes = [...lastSettlement.outcomes];
  question = lastSettlement.question;
  state = 'locked';
  lastSettlement = null;
  return { ok: true, msg: '↩️ Settlement reversed — bet re-LOCKED. Call !won / !lost / !result again.' };
}

function status() {
  if (!isActive()) return { ok: true, state: 'idle', msg: 'No bet running right now.' };
  const t = totals();
  return {
    ok: true, state, question, outcomes, pot: t.pot, byChoice: t.byChoice, count: entries.size,
    msg: `${state === 'open' ? '🎰 OPEN' : '🔒 LOCKED'}: ${question} | ` +
         outcomes.map(o => `${o} ${t.byChoice[o] || 0}`).join(' · ') + ` | pot ${t.pot}`,
  };
}

function _reset() {
  clearTimers();
  state = 'idle'; question = ''; outcomes = []; entries = new Map();
}

module.exports = {
  configure, setSay, open, place, lock, settle, cancel, undoLast, status, isActive,
  // helpers for the !won / !lost shortcuts (only valid for WIN/LOSE bets)
  isWinLose: () => outcomes.length === 2 && outcomes.includes('WIN') && outcomes.includes('LOSE'),
};
