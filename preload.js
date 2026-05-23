const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (cfg) => ipcRenderer.invoke('config:set', cfg),
  ttsVoices: () => ipcRenderer.invoke('tts:voices'),
  ttsSynthesize: (req) => ipcRenderer.invoke('tts:synthesize', req),

  // Bot / Twitch (IRC handled in main process)
  botConnect: () => ipcRenderer.invoke('bot:connect'),
  botDisconnect: () => ipcRenderer.invoke('bot:disconnect'),
  betStatus: () => ipcRenderer.invoke('bot:betStatus'),
  dbOk: () => ipcRenderer.invoke('bot:dbOk'),

  onStatus: (cb) => ipcRenderer.on('bot:status', (_e, d) => cb(d)),
  onChat: (cb) => ipcRenderer.on('chat:message', (_e, d) => cb(d)),
  onDbOk: (cb) => ipcRenderer.on('bot:dbOk', (_e, d) => cb(d)),

  // Song Requests
  srNext: () => ipcRenderer.invoke('sr:next'),
  srQueue: () => ipcRenderer.invoke('sr:queue'),
  srSetVolume: (level) => ipcRenderer.invoke('sr:volume', level),
  srEnded: () => ipcRenderer.invoke('sr:ended'),
  onSrEvent: (cb) => ipcRenderer.on('sr:event', (_e, d) => cb(d)),

  // Auto-updater
  onUpdateStatus: (cb) => ipcRenderer.on('update:status', (_e, d) => cb(d)),
  installUpdate: () => ipcRenderer.invoke('update:install'),
});
