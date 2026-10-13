// 对比首页候选数据源：排行榜 / 关键词搜索 / 子分区
const path = require('path');
const fs = require('fs');
const os = require('os');
const { app, BrowserWindow } = require('electron');

app.setName('ccMusic');
const real = path.join(app.getPath('userData'), 'radio-data.json');
const tmp = path.join(os.tmpdir(), 'ccmusic-src-probe');
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

  const show = (tag, list) => {
    console.log('\n' + tag + ' (' + list.length + ')');
    list.slice(0, 6).forEach((x) => {
      const d = typeof x.duration === 'number' ? Math.round(x.duration / 60) + '分' : x.duration;
      console.log('  · ' + String(x.title).slice(0, 34) + ' | ' + (x.author || '') + ' | ' + d
        + (x.play ? ' | ' + x.play + '播放' : ''));
    });
  };

  // A. 现在的：音乐区排行榜
  try {
    const r = await win.webContents.executeJavaScript('(async () => await window.api.hot())()');
    show('A 音乐区排行榜（现状）', r.list);
  } catch (e) { console.log('A 失败', e.message); }

  // B. 关键词搜索
  for (const kw of ['音乐']) {
    try {
      const r = await win.webContents.executeJavaScript(`(async () => await window.api.search(${JSON.stringify(kw)}, 1))()`);
      show('B 搜索「' + kw + '」', r.list);
    } catch (e) { console.log('B 失败', kw, e.message); }
  }

  // C. 排行榜 + 过滤（时长<=20分钟，排除合集/盘点/节目类）
  try {
    const r = await win.webContents.executeJavaScript('(async () => await window.api.hot())()');
    const bad = /合集|盘点|歌单|排行|榜单|100首|50首|期|综艺|reaction|翻唱合集|循环|小时|EP|MV|预告|reaction|挑战/i;
    const kept = r.list.filter((x) => {
      const d = Number(x.duration) || 0;
      return d > 60 && d <= 1200 && !bad.test(x.title || '');
    });
    show('C 排行榜+过滤后', kept);
    console.log('  过滤前 ' + r.list.length + ' 条 -> 过滤后 ' + kept.length + ' 条');
  } catch (e) { console.log('C 失败', e.message); }

  app.exit(0);
})().catch((e) => { console.error('FAIL:', e.message); app.exit(1); });
