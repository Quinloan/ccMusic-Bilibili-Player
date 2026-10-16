// 验证：听歌识曲链路 —— 真实歌曲音频 → 8kHz PCM → AFP 指纹 → 网易云匹配
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const { app, BrowserWindow } = require('electron');

app.setName('ccMusic');
const real = path.join(app.getPath('userData'), 'radio-data.json');
const tmp = path.join(os.tmpdir(), 'ccmusic-shazam-probe');
fs.mkdirSync(tmp, { recursive: true });
try {
  const d = JSON.parse(fs.readFileSync(real, 'utf8'));
  fs.writeFileSync(path.join(tmp, 'radio-data.json'), JSON.stringify(d));
} catch (e) {}
app.setPath('userData', tmp);

require('../main.js');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const FFMPEG = path.join(__dirname, '..', 'resources', 'ffmpeg-mini.exe');
const AFP_DIR = process.env.AFP_DIR || 'C:/tmp';
const BVID = process.argv[2] || 'BV1FPjy6TEiE';
const PART = +(process.argv[3] || 1);   // 第几个 P
const OFFSET = +(process.argv[4] || 0); // 从第几秒开始取（副歌段命中率通常更高）

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

  // 1. 取音频流
  const meta = await win.webContents.executeJavaScript(
    `(async () => await window.api.video(${JSON.stringify(BVID)}))()`
  );
  const part = meta.parts[PART - 1];
  console.log('视频:', String(meta.title).slice(0, 28));
  console.log('待识别:', part.part, '(应为这首歌)');
  const url = await win.webContents.executeJavaScript(
    `(async () => { const r = await window.api.playurl(${JSON.stringify(BVID)}, ${part.cid}); return r.tracks[0].url; })()`
  );

  // 2. 下载开头一小段（约 15 秒的音频足够识别）
  const { fetch } = require('undici');
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36',
      Referer: 'https://www.bilibili.com/',
      Range: OFFSET ? 'bytes=0-' : 'bytes=0-260000',
    },
  });
  console.log('下载:', res.status);

  // 3. 转 8kHz 单声道 PCM
  const ffArgs = ['-i', 'pipe:0'];
  if (OFFSET) ffArgs.push('-ss', String(OFFSET));
  ffArgs.push('-t', '12', '-f', 's16le', '-ac', '1', '-ar', '8000', 'pipe:1');
  const ff = spawn(FFMPEG, ffArgs);
  const chunks = [];
  ff.stdout.on('data', (b) => chunks.push(b));
  const pump = (async () => {
    for await (const c of res.body) {
      if (!ff.stdin.writable) break;
      if (!ff.stdin.write(c)) await new Promise((r) => ff.stdin.once('drain', r));
    }
    ff.stdin.end();
  })();
  await Promise.all([pump.catch(() => {}), new Promise((r) => ff.on('close', r))]);
  const pcm = Buffer.concat(chunks);
  const secs = pcm.length / 2 / 8000;
  console.log(`PCM: ${(pcm.length / 1024).toFixed(0)} KB / ${secs.toFixed(1)} 秒`);
  if (secs < 3) { console.log('音频太短'); app.exit(1); }

  // 4. 生成指纹
  const { GenerateFP } = require(path.join(AFP_DIR, 'afp.js'));
  const f32 = new Float32Array(pcm.length / 2);
  for (let i = 0; i < f32.length; i++) f32[i] = pcm.readInt16LE(i * 2) / 32768;
  const fp = await GenerateFP(f32);
  console.log('指纹长度:', fp.length, '字符');

  // 5. 问网易云
  const api = `https://interface.music.163.com/api/music/audio/match`
    + `?sessionId=0123456789abcdef&algorithmCode=shazam_v2&duration=${Math.min(12, Math.round(secs))}`
    + `&rawdata=${encodeURIComponent(fp)}&times=1&decrypt=1`;
  const r = await fetch(api);
  const j = await r.json();
  const list = (j.data && j.data.result) || [];
  console.log('\n识别结果:', list.length ? '' : '（无结果）');
  list.slice(0, 3).forEach((m) => {
    const s = m.song || {};
    const artists = (s.artists || []).map((a) => a.name).join('/');
    console.log(`  ★ ${s.name} — ${artists}${s.album ? '（《' + s.album.name + '》）' : ''}`);
  });
  app.exit(0);
})().catch((e) => { console.error('FAIL:', e.message); app.exit(1); });
