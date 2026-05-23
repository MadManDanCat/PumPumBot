'use strict';
// Minimal Twitch Helix client for !clip. Uses the bot's existing OAuth
// token — but clip creation needs the `clips:edit` scope, so we validate
// the token first and degrade gracefully (clear chat message) if it's
// missing rather than failing silently.

let clientId = null;
let broadcasterId = null;
let scopes = [];
let ready = false;
let lastChannel = '';
let storedToken = null;

function bearer(token) {
  return token.replace(/^oauth:/i, '');
}

async function jget(url, headers) {
  const r = await fetch(url, { headers });
  if (!r.ok) throw new Error(`${r.status}`);
  return r.json();
}

// Call on connect: validates token (-> client_id, scopes) and resolves the
// channel's broadcaster id. Safe to call repeatedly.
async function init(rawToken, channelLogin) {
  ready = false;
  scopes = [];
  clientId = null;
  broadcasterId = null;
  lastChannel = (channelLogin || '').toLowerCase();
  if (!rawToken || !lastChannel) return false;
  const token = bearer(rawToken);
  storedToken = token;

  try {
    const v = await jget('https://id.twitch.tv/oauth2/validate',
      { Authorization: `OAuth ${token}` });
    clientId = v.client_id;
    scopes = v.scopes || [];
  } catch {
    return false;   // token invalid/expired — !clip will report it
  }

  try {
    const u = await jget(
      `https://api.twitch.tv/helix/users?login=${encodeURIComponent(lastChannel)}`,
      { 'Client-Id': clientId, Authorization: `Bearer ${token}` });
    broadcasterId = u.data && u.data[0] && u.data[0].id;
  } catch {
    return false;
  }

  ready = !!(clientId && broadcasterId);
  return ready;
}

function hasClipScope() { return scopes.includes('clips:edit'); }

// ---- Stream-state cache (for the heartbeat's game-aware banter) ----
// Helix `streams` is cheap but we hit it on a timer, so a short cache
// stops us hammering the API. null = offline; { game, title } = live.
let liveCache = { ts: 0, value: null };
const LIVE_TTL_MS = 60000;          // 60s is plenty — games rarely flip faster
async function currentLive() {
  if (!ready) return null;
  if (Date.now() - liveCache.ts < LIVE_TTL_MS) return liveCache.value;
  try {
    const j = await jget(
      `https://api.twitch.tv/helix/streams?user_id=${broadcasterId}`,
      { 'Client-Id': clientId, Authorization: `Bearer ${storedToken}` });
    const s = j.data && j.data[0];
    liveCache = { ts: Date.now(), value: s ? { game: s.game_name || '', title: s.title || '' } : null };
  } catch {
    // Don't poison the cache on a transient failure — keep last known.
    liveCache.ts = Date.now();
  }
  return liveCache.value;
}
async function currentGame() {
  const live = await currentLive();
  return live ? live.game : null;
}

// Returns the public clip URL, or throws an Error with a chat-friendly msg.
async function createClip() {
  if (!ready) throw new Error('Clipping not ready yet — give it a moment after connecting.');
  if (!hasClipScope()) {
    throw new Error("Clips need the clips:edit permission — regenerate the bot token with that scope (one-time).");
  }
  const token = storedToken;
  const r = await fetch(
    `https://api.twitch.tv/helix/clips?broadcaster_id=${broadcasterId}`,
    { method: 'POST', headers: { 'Client-Id': clientId, Authorization: `Bearer ${token}` } });

  if (r.status === 404 || r.status === 403) {
    throw new Error("Can't clip — stream isn't live (or clips are disabled).");
  }
  if (!r.ok) throw new Error('Clip failed, try again in a sec.');
  const j = await r.json();
  const id = j.data && j.data[0] && j.data[0].id;
  if (!id) throw new Error('Clip failed, try again in a sec.');
  return `https://clips.twitch.tv/${id}`;
}

module.exports = { init, createClip, hasClipScope, isReady: () => ready, currentGame, currentLive };
