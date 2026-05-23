'use strict';
// SQLite economy/store. better-sqlite3 is a NATIVE module — if its binding
// fails to load (ABI mismatch in a bad build), we must NOT crash the whole
// app. The caller wraps init() in try/catch; TTS keeps working regardless.

let Database = null;
let db = null;

// Real SF6 League Point ladder (thresholds from the in-game system).
// Each league Rookie–Diamond has 5 divisions; Master is flat.
const LEAGUES = [
  { name: 'Rookie',   min: 0,     max: 1000 },
  { name: 'Iron',     min: 1000,  max: 3000 },
  { name: 'Bronze',   min: 3000,  max: 5000 },
  { name: 'Silver',   min: 5000,  max: 9000 },
  { name: 'Gold',     min: 9000,  max: 13000 },
  { name: 'Platinum', min: 13000, max: 17000 },
  { name: 'Diamond',  min: 17000, max: 25000 },
  { name: 'Master',   min: 25000, max: Infinity },
];

// Returns { name:'Gold 3', nextAt:12345|null, toNext:678 }
function rankInfo(lp) {
  lp = Math.max(0, Math.floor(lp || 0));
  const L = LEAGUES.find(x => lp >= x.min && lp < x.max) || LEAGUES[LEAGUES.length - 1];
  if (L.name === 'Master') return { name: 'Master', nextAt: null, toNext: 0 };
  const span = (L.max - L.min) / 5;
  const div = Math.min(5, Math.floor((lp - L.min) / span) + 1);   // 1..5
  const nextAt = Math.round(div < 5 ? L.min + span * div : L.max); // next division / next league
  return { name: `${L.name} ${div}`, nextAt, toNext: Math.max(0, nextAt - lp) };
}

function rankFor(lifetime) { return rankInfo(lifetime).name; }

// kept for any old callers; first entry of each league
const RANKS = LEAGUES.map(l => ({ name: l.name, at: l.min }));

function init(dbPath) {
  Database = require('better-sqlite3');
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS viewers (
      username  TEXT PRIMARY KEY,
      display   TEXT,
      balance   INTEGER NOT NULL DEFAULT 0,
      lifetime  INTEGER NOT NULL DEFAULT 0,
      last_seen INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS commands (
      name       TEXT PRIMARY KEY,
      response   TEXT NOT NULL,
      created_by TEXT
    );
    CREATE TABLE IF NOT EXISTS meta (
      k TEXT PRIMARY KEY,
      v TEXT
    );
  `);
  // Migrations. SQLite has no "ADD COLUMN IF NOT EXISTS" — duplicate ALTER
  // throws "duplicate column name". Each statement is idempotent because we
  // swallow that specific error. Safe to run on every startup; safe on
  // fresh DBs (the columns won't exist yet) and on upgraded ones (they will).
  for (const sql of [
    'ALTER TABLE viewers ADD COLUMN duel_wins   INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE viewers ADD COLUMN duel_losses INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE viewers ADD COLUMN duel_streak INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE viewers ADD COLUMN duel_best   INTEGER NOT NULL DEFAULT 0',
  ]) {
    try { db.exec(sql); } catch (e) { /* column already exists — fine */ }
  }
  return true;
}

function isReady() { return !!db; }

// ---------- Viewers / economy ----------
const ensureStmt = () => db.prepare(
  `INSERT INTO viewers (username, display, last_seen)
   VALUES (@u, @d, @t)
   ON CONFLICT(username) DO UPDATE SET display = @d, last_seen = @t`
);

function touch(username, display, ts) {
  ensureStmt().run({ u: username, d: display || username, t: ts || Date.now() });
}

function getViewer(username) {
  return db.prepare('SELECT * FROM viewers WHERE username = ?').get(username);
}

// Balance + lifetime. ONLY passive accrual should use this — lifetime
// drives rank, so game/bet winnings must NOT go through here (rank would
// become farmable by gambling). Those use addBalance() instead.
function addPoints(username, amount, display) {
  touch(username, display);
  db.prepare(
    `UPDATE viewers
     SET balance = balance + @a,
         lifetime = lifetime + CASE WHEN @a > 0 THEN @a ELSE 0 END
     WHERE username = @u`
  ).run({ a: Math.round(amount), u: username });
}

// Balance only — never touches lifetime/rank. Used for all game and bet
// payouts/refunds so churning points can't farm rank.
function addBalance(username, amount, display) {
  touch(username, display);
  db.prepare('UPDATE viewers SET balance = balance + ? WHERE username = ?')
    .run(Math.round(amount), username);
}

// Passive accrual credit. Adds balance + lifetime but DOES NOT touch
// last_seen — otherwise paying a viewer would re-mark them "active" and
// they'd farm forever without chatting (defeats the anti-AFK rule).
function addAccrual(username, amount) {
  db.prepare(
    `UPDATE viewers SET balance = balance + @a, lifetime = lifetime + @a
     WHERE username = @u`
  ).run({ a: Math.round(amount), u: username });
}

// Atomically take points; returns true if the viewer could afford it.
function spendPoints(username, amount) {
  const tx = db.transaction(() => {
    const row = db.prepare('SELECT balance FROM viewers WHERE username = ?').get(username);
    if (!row || row.balance < amount) return false;
    db.prepare('UPDATE viewers SET balance = balance - ? WHERE username = ?')
      .run(Math.round(amount), username);
    return true;
  });
  return tx();
}

// Mod tools. setBalance = exact; modAdjust(+/-) clamps at 0.
function setBalance(username, amount, display) {
  touch(username, display);
  db.prepare('UPDATE viewers SET balance = ? WHERE username = ?')
    .run(Math.max(0, Math.round(amount)), username);
}
// Mod grant/deduct. Clamps at 0. Does NOT touch lifetime — a rogue mod
// must not be able to rank-inflate an alt with !addpp.
function modAdjust(username, delta, display) {
  touch(username, display);
  const tx = db.transaction(() => {
    const row = db.prepare('SELECT balance FROM viewers WHERE username = ?').get(username);
    const cur = row ? row.balance : 0;
    const next = Math.max(0, cur + Math.round(delta));
    db.prepare('UPDATE viewers SET balance = ? WHERE username = ?').run(next, username);
    return next;
  });
  return tx();
}

// Atomic viewer-to-viewer transfer (give / duel). Returns true on success.
function transfer(fromUser, toUser, amount, toDisplay) {
  amount = Math.round(amount);
  const tx = db.transaction(() => {
    const f = db.prepare('SELECT balance FROM viewers WHERE username = ?').get(fromUser);
    if (!f || f.balance < amount) return false;
    db.prepare('UPDATE viewers SET balance = balance - ? WHERE username = ?').run(amount, fromUser);
    ensureStmt().run({ u: toUser, d: toDisplay || toUser, t: Date.now() });
    db.prepare('UPDATE viewers SET balance = balance + ? WHERE username = ?').run(amount, toUser);
    return true;
  });
  return tx();
}

function balanceOf(username) {
  const v = getViewer(username);
  return v ? v.balance : 0;
}

function lifetimeOf(username) {
  const v = getViewer(username);
  return v ? v.lifetime : 0;
}

// Viewers seen within windowMs (economy decides who actually gets paid).
function activeViewers(windowMs) {
  return db.prepare('SELECT username, display, last_seen FROM viewers WHERE last_seen >= ?')
    .all(Date.now() - windowMs);
}

// Random viewer seen within windowMs (for !moves). null if nobody recent.
function randomActiveViewer(windowMs) {
  return db.prepare(
    'SELECT username, display FROM viewers WHERE last_seen >= ? ORDER BY RANDOM() LIMIT 1'
  ).get(Date.now() - windowMs) || null;
}

function topViewers(limit = 5) {
  return db.prepare(
    'SELECT username, display, balance FROM viewers ORDER BY balance DESC LIMIT ?'
  ).all(limit);
}

// Pay every viewer seen within `windowMs`. multiplierFn(viewerRow) -> number.
// Returns count paid.
function payActive(windowMs, baseAmount, recentMs, recentBonus, multiplierFn) {
  const now = Date.now();
  const rows = db.prepare('SELECT * FROM viewers WHERE last_seen >= ?')
    .all(now - windowMs);
  const tx = db.transaction(() => {
    for (const v of rows) {
      const recent = (now - v.last_seen) <= recentMs;
      let amt = baseAmount + (recent ? recentBonus : 0);
      amt = Math.round(amt * (multiplierFn ? multiplierFn(v) : 1));
      db.prepare(
        'UPDATE viewers SET balance = balance + ?, lifetime = lifetime + ? WHERE username = ?'
      ).run(amt, amt, v.username);
    }
  });
  tx();
  return rows.length;
}

// ---------- Duel records ----------
// Wins/losses are tracked for both PvP duels (!duel) and bot duels (!duelbot).
// Lifetime is intentionally NOT touched here — duel churn must not inflate
// rank, same anti-farm rule as the other game/bet helpers.
//
// recordDuelWin returns { wins, losses, streak, best, newBest } so callers
// can fire a milestone callout when a streak crosses a threshold.
function recordDuelWin(username, display) {
  touch(username, display);
  const tx = db.transaction(() => {
    db.prepare(
      'UPDATE viewers SET duel_wins = duel_wins + 1, duel_streak = duel_streak + 1 WHERE username = ?'
    ).run(username);
    const row = db.prepare(
      'SELECT duel_wins, duel_losses, duel_streak, duel_best FROM viewers WHERE username = ?'
    ).get(username);
    let newBest = false;
    if (row.duel_streak > row.duel_best) {
      db.prepare('UPDATE viewers SET duel_best = ? WHERE username = ?').run(row.duel_streak, username);
      row.duel_best = row.duel_streak;
      newBest = true;
    }
    return {
      wins: row.duel_wins, losses: row.duel_losses,
      streak: row.duel_streak, best: row.duel_best, newBest,
    };
  });
  return tx();
}
function recordDuelLoss(username, display) {
  touch(username, display);
  db.prepare(
    'UPDATE viewers SET duel_losses = duel_losses + 1, duel_streak = 0 WHERE username = ?'
  ).run(username);
  return duelRecord(username);
}
function duelRecord(username) {
  const row = db.prepare(
    'SELECT duel_wins, duel_losses, duel_streak, duel_best FROM viewers WHERE username = ?'
  ).get(username);
  return row
    ? { wins: row.duel_wins, losses: row.duel_losses, streak: row.duel_streak, best: row.duel_best }
    : { wins: 0, losses: 0, streak: 0, best: 0 };
}
function topDuelers(limit = 5) {
  return db.prepare(
    `SELECT username, display, duel_wins, duel_losses, duel_streak, duel_best
     FROM viewers WHERE duel_wins > 0 ORDER BY duel_wins DESC, duel_best DESC LIMIT ?`
  ).all(limit);
}

// ---------- Custom commands ----------
function setCommand(name, response, by) {
  db.prepare(
    `INSERT INTO commands (name, response, created_by) VALUES (?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET response = excluded.response`
  ).run(name, response, by || null);
}
function delCommand(name) {
  return db.prepare('DELETE FROM commands WHERE name = ?').run(name).changes > 0;
}
function getCommand(name) {
  const r = db.prepare('SELECT response FROM commands WHERE name = ?').get(name);
  return r ? r.response : null;
}
function listCommands() {
  return db.prepare('SELECT name FROM commands ORDER BY name').all().map(r => r.name);
}

function close() { if (db) { try { db.close(); } catch {} db = null; } }

module.exports = {
  init, isReady, close,
  touch, getViewer, addPoints, addBalance, addAccrual, spendPoints, balanceOf, lifetimeOf,
  setBalance, modAdjust, transfer,
  topViewers, payActive, activeViewers, randomActiveViewer,
  setCommand, delCommand, getCommand, listCommands,
  recordDuelWin, recordDuelLoss, duelRecord, topDuelers,
  rankFor, rankInfo, RANKS,
};
