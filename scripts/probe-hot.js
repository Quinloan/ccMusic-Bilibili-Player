// 探测：首页热门接口 bili:hot 能否拿到音乐区排行榜
const path = require('path');
const fs = require('fs');
const os = require('os');
const { app, BrowserWindow } = require('electron');

app.setName('ccMusic'); // 让 userData 指向 %APPDATA%\ccMusic（带上登录态）
const real = path.join(app.getPath('userData'), 'radio-data.json');
const tmp = path.join(os.tmpdir(), 'ccmusic-hot-probe');
fs.mkdirSync(tmp, { recursive: true });
try {
  const d = JSON.parse(fs.readFileSync(real, 'utf8'));
  fs.writeFileSync(path.join(tmp, 'radio-data.json'), JSON.stringify({ cookies: d.cookies }));
} catch (e) { /* 没登录态也能跑 */ }
app.setPath('userData', tmp);

require('../main.js');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  for (let i = 0; i < 100; i++) {
    const w = BrowserWindow.getAllWindows()[0];
    if (w && w.webContents) {
      try { await w.webContents.executeJavaScript('1'); break; } catch (e) { /* 未就绪 */ }
    }
    await wait(200);
  }
  const win = BrowserWindow.getAllWindows()[0];
  await wait(3000);
  const r = await win.webContents.executeJavaScript(`(async () => {
    try {
      const h = await window.api.hot();
      return { n: (h.list || []).length, first: (h.list || []).slice(0, 3).map(x => x.title + ' / ' + x.author + ' / ' + x.duration) };
    } catch (e) { return { err: e.message }; }
  })()`);
  console.log('[hot]', JSON.stringify(r, null, 1));
  app.exit(0);
})().catch((e) => { console.error('FAIL:', e.message); app.exit(1); });
