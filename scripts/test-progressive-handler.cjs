// Actual main-process handler and FFmpeg, complete local audio; providers are controlled.
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), assert = require('node:assert/strict');
const { createRequire } = require('node:module'), { createHash } = require('node:crypto');
const { Readable } = require('node:stream'), { EventEmitter } = require('node:events');
const root = path.resolve(__dirname, '..');
async function run() {
  const dir = path.join(root, 'validation/BV12M4m1y7hf');
  const fixture = JSON.parse(fs.readFileSync(path.join(dir, 'fixture.json')));
  assert(fixture.complete, 'use the complete existing local fixture');
  const handlers = new Map(), localRequire = createRequire(path.join(root, 'main.js'));
  const profile = fs.mkdtempSync(path.join(root, 'validation/progressive-handler-'));
  let downloads = 0, calls = 0, blockAfter = Infinity, unblock;
  const events = []; let onProgress;
  const sender = Object.assign(new EventEmitter(), { id: 704, send: (_channel, p) => { events.push(p); onProgress?.(p); } });
  const context = { require: name => name === './lyric-recognition.cjs' ? { lyricsAvailable: () => false } : localRequire(name),
    fs, path, os: require('node:os'), __dirname: root, app: { isPackaged: false, getPath: () => profile }, process,
    spawn: require('node:child_process').spawn, createHash, AbortController, AbortSignal, Buffer, Float32Array, setTimeout,
    console: { log() {} }, apiHeaders: () => ({}), agent: undefined, netInit: async () => {},
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    getPlayurl: async () => ({ tracks: [{ url: 'fixture://audio' }] }),
    ufetch: async url => {
      assert.equal(url, 'fixture://audio', 'no real provider/network call in this regression'); downloads++;
      return new Response(Readable.toWeb(fs.createReadStream(path.join(dir, 'audio-head.m4s'))), { headers: { 'content-length': fixture.bytes } });
    },
  };
  vm.createContext(context);
  const source = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  vm.runInContext(source.slice(source.indexOf('const SPLIT_RATE ='), source.indexOf("ipcMain.handle('login:qrcode'")), context);
  context.identifySong = async (_pcm, signal) => {
    calls++; signal?.throwIfAborted();
    if (calls >= blockAfter) await localRequire('./cancellation.cjs').waitFor(new Promise(resolve => { unblock = resolve; }), signal);
    return { name: '测试歌曲', artist: '测试歌手', source: 'netease', neteaseId: '347230', cover: 'https://p1.music.126.net/test-cover.jpg' };
  };
  const invoke = (id, options, owner = sender) => handlers.get('split:analyze')({ sender: owner }, 'BV12M4m1y7hf', 11, undefined, '', id, options);
  try {
    assert.equal(await handlers.get('artwork:resolve')({ sender }, { name: '直接封面', cover: 'https://p1.music.126.net/direct.jpg' }), 'https://p1.music.126.net/direct.jpg');
    assert(fs.existsSync(path.join(profile, 'song-artwork-cache.json')), 'actual artwork IPC persists metadata in the user profile');
    const split = await invoke('cut', { mode: 'split' });
    assert(split.tracks.length >= 2); assert.equal(calls, 0, 'split-only must not call recognition');
    assert(split.sessionId); assert.equal(downloads, 1);
    assert.equal(handlers.get('split:release')({ sender: { id: 999 } }, split.sessionId), false, 'sessions are owned by the renderer');
    const mid = Math.round(split.duration / 2);
    const confirmed = [{ start: 0, end: mid, title: '' }, { start: mid, end: split.duration, title: '' }];
    blockAfter = 3;
    let finished = false, first;
    const firstProgress = new Promise(resolve => { onProgress = p => { if (p.stage === 'identify' && p.index === 0) { first = p; resolve(); } }; });
    const recognizing = invoke('name', { mode: 'recognize', sessionId: split.sessionId, tracks: confirmed }).then(r => { finished = true; return r; });
    await firstProgress; await new Promise(setImmediate);
    assert.equal(first.track.title, '测试歌曲'); assert.equal(finished, false, 'first hit arrives before the batch promise resolves');
    assert.equal(first.track.neteaseId, '347230'); assert.equal(first.track.songCover, 'https://p1.music.126.net/test-cover.jpg');
    assert.equal(downloads, 1, 'confirmation reuses PCM without another download/decode');
    assert.equal(calls, 3, 'next song starts only after the first result event');
    blockAfter = Infinity; unblock();
    const result = await recognizing;
    assert.equal(result.tracks.length, 2, 'identical recognition must not auto-merge confirmed cuts');
    assert(result.tracks.every(t => t.title === '测试歌曲'));
    assert.deepEqual(result.tracks.map(t => [t.start, t.end]), confirmed.map(t => [t.start, t.end]));
    assert.equal(vm.runInContext('splitSessions.size', context), 0);
    assert.equal(sender.listenerCount('destroyed'), 0, 'session and active-job ownership listeners are cleaned');
    const cached = await invoke('cached', { mode: 'recognize', sessionId: 'expired', tracks: confirmed });
    assert(cached.tracks.every(t => t.neteaseId === '347230' && t.songCover === first.track.songCover));
    assert.equal(calls, 4, 'completed per-song cache reuses provider results');
    // Retry after an expired session: decode once, skip checked and manually named rows.
    const retry = await invoke('resume', { mode: 'recognize', sessionId: 'expired', tracks: [{ ...confirmed[0], checked: true }, { ...confirmed[1], title: '用户改名', source: 'manual' }] });
    assert.equal(downloads, 3); assert.equal(calls, 4); assert.equal(retry.tracks[1].title, '用户改名');
    assert.equal(fs.readFileSync(path.join(profile, 'split-analysis-cache.json'), 'utf8').includes('用户改名'), false, 'manual titles must not become shared recognition cache entries');
    fs.unlinkSync(path.join(profile, 'split-analysis-cache.json'));
    const cut2 = await invoke('cut2', { mode: 'split' });
    calls = 0; blockAfter = 3;
    let firstCancel;
    const readyCancel = new Promise(resolve => { firstCancel = resolve; });
    onProgress = p => { if (p.requestId === 'cancel' && p.stage === 'identify' && p.index === 0) firstCancel(); };
    const cancelling = invoke('cancel', { mode: 'recognize', sessionId: cut2.sessionId, tracks: confirmed });
    const rejected = assert.rejects(cancelling, /abort/i);
    await readyCancel; await new Promise(setImmediate);
    const queuedDownloads = downloads;
    const queued = invoke('queued-cancel', { mode: 'recognize', sessionId: 'expired', tracks: confirmed });
    const queuedRejected = assert.rejects(queued, /abort/i);
    await new Promise(setImmediate);
    assert.equal(downloads, queuedDownloads, 'queued recognition does not decode another full sample set');
    assert.equal(handlers.get('split:cancel')({ sender }, 'queued-cancel'), true);
    await queuedRejected;
    assert.equal(handlers.get('split:cancel')({ sender }, 'cancel'), true);
    await rejected;
    assert.equal(vm.runInContext('splitJobs.size + splitSessions.size', context), 0);
    assert.equal(sender.listenerCount('destroyed'), 0);
    // Corrupt confirmation data must fail before downloading.
    const before = downloads;
    await assert.rejects(invoke('bad', { mode: 'recognize', tracks: [{ start: 0, end: 10 }, { start: 20, end: 100 }] }), /时间范围/);
    assert.equal(downloads, before);
    const cut3 = await invoke('cut3', { mode: 'split' });
    assert(cut3.sessionId); sender.emit('destroyed');
    assert.equal(vm.runInContext('splitSessions.size', context), 0, 'closing renderer releases unused samples');
    console.log('PASS: real FFmpeg split has zero identification; PCM reuse; sequential per-song events before final response; exact confirmed cuts; checked/manual skips; expired session fallback; cancellation/invalid input/owner cleanup');
  } finally {
    vm.runInContext('for (const id of [...splitSessions.keys()]) disposeSplitSession(id)', context);
    // Profile contains only test-created cache; remove only this verified workspace path.
    assert(profile.startsWith(path.join(root, 'validation/progressive-handler-')));
    fs.rmSync(profile, { recursive: true, force: true });
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
