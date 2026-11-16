// Bili web-session maintenance. Credentials stay local and are never logged.
const { publicEncrypt, constants } = require('node:crypto');
const HOSTS = new Set(['api.bilibili.com', 'passport.bilibili.com', 'www.bilibili.com']);
const AUTH = new Set(['SESSDATA', 'bili_jct', 'DedeUserID', 'DedeUserID__ckMd5', 'sid']);
function trusted(url) { try { const u = new URL(url); return u.protocol === 'https:' && HOSTS.has(u.hostname); } catch { return false; } }
function headerFor(cookies, meta = {}, url = 'https://api.bilibili.com/', now = Date.now()) {
  if (!trusted(url)) return '';
  const u = new URL(url);
  return Object.entries(cookies).filter(([name, value]) => {
    if (!/^[!#$%&'*+.^_`|~\w-]+$/.test(name) || /[\x00-\x20;\x7f]/.test(String(value))) return false;
    const m = meta[name]; if (!m) return true; // Existing app cookies were Bili-wide.
    const domain = m.domain || u.hostname, path = m.path || '/';
    return (u.hostname === domain || (!m.hostOnly && u.hostname.endsWith('.' + domain))) &&
      (u.pathname === path || u.pathname.startsWith(path.endsWith('/') ? path : path + '/')) && (!m.expires || m.expires > now);
  }).map(([k, v]) => `${k}=${v}`).join('; ');
}
function mergeCookies(cookies, meta, headers, url, { now = Date.now(), allowAccountSwitch = false } = {}) {
  const result = { cookies: { ...cookies }, meta: { ...meta }, changed: false };
  if (!trusted(url)) return result;
  const host = new URL(url).hostname;
  for (const raw of headers || []) {
    const [pair, ...attributes] = raw.split(';'), split = pair.indexOf('=');
    if (split <= 0) continue;
    const name = pair.slice(0, split).trim(), value = pair.slice(split + 1).trim();
    if (['__proto__', 'constructor', 'prototype'].includes(name) || !/^[!#$%&'*+.^_`|~\w-]+$/.test(name) || /[\x00-\x20;\x7f]/.test(value)) continue;
    const attrs = Object.fromEntries(attributes.map(a => { const i = a.indexOf('='); return [a.slice(0, i < 0 ? undefined : i).trim().toLowerCase(), i < 0 ? true : a.slice(i + 1).trim()]; }));
    const domain = String(attrs.domain || host).replace(/^\./, '').toLowerCase();
    if (!(host === domain || host.endsWith('.' + domain)) || !(domain === 'bilibili.com' || HOSTS.has(domain))) continue;
    if (AUTH.has(name) && (domain !== 'bilibili.com' || (attrs.path && attrs.path !== '/'))) continue;
    const expires = attrs['max-age'] !== undefined && /^-?\d+$/.test(attrs['max-age']) ? now + Number(attrs['max-age']) * 1000 : Date.parse(attrs.expires) || 0;
    if (!allowAccountSwitch && AUTH.has(name) && (value === '' || (expires && expires <= now))) continue;
    if (!allowAccountSwitch && name === 'DedeUserID' && cookies.DedeUserID && value !== cookies.DedeUserID) return { cookies: { ...cookies }, meta: { ...meta }, changed: false };
    if (!value || (expires && expires <= now)) { delete result.cookies[name]; delete result.meta[name]; }
    else { result.cookies[name] = value; result.meta[name] = { domain, hostOnly: !attrs.domain, path: String(attrs.path || '/'), expires, secure: !!attrs.secure }; }
  }
  result.changed = JSON.stringify(result.cookies) !== JSON.stringify(cookies) || JSON.stringify(result.meta) !== JSON.stringify(meta);
  return result;
}
function correspondPath(timestamp) {
  const key = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDLgd2OAkcGVtoE3ThUREbio0Eg
Uc/prcajMKXvkCKFCWhJYJcLkcM2DKKcSeFpD/j6Boy538YXnR6VhcuUJOhH2x71
nzPjfdTcqMz7djHum0qSZA0AyCBDABUqCrfNgCiJ00Ra7GmRj+YCK1NJEuewlb40
JNrRuoEUXpabUzGB8QIDAQAB
-----END PUBLIC KEY-----`;
  return publicEncrypt({ key, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.from(`refresh_${timestamp}`)).toString('hex');
}
function createSessionMaintenance({ getState, commit, request, headers, now = Date.now, makePath = correspondPath }) {
  let pending;
  async function run() {
    let start = getState(); if (!start.cookies.SESSDATA) return;
    let auth = { ...start.auth };
    const time = now();
    if (time - (auth.lastAttemptAt || 0) < 30 * 60 * 1000 || (!auth.pendingConfirmToken && time - (auth.lastCheckAt || 0) < 24 * 3600 * 1000)) return;
    const same = () => { const s = getState(); return s.generation === start.generation && s.cookies.SESSDATA === start.cookies.SESSDATA; };
    const save = state => { if (!same()) return false; commit(state); start = getState(); auth = { ...start.auth }; return true; };
    if (!save({ ...start, auth: { ...auth, lastAttemptAt: time } })) return;
    const signal = AbortSignal.timeout(8000);
    async function call(url, state, form) {
      const response = await request(url, { method: form ? 'POST' : 'GET', redirect: 'error', signal,
        headers: { ...headers(), Cookie: headerFor(state.cookies, state.meta, url, now()), ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
        ...(form ? { body: new URLSearchParams(form).toString() } : {}) });
      if (!response.ok) throw Error('登录维护暂时不可用');
      return response;
    }
    async function confirm() {
      const response = await call('https://passport.bilibili.com/x/passport-login/web/confirm/refresh', start,
        { csrf: start.cookies.bili_jct, refresh_token: auth.pendingConfirmToken });
      const j = await response.json();
      if (j.code !== 0) {
        if ([-101, -111, -400].includes(j.code)) save({ ...start, auth: { ...auth, renewalRequired: true } });
        throw Error('续期确认暂未完成');
      }
      save({ ...start, auth: { ...auth, pendingConfirmToken: '', lastCheckAt: now(), renewalRequired: false } });
    }
    try {
      if (auth.pendingConfirmToken) { await confirm(); return; }
      const response = await call('https://passport.bilibili.com/x/passport-login/web/cookie/info?csrf=' + encodeURIComponent(start.cookies.bili_jct || ''), start);
      const info = await response.json(); if (!same() || info.code !== 0 || typeof info.data?.refresh !== 'boolean') return;
      if (!info.data.refresh) { save({ ...start, auth: { ...auth, lastCheckAt: now(), renewalRequired: false } }); return; }
      if (!auth.refreshToken || !start.cookies.bili_jct) { save({ ...start, auth: { ...auth, lastCheckAt: now(), renewalRequired: true } }); return; }
      const timestamp = Number(info.data.timestamp);
      if (!Number.isSafeInteger(timestamp) || Math.abs(now() - timestamp) > 5 * 60 * 1000) return;
      const csrfPage = await call('https://www.bilibili.com/correspond/1/' + makePath(timestamp), start);
      const html = await csrfPage.text(); if (html.length > 1024 * 1024) return;
      const csrf = html.match(/<div\b[^>]*\bid=["']1-name["'][^>]*>\s*([\w-]+)\s*<\/div>/i)?.[1];
      if (!csrf || !same()) return;
      const oldToken = auth.refreshToken;
      const refreshed = await call('https://passport.bilibili.com/x/passport-login/web/cookie/refresh', start,
        { csrf: start.cookies.bili_jct, refresh_csrf: csrf, source: 'main_web', refresh_token: oldToken });
      const j = await refreshed.json(); if (!same()) return;
      if (j.code !== 0 || j.data?.status !== 0 || !j.data?.refresh_token) {
        if ([-101, -111, 86095].includes(j.code)) save({ ...start, auth: { ...auth, lastCheckAt: now(), renewalRequired: true } });
        return;
      }
      const next = mergeCookies(start.cookies, start.meta, refreshed.headers.getSetCookie?.() || [], 'https://passport.bilibili.com/', { now: now() });
      const issued = mergeCookies({}, {}, refreshed.headers.getSetCookie?.() || [], 'https://passport.bilibili.com/', { now: now() });
      // Do not retire the old session until complete new credentials are durable.
      if (!issued.cookies.SESSDATA || !issued.cookies.bili_jct || !headerFor(issued.cookies, issued.meta).includes('SESSDATA=') || next.cookies.SESSDATA === start.cookies.SESSDATA) return;
      if (!save({ ...start, cookies: next.cookies, meta: next.meta, auth: { ...auth, refreshToken: j.data.refresh_token, pendingConfirmToken: oldToken, renewalRequired: false } })) return;
      await confirm();
    } catch (_) { /* Keep existing/new durable credentials; back off, never log secrets. */ }
  }
  function check() { if (pending) return pending; pending = run().catch(() => {}).finally(() => { pending = null; }); return pending; }
  return { check };
}
module.exports = { trusted, headerFor, mergeCookies, correspondPath, createSessionMaintenance };
