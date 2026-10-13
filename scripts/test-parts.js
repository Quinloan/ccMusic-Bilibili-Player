// 端到端验证多 P 功能：跑真实 main.js（真实网络 + 真实 B 站接口），
// 在渲染进程里执行 pickParts → 全选 → 加入歌单 → 播放所选，最后截图。
// 用法: node scripts/test-parts.js <BV号> [输出截图.png]
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow } = require('electron');

const BVID = process.argv[2] || 'BV1FPjy6TEiE';
const OUT = process.argv[3] || 'shots/99-parts.png';

// 用独立 userData，避免与已安装的 ccMusic 抢单例锁 / 覆盖真实歌单
app.setPath('userData', path.join(app.getPath('temp'), 'ccmusic-test-parts'));

require('../main.js'); // 注册全部 IPC 并创建窗口

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function getWin() {
  for (let i = 0; i < 100; i++) {
    const w = BrowserWindow.getAllWindows()[0];
    if (w && w.webContents) {
      try { await w.webContents.executeJavaScript('1'); return w; } catch (e) { /* 还没就绪 */ }
    }
    await wait(200);
  }
  throw new Error('窗口一直没就绪');
}

(async () => {
  const win = await getWin();
  await wait(2500); // 等渲染端 init + session 就绪
  const run = (js) => win.webContents.executeJavaScript(js);
  const log = (...a) => console.log(...a);
  const withAudio = process.argv.includes('--audio'); // 默认不播放；只有显式 --audio 才播

  // 1. 直接调主进程接口看返回值（不经 UI）
  const meta = await run(`(async () => {
    const m = await window.api.video(${JSON.stringify(BVID)});
    return { videos: m.videos, parts: (m.parts||[]).length, title: m.title,
             duration: m.duration, first: m.parts[0], second: m.parts[1], hasSeason: !!m.season };
  })()`);
  log('[1] 视频信息:', JSON.stringify(meta, null, 0).slice(0, 500));

  // 2. 打开分 P 面板
  await run(`pickParts({ bvid: ${JSON.stringify(BVID)} })`);
  await wait(2500);
  const panel = await run(`({
    open: !document.querySelector('#partsModal').hidden,
    rows: document.querySelectorAll('#pmList .part-row').length,
    checked: Array.from(document.querySelectorAll('#pmList .part-row input')).filter(i=>i.checked).length,
    sub: document.querySelector('#pmSub').textContent,
    sum: document.querySelector('#pmSum').textContent,
    addBtn: document.querySelector('#pmAdd').textContent,
  })`);
  log('[2] 分P面板:', JSON.stringify(panel));

  // 3. 全选 → 加入歌单
  await run(`$('#pmAll').click()`);
  await wait(200);
  await run(`$('#pmAdd').click()`);
  await wait(1200);
  const lib = await run(`({
    count: folder().items.length,
    first: folder().items[0] && { page: folder().items[0].page, cid: folder().items[0].cid, title: folder().items[0].title, up: folder().items[0].up, dur: folder().items[0].duration },
    last: folder().items.slice(-1)[0] && { page: folder().items.slice(-1)[0].page, title: folder().items.slice(-1)[0].title },
    rows: document.querySelectorAll('#list .row').length,
    badges: document.querySelectorAll('#list .ptag').length,
    libCount: document.querySelector('#libCount').textContent,
  })`);
  log('[3] 加入歌单:', JSON.stringify(lib));

  // 4. 播放第 3 P（验证 cid 取流链路）
  if (withAudio) {
  await run(`playIndex(2)`);
  await wait(3500);
  const play = await run(`({
    cur: S.cur, paused: audio.paused, dur: Math.round(audio.duration||0),
    src: (audio.currentSrc||'').slice(0, 70),
    bTitle: document.querySelector('#bTitle').textContent,
    quality: document.querySelector('#quality').textContent,
    err: audio.error && audio.error.message,
  })`);
  log('[4] 播放 P3:', JSON.stringify(play));
  } else { log('[4] 播放: 已跳过（默认不播放）'); }

  // 5. 重复加入去重
  await run(`pickParts({ bvid: ${JSON.stringify(BVID)} })`);
  await wait(2000);
  const again = await run(`({
    rows: document.querySelectorAll('#pmList .part-row').length,
    inLib: document.querySelectorAll('#pmList .part-row.in-lib').length,
    checked: Array.from(document.querySelectorAll('#pmList .part-row input')).filter(i=>i.checked).length,
  })`);
  log('[5] 再次打开(应全部标记已在歌单且不勾选):', JSON.stringify(again));

  // 6. 仅播放：只进播放列表，收藏夹数量必须不变
  const before = await run(`folder().items.length`);
  await run(`$('#pmAll').click()`);
  await wait(200);
  await run(`$('#pmPlayOnly').click()`);
  await wait(3500);
  const only = await run(`({
    libCount: folder().items.length,
    queue: S.queue.length, qcur: S.qcur,
    playing: !audio.paused,
    bTitle: document.querySelector('#bTitle').textContent,
    badge: document.querySelector('#qBadge') && document.querySelector('#qBadge').textContent,
  })`);
  log('[6] 仅播放（收藏夹应仍为', before, '）:', JSON.stringify(only));

  // 6b. 取流策略：关闭=默认档(30232)，开启=最高档(该视频无 FLAC)
  const pick = await run(`(async () => {
    const p = await window.api.playurl(${JSON.stringify(BVID)}, ${JSON.stringify((await run('S.queue[0] ? S.queue[0].cid : ""')) || '')});
    const pickOf = (pref) => {
      localStorage.prefFlac = pref;
      const t = pickTrack(p);
      return { id: t.id, kbps: t.kbps };
    };
    const off = pickOf('0');
    const on = pickOf('1');
    localStorage.prefFlac = '0';
    return { rawFirst: p.raw && p.raw[0], flac: !!p.flac, off, on };
  })()`);
  log('[6b] 取流策略:', JSON.stringify(pick));

  // 7. 打开播放列表面板并截图
  await run(`$('#queuePanel').hidden = false; renderQueue()`);
  await wait(400);
  const panel2 = await run(`({
    open: !document.querySelector('#queuePanel').hidden,
    rows: document.querySelectorAll('#queueList .q-row').length,
    onRow: document.querySelectorAll('#queueList .q-row.on').length,
    info: document.querySelector('#qInfo').textContent,
  })`);
  log('[7] 播放列表面板:', JSON.stringify(panel2));

  // 8. 歌单分组：组头存在 → 收起 → 只剩组头一行
  const grp = await run(`(() => {
    const heads = document.querySelectorAll('#list .row.group');
    return { heads: heads.length,
             label: heads[0] ? heads[0].querySelector('.t').textContent.trim() : null,
             childRows: document.querySelectorAll('#list .row.child').length };
  })()`);
  log('[8] 分组渲染:', JSON.stringify(grp));
  await run(`toggleCollapsed(${JSON.stringify(BVID)})`);
  await wait(400);
  const col = await run(`(() => {
    const g = document.querySelector('#list .row.group');
    return { allRows: document.querySelectorAll('#list .row').length,
             arrow: g ? g.querySelector('.garrow').textContent : null };
  })()`);
  log('[9] 收起后(应只剩组头, 箭头▸):', JSON.stringify(col));

  // 10. 音量平衡：音频图是否建立、有无信号、补偿增益是否算出来
  if (withAudio) {
  const vb = await run(`(async () => {
    applyBalanceRouting();
    startAgc();
    await new Promise((r) => setTimeout(r, 6000));
    const buf = new Uint8Array(anNode.fftSize);
    anNode.getByteTimeDomainData(buf);
    let peak = 0;
    for (let i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i] - 128) / 128);
    return {
      on: balanceOn(), ctx: ac.state, hasGraph: !!(srcNode && compNode && gainNode),
      gain: +gainNode.gain.value.toFixed(2), peakNow: +peak.toFixed(3), paused: audio.paused,
    };
  })()`);
  log('[10] 音量平衡(gain≈0.6~2, peakNow>0 表示有信号):', JSON.stringify(vb));
  } else { log('[10] 音量平衡: 已跳过（默认不播放）'); }

  // 11. 音量曲线：小声区可微调，不再一拉就没声
  const vol = await run(`(() => {
    const s = document.querySelector('#vol');
    const at = (p) => { s.value = p; s.dispatchEvent(new Event('input')); return +audio.volume.toFixed(3); };
    const r = { pos5: at(5), pos10: at(10), pos20: at(20), pos50: at(50), pos80: at(80) };
    s.value = 89; s.dispatchEvent(new Event('input'));
    return r;
  })()`);
  log('[11] 音量曲线(线性时 pos10=0.1/pos20=0.2，平方后更平缓):', JSON.stringify(vol));

  // 12. 删除确认：点移除 → 弹窗 → 确认 → 歌曲真的少一首；取消路径也验证
  const del = await run(`(async () => {
    localStorage.collapsedVideos = '[]';
    renderList();
    await new Promise((r) => setTimeout(r, 150));
    const before = folder().items.length;
    document.querySelector('#list .row [data-rm]').click();
    await new Promise((r) => setTimeout(r, 250));
    const shown = !document.querySelector('#confirmModal').hidden;
    const title = document.querySelector('#cfTitle').textContent;
    document.querySelector('#cfCancel').click();
    await new Promise((r) => setTimeout(r, 150));
    const afterCancel = folder().items.length;
    document.querySelector('#list .row [data-rm]').click();
    await new Promise((r) => setTimeout(r, 250));
    document.querySelector('#cfOk').click();
    await new Promise((r) => setTimeout(r, 250));
    const after = folder().items.length;
    return { before, shown, title, afterCancel, after };
  })()`);
  log('[12] 删除确认(取消后数量不变, 确认后-1):', JSON.stringify(del));

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const img = await win.webContents.capturePage();
  fs.writeFileSync(OUT, img.toPNG());
  log('saved:', OUT);
  app.exit(0);
})().catch((e) => { console.error('FAIL:', e); app.exit(1); });
