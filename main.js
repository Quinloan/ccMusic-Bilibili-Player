// B 站纯音频连播 · Electron 主进程（CommonJS）
// 关键点：用 session.webRequest 给渲染进程发出的音频/图片请求注入 Referer，
// 因此不需要任何本地代理中转，音频流由 Chromium 直连 B 站 CDN。
const {
  app, BrowserWindow, ipcMain, session, shell, Menu, clipboard, dialog,
  Tray, nativeImage, globalShortcut,
} = require('electron');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

// GitHub 仓库（用于「关于」页与检查更新）
const GITHUB_REPO = process.env.CCMUSIC_REPO || 'Quinloan/ccMusic';

const API = 'https://api.bilibili.com';
const PASSPORT = 'https://passport.bilibili.com';
const REFERER = 'https://www.bilibili.com/';

const CHROME_MAJOR = (process.versions.chrome || '131').split('.')[0];
const UA =
  `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ` +
  `(KHTML, like Gecko) Chrome/${CHROME_MAJOR}.0.0.0 Safari/537.36`;

let ufetch = null;
let agent = null;

let cookies = {};   // buvid3/buvid4 + 登录态
let wbi = null;
let wbiAt = 0;

// ---------------------------------------------------------------- 存储
const DATA_FILE = () => path.join(app.getPath('userData'), 'radio-data.json');

function readStore() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE(), 'utf8'));
  } catch {
    return null;
  }
}
function writeStore(data) {
  fs.mkdirSync(path.dirname(DATA_FILE()), { recursive: true });
  fs.writeFileSync(DATA_FILE(), JSON.stringify(data, null, 2), 'utf8');
}

// ---------------------------------------------------------------- 网络
function cookieHeader() {
  return Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
}

function apiHeaders(extra = {}) {
  return {
    'User-Agent': UA,
    Referer: REFERER,
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    Origin: REFERER,
    'sec-ch-ua': `"Google Chrome";v="${CHROME_MAJOR}", "Chromium";v="${CHROME_MAJOR}", "Not_A Brand";v="24"`,
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-site',
    Cookie: cookieHeader(),
    ...extra,
  };
}

async function apiGet(base, p, params = {}) {
  const u = new URL(base + p);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  const r = await ufetch(u, { headers: apiHeaders(), dispatcher: agent });
  return r.json().catch(() => null);
}

const MIXIN = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61,
  26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36,
  20, 34, 44, 52,
];
const mixinKeyOf = (r) => MIXIN.map((i) => r[i]).join('').slice(0, 32);

async function refreshWbi() {
  const nav = await apiGet(API, '/x/web-interface/nav');
  const img = nav && nav.data && nav.data.wbi_img && nav.data.wbi_img.img_url;
  const sub = nav && nav.data && nav.data.wbi_img && nav.data.wbi_img.sub_url;
  if (img && sub) {
    const cut = (s) => s.split('/').pop().split('.')[0];
    wbi = { img: cut(img), sub: cut(sub) };
    wbiAt = Date.now();
  }
}
async function ensureWbi() {
  if (!wbi || Date.now() - wbiAt > 6 * 3600 * 1000) await refreshWbi();
}
function signWbi(params) {
  const mk = mixinKeyOf(wbi.img + wbi.sub);
  const s = Object.assign({}, params, { wts: Math.floor(Date.now() / 1000) });
  const q = Object.keys(s)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(s[k]).replace(/[!'()*]/g, ''))}`)
    .join('&');
  return Object.assign({}, s, { w_rid: createHash('md5').update(q + mk).digest('hex') });
}

async function initSession() {
  const saved = readStore();
  if (saved && saved.cookies) cookies = Object.assign({}, saved.cookies);
  // 设备指纹与 WBI 密钥互不依赖，并行取
  await Promise.all([
    apiGet(API, '/x/frontend/finger/spi').then((spi) => {
      if (spi && spi.data && spi.data.b_3) cookies.buvid3 = spi.data.b_3;
      if (spi && spi.data && spi.data.b_4) cookies.buvid4 = spi.data.b_4;
    }),
    refreshWbi(),
  ]);
  persistCookies();
}

// 单例：启动时后台预热，任何 B 站 IPC 调用前确保会话就绪
let sessionReady = null;
// 网络模块（undici）懒加载：不再拖慢窗口出现与首屏渲染
let ufetchReady = null;
function netInit() {
  if (!ufetchReady) {
    ufetchReady = (async () => {
      const undici = await import('undici');
      ufetch = undici.fetch;
      agent = new undici.Agent({ allowH2: true });
      console.log('[boot] 网络模块就绪于 ' + Math.round(process.uptime() * 1000) + 'ms');
    })();
  }
  return ufetchReady;
}

async function ensureSession() {
  await netInit();
  if (!sessionReady) {
    sessionReady = initSession().catch((e) => {
      sessionReady = null;
      throw e;
    });
  }
  return sessionReady;
}

function persistCookies() {
  const cur = readStore() || {};
  cur.cookies = cookies;
  writeStore(cur);
}

// ---------------------------------------------------------------- IPC
ipcMain.handle('store:get', () => {
  const s = readStore();
  return s ? s.library || null : null;
});
ipcMain.handle('store:set', (_e, library) => {
  const cur = readStore() || {};
  cur.library = library;
  cur.cookies = cookies;
  writeStore(cur);
  return true;
});

ipcMain.handle('login:state', async () => {
  await ensureSession();
  if (!cookies.SESSDATA) return { logged: false };
  const nav = await apiGet(API, '/x/web-interface/nav');
  if (nav && nav.code === 0 && nav.data && nav.data.isLogin) {
    return {
      logged: true,
      name: nav.data.uname,
      face: nav.data.face,
      level: nav.data.level_info ? nav.data.level_info.current_level : null,
    };
  }
  if (nav && nav.code === 0) {
    // B 站明确告知未登录，凭据确实失效了才清除
    delete cookies.SESSDATA;
    persistCookies();
    return { logged: false };
  }
  // 接口失败（网络/风控）：保留凭据，只是暂时查不到状态
  return { logged: false, stale: true, saved: !!cookies.SESSDATA }; // saved=本地有登录凭据，网络失败时用于中性提示
});

ipcMain.handle('login:logout', async () => {
  await ensureSession();
  for (const k of Object.keys(cookies)) {
    if (k !== 'buvid3' && k !== 'buvid4') delete cookies[k];
  }
  persistCookies();
  return true;
});

ipcMain.handle('bili:search', async (_e, keyword, page = 1) => {
  await ensureSession();
  await ensureWbi();
  const params = signWbi({ search_type: 'video', keyword, page, order: 'totalrank' });
  const j = await apiGet(API, '/x/web-interface/wbi/search/type', params);
  if (!j || j.code !== 0) throw new Error((j && j.message) || `搜索失败(${j && j.code})`);
  const strip = (s) =>
    String(s == null ? '' : s)
      .replace(/<[^>]+>/g, '')
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>');
  const list = ((j.data && j.data.result) || []).map((it) => ({
    bvid: it.bvid,
    title: strip(it.title),
    author: strip(it.author),
    pic: it.pic && it.pic.indexOf('//') === 0 ? 'https:' + it.pic : it.pic,
    duration: it.duration,
    play: it.play,
    danmaku: it.video_review,
  }));
  return { list, hasMore: ((j.data && j.data.numPages) || 1) > page };
});

ipcMain.handle('bili:video', async (_e, id) => {
  await ensureSession();
  // 同时支持 BV 号、av 号
  const param = /^BV/i.test(id) ? { bvid: id } : { aid: String(id).replace(/^av/i, '') };
  const j = await apiGet(API, '/x/web-interface/view', param);
  if (!j || j.code !== 0) throw new Error((j && j.message) || '视频信息获取失败');
  const d = j.data;
  // UP 主常给分 P 起名「001.歌名」「02 - 歌名」，展示时把序号前缀去掉（P 号徽标已表达顺序）
  const cleanPartTitle = (s) => {
    const t = String(s || '').replace(/^\s*\d{1,4}\s*[.\-—_、·]+\s*/, '').trim();
    return t || String(s || '');
  };
  // 分 P：一个视频可能有几十上百个 P，每个 P 有独立 cid/标题/时长，必须逐个可播
  // 封面统一用视频主封面（分 P 的 first_frame 常是黑帧，观感差）
  const parts = (d.pages || []).map((p) => ({
    cid: p.cid,
    page: p.page,
    part: cleanPartTitle(p.part) || ('P' + p.page),
    duration: p.duration || 0,
    cover: d.pic,
  }));
  // 视频合集（跨多个 BV 的「合集」），有就一并返回，让 UI 能一次性列出
  let season = null;
  const sections = (d.ugc_season && d.ugc_season.sections) || [];
  if (sections.length) {
    const eps = [];
    for (const s of sections) {
      for (const ep of s.episodes || []) {
        if (!ep || !ep.bvid) continue;
        eps.push({
          bvid: ep.bvid,
          aid: ep.aid,
          cid: ep.cid,
          page: ep.page || 1,
          title: cleanPartTitle(ep.title || (ep.arc && ep.arc.title) || ''),
          duration: (ep.arc && ep.arc.duration) || ep.duration || 0,
          cover: (ep.arc && ep.arc.pic) || ep.cover || d.pic,
          up: (ep.arc && ep.arc.author && ep.arc.author.name) || (d.owner ? d.owner.name : ''),
        });
      }
    }
    if (eps.length) {
      season = {
        id: d.ugc_season.id,
        title: (d.ugc_season.title || '').trim() || d.title,
        cover: d.ugc_season.cover || d.pic,
        episodes: eps,
      };
    }
  }
  return {
    bvid: d.bvid,
    aid: d.aid,
    cid: d.cid,
    title: d.title,
    cover: d.pic,
    up: d.owner ? d.owner.name : '',
    duration: d.duration,
    play: d.stat ? d.stat.view : null,
    videos: d.videos || parts.length,
    parts,
    season,
    desc: d.desc || '', // 简介：常含「00:00 歌名」的歌单时间戳，智能分歌用它取标题
  };
});

// 短链/分享链接跟随跳转，取最终地址以便提取 BV 号
ipcMain.handle('bili:resolve', async (_e, url) => {
  const u = /^https?:\/\//i.test(url) ? url : 'https://' + url;
  const r = await ufetch(u, { headers: apiHeaders(), dispatcher: agent, redirect: 'follow' });
  return r.url;
});

ipcMain.handle('app:copyText', (_e, text) => {
  clipboard.writeText(String(text == null ? '' : text));
  return true;
});

const streamCache = new Map();
async function getPlayurl(bvid, cid) {
  const key = `${bvid}:${cid}`;
  const hit = streamCache.get(key);
  if (hit && hit.expireAt > Date.now()) return hit.payload;

  await ensureSession();
  await ensureWbi();
  const j = await apiGet(
    API,
    '/x/player/wbi/playurl',
    signWbi({ bvid, cid, qn: 64, fnval: 16, fnver: 0, fourk: 0 })
  );
  if (!j || j.code !== 0) throw new Error((j && j.message) || '播放地址获取失败');
  const audio = (j.data && j.data.dash && j.data.dash.audio) || [];
  if (!audio.length) throw new Error('该视频没有独立音轨');

  const norm = (a) => ({
    id: a.id,
    codecs: a.codecs,
    kbps: Math.round((a.bandwidth || 0) / 1000),
    url: a.baseUrl,
  });
  const payload = {
    // raw 保留 B 站原始顺序，渲染端据此判断「默认那一档」
    raw: audio.map((a) => ({ id: a.id, kbps: Math.round((a.bandwidth || 0) / 1000) })),
    tracks: audio.map(norm).sort((a, b) => b.kbps - a.kbps),
    flac: j.data.flac && j.data.flac.audio ? norm(j.data.flac.audio) : null,
    dolby: j.data.dolby && j.data.dolby.audio ? norm(j.data.dolby.audio) : null,
    expireAt: Date.now() + 100 * 60 * 1000,
  };
  streamCache.set(key, { payload, expireAt: payload.expireAt });
  return payload;
}

ipcMain.handle('bili:playurl', (_e, bvid, cid) => getPlayurl(bvid, cid));

// ---------------------------------------------------------------- 智能分歌
// 长视频（几小时、无分 P）按歌与歌之间的静音切成一首首曲目
const SPLIT_RATE = 8000;  // 8kHz 单声道足够判断静音，数据量小
const SPLIT_TH = 0.008;   // RMS 低于此值算静音（相对满量程）
const SPLIT_MIN_SIL = 1.5;  // 静音至少持续这么久才算切点
const SPLIT_MIN_TRACK = 60; // 单曲最短 60 秒，滤掉过短的碎片

// 周期性留 PCM 采样：识别歌名时用，避免为识别再下一次音频
const SAMPLE_EVERY = 30; // 每 30 秒留一段
const SAMPLE_SEC = 8;    // 每段 8 秒（够生成指纹）

let afpMod = null;
function loadAfp() {
  if (!afpMod) {
    afpMod = require(app.isPackaged
      ? path.join(process.resourcesPath, 'afp', 'afp.js')
      : path.join(__dirname, 'resources', 'afp', 'afp.js'));
  }
  return afpMod;
}

// 音频片段 → 指纹 → 网易云匹配（只上传指纹，不上传音频）
async function identifySong(pcm) {
  try {
    const { GenerateFP } = loadAfp();
    const n = Math.floor(pcm.length / 2);
    if (n < 8000) return null;
    const f32 = new Float32Array(n);
    for (let i = 0; i < n; i++) f32[i] = pcm.readInt16LE(i * 2) / 32768;
    let e = 0; const m = Math.min(n, 8000);
    for (let i = 0; i < m; i++) e += f32[i] * f32[i];
    console.log('[identify] 片段: ' + n + ' 样本, RMS=' + Math.sqrt(e / m).toFixed(4));
    const fp = await GenerateFP(f32);
    const url = 'https://interface.music.163.com/api/music/audio/match'
      + '?sessionId=0123456789abcdef&algorithmCode=shazam_v2'
      + `&duration=${Math.round(n / SPLIT_RATE)}&rawdata=${encodeURIComponent(fp)}&times=1&decrypt=1`;
    const r = await ufetch(url, {
      headers: { 'User-Agent': UA, Referer: 'https://music.163.com/' }, dispatcher: agent,
      signal: AbortSignal.timeout(10000), // 识别请求 10 秒超时，卡住就放弃这一首
    });
    const j = await r.json().catch(() => null);
    const list = (j && j.data && j.data.result) || [];
    if (!list.length) { console.log('[identify] 无匹配结果'); return null; }
    const s = list[0].song || {};
    if (!s.name) { console.log('[identify] 返回无歌名'); return null; }
    return { name: s.name, artist: (s.artists || []).map((a) => a.name).join('/') };
  } catch (e) {
    console.log('[identify] 异常:', e.message);
    return null;
  }
}

function ffmpegPath() {
  // 打包后 ffmpeg 随 resources 走；开发模式就在仓库 resources/
  return app.isPackaged
    ? path.join(process.resourcesPath, 'ffmpeg-mini.exe')
    : path.join(__dirname, 'resources', 'ffmpeg-mini.exe'); // main.js 与 resources 同级
}

// maxSec 可选：只分析前 N 秒（调试 / 试看用，不传则分析整段）
ipcMain.handle('split:analyze', async (e, bvid, cid, maxSec) => {
  const send = (p) => { try { e.sender.send('split:progress', p); } catch (_) {} };
  const ffBin = ffmpegPath();
  if (!fs.existsSync(ffBin)) throw new Error('缺少解码组件 ffmpeg-mini.exe');

  const p = await getPlayurl(bvid, cid);
  const track = (p.tracks && p.tracks[0]) || p.flac || p.dolby;
  if (!track || !track.url) throw new Error('没有可用音轨');

  send({ stage: 'download', pct: 0 });
  const res = await ufetch(track.url, { headers: apiHeaders(), dispatcher: agent });
  const total = +(res.headers.get('content-length') || 0);

  const ffArgs = ['-i', 'pipe:0', '-f', 's16le', '-ac', '1', '-ar', String(SPLIT_RATE)];
  if (maxSec > 0) ffArgs.push('-t', String(maxSec)); // 只解前 N 秒，下载随之停止
  ffArgs.push('pipe:1');
  const ff = spawn(ffBin, ffArgs);
  let bytes = 0, pcmBytes = 0;
  let winAcc = 0, winN = 0;
  const WIN = SPLIT_RATE / 10; // 每 100ms 一个窗口
  const rms = [];
  let ffError = '';

  // 滚动保留最近 8 秒 PCM，每 30 秒存一份，供识别歌名用
  const samples = [];
  let roll = [], rollBytes = 0, nextSampleAt = SAMPLE_EVERY;
  const ROLL_MAX = SPLIT_RATE * 2 * SAMPLE_SEC;
  let carry = Buffer.alloc(0); // 网络分包可能奇数字节，必须跨块对齐到 16 位样本

  ff.stdout.on('data', (buf) => {
    const merged = carry.length ? Buffer.concat([carry, buf]) : buf;
    const usable = merged.length - (merged.length % 2);
    carry = merged.slice(usable);
    const aligned = merged.slice(0, usable);
    pcmBytes += aligned.length;
    for (let i = 0; i + 1 < aligned.length; i += 2) {
      const s = aligned.readInt16LE(i) / 32768;
      winAcc += s * s; winN++;
      if (winN >= WIN) { rms.push(Math.sqrt(winAcc / winN)); winAcc = 0; winN = 0; }
    }
    roll.push(aligned); rollBytes += aligned.length;
    while (rollBytes > ROLL_MAX && roll.length) { rollBytes -= roll.shift().length; }
    const t = pcmBytes / 2 / SPLIT_RATE;
    if (t >= nextSampleAt) {
      samples.push({ at: t, pcm: Buffer.concat(roll) });
      nextSampleAt += SAMPLE_EVERY;
    }
  });
  ff.stderr.on('data', (d) => { const s = d.toString(); if (s.trim()) ffError = s.slice(-300); });
  // ffmpeg 提前退出（坏流/参数问题）时 stdin 会 EPIPE，必须接住否则主进程弹窗崩溃
  ff.stdin.on('error', () => {});
  ff.stdout.on('error', () => {});

  const pump = (async () => {
    let lastPct = -1;
    for await (const chunk of res.body) {
      if (!ff.stdin.writable) break;
      bytes += chunk.length;
      if (total) {
        const pct = Math.min(99, Math.round((bytes / total) * 100));
        if (pct !== lastPct && pct % 5 === 0) { lastPct = pct; send({ stage: 'download', pct }); }
      }
      if (!ff.stdin.write(chunk)) await new Promise((r) => ff.stdin.once('drain', r));
    }
    ff.stdin.end();
  })();

  const closed = new Promise((r) => ff.on('close', r));
  let downloadOk = true;
  await Promise.all([pump.catch((err) => { downloadOk = false; console.log('[split] 下载中断:', err.message); }), closed]);
  console.log('[split] 下载统计: content-length=' + total + ' 实际=' + bytes + ' PCM时长=' + (pcmBytes / 2 / SPLIT_RATE).toFixed(1) + 's ffExit=' + ff.exitCode);

  const secs = pcmBytes / 2 / SPLIT_RATE;
  if (!downloadOk) throw new Error('音频下载中断（网络波动），请重试');
  if (secs < 10) throw new Error('音频太短，未分析出内容');

  send({ stage: 'analyze', pct: 100 });
  // 找静音段
  const silences = [];
  let runStart = -1;
  for (let i = 0; i < rms.length; i++) {
    const t = i / 10;
    if (rms[i] < SPLIT_TH) { if (runStart < 0) runStart = t; }
    else if (runStart >= 0) {
      if (t - runStart >= SPLIT_MIN_SIL) silences.push({ from: runStart, to: t });
      runStart = -1;
    }
  }
  // 按静音中点切，太短的碎片丢弃
  const tracks = [];
  let start = 0;
  silences.forEach((s) => {
    const cut = (s.from + s.to) / 2;
    if (cut - start >= SPLIT_MIN_TRACK) { tracks.push({ start: +start.toFixed(1), end: +cut.toFixed(1) }); start = cut; }
  });
  if (secs - start >= SPLIT_MIN_TRACK) tracks.push({ start: +start.toFixed(1), end: +secs.toFixed(1) });

  // 逐首识别歌名：避开接缝，在曲目内取多个位置尝试（长曲取 1/4、1/2、3/4 三处）
  let named = 0;
  for (let i = 0; i < tracks.length; i++) {
    const t = tracks[i];
    const span = t.end - t.start;
    const mids = span > 240
      ? [0.3, 0.5, 0.7].map((r) => t.start + span * r)
      : [(t.start + t.end) / 2];
    let hit = null;
    for (const mid of mids) {
      if (hit) break;
      let best = null;
      for (const s of samples) {
        if (s.at < t.start + 8 || s.at > t.end - 8) continue; // 距接缝至少 8 秒
        if (!best || Math.abs(s.at - mid) < Math.abs(best.at - mid)) best = s;
      }
      if (best) hit = await identifySong(best.pcm);
    }
    send({ stage: 'identify', pct: Math.round((i / tracks.length) * 100), done: i, total: tracks.length });
    if (hit) { t.title = hit.name; t.artist = hit.artist || ''; named++; }
    await new Promise((r2) => setTimeout(r2, 350)); // 请求间隔，防接口限频
  }

  return { tracks, duration: +secs.toFixed(1), silences: silences.length, named };
});

ipcMain.handle('login:qrcode', async () => {
  await ensureSession();
  const j = await apiGet(PASSPORT, '/x/passport-login/web/qrcode/generate');
  if (!j || j.code !== 0) throw new Error('二维码生成失败');
  const QRCode = (await import('qrcode')).default;
  const dataUrl = await QRCode.toDataURL(j.data.url, {
    margin: 1,
    width: 360,
    errorCorrectionLevel: 'M',
  });
  return { url: j.data.url, key: j.data.qrcode_key, dataUrl };
});

ipcMain.handle('login:poll', async (_e, key) => {
  const u = new URL(PASSPORT + '/x/passport-login/web/qrcode/poll');
  u.searchParams.set('qrcode_key', key);
  const r = await ufetch(u, { headers: apiHeaders(), dispatcher: agent });
  const j = await r.json().catch(() => null);
  const code = j && j.data ? j.data.code : j && j.code;
  if (code === 0) {
    const raw = typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : [];
    for (const c of raw) {
      const m = c.match(/^([^=]+)=([^;]*)/);
      if (m) cookies[m[1]] = m[2];
    }
    persistCookies();
    await refreshWbi();
    return { status: 'done' };
  }
  if (code === 86090) return { status: 'scanned' };
  if (code === 86038) return { status: 'expired' };
  return { status: 'waiting' };
});

ipcMain.handle('app:openExternal', (_e, url) => shell.openExternal(url));
ipcMain.handle('app:version', () => app.getVersion());

// 自绘标题栏的窗口控制
ipcMain.handle('win:minimize', (e) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (w) w.minimize();
});
ipcMain.handle('win:maxToggle', (e) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (!w) return;
  if (w.isMaximized()) w.unmaximize();
  else w.maximize();
});
ipcMain.handle('win:close', (e) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (w) w.close();
});

// 托盘 / 全局媒体键
ipcMain.handle('app:quit', () => quitApp());
ipcMain.handle('tray:title', (_e, t) => {
  if (tray) tray.setToolTip(t ? `ccMusic · ${t}` : 'ccMusic');
});
ipcMain.handle('settings:mediaKeys', (_e, on) => {
  mediaKeysOn = !!on;
  applyMediaKeys();
});
ipcMain.handle('settings:closeToTray', (_e, on) => {
  closeToTray = !!on;
});
ipcMain.handle('settings:autoLaunch', (_e, on) => {
  app.setLoginItemSettings({ openAtLogin: !!on });
  return app.getLoginItemSettings().openAtLogin;
});
ipcMain.handle('settings:autoLaunchState', () => app.getLoginItemSettings().openAtLogin);

// ---------------------------------------------------------------- 诊断
ipcMain.handle('diag:env', () => ({
  version: app.getVersion(),
  electron: process.versions.electron,
  chrome: process.versions.chrome,
  node: process.versions.node,
  platform: `${process.platform}-${process.arch}`,
  os: os.release(),
  dataDir: app.getPath('userData'),
  logged: !!cookies.SESSDATA,
  repo: GITHUB_REPO,
  buvid3: cookies.buvid3 ? cookies.buvid3.slice(0, 8) + '…' : '未获取',
}));

ipcMain.handle('diag:api', async (_e, input) => {
  await ensureSession();
  const steps = [];
  const push = (name, ok, detail, ms) => steps.push({ name, ok, detail, ms });
  const m = String(input || '').match(/BV[0-9A-Za-z]{10}/);
  if (!m) return { ok: false, steps: [{ name: '输入检查', ok: false, detail: '没有识别到 BV 号', ms: 0 }] };
  const bvid = m[0];

  let t0 = Date.now();
  try {
    await ensureWbi();
    push('WBI 签名密钥', true, '已获取，签名可用', Date.now() - t0);
  } catch (e) {
    push('WBI 签名密钥', false, e.message, Date.now() - t0);
    return { ok: false, steps };
  }

  t0 = Date.now();
  let cid;
  try {
    const j = await apiGet(API, '/x/web-interface/view', { bvid });
    if (!j || j.code !== 0) throw new Error((j && j.message) || '接口返回异常');
    cid = j.data.cid;
    push('解析视频信息', true, `cid=${cid}，时长 ${j.data.duration}s`, Date.now() - t0);
  } catch (e) {
    push('解析视频信息', false, e.message, Date.now() - t0);
    return { ok: false, steps };
  }

  t0 = Date.now();
  let url;
  try {
    const j = await apiGet(
      API,
      '/x/player/wbi/playurl',
      signWbi({ bvid, cid, qn: 64, fnval: 16, fnver: 0, fourk: 0 })
    );
    if (!j || j.code !== 0) throw new Error((j && j.message) || '接口返回异常');
    const a = (j.data && j.data.dash && j.data.dash.audio) || [];
    if (!a.length) throw new Error('没有独立音轨');
    url = a[a.length - 1].baseUrl;
    push('获取音频直链', true, `${a.length} 条音轨，最高 ${Math.round((a[a.length - 1].bandwidth || 0) / 1000)}kbps`, Date.now() - t0);
  } catch (e) {
    push('获取音频直链', false, e.message, Date.now() - t0);
    return { ok: false, steps };
  }

  t0 = Date.now();
  try {
    const r = await ufetch(url, {
      headers: { 'User-Agent': UA, Referer: REFERER, Range: 'bytes=0-1023' },
      dispatcher: agent,
    });
    const ok = r.status === 200 || r.status === 206;
    push('音频流可达性', ok, ok ? `HTTP ${r.status}，CDN 响应正常` : `HTTP ${r.status}`, Date.now() - t0);
  } catch (e) {
    push('音频流可达性', false, e.message, Date.now() - t0);
  }

  return { ok: steps.every((s) => s.ok), steps };
});

ipcMain.handle('diag:openData', () => {
  shell.openPath(app.getPath('userData'));
  return true;
});

ipcMain.handle('diag:export', () => {
  const pkg = {
    app: 'ccMusic',
    time: new Date().toISOString(),
    env: {
      version: app.getVersion(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      platform: `${process.platform}-${process.arch}`,
      os: os.release(),
    },
    // 安全：登录凭据一律脱敏，绝不写入诊断包
    login: { logged: !!cookies.SESSDATA, SESSDATA: '[REDACTED]' },
    library: (readStore() || {}).library || null,
  };
  const file = path.join(app.getPath('desktop'), `ccMusic-diagnostics-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify(pkg, null, 2), 'utf8');
  shell.showItemInFolder(file);
  return file;
});

// ---------------------------------------------------------------- 检查更新
function cmpVer(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

ipcMain.handle('update:check', async () => {
  const current = app.getVersion();
  const repo = GITHUB_REPO;
  try {
    const r = await ufetch(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: { 'User-Agent': 'ccMusic', Accept: 'application/vnd.github+json' },
      dispatcher: agent,
    });
    if (r.status === 404) return { current, repo, ok: false, error: '还没有发布过 Release' };
    const j = await r.json().catch(() => null);
    if (!j || !j.tag_name) return { current, repo, ok: false, error: '获取版本信息失败' };
    const latest = String(j.tag_name).replace(/^v/, '');
    return {
      current,
      repo,
      ok: true,
      hasUpdate: cmpVer(latest, current) > 0,
      latest,
      url: j.html_url,
      notes: String(j.body || '').slice(0, 400),
    };
  } catch (e) {
    return { current, repo, ok: false, error: e.message };
  }
});

// ---------------------------------------------------------------- 自动更新
// 打包环境下通过 electron-updater 检查 GitHub Releases，后台静默下载，
// 下载完成后弹窗询问是否立即重启；即使不点，退出时也会自动装好新版。
function setupAutoUpdater() {
  if (!app.isPackaged) return;
  let autoUpdater;
  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch (e) {
    console.error('[updater] 模块缺失:', e.message);
    return;
  }
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  let asking = false;
  autoUpdater.on('update-downloaded', (info) => {
    if (asking) return;
    asking = true;
    dialog
      .showMessageBox({
        type: 'info',
        title: 'ccMusic 更新',
        message: '新版本 v' + info.version + ' 已下载完成',
        detail: '重启应用即可完成更新，歌单与登录不受影响。',
        buttons: ['立即重启更新', '下次启动再说'],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      })
      .then(({ response }) => {
        asking = false;
        if (response === 0) autoUpdater.quitAndInstall(true, true);
      })
      .catch(() => (asking = false));
  });
  autoUpdater.on('error', (e) => console.error('[updater]', e.message));
  const check = () =>
    autoUpdater.checkForUpdates().catch((e) => console.error('[updater]', e.message));
  setTimeout(check, 15000); // 启动 15 秒后首次检查，避开启动高峰
  setInterval(check, 4 * 60 * 60 * 1000); // 之后每 4 小时
}

// ---------------------------------------------------------------- 托盘 & 全局媒体键
let mainWin = null;
let tray = null;
let quitting = false;          // 真正退出（托盘菜单退出）时为 true
let closeToTray = true;        // 关闭窗口时最小化到托盘，继续后台播放
let mediaKeysOn = true;        // 全局媒体键开关
let mediaRegistered = false;

function sendMedia(cmd) {
  if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('media:cmd', cmd);
}

function toggleWindow() {
  if (!mainWin || mainWin.isDestroyed()) return;
  if (mainWin.isVisible()) {
    if (mainWin.isMinimized()) mainWin.restore();
    mainWin.focus();
  } else {
    mainWin.show();
    mainWin.focus();
  }
}

function quitApp() {
  quitting = true;
  app.quit();
}

function buildTrayMenu() {
  return Menu.buildFromTemplate([
    { label: '显示 / 隐藏 ccMusic', click: () => toggleWindow() },
    { type: 'separator' },
    { label: '播放 / 暂停', click: () => sendMedia('playPause') },
    { label: '上一首', click: () => sendMedia('prev') },
    { label: '下一首', click: () => sendMedia('next') },
    { type: 'separator' },
    { label: '退出 ccMusic', click: () => quitApp() },
  ]);
}

function setupTray() {
  try {
    const p = path.join(__dirname, 'assets', 'icon.png');
    const raw = nativeImage.createFromPath(p);
    const img = raw.isEmpty() ? raw : raw.resize({ width: 32, height: 32 });
    tray = new Tray(img);
    tray.setToolTip('ccMusic');
    tray.setContextMenu(buildTrayMenu());
    tray.on('click', () => toggleWindow());
    console.log('[tray] 托盘已就绪');
  } catch (e) {
    console.error('[tray] 初始化失败：' + e.message);
  }
}

// Windows / macOS 支持把键盘上的多媒体键注册为全局快捷键
const MEDIA_KEYS = {
  MediaPlayPause: 'playPause',
  MediaNextTrack: 'next',
  MediaPreviousTrack: 'prev',
  MediaStop: 'stop',
};

function applyMediaKeys() {
  if (mediaKeysOn && !mediaRegistered) {
    for (const [acc, cmd] of Object.entries(MEDIA_KEYS)) {
      try {
        if (!globalShortcut.register(acc, () => sendMedia(cmd))) {
          console.warn('[media] 注册失败：' + acc);
        }
      } catch (e) {
        console.warn('[media] ' + acc + ' ' + e.message);
      }
    }
    mediaRegistered = true;
    console.log('[media] 已注册 ' + Object.keys(MEDIA_KEYS).length + ' 个媒体键');
  } else if (!mediaKeysOn && mediaRegistered) {
    globalShortcut.unregisterAll();
    mediaRegistered = false;
  }
}

// ---------------------------------------------------------------- 窗口
function createWindow() {
  console.log('[boot] 窗口创建于 ' + Math.round(process.uptime() * 1000) + 'ms');
  const win = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 900,
    minHeight: 600,
    title: 'ccMusic',
    frame: false, // 自绘标题栏
    show: false, // 内容就绪后再显示，避免“先弹白窗再干等”
    backgroundColor: '#f7f7f9',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false, // 后台不降频，保证连播不断
    },
  });

  mainWin = win;
  // 开发期：Ctrl+R / F5 直接刷新界面，改了渲染端代码连重启都不用
  if (!app.isPackaged) {
    win.webContents.on('before-input-event', (e, input) => {
      const hit = (input.control && input.key.toLowerCase() === 'r') || input.key === 'F5';
      if (hit) {
        e.preventDefault();
        win.webContents.reload();
      }
    });
  }

  // 首帧就绪即显示；兜底 2.5s 强制显示，防止极少数情况下 ready-to-show 不触发
  win.once('ready-to-show', () => {
    if (!win.isVisible()) win.show();
  });
  setTimeout(() => {
    if (!win.isDestroyed() && !win.isVisible()) win.show();
  }, 2500);

  // 关窗口默认进托盘后台续播；只有 tray 菜单「退出」或开关关闭时才真正退出
  win.on('close', (e) => {
    if (!quitting && closeToTray && tray) {
      e.preventDefault();
      win.hide();
    }
  });

  // 关键：给渲染进程发出的媒体/图片请求补齐 Referer 与 UA
  session.defaultSession.webRequest.onBeforeSendHeaders(
    {
      urls: [
        '*://*.bilivideo.com/*',
        '*://*.hdslb.com/*',
        '*://*.biliapi.com/*',
        '*://*.biliimg.com/*',
      ],
    },
    (details, callback) => {
      const h = Object.assign({}, details.requestHeaders);
      h['Referer'] = REFERER;
      h['User-Agent'] = UA;
      callback({ requestHeaders: h });
    }
  );

  const file = path.join(__dirname, 'renderer', 'index.html');
  // 自检模式：BILI_SELFTEST=1 时渲染进程自动跑一次全链路验证
  if (process.env.BILI_SELFTEST) win.loadFile(file, { query: { selftest: '1' } });
  else win.loadFile(file);
  return win;
}

// 规避异常退出留下的 GPU 缓存锁导致的启动卡顿（不影响图片 HTTP 缓存）
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');

// 单实例：再点一次直接聚焦已开窗口，避免多开抢媒体键、抢缓存目录
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWin) {
      if (mainWin.isMinimized()) mainWin.restore();
      if (!mainWin.isVisible()) mainWin.show();
      mainWin.focus();
    }
  });
}

app.whenReady().then(async () => {
  try {
    Menu.setApplicationMenu(null);
  } catch (e) {}
  // 关键：先出界面，网络库与会话预热放到首屏之后，避免阻塞启动
  createWindow();
  setupAutoUpdater();
  setupTray();
  applyMediaKeys(); // 默认开启，渲染端读完设置后会再同步一次
  app.on('before-quit', () => globalShortcut.unregisterAll());
  setTimeout(() => {
    netInit()
      .then(() => ensureSession())
      .catch((e) => console.error('[session]', e.message));
  }, 600); // 错开首屏渲染高峰
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
