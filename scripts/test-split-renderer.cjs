const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
async function run() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
  const key = source.slice(source.indexOf('const sourceKey ='), source.indexOf('function pmEntries()'));
  const split = source.slice(source.indexOf('async function maybeSplit('), source.indexOf('// ---------------------------------------------------------------- 首页'));
  const item = { bvid: 'BVsample', cid: 42, page: 1, duration: 900, title: '合集' };
  const f = { items: [item] }, label = { textContent: '', classList: { toggle() {} } };
  const context = { SPLIT_MIN_DURATION: 600, lastSplitTip: '', S: { queue: [{ bvid: 'other' }, { ...item }], qcur: 1, cur: 0 },
    B: { splitAnalyze: async () => ({ tracks: [{ start: 0, end: 300, title: '甲' }, { start: 300, end: 900, title: '乙' }], named: 2 }) },
    LibraryModel: require('../renderer/library-model.js'), setSongCover() {}, requestSongCover() {},
    toast: () => {}, save: () => {}, renderFolders: () => {}, renderList: () => {}, renderQueue: () => {},
    folder: () => f, audio: { currentTime: 420, removeEventListener() {} }, $: () => label, curSplitStart: null, curSplitEnd: null,
    uniqueId: () => 'batch', offerUndo() {}, syncCurrentSegment() {}, runSplitTask: async () => {}, setPlayIcon() {}, clearTimeout, setTimeout };
  vm.runInNewContext(key + split + '\nthis.keyOf = itemKey;', context);
  await context.maybeSplit(f, item);
  assert.equal(f.items.length, 1, 'analysis must not silently replace the original');
  context.applySplitResult(f, item, { tracks: [{ start: 0, end: 300, title: '甲' }, { start: 300, end: 900, title: '乙' }], named: 2 });
  assert.equal(f.items.length, 2);
  assert.notEqual(context.keyOf(f.items[0]), context.keyOf(f.items[1]));
  assert.equal(context.S.queue.length, 3);
  assert.equal(context.S.qcur, 2);
  assert.equal(context.S.cur, 1);
  assert.equal(context.curSplitStart, 300);
  assert.equal(context.curSplitEnd, 900);
  assert.equal(label.textContent, '乙');
  // Deleted entries must not be restored when analysis finishes later.
  const deleted = { ...item };
  await context.maybeSplit(f, deleted);
  assert.equal(f.items.length, 2);
  const events = [];
  context.ensureCid = async () => 42;
  context.B.playurl = async () => ({ tracks: [{ url: 'test://stream', kbps: 128 }] });
  context.B.setTrayTip = () => {};
  context.pickTrack = p => p.tracks[0];
  context.applyBalanceRouting = () => {};
  context.startAgc = () => {};
  context.syncQualityBtn = () => {};
  context.ac = null;
  Object.defineProperty(context.audio, 'currentTime', { configurable: true, get: () => 420, set: t => events.push('seek:' + t) });
  context.audio.readyState = 1;
  context.audio.play = async () => events.push('play');
  vm.runInNewContext(source.slice(source.indexOf('const playback ='), source.indexOf('// 上一首 / 下一首')), context);
  await context.playTrack(f.items[1], 1);
  assert.deepEqual(events, ['seek:300', 'play']);
  await context.playTrack({ bvid: 'whole-video', title: '整段' }, 0);
  assert.equal(context.curSplitStart, null);
  assert.equal(context.curSplitEnd, null);
  console.log('PASS: actual renderer split replacement, distinct keys, live queue position, boundaries, stale-result handling');
}
run().catch(error => { console.error(error); process.exitCode = 1; });
