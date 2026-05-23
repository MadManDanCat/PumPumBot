'use strict';
// PumPumBot Chat — standalone, TTS-free Twitch chat bot.
// Reuses the exact same lib/* modules as the full app (economy, bets,
// games, commands, security fixes) — this is just a slim shell with no
// Piper, no audio, and its own data directory.

const { app, BrowserWindow, ipcMain } = require('electron');
app.disableHardwareAcceleration();          // no GPU needed, lighter on weak PCs

const path = require('path');
const fs = require('fs');
const os = require('os');
const bot = require('../lib/bot');

// Own config + DB, separate from the TTS app's userData.
const CONFIG_PATH = path.join(app.getPath('userData'), 'botconfig.json');
const DEFAULT_CONFIG_PATH = path.join(__dirname, '..', 'botconfig.json');

try { os.setPriority(0, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch {}

function loadConfig() {
  const defaults = JSON.parse(fs.readFileSync(DEFAULT_CONFIG_PATH, 'utf8'));
  try {
    if (!fs.existsSync(CONFIG_PATH)) { fs.copyFileSync(DEFAULT_CONFIG_PATH, CONFIG_PATH); return defaults; }
    // Merge so new keys (e.g. ignoreUsers) land on configs that predate them.
    const saved = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    return { ...defaults, ...saved };
  } catch {
    return defaults;
  }
}
function saveConfig(cfg) { fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2)); }

let win;
function send(ch, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(ch, payload);
}

function createWindow() {
  win = new BrowserWindow({
    width: 620,
    height: 720,
    minWidth: 520,
    minHeight: 560,
    backgroundColor: '#0a0a14',
    title: 'PumPumBot Chat',
    icon: path.join(__dirname, '..', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: true
    }
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

ipcMain.handle('config:get', () => loadConfig());
ipcMain.handle('config:set', (_e, cfg) => { saveConfig(cfg); bot.applyConfig(cfg); return true; });
ipcMain.handle('bot:connect', () => { bot.start(loadConfig()); return true; });
ipcMain.handle('bot:disconnect', () => { bot.stop(); return true; });
ipcMain.handle('bot:betStatus', () => bot.betStatus());
ipcMain.handle('bot:dbOk', () => bot.isDbOk());

app.whenReady().then(() => {
  createWindow();
  bot.initDb(app.getPath('userData'));
  bot.setHandlers({
    onStatus: (state, label) => send('bot:status', { state, label }),
    onChat: () => {},                                  // no TTS in this build
    onLog: (kind, text) => send('bot:log', { kind, text, ts: Date.now() }),
  });
  win.webContents.once('did-finish-load', () => {
    const cfg = loadConfig();
    send('bot:dbOk', bot.isDbOk());
    if (cfg.channel) bot.start(cfg);
  });
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('before-quit', () => bot.stop());
app.on('window-all-closed', () => { bot.stop(); if (process.platform !== 'darwin') app.quit(); });
