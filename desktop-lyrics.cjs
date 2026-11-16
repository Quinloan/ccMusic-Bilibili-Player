'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { fitBounds } = require('./window-mode.cjs');

function createDesktopLyrics({ BrowserWindow, ipcMain, screen, host, preferences }) {
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(preferences, 'utf8')); } catch (_) {}
  let window = null;
  let enabled = false;
  let disposing = false;
  let timer = null;
  let hoverTimer = null;
  let controlsVisible = null;
  let lastInsideAt = 0;
  let message = { current: '等待播放', next: '' };
  let style = {
    fontSize: Math.max(18, Math.min(56, Number(saved.style?.fontSize) || 29)),
    color: /^#[a-f0-9]{6}$/i.test(saved.style?.color || '') ? saved.style.color : '#ffe27a',
    twoLines: saved.style?.twoLines !== false,
  };

  function persist() {
    try {
      fs.mkdirSync(path.dirname(preferences), { recursive: true });
      fs.writeFileSync(preferences, JSON.stringify({ enabled, style, bounds: window?.getBounds() || saved.bounds }));
    } catch (_) {}
  }
  function notify() {
    if (!host.isDestroyed()) host.webContents.send('lyrics:desktop-state', { enabled });
  }
  function updateControls() {
    if (!window || window.isDestroyed()) return;
    const cursor = screen.getCursorScreenPoint();
    const bounds = window.getBounds();
    const inside = cursor.x >= bounds.x && cursor.x < bounds.x + bounds.width &&
      cursor.y >= bounds.y && cursor.y < bounds.y + bounds.height;
    if (inside) lastInsideAt = Date.now();
    const visible = inside || Date.now() - lastInsideAt < 100;
    if (visible === controlsVisible) return;
    controlsVisible = visible;
    window.webContents.send('lyrics:desktop-controls', visible);
  }
  function applyStyle() {
    if (!window) return;
    const height = Math.ceil(70 + style.fontSize * 1.45 + (style.twoLines ? style.fontSize * .72 * 1.45 + 8 : 0));
    window.setBounds(fitBounds({ ...window.getBounds(), height }, screen));
    window.webContents.send('lyrics:desktop-style', style);
  }
  function setEnabled(on) {
    enabled = !!on;
    if (enabled && !window) {
      const area = screen.getPrimaryDisplay().workArea;
      const fallback = {
        x: area.x + Math.max(0, Math.round((area.width - 760) / 2)),
        y: area.y + area.height - 180,
        width: Math.min(760, area.width),
        height: 166,
      };
      const bounds = saved.bounds && ['x', 'y', 'width', 'height'].every(k => Number.isFinite(saved.bounds[k]))
        ? saved.bounds : fallback;
      window = new BrowserWindow({
        ...fitBounds(bounds, screen), minWidth: Math.min(560, area.width), minHeight: 100, maxHeight: 260, show: false,
        frame: false, transparent: true, alwaysOnTop: true, skipTaskbar: true, hasShadow: false, focusable: false,
        webPreferences: {
          preload: path.join(__dirname, 'desktop-lyrics-preload.cjs'),
          contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false,
        },
      });
      window.setAlwaysOnTop(true, 'pop-up-menu');
      window.on('system-context-menu', event => event.preventDefault());
      window.webContents.on('context-menu', event => event.preventDefault());
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      window.webContents.on('will-navigate', event => event.preventDefault());
      window.webContents.on('did-finish-load', () => {
        if (window && enabled) {
          applyStyle();
          window.webContents.send('lyrics:desktop-line', message);
          window.showInactive();
          controlsVisible = null;
          lastInsideAt = 0;
          updateControls();
        }
      });
      hoverTimer = setInterval(updateControls, 20);
      const rememberBounds = () => {
        clearTimeout(timer);
        timer = setTimeout(persist, 300);
      };
      window.on('move', rememberBounds);
      window.on('resize', rememberBounds);
      window.on('close', () => { if (window) saved.bounds = window.getBounds(); });
      window.on('closed', () => {
        clearInterval(hoverTimer);
        hoverTimer = null;
        controlsVisible = null;
        window = null;
        if (!disposing) {
          enabled = false;
          persist();
          notify();
        }
      });
      window.loadFile(path.join(__dirname, 'renderer/desktop-lyrics.html'));
    } else if (!enabled && window) window.close();
    persist();
    notify();
    return { enabled };
  }

  const handlers = {
    'lyrics:desktop-state': event => event.sender === host.webContents ? { enabled } : null,
    'lyrics:desktop-toggle': (event, on) => event.sender === host.webContents ? setEnabled(on) : null,
    'lyrics:desktop-line': (event, line) => {
      if (event.sender !== host.webContents) return;
      message = { current: String(line?.current || '').slice(0, 1000), next: String(line?.next || '').slice(0, 1000), offset: Number(line?.offset) || 0 };
      if (window && !window.isDestroyed()) window.webContents.send('lyrics:desktop-line', message);
    },
    'lyrics:desktop-close': event => {
      if (event.sender === window?.webContents) setEnabled(false);
    },
    'lyrics:desktop-configure': (event, patch) => {
      if (event.sender !== window?.webContents) return;
      if (Number.isFinite(patch?.fontSize)) style.fontSize = Math.max(18, Math.min(56, patch.fontSize));
      if (/^#[a-f0-9]{6}$/i.test(patch?.color || '')) style.color = patch.color;
      if (typeof patch?.twoLines === 'boolean') style.twoLines = patch.twoLines;
      applyStyle();
      persist();
    },
    'lyrics:desktop-offset': (event, delta) => {
      if (event.sender === window?.webContents && [-.5, .5].includes(delta) && !host.isDestroyed()) host.webContents.send('lyrics:desktop-offset', delta);
    },
  };
  for (const [name, fn] of Object.entries(handlers)) ipcMain.handle(name, fn);
  host.webContents.on('did-start-loading', () => {
    message = { current: '等待播放', next: '' };
    if (window) window.webContents.send('lyrics:desktop-line', message);
  });
  host.once('closed', () => {
    disposing = true;
    clearTimeout(timer);
    clearInterval(hoverTimer);
    persist();
    if (window) window.destroy();
    for (const name of Object.keys(handlers)) ipcMain.removeHandler(name);
  });
  if (saved.enabled) setEnabled(true);
  return { setEnabled };
}
module.exports = { createDesktopLyrics };
