// Execute actual networking/signature/QR functions with fake responses only.
const vm = require('node:vm'), fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
function fixture() {
  const writes = [], requests = [];
  const c = { URL, URLSearchParams, AbortSignal, createHash, biliSession: require('../bili-session.cjs'),
    API: 'https://api.bilibili.com', PASSPORT: 'https://passport.bilibili.com', REFERER: 'https://www.bilibili.com/', CHROME_MAJOR: '150', UA: 'test',
    cookies: { SESSDATA: 'fake-session', bili_jct: 'fake-csrf', DedeUserID: 'a', buvid3: 'stable3', buvid4: 'stable4' }, cookieMeta: {}, loginGeneration: 0,
    loginMaintenanceState: {}, agent: {}, wbi: { img: 'abcdefghijklmnopqrstuvwxyz123456', sub: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ123456' }, wbiAt: 0,
    readStore: () => ({ library: 'preserved' }), writeStore: value => writes.push(value),
    ufetch: async (url, options) => { requests.push({ url: String(url), options }); return c.reply; } };
  vm.createContext(c);
  vm.runInContext(source.slice(source.indexOf('function cookieHeader('), source.indexOf('async function initSession()')), c);
  return { c, requests, writes };
}
const response = (json, set = [], status = 200) => ({ ok: status === 200, status, headers: { getSetCookie: () => set }, json: async () => json, body: { cancel: async () => {} } });
async function run() {
  const { c, requests, writes } = fixture();
  c.reply = response({ code: 0 }, ['theme=updated; Domain=.bilibili.com; Path=/']);
  const input = { keyword: "a !'()* 中文", bvid: 'BV1CaPrz7EL6', cid: 36468035480 };
  const signed = c.signWbi(input);
  await c.apiGet(c.API, '/x/player/wbi/playurl', signed);
  const sent = new URL(requests[0].url), params = Object.fromEntries(sent.searchParams);
  const canonical = Object.keys(params).filter(k => k !== 'w_rid').sort().map(k => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`).join('&');
  const mixin = vm.runInContext('mixinKeyOf(wbi.img + wbi.sub)', c);
  assert.equal(params.w_rid, createHash('md5').update(canonical + mixin).digest('hex'));
  assert(Math.abs(Number(params.wts) - Date.now() / 1000) < 2);
  assert.equal(params.keyword, 'a  中文'); assert.equal(input.keyword, "a !'()* 中文");
  assert(requests[0].options.headers.Cookie.includes('SESSDATA=fake-session'));
  assert.equal(requests[0].options.headers.Referer, c.REFERER); assert.equal(requests[0].options.dispatcher, c.agent);
  assert.equal(c.cookies.theme, 'updated'); assert.equal(writes[0].library, 'preserved');
  assert.equal(c.apiHeaders({}, 'https://audio.bilivideo.com/a').Cookie, '');
  assert.equal(c.apiHeaders({}, 'https://b23.tv/test').Cookie, '');
  const count = writes.length;
  c.reply = response(null, ['SESSDATA=; Domain=.bilibili.com; Max-Age=0'], 412);
  assert.equal((await c.apiGet(c.API, '/x/player/wbi/playurl')).code, -412); assert.equal(writes.length, count);
  let finish;
  c.ufetch = () => new Promise(resolve => { finish = resolve; });
  const pending = c.apiGet(c.API, '/x/web-interface/nav'); c.loginGeneration++; c.cookies.SESSDATA = 'new-login';
  finish(response({ code: 0 }, ['SESSDATA=old-response; Domain=.bilibili.com'])); await pending;
  assert.equal(c.cookies.SESSDATA, 'new-login'); assert.equal(writes.length, count);
  vm.runInContext(source.slice(source.indexOf('async function initSession()'), source.indexOf('// 单例：启动时后台预热')), c);
  let spi = 0; c.loadCookies = () => {}; c.persistCookies = () => {}; c.refreshWbi = async () => {};
  c.apiGet = async () => { spi++; return { data: { b_3: 'replacement3', b_4: 'replacement4' } }; };
  await c.initSession(); assert.equal(spi, 0); delete c.cookies.buvid4; await c.initSession();
  assert.equal(c.cookies.buvid3, 'stable3'); assert.equal(c.cookies.buvid4, 'replacement4');
  const handlers = {};
  Object.assign(c, { ipcMain: { handle: (name, fn) => { handlers[name] = fn; } }, loginQrKey: 'current-qr',
    streamCache: new Map(), saveSessionSnapshot: next => { c.cookies = next.cookies; c.cookieMeta = next.meta; c.loginMaintenanceState = next.auth; } });
  vm.runInContext(source.slice(source.indexOf("ipcMain.handle('login:poll'"), source.indexOf("ipcMain.handle('app:openExternal'")), c);
  const poll = handlers['login:poll'];
  assert.equal((await poll(null, 'old-qr')).status, 'expired');
  c.ufetch = async () => response({ data: { code: 0, refresh_token: 'fake-refresh' } }, ['SESSDATA=issued; Domain=.bilibili.com; Path=/', 'bili_jct=issued-csrf; Domain=.bilibili.com; Path=/']);
  assert.equal((await poll(null, 'current-qr')).status, 'done'); assert.equal(c.loginMaintenanceState.refreshToken, 'fake-refresh');
  assert.equal(c.cookies.SESSDATA, 'issued'); assert.equal(c.cookies.buvid3, 'stable3');
  c.loginQrKey = 'partial'; c.ufetch = async () => response({ data: { code: 0, refresh_token: 'partial' } });
  await assert.rejects(poll(null, 'partial'), /完整登录凭据/); assert.equal(c.cookies.SESSDATA, 'issued');
  console.log('PASS: actual request headers/cookie capture, serialized-parameter WBI hash/time/IDs, scoped CDN/shortlink requests, 412 and late-response preservation, stable device IDs, QR token persistence and incomplete/stale QR rejection; no network/profile');
}
run().catch(error => { console.error(error); process.exitCode = 1; });
