// 候选关键词组的实际结果（带时长过滤，看看剩下的是不是"一首歌"）
const path = require('path');
const fs = require('fs');
const os = require('os');
const { app, BrowserWindow } = require('electron');

app.setName('ccMusic');
const real = path.join(app.getPath('userData'), 'radio-data.json');
const tmp = path.join(os.tmpdir(), 'ccmusic-kw-probe');
fs.mkdirSync(tmp, { recursive: true });
try {
  const d = JSON.parse(fs.readFileSync(real, 'utf8'));
  fs.writeFileSync(path.join(tmp, 'radio-data.json'), JSON.stringify({ cookies: d.cookies }));
} catch (e) {}
app.setPath('userData', tmp);

require('../main.js');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const GROUPS = [['音乐']];

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

  const dur = (d) => (typeof d === 'string' && d.includes(':')
    ? d.split(':').reduce((a, b) => a * 60 + (+b || 0), 0)
    : Number(d) || 0);
  const bad = /教程|教学|课程|入门|进阶|零基础|怎么|如何|测评|开箱|挑战|vs|reaction|综艺|解说|访谈|预告|直播回放/i;

  for (const g of GROUPS) {
    console.log('\n=== 关键词组：' + g.join(' / ') + ' ===');
    let total = 0, kept = 0;
    for (const kw of g) {
      const r = await win.webContents.executeJavaScript(
        `(async () => await window.api.search(${JSON.stringify(kw)}, 1))()`
      );
      const list = r.list || [];
      const ok = list.filter((x) => { const d = dur(x.duration); return d >= 60 && d <= 10800 && !bad.test(x.title || ''); });
      total += list.length; kept += ok.length;
      console.log(`  「${kw}」 共 ${list.length} 条，过滤后 ${ok.length} 条，原始前 8 条：`);
      list.slice(0, 8).forEach((x) => {
        const d = dur(x.duration);
        console.log(`     · ${String(x.title).slice(0, 30)} | ${x.author || ''} | ${Math.round(d / 60)}分${d % 60}秒 | ${x.play}播放`);
      });
    }
    console.log('  小计：过滤前 ' + total + ' → 过滤后 ' + kept);
  }

  app.exit(0);
})().catch((e) => { console.error('FAIL:', e.message); app.exit(1); });
