// Resize the existing player window. Playback/webContents are never recreated.
const fs = require('node:fs');
const path = require('node:path');
const MINI_SIZES = { compact: { width: 300, height: 148 }, square: { width: 320, height: 320 } };
const MINI_SIZE = MINI_SIZES.compact;
// A native shape, not a rounded card drawn inside a rectangular window.
// Electron passes this to both the widget compositor and OS hit-test region.
function roundedWindowShape(width, height, radius = 20) {
  const r = Math.min(radius, Math.floor(width / 2), Math.floor(height / 2)), rects = [];
  for (let y = 0; y < height; y++) {
    const dy = y < r ? r - y - .5 : y >= height - r ? y - (height - r) + .5 : 0;
    const inset = dy ? Math.ceil(r - Math.sqrt(r * r - dy * dy)) : 0;
    const last = rects.at(-1);
    if (last && last.x === inset) last.height++;
    else rects.push({ x: inset, y, width: width - 2 * inset, height: 1 });
  }
  return rects;
}
function validBounds(value) {
  return value && ['x', 'y', 'width', 'height'].every(key => Number.isSafeInteger(value[key]) && Math.abs(value[key]) < 1000000) && value.width > 0 && value.height > 0;
}
function fitBounds(bounds, screen) {
  const area = screen.getDisplayMatching(bounds).workArea;
  const width = Math.min(bounds.width, area.width), height = Math.min(bounds.height, area.height);
  return { width, height, x: Math.round(Math.max(area.x, Math.min(bounds.x, area.x + area.width - width))),
    y: Math.round(Math.max(area.y, Math.min(bounds.y, area.y + area.height - height))) };
}
function createWindowMode({ win, screen, preferences, emit = () => {} }) {
  let saved = {};
  try { const value = JSON.parse(fs.readFileSync(preferences, 'utf8')); if (value && typeof value === 'object') saved = value; } catch (_) {}
  let mini = false, pinned = saved.pinned !== false, miniBounds = validBounds(saved.bounds) ? saved.bounds : null;
  let layout = Object.hasOwn(MINI_SIZES, saved.layout) ? saved.layout : 'compact';
  let normal = null, revision = 0;
  const snapshot = () => ({ mini, pinned, revision, glass: false, layout });
  function applyShape(on) {
    if (typeof win.setShape !== 'function' || !['win32', 'linux'].includes(process.platform)) return;
    const bounds = win.getBounds();
    // Solid Material surface: clip the real window, without a DWM backdrop.
    win.setShape(on ? roundedWindowShape(bounds.width, bounds.height) : []);
  }
  function persist() {
    if (!preferences) return;
    try {
      fs.mkdirSync(path.dirname(preferences), { recursive: true });
      fs.writeFileSync(preferences, JSON.stringify({ pinned, bounds: miniBounds, layout }), 'utf8');
    } catch (_) {} // A read-only profile must not prevent restoring the main window.
  }
  function publish() { revision++; const state = snapshot(); emit(state); return state; }
  function resizeMini(anchor) {
    const target = fitBounds({ ...anchor, ...MINI_SIZES[layout] }, screen);
    // Release the previous fixed size before growing OR shrinking the card.
    win.setMinimumSize(0, 0);
    win.setMaximumSize(target.width, target.height);
    win.setMinimumSize(target.width, target.height);
    win.setBounds(target);
    miniBounds = target;
    applyShape(true);
  }
  function setMini(on) {
    if (typeof on !== 'boolean') throw new Error('无效的小窗模式');
    if (win.isDestroyed() || on === mini) return snapshot();
    if (on) {
      normal = { bounds: win.getNormalBounds(), maximized: win.isMaximized(), minimum: win.getMinimumSize(),
        maximum: win.getMaximumSize(), resizable: win.isResizable(), maximizable: win.isMaximizable(), onTop: win.isAlwaysOnTop(), shadow: win.hasShadow?.() ?? true };
      const area = screen.getDisplayMatching(normal.bounds).workArea;
      const anchor = miniBounds || { x: area.x + area.width - MINI_SIZES[layout].width - 24, y: area.y + 32 };
      if (normal.maximized) win.unmaximize();
      resizeMini(anchor);
      win.setResizable(false);
      win.setMaximizable(false);
      win.setHasShadow?.(false);
      applyShape(true);
      mini = true;
      win.setAlwaysOnTop(pinned, 'pop-up-menu');
    } else {
      miniBounds = win.getBounds();
      mini = false;
      win.setResizable(normal.resizable);
      win.setMaximizable(normal.maximizable);
      win.setMaximumSize(...normal.maximum);
      win.setMinimumSize(...normal.minimum);
      win.setAlwaysOnTop(normal.onTop);
      win.setBounds(fitBounds(normal.bounds, screen));
      applyShape(false);
      win.setHasShadow?.(normal.shadow);
      if (normal.maximized) win.maximize();
      normal = null;
    }
    persist();
    return publish();
  }
  function setPinned(on) {
    if (typeof on !== 'boolean') throw new Error('无效的置顶状态');
    if (win.isDestroyed()) return snapshot();
    pinned = on;
    if (mini) win.setAlwaysOnTop(pinned, 'pop-up-menu');
    persist();
    return publish();
  }
  function setLayout(value) {
    if (typeof value !== 'string' || !Object.hasOwn(MINI_SIZES, value)) throw new Error('无效的小窗形态');
    if (win.isDestroyed() || value === layout) return snapshot();
    layout = value;
    if (mini) resizeMini(win.getBounds());
    persist();
    return publish();
  }
  function keepVisible() {
    if (!mini || win.isDestroyed()) return;
    resizeMini(win.getBounds());
  }
  const rememberPosition = () => {
    if (mini && !win.isDestroyed()) { miniBounds = win.getBounds(); persist(); }
  };
  win.on('moved', rememberPosition);
  screen.on('display-removed', keepVisible);
  screen.on('display-metrics-changed', keepVisible);
  return { snapshot, setMini, setPinned, setLayout, dispose() {
    if (mini && !win.isDestroyed()) miniBounds = win.getBounds();
    persist();
    win.removeListener('moved', rememberPosition);
    screen.removeListener('display-removed', keepVisible);
    screen.removeListener('display-metrics-changed', keepVisible);
  } };
}
module.exports = { createWindowMode, fitBounds, MINI_SIZE, MINI_SIZES, roundedWindowShape };
