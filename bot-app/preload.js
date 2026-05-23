const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (cfg) => ipcRenderer.invoke('config:set', cfg),
  botConnect: () => ipcRenderer.invoke('bot:connect'),
  botDisconnect: () => ipcRenderer.invoke('bot:disconnect'),
  betStatus: () => ipcRenderer.invoke('bot:betStatus'),
  dbOk: () => ipcRenderer.invoke('bot:dbOk'),
  onStatus: (cb) => ipcRenderer.on('bot:status', (_e, d) => cb(d)),
  onLog: (cb) => ipcRenderer.on('bot:log', (_e, d) => cb(d)),
  onDbOk: (cb) => ipcRenderer.on('bot:dbOk', (_e, d) => cb(d)),
});
