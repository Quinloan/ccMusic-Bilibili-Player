// Controlled network/conversion barriers, no Electron, network or audio playback.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { createDownloader } = require('../audio-downloads.cjs');
const { waitFor } = require('../cancellation.cjs');
const root = path.resolve(__dirname, '..'), dir = fs.mkdtempSync(path.join(root, 'validation/pipeline-'));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function bounded(promise) {
  let timer; try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Pipeline barrier timed out')), 5000); })]); }
  finally { clearTimeout(timer); }
}
const owner = {}, base = { bvid: 'BV1CaPrz7EL6', page: 1, split: true, startSec: 0, endSec: 10 };
const items = [1, 2, 1].map((cid, i) => ({ ...base, cid, title: '曲目' + i }));
const playurl = async (_bvid, cid) => ({ tracks: [{ id: 30280, codecs: 'aac', kbps: 192, url: 'https://fixture.invalid/' + cid }] });
async function main() {
  const gate = deferred(), downloaded = deferred(), converting = deferred();
  let transfers = 0, queued = 0, active = 0, maxActive = 0; const paths = [];
  const manager = createDownloader({ executable: '', tempRoot: dir, headers: () => ({}), resolveItem: async x => x, getPlayurl: playurl,
    request: async url => { transfers++; return new Response('source-' + url.split('/').at(-1)); },
    onUpdate: (_, task) => { if (task.state === 'waiting-conversion' && ++queued === 3) downloaded.resolve(); },
    convert: async ({ input, output, item, signal }) => {
      active++; maxActive = Math.max(active, maxActive); paths.push(input);
      try {
        const before = await fs.promises.readFile(input, 'utf8');
        if (item.title === '曲目0') { converting.resolve(); await waitFor(gate.promise, signal); }
        assert.equal(await fs.promises.readFile(input, 'utf8'), before, 'later downloads must not overwrite an in-use source');
        assert.equal(before, 'source-' + item.cid);
        await fs.promises.writeFile(output, before);
      } finally { active--; }
    } });
  manager.add(owner, items, dir);
  try {
    await bounded(converting.promise); await bounded(downloaded.promise);
    assert.equal(transfers, 2, 'A/B/A split batch transfers each source once');
    assert.deepEqual(manager.list(owner).map(t => t.state), ['saving', 'waiting-conversion', 'waiting-conversion'], 'all downloads finish before the blocked first conversion completes');
  } finally { gate.resolve(); await manager.idle(); }
  assert.equal(maxActive, 1, 'conversion has its own single worker lane');
  assert.deepEqual(manager.list(owner).map(t => t.state), ['done', 'done', 'done']);
  assert.equal(paths[0], paths[2]); assert.notEqual(paths[0], paths[1]);
  for (const job of manager.list(owner)) fs.unlinkSync(job.file);
  assert.deepEqual(fs.readdirSync(dir), []);

  // Hidden waiting records and their active conversion still belong to shutdown.
  let ready = 0; const allWaiting = deferred();
  const hidden = createDownloader({ executable: '', tempRoot: dir, headers: () => ({}), resolveItem: async x => x, getPlayurl: playurl,
    request: async () => new Response('source'),
    onUpdate: (_, t) => { if (t.state === 'waiting-conversion' && ++ready === 3) allWaiting.resolve(); },
    convert: async ({ signal }) => { await waitFor(new Promise(() => {}), signal); } });
  hidden.add(owner, items, dir); await bounded(allWaiting.promise);
  hidden.cancelOwner(owner); assert.deepEqual(hidden.list(owner), []);
  await bounded(hidden.shutdown()); assert.equal(hidden.hasPending(), false); assert.deepEqual(fs.readdirSync(dir), []);

  // Bulk actions are owner/batch scoped, including queued conversions hidden on cancel.
  const allQueued = deferred(); let queuedForBulk = 0;
  const bulk = createDownloader({ executable: '', tempRoot: dir, headers: () => ({}), resolveItem: async x => x, getPlayurl: playurl,
    request: async () => new Response('source'),
    onUpdate: (_, t) => { if (t.state === 'waiting-conversion' && ++queuedForBulk === 3) allQueued.resolve(); },
    convert: async ({ signal }) => waitFor(new Promise(() => {}), signal) });
  const batchA = bulk.add(owner, items, dir); await bounded(allQueued.promise);
  const batchB = bulk.add(owner, [items[0]], dir), otherOwner = {};
  const foreign = bulk.add(otherOwner, [items[0]], dir);
  assert.throws(() => bulk.manage(owner, 'delete'), /无效/);
  assert.throws(() => bulk.manage(owner, 'cancel', {}), /无效/);
  assert.deepEqual(bulk.manage(otherOwner, 'cancel', batchA[0].batchId).removed, []);
  assert.deepEqual(bulk.manage(owner, 'clear').removed, [], 'clear never interrupts live work');
  const result = bulk.manage(owner, 'cancel', batchA[0].batchId);
  assert.equal(result.cancelled, 3); assert.deepEqual(result.removed, batchA.map(t => t.id));
  assert.deepEqual(bulk.list(owner).map(t => t.id), batchB.map(t => t.id));
  assert.equal(bulk.manage(owner, 'cancel').cancelled, 1);
  assert.deepEqual(bulk.list(otherOwner).map(t => t.id), foreign.map(t => t.id));
  bulk.manage(otherOwner, 'cancel'); await bounded(bulk.idle());
  assert.equal(bulk.hasPending(), false); assert.deepEqual(fs.readdirSync(dir), []);

  // Abort while network and encoder lanes are both busy.
  const network = deferred(), encoder = deferred(); let calls = 0;
  const quitting = createDownloader({ executable: '', tempRoot: dir, headers: () => ({}), resolveItem: async x => x, getPlayurl: playurl,
    onUpdate() {}, request: async (_url, { signal }) => {
      if (++calls === 1) return new Response('source');
      return new Response(new ReadableStream({ start(stream) {
        stream.enqueue(Buffer.from('partial')); signal.addEventListener('abort', () => stream.error(signal.reason), { once: true }); network.resolve();
      } }));
    }, convert: async ({ signal }) => { encoder.resolve(); await waitFor(new Promise(() => {}), signal); } });
  quitting.add(owner, items, dir); await bounded(Promise.all([network.promise, encoder.promise]));
  await bounded(quitting.shutdown()); assert.equal(quitting.hasPending(), false);
  assert(quitting.list(owner).every(t => t.state === 'cancelled')); assert.deepEqual(fs.readdirSync(dir), []);

  // A failed conversion does not block later downloads or conversions.
  let count = 0;
  const failing = createDownloader({ executable: '', tempRoot: dir, headers: () => ({}), resolveItem: async x => x, getPlayurl: playurl,
    onUpdate() {}, request: async () => new Response('source'), convert: async ({ output }) => {
      if (++count === 1) throw Error('conversion failure'); await fs.promises.writeFile(output, 'complete');
    } });
  failing.add(owner, items.slice(0, 2), dir); await bounded(failing.idle());
  assert.deepEqual(failing.list(owner).map(t => t.state), ['error', 'done']);
  assert.equal(failing.list(owner)[1].batchProgress.saved, 1);
  assert.equal(failing.list(owner)[1].batchProgress.failed, 1, 'conversion failures never count as saved songs');
  const savedFile = failing.list(owner)[1].file;
  assert.equal(failing.manage({}, 'clear').removed.length, 0);
  assert.equal(failing.manage(owner, 'clear').removed.length, 2);
  assert.equal(fs.existsSync(savedFile), true, 'clearing records must never delete saved songs');
  fs.unlinkSync(savedFile); assert.deepEqual(fs.readdirSync(dir), []);

  // A final exclusive file copy is allowed to complete, never cut off midway.
  let committingResult, committingManager;
  committingManager = createDownloader({ executable: '', tempRoot: dir, headers: () => ({}), resolveItem: async x => x, getPlayurl: playurl,
    request: async () => new Response('source'), convert: async ({ output }) => fs.promises.writeFile(output, 'complete'),
    onUpdate: (_, t) => { if (t.state === 'committing') committingResult = committingManager.manage(owner, 'cancel'); } });
  committingManager.add(owner, items.slice(0, 2), dir); await bounded(committingManager.idle());
  assert.equal(committingResult.committing, 1); assert.equal(committingResult.cancelled, 1);
  assert.deepEqual(committingManager.list(owner).map(t => t.state), ['done']);
  fs.unlinkSync(committingManager.list(owner)[0].file); assert.deepEqual(fs.readdirSync(dir), []);

  // A later slow network request must not delay an earlier finished song.
  const releaseNetwork = deferred(), secondDownload = deferred(), firstDone = deferred(); let fetched = 0;
  const slowNetwork = createDownloader({ executable: '', tempRoot: dir, headers: () => ({}), resolveItem: async x => x, getPlayurl: playurl,
    onUpdate: (_, t) => { if (t.state === 'done' && t.title === items[0].title) firstDone.resolve(); },
    request: async (_url, { signal }) => {
      if (++fetched === 2) { secondDownload.resolve(); await waitFor(releaseNetwork.promise, signal); }
      return new Response('source');
    }, convert: async ({ output }) => { await fs.promises.writeFile(output, 'complete'); } });
  slowNetwork.add(owner, items.slice(0, 2), dir);
  try {
    await bounded(secondDownload.promise); await bounded(firstDone.promise);
    assert.equal(slowNetwork.list(owner)[1].state, 'downloading');
  } finally { releaseNetwork.resolve(); await slowNetwork.idle(); }
  for (const t of slowNetwork.list(owner)) fs.unlinkSync(t.file);
  assert.deepEqual(fs.readdirSync(dir), []);
  console.log('PASS: download/encoding lanes, immutable cache, scoped bulk cancel/clear, cancelled conversion cleanup, ownership, saved files and committing protection, shutdown and failure isolation');
}
main().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => { fs.rmdirSync(dir); });
