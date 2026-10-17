// Verify actual main-process scheduling with a virtual clock and fixed replies.
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const assert = require('node:assert/strict'), { createHash } = require('node:crypto');
const root = path.resolve(__dirname, '..');
function slice(source) { return source.slice(source.indexOf('const SPLIT_RATE ='), source.indexOf('async function identifyNetease(')); }
async function exercise(source, backoff = false) {
  let clock = 0, active = 0, maximum = 0; const starts = [], results = [];
  class Clock extends Date { static now() { return clock; } }
  const context = { Buffer, Date: Clock, createHash, console, app: {}, path, process,
    require: name => name === 'node:timers/promises' ? { setTimeout: async (ms, _value, { signal } = {}) => { signal?.throwIfAborted(); clock += ms; } } : require(path.join(root, name)),
    identifyNetease: async () => {
      active++; maximum = Math.max(maximum, active); starts.push(clock); clock += 350;
      await Promise.resolve(); active--;
      if (backoff && starts.length === 1) vm.runInContext('identifyNextAt = Date.now() + 15000', context);
      return { name: '测试歌曲', artist: '测试歌手', source: 'netease' };
    } };
  vm.createContext(context); vm.runInContext(slice(source), context);
  const samples = ['one', 'two', 'three'].map(value => Buffer.from(value));
  await Promise.all(samples.map(async pcm => { results.push(await context.identifySong(pcm)); }));
  assert.equal(maximum, 1, 'providers must stay serial');
  const calls = starts.length; await context.identifySong(samples[0]); assert.equal(starts.length, calls, 'cache hit must not issue a request');
  const controller = new AbortController();
  const cancelled = context.identifySong(Buffer.from('cancelled'), controller.signal);
  controller.abort(new Error('cancelled'));
  await assert.rejects(cancelled, /cancelled/);
  await vm.runInContext('identifyQueue', context);
  assert.equal(starts.length, calls, 'cancelled work must not reach provider');
  assert.equal(results.length, 3);
  return { starts, elapsedMs: clock, requests: calls, maxConcurrent: maximum };
}
async function run() {
  const source = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  const result = await exercise(source);
  for (let i = 1; i < result.starts.length; i++) assert(result.starts[i] - result.starts[i - 1] >= 1000);
  const throttled = await exercise(source, true);
  assert(throttled.starts[1] - throttled.starts[0] >= 15000, 'provider backoff must survive queue scheduling');
  const previous = path.join(root, 'release-work/v1.6.0-beta.1/main.js');
  const snapshot = path.join(root, 'validation/identify-queue-before.js');
  if (!fs.existsSync(snapshot) && fs.existsSync(previous)) {
    const text = fs.readFileSync(previous, 'utf8');
    if (text.includes('finally { identifyNextAt = Date.now() + 1200; }')) fs.writeFileSync(snapshot, text);
  }
  const before = fs.existsSync(snapshot) ? await exercise(fs.readFileSync(snapshot, 'utf8')) : null;
  const report = { condition: 'Virtual clock, same three 350ms provider replies, real identifySong scheduling; not an online end-to-end speed claim.', before, after: result, throttled };
  fs.writeFileSync(path.join(root, 'validation/identify-queue-timing.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  console.log('PASS: serial providers, bounded start rate, cache hit, cancellation, provider backoff; unchanged reply payloads');
}
run().catch(error => { console.error(error); process.exitCode = 1; });
