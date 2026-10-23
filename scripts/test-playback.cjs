const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
async function run() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'renderer/app.js'), 'utf8');
  const label = { textContent: '', classList: { toggle() {} } }, requests = [], played = [], listeners = new Map(), timers = new Map(); let timerId = 0;
  const context = { $: () => label, clearTimeout: id => timers.delete(id), setTimeout: fn => { timers.set(++timerId, fn); return timerId; }, console, curSplitStart: null, curSplitEnd: null, splitAdvancing: false, fmt: n => String(n),
    S: { queue: [], qcur: -1 }, ensureCid: async () => 1, pickTrack: p => p.tracks[0],
    B: { playurl: (bvid, _cid, refresh) => new Promise(resolve => requests.push({ bvid, refresh, resolve })), setTrayTip() {} },
    audio: { src: '', readyState: 1, duration: 3167, currentTime: 0, paused: false, seeking: false, pause() {},
      removeEventListener(name, fn) { if (listeners.get(name) === fn) listeners.delete(name); },
      addEventListener(name, fn) { listeners.set(name, fn); }, play: async function () { played.push(this.src); } },
    setPlayIcon() {}, setSongCover() {}, requestSongCover() {}, mergeAdjacentIdentified() {}, toast() {}, applyBalanceRouting() {}, startAgc() {}, syncQualityBtn() {}, renderList() {}, renderQueue() {}, ac: null };
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('const songArtist ='), source.indexOf('const save =')), context);
  vm.runInContext(source.slice(source.indexOf('const playback ='), source.indexOf('// 上一首 / 下一首')) + '\nthis.playerState = playback;', context);
  vm.runInContext(source.slice(source.indexOf('audio.onplay ='), source.indexOf('// 音量走感知曲线')), context);
  const old = context.playTrack({ bvid: 'old', title: '旧歌' }); await new Promise(setImmediate);
  const latest = context.playTrack({ bvid: 'new', title: '新歌', split: true, startSec: 200, endSec: 300 }); await new Promise(setImmediate);
  requests[1].resolve({ tracks: [{ url: 'https://new', backupUrls: ['https://backup'], kbps: 128 }] });
  assert.equal(await latest, true);
  requests[0].resolve({ tracks: [{ url: 'https://old' }] });
  assert.equal(await old, false);
  assert.deepEqual(played, ['https://new']);
  assert.equal(context.audio.currentTime, 200);
  context.audio.onseeked();
  context.audio.currentTime = 250; context.playerState.lastPosition = 250;
  const recovered = context.recoverPlayback(); await new Promise(setImmediate);
  requests[2].resolve({ tracks: [{ url: 'https://new', backupUrls: ['https://backup'] }] }); await recovered;
  assert.equal(played.at(-1), 'https://backup');
  assert.equal(context.audio.currentTime, 250);
  const refreshed = context.recoverPlayback(); await new Promise(setImmediate);
  assert.equal(requests[3].refresh, true);
  requests[3].resolve({ tracks: [{ url: 'https://fresh' }] }); await refreshed;
  assert.equal(played.at(-1), 'https://fresh');
  await context.recoverPlayback();
  assert.equal(requests.length, 4, 'automatic recovery must have a finite retry budget');
  const moon = { bvid: 'BV1CaPrz7EL6', cid: 36468035480, title: '月光', split: true, startSec: 0, endSec: 269.2 };
  const start = context.playTrack(moon); await new Promise(setImmediate);
  requests.at(-1).resolve({ tracks: [{ url: 'https://moon', backupUrls: ['https://moon-backup'] }] }); await start;
  context.audio.currentTime = 80; context.audio.ontimeupdate();
  label.value = String(20 / 269.2 * 1000); label.oninput();
  const backwardsRecovery = context.recoverPlayback(); await new Promise(setImmediate);
  requests.at(-1).resolve({ tracks: [{ url: 'https://moon', backupUrls: ['https://moon-backup'] }] }); await backwardsRecovery;
  assert(Math.abs(context.audio.currentTime - 20) < 1e-8, 'recovery immediately after dragging backwards must not jump back to the old 80-second cursor');
  // A later drag wins even while a new URL is still being requested.
  const loading = context.playTrack(moon, undefined, { position: 50 }); await new Promise(setImmediate);
  label.value = String(12 / 269.2 * 1000); label.oninput();
  context.audio.currentTime = 88; context.audio.ontimeupdate();
  requests.at(-1).resolve({ tracks: [{ url: 'https://moon' }] }); await loading;
  assert(Math.abs(context.audio.currentTime - 12) < 1e-8, 'late URL resolution uses the last drag, ignoring old-source timeupdate');
  // Metadata can arrive after several drags, including all the way to zero.
  context.audio.readyState = 0;
  const metadata = context.playTrack(moon, undefined, { position: 55 }); await new Promise(setImmediate);
  requests.at(-1).resolve({ tracks: [{ url: 'https://moon' }] }); await metadata;
  context.audio.currentTime = 88; context.audio.ontimeupdate();
  assert.equal(context.playerState.lastPosition, 55, 'unacknowledged initial positioning is not overwritten by a stale native clock');
  for (const target of [40, 5, 30, 0]) { label.value = String(target / 269.2 * 1000); label.oninput(); }
  context.audio.readyState = 1;
  const onMetadata = listeners.get('loadedmetadata'); listeners.delete('loadedmetadata'); onMetadata();
  assert.equal(context.audio.currentTime, 0, 'delayed metadata must not replay its captured old 55-second seek');
  // A queued seeked/timeupdate from an earlier drag cannot acknowledge the latest one.
  context.audio.currentTime = 30; context.audio.onseeked(); context.audio.ontimeupdate();
  assert.equal(context.playerState.lastPosition, 0);
  assert.equal(context.playerState.seekTarget, 0);
  context.audio.currentTime = 0; context.audio.onseeked();
  assert.equal(context.playerState.seekTarget, null);
  context.audio.readyState = 2; context.audio.onwaiting();
  const staleStall = timers.get(context.playerState.stallTimer);
  context.audio.onerror(); const staleError = timers.get(timerId);
  label.value = String(25 / 269.2 * 1000); label.oninput();
  const beforeStaleCallbacks = requests.length; staleStall(); staleError(); await new Promise(setImmediate);
  assert.equal(requests.length, beforeStaleCallbacks, 'buffer/error callbacks queued before a newer drag cannot restart playback');
  // Current generation still recovers a genuine buffering failure at the last drag.
  const currentStall = timers.get(context.playerState.stallTimer); currentStall(); await new Promise(setImmediate);
  assert.equal(requests.length, beforeStaleCallbacks + 1);
  requests.at(-1).resolve({ tracks: [{ url: 'https://recovered' }] }); await new Promise(setImmediate);
  assert(Math.abs(context.audio.currentTime - 25) < 1e-8);
  // A retained metadata callback for an obsolete source is harmless after switching songs.
  context.audio.readyState = 0;
  const obsolete = context.playTrack(moon, undefined, { position: 60 }); await new Promise(setImmediate);
  requests.at(-1).resolve({ tracks: [{ url: 'https://moon' }] }); await obsolete;
  const obsoleteMetadata = listeners.get('loadedmetadata');
  context.audio.readyState = 1;
  const next = context.playTrack({ ...moon, bvid: 'next', startSec: 300, endSec: 500 }); await new Promise(setImmediate);
  requests.at(-1).resolve({ tracks: [{ url: 'https://next' }] }); await next;
  obsoleteMetadata(); assert.equal(context.audio.currentTime, 300);
  context.S.mode = 'single'; context.audio.onended();
  assert.equal(context.audio.currentTime, 300); assert.equal(context.playerState.lastPosition, 300);
  console.log('PASS: latest playback wins; rapid backward seek/recovery, URL/metadata races, stale clock/seeked/timers, genuine stall recovery, obsolete callbacks and bounded retries; no media playback');
}
run().catch(error => { console.error(error); process.exitCode = 1; });
