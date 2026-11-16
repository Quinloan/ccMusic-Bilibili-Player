const assert = require('node:assert/strict');
const { headerFor, mergeCookies, correspondPath, createSessionMaintenance } = require('../bili-session.cjs');
const COOKIE = 'https://passport.bilibili.com/';
const issue = ['SESSDATA=new-session; Domain=.bilibili.com; Path=/; Secure', 'bili_jct=new-csrf; Domain=.bilibili.com; Path=/; Secure'];
function response(data, set = [], ok = true) { return { ok, headers: { getSetCookie: () => set }, json: async () => data, text: async () => String(data) }; }
function fixture(handler, auth = { refreshToken: 'old-refresh' }) {
  let clock = 2000000000000, state = { cookies: { SESSDATA: 'old-session', bili_jct: 'old-csrf', DedeUserID: 'user-a', buvid3: 'stable-device' }, meta: {}, auth, generation: 1 };
  const calls = [], saves = [];
  const controller = createSessionMaintenance({ now: () => clock, makePath: () => 'local-path', getState: () => structuredClone(state),
    commit: next => { state = structuredClone(next); saves.push(structuredClone(next)); }, headers: () => ({ 'User-Agent': 'test' }),
    request: async (url, options) => { assert.equal(options.redirect, 'error'); const call = { url, options }; calls.push(call); return handler(call, state, calls.length); } });
  return { controller, calls, saves, state: () => state, advance: ms => { clock += ms; }, change: fn => { fn(state); }, time: () => clock };
}
async function run() {
  assert.equal(correspondPath(Date.now()).length, 256);
  const start = { SESSDATA: 'session', buvid3: 'device' };
  const parsed = mergeCookies(start, {}, ['SESSDATA=rotated; Domain=.bilibili.com; Path=/', 'extra=ok; Domain=evil.example', 'host=x; Path=/private', 'short=gone; Domain=.bilibili.com; Max-Age=0'], COOKIE);
  assert.equal(parsed.cookies.SESSDATA, 'rotated'); assert.equal(parsed.cookies.extra, undefined);
  assert(!headerFor(parsed.cookies, parsed.meta, 'https://api.bilibili.com/').includes('host='));
  assert.equal(headerFor(parsed.cookies, parsed.meta, 'https://audio.bilivideo.com/'), '');
  assert.equal(headerFor(parsed.cookies, parsed.meta, 'http://api.bilibili.com/'), '');
  assert.equal(mergeCookies(start, {}, issue, 'https://untrusted.example').changed, false);
  assert.equal(mergeCookies(start, {}, ['SESSDATA=; Max-Age=0; Domain=.bilibili.com'], COOKIE).cookies.SESSDATA, 'session');
  assert.equal(mergeCookies({ DedeUserID: 'a', SESSDATA: 's' }, {}, ['SESSDATA=other; Domain=.bilibili.com', 'DedeUserID=b; Domain=.bilibili.com'], COOKIE).changed, false);
  const valid = fixture(() => response({ code: 0, data: { refresh: false } }));
  await Promise.all([valid.controller.check(), valid.controller.check()]); await valid.controller.check(); assert.equal(valid.calls.length, 1);
  valid.advance(25 * 3600 * 1000); await valid.controller.check(); assert.equal(valid.calls.length, 2);
  const legacy = fixture(() => response({ code: 0, data: { refresh: true } }), {});
  await legacy.controller.check(); assert.equal(legacy.calls.length, 1); assert.equal(legacy.state().auth.renewalRequired, true); assert.equal(legacy.state().cookies.SESSDATA, 'old-session');
  let failConfirm = true;
  const refresh = fixture((call, current) => {
    if (call.url.includes('/cookie/info')) return response({ code: 0, data: { refresh: true, timestamp: refresh.time() } });
    if (call.url.includes('/correspond/')) return response('<div id="1-name">temporary-csrf</div>');
    const body = new URLSearchParams(call.options.body);
    if (call.url.endsWith('/cookie/refresh')) {
      assert.equal(body.get('csrf'), 'old-csrf'); assert.equal(body.get('refresh_token'), 'old-refresh');
      assert.equal(body.get('refresh_csrf'), 'temporary-csrf');
      return response({ code: 0, data: { status: 0, refresh_token: 'new-refresh' } }, issue);
    }
    assert.equal(body.get('csrf'), 'new-csrf'); assert.equal(body.get('refresh_token'), 'old-refresh');
    assert.equal(current.auth.pendingConfirmToken, 'old-refresh', 'new pair must be durable before confirm');
    assert.equal(current.cookies.SESSDATA, 'new-session');
    if (failConfirm) throw Error('simulated network failure');
    return response({ code: 0 });
  });
  await refresh.controller.check(); assert.equal(refresh.state().cookies.buvid3, 'stable-device');
  assert.equal(refresh.state().auth.refreshToken, 'new-refresh'); assert.equal(refresh.state().auth.pendingConfirmToken, 'old-refresh');
  await refresh.controller.check(); assert.equal(refresh.calls.length, 4);
  refresh.advance(31 * 60 * 1000); failConfirm = false; await refresh.controller.check();
  assert.equal(refresh.calls.length, 5, 'retry confirmation without creating another session'); assert.equal(refresh.state().auth.pendingConfirmToken, '');
  for (const failure of [-412, -101, -352]) {
    const denied = fixture(() => response({ code: failure }));
    await denied.controller.check(); assert.equal(denied.calls.length, 1); assert.equal(denied.state().cookies.SESSDATA, 'old-session');
  }
  const incomplete = fixture(call => call.url.includes('/info') ? response({ code: 0, data: { refresh: true, timestamp: incomplete.time() } }) : call.url.includes('/correspond/') ? response('<div id="1-name">csrf</div>') : response({ code: 0, data: { status: 0, refresh_token: 'new' } }, issue.slice(0, 1)));
  await incomplete.controller.check(); assert.equal(incomplete.state().cookies.SESSDATA, 'old-session'); assert.equal(incomplete.calls.length, 3);
  const mismatch = fixture(call => call.url.includes('/info') ? response({ code: 0, data: { refresh: true, timestamp: mismatch.time() } }) : call.url.includes('/correspond/') ? response('<div id="1-name">csrf</div>') : response({ code: 86095 }));
  await mismatch.controller.check(); assert.equal(mismatch.state().auth.renewalRequired, true); assert.equal(mismatch.state().cookies.SESSDATA, 'old-session');
  let complete;
  const race = fixture(() => new Promise(resolve => { complete = resolve; }));
  const pending = race.controller.check(); await new Promise(setImmediate);
  race.change(s => { s.cookies.SESSDATA = 'new-login'; s.generation++; });
  complete(response({ code: 0, data: { refresh: true, timestamp: race.time() } })); await pending;
  assert.equal(race.calls.length, 1); assert.equal(race.state().cookies.SESSDATA, 'new-login');
  console.log('PASS: scoped cookie merge/expiry/domain/account guards, RSA path, daily check/coalescing, legacy login, refresh transaction, durable-before-confirm, confirmation retry, backoff, malformed response and account-switch races; fake credentials/network only');
}
run().catch(error => { console.error(error); process.exitCode = 1; });
