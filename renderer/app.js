// PumPumBot renderer: Twitch IRC + Piper TTS

const $ = (id) => document.getElementById(id);
const els = {
  channel: $('channel'),
  connectBtn: $('connectBtn'),
  status: $('status'),
  statusText: $('statusText'),
  ttsToggle: $('ttsToggle'),
  subOnly: $('subOnly'),
  modOnly: $('modOnly'),
  mute: $('mute'),
  skip: $('skip'),
  volume: $('volume'),
  rate: $('rate'),
  voice: $('voice'),
  volumeVal: $('volumeVal'),
  rateVal: $('rateVal'),
  nowReading: $('nowReading'),
  liveCard: document.querySelector('.live-card'),
  queueWrap: $('queueWrap'),
  queue: $('queue'),
  writeEnabled: $('writeEnabled'),
  botFields: $('botFields'),
  botUser: $('botUser'),
  botToken: $('botToken'),
  botSave: $('botSave'),
  econStatus: $('econStatus'),
  betStrip: $('betStrip'),
  elApiKey: $('elApiKey'),
  elSave: $('elSave'),
  elStatus: $('elStatus'),
};

let cfg = {};
const queue = [];
let speaking = false;
let currentAudio = null;
let piperVoices = [];
const lastUserSpoke = new Map();
const recentMessages = new Map();

// ---------- Config ----------
async function loadCfg() {
  cfg = await window.api.getConfig();
  els.channel.value = cfg.channel || '';
  els.volume.value = Math.round((cfg.volume ?? 0.9) * 100);
  els.rate.value = Math.round((cfg.rate ?? 1.05) * 100);
  els.volumeVal.textContent = els.volume.value + '%';
  els.rateVal.textContent = (els.rate.value / 100).toFixed(2) + 'x';
  els.subOnly.checked = !!cfg.subOnly;
  els.modOnly.checked = !!cfg.modOnly;
  els.mute.checked = !!cfg.muted;
  els.writeEnabled.checked = !!cfg.writeEnabled;
  els.botUser.value = cfg.botUser || '';
  els.botToken.value = cfg.botToken || '';
  els.botFields.hidden = !cfg.writeEnabled;
  els.elApiKey.value = cfg.elevenLabsApiKey || '';
  paintBigToggle();
}
let _saveTimer = null;
async function saveCfg() { await window.api.setConfig(cfg); }
function saveCfgDebounced() {
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(saveCfg, 300);
}

// ---------- UI helpers ----------
function paintBigToggle() {
  const on = cfg.enabled !== false;
  els.ttsToggle.classList.toggle('on', on);
  els.ttsToggle.classList.toggle('off', !on);
  els.ttsToggle.setAttribute('aria-pressed', on ? 'true' : 'false');
  els.ttsToggle.querySelector('.big-toggle-state').textContent = on ? 'Reading' : 'Paused';
  els.ttsToggle.querySelector('.big-toggle-hint').textContent = on ? 'Tap to stop' : 'Tap to start';
}
function setStatus(state, label) {
  els.status.classList.remove('connected', 'disconnected', 'connecting');
  els.status.classList.add(state);
  els.statusText.textContent = label;
}
function setConnectButton(label) {
  els.connectBtn.querySelector('span').textContent = label;
}
function setSpeakingIndicator(on) {
  els.liveCard.classList.toggle('speaking', !!on);
}

// ---------- Voices (Piper) ----------
async function populateVoices() {
  piperVoices = await window.api.ttsVoices();
  els.voice.innerHTML = '';
  if (!piperVoices.length) {
    const o = document.createElement('option');
    o.textContent = '(no voices found)';
    els.voice.appendChild(o);
    return;
  }
  for (const v of piperVoices) {
    const o = document.createElement('option');
    o.value = v.id;
    o.textContent = v.name;
    if (v.id === cfg.voice) o.selected = true;
    els.voice.appendChild(o);
  }
  if (!cfg.voice || !piperVoices.some(v => v.id === cfg.voice)) {
    cfg.voice = piperVoices[0].id;
    els.voice.value = cfg.voice;
    saveCfg();
  }
}

// ---------- Text normalization ----------
const CHAT_REPLACEMENTS = {
  "im": "I'm", "ive": "I've", "ill": "I'll", "id": "I'd",
  "youre": "you're", "youll": "you'll", "youve": "you've", "youd": "you'd",
  "hes": "he's", "shes": "she's", "theyre": "they're", "theyve": "they've", "theyll": "they'll", "theyd": "they'd",
  "weve": "we've", "wed": "we'd", "well": "we'll",
  "dont": "don't", "didnt": "didn't", "doesnt": "doesn't",
  "cant": "can't", "couldnt": "couldn't", "shouldnt": "shouldn't", "wouldnt": "wouldn't",
  "wont": "won't", "wasnt": "wasn't", "werent": "weren't",
  "isnt": "isn't", "arent": "aren't", "hasnt": "hasn't", "havent": "haven't", "hadnt": "hadn't",
  "thats": "that's", "whats": "what's", "wheres": "where's", "whens": "when's", "hows": "how's", "whos": "who's",
  "lets": "let's", "its": "it's",
  "u": "you", "ur": "your", "r": "are",
  "y": "why", "k": "okay", "kk": "okay",
  "thx": "thanks", "ty": "thank you", "tysm": "thank you so much",
  "pls": "please", "plz": "please",
  "lol": "lol", "lmao": "lmao", "rofl": "rofl",
  "omg": "oh my god", "omfg": "oh my god",
  "wtf": "what the heck", "stfu": "shut up",
  "idk": "I don't know", "idc": "I don't care", "ikr": "I know right",
  "tbh": "to be honest", "ngl": "not gonna lie", "fr": "for real",
  "rn": "right now", "btw": "by the way", "bc": "because", "cuz": "because", "cause": "because",
  "smh": "shaking my head", "imo": "in my opinion", "imho": "in my humble opinion",
  "afaik": "as far as I know", "iirc": "if I recall correctly",
  "irl": "in real life", "afk": "away from keyboard", "brb": "be right back",
  "gg": "good game", "ggs": "good games", "wp": "well played", "glhf": "good luck have fun",
  "ez": "easy", "pog": "pog", "poggers": "poggers", "kek": "kek", "lul": "lul",
  "nvm": "never mind", "ofc": "of course", "fyi": "for your information",
  "asap": "as soon as possible",
  "atm": "at the moment", "tho": "though", "thru": "through",
  "wyd": "what you doing", "wbu": "what about you", "hbu": "how about you",
};

function normalizeChat(text) {
  // Strip URLs
  text = text.replace(/https?:\/\/\S+/gi, '');
  // Strip Unicode emojis (😀 🔥 🎮 etc.)
  text = text.replace(/\p{Extended_Pictographic}/gu, ' ');
  // Strip common ASCII text emoticons (:D :) :( ;) xD <3 T_T ^_^ etc.)
  text = text.replace(/(^|\s)(?:[:;=8][\-o\*']?[\)\(\]\[\\\/DPpoO3\|]+|x[Dd3]|XD|<\/?3|T_T|\^_\^|-_-|o_o|O_O|>_<|:'\(|:'\))(?=\s|$)/g, '$1');
  // Strip stray colons / semicolons / equals signs that aren't part of words (so leftover ":" doesn't get read as "colon")
  text = text.replace(/(^|\s)[:;=]+(?=\s|$)/g, '$1');
  // Collapse 3+ repeated letters: "yesssss" -> "yess"
  text = text.replace(/(.)\1{2,}/g, '$1$1');
  // Whole-word chat-speak replacements
  text = text.replace(/\b[a-zA-Z]+\b/g, (w) => {
    const lower = w.toLowerCase();
    return CHAT_REPLACEMENTS[lower] || w;
  });
  // Collapse repeated punctuation: "!!!!" -> "!"
  text = text.replace(/([!?.,])\1{1,}/g, '$1');
  // Collapse extra spaces left behind
  text = text.replace(/\s{2,}/g, ' ');
  return text.trim();
}

// ---------- TTS ----------
async function speakNext() {
  if (speaking) return;
  if (!cfg.enabled || cfg.muted) { queue.length = 0; renderQueue(); return; }
  const item = queue.shift();
  renderQueue();
  if (!item) {
    els.nowReading.textContent = 'Waiting for chat';
    els.nowReading.classList.add('idle');
    setSpeakingIndicator(false);
    return;
  }

  speaking = true;
  setSpeakingIndicator(true);
  els.nowReading.classList.remove('idle');
  els.nowReading.innerHTML = `<b>${escapeHtml(item.user)}</b> &nbsp; ${escapeHtml(item.text)}`;

  const cleanText = normalizeChat(item.text);
  if (!/[a-zA-Z0-9]/.test(cleanText)) {
    // Message has no readable content (emoji/punctuation only)
    speaking = false;
    setSpeakingIndicator(false);
    setTimeout(speakNext, 30);
    return;
  }
  const phrase = cfg.readUsername === false ? cleanText : `${item.user} says, ${cleanText}`;
  const lengthScale = 1 / (cfg.rate || 1.0);

  try {
    const wavArrayBuf = await window.api.ttsSynthesize({
      text: phrase, voice: cfg.voice, lengthScale
    });
    const mime = cfg.voice.startsWith('el:') ? 'audio/mpeg' : 'audio/wav';
    const blob = new Blob([wavArrayBuf], { type: mime });
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    audio.volume = cfg.volume ?? 0.9;
    currentAudio = audio;
    const done = () => {
      URL.revokeObjectURL(url);
      currentAudio = null;
      speaking = false;
      setSpeakingIndicator(false);
      unduckMusic();
      setTimeout(speakNext, 60);
    };
    audio.onended = done;
    audio.onerror = done;
    duckMusic();
    await audio.play();
  } catch (err) {
    console.error('Piper synthesis failed:', err);
    speaking = false;
    setSpeakingIndicator(false);
    unduckMusic();
    setTimeout(speakNext, 60);
  }
}

function enqueue(user, text, tags) {
  if (!cfg.enabled || cfg.muted) return;
  if (cfg.subOnly && !(tags.subscriber || tags.mod || tags.broadcaster)) return;
  if (cfg.modOnly && !(tags.mod || tags.broadcaster)) return;
  if (text.length > (cfg.maxLength ?? 200)) return;
  if (cfg.blockLinks && /https?:\/\/|www\.|\.[a-z]{2,}\//i.test(text)) return;

  const now = Date.now();
  const cd = cfg.perUserCooldownMs ?? 4000;
  if (now - (lastUserSpoke.get(user) || 0) < cd) return;

  const dupKey = (user + '|' + text).toLowerCase();
  const dupWin = cfg.duplicateWindowMs ?? 30000;
  if (now - (recentMessages.get(dupKey) || 0) < dupWin) return;

  lastUserSpoke.set(user, now);
  recentMessages.set(dupKey, now);
  if (recentMessages.size > 500) {
    const cutoff = now - dupWin;
    for (const [k, t] of recentMessages) if (t < cutoff) recentMessages.delete(k);
  }

  queue.push({ user, text });
  renderQueue();
  speakNext();
}

function renderQueue() {
  els.queue.innerHTML = '';
  const items = queue.slice(0, 3);
  els.queueWrap.hidden = items.length === 0;
  for (const item of items) {
    const li = document.createElement('li');
    li.innerHTML = `<b>${escapeHtml(item.user)}</b> &nbsp; ${escapeHtml(item.text)}`;
    els.queue.appendChild(li);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function skipCurrent() {
  if (currentAudio) { try { currentAudio.pause(); } catch {} currentAudio = null; }
  speaking = false;
  setSpeakingIndicator(false);
  unduckMusic();
  setTimeout(speakNext, 60);
}

// ---------- Twitch (IRC handled in main process) ----------
let connected = false;

async function connect() {
  const channel = (els.channel.value || '').trim().toLowerCase().replace(/^#/, '');
  if (!channel) { setStatus('disconnected', 'Type a channel name first'); return; }
  cfg.channel = channel;
  await saveCfg();           // main re-applies bot config from saved file
  await window.api.botConnect();
}

async function disconnect() {
  await window.api.botDisconnect();
}

// Status pushed from main
window.api.onStatus(({ state, label }) => {
  setStatus(state, label);
  connected = state === 'connected';
  setConnectButton(connected ? 'Disconnect' : (state === 'connecting' ? 'Connecting…' : 'Link Up'));
});

// Every chat message pushed from main → run TTS pipeline
window.api.onChat((m) => {
  enqueue(m.user, m.text, m.flags || {});
});

// ---------- Wiring ----------
els.connectBtn.addEventListener('click', () => { if (connected) disconnect(); else connect(); });
els.channel.addEventListener('keydown', (e) => { if (e.key === 'Enter') connect(); });

els.ttsToggle.addEventListener('click', () => {
  cfg.enabled = !cfg.enabled;
  paintBigToggle();
  saveCfg();
  if (!cfg.enabled) { skipCurrent(); queue.length = 0; renderQueue(); }
});

function bindSwitch(input, key, isMute) {
  input.addEventListener('change', () => {
    cfg[key] = input.checked;
    saveCfg();
    if (isMute && cfg.muted) { skipCurrent(); queue.length = 0; renderQueue(); }
  });
}
bindSwitch(els.subOnly, 'subOnly');
bindSwitch(els.modOnly, 'modOnly');
bindSwitch(els.mute, 'muted', true);

els.skip.addEventListener('click', skipCurrent);

els.volume.addEventListener('input', () => {
  cfg.volume = els.volume.value / 100;
  els.volumeVal.textContent = els.volume.value + '%';
  saveCfgDebounced();
});
els.rate.addEventListener('input', () => {
  cfg.rate = els.rate.value / 100;
  els.rateVal.textContent = (els.rate.value / 100).toFixed(2) + 'x';
  saveCfgDebounced();
});
els.voice.addEventListener('change', () => {
  cfg.voice = els.voice.value;
  saveCfg();
});

// ---------- Chat Bot (write mode) ----------
els.writeEnabled.addEventListener('change', () => {
  cfg.writeEnabled = els.writeEnabled.checked;
  els.botFields.hidden = !cfg.writeEnabled;
  saveCfg();
});

els.elSave.addEventListener('click', async () => {
  cfg.elevenLabsApiKey = (els.elApiKey.value || '').trim();
  await saveCfg();
  await populateVoices();
  els.elStatus.textContent = cfg.elevenLabsApiKey ? 'Key saved — voices refreshed' : 'Key cleared';
  setTimeout(() => { els.elStatus.textContent = ''; }, 3000);
});

els.botSave.addEventListener('click', async () => {
  cfg.botUser = (els.botUser.value || '').trim().toLowerCase();
  cfg.botToken = (els.botToken.value || '').trim();
  cfg.writeEnabled = els.writeEnabled.checked;
  await saveCfg();
  await window.api.botDisconnect();
  await window.api.botConnect();
  els.botSave.querySelector('span').textContent = 'Saved ✓';
  setTimeout(() => els.botSave.querySelector('span').textContent = 'Save & Reconnect', 1500);
});

async function refreshEconStatus() {
  try {
    const ok = await window.api.dbOk();
    els.econStatus.textContent = ok ? 'ECONOMY: ONLINE' : 'ECONOMY: OFFLINE';
    els.econStatus.classList.toggle('off', !ok);
  } catch {}
}

async function pollBets() {
  try {
    const st = await window.api.betStatus();
    if (st && st.state && st.state !== 'idle') {
      els.betStrip.hidden = false;
      els.betStrip.textContent = st.msg || '';
    } else {
      els.betStrip.hidden = true;
    }
  } catch {}
}
// Poll bets infrequently — just a fallback sync (bets are short-lived)
setInterval(pollBets, 15000);

// ---------- Init ----------
// Main auto-connects on launch if a channel is configured; the renderer
// just reflects status pushed via onStatus. No connect() call here.
(async () => {
  await loadCfg();
  await populateVoices();
  setStatus('disconnected', 'Offline');
  refreshEconStatus();
  pollBets();
})();

window.api.onDbOk(() => refreshEconStatus());

// ---------- Auto-updater ----------
const updateBar = $('updateBar');
const updateMsg = $('updateMsg');
const updateBtn = $('updateBtn');

const updateIcon = document.querySelector('.update-icon');
const updateTitle = document.querySelector('.update-title');

window.api.onUpdateStatus(({ state, msg }) => {
  // Only show the bar for downloading / ready / error — not during the silent check
  if (state === 'idle' || state === 'checking' || !msg) {
    updateBar.hidden = true;
    updateBtn.hidden = true;
    return;
  }
  updateBar.hidden = false;
  updateMsg.textContent = msg;
  if (state === 'ready') {
    updateBtn.hidden = false;
    updateTitle.textContent = 'UPDATE READY';
    updateIcon.style.animation = 'none';
  } else if (state === 'error') {
    updateBtn.hidden = true;
    updateTitle.textContent = 'UPDATE ERROR';
    updateIcon.style.animation = 'none';
  } else if (state === 'downloading') {
    updateBtn.hidden = true;
    updateTitle.textContent = 'DOWNLOADING';
    updateIcon.style.animation = '';
  } else {
    updateBtn.hidden = true;
    updateTitle.textContent = 'UPDATING...';
    updateIcon.style.animation = '';
  }
});

updateBtn.addEventListener('click', () => {
  window.api.installUpdate();
});

// ---------- Song Requests ----------
let musicAudio = null;
let musicVolume = 50;
let musicPlaying = false;
let currentSrSong = null;

const srNowPlaying = $('srNowPlaying');
const srQueueWrap = $('srQueueWrap');
const srQueueEl = $('srQueue');
const srVolumeSlider = $('srVolume');
const srVolVal = $('srVolVal');

function duckMusic() {
  if (musicAudio && musicPlaying) {
    musicAudio.volume = (musicVolume / 100) * 0.15;
  }
}
function unduckMusic() {
  if (musicAudio && musicPlaying) {
    musicAudio.volume = musicVolume / 100;
  }
}

async function playNextSong() {
  srNowPlaying.classList.remove('idle');
  srNowPlaying.textContent = 'Loading song...';

  let data;
  try {
    data = await window.api.srNext();
  } catch (e) {
    srNowPlaying.textContent = 'ERROR: ' + e.message;
    return;
  }

  if (!data) {
    musicPlaying = false;
    currentSrSong = null;
    srNowPlaying.textContent = 'No music playing';
    srNowPlaying.classList.add('idle');
    srQueueWrap.hidden = true;
    return;
  }

  if (!data.audio || !data.audio.byteLength) {
    srNowPlaying.textContent = 'ERROR: Empty audio buffer';
    window.api.srEnded();
    return;
  }

  currentSrSong = data;
  srNowPlaying.innerHTML = `<b>${escapeHtml(data.requester)}</b> &nbsp; ${escapeHtml(data.title)} (${Math.round(data.audio.byteLength / 1024)}KB)`;

  const blob = new Blob([data.audio], { type: data.mimeType || 'audio/webm' });
  const url = URL.createObjectURL(blob);
  musicAudio = new Audio(url);
  musicAudio.volume = musicVolume / 100;
  if (speaking) musicAudio.volume = (musicVolume / 100) * 0.15;

  musicAudio.onended = () => {
    URL.revokeObjectURL(url);
    musicPlaying = false;
    currentSrSong = null;
    window.api.srEnded();
    playNextSong();
  };
  musicAudio.onerror = (e) => {
    srNowPlaying.textContent = `PLAY ERROR: ${musicAudio.error?.message || 'unknown'} (type: ${data.mimeType})`;
    URL.revokeObjectURL(url);
    musicPlaying = false;
    currentSrSong = null;
    window.api.srEnded();
  };

  try {
    await musicAudio.play();
    musicPlaying = true;
  } catch (e) {
    srNowPlaying.textContent = 'PLAY FAILED: ' + e.message;
    musicPlaying = false;
    return;
  }

  refreshSrQueue();
}

async function refreshSrQueue() {
  try {
    const info = await window.api.srQueue();
    srQueueEl.innerHTML = '';
    const items = (info.upcoming || []).slice(0, 5);
    srQueueWrap.hidden = items.length === 0;
    for (const song of items) {
      const li = document.createElement('li');
      li.innerHTML = `<b>${escapeHtml(song.requester)}</b> &nbsp; ${escapeHtml(song.title)}`;
      srQueueEl.appendChild(li);
    }
  } catch {}
}

// SR events from main process
window.api.onSrEvent(({ type, data }) => {
  if (type === 'enqueued') {
    // A new song was queued — start playing if nothing is playing
    if (!musicPlaying) playNextSong();
    else refreshSrQueue();
  }
  if (type === 'skip') {
    if (musicAudio) { try { musicAudio.pause(); } catch {} musicAudio = null; }
    musicPlaying = false;
    currentSrSong = null;
    window.api.srEnded();
    playNextSong();
  }
  if (type === 'volume') {
    musicVolume = data;
    srVolumeSlider.value = musicVolume;
    srVolVal.textContent = musicVolume + '%';
    if (musicAudio && musicPlaying) {
      musicAudio.volume = speaking ? (musicVolume / 100) * 0.15 : musicVolume / 100;
    }
  }
});

// Music volume slider
srVolumeSlider.addEventListener('input', () => {
  musicVolume = parseInt(srVolumeSlider.value, 10);
  srVolVal.textContent = musicVolume + '%';
  if (musicAudio && musicPlaying) {
    musicAudio.volume = speaking ? (musicVolume / 100) * 0.15 : musicVolume / 100;
  }
  window.api.srSetVolume(musicVolume);
});
