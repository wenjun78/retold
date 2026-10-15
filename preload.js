'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const EVENTS = ['notice', 'progress', 'video', 'overlay', 'window', 'page'];

contextBridge.exposeInMainWorld('gloss', {
  call: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  // Where a file dropped onto the window lives on disk.
  pathFor: (file) => { try { return webUtils.getPathForFile(file); } catch { return ''; } },
  on: (event, handler) => {
    if (!EVENTS.includes(event)) return;
    ipcRenderer.on('gloss:' + event, (_e, payload) => handler(payload));
  },
});
