// 端到端验证：B 站真实音频 → 裁剪版 ffmpeg → PCM → 自写静音检测 → 切点
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const { app, BrowserWindow } = require('electron');

app.setName('ccMusic');
const real = path.join(app.getPath('userData'), 'radio-data.json');
const tmp = path.join(os.tmpdir(), 'ccmusic-split-probe');
fs.mkdirSync(tmp, { recursive: true });
try {
  const d = JSON.parse(fs.readFileSync(real, 'utf8'));
  fs.writeFileSync(path.join(tmp, 'radio-data.json'), JSON.stringify(d));
} catch (e) {}
app.setPath('userData', tmp);

require('../main.js');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const FFMPEG = path.join(__dirname, '..', 'resources', 'ffmpeg-mini.exe');
const RATE = 8000; // 8kHz 单声道足够判断静音，数据量小

(async () => {
  for (let i = 0; i < 100; i++) {
    const w = BrowserWindow.getAllWindows()[0];
    if (w && w.webContents) {
      try { await w.webContents.executeJavaScript('1'); break; } catch (e) {}
    }
    await wait(200);
  }
  const win = BrowserWindow.getAllWindows()[0];
  await wait(3000);

  // 1. 取真实音频流地址（走 B.playurl，带签名与登录态）
  const meta = await win.webContents.executeJavaScript(
    `(async () => await window.api.video(${JSON.stringify(process.argv[2] || 'BV1FPjy6TEiE')}))()`
  );
  const p = meta.parts[0];
  const url = await win.webContents.executeJavaScript(
    `(async () => { const r = await window.api.playurl(${JSON.stringify(meta.bvid)}, ${p.cid}); return (r.tracks && r.tracks[0]) ? r.tracks[0].url : null; })()`
  );
  console.log('视频:', String(meta.title).slice(0, 30), '| 第1P:', p.part, '| 时长', p.duration + 's');
  if (!url) { console.log('没拿到音频流地址'); app.exit(1); }
  console.log('音频流:', url.slice(0, 60) + '...');

  // 2. 主进程下载（带 B 站要求的 Referer/UA/cookie），边下边喂给 ffmpeg
  const cookie = JSON.parse(fs.readFileSync(path.join(tmp, 'radio-data.json'), 'utf8')).cookies || {};
  const ck = Object.keys(cookie).map((k) => `${k}=${cookie[k]}`).join('; ');
  const { undici } = { undici: require('undici') };
  const res = await undici.fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36',
      Referer: 'https://www.bilibili.com/',
      Cookie: ck,
      Range: 'bytes=0-12000000', // 测试只拉前 ~12MB
    },
  });
  console.log('下载响应:', res.status, '| 大小', res.headers.get('content-length'));

  // 3. ffmpeg 解封装+解码+降采样，吐 PCM 到 stdout
  const ff = spawn(FFMPEG, ['-i', 'pipe:0', '-f', 's16le', '-ac', '1', '-ar', String(RATE), 'pipe:1']);
  let bytes = 0;
  // 4. Node 边收 PCM 边算 RMS，找静音段
  const WIN = RATE / 10; // 每 100ms 一个窗口
  let winAcc = 0, winN = 0;
  const rms = [];
  ff.stdout.on('data', (buf) => {
    bytes += buf.length;
    for (let i = 0; i + 1 < buf.length; i += 2) {
      const s = buf.readInt16LE(i) / 32768;
      winAcc += s * s; winN++;
      if (winN >= WIN) { rms.push(Math.sqrt(winAcc / winN)); winAcc = 0; winN = 0; }
    }
  });
  const ffErr = [];
  ff.stderr.on('data', (d) => ffErr.push(d.toString()));

  let written = false;
  (async () => {
    for await (const chunk of res.body) {
      if (!ff.stdin.writable) break;
      if (!ff.stdin.write(chunk)) await new Promise((r) => ff.stdin.once('drain', r));
    }
    written = true;
    ff.stdin.end();
  })().catch((e) => console.log('下载出错:', e.message));

  await new Promise((r) => ff.on('close', r));
  const secs = bytes / 2 / RATE;
  console.log(`\nPCM: ${(bytes / 1024 / 1024).toFixed(1)} MB | 音频时长 ${secs.toFixed(1)}s | 窗口数 ${rms.length}`);

  // 静音检测：RMS < 阈值且持续 >= 1.5 秒
  const TH = 0.008;      // 阈值（相对满量程）
  const MIN_SIL = 1.5;   // 最短静音秒数
  const MIN_TRACK = 60;  // 单曲最短 60 秒
  const silences = [];
  let runStart = -1;
  rms.forEach((v, i) => {
    const t = i / 10;
    if (v < TH) { if (runStart < 0) runStart = t; }
    else if (runStart >= 0) {
      const dur = t - runStart;
      if (dur >= MIN_SIL) silences.push({ from: runStart, to: t, dur: +dur.toFixed(1) });
      runStart = -1;
    }
  });
  console.log(`\n检测到静音段 ${silences.length} 个（阈值 ${TH}, 最短 ${MIN_SIL}s）:`);
  silences.slice(0, 8).forEach((s) => console.log(`  ${s.from.toFixed(1)}s → ${s.to.toFixed(1)}s (${s.dur}s)`));

  // 生成曲目（按静音中点切，过滤太短的）
  const cuts = silences.map((s) => (s.from + s.to) / 2);
  const tracks = [];
  let start = 0;
  cuts.forEach((c) => {
    if (c - start >= MIN_TRACK) { tracks.push({ start: +start.toFixed(1), end: +c.toFixed(1) }); start = c; }
  });
  if (secs - start >= MIN_TRACK) tracks.push({ start: +start.toFixed(1), end: +secs.toFixed(1) });
  console.log(`\n切成 ${tracks.length} 首:`);
  tracks.slice(0, 10).forEach((t, i) =>
    console.log(`  曲目${i + 1}: ${t.start}s – ${t.end}s (${(t.end - t.start).toFixed(0)}s)`));

  if (ffErr.length) console.log('\nffmpeg 提示:', ffErr.join('').split('\n').slice(-3).join(' | '));
  app.exit(0);
})().catch((e) => { console.error('FAIL:', e.message); app.exit(1); });
