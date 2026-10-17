const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { spawnSync } = require('node:child_process');
const { normalizePlayInfo, bestTrack, safeName, validateItems, createDownloader } = require('../audio-downloads.cjs');
const { registerDownloads } = require('../download-ipc.cjs');
const root = path.resolve(__dirname, '..'), executable = process.env.CCMUSIC_FFMPEG || path.join(root, 'resources/download-audio/ffmpeg.exe');
const item = { bvid: 'BV1uuHd6cEhy', cid: 1, page: 1, title: '测试:歌曲?<>', artist: '歌手' };
const track = { id: 30280, codecs: 'mp4a.40.2', kbps: 192, url: 'https://audio.test/aac' };
async function run() {
  const dir = fs.mkdtempSync(path.join(root, 'validation/download-test-'));
  const created = [];
  try {
    assert.equal(bestTrack(normalizePlayInfo({ dash: { audio: [{ id: 30280, bandwidth: 192000, baseUrl: track.url }], flac: { audio: { id: 30251, bandwidth: 900000, base_url: 'https://audio.test/flac' } }, dolby: { audio: [{ id: 30250, bandwidth: 448000, baseUrl: 'https://audio.test/dolby' }] } } })).id, 30251);
    assert.equal(bestTrack(normalizePlayInfo({ dash: { audio: [{ ...track, bandwidth: 192000 }], dolby: { audio: [{ id: 30250, bandwidth: 448000, baseUrl: 'https://audio.test/dolby' }] } } })).id, 30250);
    assert.equal(safeName('CON.mp3'), '_CON.mp3'); assert.equal(safeName('../../坏:名字?'), '.. .. 坏 名字');
    assert.throws(() => validateItems([{ ...item, split: true, startSec: 9, endSec: 8 }]));
    assert.throws(() => validateItems([{ ...item, bvid: '../bad' }]));
    const source = path.join(dir, 'source.m4a'); created.push(source);
    // Synthetic 4-second / 48 kHz tone; a test fixture must not require the runtime
    // decoder to contain a signal generator and an AAC encoder.
    fs.copyFileSync(path.join(__dirname, 'fixtures/tone-aac.m4a'), source);
    const bytes = fs.readFileSync(source); let refreshes = 0, transfers = 0;
    const owner = {}, other = {}, updates = [];
    const manager = createDownloader({ executable, tempRoot: dir, onUpdate: (_, task) => updates.push(task), resolveItem: async x => x,
      getPlayurl: async (_bv, _cid, refresh) => { assert.equal(refresh, true); refreshes++; return { tracks: [track] }; },
      headers: () => ({}), request: async () => { transfers++; return new Response(bytes, { headers: { 'content-length': String(bytes.length) } }); } });
    const first = manager.add(owner, validateItems([item, { ...item, split: true, startSec: 1, endSec: 2.25 }]), dir);
    assert.equal(manager.cancel(other, first[0].id), false);
    await manager.idle();
    const complete = manager.list(owner); assert.deepEqual(complete.map(t => t.state), ['done', 'done']);
    assert.equal(transfers, 1, 'batch splits reuse the same downloaded source');
    assert.ok(complete[0].file.endsWith('.m4a')); assert.ok(complete[1].file.endsWith('.flac'));
    created.push(...complete.map(task => task.file));
    assert.ok(complete.every(task => task.file.startsWith(dir + path.sep)));
    const flacSource = path.join(dir, 'lossless-source.flac'); created.push(flacSource);
    assert.equal(spawnSync(executable, ['-v', 'error', '-i', source, '-c:a', 'flac', flacSource], { windowsHide: true }).status, 0);
    const losslessTrack = { id: 30251, codecs: 'fLaC', lossless: true, kbps: 600, url: 'https://audio.test/flac' };
    const lossless = createDownloader({ executable, tempRoot: dir, onUpdate() {}, resolveItem: async x => x, headers: () => ({}),
      getPlayurl: async () => ({ tracks: [track], flac: losslessTrack }), request: async url => { assert.equal(url, losslessTrack.url); return new Response(fs.readFileSync(flacSource)); } });
    lossless.add(owner, [{ ...item, title: '无损封装路径验证' }], dir); await lossless.idle();
    const losslessJob = lossless.list(owner)[0]; assert.equal(losslessJob.state, 'done'); assert.ok(losslessJob.file.endsWith('.flac')); created.push(losslessJob.file);
    const decoded = spawnSync(executable, ['-v', 'error', '-i', complete[1].file, '-f', 's16le', '-ac', '1', '-ar', '48000', 'pipe:1'], { windowsHide: true });
    assert.equal(decoded.status, 0); assert.equal(decoded.stdout.length, 1.25 * 48000 * 2, 'split must contain only requested 1.25 seconds');
    const originalDecoded = spawnSync(executable, ['-v', 'error', '-i', source, '-f', 's16le', 'pipe:1'], { windowsHide: true });
    const remuxDecoded = spawnSync(executable, ['-v', 'error', '-i', complete[0].file, '-f', 's16le', 'pipe:1'], { windowsHide: true });
    assert.deepEqual(originalDecoded.stdout, remuxDecoded.stdout, 'whole song retains encoded audio without lossy re-encoding');
    assert.equal(manager.reveal(other, first[0].id), null); assert.equal(manager.dismiss(other, first[0].id), false);
    manager.add(owner, [item], dir); await manager.idle();
    const duplicate = manager.list(owner).at(-1); created.push(duplicate.file); assert.ok(duplicate.file.endsWith('(1).m4a')); assert.equal(refreshes, 3);
    const bad = createDownloader({ executable, tempRoot: dir, onUpdate() {}, resolveItem: async x => x, headers: () => ({}),
      getPlayurl: async () => ({ tracks: [track], flac: { ...track, lossless: true, url: 'https://audio.test/flac' } }),
      request: async url => { assert.equal(url, 'https://audio.test/flac'); return new Response('error', { status: 403 }); } });
    const [badJob] = bad.add(owner, [item], dir); await bad.idle(); assert.equal(bad.list(owner)[0].state, 'error', 'failure must not silently downgrade');
    assert.match(bad.list(owner)[0].error, /403/); bad.retry(owner, badJob.id); await bad.idle(); assert.equal(bad.list(owner).length, 2);
    let started;
    const waitStarted = new Promise(resolve => { started = resolve; });
    const cancelled = createDownloader({ executable, tempRoot: dir, onUpdate() {}, resolveItem: async x => x, headers: () => ({}), getPlayurl: async () => ({ tracks: [track] }),
      request: async (_url, { signal }) => new Response(new ReadableStream({ start(stream) { stream.enqueue(bytes.subarray(0, 10)); started(); signal.addEventListener('abort', () => stream.error(signal.reason), { once: true }); } })) });
    const tasks = cancelled.add(owner, [item, item], dir); await waitStarted;
    assert.equal(cancelled.cancel(owner, tasks[0].id), true); assert.equal(cancelled.cancel(owner, tasks[1].id), true);
    await cancelled.idle(); assert.deepEqual(cancelled.list(owner).map(t => t.state), ['cancelled', 'cancelled']);
    let prepared;
    const startedPreparing = new Promise(resolve => { prepared = resolve; });
    const exiting = createDownloader({ executable, tempRoot: dir, onUpdate: (_, task) => { if (task.state === 'preparing') prepared(); },
      resolveItem: () => new Promise(() => {}), getPlayurl() {}, headers() {}, request() {} });
    exiting.add(owner, [item, item], dir); await startedPreparing;
    assert.equal(exiting.hasPending(), true); await exiting.shutdown(); assert.equal(exiting.hasPending(), false);
    assert.deepEqual(exiting.list(owner).map(task => task.state), ['cancelled', 'cancelled']);
    assert.throws(() => exiting.add(owner, [item], dir), /正在退出/);
    assert.equal(fs.readdirSync(dir).some(name => name.startsWith('ccmusic-download-')), false, 'temporary files cleaned on failure/cancel/success');
    // Verify the privileged IPC gate before a native dialog or any network download.
    const handlers = new Map(); let dialogs = 0, logged = false;
    const ipc = registerDownloads({ ipcMain: { handle: (key, fn) => handlers.set(key, fn) }, dialog: { showOpenDialog: async () => { dialogs++; return { canceled: true }; } },
      BrowserWindow: { fromWebContents: () => null }, shell: {}, executable, getLoginState: async () => ({ logged }), getPlayurl: async () => { throw Error('must not request'); }, resolveItem: async x => x, request() {}, headers() {} });
    const event = { sender: { isDestroyed: () => false } }, start = handlers.get('download:start');
    assert.deepEqual(await start(event, [item]), { needsLogin: true, stale: false }); assert.equal(dialogs, 0);
    assert.deepEqual(await start(event, [item], true), { cancelled: true }); assert.equal(dialogs, 1);
    logged = true; assert.deepEqual(await start(event, [item]), { cancelled: true }); assert.equal(dialogs, 2); await ipc.idle();
    console.log('PASS: highest FLAC/Dolby/AAC selection, fresh URLs, real FFmpeg remux and exact split, names/collisions, no silent downgrade, cancellation/cleanup/ownership, IPC login gate');
  } finally {
    for (const file of created) fs.rmSync(file, { force: true });
    fs.rmdirSync(dir); // Deliberately nonrecursive: leftovers fail the test.
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
