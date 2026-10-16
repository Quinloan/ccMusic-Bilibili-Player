// 验证产品代码路径：调用 window.api.splitAnalyze（主进程 split:analyze）
// 用法: probe-split-ipc.js [bvid] [maxSec]   maxSec>0 时只分析前 N 秒（调试用）
const path = require('path');
const fs = require('fs');
const os = require('os');
const { app, BrowserWindow } = require('electron');

app.setName('ccMusic');
const real = path.join(app.getPath('userData'), 'radio-data.json');
const tmp = path.join(os.tmpdir(), 'ccmusic-split-ipc');
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

  const bvid = process.argv[2] || 'BV1uuHd6cEhy';
  const maxSec = +(process.argv[3] || 0);
  const meta = await win.webContents.executeJavaScript(
    `(async () => await window.api.video(${JSON.stringify(bvid)}))()`
  );
  console.log('视频:', String(meta.title).slice(0, 34), '| 时长', meta.duration + 's');

  const t0 = Date.now();
  const r = await win.webContents.executeJavaScript(
    `(async () => await window.api.splitAnalyze(${JSON.stringify(bvid)}, ${meta.cid}, ${maxSec}))()`
  );
  console.log('分析完成，耗时 ' + ((Date.now() - t0) / 1000).toFixed(1) + ' 秒');
  console.log('音频时长: ' + r.duration + 's | 静音段: ' + r.silences + ' 个 | 切成: '
    + r.tracks.length + ' 首 | 识别出: ' + (r.named || 0) + ' 首');
  r.tracks.forEach((t, i) => {
    const pos = Math.floor(t.start / 60) + '分' + Math.round(t.start % 60) + '秒';
    const end = Math.floor(t.end / 60) + '分' + Math.round(t.end % 60) + '秒';
    const tag = t.title ? '  >> ' + t.title + (t.artist ? ' - ' + t.artist : '') : '  (未识别)';
    console.log('  曲目' + (i + 1) + ': ' + pos + ' - ' + end + '  (' + Math.round(t.end - t.start) + 's)' + tag);
  });
  app.exit(0);
})().catch((e) => { console.error('FAIL:', e.message); app.exit(1); });
