const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
// 启动耗时埋点：定位“窗口出来了但内容迟迟不出现”的问题
const T0 = performance.now();
const mark = (s) => console.log('[perf] ' + s + ' @' + Math.round(performance.now() - T0) + 'ms');
mark('脚本开始执行');
const B = window.api; // 注意：不能用 const api，会与 contextBridge 暴露的 window.api 冲突
const audio = $('#audio');

const S = {
  view: 'library',
  folders: [],   // 收藏夹：持久歌单，手动整理
  active: null,
  cur: -1,
  queue: [],     // 播放列表：当前正在播的临时队列，不进收藏夹
  qcur: -1,      // 队列中正在播放的下标
  mode: 'loop', // loop | single | shuffle
  results: [],
  kw: '',
  page: 1,
  hasMore: false,
  history: [], // 最近播放（最多 24 条）
  hot: [],     // 首页：B 站音乐区热门
};

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (sec) => {
  if (!sec || !isFinite(sec)) return '00:00';
  const m = Math.floor(sec / 60), r = Math.floor(sec % 60);
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
};
// 搜索接口给 "4:30" 字符串，视频接口给秒数，统一展示
const fmtDur = (d) => (typeof d === 'number' ? fmt(d) : String(d || ''));
const fmtPlay = (n) => (n >= 10000 ? (n / 10000).toFixed(1) + ' 万' : String(n ?? 0));
const folder = () => S.folders.find((f) => f.id === S.active);
const save = () =>
  B.setLibrary({
    folders: S.folders, active: S.active, queue: S.queue, qcur: S.qcur,
    history: S.history,
  });

let toastTimer;
function toast(msg) {
  const old = $('.toast');
  if (old) old.remove();
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2400);
}

const VIEWS = ['home', 'library', 'search', 'diag', 'about'];
const viewStack = []; // 视图历史，返回按钮用
function showView(v, opts) {
  if (!VIEWS.includes(v)) v = 'library';
  if (S.view && S.view !== v && !(opts && opts.noHistory)) {
    viewStack.push(S.view);
    if (viewStack.length > 30) viewStack.shift();
  }
  S.view = v;
  VIEWS.forEach((id) => { const el = $('#view-' + id); if (el) el.hidden = id !== v; });
  $$('.nav-item').forEach((n) => n.classList.toggle('on', n.dataset.view === v));
  const back = $('#backBtn');
  if (back) back.classList.toggle('dim', viewStack.length === 0);
}
// 返回上一视图；没有历史时提示
function goBack() {
  const prev = viewStack.pop();
  if (!prev) { toast('已经在最上层了'); return; }
  showView(prev, { noHistory: true });
}

// ---------------------------------------------------------------- 输入识别
// 支持三种输入：关键词 / BV 号、av 号 / B 站链接（含 b23.tv 短链）
// 链接里的分 P 序号：https://.../BVxxx/?p=3
function pageFromUrl(u) {
  const m = String(u || '').match(/[?&]p=(\d{1,4})/i);
  return m ? +m[1] : 0;
}

function parseInput(raw) {
  const s = (raw || '').trim();
  if (!s) return null;
  if (/b23\.tv/i.test(s) || /bilibili\.com/i.test(s) || /^https?:\/\//i.test(s)) {
    return { type: 'url', value: s, page: pageFromUrl(s) };
  }
  const bv = s.match(/BV[0-9A-Za-z]{10}/);
  if (bv) return { type: 'bvid', value: bv[0], page: pageFromUrl(s) };
  const av = s.match(/\bav(\d+)\b/i) || s.match(/^(\d{5,})$/);
  if (av) return { type: 'aid', value: av[1], page: pageFromUrl(s) };
  return { type: 'keyword', value: s, page: 0 };
}

// 从最终 URL 里提取视频 id（含分 P 序号）
function idFromUrl(u) {
  const page = pageFromUrl(u);
  const bv = u.match(/BV[0-9A-Za-z]{10}/);
  if (bv) return { type: 'bvid', value: bv[0], page };
  const av = u.match(/\/video\/av(\d+)/i) || u.match(/[?&]aid=(\d+)/i);
  if (av) return { type: 'aid', value: av[1], page };
  return null;
}

// ---------------------------------------------------------------- 初始化
async function init() {
  mark('init 开始');
  const lib = await B.getLibrary();
  mark('收藏数据已返回');
  if (lib?.folders?.length) {
    S.folders = lib.folders;
    S.active = lib.active && S.folders.some((f) => f.id === lib.active) ? lib.active : S.folders[0].id;
  } else {
    S.folders = [{ id: 'f1', name: '我的歌单', items: [] }];
    S.active = 'f1';
    save();
  }
  // 播放列表：上次退出时的队列，恢复但不自动播放
  S.queue = Array.isArray(lib?.queue) ? lib.queue.filter((x) => x && x.bvid) : [];
  S.qcur = Number.isInteger(lib?.qcur) && lib.qcur < S.queue.length ? lib.qcur : -1;
  S.history = Array.isArray(lib?.history) ? lib.history.filter((x) => x && x.bvid).slice(0, 24) : [];
  audio.volume = 0.8; // 仍是 80%，滑块位置按曲线反推（约 89）
  $('#vol').value = posFromVol(0.8);
  renderFolders();
  renderList();
  renderQueue();
  showView('home', { noHistory: true }); // 默认进首页
  renderHome();
  mark('首屏渲染完成');
  setTimeout(checkLogin, 350); // 登录状态走网络，错开首屏渲染
  setTimeout(migrateOldPartItems, 1200); // 旧多P条目（黑帧封面/序号标题）后台静默修复
  setTimeout(loadHot, 800); // 热门推荐走网络，错开首屏
}

const LOGO_SRC = '../assets/icon.png';
let accountState = { logged: false };

async function checkLogin() {
  const av = $('#avatarImg');
  let st;
  try {
    st = await B.loginState();
  } catch (e) {
    st = { logged: false, stale: true };
  }
  if (st.logged) {
    av.onerror = () => { av.onerror = null; av.src = LOGO_SRC; };
    av.src = st.face || LOGO_SRC;
    av.title = (st.name || '已登录') + ' · 点按打开账号菜单';
    accountState = { logged: true, st };
  } else if (st.stale) {
    av.src = LOGO_SRC;
    av.title = '登录状态检查失败 · 点按重试';
    accountState = { logged: false, stale: true };
  } else {
    av.src = LOGO_SRC;
    av.title = '未登录 · 点按登录';
    accountState = { logged: false };
  }
}

// ---------------------------------------------------------------- 账号菜单
const AM_ICONS = {
  setting:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>',
  update:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"></path><path d="M21 3v6h-6"></path></svg>',
  diag: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12h-4l-3 9L9 3l-3 9H2"></path></svg>',
  about:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><path d="M12 16v-4"></path><path d="M12 8h.01"></path></svg>',
  logout:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path><path d="M16 17l5-5-5-5"></path><path d="M21 12H9"></path></svg>',
  login:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"></rect><rect x="14" y="3" width="7" height="7" rx="1"></rect><rect x="14" y="14" width="7" height="7" rx="1"></rect><path d="M3 14h4v4"></path><path d="M10 21h4"></path></svg>',
};

function amItem(icon, label, act, danger) {
  return `<div class="am-item ${danger ? 'danger' : ''}" data-act="${act}">${icon}<span>${label}</span></div>`;
}

function openAccountMenu() {
  const m = $('#accountMenu');
  const head = $('#amHead');
  if (accountState.logged) {
    const st = accountState.st;
    head.innerHTML = `<img src="${esc(st.face || '')}" />
      <div><div class="h-name">${esc(st.name || '已登录')}</div><div class="h-sub">B 站等级 Lv${st.level ?? '-'}</div></div>`;
  } else if (accountState.stale) {
    head.innerHTML = `<img class="logo-avatar" src="${LOGO_SRC}" alt="" />
      <div><div class="h-name">登录状态检查失败</div><div class="h-sub">网络或接口暂时不可用</div></div>`;
  } else {
    head.innerHTML = `<img class="logo-avatar" src="${LOGO_SRC}" alt="" />
      <div><div class="h-name">未登录</div><div class="h-sub">登录后可解锁更高音质</div></div>`;
  }
  const rows = [
    amItem(AM_ICONS.setting, '设置', 'settings'),
    amItem(AM_ICONS.update, '检查更新', 'update'),
    amItem(AM_ICONS.diag, '诊断', 'diag'),
    amItem(AM_ICONS.about, '关于', 'about'),
    '<div class="am-sep"></div>',
    accountState.logged
      ? amItem(AM_ICONS.logout, '退出登录', 'logout', true)
      : amItem(AM_ICONS.login, '扫码登录', 'login'),
  ];
  $('#amItems').innerHTML = rows.join('');
  $('#amItems')
    .querySelectorAll('.am-item')
    .forEach((el) => {
      el.onclick = async () => {
        m.hidden = true;
        const act = el.dataset.act;
        if (act === 'diag' || act === 'about') showView(act);
        else if (act === 'settings') openSettings();
        else if (act === 'login') openLogin();
        else if (act === 'logout') {
          await B.logout();
          toast('已退出登录');
          checkLogin();
        } else if (act === 'update') {
          showView('about');
          doCheck(false);
        }
      };
    });
  m.hidden = false;
}

// ---------------------------------------------------------------- 首页
// 最近播放：记录最近播过的曲目（含分 P），首页与「继续播放」都用它
function pushHistory(it) {
  if (!it || !it.bvid) return;
  const key = itemKey(it);
  S.history = S.history.filter((x) => itemKey(x) !== key);
  S.history.unshift({
    bvid: it.bvid, cid: it.cid, page: it.page || 1, title: it.title,
    up: it.up || it.author || '', cover: it.cover || '', duration: it.duration || 0,
    vtitle: it.vtitle || '',
  });
  S.history = S.history.slice(0, 24);
  save();
}

function renderHomeHero() {
  const last = S.history[0];
  const box = $('#homeHero');
  if (!last) {
    box.innerHTML = `<div>
      <div class="hh-t">还没有播放记录</div>
      <div class="hh-u">在上方搜索框找首歌，或点下面的热门推荐试试</div>
    </div>`;
    return;
  }
  box.innerHTML = `<img src="${esc(last.cover || '')}" />
    <div>
      <div class="hh-t">继续播放：${esc(last.title)}</div>
      <div class="hh-u">${esc(last.up || '')}</div>
    </div>
    <div class="hh-r">
      <button id="heroPlay">继续播放</button>
    </div>`;
  $('#heroPlay').onclick = async () => {
    const i = S.queue.findIndex((x) => itemKey(x) === itemKey(last));
    if (i >= 0) {
      await playQueueAt(i);
    } else {
      loadQueue([last], 0); // 队列里没有就把它排在最前面播
      await playQueueAt(0);
    }
  };
}

// 热门条目（搜索结果格式）→ 可入队列的曲目对象
function hotToItem(r) {
  return {
    bvid: r.bvid, cid: r.cid || 0, page: 1, title: r.title, vtitle: r.title,
    up: r.author || '', cover: r.pic || '', duration: r.duration || 0,
  };
}

function cardHtml(o, opts) {
  const cover = o.cover || o.pic || ''; // 热门条目的封面字段叫 pic
  const badge = o.duration ? `<span class="hc-badge">${fmtDur(o.duration)}</span>` : '';
  return `<div class="hcard" data-idx="${opts.idx}" data-kind="${opts.kind}"
      title="${esc(o.title)}">
    ${cover
      ? `<img class="hc-cover" src="${esc(cover)}" loading="lazy" />`
      : `<div class="hc-folder">♫</div>`}
    ${badge}
    <div class="hc-acts">
      <button data-act="play" title="播放">▶</button>
      <button data-act="queue" title="加入播放列表">＋</button>
      ${opts.kind === 'hot' ? '<button data-act="add" title="加入收藏夹">♥</button>' : ''}
    </div>
    <div class="hc-t">${esc(o.title)}</div>
    <div class="hc-u">${esc(opts.sub || '')}</div>
  </div>`;
}

async function renderHome() {
  renderHomeHero();

  // 最近播放（最多 8 个）
  $('#homeRecent').innerHTML = S.history.length
    ? S.history.slice(0, 8)
        .map((it, i) => cardHtml(it, {
          idx: i, kind: 'recent',
          sub: it.up || '',
        }))
        .join('')
    : '<div class="muted">还没有播放记录</div>';
  bindHomeCards($('#homeRecent'), 'recent');

  // 我的收藏夹
  $('#homeFolders').innerHTML = S.folders.length
    ? S.folders.map((f, i) => cardHtml(
        { title: f.name, cover: (f.items[0] || {}).cover || '', duration: 0 },
        { idx: i, kind: 'folder', sub: `${f.items.length} 首` }
      )).join('')
    : '<div class="muted">还没有收藏夹</div>';
  bindHomeCards($('#homeFolders'), 'folder');

  if (S.hot.length) renderHotCards(); // 已拿到过就直接画，避免每次切首页都空白
}

function bindHomeCards(box, kind) {
  box.querySelectorAll('.hcard').forEach((el) => {
    const i = +el.dataset.idx;
    el.onclick = async (e) => {
      const act = e.target.dataset.act;
      if (act) {
        e.stopPropagation();
        if (kind === 'folder') {
          S.active = S.folders[i].id;
          save(); renderFolders(); renderList(); showView('library');
          return;
        }
        if (kind === 'recent') {
          const it = S.history[i];
          if (act === 'play') { loadQueue([it], 0); playQueueAt(0); }
          else qToastAdd([it]);
          return;
        }
        // 热门：按搜索结果处理（多 P 会自动弹分 P 面板）
        const r = S.hot[i];
        if (!r) return;
        if (act === 'add') { await addToFolder(r); return; }
        if (act === 'queue') { qToastAdd([hotToItem(r)]); return; }
        await playSearchItem(r);
        return;
      }
      // 卡片本体
      if (kind === 'recent') { loadQueue([S.history[i]], 0); playQueueAt(0); }
      else if (kind === 'folder') {
        S.active = S.folders[i].id;
        save(); renderFolders(); renderList(); showView('library');
      } else {
        const r = S.hot[i];
        if (r) await playSearchItem(r);
      }
    };
  });
}

function renderHotCards() {
  const box = $('#homeHot');
  box.innerHTML = S.hot.length
    ? S.hot.map((it, i) => cardHtml(it, {
        idx: i, kind: 'hot',
        sub: `${it.author || ''} · ${fmtPlay(it.play)}播放`,
      })).join('')
    : '<div class="muted">暂时没有拿到热门列表</div>';
  bindHomeCards(box, 'hot');
}

async function loadHot() {
  try {
    const r = await B.hot();
    S.hot = r.list || [];
  } catch (e) {
    S.hot = [];
    $('#homeHot').innerHTML = `<div class="muted">热门列表加载失败：${esc(e.message || '')}</div>`;
    return;
  }
  renderHotCards();
}

// ---------------------------------------------------------------- 删除确认
// 删除是不可撤销的，统一走确认弹窗，避免手滑点掉歌单或整组多 P
let confirmResolve = null;
function askConfirm(title, desc, okText = '删除') {
  const m = $('#confirmModal');
  $('#cfTitle').textContent = title;
  $('#cfDesc').textContent = desc || '';
  $('#cfOk').textContent = okText;
  m.hidden = false;
  return new Promise((res) => { confirmResolve = res; });
}
function closeConfirm(v) {
  $('#confirmModal').hidden = true;
  const r = confirmResolve;
  confirmResolve = null;
  if (r) r(v);
}
$('#cfOk').onclick = () => closeConfirm(true);
$('#cfCancel').onclick = () => closeConfirm(false);
$('#confirmModal').onclick = (e) => {
  if (e.target.id === 'confirmModal') closeConfirm(false);
};

// ---------------------------------------------------------------- 渲染
function renderFolders() {
  $('#folders').innerHTML = S.folders
    .map(
      (f) => `<div class="folder ${f.id === S.active ? 'on' : ''}" data-id="${f.id}">
        <span class="name">${esc(f.name)}</span>
        <span><span class="cnt">${f.items.length}</span>${
          S.folders.length > 1 ? `<span class="del" data-del="${f.id}">×</span>` : ''
        }</span></div>`
    )
    .join('');
  $$('#folders .folder').forEach((el) => {
    el.onclick = async (e) => {
      const del = e.target.dataset.del;
      if (del) {
        const f = S.folders.find((x) => x.id === del);
        if (!f) return;
        const n = f.items.length;
        const ok = await askConfirm(
          '删除收藏夹',
          `「${f.name}」${n ? `及其中的 ${n} 首歌` : ''}将被删除，删除后无法恢复。`,
          '删除收藏夹'
        );
        if (!ok) return;
        S.folders = S.folders.filter((x) => x.id !== del);
        if (S.active === del) S.active = S.folders[0].id;
        save(); renderFolders(); renderList(); showView('library');
        toast(`已删除收藏夹「${f.name}」`);
        return;
      }
      S.active = el.dataset.id;
      save(); renderFolders(); renderList(); showView('library');
    };
  });
}

function rowHtml(it, i, extra) {
  const pg = +it.page || 1;
  // 多 P 视频的分 P 条目：标题前带 P 号徽标，悬浮提示所属视频
  const badge = pg > 1 || (it.vtitle && it.vtitle !== it.title) ? `<span class="ptag">P${pg}</span>` : '';
  return `<div class="row ${extra || ''} ${i === S.cur ? 'on' : ''}" data-i="${i}" title="${esc(it.vtitle || it.title)}">
    <img src="${esc(it.cover || '')}" loading="lazy" />
    <div class="meta">
      <div class="t">${badge}${esc(it.title)}</div>
      <div class="u">${esc(it.up || it.author || '')} · ${fmtDur(it.duration)}</div>
    </div>
    <div class="acts">
      <button data-play="${i}">播放</button>
      <button data-rm="${i}">移除</button>
    </div></div>`;
}

// 多 P 条目合并/展开：折叠状态记在 localStorage（按视频 bvid）
function collapsedSet() {
  try { return new Set(JSON.parse(localStorage.collapsedVideos || '[]')); }
  catch (e) { return new Set(); }
}
function toggleCollapsed(bvid) {
  const s = collapsedSet();
  if (s.has(bvid)) s.delete(bvid); else s.add(bvid);
  localStorage.collapsedVideos = JSON.stringify([...s]);
  renderList();
}

// 多 P 分组的「总行」：收起时就是唯一可见的一行，展开时是组头
function groupHtml(f, start, count, collapsed) {
  const it = f.items[start];
  const vtitle = it.vtitle || it.title;
  const total = f.items.slice(start, start + count).reduce((s, x) => s + (+x.duration || 0), 0);
  return `<div class="row group${collapsed ? '' : ' open'}" data-bvid="${esc(it.bvid)}" data-start="${start}" data-count="${count}"
    title="${esc(vtitle)}（共 ${count} 个分 P，点击${collapsed ? '展开' : '收起'}）">
    <div class="gcover">
      <img src="${esc(it.cover || '')}" loading="lazy" />
      <span class="gnum">${count}P</span>
    </div>
    <div class="meta">
      <div class="t"><span class="gtag">合集 ${count}P</span>${esc(vtitle)}</div>
      <div class="u">${esc(it.up || '')} · 共 ${fmtTotal(total)} · 点击${collapsed ? '展开全部' : '收起'}</div>
    </div>
    <span class="garrow">${collapsed ? '▸' : '▾'}</span>
    <div class="acts">
      <button data-gplay="${start}">播放</button>
      <button data-grm="${start}" data-count="${count}">移除</button>
    </div></div>`;
}

function renderList() {
  const f = folder();
  $('#libTitle').textContent = f.name;
  $('#libCount').textContent = `${f.items.length} 首`;
  if (!f.items.length) {
    $('#list').innerHTML = '<div class="empty">这个收藏夹还是空的，去上方搜索框找几首加进来</div>';
    return;
  }
  // 相邻的同视频多 P 条目聚成一组：可合并成一行，也可展开
  const collapsed = collapsedSet();
  const isPart = (it) => !!it.vtitle || (+it.page || 1) > 1;
  let html = '';
  let i = 0;
  while (i < f.items.length) {
    const it = f.items[i];
    let j = i + 1;
    if (isPart(it)) {
      while (j < f.items.length && f.items[j].bvid === it.bvid && isPart(f.items[j])) j++;
    }
    if (j - i === 1) {
      html += rowHtml(it, i);
    } else {
      const bid = it.bvid;
      html += groupHtml(f, i, j - i, collapsed.has(bid));
      if (!collapsed.has(bid)) {
        for (let k = i; k < j; k++) html += rowHtml(f.items[k], k, 'child');
      }
    }
    i = j;
  }
  $('#list').innerHTML = html;
  const rmItems = (start, cnt) => {
    f.items.splice(start, cnt);
    if (S.cur >= start && S.cur < start + cnt) S.cur = -1;
    else if (S.cur >= start + cnt) S.cur -= cnt;
    save(); renderFolders(); renderList();
  };
  $$('#list .row').forEach((el) => {
    const i = +el.dataset.i;
    const gp = el.dataset.gplay;
    const grm = el.dataset.grm;
    const isGroup = el.dataset.bvid !== undefined;
    el.onclick = async (e) => {
      if (e.target.dataset.rm !== undefined) {
        const it = f.items[+e.target.dataset.rm];
        const ok = await askConfirm('从收藏夹移除', `「${it.title}」将从「${f.name}」移除。`, '移除');
        if (!ok) return;
        f.items.splice(+e.target.dataset.rm, 1);
        if (S.cur >= f.items.length) S.cur = -1;
        save(); renderFolders(); renderList();
        toast('已移除');
        return;
      }
      if (e.target.dataset.play !== undefined) {
        e.stopPropagation();
        playIndex(+e.target.dataset.play);
        return;
      }
      if (gp !== undefined) {
        e.stopPropagation();
        playIndex(+gp);
        return;
      }
      if (grm !== undefined) {
        e.stopPropagation();
        const cnt = +el.dataset.count;
        const vtitle = f.items[+grm].vtitle || f.items[+grm].title;
        const ok = await askConfirm(
          '移除全部分 P',
          `「${vtitle}」的 ${cnt} 首歌将一起从「${f.name}」移除。`,
          `移除 ${cnt} 首`
        );
        if (!ok) return;
        rmItems(+grm, cnt);
        toast(`已移除 ${cnt} 首`);
        return;
      }
      if (isGroup) { toggleCollapsed(el.dataset.bvid); return; }
      playIndex(i);
    };
    el.oncontextmenu = (e) => {
      e.preventDefault();
      if (isGroup) {
        const bid = el.dataset.bvid;
        const start = +el.dataset.start;
        const cnt = +el.dataset.count;
        showCtxMenu(e.clientX, e.clientY, [
          { label: collapsed.has(bid) ? '展开全部 P' : '收起', action: () => toggleCollapsed(bid) },
          { label: '播放', action: () => playIndex(start) },
          { label: '在浏览器打开 B 站页面', action: () => B.openExternal('https://www.bilibili.com/video/' + bid) },
          { label: '复制视频链接', action: () => { B.copyText('https://www.bilibili.com/video/' + bid); toast('链接已复制'); } },
          { label: '移除全部', action: async () => {
              const vtitle = f.items[start].vtitle || f.items[start].title;
              const ok = await askConfirm(
                '移除全部分 P',
                `「${vtitle}」的 ${cnt} 首歌将一起从「${f.name}」移除。`,
                `移除 ${cnt} 首`
              );
              if (!ok) return;
              rmItems(start, cnt);
              toast(`已移除 ${cnt} 首`);
            } },
        ]);
        return;
      }
      const it = f.items[i];
      showCtxMenu(e.clientX, e.clientY, [
        { label: '播放', action: () => playIndex(i) },
        { label: '加入播放列表', action: () => qToastAdd([it]) },
        { label: '该视频的全部分 P…', action: () => openPartsOfVideo(it.bvid) },
        { label: '在浏览器打开 B 站页面', action: () => B.openExternal('https://www.bilibili.com/video/' + it.bvid) },
        { label: '复制视频链接', action: () => { B.copyText('https://www.bilibili.com/video/' + it.bvid); toast('链接已复制'); } },
        { label: '从歌单移除', action: async () => {
            const ok = await askConfirm('从收藏夹移除', `「${it.title}」将从「${f.name}」移除。`, '移除');
            if (!ok) return;
            f.items.splice(i, 1);
            if (S.cur >= f.items.length) S.cur = -1;
            save(); renderFolders(); renderList();
            toast('已移除');
          } },
      ]);
    };
  });
}

function renderResults(append = false) {
  const html = S.results.map((r, i) => {
    const playTxt = r.play != null && r.play !== '' ? ` · ${fmtPlay(r.play)}播放` : '';
    const ptag = r.partsCount > 1 ? `<span class="gtag">合集 ${r.partsCount}P</span>` : '';
    return `<div class="row" data-i="${i}">
      <img src="${r.pic}" loading="lazy" />
      <div class="meta">
        <div class="t">${ptag}${esc(r.title)}</div>
        <div class="u">${esc(r.author || '')} · ${fmtDur(r.duration)}${playTxt}</div>
      </div>
      <div class="acts">
        <button data-play="${i}">播放</button>
        <button data-add="${i}">加入</button>
      </div></div>`;
  }).join('');
  $('#results').innerHTML = append ? $('#results').innerHTML + html : html;
  $('#moreWrap').hidden = !S.hasMore;
  $$('#results .row').forEach((el) => {
    const i = +el.dataset.i;
    el.onclick = async (e) => {
      if (e.target.dataset.add !== undefined) {
        e.stopPropagation();
        await addToFolder(S.results[i]);
        return;
      }
      await playSearchItem(S.results[i]);
    };
    el.oncontextmenu = (e) => {
      e.preventDefault();
      const r = S.results[i];
      showCtxMenu(e.clientX, e.clientY, [
        { label: '播放', action: () => playSearchItem(r) },
        { label: '加入收藏夹', action: () => addToFolder(r) },
      { label: '加入播放列表', action: () => qToastAdd([{
        bvid: r.bvid, page: r.page || 1, title: r.title, vtitle: r.title,
        up: r.author, cover: r.pic, duration: r.duration,
      }]) },
      { label: '选择分 P / 合辑…', action: () => pickParts(r) },
        { label: '在浏览器打开 B 站页面', action: () => B.openExternal('https://www.bilibili.com/video/' + r.bvid) },
        { label: '复制视频链接', action: () => { B.copyText('https://www.bilibili.com/video/' + r.bvid); toast('链接已复制'); } },
      ]);
    };
  });
}

// ---------------------------------------------------------------- 右键菜单
let ctxEl = null;
function closeCtx() {
  if (ctxEl) { ctxEl.remove(); ctxEl = null; }
}
function showCtxMenu(x, y, items) {
  closeCtx();
  ctxEl = document.createElement('div');
  ctxEl.className = 'ctx';
  ctxEl.innerHTML = items.map((it, i) => `<div class="ctx-item" data-i="${i}">${esc(it.label)}</div>`).join('');
  document.body.appendChild(ctxEl);
  const rect = ctxEl.getBoundingClientRect();
  ctxEl.style.left = Math.max(4, Math.min(x, window.innerWidth - rect.width - 8)) + 'px';
  ctxEl.style.top = Math.max(4, Math.min(y, window.innerHeight - rect.height - 8)) + 'px';
  ctxEl.addEventListener('click', (e) => {
    const i = +e.target.dataset.i;
    if (items[i]) items[i].action();
    closeCtx();
  });
  const onDown = (e) => { if (ctxEl && !ctxEl.contains(e.target)) closeCtx(); };
  window.addEventListener('mousedown', onDown, { once: true });
  window.addEventListener('blur', closeCtx, { once: true });
  window.addEventListener('wheel', closeCtx, { once: true, passive: true });
}

// ---------------------------------------------------------------- 搜索
async function handleSearch() {
  const raw = $('#kw').value.trim();
  if (!raw) return;
  const p = parseInput(raw);
  if (p.type === 'keyword') return doSearch(1);

  showView('search');
  $('#moreWrap').hidden = true;
  $('#results').innerHTML = '<div class="empty">识别到视频链接，解析中…</div>';
  try {
    let id = p;
    if (p.type === 'url') {
      const final = await B.resolve(p.value);
      id = idFromUrl(final);
      if (!id) throw new Error('链接里没有识别到视频 ID');
    }
    const meta = await B.video(id.value);
    const parts = meta.parts || [];
    S.results = [{
      bvid: meta.bvid,
      title: meta.title,
      author: meta.up,
      pic: meta.cover,
      duration: meta.duration,
      play: meta.play,
      page: id.page || 0,
      partsCount: parts.length,
      meta,
    }];
    S.hasMore = false;
    renderResults();
    if (parts.length > 1) {
      openPartsPicker(meta, { only: id.page || 0 });
      toast(`识别到 ${parts.length} 个分 P`);
    } else {
      toast('已识别视频');
    }
  } catch (e) {
    $('#results').innerHTML = `<div class="empty">解析失败：${esc(e.message)}</div>`;
  }
}

async function doSearch(page = 1, append = false) {
  const kw = $('#kw').value.trim();
  if (!kw) return;
  S.kw = kw;
  S.page = page;
  if (!append) {
    $('#results').innerHTML = '<div class="empty">搜索中…</div>';
    showView('search');
  }
  try {
    const r = await B.search(kw, page);
    S.results = append ? S.results.concat(r.list) : r.list;
    S.hasMore = r.hasMore;
    if (!S.results.length) $('#results').innerHTML = '<div class="empty">没有找到结果</div>';
    else renderResults(append);
  } catch (e) {
    $('#results').innerHTML = `<div class="empty">搜索失败：${esc(e.message)}</div>`;
  }
}

// ---------------------------------------------------------------- 分 P / 合集选择面板
// 一个视频可能有几十上百个 P，每个 P 是独立的一首歌，必须能逐个选、逐个加入
let pmMeta = null;      // 当前视频信息（含 parts / season）
let pmMode = 'parts';   // parts | season
let pmWantPlay = false; // 加入后是否立即播放

const itemKey = (it) => it.bvid + ':' + (+it.page || 1);

function pmEntries() {
  if (pmMode === 'season' && pmMeta.season) {
    return (pmMeta.season.episodes || []).map((ep, i) => ({
      key: ep.bvid + ':' + (ep.page || 1),
      no: String(i + 1),
      name: ep.title || ('第 ' + (i + 1) + ' 集'),
      duration: ep.duration || 0,
      bvid: ep.bvid, cid: ep.cid, page: ep.page || 1,
      cover: ep.cover || pmMeta.cover, up: ep.up || pmMeta.up,
      vtitle: pmMeta.season.title,
    }));
  }
  const multi = (pmMeta.parts || []).length > 1;
  return (pmMeta.parts || []).map((p) => ({
    key: pmMeta.bvid + ':' + p.page,
    no: 'P' + p.page,
    name: multi ? p.part || ('P' + p.page) : pmMeta.title,
    duration: p.duration || 0,
    bvid: pmMeta.bvid, cid: p.cid, page: p.page,
    cover: p.cover || pmMeta.cover, up: pmMeta.up,
    vtitle: pmMeta.title,
  }));
}

function fmtTotal(sec) {
  const s = Math.max(0, Math.round(sec || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h} 小时 ${m} 分` : `${m} 分`;
}

function pmSelectedKeys() {
  return Array.from($$('#pmList .part-row'))
    .filter((el) => el.querySelector('input').checked)
    .map((el) => el.dataset.key);
}

function pmUpdateSum() {
  const keys = new Set(pmSelectedKeys());
  const all = pmEntries();
  const sec = all.filter((e) => keys.has(e.key)).reduce((s, e) => s + (e.duration || 0), 0);
  $('#pmSum').textContent = `已选 ${keys.size} 首 · ${fmtTotal(sec)}`;
  $('#pmAdd').disabled = !keys.size;
  $('#pmPlay').disabled = !keys.size;
  $('#pmPlayOnly').disabled = !keys.size;
}

function pmRenderList() {
  const all = pmEntries();
  const inLib = new Set((folder() ? folder().items : []).map(itemKey));
  $('#pmList').innerHTML = all
    .map(
      (e) => `<label class="part-row${inLib.has(e.key) ? ' in-lib' : ''}" data-key="${esc(e.key)}">
        <input type="checkbox" ${inLib.has(e.key) ? '' : 'checked'} />
        <span class="pno">${esc(e.no)}</span>
        <span class="pname">${esc(e.name)}${inLib.has(e.key) ? '<i class="padded">已在歌单</i>' : ''}</span>
        <span class="ptime">${fmt(e.duration)}</span>
      </label>`
    )
    .join('');
  $('#pmList').querySelectorAll('.part-row').forEach((el) => {
    el.querySelector('input').onchange = pmUpdateSum;
  });
  pmUpdateSum();
}

function openPartsPicker(meta, opts = {}) {
  pmMeta = meta;
  pmWantPlay = !!opts.play;
  pmMode = opts.mode || 'parts';
  const parts = meta.parts || [];
  const multi = parts.length > 1;
  $('#pmTitle').textContent = meta.title;
  const total = parts.reduce((s, p) => s + (p.duration || 0), 0);
  $('#pmSub').textContent = multi
    ? `共 ${parts.length} 个分 P · 总时长 ${fmtTotal(total)}`
    : `单 P 视频 · ${fmtTotal(meta.duration)}`;
  const sw = $('#pmSwitch');
  if (meta.season && meta.season.episodes && meta.season.episodes.length > 1 && meta.parts) {
    sw.hidden = false;
    sw.textContent = pmMode === 'parts'
      ? `合辑《${meta.season.title}》共 ${meta.season.episodes.length} 个视频 ›`
      : `‹ 回到分 P（${parts.length} P）`;
  } else {
    sw.hidden = true;
  }
  $('#partsModal').hidden = false;
  pmRenderList();
  // 链接里带了 ?p=N 时只选那一 P，并把列表滚到该处
  const only = +opts.only || 0;
  if (only > 0) {
    $$('#pmList .part-row').forEach((el) => {
      const on = el.querySelector('.pno').textContent === 'P' + only;
      el.querySelector('input').checked = on;
    });
    pmUpdateSum();
    const hit = $('#pmList .part-row[data-key="' + meta.bvid + ':' + only + '"]');
    if (hit) hit.scrollIntoView({ block: 'center' });
  }
}

function closePartsPicker() {
  $('#partsModal').hidden = true;
  pmMeta = null;
}

// action: 'play' 仅播放（不动收藏夹） | 'add' 加入歌单 | 'addplay' 加入并播放
async function pmCommit(action) {
  const keys = new Set(pmSelectedKeys());
  if (!keys.size) return toast('至少选一个分 P');
  const all = pmEntries()
    .filter((e) => keys.has(e.key))
    .map((e) => ({
      bvid: e.bvid, cid: e.cid, page: e.page,
      title: e.name, vtitle: e.vtitle || e.name,
      up: e.up, cover: e.cover, duration: e.duration,
    }));
  closePartsPicker();

  if (action === 'play') {
    // 仅播放：只放进播放列表，收藏夹一个字都不动
    loadQueue(all, 0);
    await playQueueAt(0);
    toast(`${all.length} 首已进入播放列表（未加入收藏夹）`);
    return;
  }

  const f = folder();
  if (!f) return toast('先建一个收藏夹');
  let added = 0, dup = 0;
  for (const it of all) {
    if (f.items.some((x) => itemKey(x) === itemKey(it))) { dup++; continue; }
    f.items.push(it);
    added++;
  }
  save(); renderFolders(); renderList();
  toast(`已加入 ${added} 首到《${f.name}》${dup ? `（${dup} 首已存在，已跳过）` : ''}`);

  if (action === 'addplay') {
    if (!added && !dup) return;
    showView('library');
    const f2 = folder();
    let idx = f2.items.findIndex((x) => keys.has(itemKey(x)));
    if (idx < 0) idx = 0;
    loadQueue(f2.items, idx); // 加入后从歌单续播
    await playQueueAt(idx);
  }
}

// 打开某个视频的全部分 P（歌单里某一首 → 补加同视频其它 P）
async function openPartsOfVideo(bvid, opts = {}) {
  try {
    toast('读取分 P 信息…');
    const meta = await B.video(bvid);
    openPartsPicker(meta, opts);
  } catch (e) {
    toast('读取失败：' + e.message);
  }
}

async function addToFolder(r) {
  try {
    const meta = (r.meta && r.meta.bvid === r.bvid) ? r.meta : await B.video(r.bvid);
    r.meta = meta;
    if ((meta.parts || []).length > 1) return openPartsPicker(meta, { only: r.page || 0 });
    const f = folder();
    const key = meta.bvid + ':1';
    if (f.items.some((x) => itemKey(x) === key)) return toast('已经在歌单里了');
    f.items.push({
      bvid: meta.bvid, cid: meta.cid, page: 1, title: meta.title, vtitle: meta.title,
      up: meta.up, cover: meta.cover, duration: meta.duration,
    });
    save(); renderFolders(); renderList();
    toast(`已加入《${f.name}》`);
  } catch (e) {
    toast('加入失败：' + e.message);
  }
}

async function playSearchItem(r) {
  try {
    const meta = (r.meta && r.meta.bvid === r.bvid) ? r.meta : await B.video(r.bvid);
    r.meta = meta;
    if ((meta.parts || []).length > 1) {
      return openPartsPicker(meta, { only: r.page || 0, play: true });
    }
    // 单 P：只进播放列表，不动收藏夹
    loadQueue([{
      bvid: meta.bvid, cid: meta.cid, page: 1, title: meta.title, vtitle: meta.title,
      up: meta.up, cover: meta.cover, duration: meta.duration,
    }], 0);
    await playQueueAt(0);
    renderList();
  } catch (e) {
    toast('播放失败：' + e.message);
  }
}

// ---------------------------------------------------------------- 设置面板（居中悬浮卡片）
async function openSettings() {
  const m = $('#settingsModal');
  m.hidden = false;
  // 打开时同步一次真实状态，避免和主进程 / 底部按钮不一致
  $('#mediaKeys').checked = localStorage.mediaKeys !== '0';
  $('#closeAction').value = localStorage.closeToTray !== '0' ? 'tray' : 'quit';
  $('#autoCheck').checked = localStorage.autoCheck !== '0';
  $('#prefFlac').checked = localStorage.prefFlac === '1';
  $('#volumeBalance').checked = localStorage.volumeBalance !== '0';
  $('#lastCheck').textContent = localStorage.lastCheckAt || '从未';
  try {
    $('#autoLaunch').checked = !!(await B.getAutoLaunch());
  } catch (e) {
    $('#autoLaunch').checked = false;
  }
}
function closeSettings() {
  $('#settingsModal').hidden = true;
}

// 右键 / 入口：直接打开某个视频的分 P 面板
async function pickParts(r) {
  try {
    toast('读取分 P 信息…');
    const meta = (r && r.meta && r.meta.bvid === r.bvid) ? r.meta : await B.video(r.bvid);
    if (r) r.meta = meta;
    openPartsPicker(meta, { only: (r && r.page) || 0 });
  } catch (e) {
    toast('读取失败：' + e.message);
  }
}

// ---------------------------------------------------------------- 音量平衡（响度均衡）
// audio → MediaElementSource → DynamicsCompressor → Analyser → Gain → 输出
// 关闭时跳过压缩器直通；开启时按实测峰值给一个补偿增益，让各曲目响度趋于一致
let ac = null, srcNode = null, compNode = null, anNode = null, gainNode = null;
let agcTimer = null;

const balanceOn = () => localStorage.volumeBalance !== '0';

function ensureGraph() {
  if (ac) return ac;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  ac = new AC();
  srcNode = ac.createMediaElementSource(audio);
  compNode = ac.createDynamicsCompressor();
  compNode.threshold.value = -20;
  compNode.knee.value = 12;
  compNode.ratio.value = 6;
  compNode.attack.value = 0.005;
  compNode.release.value = 0.25;
  anNode = ac.createAnalyser();
  anNode.fftSize = 2048;
  gainNode = ac.createGain();
  gainNode.gain.value = 1;
  anNode.connect(gainNode);
  gainNode.connect(ac.destination);
  return ac;
}

function applyBalanceRouting() {
  if (!ensureGraph()) return;
  try { srcNode.disconnect(); } catch (e) { /* 首次还没连 */ }
  try { compNode.disconnect(); } catch (e) { /* 同上 */ }
  if (balanceOn()) {
    srcNode.connect(compNode);
    compNode.connect(anNode);
  } else {
    srcNode.connect(anNode);
  }
}

// 开播后采样约 5 秒，按峰值中位数算补偿增益（限制 0.6~2 倍，避免爆音）
function startAgc() {
  clearInterval(agcTimer);
  if (!balanceOn() || !anNode) return;
  if (gainNode) gainNode.gain.value = 1;
  const buf = new Uint8Array(anNode.fftSize);
  const peaks = [];
  let n = 0;
  agcTimer = setInterval(() => {
    if (audio.paused) return;
    anNode.getByteTimeDomainData(buf);
    let peak = 0;
    for (let i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i] - 128) / 128);
    if (peak > 0.02) peaks.push(peak);
    if (++n >= 12) {
      clearInterval(agcTimer);
      if (!peaks.length) return;
      peaks.sort((a, b) => a - b);
      const med = peaks[Math.floor(peaks.length / 2)];
      const g = Math.min(2, Math.max(0.6, 0.5 / med));
      gainNode.gain.setTargetAtTime(g, ac.currentTime, 0.4);
    }
  }, 400);
}

// ---------------------------------------------------------------- 播放列表（队列）
// 与收藏夹分离：只播放不入库的曲目放这里，连播 / 上一首 / 下一首都以它为准
function syncQueueBtn() {
  const btn = $('#qBtn');
  if (!btn) return;
  const n = S.queue.length;
  btn.classList.toggle('on', n > 0);
  const b = $('#qBadge');
  if (b) { b.textContent = n > 99 ? '99+' : String(n); b.hidden = !n; }
}

function renderQueue() {
  const box = $('#queueList');
  if (!box) return;
  if (!S.queue.length) {
    box.innerHTML =
      '<div class="q-empty">播放列表是空的<br/>播放任意歌曲会进入这里<br/>在分 P 面板里选「仅播放」可只播不入库</div>';
  } else {
    box.innerHTML = S.queue
      .map(
        (it, i) => `<div class="q-row ${i === S.qcur ? 'on' : ''}" data-i="${i}"
        title="${esc(it.vtitle || it.title)}">
        <img class="qcover" src="${esc(it.cover || '')}" loading="lazy" />
        <span class="qmeta">
          <span class="qt">${esc(it.title)}</span>
          <span class="qu">${esc(it.up || '')}</span>
        </span>
        <span class="qd">${fmtDur(it.duration)}</span>
        <button class="qx" data-x="${i}" title="从播放列表移除">×</button>
      </div>`
      )
      .join('');
    box.querySelectorAll('.q-row').forEach((el) => {
      el.onclick = (e) => {
        if (e.target.dataset.x !== undefined) {
          e.stopPropagation();
          removeFromQueue(+e.target.dataset.x);
          return;
        }
        playQueueAt(+el.dataset.i);
      };
    });
  }
  const info = $('#qInfo');
  if (info) {
    info.textContent = S.queue.length
      ? `共 ${S.queue.length} 首${S.qcur >= 0 ? ` · 第 ${S.qcur + 1} 首` : ''}`
      : '';
  }
  syncQueueBtn();
}

// 用一份曲目替换整个播放列表，并从 startIdx 开始（不自动播放）
function loadQueue(items, startIdx = -1) {
  S.queue = (items || []).map((it) => ({ ...it }));
  S.qcur = startIdx >= 0 && startIdx < S.queue.length ? startIdx : -1;
  save();
  renderQueue();
}

function appendQueue(items) {
  const keys = new Set(S.queue.map(itemKey));
  const add = (items || []).filter((it) => !keys.has(itemKey(it)));
  S.queue = S.queue.concat(add.map((it) => ({ ...it })));
  save();
  renderQueue();
  return add.length;
}

function removeFromQueue(i) {
  if (i < 0 || i >= S.queue.length) return;
  S.queue.splice(i, 1);
  if (S.qcur > i) S.qcur -= 1;
  else if (S.qcur === i) S.qcur = -1;
  save();
  renderQueue();
}

function clearQueue() {
  S.queue = [];
  S.qcur = -1;
  save();
  renderQueue();
}

// 右键「加入播放列表」
function qToastAdd(items) {
  const n = appendQueue(items);
  toast(n ? `已加入播放列表（${n} 首）` : '已经在播放列表里了');
}

// 播放列表里的第 i 首（同时同步收藏夹列表的高亮）
async function playQueueAt(i) {
  if (i < 0 || i >= S.queue.length) return;
  const it = S.queue[i];
  const f = folder();
  const idx = f ? f.items.findIndex((x) => itemKey(x) === itemKey(it)) : -1;
  await playTrack(it, idx);
  S.qcur = i;
  save();
  renderQueue();
}

// ---------------------------------------------------------------- 播放
async function playIndex(i) {
  const f = folder();
  if (i < 0 || i >= f.items.length) return;
  loadQueue(f.items, i); // 从收藏夹起播 = 整张歌单作为播放列表
  await playQueueAt(i);
}

// 取流策略：
//   无损优先 = 有 FLAC 就用 FLAC，没有就取能取到的最高音质
//   关闭     = B 站默认那一档（接口原始顺序第一条），不刻意挑最高
function pickTrack(p) {
  if (localStorage.prefFlac === '1') return p.flac || p.tracks[0];
  const defId = p.raw && p.raw.length ? p.raw[0].id : null;
  const def = defId != null ? p.tracks.find((t) => t.id === defId) : null;
  return def || p.tracks[p.tracks.length - 1];
}

// 按钮文字恒为「无损优先」，亮/不亮表达开关；真实码率只放进悬浮提示
let curKbps = 0;

// 老数据修复判定：缺 cid、封面还是分P黑帧（storyff）、或标题带「001.」序号前缀
function needsMetaFix(it) {
  return !it.cid
    || /storyff/.test(it.cover || '')
    || /^\s*\d{1,4}\s*[.\-—_、·]/.test(it.title || '');
}

async function ensureCid(it) {
  if (!needsMetaFix(it)) return it.cid;
  const meta = await B.video(it.bvid);
  const pg = +it.page || 1;
  const p = (meta.parts || []).find((x) => +x.page === pg);
  it.cid = (p && p.cid) || meta.cid;
  it.cover = meta.cover; // 统一用视频主封面，与首页一致
  if (p && p.part) it.title = p.part; // 已清洗过序号的分P名
  if (!it.up) it.up = meta.up;
  return it.cid;
}

// 启动后后台迁移：把旧版加入的多P条目（黑帧封面/带序号标题）批量修正
async function migrateOldPartItems() {
  const bad = new Set();
  const scan = (list) => (list || []).forEach((it) => { if (needsMetaFix(it)) bad.add(it.bvid); });
  S.folders.forEach((f) => scan(f.items));
  scan(S.queue);
  if (!bad.size) return;
  for (const bvid of bad) {
    try {
      const meta = await B.video(bvid);
      const fix = (it) => {
        if (it.bvid !== bvid || !needsMetaFix(it)) return;
        const p = (meta.parts || []).find((x) => +x.page === (+it.page || 1));
        it.cid = (p && p.cid) || meta.cid;
        it.cover = meta.cover;
        if (p && p.part) it.title = p.part;
        if (!it.up) it.up = meta.up;
      };
      S.folders.forEach((f) => f.items.forEach(fix));
      S.queue.forEach(fix);
    } catch (e) { /* 单个视频失败就跳过，下次启动再试 */ }
  }
  save();
  renderFolders();
  renderList();
  renderQueue();
}

async function playTrack(it, idx) {
  try {
    await ensureCid(it);
    const p = await B.playurl(it.bvid, it.cid);
    const track = pickTrack(p);
    if (idx !== undefined) S.cur = idx;
    audio.src = track.url;
    await audio.play();
    // 音频图要在真正播放后才建（首次播放有用户手势，AudioContext 才不会被挂起）
    applyBalanceRouting();
    if (ac && ac.state === 'suspended') await ac.resume().catch(() => {});
    startAgc(); // 每首歌重新测一次补偿增益
    $('#bCover').src = it.cover || '';
    $('#bTitle').textContent = it.title;
    $('#bUp').textContent = it.up || it.author || '';
    curKbps = track.kbps || 0;
    syncQualityBtn();
    pushHistory(it); // 记进最近播放，首页「继续播放」用它
    if (S.view === 'home') renderHome();
    $('#play').textContent = '⏸';
    B.setTrayTip(it.title); // 托盘悬停时显示当前曲目
    renderList();
    renderQueue();
  } catch (e) {
    toast('播放失败：' + e.message);
  }
}

// 上一首 / 下一首：优先走播放列表，没有队列时退回当前收藏夹
function step(d) {
  const q = S.queue;
  if (q.length) {
    let n;
    if (S.mode === 'shuffle') {
      n = Math.floor(Math.random() * q.length);
    } else {
      n = S.qcur + d;
      if (n >= q.length) n = 0;
      if (n < 0) n = q.length - 1;
    }
    return playQueueAt(n);
  }
  const f = folder();
  if (!f || !f.items.length) return;
  let n;
  if (S.mode === 'shuffle') {
    n = Math.floor(Math.random() * f.items.length);
  } else {
    n = S.cur + d;
    if (n >= f.items.length) n = 0;
    if (n < 0) n = f.items.length - 1;
  }
  playIndex(n);
}

// ---------------------------------------------------------------- 登录
let pollTimer;
async function openLogin() {
  $('#loginModal').hidden = false;
  $('#qrTip').textContent = '正在生成二维码…';
  $('#qr').removeAttribute('src');
  let key = null;
  try {
    const r = await B.loginQrcode();
    key = r.key;
    $('#qr').src = r.dataUrl;
    $('#qrTip').textContent = '请使用 B 站 App 扫码';
  } catch (e) {
    $('#qrTip').textContent = '二维码生成失败：' + e.message;
    return;
  }
  clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    try {
      const r = await B.loginPoll(key);
      if (r.status === 'scanned') $('#qrTip').textContent = '已扫描，请在手机上确认';
      if (r.status === 'expired') {
        clearInterval(pollTimer);
        $('#qrTip').textContent = '二维码已过期，请关闭后重新打开';
      }
      if (r.status === 'done') {
        clearInterval(pollTimer);
        $('#loginModal').hidden = true;
        toast('登录成功，音质已解锁');
        checkLogin();
      }
    } catch (e) {
      clearInterval(pollTimer);
      $('#qrTip').textContent = '登录检查失败：' + e.message;
    }
  }, 1500);
}

// ---------------------------------------------------------------- 诊断 / 关于
async function initDiag() {
  const env = await B.diagEnv();
  const rows = [
    ['应用版本', `${env.version}${env.logged ? ' · 已登录 B 站' : ' · 未登录'}`],
    ['运行时', `Electron ${env.electron} · Chromium ${env.chrome} · Node ${env.node}`],
    ['系统', `${env.platform} · OS build ${env.os}`],
    ['设备指纹', env.buvid3],
    ['数据目录', env.dataDir],
  ];
  $('#envRows').innerHTML = rows
    .map(([k, v]) => `<div class="row-line">
      <div class="rl-main"><b>${esc(k)}</b></div>
      <span class="muted" style="max-width:62%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(v)}">${esc(v)}</span>
    </div>`)
    .join('');
}

async function runDiag() {
  const bv = $('#diagBv').value.trim();
  if (!bv) return toast('先填一个 BV 号');
  $('#diagSteps').innerHTML = '<div class="diag-ok">测试中…</div>';
  try {
    const r = await B.diagApi(bv);
    $('#diagSteps').innerHTML = r.steps
      .map((s) => `<div class="step ${s.ok ? 'ok' : 'bad'}">
        <span class="mark">${s.ok ? '✓' : '×'}</span>
        <span class="sname">${esc(s.name)}</span>
        <span class="sdetail" title="${esc(s.detail)}">${esc(s.detail)}</span>
        <span class="sms">${s.ms}ms</span></div>`)
      .join('') +
      `<div class="diag-ok ${r.ok ? 'pass' : 'fail'}">${r.ok ? '全链路正常，可以正常播放' : '链路存在异常，参考上方失败步骤'}</div>`;
  } catch (e) {
    $('#diagSteps').innerHTML = `<div class="diag-ok fail">诊断执行失败：${esc(e.message)}</div>`;
  }
}

function renderUpdateBanner(el, r) {
  if (!el) return;
  el.hidden = false;
  el.innerHTML = `<div class="ub-main"><b>发现新版本 ${esc(r.latest)}</b>
      <span class="muted">当前版本 ${esc(r.current)}，前往 GitHub 下载安装包。</span></div>
    <div class="ub-actions"><button class="primary">前往下载</button></div>`;
  el.querySelector('button').onclick = () => B.openExternal(r.url);
}

function hideUpdateBanners() {
  $('#aboutUpdateBanner').hidden = true;
  $('#diagUpdateBanner').hidden = true;
}

function showUpdateMsg(text) {
  $('#updateResult').innerHTML = `<div class="ub-msg">${esc(text)}</div>`;
}

async function doCheck(silent = false) {
  const r = await B.checkUpdate();
  if (!r.ok) {
    if (!silent) showUpdateMsg('检查失败：' + r.error + `\n（仓库：${r.repo}）`);
    return r;
  }
  localStorage.lastCheckAt = new Date().toLocaleString('zh-CN');
  $('#lastCheck').textContent = localStorage.lastCheckAt;
  if (r.hasUpdate) {
    renderUpdateBanner($('#aboutUpdateBanner'), r);
    renderUpdateBanner($('#diagUpdateBanner'), r);
    if (!silent) showUpdateMsg(`发现新版本 v${r.latest}（当前 v${r.current}）\n\n${r.notes || '暂无发布说明'}`);
  } else {
    hideUpdateBanners();
    if (!silent) showUpdateMsg(`当前已是最新版本 v${r.current}`);
  }
  return r;
}

async function initAbout() {
  const env = await B.diagEnv();
  $('#aboutVer').textContent = 'v' + env.version;
  const sv = $('#setVer');
  if (sv) sv.textContent = 'v' + env.version;
  $('#relLink').onclick = () => B.openExternal('https://github.com/' + env.repo + '/releases');
}

// ---------------------------------------------------------------- 事件
$$('.nav-item').forEach((el) => {
  el.onclick = () => {
    showView(el.dataset.view);
    if (el.dataset.view === 'home') renderHome(); // 回到首页时刷新最近播放/收藏夹
  };
});

// 标题栏头像 → 二级菜单；点击菜单外自动收起
$('#avatarBtn').onclick = (e) => {
  e.stopPropagation();
  const m = $('#accountMenu');
  if (m.hidden) {
    if (accountState.stale) checkLogin();
    openAccountMenu();
  } else m.hidden = true;
};
document.addEventListener('click', (e) => {
  const m = $('#accountMenu');
  if (!m.hidden && !m.contains(e.target) && !$('#avatarBtn').contains(e.target)) {
    m.hidden = true;
  }
});

// 自绘标题栏的窗口控制
$('#wMin').onclick = () => B.winMin();
$('#wMax').onclick = () => B.winMaxToggle();
$('#wClose').onclick = () => B.winClose();

// 顶栏返回按钮：回上一视图
$('#backBtn').onclick = goBack;

// 全局媒体键 / 系统托盘菜单发来的播放指令
B.onMediaCmd((cmd) => {
  if (cmd === 'playPause') $('#play').click();
  else if (cmd === 'next') $('#next').click();
  else if (cmd === 'prev') $('#prev').click();
  else if (cmd === 'stop' && !audio.paused) $('#play').click();
});
// 首次同步一次开关状态给主进程（默认都开）
B.setMediaKeys(localStorage.mediaKeys !== '0');
B.setCloseToTray(localStorage.closeToTray !== '0');
B.getVersion().then((v) => { $('#sideVer').textContent = 'v' + v; });
$('#diagRun').onclick = runDiag;
$('#diagBv').onkeydown = (e) => { if (e.key === 'Enter') runDiag(); };
$('#openData').onclick = () => B.diagOpenData();
$('#exportDiag').onclick = async () => {
  const f = await B.diagExport();
  toast('已导出到桌面');
};
$('#checkBtn').onclick = () => doCheck(false);
$('#openSettingsBtn').onclick = openSettings;
$('#settingsClose').onclick = closeSettings;
$('#settingsModal').onclick = (e) => { if (e.target.id === 'settingsModal') closeSettings(); };
$('#volumeBalance').onchange = () => {
  const on = $('#volumeBalance').checked;
  localStorage.volumeBalance = on ? '1' : '0';
  applyBalanceRouting();
  if (on) {
    if (ac && ac.state === 'suspended') ac.resume().catch(() => {});
    startAgc();
  } else {
    clearInterval(agcTimer);
    if (gainNode && ac) gainNode.gain.setTargetAtTime(1, ac.currentTime, 0.2);
  }
  toast(on ? '已开启音量平衡' : '已关闭音量平衡');
};
$('#prefFlac').onchange = () => {
  const on = $('#prefFlac').checked;
  localStorage.prefFlac = on ? '1' : '0';
  syncQualityBtn();
  toast(on ? '已开启无损优先（下一首生效）' : '已关闭无损优先');
};
$('#autoCheck').onchange = () => {
  localStorage.autoCheck = $('#autoCheck').checked ? '1' : '0';
  toast($('#autoCheck').checked ? '已开启自动检查' : '已关闭自动检查');
};
$('#mediaKeys').onchange = () => {
  const on = $('#mediaKeys').checked;
  localStorage.mediaKeys = on ? '1' : '0';
  B.setMediaKeys(on);
  toast(on ? '已开启全局媒体键' : '已关闭全局媒体键');
};
$('#closeAction').onchange = () => {
  const tray = $('#closeAction').value === 'tray';
  localStorage.closeToTray = tray ? '1' : '0';
  B.setCloseToTray(tray);
  toast(tray ? '点 × 将缩到托盘继续播放' : '点 × 将直接退出程序');
};
$('#autoLaunch').onchange = async () => {
  const on = $('#autoLaunch').checked;
  const ok = await B.setAutoLaunch(on);
  $('#autoLaunch').checked = !!ok;
  toast(ok ? '已设置开机自启动' : '已取消开机自启动');
};
$('#quitBtn').onclick = () => {
  if (confirm('确定退出 ccMusic 吗？')) B.appQuit();
};

// 音质按钮：文字恒为「无损优先」，亮=已开启，不亮=已关闭
function syncQualityBtn() {
  const el = $('#quality');
  const on = localStorage.prefFlac === '1';
  el.classList.toggle('on', on);
  el.textContent = '无损优先';
  el.title = (audio.src && curKbps ? '当前 ' + curKbps + 'kbps · ' : '')
    + (on ? '已开启' : '已关闭') + ' · 点按切换';
}
syncQualityBtn();

$('#go').onclick = handleSearch;
$('#kw').onkeydown = (e) => { if (e.key === 'Enter') handleSearch(); };
$('#more').onclick = () => doSearch(S.page + 1, true);

// ---------------------------------------------------------------- 分 P 面板事件
$('#pmCancel').onclick = closePartsPicker;
$('#partsModal').onclick = (e) => { if (e.target.id === 'partsModal') closePartsPicker(); };
$('#pmAdd').onclick = () => pmCommit('add');
$('#pmPlay').onclick = () => pmCommit('addplay');
$('#pmPlayOnly').onclick = () => pmCommit('play');

// 播放列表面板
$('#qBtn').onclick = () => {
  const p = $('#queuePanel');
  p.hidden = !p.hidden;
  if (!p.hidden) renderQueue();
};
$('#qClose').onclick = () => { $('#queuePanel').hidden = true; };
$('#qClear').onclick = () => { clearQueue(); toast('播放列表已清空'); };
$('#qSave').onclick = () => {
  const f = folder();
  if (!f) return toast('先建一个收藏夹');
  if (!S.queue.length) return toast('播放列表是空的');
  let added = 0;
  for (const it of S.queue) {
    if (f.items.some((x) => itemKey(x) === itemKey(it))) continue;
    f.items.push({ ...it });
    added++;
  }
  save(); renderFolders(); renderList();
  toast(`已把 ${added} 首存入《${f.name}》`);
};
$('#pmAll').onclick = () => pmSetCheck(() => true);
$('#pmNone').onclick = () => pmSetCheck(() => false);
$('#pmInvert').onclick = () => pmSetCheck((el) => !el.querySelector('input').checked);
$('#pmSwitch').onclick = () => {
  pmMode = pmMode === 'parts' ? 'season' : 'parts';
  openPartsPicker(pmMeta, { mode: pmMode });
};
function pmSetCheck(fn) {
  $$('#pmList .part-row').forEach((el) => { el.querySelector('input').checked = !!fn(el); });
  pmUpdateSum();
}
$('#playAll').onclick = () => playIndex(0);

$('#nfBtn').onclick = () => {
  const n = $('#nfName').value.trim();
  if (!n) return;
  const f = { id: 'f' + Date.now(), name: n, items: [] };
  S.folders.push(f);
  S.active = f.id;
  $('#nfName').value = '';
  save(); renderFolders(); renderList();
};
$('#nfName').onkeydown = (e) => { if (e.key === 'Enter') $('#nfBtn').click(); };

$('#play').onclick = () => {
  if (!audio.src) return step(1);
  audio.paused ? audio.play() : audio.pause();
};
$('#prev').onclick = () => step(-1);
$('#next').onclick = () => step(1);
$('#mode').onclick = () => {
  S.mode = S.mode === 'loop' ? 'single' : S.mode === 'single' ? 'shuffle' : 'loop';
  const label = { loop: '🔁', single: '🔂', shuffle: '🔀' };
  $('#mode').textContent = label[S.mode];
  $('#mode').classList.add('on-mode');
  toast({ loop: '列表循环', single: '单曲循环', shuffle: '随机播放' }[S.mode]);
};

audio.onplay = () => ($('#play').textContent = '⏸');
audio.onpause = () => ($('#play').textContent = '▶');
audio.onended = () => {
  if (S.mode === 'single') {
    audio.currentTime = 0;
    audio.play();
  } else step(1);
};
audio.ontimeupdate = () => {
  if (!audio.duration) return;
  $('#seek').value = String(Math.round((audio.currentTime / audio.duration) * 1000));
  $('#cur').textContent = fmt(audio.currentTime);
  $('#dur').textContent = fmt(audio.duration);
};
$('#seek').oninput = () => {
  if (audio.duration) audio.currentTime = ($('#seek').value / 1000) * audio.duration;
};
// 音量走感知曲线：滑块位置 → 音量 = 位置²
// 线性映射时低端一动就从"还能听"掉到"没声"，平方后低端变化平缓、好微调，高端变化也更明显
const volFromPos = (pos) => {
  const t = Math.max(0, Math.min(100, +pos || 0)) / 100;
  return t * t;
};
const posFromVol = (v) => Math.round(Math.sqrt(Math.max(0, Math.min(1, +v || 0))) * 100);
$('#vol').oninput = () => (audio.volume = volFromPos($('#vol').value));
$('#loginClose').onclick = () => {
  clearInterval(pollTimer);
  $('#loginModal').hidden = true;
};
$('#quality').onclick = () => {
  localStorage.prefFlac = localStorage.prefFlac === '1' ? '0' : '1';
  const pf = $('#prefFlac'); // 设置面板开着时保持两侧一致
  if (pf) pf.checked = localStorage.prefFlac === '1';
  syncQualityBtn();
  toast(localStorage.prefFlac === '1' ? '已开启无损优先（下一首生效）' : '已关闭无损优先');
};

document.onkeydown = (e) => {
  if (e.key === 'Escape') {
    if (!$('#confirmModal').hidden) return closeConfirm(false);
    if (!$('#settingsModal').hidden) return closeSettings();
    if (!$('#partsModal').hidden) return closePartsPicker();
    if (!$('#loginModal').hidden) return $('#loginClose').click();
  }
  if (e.code === 'Space' && e.target.tagName !== 'INPUT') {
    e.preventDefault();
    $('#play').click();
  }
};
// 全局右键空白处不弹系统菜单，统一用自定义菜单
window.addEventListener('contextmenu', (e) => {
  if (!e.target.closest('.row')) e.preventDefault();
});

// 自检：验证 搜索 → 解析 → 渲染进程直连 CDN（Referer 由主进程注入）整条链路
async function selfTest() {
  const log = (...a) => console.log('[SELFTEST]', ...a);
  try {
    const r = await B.search('周杰伦 晴天', 1);
    log('SEARCH list=' + r.list.length + ' first=' + r.list[0].title);
    const meta = await B.video(r.list[0].bvid);
    log('VIDEO bvid=' + meta.bvid + ' cid=' + meta.cid + ' dur=' + meta.duration);
    const p = await B.playurl(meta.bvid, meta.cid);
    log('PLAYURL tracks=' + p.tracks.map((t) => t.kbps + 'k').join('/') + ' flac=' + !!p.flac);
    const url = p.tracks[0].url;
    const a = new Audio();
    a.preload = 'auto';
    a.src = url;
    const res = await new Promise((resolve) => {
      a.addEventListener('loadedmetadata', () => resolve('OK duration=' + a.duration));
      a.addEventListener('error', () => resolve('ERR code=' + (a.error && a.error.code)));
      setTimeout(() => resolve('TIMEOUT'), 20000);
    });
    log('MEDIA ' + res + ' host=' + new URL(url).host);
    const bv = parseInput('https://www.bilibili.com/video/BV1BZbSzZEGT?p=1');
    const bvid2 = parseInput('BV1suam6sEtq');
    const aid = parseInput('av117370366596649');
    const short = idFromUrl('https://www.bilibili.com/video/BV1GJ411x7h7?from=share');
    log('PARSE url=' + bv.value + ' bv=' + bvid2.value + ' aid=' + aid.value + ' fromUrl=' + short.value);
    log(res.startsWith('OK') ? 'RESULT=PASS' : 'RESULT=FAIL');
  } catch (e) {
    log('EXCEPTION ' + e.message);
    log('RESULT=FAIL');
  }
}

mark('init 调用前');
init();
async function afterInit() {
  await initDiag();
  await initAbout();
  const lc = localStorage.lastCheckAt;
  if (lc) $('#lastCheck').textContent = lc;
  mark('后台初始化完成');
  if (localStorage.autoCheck !== '0') doCheck(true); // 更新检查最后再做，不抢首屏
}
setTimeout(afterInit, 500); // 诊断/关于/更新检查都不影响首屏，延后执行
if (location.search.indexOf('selftest=1') >= 0) setTimeout(selfTest, 1200);
