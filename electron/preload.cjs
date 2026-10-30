const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('take1Native', {
  isDesktop: true,
  platform: process.platform,
  onHotkey: (cb) => ipcRenderer.on('hotkey', (_e, name) => cb(name)),
  getShortcuts: () => ipcRenderer.invoke('shortcuts:get'),
  setShortcuts: (map) => ipcRenderer.invoke('shortcuts:set', map),
  listening: (on) => ipcRenderer.send('listening', !!on),
  setTalkKey: (key) => ipcRenderer.invoke('talk:set', key),
  talkStatus: () => ipcRenderer.invoke('talk:status'),
  getSources: () => ipcRenderer.invoke('sources:list'),
  chooseSource: (id) => ipcRenderer.invoke('sources:choose', id),
  pillInteractive: (on) => ipcRenderer.send('pill:interactive', !!on),
  pillVisible: (on) => ipcRenderer.send('pill:visible', !!on),
  showMain: () => ipcRenderer.send('main:show'),
  hideMain: () => ipcRenderer.send('main:hide'),
  googleAuth: (o) => ipcRenderer.invoke('google:auth', o),
  googleSignOut: () => ipcRenderer.invoke('google:signout'),
});
