'use strict';
// Per-minute points accrual — anti-AFK by design.
// You only earn for a tick if you sent a NEW message since the last tick.
// So coasting on one message per 10 min is dead: to keep earning you must
// keep chatting every interval, which is visible spam a mod will catch.
// Subs/mods/vips earn multipliers. Roles tracked in memory (per session).

const db = require('./db');

const DEFAULTS = {
  intervalMs: 60000,        // pay every minute
  activeWindowMs: 600000,   // only consider viewers seen in last 10 min
  recentMs: 60000,          // "recent" = chatted in last 60s -> bonus
  base: 3,                  // PP/min for an active chatter
  recentBonus: 2,           // extra PP/min if recently chatted
  subMult: 2,
  modMult: 3,
  vipMult: 2,
  currency: 'PP',
};

let cfg = { ...DEFAULTS };
let timer = null;
const roles = new Map();      // login -> {sub,mod,vip}
const paidSeen = new Map();   // login -> last_seen value at last payout

function applyConfig(c = {}) {
  cfg = { ...DEFAULTS, ...c };
}

function noteMessage(login, display, flags) {
  if (!db.isReady()) return;
  roles.set(login, {
    sub: !!flags.subscriber,
    mod: !!flags.mod || !!flags.broadcaster,
    vip: !!flags.vip,
  });
  db.touch(login, display, Date.now());
}

function multiplierFor(viewerRow) {
  const r = roles.get(viewerRow.username) || {};
  if (r.mod) return cfg.modMult;
  let m = 1;
  if (r.sub) m = Math.max(m, cfg.subMult);
  if (r.vip) m = Math.max(m, cfg.vipMult);
  return m;
}

function tick() {
  if (!db.isReady()) return;
  try {
    const now = Date.now();
    const rows = db.activeViewers(cfg.activeWindowMs);
    for (const v of rows) {
      // Must have chatted SINCE we last paid them — no new message, no pay.
      const lastPaid = paidSeen.get(v.username) || 0;
      if (v.last_seen <= lastPaid) continue;

      const recent = (now - v.last_seen) <= cfg.recentMs;
      let amt = cfg.base + (recent ? cfg.recentBonus : 0);
      amt = Math.round(amt * multiplierFor(v));
      db.addAccrual(v.username, amt);   // balance+lifetime, does NOT bump last_seen
      paidSeen.set(v.username, v.last_seen);
    }
    // Bound memory: forget anyone not seen within the window.
    if (paidSeen.size > 2000) {
      const cutoff = now - cfg.activeWindowMs;
      for (const [u, t] of paidSeen) if (t < cutoff) paidSeen.delete(u);
    }
  } catch (e) {
    console.error('[economy] tick failed:', e.message);
  }
}

function start() {
  stop();
  timer = setInterval(tick, cfg.intervalMs);
}
function stop() {
  if (timer) { clearInterval(timer); timer = null; }
}

module.exports = { applyConfig, noteMessage, tick, start, stop, get cfg() { return cfg; } };
