'use strict';
// Viewer games: !gamble, !duel/!accept/!decline, !give.
// All point moves go through db's atomic helpers so balances can't desync.

const db = require('./db');
const lines = require('./lines');

let say = () => {};
function setSay(fn) { if (typeof fn === 'function') say = fn; }

let CFG = {
  currency: 'PP',
  gambleWinChance: 0.47,   // < 0.5 keeps the economy from inflating
  gambleMin: 10,
  gambleMax: 50000,
  giveMin: 1,
  giveCooldownMs: 30000,
  duelMin: 10,
  duelExpiryMs: 60000,
  // Bot duel (always-available fallback). House edge is the real anti-farm:
  // botDuelWinChance is the BOT's chance to win, so >0.5 = farming loses.
  botName: '',
  botDuelWinChance: 0.52,
  botDuelCooldownMs: 60000,
  botDuelMax: 5000,
};
function configure(c = {}) { CFG = { ...CFG, ...c }; }

const giveCooldown = new Map();          // login -> ts
const botDuelCooldown = new Map();       // login -> ts
const pendingDuels = new Map();          // targetLogin -> {fromLogin,fromDisplay,toLogin,amount,timer}

function parseTarget(raw) {
  return String(raw || '').replace(/^@/, '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '');
}
const MAX_AMOUNT = 1e12;  // shared sanity ceiling vs scientific-notation abuse
function amt(raw) {
  const n = Math.floor(Number(raw));
  return (Number.isFinite(n) && n > 0 && n <= MAX_AMOUNT) ? n : null;
}

// ---------- Gamble ----------
function gamble(login, display, amountRaw) {
  const a = amt(amountRaw);
  if (!a) return `${display} usage: !gamble <amount>`;
  if (a < CFG.gambleMin) return `${display} minimum gamble is ${CFG.gambleMin} ${CFG.currency}.`;
  if (a > CFG.gambleMax) return `${display} max gamble is ${CFG.gambleMax} ${CFG.currency}.`;
  if (!db.spendPoints(login, a)) return `${display} you only have ${db.balanceOf(login)} ${CFG.currency}.`;
  if (Math.random() < CFG.gambleWinChance) {
    db.addBalance(login, a * 2, display);           // net +a, no rank inflation
    return `🎲 ${display} WON and doubled to ${a * 2}! Balance: ${db.balanceOf(login)} ${CFG.currency}.`;
  }
  return `💀 ${display} lost ${a} ${CFG.currency}. Balance: ${db.balanceOf(login)}.`;
}

// ---------- Give ----------
function give(fromLogin, fromDisplay, targetRaw, amountRaw) {
  const to = parseTarget(targetRaw);
  const a = amt(amountRaw);
  if (!to || !a) return `${fromDisplay} usage: !give <user> <amount>`;
  if (to === fromLogin) return `${fromDisplay} you can't give to yourself.`;
  if (a < CFG.giveMin) return `${fromDisplay} minimum is ${CFG.giveMin} ${CFG.currency}.`;
  const now = Date.now();
  if (now - (giveCooldown.get(fromLogin) || 0) < CFG.giveCooldownMs) {
    return `${fromDisplay} slow down — wait before giving again.`;
  }
  if (!db.transfer(fromLogin, to, a, to)) {
    return `${fromDisplay} not enough ${CFG.currency} (you have ${db.balanceOf(fromLogin)}).`;
  }
  giveCooldown.set(fromLogin, now);
  return `🎁 ${fromDisplay} gave ${a} ${CFG.currency} to ${to}.`;
}

// ---------- Bot duel (always-available, house-edged) ----------
function isBotTarget(t) {
  return t === 'bot' || t === 'thebot' || (CFG.botName && t === CFG.botName);
}

function duelBot(login, display, amountRaw) {
  const a = amt(amountRaw);
  if (!a) return `${display} usage: !duelbot <amount>`;
  if (a < CFG.duelMin) return `${display} minimum duel is ${CFG.duelMin} ${CFG.currency}.`;
  if (a > CFG.botDuelMax) return `${display} max bot duel is ${CFG.botDuelMax} ${CFG.currency}.`;
  const now = Date.now();
  const wait = CFG.botDuelCooldownMs - (now - (botDuelCooldown.get(login) || 0));
  if (wait > 0) return `${display} you can duel the bot again in ${Math.ceil(wait / 1000)}s.`;
  if (!db.spendPoints(login, a)) {
    return `${display} you only have ${db.balanceOf(login)} ${CFG.currency}.`;
  }
  botDuelCooldown.set(login, now);
  // CFG.botDuelWinChance is the BOT's win probability. Bot duels count toward
  // the same streak/record as PvP duels — 52% bot edge means streak-farming
  // against the bot is mathematically a losing strategy, so it's safe to merge.
  if (Math.random() >= CFG.botDuelWinChance) {
    db.addBalance(login, a * 2, display);         // net +a, no rank inflation
    const winRec = db.recordDuelWin(login, display);
    const streakLine = lines.duelStreak(display, winRec.streak);
    return `⚔️🤖 ${display} steps to the bot! ${lines.clash()} ${display} wins — +${a * 2} ${CFG.currency}. ${lines.duelBotWin()}`
         + (streakLine ? ' ' + streakLine : '')
         + ` (bal ${db.balanceOf(login)})`;
  }
  db.recordDuelLoss(login, display);
  return `⚔️🤖 ${display} steps to the bot! ${lines.clash()} the bot wins — ${display} loses ${a} ${CFG.currency}. ${lines.duelBotLose()} (bal ${db.balanceOf(login)})`;
}

// ---------- Duel ----------
function duel(fromLogin, fromDisplay, targetRaw, amountRaw) {
  // "!duel 50" (numeric first arg, no second) -> bot duel.
  if (amt(targetRaw) != null && (amountRaw === undefined || amountRaw === '')) {
    return duelBot(fromLogin, fromDisplay, targetRaw);
  }
  // "!duel bot 50" / "!duel @<botname> 50" -> bot duel.
  const rawT = parseTarget(targetRaw);
  if (isBotTarget(rawT)) return duelBot(fromLogin, fromDisplay, amountRaw);

  const to = rawT;
  const a = amt(amountRaw);
  if (!to || !a) return `${fromDisplay} usage: !duel <user> <amount> (or !duelbot <amount>)`;
  if (to === fromLogin) return `${fromDisplay} you can't duel yourself.`;
  if (a < CFG.duelMin) return `${fromDisplay} minimum duel is ${CFG.duelMin} ${CFG.currency}.`;
  if (pendingDuels.has(to)) return `${fromDisplay} ${to} already has a pending duel.`;
  for (const d of pendingDuels.values()) {
    if (d.fromLogin === fromLogin) return `${fromDisplay} you already have a duel pending.`;
  }
  if (db.balanceOf(fromLogin) < a) return `${fromDisplay} you only have ${db.balanceOf(fromLogin)} ${CFG.currency}.`;

  const timer = setTimeout(() => {
    if (pendingDuels.get(to)) {
      pendingDuels.delete(to);
      say(`⌛ ${fromDisplay}'s duel challenge to ${to} expired.`);
    }
  }, CFG.duelExpiryMs);

  pendingDuels.set(to, { fromLogin, fromDisplay, toLogin: to, amount: a, timer });
  return `⚔️ ${fromDisplay} challenges ${to} to a ${a} ${CFG.currency} duel! ${to} type !accept or !decline (${Math.round(CFG.duelExpiryMs/1000)}s).`;
}

function accept(login, display) {
  const d = pendingDuels.get(login);
  if (!d) return null;
  clearTimeout(d.timer);
  pendingDuels.delete(login);

  // Take both stakes atomically; if either can't cover (balance changed
  // since the challenge), refund and abort — never create or destroy points.
  if (!db.spendPoints(d.fromLogin, d.amount)) {
    return `${display} duel off — ${d.fromDisplay} can't cover it now.`;
  }
  if (!db.spendPoints(login, d.amount)) {
    db.addBalance(d.fromLogin, d.amount, d.fromDisplay);   // refund challenger
    return `${display} you only have ${db.balanceOf(login)} ${CFG.currency}.`;
  }
  const challengerWins = Math.random() < 0.5;
  const winName  = challengerWins ? d.fromDisplay : display;
  const loseName = challengerWins ? display       : d.fromDisplay;
  const winLogin  = challengerWins ? d.fromLogin : login;
  const loseLogin = challengerWins ? login       : d.fromLogin;
  db.addBalance(winLogin, d.amount * 2, winName);

  // Record W/L. Streak callout fires only AT milestone thresholds (3/5/10
  // /20/50/100), so non-milestone wins stay quiet — keeps it from spamming.
  const winRec = db.recordDuelWin(winLogin, winName);
  db.recordDuelLoss(loseLogin, loseName);
  const streakLine = lines.duelStreak(winName, winRec.streak);

  return `⚔️ ${d.fromDisplay} vs ${display}! ${lines.clash()} ${winName} takes it — ${d.amount * 2} ${CFG.currency}. ${lines.duelHumanWin()}`
       + (streakLine ? ' ' + streakLine : '');
}

function decline(login, display) {
  const d = pendingDuels.get(login);
  if (!d) return null;
  clearTimeout(d.timer);
  pendingDuels.delete(login);
  return `🛡️ ${display} declined ${d.fromDisplay}'s duel.`;
}

module.exports = { setSay, configure, gamble, give, duel, duelBot, accept, decline };
