// Execute only the actual login-state functions: no Electron, network or profile.
const vm = require('node:vm'), fs = require('node:fs'), assert = require('node:assert/strict');
const source = fs.readFileSync(require('node:path').join(__dirname, '../main.js'), 'utf8');
const functions = source.slice(source.indexOf('function loadCookies()'), source.indexOf("ipcMain.handle('login:state'"));
async function run() {
  function fixture(saved = {}, reply) {
    const c = { cookies: {}, cookiesLoaded: false, reads: 0, net: 0, writes: 0, reply, AbortSignal, API: '',
      readStore() { c.reads++; return { cookies: saved }; }, persistCookies() { c.writes++; },
      async netInit() { c.net++; }, async apiGet() { return typeof c.reply === 'function' ? c.reply() : c.reply; },
      ensureSession() { throw Error('Login state must not wait for WBI/fingerprint'); } };
    vm.createContext(c); vm.runInContext(functions, c); return c;
  }
  const anonymous = fixture(); assert.equal((await anonymous.getLoginState()).logged, false); assert.equal(anonymous.net, 0);
  const expired = fixture({ SESSDATA: 'test-expired' }, { code: -101, data: { isLogin: false } });
  assert.equal((await expired.getLoginState()).logged, false); assert.equal(expired.cookies.SESSDATA, undefined); assert.equal(expired.writes, 1);
  const valid = fixture({ SESSDATA: 'test-valid' }, { code: 0, data: { isLogin: true, uname: '测试' } });
  assert.equal((await valid.getLoginState()).logged, true);
  for (const reply of [null, { code: -412 }, { code: 0, data: {} }]) {
    const unknown = fixture({ SESSDATA: 'test-retained' }, reply);
    assert.equal((await unknown.getLoginState()).stale, true); assert.equal(unknown.writes, 0); assert.equal(unknown.cookies.SESSDATA, 'test-retained');
  }
  let finish;
  const race = fixture({ SESSDATA: 'test-old' }, () => new Promise(resolve => { finish = resolve; }));
  const pending = race.getLoginState();
  for (let i = 0; !finish && i < 20; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(typeof finish, 'function');
  race.cookies.SESSDATA = 'test-new'; finish({ code: -101 });
  assert.equal((await pending).stale, true); assert.equal(race.cookies.SESSDATA, 'test-new'); assert.equal(race.writes, 0);
  console.log('PASS: immediate anonymous state without session initialization, expired-login detection, valid/unknown states and new-login race protection; no Electron/network/profile writes');
}
run().catch(error => { console.error(error); process.exitCode = 1; });
