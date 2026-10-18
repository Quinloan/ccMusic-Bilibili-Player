const assert = require('node:assert/strict');
const { createMetadataQueue } = require('../renderer/library-model.js');
const { createArtworkResolver } = require('../cover-art.cjs');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
  const end = Date.now() + 3000;
  while (!check()) { assert.ok(Date.now() < end, 'bounded queue should make progress'); await sleep(2); }
}
async function run() {
  const queue = createMetadataQueue({ concurrency: 2, timeout: 100 });
  let release, active = 0, peak = 0;
  const starts = [];
  const jobs = Array.from({ length: 250 }, (_, i) => queue.add(async signal => {
    starts.push(i); active++; peak = Math.max(peak, active);
    try {
      if (i === 0) await new Promise(resolve => { release = resolve; });
      else await sleep(1);
      return signal.aborted ? null : i;
    } finally { active--; }
  }));
  jobs[249].promote(10);
  assert.deepEqual(await jobs[249], 249); assert.ok(starts.indexOf(249) < 2);
  assert.equal(await jobs[0], null, 'a transport ignoring abort cannot stall the queue');
  release(); await Promise.all(jobs); await until(() => queue.active === 0);
  assert.equal(peak <= 3, true, 'at most two live jobs plus a timed-out noncooperative mock');
  assert.equal(queue.waiting, 0);
  const stamps = [], limited = createMetadataQueue({ interval: 20, timeout: 300 });
  await Promise.all(Array.from({ length: 5 }, () => limited.add(() => { stamps.push(Date.now()); return true; })));
  assert.ok(stamps.slice(1).every((t, i) => t - stamps[i] >= 18), 'global start interval is preserved');
  // Use the actual resolver: a stuck title and cover must release their slots,
  // and late provider replies must not poison the refreshed cache.
  let phase = 'stuck', late = [], calls = 0;
  const resolver = createArtworkResolver({ interval: 0, timeout: 80, request: async () => {
    calls++;
    if (phase === 'stuck') return new Promise(resolve => late.push(resolve));
    return Response.json({ code: 200, result: { songs: [{ id: 1, name: '普通朋友', ar: [{ name: '陶喆' }], al: { picUrl: 'https://art.test/original.png' } }] } });
  } });
  const input = { title: '陶喆《普通朋友》' };
  const first = resolver.resolveTitle(input), cover = resolver.resolve({ name: '普通朋友', artist: '陶喆' });
  await until(() => late.length === 2);
  assert.equal(await first, null); assert.equal(await cover, '');
  phase = 'ready';
  const repaired = await resolver.resolveTitle({ ...input, refresh: true }); assert.equal(repaired.matched, true);
  late.forEach(resolve => resolve(Response.json({ code: 200, result: { songs: [] } })));
  await sleep(20); const before = calls;
  assert.deepEqual(await resolver.resolveTitle(input), repaired); assert.equal(calls, before, 'expired work must not overwrite a newer cache entry');
  console.log('PASS: 250-item bounded/promotable queue, request deadline, global rate limit, actual title/cover provider hangs, recovery and late-result cache protection');
}
run().catch(error => { console.error(error); process.exitCode = 1; });
