// 开发用：启动界面截图。用法 node scripts/dev-screenshot.js <输出.png> [--demo] [--menu] [--about] [--search] [--back]
// 独立入口，不加载 main.js 的业务逻辑，只渲染 renderer/index.html
// --demo 会注入一批演示歌单数据 + 播放中状态，让截图有内容（只影响本次截图进程，不写库）
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow } = require('electron');

const out = process.argv[2] || 'shot.png';
const openMenu = process.argv.includes('--menu');
const openAbout = process.argv.includes('--about');
const testBack = process.argv.includes('--back');
const demo = process.argv.includes('--demo');
const search = process.argv.includes('--search');
const openQueue = process.argv.includes('--queue');
const openSettings = process.argv.includes('--settings');
const collapseGroups = process.argv.includes('--collapse');
const shotConfirm = process.argv.includes('--confirm');
const shotHome = process.argv.includes('--home');

// 演示数据注入脚本（在渲染进程执行）
const DEMO_JS = `
(function () {
  var C = ['#ff8fb1','#7ec8e3','#ffd166','#9fe0a8','#c9b6ff','#ffb37e','#8fd4c1','#f7a8b8'];
  var mk = function (c) {
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="140" height="140">'
      + '<rect width="140" height="140" fill="' + c + '"/>'
      + '<circle cx="70" cy="70" r="30" fill="rgba(255,255,255,.9)"/>'
      + '<circle cx="70" cy="70" r="8" fill="' + c + '"/></svg>';
    return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
  };
  var mk2 = function (c, t) {
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="100">'
      + '<rect width="160" height="100" fill="' + c + '"/>'
      + '<text x="80" y="58" font-size="26" fill="rgba(255,255,255,.95)" '
      + 'font-family="sans-serif" text-anchor="middle">' + t + '</text></svg>';
    return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
  };
  var item = function (bvid, title, up, dur, i) {
    return { bvid: bvid, cid: 1000 + i, title: title, up: up, duration: dur,
             cover: mk(C[i % C.length]) };
  };
  var partItem = function (bvid, page, title, up, dur, i) {
    return { bvid: bvid, cid: 2000 + page, page: page, title: title, vtitle: '【周杰伦】50首精选合集',
             up: up, duration: dur, cover: mk(C[2]) };
  };
  // 一个多 P 合集（P1~P6）+ 两首独立歌曲，截图能展示分组折叠
  var f1 = {
    id: 'f1', name: '我的收藏夹', items: [
      partItem('BV1FPjy6TEiE', 1, '周杰伦-晴天', '超级爱下雨天', 270, 0),
      partItem('BV1FPjy6TEiE', 2, '周杰伦-夜曲', '超级爱下雨天', 227, 1),
      partItem('BV1FPjy6TEiE', 3, '周杰伦-星晴', '超级爱下雨天', 259, 2),
      partItem('BV1FPjy6TEiE', 4, '周杰伦-七里香', '超级爱下雨天', 300, 3),
      partItem('BV1FPjy6TEiE', 5, '周杰伦-花海', '超级爱下雨天', 265, 4),
      partItem('BV1FPjy6TEiE', 6, '周杰伦-稻香', '超级爱下雨天', 224, 5),
      item('BV1g411c7F0', '在百万家装录音棚大声听 徐良&小凌《坏女孩》', 'JLRS-LeoFM', 244, 6),
      item('BV1h411c7F1', '起风了', '买辣椒也用券', 325, 7),
    ],
  };
  var f2 = {
    id: 'f2', name: '睡前纯音乐', items: [
      item('BV2a411c7EU', 'River Flows in You', 'Yiruma', 190, 1),
      item('BV2b411c7EV', 'Kiss the Rain', 'Yiruma', 274, 3),
      item('BV2c411c7EW', '天空之城', '久石让', 245, 5),
    ],
  };
  var f3 = { id: 'f3', name: '日推随机', items: [item('BV3a411c7EU', 'Mine', 'Bazzi', 152, 2)] };
  S.folders = [f1, f2, f3];
  S.active = 'f1';
  S.cur = 2;
  renderFolders();
  renderList();
  // 顺带把播放列表（队列）也填上，截图层能展示右侧面板
  f1.items.forEach(function (x) { if (!x.vtitle) x.vtitle = x.title; });
  S.queue = f1.items.slice(0, 12).map(function (x) { return Object.assign({}, x); });
  S.qcur = 2;
  renderQueue();
  S.history = [
    { bvid: 'BV1FPjy6TEiE', cid: 39252201332, page: 3, title: '周杰伦-星晴',
      up: '超级爱下雨天', cover: mk(C[2]), duration: 259, vtitle: '【周杰伦】50首精选合集' },
    { bvid: 'BV1g411c7F0', cid: 1006, page: 1, title: '在百万家装录音棚大声听 徐良&小凌《坏女孩》',
      up: 'JLRS-LeoFM', cover: mk(C[6]), duration: 244 },
    { bvid: 'BV1h411c7F1', cid: 1007, page: 1, title: '起风了',
      up: '买辣椒也用券', cover: mk(C[0]), duration: 325 },
    { bvid: 'BV2a411c7EU', cid: 1001, page: 1, title: 'River Flows in You',
      up: 'Yiruma', cover: mk(C[3]), duration: 190 },
  ];
  S.hot = [
    { bvid: 'BV9x411c7mG', cid: 1, title: '【Hi-Res】无损音质试音天碟', author: '音乐区UP', pic: mk(C[1]), duration: 320, play: 128000 },
    { bvid: 'BV9y411c7mH', cid: 2, title: '循环歌单｜深夜适合听的华语慢歌', author: '深夜电台', pic: mk(C[4]), duration: 3619, play: 452000 },
    { bvid: 'BV9z411c7mI', cid: 3, title: '一个人的房间，开一盏灯', author: '安静角落', pic: mk(C[5]), duration: 268, play: 33000 },
    { bvid: 'BV9v411c7mJ', cid: 4, title: '钢琴改编｜起风了', author: '钢琴菌', pic: mk(C[7]), duration: 245, play: 98000 },
  ];
  localStorage.collapsedVideos = ${collapseGroups ? "JSON.stringify(['BV1FPjy6TEiE'])" : "'[]'"};
  renderList();

  // 底部播放条：伪装成正在播放
  var cover = mk(C[2]);
  var bc = document.querySelector('#bCover'); if (bc) bc.src = cover;
  var bt = document.querySelector('#bTitle'); if (bt) bt.textContent = '晴天';
  var bu = document.querySelector('#bUp'); if (bu) bu.textContent = '周杰伦';
  var pb = document.querySelector('#play'); if (pb) pb.textContent = '⏸';
  var cu = document.querySelector('#cur'); if (cu) cu.textContent = '01:12';
  var du = document.querySelector('#dur'); if (du) du.textContent = '04:29';
  var sk = document.querySelector('#seek'); if (sk) { sk.value = 270; }
  var q = document.querySelector('#quality');
  if (q) { q.textContent = '无损优先'; q.classList.add('on'); }
  var av = document.querySelector('#avatarImg');
  if (av) {
    av.src = 'data:image/svg+xml;utf8,' + encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" width="72" height="72">'
      + '<rect width="72" height="72" fill="#185fa5"/>'
      + '<circle cx="36" cy="26" r="12" fill="#fff"/>'
      + '<path d="M12 68c0-13 11-22 24-22s24 9 24 22z" fill="#fff"/></svg>');
  }
  return 'demo-ok';
})()
`;

const SEARCH_JS = `
(function () {
  var C = ['#ff8fb1','#7ec8e3','#ffd166','#9fe0a8','#c9b6ff','#ffb37e'];
  var mk2 = function (c, t) {
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="100">'
      + '<rect width="160" height="100" fill="' + c + '"/>'
      + '<text x="80" y="58" font-size="24" fill="rgba(255,255,255,.95)" '
      + 'font-family="sans-serif" text-anchor="middle">' + t + '</text></svg>';
    return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
  };
  S.results = [
    { bvid: 'BV1a411c7EU', title: '【Hi-Res】起风了 无损音质', up: '买辣椒也用券', duration: '5:25', play: 1280000, pic: mk2(C[0], '起风了') },
    { bvid: 'BV1b411c7EV', title: '起风了 钢琴独奏版', up: 'PianoCover', duration: '4:12', play: 356000, pic: mk2(C[1], '钢琴版') },
    { bvid: 'BV1c411c7EW', title: '起风了 吉他弹唱', up: '阿七不练琴', duration: '5:31', play: 98200, pic: mk2(C[2], '吉他版') },
    { bvid: 'BV1d411c7EX', title: '起风了 中文填词翻唱', up: '小橘子', duration: '5:19', play: 51200, pic: mk2(C[3], '翻唱') },
    { bvid: 'BV1e411c7EY', title: '起风了 交响乐版', up: 'SymphonyLab', duration: '6:03', play: 77400, pic: mk2(C[4], '交响乐') },
    { bvid: 'BV1f411c7EZ', title: '起风了 小提琴', up: '弦上光', duration: '4:48', play: 23300, pic: mk2(C[5], '小提琴') },
  ];
  var kw = document.querySelector('#kw'); if (kw) kw.value = '起风了';
  showView('search');
  renderResults();
  var mw = document.querySelector('#moreWrap'); if (mw) mw.hidden = false;
  return 'search-ok';
})()
`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1120,
    height: 760,
    frame: false,
    backgroundColor: '#f7f7f9',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  await new Promise((r) => setTimeout(r, 1500));
  if (demo) {
    console.log('demo:', await win.webContents.executeJavaScript(DEMO_JS));
    await new Promise((r) => setTimeout(r, 600));
  }
  if (search) {
    console.log('search:', await win.webContents.executeJavaScript(SEARCH_JS));
    await new Promise((r) => setTimeout(r, 600));
  }
  if (testBack) {
    const r = await win.webContents.executeJavaScript(
      "(function(){ showView('diag'); showView('about'); goBack(); return S.view; })()"
    );
    console.log('back-result:', r, '(期望 diag)');
  }
  if (openAbout) {
    await win.webContents.executeJavaScript(
      "typeof showView === 'function' ? (showView('about'), 'ok') : 'no-fn'"
    );
    await new Promise((r) => setTimeout(r, 400));
    await win.webContents.executeJavaScript(
      "document.querySelector('#playSettings')?.scrollIntoView({ block: 'start' }); 'ok'"
    );
    await new Promise((r) => setTimeout(r, 300));
  }
  if (openQueue) {
    await win.webContents.executeJavaScript(
      "document.querySelector('#queuePanel').hidden = false; renderQueue(); 'ok'"
    );
    await new Promise((r) => setTimeout(r, 300));
  }
  if (shotHome) {
    await win.webContents.executeJavaScript(
      "typeof renderHome === 'function' ? (showView('home'), renderHome(), document.querySelector('.page.home').scrollTop = 620, 'ok') : 'no-fn'"
    );
    await new Promise((r) => setTimeout(r, 400));
  }
  if (shotConfirm) {
    await win.webContents.executeJavaScript(
      "typeof askConfirm === 'function' ? (askConfirm('移除全部分 P', '「测试合集」的 6 首歌将一起从「我的收藏夹」移除。', '移除 6 首'), 'ok') : 'no-fn'"
    );
    await new Promise((r) => setTimeout(r, 400));
  }
  if (openSettings) {
    await win.webContents.executeJavaScript(
      "typeof openSettings === 'function' ? (openSettings(), 'ok') : 'no-fn'"
    );
    await new Promise((r) => setTimeout(r, 500));
  }
  if (openMenu) {
    await win.webContents.executeJavaScript(
      "typeof openAccountMenu === 'function' ? (openAccountMenu(), 'ok') : 'no-fn'"
    );
    await new Promise((r) => setTimeout(r, 400));
  }
  const diag = await win.webContents.executeJavaScript(`({
    folders: S.folders.length, items: (folder() || { items: [] }).items.length,
    rows: document.querySelectorAll('#list .row').length,
    collapsed: localStorage.collapsedVideos || '',
  })`).catch((e) => ({ diagErr: e.message }));
  console.log('diag:', JSON.stringify(diag));
  console.log('inj-has-toggle:', DEMO_JS.includes('toggleCollapsed'), 'argvCollapse:', process.argv.includes('--collapse'));
  const img = await win.webContents.capturePage();
  const diag2 = await win.webContents.executeJavaScript(`({
    rows: document.querySelectorAll('#list .row').length,
    folders: (window.S && S.folders || []).length,
    t: Math.round(performance.now()),
  })`).catch((e) => ({ diagErr: e.message }));
  console.log('diag2:', JSON.stringify(diag2));
  // capturePage 偶发拍到空白帧（合成器未重绘），多拍几张取字节最大的那张
  let best = img.toPNG();
  for (let k = 0; k < 4; k++) {
    const shot = await win.webContents.capturePage();
    const buf = shot.toPNG();
    if (buf.length > best.length) best = buf;
    await new Promise((r) => setTimeout(r, 350));
  }
  fs.writeFileSync(out, best);
  console.log('saved:', out, Math.round(best.length / 1024) + 'KB');
  app.exit(0);
});
