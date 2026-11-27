const { contextBridge, ipcRenderer } = require('electron');

// 通知主进程：菜单窗口 preload 已成功执行
try { ipcRenderer.send('renderer-ready-menu'); } catch (e) {}

contextBridge.exposeInMainWorld('appMenu', {
  action: (a) => ipcRenderer.send('menu-action', a),
  setAutostart: (en) => ipcRenderer.send('win-autostart', !!en),
  lockToggle: () => ipcRenderer.send('win-lock-toggle'),
  onAutostart: (cb) => ipcRenderer.on('menu-autostart', (e, v) => cb(v)),
  onData: (cb) => ipcRenderer.on('menu-data', (e, d) => cb(d))
});
