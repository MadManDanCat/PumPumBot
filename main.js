// Performance: tell Chromium not to bother with GPU compositing.
// Saves ~1% GPU at the cost of negligible CPU — worth it on weaker rigs that
// are already running OBS + a heavy game.
const { app, BrowserWindow, ipcMain } = require('electron');
app.disableHardwareAcceleration();

const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const { autoUpdater } = require('electron-updater');
const bot = require('./lib/bot');

const CONFIG_PATH = path.join(app.getPath('userData'), 'config.json');
const DEFAULT_CONFIG_PATH = path.join(__dirname, 'config.json');

// Lower the main process priority so the game always gets CPU first.
try {
  os.setPriority(0, os.constants.priority.PRIORITY_BELOW_NORMAL);
} catch {}

function piperRoot() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'vendor', 'piper')
    : path.join(__dirname, 'vendor', 'piper');
}
const PIPER_EXE = path.join(piperRoot(), 'piper.exe');
const VOICES_DIR = path.join(piperRoot(), 'voices');
const TMP_OUT_DIR = path.join(os.tmpdir(), 'pumpum-tts');
try { fs.mkdirSync(TMP_OUT_DIR, { recursive: true }); } catch {}

const PRETTY_VOICE_NAMES = {
  'en_GB-alan-medium':                'Alan — British Bloke',
  'en_GB-jenny_dioco-medium':         'Jenny — British Woman',
  'en_GB-northern_english_male-medium':'Northern Geezer',
  'en_US-amy-medium':                 'Amy — American Woman',
  'en_US-joe-medium':                 'Joe — American Guy',
  'en_US-hfc_male-medium':            'Deep Mike — Low American',
  'en_US-hfc_female-medium':          'Smooth Sarah — American',
  'en_US-libritts_r-medium':          'Narrator — Audiobook',
};

function listVoices() {
  try {
    return fs.readdirSync(VOICES_DIR)
      .filter(f => f.endsWith('.onnx'))
      .map(f => {
        const stem = f.replace(/\.onnx$/, '');
        const name = PRETTY_VOICE_NAMES[stem]
          || stem.split('-').slice(1, -1).join(' ')
               .split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
        return { id: f, name };
      });
  } catch {
    return [];
  }
}

// ---------- Persistent Piper process ----------
// Before: spawned a new piper.exe per chat message (~500ms, 60MB model
// re-loaded each time). On weak PCs that's a sharp CPU+IO spike.
// Now: one piper.exe kept alive per voice, fed via stdin (--json-input).
// Drops per-message cost to ~150ms and a tiny CPU bump.

let piperProc = null;
let piperVoice = null;        // currently loaded voice filename
let pendingQueue = [];        // FIFO of { resolve, reject }
let stdoutBuf = '';

function killPiper() {
  if (piperProc) {
    try { piperProc.kill(); } catch {}
    piperProc = null;
  }
  piperVoice = null;
  stdoutBuf = '';
  const dead = pendingQueue;
  pendingQueue = [];
  for (const { reject } of dead) reject(new Error('Piper restarted'));
}

function ensurePiper(voiceFile) {
  if (piperProc && piperVoice === voiceFile && !piperProc.killed) return;
  killPiper();

  const modelPath = path.join(VOICES_DIR, voiceFile);
  const args = ['--model', modelPath, '--json-input', '--output_dir', TMP_OUT_DIR];
  piperProc = spawn(PIPER_EXE, args, { cwd: piperRoot(), windowsHide: true });
  piperVoice = voiceFile;

  // Lower piper's priority too — its CPU bursts should never preempt the game.
  try {
    os.setPriority(piperProc.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
  } catch {}

  piperProc.stdout.on('data', (chunk) => {
    stdoutBuf += chunk.toString();
    let nl;
    while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
      const line = stdoutBuf.slice(0, nl).trim();
      stdoutBuf = stdoutBuf.slice(nl + 1);
      if (!line) continue;
      const pending = pendingQueue.shift();
      if (!pending) continue;
      fs.readFile(line, (err, buf) => {
        fs.unlink(line, () => {});
        if (err) pending.reject(err); else pending.resolve(buf);
      });
    }
  });

  piperProc.stderr.on('data', () => { /* piper logs progress to stderr; ignore */ });

  piperProc.on('exit', () => {
    const dead = pendingQueue;
    pendingQueue = [];
    piperProc = null;
    piperVoice = null;
    for (const { reject } of dead) reject(new Error('Piper exited unexpectedly'));
  });
}

// Pre-check once at startup — no need to hit the filesystem per message
const _validVoices = new Set();
function validateVoicePaths() {
  _validVoices.clear();
  if (!fs.existsSync(PIPER_EXE)) return;
  try {
    for (const f of fs.readdirSync(VOICES_DIR)) {
      if (f.endsWith('.onnx')) _validVoices.add(f);
    }
  } catch {}
}

function synthesize(text, voiceFile, lengthScale) {
  return new Promise((resolve, reject) => {
    if (!_validVoices.size) return reject(new Error('Piper binary or voices missing'));
    if (!_validVoices.has(voiceFile)) return reject(new Error('Voice not found: ' + voiceFile));

    try {
      ensurePiper(voiceFile);
    } catch (e) {
      return reject(e);
    }

    const payload = { text };
    if (lengthScale && isFinite(lengthScale)) payload.length_scale = lengthScale;

    pendingQueue.push({ resolve, reject });
    try {
      piperProc.stdin.write(JSON.stringify(payload) + '\n');
    } catch (e) {
      const idx = pendingQueue.findIndex(p => p.resolve === resolve);
      if (idx >= 0) pendingQueue.splice(idx, 1);
      reject(e);
    }
  });
}

// ---------- ElevenLabs TTS ----------
let elVoicesCache = [];

async function elevenLabsSynthesize(text, voiceId, apiKey) {
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
    method: 'POST',
    headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
    body: JSON.stringify({ text, model_id: 'eleven_flash_v2_5' }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`ElevenLabs ${res.status}: ${body.slice(0, 200)}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

async function refreshElevenLabsVoices(apiKey) {
  if (!apiKey) { elVoicesCache = []; return; }
  try {
    const res = await fetch('https://api.elevenlabs.io/v1/voices', {
      headers: { 'xi-api-key': apiKey },
    });
    if (!res.ok) { elVoicesCache = []; return; }
    const data = await res.json();
    elVoicesCache = (data.voices || []).map(v => ({
      id: 'el:' + v.voice_id,
      name: v.name + ' ⚡',
    }));
  } catch { elVoicesCache = []; }
}

// ---------- Config ----------
let _cachedConfig = null;

function loadConfig() {
  if (_cachedConfig) return _cachedConfig;
  const defaults = JSON.parse(fs.readFileSync(DEFAULT_CONFIG_PATH, 'utf8'));
  try {
    if (!fs.existsSync(CONFIG_PATH)) {
      fs.copyFileSync(DEFAULT_CONFIG_PATH, CONFIG_PATH);
      _cachedConfig = defaults;
      return defaults;
    }
    const saved = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    _cachedConfig = { ...defaults, ...saved };
    return _cachedConfig;
  } catch {
    _cachedConfig = defaults;
    return defaults;
  }
}

function saveConfig(cfg) {
  _cachedConfig = cfg;
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

// ---------- Window ----------
let mainWindow;
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 880,
    height: 700,
    minWidth: 720,
    minHeight: 560,
    backgroundColor: '#0a0a14',
    title: 'PumPumBot',
    icon: path.join(__dirname, 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: true
    }
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

// ---------- IPC ----------
ipcMain.handle('config:get', () => loadConfig());
ipcMain.handle('config:set', async (_e, cfg) => {
  saveConfig(cfg);
  bot.applyConfig(cfg);
  await refreshElevenLabsVoices(cfg.elevenLabsApiKey).catch(() => {});
  return true;
});
ipcMain.handle('tts:voices', () => [...listVoices(), ...elVoicesCache]);
ipcMain.handle('tts:synthesize', async (_e, { text, voice, lengthScale }) => {
  if (voice.startsWith('el:')) {
    const cfg = loadConfig();
    if (!cfg.elevenLabsApiKey) throw new Error('ElevenLabs API key not set');
    const buf = await elevenLabsSynthesize(text, voice.slice(3), cfg.elevenLabsApiKey);
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  }
  const buf = await synthesize(text, voice, lengthScale);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
});

// Bot / Twitch (IRC now lives in main, not the renderer)
ipcMain.handle('bot:connect', () => { bot.start(loadConfig()); return true; });
ipcMain.handle('bot:disconnect', () => { bot.stop(); return true; });
ipcMain.handle('bot:betStatus', () => bot.betStatus());
ipcMain.handle('bot:dbOk', () => bot.isDbOk());

// Song Requests — audio fetched in main, sent to renderer as ArrayBuffer
ipcMain.handle('sr:next', async () => {
  const song = await bot.sr.nextSong();
  if (!song) return null;
  if (song.error) return { error: song.error };
  if (!song.audio) return { error: 'No audio data returned' };
  const audio = song.audio.buffer.slice(song.audio.byteOffset, song.audio.byteOffset + song.audio.byteLength);
  return {
    videoId: song.videoId,
    title: song.title,
    durationSec: song.durationSec,
    requester: song.requester,
    audio,
    mimeType: song.mimeType || 'audio/webm',
  };
});
ipcMain.handle('sr:queue', () => bot.sr.getQueueInfo());
ipcMain.handle('sr:volume', (_e, level) => {
  bot.sr.setVolume(level, { mod: true });
  return true;
});
ipcMain.handle('sr:ended', () => { bot.sr.songEnded(); return true; });

// ---------- Auto-updater ----------
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;
autoUpdater.logger = null; // quiet — we push status to the renderer

function sendUpdate(state, msg) { send('update:status', { state, msg }); }

autoUpdater.on('checking-for-update', () => sendUpdate('checking', 'Checking for updates…'));
autoUpdater.on('update-available', (info) => sendUpdate('downloading', `Downloading v${info.version}…`));
autoUpdater.on('update-not-available', () => sendUpdate('idle', ''));
autoUpdater.on('download-progress', (p) => sendUpdate('downloading', `Downloading… ${Math.round(p.percent)}%`));
autoUpdater.on('update-downloaded', (info) => sendUpdate('ready', `v${info.version} ready — restart to update`));
autoUpdater.on('error', (err) => sendUpdate('error', err?.message || 'Update failed'));

ipcMain.handle('update:install', () => { autoUpdater.quitAndInstall(); return true; });

// ---------- App lifecycle ----------
app.whenReady().then(() => {
  validateVoicePaths();
  createWindow();

  // Economy DB lives next to the config in userData.
  bot.initDb(app.getPath('userData'));
  bot.setHandlers({
    onStatus: (state, label) => send('bot:status', { state, label }),
    onChat: (m) => send('chat:message', m),
    onSrEvent: (type, data) => send('sr:event', { type, data }),
  });

  // Pre-fetch ElevenLabs voices if an API key is configured.
  const startCfg = loadConfig();
  refreshElevenLabsVoices(startCfg.elevenLabsApiKey).catch(() => {});

  // Auto-connect on launch if a channel is configured.
  mainWindow.webContents.once('did-finish-load', () => {
    const cfg = loadConfig();
    send('bot:dbOk', bot.isDbOk());
    if (cfg.channel) bot.start(cfg);
  });

  // Check for updates ~3s after launch (non-blocking).
  setTimeout(() => { autoUpdater.checkForUpdates().catch(() => {}); }, 3000);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => { killPiper(); bot.stop(); });
app.on('window-all-closed', () => {
  killPiper();
  bot.stop();
  if (process.platform !== 'darwin') app.quit();
});
