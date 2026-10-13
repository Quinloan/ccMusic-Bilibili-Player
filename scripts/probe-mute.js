// 验证：webContents.setAudioMuted(true) 后，Web Audio 还能不能读到信号
// 若能，测试就能"无声播放"，不再打扰用户
const path = require('path');
const fs = require('fs');
const os = require('os');
const { app, BrowserWindow } = require('electron');

app.setName('ccMusic');
const real = path.join(app.getPath('userData'), 'radio-data.json');
const tmp = path.join(os.tmpdir(), 'ccmusic-mute-probe');
fs.mkdirSync(tmp, { recursive: true });
try {
  const d = JSON.parse(fs.readFileSync(real, 'utf8'));
  fs.writeFileSync(path.join(tmp, 'radio-data.json'), JSON.stringify(d));
} catch (e) {}
app.setPath('userData', tmp);

require('../main.js');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  for (let i = 0; i < 100; i++) {
    const w = BrowserWindow.getAllWindows()[0];
    if (w && w.webContents) {
      try { await w.webContents.executeJavaScript('1'); break; } catch (e) {}
    }
    await wait(200);
  }
  const win = BrowserWindow.getAllWindows()[0];
  await wait(2500);

  const peak = () => win.webContents.executeJavaScript(`(() => {
    if (!anNode) return -1;
    const b = new Uint8Array(anNode.fftSize);
    anNode.getByteTimeDomainData(b);
    let p = 0; for (let i = 0; i < b.length; i++) p = Math.max(p, Math.abs(b[i] - 128) / 128);
    return +p.toFixed(3);
  })()`);

  // 播放一首（用真实视频）
  await win.webContents.executeJavaScript(`(async () => {
    const meta = await window.api.video('BV1FPjy6TEiE');
    const p = meta.parts[2];
    loadQueue([{ bvid: meta.bvid, cid: p.cid, page: p.page, title: p.part,
      vtitle: meta.title, up: meta.up, cover: meta.cover, duration: p.duration }], 0);
    await playQueueAt(0);
    return 'ok';
  })()`);
  await wait(4000);
  console.log('有声时 peak =', await peak());

  win.webContents.setAudioMuted(true);
  await wait(1200);
  console.log('静音后 peak =', await peak());
  await wait(1500);
  console.log('静音 3 秒后 peak =', await peak());

  win.webContents.setAudioMuted(false);
  await wait(1000);
  console.log('恢复后 peak =', await peak());

  app.exit(0);
})().catch((e) => { console.error('FAIL:', e.message); app.exit(1); });
