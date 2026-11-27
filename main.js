const { app, BrowserWindow, ipcMain, screen, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

// ============================================================
// 抽取座号 · 圆形小球悬浮窗（主进程）
// 架构：双窗口
//   1. 球窗口  136×136 透明圆形小球：单击抽取 / 拖拽移动 / 右键开菜单
//   2. 菜单窗口 220×310 透明圆角面板：人数调节 / 置顶 / 开机自启 / 重置 / 退出 / 历史
// 稳定性（v3 强化）：
//   1. 禁用硬件加速 + 强制软件 ANGLE（虚拟机/远程桌面/老显卡下 GPU 初始化失败
//      是"窗口闪现即退 / 渲染进程 launch-failed(exitCode=18)"头号原因）
//   2. 禁用渲染进程后台节流 / 窗口遮挡计算 / 崩溃上报组件
//   3. 渲染进程 launch-failed（启动失败）专项：延迟退避重建窗口，不退出
//   4. 连续 3 次启动失败 → 弹窗提示（多为安全软件拦截，给出白名单建议）
//   5. 渲染进程崩溃自动重载；反复崩溃降级为不透明模式
//   6. 全局异常 + 各阶段打点写入 userData/error.log（单文件模式下日志不丢）
// 外观（v3.1）：
//   - 窗口缩小：球 120px（窗口 136）、菜单 220×310
//   - setShape 把窗口裁剪为圆形/圆角区域，清除 Windows 透明窗口的方形系统阴影
// 拖拽（v3.1 修复）：
//   - 渲染层改用 Pointer Capture（拖出窗口不中断）
//   - 主进程 drag-start 记录基准位置，move 用 基准+位移 定位（不再跳位）
// 开机自启（v3.1 新增）：默认开启，菜单可切换
//   - Windows/macOS 用 setLoginItemSettings，Linux 写 XDG autostart 文件
// ============================================================
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-gpu-compositing');
// 强制软件渲染后端（ANGLE/SwiftShader），规避显卡驱动初始化失败
app.commandLine.appendSwitch('use-angle', 'swiftshader');
app.commandLine.appendSwitch('disable-software-rasterizer');
// 关闭 Windows 窗口遮挡计算（远程桌面/虚拟机下窗口内容不刷新的高频原因）
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion,WinUseNativeOcclusion');
// 减少后台节流与后台渲染抑制
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
// 禁用扩展与崩溃上报组件（减少子进程启动链上的干扰）
app.commandLine.appendSwitch('disable-extensions');
app.commandLine.appendSwitch('disable-breakpad');
app.commandLine.appendSwitch('disable-crash-reporter');
// 禁用 Chromium 沙箱：虚拟机 / 远程桌面 / 受限账户 / 部分安全软件
// 环境下 Windows 沙箱会导致渲染进程无法启动（窗口闪现即退）
app.commandLine.appendSwitch('no-sandbox');
// v3.3：Windows 上禁用 DirectComposition 合成路径。
// 原因：DComp 窗口会忽略 SetWindowRgn（圆形裁剪失效 → 阴影/背景按矩形显示），
// 回退到经典合成路径后 setShape 的圆形裁剪真正生效。
if (process.platform === 'win32') {
  app.commandLine.appendSwitch('disable-direct-composition');
}

// ---------- 单实例锁（防止双开出现两个球） ----------
const gotSingleLock = app.requestSingleInstanceLock();
if (!gotSingleLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    log('检测到第二次启动，聚焦已有实例');
    if (ballWin && !ballWin.isDestroyed()) { ballWin.show(); ballWin.focus(); }
  });
}

// 窗口尺寸常量
const BALL_WIN = 136;          // 球窗口（含透明留白）
const BALL_SIZE = 120;         // 小球直径
const MENU_W = 220, MENU_H = 360;
const LOCK_MARGIN = 4;         // 锁定时贴屏幕边缘的间距

// 日志目录：userData（%APPDATA%/seat-draw-widget 或 ~/.config/seat-draw-widget）
const userDataDir = app.getPath('userData');
try { fs.mkdirSync(userDataDir, { recursive: true }); } catch (e) {}
const logFile = path.join(userDataDir, 'error.log');
const posFile = path.join(userDataDir, 'position.json');
const posLockFile = path.join(userDataDir, 'poslock.json');
app.commandLine.appendSwitch('enable-logging', 'file');
app.commandLine.appendSwitch('log-file', path.join(userDataDir, 'chrome-debug.log'));

function log(msg) {
  // 日志轮转：超过 1MB 归档为 .old，避免无限增长
  try {
    if (fs.existsSync(logFile) && fs.statSync(logFile).size > 1024 * 1024) {
      try { fs.renameSync(logFile, logFile + '.old'); } catch (e) {}
    }
  } catch (e) {}
  const line = '[' + new Date().toISOString() + '] ' + msg;
  try { fs.appendFileSync(logFile, line + '\n'); } catch (e) {}
  console.log(line);
}

// ---------- 位置锁定 ----------
// 锁定后小球固定在屏幕角落（默认右下角），重启保持；解锁后回到默认位置可自由拖动
let ballLocked = false;      // 当前是否锁定

function loadPosLock() {
  try {
    const d = JSON.parse(fs.readFileSync(posLockFile, 'utf8'));
    if (d && d.locked) return { locked: true, pos: Array.isArray(d.pos) && d.pos.length === 2 ? d.pos : null };
  } catch (e) {}
  return { locked: false, pos: null };
}
function savePosLock() {
  try {
    fs.writeFileSync(posLockFile, JSON.stringify({
      locked: !!ballLocked,
      pos: ballLocked && ballWin && !ballWin.isDestroyed() ? ballWin.getPosition() : null
    }));
  } catch (e) {}
}

// 吸附位置：右下角（紧贴边缘）或左下角，由参数决定；默认右下角
function cornerPos(disp, corner) {
  const wa = disp.workArea;
  if (corner === 'left') return [wa.x + LOCK_MARGIN, wa.y + wa.height - BALL_WIN - LOCK_MARGIN];
  return [wa.x + wa.width - BALL_WIN - LOCK_MARGIN, wa.y + wa.height - BALL_WIN - LOCK_MARGIN];
}

function notifyBallLocked() {
  if (!ballWin || ballWin.isDestroyed()) return;
  try { ballWin.webContents.send('app-action', ballLocked ? 'lock-on' : 'lock-off'); } catch (e) {}
  pushMenuData();
}

// 切换/设置锁定。锁定：吸附到当前显示器右下角，禁拖拽，重启保持；
// 解锁：回到屏幕右侧中部（默认位置），恢复拖拽。
function setBallLocked(locked) {
  if (!ballWin || ballWin.isDestroyed()) return;
  if (locked) {
    const bp = ballWin.getPosition();
    const disp = screen.getDisplayNearestPoint({ x: bp[0], y: bp[1] });
    const pos = cornerPos(disp, 'right');
    ballWin.setPosition(pos[0], pos[1]);
    ballLocked = true;
    savePosLock();
    log('位置锁定：吸附到 ' + pos[0] + ',' + pos[1]);
  } else {
    ballLocked = false;
    savePosLock();
    const wa = screen.getPrimaryDisplay().workArea;
    const def = [wa.x + wa.width - BALL_WIN - LOCK_MARGIN, wa.y + Math.round((wa.height - BALL_WIN) / 2)];
    ballWin.setPosition(def[0], def[1]);
    log('位置解锁：回到默认位置 ' + def[0] + ',' + def[1]);
  }
  notifyBallLocked();
}

// ---------- 窗口位置记忆 ----------
function loadBallPos() {
  try {
    const p = JSON.parse(fs.readFileSync(posFile, 'utf8'));
    if (Array.isArray(p) && p.length === 2 && isFinite(p[0]) && isFinite(p[1])) return p;
  } catch (e) {}
  return null;
}
function saveBallPos() {
  if (!ballWin || ballWin.isDestroyed()) return;
  try { fs.writeFileSync(posFile, JSON.stringify(ballWin.getPosition())); } catch (e) {}
}
// 恢复位置时做屏幕适配：不在任何显示器可视区内就放回主屏右侧中部
function clampPosToDisplay(x, y) {
  const wa = screen.getPrimaryDisplay().workArea;
  const cx = Math.max(wa.x, Math.min(x, wa.x + wa.width - BALL_WIN));
  const cy = Math.max(wa.y, Math.min(y, wa.y + wa.height - BALL_WIN));
  return [cx, cy];
}

// ---------- 启动打点 ----------
log('=== 抽取座号启动(小球版 v3.3) ===');
log('platform=' + process.platform + ' arch=' + process.arch);
log('transparent-shadow: hasShadow=false, setShape=72段, DComp=' + (process.platform === 'win32' ? 'off(禁用)' : 'n/a'));
log('electron=' + process.versions.electron + ' chrome=' + process.versions.chrome + ' node=' + process.versions.node);
try {
  const cpus = os.cpus();
  log('cpu=' + (cpus && cpus[0] ? cpus[0].model : 'unknown') + ' cores=' + (cpus ? cpus.length : '?'));
} catch (e) { log('cpu=unknown'); }
log('exe=' + process.execPath);
log('userData=' + userDataDir);
log('argv=' + JSON.stringify(process.argv.slice(1)));

process.on('uncaughtException', (err) => {
  log('uncaughtException: ' + (err && err.stack ? err.stack : String(err)));
});
process.on('unhandledRejection', (reason) => {
  log('unhandledRejection: ' + String(reason));
});

let ballWin = null;
let menuWin = null;
let lastData = null;   // 最近一次球窗口数据，菜单打开时立即推送
let fallbackMode = false;  // 是否已降级为不透明模式（透明窗口在部分显卡/远程桌面/虚拟机下崩溃）
let rebuilding = false;    // 正在重建窗口（降级期间不因 window-all-closed 退出）
let ballCrashCount = 0;
let menuCrashCount = 0;
let ballLaunchFailCount = 0;   // 球窗口渲染进程启动失败次数（launch-failed 专项）
let menuLaunchFailCount = 0;   // 菜单窗口渲染进程启动失败次数
let launchFailHinted = false;  // 启动失败提示是否已弹出（防重复打扰）
let autostartEnabled = true;   // 开机自启状态（默认开启）

// 窗口形状（清除方形系统阴影）
// 圆形近似（用多个竖条矩形 union 成圆，Windows 阴影贴合形状）
// v3.2：段数 28 → 72，圆形边缘更平滑，减少透明窗口边缘的方形视觉残留
function circleShapeRects(size, segments) {
  const r = size / 2;
  const rects = [];
  for (let i = 0; i < segments; i++) {
    const x0 = Math.floor(i * size / segments);
    const x1 = Math.floor((i + 1) * size / segments);
    const cx = (x0 + x1) / 2 - r;
    const halfH = Math.sqrt(Math.max(0, r * r - cx * cx));
    const y0 = Math.round(r - halfH);
    const h = Math.max(1, Math.round(halfH * 2));
    rects.push({ x: x0, y: y0, width: Math.max(1, x1 - x0), height: h });
  }
  return rects;
}

// 圆角矩形近似（上下各若干横带，中间主体）
function roundedRectRects(w, h, rad, segments) {
  const rects = [];
  for (let i = 0; i < segments; i++) {
    const y0 = Math.floor(i * rad / segments);
    const y1 = Math.max(y0 + 1, Math.floor((i + 1) * rad / segments));
    const xInset = rad - Math.sqrt(Math.max(0, rad * rad - ((i + 0.5) * rad / segments) ** 2));
    const xi = Math.round(xInset);
    const rowW = w - 2 * xi;
    if (rowW > 0) {
      rects.push({ x: xi, y: y0, width: rowW, height: y1 - y0 });              // 顶带
      rects.push({ x: xi, y: h - y1, width: rowW, height: y1 - y0 });          // 底带
    }
  }
  rects.push({ x: 0, y: rad, width: w, height: h - 2 * rad });                 // 主体
  return rects;
}

function applyShape(win, shapeFn) {
  if (!win || win.isDestroyed()) return;
  try {
    if (process.platform === 'darwin') return; // macOS 阴影跟随 alpha 形状，无需裁剪
    const rects = shapeFn();
    if (rects && rects.length) win.setShape(rects);
    log('窗口形状已设置: ' + rects.length + ' 块');
  } catch (e) { log('setShape 失败(忽略): ' + String(e)); }
}

// ================= 开机自启 =================
function applyAutostart(enabled) {
  autostartEnabled = !!enabled;
  try {
    if (process.platform === 'win32' || process.platform === 'darwin') {
      app.setLoginItemSettings({ openAtLogin: autostartEnabled, openAsHidden: false, path: process.execPath });
      log('开机自启(系统API) 已' + (autostartEnabled ? '开启' : '关闭'));
    } else if (process.platform === 'linux') {
      const deskDir = path.join(app.getPath('appData'), 'autostart');
      fs.mkdirSync(deskDir, { recursive: true });
      const desk = path.join(deskDir, 'seat-draw.desktop');
      if (autostartEnabled) {
        fs.writeFileSync(desk, '[Desktop Entry]\nType=Application\nName=抽取座号\nExec=' + process.execPath + '\nX-GNOME-Autostart-enabled=true\n');
      } else {
        try { fs.unlinkSync(desk); } catch (e) {}
      }
      log('开机自启(Linux desktop) 已' + (autostartEnabled ? '开启' : '关闭'));
    }
  } catch (e) { log('开机自启设置失败: ' + String(e)); }
}

function readAutostart() {
  try {
    if (process.platform === 'win32' || process.platform === 'darwin') {
      return !!app.getLoginItemSettings().openAtLogin;
    } else if (process.platform === 'linux') {
      return fs.existsSync(path.join(app.getPath('appData'), 'autostart', 'seat-draw.desktop'));
    }
  } catch (e) { log('读取自启状态失败: ' + String(e)); }
  return autostartEnabled;
}

function buildWinOpts(w, h, transparent) {
  return {
    width: w, height: h,
    frame: false,
    transparent: transparent && !fallbackMode,
    backgroundColor: fallbackMode ? '#101814' : '#00000000',
    hasShadow: false,          // 关闭 Windows DWM 系统阴影（透明窗口默认方形阴影即此）
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false
    }
  };
}

function enterFallbackMode(reason) {
  if (fallbackMode) return;
  fallbackMode = true;
  rebuilding = true;
  log('>>> 降级为不透明模式：' + reason);
  try { if (ballWin && !ballWin.isDestroyed()) ballWin.destroy(); } catch (e) {}
  try { if (menuWin && !menuWin.isDestroyed()) menuWin.destroy(); } catch (e) {}
  ballWin = null;
  menuWin = null;
  createMenuWindow();
  createBallWindow();
  rebuilding = false;
}

function rebuildBallWindow() {
  log('球窗口 重建（销毁后重建，彻底重置渲染进程）');
  try { if (ballWin && !ballWin.isDestroyed()) ballWin.destroy(); } catch (e) {}
  ballWin = null;
  if (!fallbackMode && ballCrashCount >= 2) {
    enterFallbackMode('球窗口渲染进程反复异常');
    return;
  }
  createBallWindow();
}

function rebuildMenuWindow() {
  log('菜单窗口 重建（销毁后重建）');
  try { if (menuWin && !menuWin.isDestroyed()) menuWin.destroy(); } catch (e) {}
  menuWin = null;
  if (!fallbackMode && menuCrashCount >= 2) {
    enterFallbackMode('菜单窗口渲染进程反复异常');
    return;
  }
  createMenuWindow();
}

// 连续启动失败提示（多为安全软件拦截子进程）
function hintLaunchFailed() {
  if (launchFailHinted) return;
  launchFailHinted = true;
  try {
    dialog.showMessageBoxSync({
      type: 'warning',
      title: '抽取座号',
      message: '程序窗口反复启动失败。\n\n最常见原因是安全软件（杀毒/电脑管家）拦截了程序进程。\n建议：\n1) 将本程序加入安全软件白名单或信任区后重试；\n2) 关闭安全软件后重新打开；\n3) 仍失败时，请把 "' + userDataDir + '\\error.log" 发送给开发者。'
    });
  } catch (e) { log('提示弹窗失败: ' + String(e)); }
}

function createMenuWindow() {
  const opts = buildWinOpts(MENU_W, MENU_H, true);
  opts.webPreferences.preload = path.join(__dirname, 'preload-menu.js');
  menuWin = new BrowserWindow(opts);
  menuWin.setAlwaysOnTop(true, 'screen-saver');
  menuWin.loadFile('menu.html');
  applyShape(menuWin, () => roundedRectRects(MENU_W, MENU_H, 18, 16));
  // 创建即隐藏：菜单是"按需弹出"，启动时不显示（Linux/X11 上 show:false 的
  // 透明窗口仍会被映射，若不隐藏会盖在球上方）
  try { menuWin.hide(); } catch (e) {}

  menuWin.on('show', () => {
    log('菜单窗口 show');
    try { menuWin.webContents.send('menu-autostart', autostartEnabled); } catch (e) {}
  });
  menuWin.on('blur', () => {
    if (!menuWin || menuWin.isDestroyed()) return;
    // 延迟 120ms 再判断：鼠标仍悬停在菜单窗口内（例如刚点了菜单项）则不隐藏
    setTimeout(() => {
      if (!menuWin || menuWin.isDestroyed()) return;
      try {
        const p = screen.getCursorScreenPoint();
        const b = menuWin.getBounds();
        if (p.x >= b.x && p.x <= b.x + b.width && p.y >= b.y && p.y <= b.y + b.height) return;
      } catch (e) {}
      menuWin.hide();
    }, 120);
  });
  menuWin.on('closed', () => { menuWin = null; });

  // 菜单窗口渲染诊断
  menuWin.webContents.on('did-finish-load', () => log('菜单窗口 did-finish-load'));
  menuWin.webContents.on('render-process-gone', (event, details) => {
    menuCrashCount++;
    log('菜单窗口 render-process-gone: ' + JSON.stringify(details) + ' count=' + menuCrashCount);
    if (details.reason === 'launch-failed') {
      menuLaunchFailCount++;
      log('菜单窗口 渲染进程启动失败(launch-failed) 第 ' + menuLaunchFailCount + ' 次，1.5s 后重建');
      if (menuLaunchFailCount >= 3) hintLaunchFailed();
      setTimeout(rebuildMenuWindow, 1500);
      return;
    }
    if (menuCrashCount >= 2 && !fallbackMode) enterFallbackMode('菜单窗口渲染进程反复崩溃');
  });
}

function createBallWindow() {
  const opts = buildWinOpts(BALL_WIN, BALL_WIN, true);
  opts.webPreferences.preload = path.join(__dirname, 'preload.js');
  ballWin = new BrowserWindow(opts);
  ballWin.setAlwaysOnTop(true, 'screen-saver');
  ballWin.loadFile('index.html');
  applyShape(ballWin, () => circleShapeRects(BALL_WIN, 72));

  const forceShow = setTimeout(() => {
    if (ballWin && !ballWin.isDestroyed()) { log('球窗口 force-show 兜底显示'); ballWin.show(); }
  }, 3000);
  ballWin.once('ready-to-show', () => {
    log('球窗口 ready-to-show 触发');
    clearTimeout(forceShow);
    if (ballWin && !ballWin.isDestroyed()) ballWin.show();
  });
  ballWin.on('show', () => {
    log('球窗口 show 事件');
    // 显示后强制重设圆形裁剪（防 DWM 在窗口显示时绘制矩形系统阴影）
    // v3.2：双延迟——部分 Windows 版本在窗口显示后数百毫秒才绘制阴影
    [200, 900].forEach((ms) => {
      setTimeout(() => {
        if (ballWin && !ballWin.isDestroyed() && process.platform !== 'darwin') {
          try { ballWin.setShape(circleShapeRects(BALL_WIN, 72)); } catch (e) {}
        }
      }, ms);
    });
  });
  // 移动后重设圆形裁剪（防移动过程中 DWM 重绘矩形阴影）
  ballWin.on('move', () => {
    clearTimeout(ballWin.__shapeTimer);
    ballWin.__shapeTimer = setTimeout(() => {
      if (ballWin && !ballWin.isDestroyed() && process.platform !== 'darwin') {
        try { ballWin.setShape(circleShapeRects(BALL_WIN, 72)); } catch (e) {}
      }
    }, 80);
  });
  ballWin.on('closed', () => { ballWin = null; });

  // 恢复位置：锁定状态优先（锁定→锁定位置；否则→记忆位置或默认）
  const lockState = loadPosLock();
  ballLocked = lockState.locked;
  if (ballLocked) {
    const bp = ballWin.getPosition();
    const disp = screen.getDisplayNearestPoint({ x: bp[0], y: bp[1] });
    const pos = lockState.pos && lockState.pos.length === 2
      ? clampPosToDisplay(lockState.pos[0], lockState.pos[1])
      : cornerPos(disp, 'right');
    ballWin.setPosition(pos[0], pos[1]);
    log('位置锁定生效，小球固定于: ' + pos[0] + ',' + pos[1]);
  } else {
    const saved = loadBallPos();
    if (saved) {
      const [px, py] = clampPosToDisplay(saved[0], saved[1]);
      ballWin.setPosition(px, py);
      log('已恢复上次位置: ' + px + ',' + py);
    }
  }

  // ---------- 渲染进程诊断 ----------
  ballWin.webContents.on('did-finish-load', () => {
    log('球窗口 did-finish-load: ' + ballWin.webContents.getURL());
    // 页面加载完成后同步锁定状态（渲染层据此禁止拖拽）
    notifyBallLocked();
  });
  ballWin.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {
    log('球窗口 did-fail-load: code=' + errorCode + ' desc=' + errorDescription + ' url=' + validatedURL);
  });
  ballWin.webContents.on('render-process-gone', (event, details) => {
    ballCrashCount++;
    log('球窗口 render-process-gone: ' + JSON.stringify(details) + ' count=' + ballCrashCount);
    if (details.reason === 'launch-failed') {
      ballLaunchFailCount++;
      log('球窗口 渲染进程启动失败(launch-failed) 第 ' + ballLaunchFailCount + ' 次，1.5s 后重建窗口');
      if (ballLaunchFailCount >= 3) hintLaunchFailed();
      setTimeout(rebuildBallWindow, 1500);
      return;
    }
    if (ballCrashCount >= 2 && !fallbackMode) {
      enterFallbackMode('球窗口渲染进程反复崩溃 (' + JSON.stringify(details) + ')');
      return;
    }
    setTimeout(() => { if (ballWin && !ballWin.isDestroyed()) ballWin.webContents.reload(); }, 600);
  });
  ballWin.webContents.on('console-message', (event, level, message, line, sourceId) => {
    log('球窗口 page-console[' + level + '] ' + message + ' (' + (sourceId || '') + ':' + line + ')');
  });
  ballWin.webContents.on('preload-error', (event, preloadPath, error) => {
    log('球窗口 preload-error: ' + preloadPath + ' -> ' + error);
  });
}

app.whenReady().then(() => {
  log('app ready，创建窗口');
  // 开机自启：首次运行（无初始化标记）默认开启并记录；之后遵循用户选择
  try {
    const initFlag = path.join(userDataDir, 'autostart-init');
    if (!fs.existsSync(initFlag)) {
      fs.writeFileSync(initFlag, '1');
      autostartEnabled = true;
      log('首次运行：开机自启默认开启');
    } else {
      autostartEnabled = readAutostart();
    }
  } catch (e) { log('自启初始化标记失败: ' + String(e)); }
  applyAutostart(autostartEnabled);
  // 菜单窗口惰性创建（首次右键时才创建），启动只建小球窗口
  createBallWindow();
});

app.on('window-all-closed', () => {
  if (rebuilding) { log('窗口重建中，跳过退出'); return; }
  log('window-all-closed，退出');
  app.quit();
});

// 退出前保存窗口位置
app.on('before-quit', () => { saveBallPos(); });

// ================= IPC =================
// 渲染进程就绪
ipcMain.on('renderer-ready', () => log('球窗口 renderer-ready（preload 已执行）'));
ipcMain.on('renderer-ready-menu', () => log('菜单窗口 renderer-ready（preload 已执行）'));
ipcMain.on('renderer-log', (e, msg) => log('page-log: ' + msg));

// 球窗口：打开菜单（显示在球下方，超出屏幕则上移；跟随球所在显示器）
// 菜单窗口惰性创建：启动时不创建，首次右键时才创建，避免 Linux/X11 上
// 隐藏菜单窗口映射盖住小球的问题
ipcMain.on('ball-open-menu', () => {
  if (!menuWin || menuWin.isDestroyed()) {
    log('首次打开菜单，惰性创建菜单窗口');
    createMenuWindow();
    if (menuWin && !menuWin.isDestroyed()) {
      menuWin.webContents.once('did-finish-load', () => { showMenuAtBall(); });
    }
    return;
  }
  showMenuAtBall();
});

function showMenuAtBall() {
  if (!menuWin || menuWin.isDestroyed()) return;
  const [bx, by] = ballWin ? ballWin.getPosition() : [100, 100];
  const disp = screen.getDisplayNearestPoint({ x: bx, y: by });
  const wa = disp.workArea;
  let mx = Math.round(bx + BALL_WIN / 2 - MENU_W / 2);
  let my = by + BALL_WIN + 6;
  if (my + MENU_H > wa.y + wa.height) my = by - MENU_H - 6;
  if (mx < wa.x) mx = wa.x;
  if (mx + MENU_W > wa.x + wa.width) mx = wa.x + wa.width - MENU_W;
  menuWin.setPosition(mx, my);
  menuWin.show();
  menuWin.focus();
  // 菜单打开时立即推送最新数据
  if (lastData) pushMenuData();
}

// 菜单窗口：操作转发给球窗口
ipcMain.on('menu-action', (e, action) => {
  if (ballWin && !ballWin.isDestroyed()) ballWin.webContents.send('app-action', action);
});

// 球窗口：数据变化推给菜单窗口
ipcMain.on('ball-data-changed', (e, data) => {
  lastData = data;
  pushMenuData();
});

// 菜单数据推送（附带当前置顶/锁定状态，保证菜单开关与真实状态一致）
// 注意：不依赖 isVisible——菜单隐藏期间也持续推送，重新打开时 UI 一定是最新数据
function pushMenuData() {
  if (!lastData) return;
  if (menuWin && !menuWin.isDestroyed()) {
    menuWin.webContents.send('menu-data', Object.assign({}, lastData, {
      pin: !!(ballWin && !ballWin.isDestroyed() && ballWin.isAlwaysOnTop()),
      locked: !!ballLocked
    }));
  }
}

// ---------- 拖拽移动（屏幕坐标增量，窗口全程保持圆形裁剪） ----------
// 渲染层用 screenX/screenY 差分上报增量；主进程在窗口当前位置上累加 → 完全跟手。
// 不再在拖拽时放开窗口形状：渲染层已用 setPointerCapture 捕获指针，
// 鼠标事件不依赖窗口命中区域，窗口形状可全程保持圆形。
// 方形阴影的两大根因：
//   1) 旧版拖拽开始把 setShape 放开为全矩形，若拖拽结束恢复失败 → 窗口永久矩形
//   2) DWM 对矩形区域绘制系统阴影
// 修复 = 全程不放开形状 + hasShadow:false + 移动/显示后强制重设圆形裁剪。
ipcMain.on('ball-drag-start', () => {
  if (ballLocked) { log('位置已锁定，忽略拖拽'); return; }  // 锁定状态禁拖
  // 拖拽期间也保持圆形形状（不再放开），Pointer Capture 保证事件不丢
  if (ballWin && !ballWin.isDestroyed()) {
    try {
      if (process.platform !== 'darwin') applyShape(ballWin, () => circleShapeRects(BALL_WIN, 72));
    } catch (e) { log('拖拽开始重设形状失败(忽略): ' + String(e)); }
  }
});

ipcMain.on('ball-move', (e, dx, dy) => {
  if (ballLocked) return;   // 主进程锁定防御：锁定态绝不受任何移动请求
  if (!ballWin || ballWin.isDestroyed()) return;
  const [cx, cy] = ballWin.getPosition();
  const [w, h] = ballWin.getSize();
  // 跟随鼠标所在显示器 clamp（多显示器不卡主屏边界）
  const disp = screen.getDisplayNearestPoint({ x: cx + dx, y: cy + dy });
  const wa = disp.workArea;
  const nx = Math.max(wa.x, Math.min(cx + dx, wa.x + wa.width - w));
  const ny = Math.max(wa.y, Math.min(cy + dy, wa.y + wa.height - h));
  ballWin.setPosition(Math.round(nx), Math.round(ny));
});

ipcMain.on('ball-drag-end', () => {
  // 双重保险：立即恢复圆形 + 延迟 150ms 再次强制重设（防 DWM/系统在拖拽后重绘矩形阴影）
  applyShape(ballWin, () => circleShapeRects(BALL_WIN, 72));
  setTimeout(() => {
    if (ballWin && !ballWin.isDestroyed() && process.platform !== 'darwin') {
      try { ballWin.setShape(circleShapeRects(BALL_WIN, 72)); } catch (e) {}
    }
  }, 150);
  if (!ballLocked) saveBallPos();
  log(ballLocked ? '拖拽结束：位置已锁定，不保存新位置' : '拖拽结束：恢复圆形窗口形状，位置已记忆');
});

// 球窗口：退出
ipcMain.on('win-close', () => {
  log('用户点击退出');
  app.quit();
});

// 置顶切换
ipcMain.on('win-pin', (e, pin) => {
  if (ballWin) ballWin.setAlwaysOnTop(!!pin, 'screen-saver');
  if (menuWin) menuWin.setAlwaysOnTop(!!pin, 'screen-saver');
  log('置顶切换: ' + (!!pin ? '开' : '关'));
});

// 位置锁定切换（来自菜单）
ipcMain.on('win-lock-toggle', () => {
  setBallLocked(!ballLocked);
});

// 开机自启切换（来自菜单）
ipcMain.on('win-autostart', (e, enabled) => {
  applyAutostart(!!enabled);
});
