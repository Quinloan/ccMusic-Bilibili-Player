const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
async function run() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'renderer/app.js'), 'utf8');
  const label = { textContent: '', classList: { toggle() {} } }, requests = [], played = [];
  const context = { $: () => label, clearTimeout, setTimeout, console, curSplitStart: null, curSplitEnd: null,
    S: { queue: [], qcur: -1 }, ensureCid: async () => 1, pickTrack: p => p.tracks[0],
    B: { playurl: (bvid, _cid, refresh) => new Promise(resolve => requests.push({ bvid, refresh, resolve })), setTrayTip() {} },
    audio: { src: '', readyState: 1, currentTime: 0, pause() {}, removeEventListener() {}, play: async function () { played.push(this.src); } },
    setPlayIcon() {}, toast() {}, applyBalanceRouting() {}, startAgc() {}, syncQualityBtn() {}, renderList() {}, renderQueue() {}, ac: null };
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('const playback ='), source.indexOf('// 上一首 / 下一首')) + '\nthis.playerState = playback;', context);
  const old = context.playTrack({ bvid: 'old', title: '旧歌' }); await new Promise(setImmediate);
  const latest = context.playTrack({ bvid: 'new', title: '新歌', split: true, startSec: 200, endSec: 300 }); await new Promise(setImmediate);
  requests[1].resolve({ tracks: [{ url: 'https://new', backupUrls: ['https://backup'], kbps: 128 }] });
  assert.equal(await latest, true);
  requests[0].resolve({ tracks: [{ url: 'https://old' }] });
  assert.equal(await old, false);
  assert.deepEqual(played, ['https://new']);
  assert.equal(context.audio.currentTime, 200);
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
  console.log('PASS: latest playback wins, stale requests cannot play, backup and fresh URL recovery preserve position, bounded retries');
}
run().catch(error => { console.error(error); process.exitCode = 1; });
