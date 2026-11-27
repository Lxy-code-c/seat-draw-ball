const { contextBridge, ipcRenderer } = require('electron');

// 通知主进程：preload 已成功执行
try { ipcRenderer.send('renderer-ready'); } catch (e) {}

contextBridge.exposeInMainWorld('appBall', {
  close: () => ipcRenderer.send('win-close'),
  setPin: (pin) => ipcRenderer.send('win-pin', !!pin),
  openMenu: () => ipcRenderer.send('ball-open-menu'),
  dragStart: () => ipcRenderer.send('ball-drag-start'),
  moveBy: (dx, dy) => ipcRenderer.send('ball-move', Math.round(dx), Math.round(dy)),
  dragEnd: () => ipcRenderer.send('ball-drag-end'),
  pushData: (data) => ipcRenderer.send('ball-data-changed', data),
  log: (msg) => ipcRenderer.send('renderer-log', String(msg)),
  onAction: (cb) => ipcRenderer.on('app-action', (e, action, value) => cb(action, value))
});
