// Actual main-process resolver functions, fake API and clock. No profile or media.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { createHash } = require('node:crypto'), { createRequire } = require('node:module');
const file = path.join(__dirname, '../main.js'), source = fs.readFileSync(file, 'utf8');
const success = { code: 0, data: { dash: { audio: [{ id: 30280, bandwidth: 320000, baseUrl: 'https://audio.example/a' }], flac: { audio: { id: 30251, bandwidth: 1200000, baseUrl: 'https://audio.example/flac' } } } } };
function fixture(reply) {
  let time = 1000000;
  const calls = [], c = { AbortSignal, createHash, require: createRequire(file), API: 'https://api.bilibili.com',
    identity: 'saved-session', cookieHeader: () => c.identity, ensureSession: async () => {}, ensureWbi: async () => {},
    signWbi: value => value, Date: { now: () => time },
    apiGet: async (host, endpoint, params) => { calls.push({ endpoint, params }); return reply(endpoint, calls.length); } };
  c.cookies = { get SESSDATA() { return c.identity; } };
  vm.createContext(c);
  vm.runInContext(source.slice(source.indexOf('const streamCache ='), source.indexOf("ipcMain.handle('bili:playurl'")), c);
  return { c, calls, advance: ms => { time += ms; } };
}
async function run() {
  const normal = fixture(() => success);
  assert.equal((await normal.c.getPlayurl('BV1CaPrz7EL6', 1)).flac.lossless, true);
  await normal.c.getPlayurl('BV1CaPrz7EL6', 1); assert.equal(normal.calls.length, 1);
  await normal.c.getPlayurl('BV1CaPrz7EL6', 1, true); assert.equal(normal.calls.length, 2);
  normal.c.identity = 'other-session'; await normal.c.getPlayurl('BV1CaPrz7EL6', 1); assert.equal(normal.calls.length, 3);
  const fallback = fixture(endpoint => endpoint.includes('/wbi/') ? { code: -412 } : success);
  const result = await fallback.c.getPlayurl('BV1CaPrz7EL6', 1);
  assert.equal(result.flac.lossless, true);
  assert.equal(fallback.calls.length, 2); assert.equal(fallback.calls[1].params.qn, 127); assert.equal(fallback.calls[1].params.fnval, 4048);
  assert.equal(fallback.c.identity, 'saved-session');
  await fallback.c.getPlayurl('BV1CaPrz7EL6', 2);
  assert.equal(fallback.calls.length, 3); assert.equal(fallback.calls[2].endpoint, '/x/player/playurl');
  fallback.advance(601000); await fallback.c.getPlayurl('BV1CaPrz7EL6', 3); assert.equal(fallback.calls[3].endpoint, '/x/player/wbi/playurl');
  const limited = fixture(() => ({ code: -412 }));
  await assert.rejects(limited.c.getPlayurl('BV1CaPrz7EL6', 1), /B站暂时拒绝/);
  await assert.rejects(limited.c.getPlayurl('BV1CaPrz7EL6', 2, true), /秒后重试/); assert.equal(limited.calls.length, 2);
  limited.advance(31000); await assert.rejects(limited.c.getPlayurl('BV1CaPrz7EL6', 2), /B站暂时拒绝/); assert.equal(limited.calls.length, 4);
  const throttled = fixture(() => ({ code: -429 }));
  await assert.rejects(throttled.c.getPlayurl('BV1CaPrz7EL6', 1), /B站暂时拒绝/); assert.equal(throttled.calls.length, 1);
  const denied = fixture(() => ({ code: -10403, message: '无权播放' }));
  await assert.rejects(denied.c.getPlayurl('BV1CaPrz7EL6', 1), /无权播放/); assert.equal(denied.calls.length, 1);
  let resolve; const gate = new Promise(r => { resolve = r; });
  const parallel = fixture(() => gate);
  const a = parallel.c.getPlayurl('BV1CaPrz7EL6', 1), b = parallel.c.getPlayurl('BV1CaPrz7EL6', 1, true);
  await new Promise(setImmediate); assert.equal(parallel.calls.length, 1); resolve(success);
  assert.equal((await a).tracks[0].kbps, 320); assert.equal((await b).tracks[0].kbps, 320);
  console.log('PASS: actual playurl cache/session isolation, bounded fallback, maximum quality preserved, sticky compatibility, cooldown, 429/rights handling and in-flight coalescing; no network/Electron/audio');
}
run().catch(error => { console.error(error); process.exitCode = 1; });

