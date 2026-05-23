'use strict';
// Song Request system. YouTube search + audio streaming via play-dl.
// Queue managed here; audio playback happens in the renderer (HTML5 Audio).

const play = require('play-dl');
const db = require('./db');

let cfg = {
  enabled: true,
  cost: 100,
  maxQueue: 10,
  maxDurationSec: 480,
  defaultVolume: 50,
};
let CURRENCY = 'PP';

const queue = [];        // { videoId, title, durationSec, requester, requesterLogin }
let currentSong = null;
let volume = 50;
let enabled = true;

// Called by bot.js
let onSrEvent = () => {};
function setEventHandler(fn) { onSrEvent = fn; }

function configure(c = {}, currency) {
  if (currency) CURRENCY = currency;
  if (typeof c.enabled === 'boolean') enabled = c.enabled;
  if (typeof c.cost === 'number') cfg.cost = c.cost;
  if (typeof c.maxQueue === 'number') cfg.maxQueue = c.maxQueue;
  if (typeof c.maxDurationSec === 'number') cfg.maxDurationSec = c.maxDurationSec;
  if (typeof c.defaultVolume === 'number') { cfg.defaultVolume = c.defaultVolume; volume = c.defaultVolume; }
}

function fmtDuration(sec) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// --- YouTube resolution ---
async function resolveVideo(query) {
  query = query.trim();
  if (!query) return { ok: false, msg: 'Usage: !sr <song name or YouTube URL>' };

  let info;
  try {
    // Check if it's a URL
    const validated = await play.validate(query);
    if (validated === 'yt_video') {
      const details = await play.video_info(query);
      info = details.video_details;
    } else {
      // Search by text
      const results = await play.search(query, { limit: 1, source: { youtube: 'video' } });
      if (!results.length) return { ok: false, msg: `No results for "${query.slice(0, 40)}"` };
      info = results[0];
    }
  } catch (e) {
    console.error('[sr] YouTube resolve error:', e.message);
    return { ok: false, msg: 'YouTube search failed — try again.' };
  }

  if (!info || !info.id) return { ok: false, msg: 'Could not find that video.' };

  const durationSec = info.durationInSec || 0;
  const title = (info.title || 'Unknown').slice(0, 80);

  return {
    ok: true,
    videoId: info.id,
    title,
    durationSec,
    url: `https://www.youtube.com/watch?v=${info.id}`,
  };
}

// --- Public API ---
async function request(login, display, query, flags) {
  if (!enabled) return 'Song requests are currently off.';
  if (queue.length >= cfg.maxQueue) return `Queue is full (${cfg.maxQueue} songs max).`;

  const resolved = await resolveVideo(query);
  if (!resolved.ok) return resolved.msg;

  if (resolved.durationSec > cfg.maxDurationSec) {
    return `"${resolved.title}" is too long (${fmtDuration(resolved.durationSec)} — max ${fmtDuration(cfg.maxDurationSec)}).`;
  }

  // Duplicate check
  const isDup = (currentSong && currentSong.videoId === resolved.videoId)
    || queue.some(s => s.videoId === resolved.videoId);
  if (isDup) return `"${resolved.title}" is already in the queue.`;

  // Charge PP (free for mods/broadcaster)
  const isFree = flags && (flags.mod || flags.broadcaster);
  if (cfg.cost > 0 && !isFree) {
    if (!db.isReady()) return 'Economy is offline — song requests unavailable.';
    const bal = db.balanceOf(login);
    if (bal < cfg.cost) {
      return `${display} you need ${cfg.cost.toLocaleString()} ${CURRENCY} (you have ${bal.toLocaleString()}).`;
    }
    if (!db.spendPoints(login, cfg.cost)) {
      return `${display} not enough ${CURRENCY}.`;
    }
  }

  const song = {
    videoId: resolved.videoId,
    title: resolved.title,
    durationSec: resolved.durationSec,
    requester: display,
    requesterLogin: login,
  };

  queue.push(song);

  // Notify renderer
  try { onSrEvent('enqueued', { song, queueLength: queue.length }); } catch (e) { console.error('[sr] event emit failed:', e); }

  const pos = queue.length;
  const costBit = (cfg.cost > 0 && !isFree) ? ` (-${cfg.cost} ${CURRENCY})` : '';
  return `Added "${resolved.title}" [${fmtDuration(resolved.durationSec)}] — #${pos} in queue${costBit}`;
}

function skip(login, flags) {
  if (!(flags && (flags.mod || flags.broadcaster))) return null;
  if (!currentSong) return 'Nothing playing.';
  const skipped = currentSong.title;
  currentSong = null;
  try { onSrEvent('skip', {}); } catch {}
  return `Skipped "${skipped}".`;
}

function getQueueInfo() {
  return {
    current: currentSong,
    upcoming: queue.slice(0, 10),
    volume,
  };
}

function getQueueMsg() {
  if (!currentSong && queue.length === 0) return 'No songs in queue — !sr <song> to request.';
  let msg = '';
  if (currentSong) msg += `Now: "${currentSong.title}" (${currentSong.requester})`;
  if (queue.length > 0) {
    const upcoming = queue.slice(0, 3).map((s, i) => `${i + 1}. ${s.title}`).join(' · ');
    msg += (msg ? ' | ' : '') + `Queue: ${upcoming}`;
    if (queue.length > 3) msg += ` (+${queue.length - 3} more)`;
  }
  return msg;
}

function setVolume(level, flags) {
  if (!(flags && (flags.mod || flags.broadcaster))) return null;
  const n = Math.floor(Number(level));
  if (!Number.isFinite(n) || n < 0 || n > 100) return 'Usage: !volume <0-100>';
  volume = n;
  try { onSrEvent('volume', volume); } catch {}
  return `Music volume: ${volume}%`;
}

// Called by main.js IPC when renderer asks for the next song to play.
// Reads the full audio into a Buffer here so the renderer gets raw bytes
// it can play via Blob URL — no re-fetching of expiring YouTube URLs.
async function nextSong() {
  const song = queue.shift();
  if (!song) { currentSong = null; return null; }
  currentSong = song;

  try {
    const url = `https://www.youtube.com/watch?v=${song.videoId}`;
    const info = await play.video_info(url);
    const streamData = await play.stream_from_info(info);
    const chunks = [];
    for await (const chunk of streamData.stream) {
      chunks.push(chunk);
    }
    const audio = Buffer.concat(chunks);
    const mimeType = (streamData.type || '').includes('opus') || (streamData.type || '').includes('ogg')
      ? 'audio/webm' : 'audio/mp4';
    return { ...song, audio, mimeType };
  } catch (e) {
    console.error('[sr] Stream extract failed:', e.message);
    currentSong = null;
    return { error: `${e.message} (id: ${song.videoId})` };
  }
}

function songEnded() {
  currentSong = null;
}

function getVolume() { return volume; }
function isEnabled() { return enabled; }
function getCurrent() { return currentSong; }

module.exports = {
  configure,
  setEventHandler,
  request,
  skip,
  getQueueInfo,
  getQueueMsg,
  setVolume,
  nextSong,
  songEnded,
  getVolume,
  isEnabled,
  getCurrent,
};
