// 端到端：模拟把长视频加入歌单 → 自动触发分歌 → 检查歌单变成多首曲目
const path = require('path');
const fs = require('fs');
const os = require('os');
const { app, BrowserWindow } = require('electron');

app.setName('ccMusic');
const real = path.join(app.getPath('userData'), 'radio-data.json');
const tmp = path.join(os.tmpdir(), 'ccmusic-split-e2e');
fs.mkdirSync(tmp, { recursive: true });
try {
  const d = JSON.parse(fs.readFileSync(real, 'utf8'));
  fs.writeFileSync(path.join(tmp, 'radio-data.json'), JSON.stringify({ cookies: d.cookies }));
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
  const meta = await win.webContents.executeJavaScript(
    `(async () => await window.api.video(${JSON.stringify(bvid)}))()`
  );
  console.log('视频:', String(meta.title).slice(0, 30), meta.duration + 's');

  // 1. 模拟"加入收藏夹"（长视频、单 P）
  await win.webContents.executeJavaScript(`(async () => {
    const f = folder();
    f.items.push({
      bvid: ${JSON.stringify(bvid)}, cid: ${meta.cid}, page: 1,
      title: ${JSON.stringify(meta.title)}, vtitle: ${JSON.stringify(meta.title)},
      up: ${JSON.stringify(meta.up || '')}, cover: '', duration: ${meta.duration},
    });
    save(); renderFolders(); renderList();
    maybeSplit(f, f.items[f.items.length - 1]);
    return 'ok';
  })()`);
  console.log('已触发分析，等待…');
  await wait(20000); // 35 分钟音频下载+分析约几秒，留足余量

  // 2. 检查结果
  const r = await win.webContents.executeJavaScript(`({
    count: folder().items.length,
    last: folder().items.slice(-4).map((x) => x.title + (x.split ? '/' + Math.round(x.startSec) + '-' + Math.round(x.endSec) + 's' : '/整段')),
    rows: document.querySelectorAll('#list .row').length,
    groups: document.querySelectorAll('#list .row.group').length,
    libCount: document.querySelector('#libCount').textContent,
  })`);
  console.log('歌单条目:', r.count, '| 列表行:', r.rows, '| 被折叠的组:', r.groups, '|', r.libCount);
  console.log('最后几首:', r.last.join('  '));

  app.exit(0);
})().catch((e) => { console.error('FAIL:', e.message); app.exit(1); });
