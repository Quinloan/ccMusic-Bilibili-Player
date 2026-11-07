// Native window contract with a fake Electron window; never starts Electron.
const assert = require('node:assert/strict'), { EventEmitter } = require('node:events');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createWindowMode, MINI_SIZE, MINI_SIZES, roundedWindowShape } = require('../window-mode.cjs');
class FakeWindow extends EventEmitter {
  constructor() { super(); this.bounds = { x: 220, y: 120, width: 1120, height: 760 }; this.minimum = [900, 600]; this.maximum = [0, 0]; this.resizable = true; this.maximizable = true; this.onTop = false; this.maximized = false; }
  isDestroyed() { return false; }
  getNormalBounds() { return { ...this.bounds }; }
  getBounds() { return { ...this.bounds }; }
  getMinimumSize() { return this.minimum.slice(); }
  getMaximumSize() { return this.maximum.slice(); }
  isResizable() { return this.resizable; }
  isMaximizable() { return this.maximizable; }
  isAlwaysOnTop() { return this.onTop; }
  isMaximized() { return this.maximized; }
  unmaximize() { this.maximized = false; }
  maximize() { this.maximized = true; }
  setMinimumSize(...size) { this.minimum = size; }
  setMaximumSize(...size) { this.maximum = size; }
  setResizable(value) { this.resizable = value; }
  setMaximizable(value) { this.maximizable = value; }
  setAlwaysOnTop(value, level) { this.onTop = value; this.level = level; }
  setBackgroundMaterial(value) { this.material = value; }
  setShape(rects) { this.shape = rects; }
  hasShadow() { return this.shadow !== false; }
  setHasShadow(value) { this.shadow = value; }
  setBounds(value) {
    assert.ok(value.width >= this.minimum[0] && value.height >= this.minimum[1], 'constraints lowered before resizing');
    assert.ok(!this.maximum[0] || value.width <= this.maximum[0]);
    this.bounds = { ...value }; this.emit('moved');
  }
}
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccmusic-mini-')), preferences = path.join(dir, 'window-layout.json');
try {
  const screen = new EventEmitter(); screen.area = { x: 0, y: 0, width: 1920, height: 1040 };
  screen.getDisplayMatching = () => ({ workArea: screen.area });
  const win = new FakeWindow(), initial = win.getBounds(), events = [];
  let mode = createWindowMode({ win, screen, preferences, glassSupported: true, emit: state => events.push(state) });
  assert.deepEqual(mode.snapshot(), { mini: false, pinned: true, revision: 0, glass: false, layout: 'compact' });
  mode.setMini(true);
  assert.equal(win.material, undefined); assert.equal(mode.snapshot().glass, false);
  win.emit('focus'); assert.equal(win.material, undefined, 'focus never enables a backdrop');
  assert.equal(win.onTop, true); assert.equal(win.resizable, false); assert.equal(win.maximizable, false);
  assert.equal(win.level, 'pop-up-menu', 'mini uses a stable floating level through native style changes');
  assert.equal(win.shadow, false);
  const inside = (shape,x,y) => shape.some(r => x >= r.x && x < r.x+r.width && y >= r.y && y < r.y+r.height);
  for (const size of Object.values(MINI_SIZES)) {
    const shape = roundedWindowShape(size.width,size.height);
    for (const [x,y] of [[0,0],[size.width-1,0],[0,size.height-1],[size.width-1,size.height-1]]) assert.equal(inside(shape,x,y),false,'window corners are cut out, not recoloured');
    assert.equal(inside(shape,20,0),true); assert.equal(inside(shape,0,20),true); assert.equal(inside(shape,40,40),true);
    assert.equal(shape.reduce((n,r)=>n+r.height,0),size.height,'no horizontal gaps in the native shape');
  }
  assert.deepEqual(win.shape,roundedWindowShape(300,148));
  assert.deepEqual([win.bounds.width, win.bounds.height], [MINI_SIZE.width, MINI_SIZE.height]);
  mode.setMini(true); assert.equal(events.length, 1, 'repeat entry never overwrites normal bounds');
  win.bounds.x = 1620;
  mode.setLayout('square');
  assert.deepEqual([win.bounds.width, win.bounds.height], [320, 320]);
  assert.ok(win.bounds.x + win.bounds.width <= screen.area.width, 'growing near a screen edge remains visible');
  assert.deepEqual(win.minimum, [320, 320]); assert.deepEqual(win.maximum, [320, 320]);
  assert.deepEqual(win.shape,roundedWindowShape(320,320),'shape follows layout changes');
  mode.setLayout('compact'); assert.deepEqual([win.bounds.width, win.bounds.height], [300, 148]);
  mode.setPinned(false); assert.equal(win.onTop, false);
  win.bounds.x = 800; win.bounds.y = 230; win.emit('moved');
  mode.setMini(false);
  assert.equal(win.material, undefined); assert.equal(mode.snapshot().glass, false);
  assert.deepEqual(win.bounds, initial); assert.deepEqual(win.minimum, [900, 600]); assert.deepEqual(win.maximum, [0, 0]);
  assert.equal(win.resizable, true); assert.equal(win.maximizable, true); assert.equal(win.onTop, false);
  assert.deepEqual(win.shape,[],'normal window restores the full native area'); assert.equal(win.shadow,true);
  mode.setLayout('square'); assert.deepEqual(win.bounds, initial, 'changing preference outside mini must not resize the normal window');
  mode.setMini(true); assert.equal(win.bounds.x, 800); assert.equal(win.bounds.y, 230); assert.equal(win.onTop, false);
  mode.setMini(false); win.maximized = true;
  mode.setMini(true); assert.equal(win.maximized, false); mode.setMini(false); assert.equal(win.maximized, true);
  mode.dispose(); assert.equal(screen.listenerCount('display-removed'), 0); assert.equal(win.listenerCount('moved'), 0);
  const second = new FakeWindow();
  mode = createWindowMode({ win: second, screen, preferences });
  assert.equal(mode.snapshot().pinned, false, 'pin preference survives restart');
  assert.equal(mode.snapshot().layout, 'square', 'chosen mini shape survives restart');
  mode.setMini(true); assert.equal(second.bounds.x, 800);
  assert.deepEqual([second.bounds.width, second.bounds.height], [MINI_SIZES.square.width, MINI_SIZES.square.height]);
  second.bounds.x = -4000; second.bounds.y = -3000;
  screen.emit('display-removed'); assert.ok(second.bounds.x >= 0 && second.bounds.y >= 0, 'detached monitor cannot strand mini player');
  mode.setPinned(true); mode.setMini(false); assert.equal(second.onTop, false, 'restored main window does not inherit mini pin');
  assert.throws(() => mode.setMini('true')); assert.throws(() => mode.setPinned(null)); assert.throws(() => mode.setLayout('bad')); assert.throws(() => mode.setLayout('__proto__')); mode.dispose();
  fs.writeFileSync(preferences, 'null');
  mode = createWindowMode({ win: new FakeWindow(), screen, preferences }); mode.setMini(true); mode.setMini(false); mode.dispose();
  const unsupported = new FakeWindow();
  mode = createWindowMode({ win: unsupported, screen, preferences, glassSupported: false });
  mode.setMini(true); assert.equal(unsupported.material, undefined, 'disabled native effects never touch DWM'); assert.equal(mode.snapshot().glass, false); mode.setMini(false); mode.dispose();
  const broken = new FakeWindow(); broken.setBackgroundMaterial = () => { throw Error('unsupported DWM'); };
  mode = createWindowMode({ win: broken, screen, preferences, glassSupported: true });
  mode.setMini(true); assert.equal(mode.snapshot().glass, false); mode.setLayout('compact'); broken.emit('focus'); mode.setMini(false); mode.dispose();
  console.log('PASS: same-window mini bounds, idempotence, pin/position persistence, normal/maximized restore, monitor removal, malformed preferences, IPC value validation and cleanup; no Electron');
} finally { if (fs.existsSync(preferences)) fs.unlinkSync(preferences); fs.rmdirSync(dir); }
