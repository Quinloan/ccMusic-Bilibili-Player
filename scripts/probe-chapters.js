// 探测：B 站视频接口里有没有"章节/看点"数据（可用作长视频分歌的现成切点）
const path = require('path');
const fs = require('fs');
const os = require('os');
const { app, BrowserWindow } = require('electron');

app.setName('ccMusic');
const real = path.join(app.getPath('userData'), 'radio-data.json');
const tmp = path.join(os.tmpdir(), 'ccmusic-ch-probe');
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
  await wait(3000);

  // 先搜一个长视频（>30 分钟）
  const r = await win.webContents.executeJavaScript(`(async () => await window.api.search('音乐', 1))()`);
  const long = (r.list || []).filter((x) => {
    const d = typeof x.duration === 'string' && x.duration.includes(':')
      ? x.duration.split(':').reduce((a, b) => a * 60 + (+b || 0), 0) : Number(x.duration) || 0;
    return d > 1800;
  });
  console.log('长视频候选:', long.length);
  const targets = long.slice(0, 3).map((x) => x.bvid);

  for (const bv of targets) {
    const v = await win.webContents.executeJavaScript(`(async () => await window.api.video(${JSON.stringify(bv)}))()`);
    console.log('\n' + bv + ' | ' + String(v.title).slice(0, 30) + ' | 时长 ' + v.duration + 's');
    console.log('  返回字段:', Object.keys(v).join(', '));
    const desc = await win.webContents.executeJavaScript(`(async () => {
      const m = await window.api.video(${JSON.stringify(bv)});
      return m.desc || '';
    })()`);
    console.log('  简介前 260 字: ' + String(desc).replace(/\n+/g, ' | ').slice(0, 260));
  }
  app.exit(0);
})().catch((e) => { console.error('FAIL:', e.message); app.exit(1); });
