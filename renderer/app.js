const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
// 启动耗时埋点：定位“窗口出来了但内容迟迟不出现”的问题
const T0 = performance.now();
const mark = (s) => console.log('[perf] ' + s + ' @' + Math.round(performance.now() - T0) + 'ms');
mark('脚本开始执行');
const B = window.api; // 注意：不能用 const api，会与 contextBridge 暴露的 window.api 冲突
const audio = $('#audio');
if (localStorage.prefFlac == null) localStorage.prefFlac = '1';

const S = {
  view: 'library',
  folders: [],   // 歌单：持久歌单，手动整理
  active: null,
  cur: -1,
  queue: [],     // 待播队列：当前正在播的临时队列，不进歌单
  qcur: -1,      // 队列中正在播放的下标
  mode: ['loop', 'single', 'shuffle'].includes(localStorage.playMode) ? localStorage.playMode : 'loop',
  results: [],
  kw: '',
  page: 1,
  hasMore: false,
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
const fmtDur = (d) => {
  const parts = typeof d === 'string' ? d.split(':') : [];
  const seconds = typeof d === 'number' ? d : parts.length >= 2 && parts.every(p => /^\d+$/.test(p)) ? parts.reduce((total, part) => total * 60 + Number(part), 0) : 0;
  if (seconds >= 3600) return `${Math.floor(seconds / 3600)}:${String(Math.floor(seconds % 3600 / 60)).padStart(2, '0')}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
  return typeof d === 'number' ? fmt(d) : String(d || '');
};
const fmtPlay = (n) => (n >= 10000 ? (n / 10000).toFixed(1) + ' 万' : String(n ?? 0));
const folder = () => S.folders.find((f) => f.id === S.active);
const songArtist = item => Object.hasOwn(item, 'artist') ? String(item.artist || '') : item.up || item.author || '';
const save = () =>
  B.setLibrary({
    folders: S.folders, active: S.active, queue: S.queue, qcur: S.qcur,
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
  $$('#folders .folder').forEach(n => n.classList.toggle('on', v === 'library' && n.dataset.id === S.active));
  const back = $('#backBtn');
  if (back) back.classList.toggle('dim', viewStack.length === 0);
  scheduleVisibleSongCovers();
  if (v === 'search') scheduleSearchMore();
  if (v === 'home') scheduleHomeMore();
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
  // 待播队列：上次退出时的队列，恢复但不自动播放
  S.queue = Array.isArray(lib?.queue) ? lib.queue.filter((x) => x && x.bvid) : [];
  S.qcur = Number.isInteger(lib?.qcur) && lib.qcur < S.queue.length ? lib.qcur : -1;
  restorePendingTasks();
  const savedVolume = Number(localStorage.savedVolume ?? 0.8);
  setUserVolume(Number.isFinite(savedVolume) ? savedVolume : 0.8, false);
  $('#vol').value = posFromVol(userVolume);
  renderFolders();
  renderList();
  renderQueue();
  showView('home', { noHistory: true }); // 默认进首页
  renderHome();
  mark('首屏渲染完成');
  setTimeout(checkLogin, 350); // 登录状态走网络，错开首屏渲染
  setTimeout(migrateOldPartItems, 1200); // 旧多P条目（黑帧封面/序号标题）后台静默修复
}

const LOGO_SRC = '../assets/icon.png';
let accountState = { logged: false };
let loginCheckSequence = 0;
let startupLoginEligible = true, startupLoginPending = false, startupLoginTimer = null, startupLoginFocus = null;

function dismissStartupLoginReminder(never = false) {
  if (never) {
    try { localStorage.startupLoginReminder = '0'; } catch (_) { toast('暂时无法保存提醒设置'); }
  }
  startupLoginEligible = false; startupLoginPending = false;
  clearTimeout(startupLoginTimer); startupLoginTimer = null;
  const modal = $('#startupLoginModal'), wasOpen = !modal.hidden;
  modal.hidden = true;
  if (wasOpen && startupLoginFocus?.isConnected) startupLoginFocus.focus();
  startupLoginFocus = null;
}
function scheduleStartupLoginReminder() {
  if (!startupLoginEligible || !startupLoginPending || localStorage.startupLoginReminder === '0' || startupLoginTimer !== null) return;
  startupLoginTimer = setTimeout(() => {
    startupLoginTimer = null;
    if (!startupLoginEligible || !startupLoginPending || accountState.logged || accountState.stale || localStorage.startupLoginReminder === '0') return;
    if (document.querySelector('.modal:not([hidden])')) return;
    startupLoginEligible = false; startupLoginPending = false;
    startupLoginFocus = document.activeElement;
    $('#accountMenu').hidden = true;
    for (const selector of ['#tasksPanel', '#downloadsPanel', '#queuePanel']) $(selector).hidden = true;
    $('#startupLoginModal').hidden = false;
    $('#startupLoginNow').focus();
  }, 300);
}
function initStartupLoginReminder() {
  const observer = new MutationObserver(scheduleStartupLoginReminder);
  for (const modal of document.querySelectorAll('.modal')) observer.observe(modal, { attributes: true, attributeFilter: ['hidden'] });
  $('#startupLoginClose').onclick = () => dismissStartupLoginReminder();
  $('#startupLoginNever').onclick = () => dismissStartupLoginReminder(true);
  $('#startupLoginNow').onclick = () => openLogin();
  $('#startupLoginModal').onclick = event => { if (event.target.id === 'startupLoginModal') dismissStartupLoginReminder(); };
}

async function checkLogin(retried) {
  const ticket = ++loginCheckSequence;
  const av = $('#avatarImg');
  let st;
  let loginTimeout;
  try {
    st = await Promise.race([B.loginState(), new Promise(resolve => { loginTimeout = setTimeout(() => resolve({ logged: false, stale: true }), 18000); })]);
  } catch (e) {
    st = { logged: false, stale: true };
  } finally { clearTimeout(loginTimeout); }
  if (!st || typeof st.logged !== 'boolean') st = { logged: false, stale: true };
  if (ticket !== loginCheckSequence) return;
  if (st.logged) {
    av.onerror = () => { av.onerror = null; av.src = LOGO_SRC; };
    av.src = st.face || LOGO_SRC;
    av.title = (st.name || '已登录') + ' · 点按打开账号菜单';
    accountState = { logged: true, st };
    dismissStartupLoginReminder();
  } else if (st.stale) {
    av.src = LOGO_SRC;
    av.title = st.saved ? '已登录（网络波动，状态稍后恢复）' : '登录状态检查失败 · 点按重试';
    accountState = { logged: false, stale: true, st };
    startupLoginPending = false;
    if (!$('#startupLoginModal').hidden) dismissStartupLoginReminder();
    // 网络波动导致的检查失败，10 秒后自动重试一次
    if (!retried) setTimeout(() => { if (accountState.stale) checkLogin(true); }, 10000);
  } else {
    av.src = LOGO_SRC;
    av.title = '未登录 · 点按登录';
    accountState = { logged: false };
    if (startupLoginEligible) { startupLoginPending = true; scheduleStartupLoginReminder(); }
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
    const st = accountState.st || {};
    head.innerHTML = `<img class="logo-avatar" src="${LOGO_SRC}" alt="" />
      <div><div class="h-name">${st.saved ? '已登录（网络波动）' : '登录状态检查失败'}</div>
      <div class="h-sub">${st.saved ? '本地登录信息已保留，稍后重试' : '网络或接口暂时不可用'}</div></div>`;
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

// ---------------------------------------------------------------- 智能分歌
// 几小时的长视频（无分 P）按歌与歌之间的静音切成一首首曲目
const SPLIT_MIN_DURATION = 600; // 超过 10 分钟的长视频就按静音切分
let lastSplitTip = '';
if (B.onSplitProgress) {
  B.onSplitProgress((p) => {
    if (p.requestId) { taskProgress(p); return; }
    const tip = p.stage === 'cached'
      ? '分歌：已读取分析结果'
      : p.stage === 'download'
      ? `正在智能解析 ${p.pct || 0}%`
      : p.stage === 'lyrics'
        ? `分歌：正在根据歌词识别 ${(+p.done || 0) + 1}/${p.total || 0}`
      : p.stage === 'identify'
        ? `分歌：识别歌名 ${p.done || 0}/${p.total || 0}`
        : '正在智能解析…';
    if (tip === lastSplitTip) return;
    lastSplitTip = tip;
    toast(tip);
  });
}

async function maybeSplit(f, item, description = '') {
  if (!item || item.split) return;
  if (!(item.duration >= SPLIT_MIN_DURATION)) return;
  if ((+item.page || 1) > 1) return; // 只处理整段，分 P 不重复分析
  return runSplitTask(f, item, description);
}
function applySplitResult(f, item, r, previous = null) {
  const idx = previous ? f.items.findIndex(candidate => previous.includes(candidate)) : f.items.indexOf(item);
  if (idx < 0) return;
  if (previous?.some(candidate => !f.items.includes(candidate))) throw new Error('原分段已变更，请重新分析');
  if (previous) for (const oldBatch of new Set(previous.map(candidate => candidate.splitBatch))) stopBatchRecognition(oldBatch);
  const batch = uniqueId();
  const tracks = r.tracks.map((t, i) => ({
    ...item,
    vtitle: item.vtitle || item.title,
    title: t.title || `曲目 ${i + 1}`, // 识别到歌名就用，没有就编号
    artist: t.title ? t.artist || '' : '',
    identifySource: t.title ? t.source || '' : '',
    sourceTitle: t.source === 'description' ? t.title : undefined,
    titleMetaVersion: undefined,
    referenceArtist: t.title ? t.referenceArtist || '' : '',
    songCover: LibraryModel.songCoverUrl(t.songCover),
    neteaseId: /^\d{1,20}$/.test(String(t.neteaseId || '')) ? String(t.neteaseId) : '',
    duration: Math.round(t.end - t.start),
    startSec: t.start,
    endSec: t.end,
    split: true,
    splitBatch: batch,
    splitFragments: undefined,
    boundaryLocked: !!t.boundaryLocked || ['manual', 'description'].includes(t.source),
    originalDuration: r.duration || item.duration,
  }));
  if (previous) {
    for (let i = f.items.length - 1; i >= 0; i--) if (previous.includes(f.items[i])) f.items.splice(i, 1);
    f.items.splice(idx, 0, ...tracks);
  } else f.items.splice(idx, 1, ...tracks);
  // Queues contain copies; replace any whole-video copy as well.
  const oldQueue = S.queue;
  const oldCurrent = S.qcur;
  let newCurrent = oldCurrent;
  const nextQueue = [];
  let replacing = false, replaceStart = 0;
  oldQueue.forEach((entry, queueIndex) => {
    const replacement = previous ? entry.split && previous.some(old => itemKey(old) === itemKey(entry)) : !entry.split && itemKey(entry) === itemKey(item);
    if (replacement && !replacing) { replaceStart = nextQueue.length; nextQueue.push(...tracks.map(t => ({ ...t }))); }
    if (queueIndex === oldCurrent) {
      newCurrent = nextQueue.length;
      if (replacement) {
        const part = Math.max(0, tracks.findIndex(t => audio.currentTime >= t.startSec && audio.currentTime < t.endSec));
        newCurrent = replaceStart + part;
        curSplitStart = tracks[part].startSec; curSplitEnd = tracks[part].endSec;
        $('#bTitle').textContent = tracks[part].title;
      }
    }
    if (!replacement) nextQueue.push(entry);
    replacing = replacement;
  });
  S.queue = nextQueue; S.qcur = newCurrent;
  if (folder() === f && S.qcur >= 0) S.cur = f.items.findIndex(t => itemKey(t) === itemKey(S.queue[S.qcur]));
  syncCurrentSegment();
  save(); renderFolders(); renderList(); renderQueue();
  offerUndo(previous ? '已重新分歌' : '已应用分歌结果', () => previous ? undoResplit(f, previous, oldQueue, batch) : restoreSplitBatch(f, item, batch));
  toast(`已加入 ${tracks.length} 首`);
  return batch;
}

// ---------------------------------------------------------------- 首页
// 热门条目（搜索结果格式）→ 可入队列的曲目对象
function hotToItem(r) {
  return {
    bvid: r.bvid, cid: r.cid || 0, page: 1, title: r.title, vtitle: r.title,
    partsCount: r.partsCount,
    up: r.author || '', cover: r.pic || '', duration: durSec(r.duration),
  };
}

function cardHtml(o, opts) {
  const cover = o.cover || o.pic || ''; // 热门条目的封面字段叫 pic
  const badge = o.duration ? `<span class="hc-badge">${fmtDur(o.duration)}</span>` : '';
  return `<div class="hcard" data-idx="${opts.idx}" data-kind="${opts.kind}"
      title="${esc(o.title)}">
    <div class="hc-artwork">${cover
      ? `<img class="hc-cover" src="${esc(cover)}" loading="lazy" />`
      : `<div class="hc-folder">♫</div>`}
    ${badge}
    <div class="hc-acts">
      <button data-act="play" title="播放">▶</button>
      <button data-act="queue" title="加入待播队列">＋</button>
      ${opts.kind === 'hot' ? '<button data-act="add" title="加入歌单">♥</button>' : ''}
    </div></div>
    <div class="hc-t">${esc(o.title)}</div>
    <div class="hc-u">${esc(opts.sub || '')}</div>
  </div>`;
}

// 首页只放「音乐区热门」；最近播放和歌单入口不在这里
function renderHome() {
  updateHomePager();
  scheduleHomeMore();
}

function bindHomeCards(box, kind) {
  box.querySelectorAll('.hcard').forEach((el) => {
    const i = +el.dataset.idx;
    el.onclick = async (e) => {
      const act = e.target.dataset.act;
      const r = S.hot[i];
      if (!r) return;
      if (act) {
        e.stopPropagation();
        if (act === 'add') { await addToFolder(r); return; }   // 加入歌单
        if (act === 'queue') { qToastAdd([hotToItem(r)]); return; } // 加入待播队列
      }
      await playSearchItem(r); // ▶ 或点卡片本体：多 P 会自动弹分 P 面板
    };
  });
}

function renderHotCards(append = false) {
  const box = $('#homeHot');
  const start = append ? box.querySelectorAll('.hcard').length : 0;
  if (!start) box.innerHTML = '';
  if (S.hot.length) box.insertAdjacentHTML('beforeend', S.hot.slice(start).map((it, i) => cardHtml(it, {
        idx: start + i, kind: 'hot',
        sub: `${it.author || ''} · ${fmtPlay(it.play)}播放`,
      })).join(''));
  bindHomeCards(box, 'hot');
}

// 首页沿用听歌筛选，逐页追加，独立于搜索视图的分页状态。
const HOME_KW = '音乐';
const durSec = (d) =>
  typeof d === 'string' && d.includes(':')
    ? d.split(':').reduce((a, b) => a * 60 + (+b || 0), 0)
    : Number(d) || 0;

let homePage = 0, homeHasMore = true, homeLoading = false, homeError = '';
let homeAutoTimer = null, homeIdlePages = 0, homeAutoPaused = false;
function nearHomeBottom() {
  const page = $('#view-home .page');
  return page.clientHeight > 0 && page.scrollHeight - page.scrollTop - page.clientHeight < 240;
}
function updateHomePager() {
  $('#homeHot').setAttribute('aria-busy', String(homeLoading));
  if (!S.hot.length) $('#homeHot').innerHTML = `<div class="muted">${homeError ? '推荐暂时不可用' : homeLoading || (homeHasMore && !homeAutoPaused) ? '正在加载…' : '暂时没有更多音乐推荐'}</div>`;
  const pager = $('#homePager');
  pager.querySelector('span').textContent = homeError ? '加载失败' : homeLoading ? '正在加载…' : homeAutoPaused ? '继续下滑查看更多推荐' : !homeHasMore && S.hot.length ? '没有更多了' : '';
  const retry = pager.querySelector('button');
  retry.hidden = !homeError;
  retry.onclick = () => { homeError = ''; homeAutoPaused = false; homeIdlePages = 0; loadHot(); };
}
function scheduleHomeMore() {
  if (homeAutoTimer !== null) return;
  homeAutoTimer = setTimeout(() => {
    homeAutoTimer = null;
    if (S.view === 'home' && homeHasMore && !homeLoading && !homeError && !homeAutoPaused && nearHomeBottom()) loadHot();
  }, 350);
}
function homeScrollIntent() {
  if (homeAutoPaused && nearHomeBottom()) { homeAutoPaused = false; homeIdlePages = 0; updateHomePager(); }
  scheduleHomeMore();
}
async function loadHot() {
  if (homeLoading || !homeHasMore || S.view !== 'home') return;
  homeLoading = true; homeError = ''; updateHomePager();
  try {
    const nextPage = homePage + 1;
    const result = await B.search(HOME_KW, nextPage);
    const seen = new Set(S.hot.map(item => item.bvid));
    const previousCount = S.hot.length;
    for (const item of result.list || []) {
      if (!item.bvid || seen.has(item.bvid) || !MusicSearch.eligible(item, HOME_KW)) continue;
      seen.add(item.bvid); S.hot.push(item);
    }
    homePage = nextPage; homeHasMore = !!result.hasMore && homePage < 100;
    homeIdlePages = S.hot.length === previousCount ? homeIdlePages + 1 : 0;
    homeAutoPaused = homeHasMore && (homeIdlePages >= 5 || !!result.partial);
    renderHotCards(true);
  } catch (e) {
    homeError = e.message || '请稍后重试';
  } finally {
    homeLoading = false; updateHomePager(); scheduleHomeMore();
  }
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
      (f) => `<div class="folder ${S.view === 'library' && f.id === S.active ? 'on' : ''}" data-id="${f.id}">
        <span class="name">${esc(f.name)}</span>
        <span><span class="cnt">${f.items.length}</span>${
          `<button class="folder-menu" data-menu="${esc(f.id)}" title="歌单操作" aria-label="歌单操作">⋯</button>`
        }</span></div>`
    )
    .join('');
  $$('#folders .folder').forEach((el) => {
    el.onclick = async (e) => {
      const menu = e.target.closest('[data-menu]');
      if (menu) {
        e.stopPropagation();
        const f = S.folders.find(x => x.id === menu.dataset.menu);
        if (f) showCtxMenu(e.clientX, e.clientY, [
          { label: '选择歌曲下载…', action: () => openDownloadPicker(f.items, f.name) },
          { label: '重命名歌单', action: () => renameFolder(f) },
          { label: '删除歌单', action: () => deleteFolder(f) },
        ]);
        return;
      }
      S.active = el.dataset.id;
      librarySelection.clear(); libraryQuery = ''; $('#libFilter').value = ''; updateLibrarySelection();
      save(); renderFolders(); renderList(); showView('library');
    };
  });
}

function rowHtml(it, i, extra) {
  const pg = +it.page || 1;
  // 多 P 视频的分 P 条目：标题前带 P 号徽标，悬浮提示所属视频（分歌切出的曲目不是分 P，不带）
  const badge = LibraryModel.isVideoPart(it) ? `<span class="ptag">P${pg}</span>` : '';
  return `<div class="row ${extra || ''} ${i === S.cur ? 'on' : ''}" data-i="${i}" title="${esc(it.vtitle || it.title)}">
    ${librarySelecting ? `<input class="song-check" type="checkbox" aria-label="选择 ${esc(it.title)}" ${librarySelection.has(itemKey(it)) ? 'checked' : ''} />` : ''}
    <img src="${esc(itemCover(it))}" data-fallback="${esc(it.cover || '')}" loading="lazy" />
    <div class="meta">
      <div class="t">${badge}${esc(it.title)}</div>
      <div class="u">${[esc(songArtist(it)), fmtDur(it.duration)].filter(Boolean).join(' · ')}</div>
    </div>
    <div class="acts">
      <button data-play="${i}">播放</button>
      <button data-dl="${i}">下载</button>
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
  // 分歌切出的组显示「切分 N 首」，多 P 合集显示「合集 N P」
  const isSplitGroup = !!it.split;
  const gnum = isSplitGroup ? count + ' 首' : count + 'P';
  const gtagText = isSplitGroup ? `智能切分 · ${count} 首` : `合集 ${count}P`;
  const hint = isSplitGroup ? `共 ${count} 首曲目，点击${collapsed ? '展开' : '收起'}` : `共 ${count} 个分 P，点击${collapsed ? '展开' : '收起'}`;
  return `<div class="row group${collapsed ? '' : ' open'}" data-bvid="${esc(it.bvid)}" data-start="${start}" data-count="${count}"
    title="${esc(vtitle)}（${hint}）">
    <div class="gcover">
      <img src="${esc(it.cover || '')}" loading="lazy" />
      <span class="gnum">${gnum}</span>
    </div>
    <div class="meta">
      <div class="t"><span class="gtag">${gtagText}</span>${esc(vtitle)}</div>
      <div class="u">${esc(it.up || '')} · 共 ${fmtTotal(total)} · 点击${collapsed ? '展开全部' : '收起'}</div>
    </div>
    <span class="garrow">${collapsed ? '▸' : '▾'}</span>
    <div class="acts">
      <button data-gplay="${start}">播放</button>
      <button data-gdl="${start}" data-count="${count}">选择下载…</button>
      <button data-grm="${start}" data-count="${count}">移除</button>
    </div></div>`;
}

function renderList() {
  scheduleVisibleSongCovers();
  const f = folder();
  if (!f) return;
  S.cur = S.queue[S.qcur] ? f.items.findIndex(item => itemKey(item) === itemKey(S.queue[S.qcur])) : -1;
  const validKeys = new Set(f.items.map(itemKey));
  for (const key of librarySelection) if (!validKeys.has(key)) librarySelection.delete(key);
  updateLibrarySelection();
  $('#playAll').disabled = !f.items.length;
  $('#libTitle').textContent = f.name;
  $('#libCount').textContent = `${f.items.length} 首`;
  if (!f.items.length) {
    $('#list').innerHTML = '<div class="empty">这个歌单还是空的，去上方搜索框找几首加进来</div>';
    return;
  }
  const collapsed = collapsedSet();
  if (libraryQuery || librarySelecting) {
    $('#list').innerHTML = f.items.map((item, index) => libraryMatches(item) ? rowHtml(item, index) : '').join('') || '<div class="empty">歌单中没有匹配的曲目</div>';
  } else {
  // 相邻的同视频多 P 条目聚成一组：可合并成一行，也可展开
  // 同一视频的曲目聚成一组：分 P 合集与"单 P 智能切分"出的曲目都折叠，组头显示视频标题
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
  }
  const rmItems = (start, cnt) => {
    const removed = f.items.slice(start, start + cnt);
    f.items.splice(start, cnt);
    if (S.cur >= start && S.cur < start + cnt) S.cur = -1;
    else if (S.cur >= start + cnt) S.cur -= cnt;
    save(); renderFolders(); renderList();
    offerUndo(`已移除 ${cnt} 首`, () => { if (S.folders.includes(f)) f.items.splice(Math.min(start, f.items.length), 0, ...removed); });
  };
  $$('#list .row').forEach((el) => {
    const i = +el.dataset.i;
    const isGroup = el.dataset.bvid !== undefined;
    el.onclick = async (e) => {
      const button = e.target.closest('button');
      const action = button?.dataset || {};
      const gp = action.gplay, grm = action.grm;
      if (action.dl !== undefined) { await requestDownloads([f.items[+action.dl]]); return; }
      if (action.gdl !== undefined) { openDownloadPicker(f.items.slice(+action.gdl, +action.gdl + +el.dataset.count), f.items[+action.gdl].vtitle || f.name); return; }
      if (librarySelecting && !isGroup && action.play === undefined && action.rm === undefined) {
        const key = itemKey(f.items[i]);
        librarySelection.has(key) ? librarySelection.delete(key) : librarySelection.add(key);
        updateLibrarySelection(); renderList(); return;
      }
      if (action.rm !== undefined) {
        const it = f.items[+action.rm];
        const ok = await askConfirm('从歌单移除', `「${it.title}」将从「${f.name}」移除。`, '移除');
        if (!ok) return;
        rmItems(+action.rm, 1);
        toast('已移除');
        return;
      }
      if (action.play !== undefined) {
        e.stopPropagation();
        playIndex(+action.play);
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
          '移除整组',
          `「${vtitle}」的 ${cnt} 首歌将一起从「${f.name}」移除。`,
          `移除 ${cnt} 首`
        );
        if (!ok) return;
        rmItems(+grm, cnt);
        toast(`已移除 ${cnt} 首`);
        return;
      }
      if (button) return;
      if (isGroup) { toggleCollapsed(el.dataset.bvid); return; }
      $$('#list .row.selected').forEach(row => row.classList.remove('selected'));
      el.classList.add('selected');
    };
    el.ondblclick = e => { if (!librarySelecting && !e.target.closest('button, input')) { if (isGroup) playIndex(+el.dataset.start); else playIndex(i); } };
    el.oncontextmenu = (e) => {
      e.preventDefault();
      if (isGroup) {
        const bid = el.dataset.bvid;
        const start = +el.dataset.start;
        const cnt = +el.dataset.count;
        showCtxMenu(e.clientX, e.clientY, [
          { label: collapsed.has(bid) ? '展开全部 P' : '收起', action: () => toggleCollapsed(bid) },
          { label: '播放', action: () => playIndex(start) },
          { label: '选择歌曲下载…', action: () => openDownloadPicker(f.items.slice(start, start + cnt), f.items[start].vtitle || f.name) },
          { label: '解析整组歌曲信息', action: () => parseSongMetadata(f.items.slice(start, start + cnt)) },
          ...(f.items[start].split ? [{ label: '重新智能分歌…', action: () => resplitVideo(f, f.items[start]) }] : []),
          ...(f.items[start].split ? [{ label: '恢复整段…', action: () => restoreWholeVideo(f, f.items[start]) }] : []),
          { label: '在浏览器打开 B 站页面', action: () => B.openExternal('https://www.bilibili.com/video/' + bid) },
          { label: '复制视频链接', action: () => { B.copyText('https://www.bilibili.com/video/' + bid); toast('链接已复制'); } },
          { label: '移除全部', action: async () => {
              const vtitle = f.items[start].vtitle || f.items[start].title;
              const ok = await askConfirm(
                '移除整组',
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
        { label: '下载（最高可用音质）', action: () => requestDownloads([it]) },
        { label: '下一首播放', action: () => addNext([it]) },
        { label: '编辑歌曲信息…', action: () => editSongInfo(it) },
        { label: '解析歌曲信息', action: () => parseSongMetadata([it]) },
        ...(it.split ? [{ label: '重新智能分歌…', action: () => resplitVideo(f, it) }] : []),
        ...(it.split ? [{ label: '恢复整段…', action: () => restoreWholeVideo(f, it) }] : []),
        ...(!it.split && canSplitItem(it) ? [{ label: '智能分歌…', action: () => maybeSplit(f, it) }] : []),
        { label: '加入待播队列', action: () => qToastAdd([it]) },
        { label: '该视频的全部分 P…', action: () => openPartsOfVideo(it.bvid) },
        { label: '在浏览器打开 B 站页面', action: () => B.openExternal('https://www.bilibili.com/video/' + it.bvid) },
        { label: '复制视频链接', action: () => { B.copyText('https://www.bilibili.com/video/' + it.bvid); toast('链接已复制'); } },
        { label: '从歌单移除', action: async () => {
            const ok = await askConfirm('从歌单移除', `「${it.title}」将从「${f.name}」移除。`, '移除');
            if (!ok) return;
            rmItems(i, 1);
            toast('已移除');
          } },
      ]);
    };
  });
}

function renderResults(append = false) {
  const list = $('#results');
  const top = list.scrollTop;
  const anchor = append ? [...list.querySelectorAll('.row')].find(row => row.getBoundingClientRect().bottom > list.getBoundingClientRect().top) : null;
  const anchorIndex = anchor?.dataset.i, anchorOffset = anchor ? anchor.getBoundingClientRect().top - list.getBoundingClientRect().top : 0;
  const visible = visibleSearchResults();
  const html = visible.map((r) => {
    const i = S.results.indexOf(r);
    const playTxt = r.play != null && r.play !== '' ? ` · ${fmtPlay(r.play)}播放` : '';
    const ptag = `<span class="type-tag">${r.partsCount > 1 ? `多 P · ${r.partsCount}` : durSec(r.duration) >= 600 ? '长视频' : durSec(r.duration) >= 180 ? '单曲' : '短视频'}</span>`;
    const saved = S.folders.some(f => f.items.some(item => item.bvid === r.bvid));
    return `<div class="row ${selectedResult === r.bvid ? 'selected' : ''}" data-i="${i}" title="${esc(r.title)}">
      <img src="${r.pic}" loading="lazy" />
      <div class="meta">
        <div class="t">${ptag}${esc(r.title)}</div>
        <div class="u">${esc(r.author || '')} · ${fmtDur(r.duration)}${playTxt}${saved ? ' · 已收藏' : ''}</div>
      </div>
      <div class="acts">
        <button data-play="${i}">播放</button>
        <button data-add="${i}">加入歌单</button>
        <button data-download="${i}">下载</button>
      </div></div>`;
  }).join('');
  list.innerHTML = (html || `<div class="empty">${searchEmptyText()}</div>`)
    + (S.searchDirect ? '' : '<div id="searchPager" class="search-pager" role="status"><span></span><button hidden>重试</button></div>');
  if (append) {
    const nextAnchor = anchorIndex !== undefined ? list.querySelector(`.row[data-i="${anchorIndex}"]`) : null;
    list.scrollTop = top;
    if (nextAnchor) list.scrollTop += nextAnchor.getBoundingClientRect().top - list.getBoundingClientRect().top - anchorOffset;
  } else list.scrollTop = 0;
  updateSearchPager();
  $$('#results .row').forEach((el) => {
    const i = +el.dataset.i;
    el.onclick = async (e) => {
      if (e.target.dataset.add !== undefined) {
        e.stopPropagation();
        await addToFolder(S.results[i]);
        return;
      }
      if (e.target.closest('[data-download]')) { await downloadSearchItem(S.results[i]); return; }
      if (e.target.closest('[data-play]')) { await playSearchItem(S.results[i]); return; }
      selectedResult = S.results[i].bvid;
      $$('#results .row.selected').forEach(row => row.classList.remove('selected')); el.classList.add('selected');
    };
    el.ondblclick = e => { if (!e.target.closest('button')) playSearchItem(S.results[i]); };
    el.oncontextmenu = (e) => {
      e.preventDefault();
      const r = S.results[i];
      showCtxMenu(e.clientX, e.clientY, [
        { label: '播放', action: () => playSearchItem(r) },
        { label: '下一首播放', action: () => addNext([hotToItem(r)]) },
        { label: '加入歌单', action: () => addToFolder(r) },
        { label: '下载（最高可用音质）', action: () => downloadSearchItem(r) },
      { label: '加入待播队列', action: () => qToastAdd([{
        bvid: r.bvid, page: r.page || 1, title: r.title, vtitle: r.title,
        up: r.author, cover: r.pic, duration: r.duration,
      }]) },
      { label: '选择分 P / 合辑…', action: () => pickParts(r) },
        { label: '在浏览器打开 B 站页面', action: () => B.openExternal('https://www.bilibili.com/video/' + r.bvid) },
        { label: '复制视频链接', action: () => { B.copyText('https://www.bilibili.com/video/' + r.bvid); toast('链接已复制'); } },
      ]);
    };
  });
  scheduleSearchMore();
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
let searchRequest = 0;
let searchLoading = false;
let searchError = '';
let searchAutoTimer = null;
let searchIdlePages = 0;
let searchAutoPaused = false;
function searchEmptyText() {
  if (searchError) return '搜索暂时不可用';
  if (searchLoading || (S.hasMore && !searchAutoPaused)) return S.page > 0 ? '正在查找符合筛选的结果…' : '搜索中…';
  return S.results.length ? '没有符合当前筛选的结果' : '没有找到结果';
}
function updateSearchPager() {
  $('#results').setAttribute('aria-busy', String(searchLoading));
  const empty = $('#results').querySelector('.empty');
  if (empty && !S.searchDirect) empty.textContent = searchEmptyText();
  const pager = $('#searchPager');
  if (!pager) return;
  pager.hidden = S.searchDirect || (searchLoading && !S.results.length);
  pager.querySelector('span').textContent = searchError ? '加载失败' : searchLoading ? '正在加载…' : searchAutoPaused ? '暂未找到更多匹配结果' : S.hasMore ? '' : S.results.length ? '没有更多了' : '';
  const retry = pager.querySelector('button');
  retry.hidden = !searchError;
  retry.onclick = () => {
    searchError = ''; searchIdlePages = 0; searchAutoPaused = false;
    doSearch(S.results.length ? S.page + 1 : 1, S.results.length > 0);
  };
}
function nearSearchBottom() {
  const list = $('#results');
  return list.clientHeight > 0 && list.scrollHeight - list.scrollTop - list.clientHeight < 180;
}
function scheduleSearchMore() {
  if (searchAutoTimer !== null) return;
  searchAutoTimer = setTimeout(() => {
    searchAutoTimer = null;
    if (S.view === 'search' && !S.searchDirect && S.kw && S.hasMore && !searchLoading && !searchError && !searchAutoPaused && nearSearchBottom()) doSearch(S.page + 1, true);
  }, 350);
}
function searchScrollIntent() {
  if (searchAutoPaused && nearSearchBottom()) { searchAutoPaused = false; searchIdlePages = 0; updateSearchPager(); }
  scheduleSearchMore();
}
async function handleSearch() {
  const raw = $('#kw').value.trim();
  if (!raw) return;
  rememberSearch(raw);
  const p = parseInput(raw);
  if (p.type === 'keyword') return doSearch(1);
  const request = ++searchRequest;
  clearTimeout(searchAutoTimer); searchAutoTimer = null;
  searchLoading = true; searchError = ''; searchAutoPaused = false; searchIdlePages = 0;
  S.searchDirect = true; S.hasMore = false; S.results = [];
  showView('search');
  $('#searchHint').hidden = true;
  $('#results').innerHTML = '<div class="empty">识别到视频链接，解析中…</div>';
  try {
    let id = p;
    if (p.type === 'url') {
      const final = await B.resolve(p.value);
      id = idFromUrl(final);
      if (!id) throw new Error('链接里没有识别到视频 ID');
    }
    const meta = await B.video(id.value);
    if (request !== searchRequest) return;
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
    S.searchDirect = true;
    S.hasMore = false;
    renderResults();
    if (parts.length > 1) {
      openPartsPicker(meta, { only: id.page || 0 });
      toast(`识别到 ${parts.length} 个分 P`);
    } else {
      toast('已识别视频');
    }
  } catch (e) {
    if (request !== searchRequest) return;
    $('#results').innerHTML = `<div class="empty">解析失败：${esc(e.message)}</div>`;
  } finally {
    if (request === searchRequest) { searchLoading = false; updateSearchPager(); }
  }
}

async function doSearch(page = 1, append = false) {
  if (append && (searchLoading || !S.hasMore || S.searchDirect || S.view !== 'search')) return;
  const kw = append ? S.kw : $('#kw').value.trim();
  if (!kw) return;
  if (!append) rememberSearch(kw);
  const request = ++searchRequest;
  S.kw = kw;
  clearTimeout(searchAutoTimer); searchAutoTimer = null;
  searchLoading = true; searchError = '';
  if (!append) {
    searchIdlePages = 0; searchAutoPaused = false;
    S.results = []; S.hasMore = false; S.page = 0;
    S.searchDirect = false;
    $('#searchHint').hidden = true;
    showView('search');
    renderResults();
  } else updateSearchPager();
  try {
    const r = await B.search(kw, page);
    if (request !== searchRequest) return;
    S.page = page;
    const previousCount = visibleSearchResults().length;
    S.results = [...new Map((append ? S.results.concat(r.list) : r.list).map(it => [it.bvid, it])).values()];
    S.hasMore = !!r.hasMore && page < 100;
    // Do not crawl every remote page when a restrictive filter finds nothing.
    searchIdlePages = append && visibleSearchResults().length <= previousCount ? searchIdlePages + 1 : 0;
    searchAutoPaused = searchIdlePages >= 5 || !!r.partial;
    $('#searchHint').textContent = [r.corrected ? `已按「${r.effectiveQuery}」搜索` : '', r.partial ? '部分结果暂时无法获取' : ''].filter(Boolean).join(' · ');
    $('#searchHint').hidden = !$('#searchHint').textContent;
    renderResults(append);
  } catch (e) {
    if (request !== searchRequest) return;
    searchError = e.message || '请稍后重试';
    if (!append) renderResults();
    updateSearchPager();
  } finally {
    if (request === searchRequest) {
      searchLoading = false;
      if (!S.results.length) renderResults();
      updateSearchPager(); scheduleSearchMore();
    }
  }
}

// ---------------------------------------------------------------- 分 P / 合集选择面板
// 一个视频可能有几十上百个 P，每个 P 是独立的一首歌，必须能逐个选、逐个加入
let pmMeta = null;      // 当前视频信息（含 parts / season）
let pmMode = 'parts';   // parts | season
let pmWantPlay = false; // 加入后是否立即播放

const sourceKey = (it) => it.bvid + ':' + (+it.page || 1);
const itemKey = (it) => sourceKey(it)
  + (it.split ? ':' + it.startSec + ':' + it.endSec : '');

function pmEntries() {
  if (pmMode === 'season' && pmMeta.season) {
    return (pmMeta.season.episodes || []).map((ep, i) => ({
      key: ep.bvid + ':' + (ep.page || 1),
      no: String(i + 1),
      name: ep.title || ('第 ' + (i + 1) + ' 集'),
      duration: ep.duration || 0,
      bvid: ep.bvid, cid: ep.cid, page: ep.page || 1,
      partsCount: ep.partsCount,
      cover: ep.cover || pmMeta.cover, up: ep.up || pmMeta.up,
      vtitle: pmMeta.season.title,
    }));
  }
  const multi = (pmMeta.parts || []).length > 1;
  return (pmMeta.parts || []).map((p) => ({
    key: pmMeta.bvid + ':' + p.page,
    no: 'P' + p.page,
    name: multi ? p.part || ('P' + p.page) : pmMeta.title,
    partTitle: multi ? p.part || '' : '',
    partsCount: (pmMeta.parts || []).length,
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
  $('#pmList').innerHTML = all
    .map(
      (e) => `<label class="part-row" data-key="${esc(e.key)}">
        <input type="checkbox" checked />
        <span class="pno">${esc(e.no)}</span>
        <span class="pname">${esc(e.name)}</span>
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

// action: 'play' 仅播放（不动歌单） | 'add' 加入歌单 | 'addplay' 加入并播放
async function pmCommit(action) {
  const keys = new Set(pmSelectedKeys());
  if (!keys.size) return toast('至少选一个分 P');
  const all = pmEntries()
    .filter((e) => keys.has(e.key))
    .map((e) => ({
      bvid: e.bvid, cid: e.cid, page: e.page,
      title: e.name, vtitle: e.vtitle || e.name, partTitle: e.partTitle || '',
      partsCount: e.partsCount,
      up: e.up, cover: e.cover, duration: e.duration,
    }));
  if (action === 'download') { closePartsPicker(); await requestDownloads(all); return; }
  if (action === 'play') {
    closePartsPicker();
    // 仅播放：只放进待播队列，歌单一个字都不动
    loadQueue(all, 0);
    await playQueueAt(0);
    toast(`${all.length} 首已进入待播队列（未加入歌单）`);
    return;
  }

  const result = await saveItemsToFolder(all, {
    allowSplit: pmMode === 'season',
    confirmText: action === 'addplay' ? '加入并播放' : '加入歌单',
  });
  if (!result) return; // Cancel returns to the part selection without changing it.
  closePartsPicker();

  if (action === 'addplay') {
    showView('library');
    const f2 = result.folder;
    let idx = f2.items.findIndex((x) => keys.has(sourceKey(x)));
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

// All library insertion paths ask for a destination. Eligible long videos default to smart splitting.
let addChoiceResolve = null;
let addChoiceCanSplit = false;
let addChoiceFocus = null;
function canSplitItem(item) {
  return !item.split && item.duration >= SPLIT_MIN_DURATION && (+item.page || 1) === 1;
}
function chooseAddOptions(items, opts = {}) {
  if (addChoiceResolve) closeAddDialog(null);
  addChoiceFocus = document.activeElement;
  addChoiceCanSplit = opts.allowSplit !== false && items.some(canSplitItem);
  $('#addTitle').textContent = opts.confirmText || '加入歌单';
  $('#addSummary').textContent = items.length === 1 ? items[0].title : `已选 ${items.length} 首 · ${fmtTotal(items.reduce((sum, it) => sum + (+it.duration || 0), 0))}`;
  $('#addFolder').innerHTML = S.folders.map(f => `<option value="${esc(f.id)}">${esc(f.name)}（${f.items.length} 首）</option>`).join('')
    + '<option value="__new__">＋ 新建歌单…</option>';
  $('#addFolder').value = S.folders.some(f => f.id === S.active) ? S.active : '__new__';
  $('#addNewName').value = '';
  $('#addNewWrap').hidden = $('#addFolder').value !== '__new__';
  $('#addSplitOptions').hidden = !addChoiceCanSplit;
  $('#addWhole').checked = !addChoiceCanSplit;
  $('#addSplit').checked = addChoiceCanSplit;
  $('#addError').hidden = true;
  $('#addConfirm').textContent = opts.confirmText || '加入歌单';
  $('#addModal').hidden = false;
  $('#addFolder').focus();
  return new Promise(resolve => { addChoiceResolve = resolve; });
}
function closeAddDialog(choice) {
  $('#addModal').hidden = true;
  const resolve = addChoiceResolve;
  addChoiceResolve = null;
  if (addChoiceFocus?.isConnected) addChoiceFocus.focus();
  addChoiceFocus = null;
  if (resolve) resolve(choice);
}
function confirmAddDialog(event) {
  event.preventDefault();
  const folderId = $('#addFolder').value;
  const newName = $('#addNewName').value.trim();
  const error = folderId === '__new__'
    ? !newName ? '请输入新歌单名称' : S.folders.some(f => f.name === newName) ? '已有同名歌单，请直接选择它' : ''
    : !S.folders.some(f => f.id === folderId) ? '这个歌单已不存在，请重新选择' : '';
  if (error) {
    $('#addError').textContent = error;
    $('#addError').hidden = false;
    if (folderId === '__new__') $('#addNewName').focus();
    return;
  }
  closeAddDialog({ folderId, newName, split: addChoiceCanSplit && $('#addSplit').checked });
}
async function saveItemsToFolder(items, opts = {}) {
  if (!items.length) { toast('没有可以添加的曲目'); return null; }
  const choice = await chooseAddOptions(items, opts);
  if (!choice) return null;
  let f;
  if (choice.folderId === '__new__') {
    f = { id: 'f' + Date.now() + Math.random().toString(36).slice(2, 8), name: choice.newName, items: [] };
    S.folders.push(f);
  } else {
    f = S.folders.find(candidate => candidate.id === choice.folderId);
  }
  if (!f) { toast('歌单已不存在，请重新添加'); return null; }
  const added = [];
  let duplicates = 0;
  for (const item of items) {
    const exists = f.items.some(x => item.split ? itemKey(x) === itemKey(item) : sourceKey(x) === sourceKey(item));
    if (exists) { duplicates++; continue; }
    const copy = { ...item };
    f.items.push(copy);
    added.push(copy);
  }
  if (S.active !== f.id) S.cur = -1;
  S.active = f.id;
  save(); renderFolders(); renderList();
  toast(`已加入 ${added.length} 首到《${f.name}》${duplicates ? `（${duplicates} 首已存在，已跳过）` : ''}`);
  queueSongTitles(added);
  if (choice.split && opts.allowSplit !== false) {
    // Analyze serially: each completion can replace its own inserted entry safely.
    (async () => {
      for (const item of added.filter(canSplitItem)) await maybeSplit(f, item, opts.description || '');
    })().catch(error => toast('分歌失败：' + error.message));
  }
  return { folder: f, added, duplicates };
}

async function addToFolder(r) {
  try {
    const meta = (r.meta && r.meta.bvid === r.bvid) ? r.meta : await B.video(r.bvid);
    r.meta = meta;
    if ((meta.parts || []).length > 1) return openPartsPicker(meta, { only: r.page || 0 });
    await saveItemsToFolder([{
      bvid: meta.bvid, cid: meta.cid, page: 1, title: meta.title, vtitle: meta.title,
      partsCount: Math.max(1, (meta.parts || []).length),
      up: meta.up, cover: meta.cover, duration: meta.duration,
    }], { description: meta.desc });
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
    // 单 P：只进待播队列，不动歌单
    loadQueue([{
      bvid: meta.bvid, cid: meta.cid, page: 1, title: meta.title, vtitle: meta.title,
      partsCount: Math.max(1, (meta.parts || []).length),
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
// Source → loudness gain → peak protection → user volume → output.
// A separate pre-fader stereo meter never sees the user's volume adjustment.
let ac = null, srcNode = null;
let agcTimer = null;
let balanceGraph = null, balanceController = null, balanceKey = '', userVolume = 0.8;
const volumeReferences = new Map();
try {
  const saved = JSON.parse(localStorage.volumeReferencesV1 || '[]');
  if (Array.isArray(saved)) for (const entry of saved.slice(-100)) {
    if (Array.isArray(entry) && typeof entry[0] === 'string' && entry[0].length < 300 && Number.isFinite(entry[1]) && entry[1] >= -50 && entry[1] <= 6) volumeReferences.set(entry[0], entry[1]);
  }
} catch (_) {}
let volumeCacheTimer = null;
function rememberVolumeReference() {
  if (!balanceKey || balanceController?.samples < 30 || !Number.isFinite(balanceController?.reference)) return;
  if (volumeReferences.has(balanceKey) && Math.abs(volumeReferences.get(balanceKey) - balanceController.reference) < 0.1) return;
  volumeReferences.delete(balanceKey); volumeReferences.set(balanceKey, balanceController.reference);
  while (volumeReferences.size > 100) volumeReferences.delete(volumeReferences.keys().next().value);
  if (volumeCacheTimer !== null) return;
  volumeCacheTimer = setTimeout(() => {
    volumeCacheTimer = null;
    try { localStorage.volumeReferencesV1 = JSON.stringify([...volumeReferences]); } catch (_) {}
  }, 1500);
}
function setUserVolume(value, persist = true) {
  userVolume = Math.max(0, Math.min(1, Number(value) || 0));
  if (balanceGraph) { audio.volume = 1; balanceGraph.setVolume(userVolume); }
  else audio.volume = userVolume;
  if (persist) try { localStorage.savedVolume = String(userVolume); } catch (_) {}
}

const balanceOn = () => localStorage.volumeBalance !== '0';

function ensureGraph() {
  if (ac) return ac;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  ac = new AC(); srcNode = ac.createMediaElementSource(audio);
  balanceGraph = VolumeBalance.createGraph(ac, srcNode, userVolume);
  audio.volume = 1;
  return ac;
}

function applyBalanceRouting() {
  if (!ensureGraph()) return;
  balanceGraph.setEnabled(balanceOn());
}

function startAgc(item = playback.current?.item, track = playback.current?.track) {
  clearInterval(agcTimer);
  agcTimer = null;
  if (!balanceOn() || !balanceGraph) return;
  const key = item ? itemKey(item) + '|' + (item.cid || 0) + '|' + (track?.id || '') : '';
  rememberVolumeReference();
  if (key !== balanceKey || !balanceController) {
    balanceKey = key; balanceController = VolumeBalance.createController(volumeReferences.get(key));
  }
  balanceGraph.setDb(balanceController.db, true);
  let meterReadyAt = ac.currentTime + 0.25;
  agcTimer = setInterval(() => {
    if (audio.seeking) meterReadyAt = ac.currentTime + 0.25;
    if (audio.paused || audio.seeking || audio.readyState < 3 || ac.state !== 'running' || ac.currentTime < meterReadyAt) return;
    balanceGraph.setDb(balanceController.push(balanceGraph.measure()));
    rememberVolumeReference();
  }, 100);
}

// ---------------------------------------------------------------- 待播队列（队列）
// 与歌单分离：只播放不入库的曲目放这里，连播 / 上一首 / 下一首都以它为准
function syncQueueBtn() {
  const btn = $('#qBtn');
  if (!btn) return;
  const n = S.queue.length;
  btn.classList.toggle('on', n > 0);
  const b = $('#qBadge');
  if (b) { b.textContent = n > 99 ? '99+' : String(n); b.hidden = !n; }
}

function renderQueue() {
  scheduleVisibleSongCovers();
  const box = $('#queueList');
  if (!box) return;
  if (!S.queue.length) {
    box.innerHTML =
      '<div class="q-empty">待播队列是空的<br/>播放任意歌曲会进入这里<br/>在分 P 面板里选「仅播放」可只播不入库</div>';
  } else {
    box.innerHTML = S.queue
      .map(
        (it, i) => `<div class="q-row ${i === S.qcur ? 'on' : ''}" data-i="${i}"
        title="${esc(it.vtitle || it.title)}">
        <img class="qcover" src="${esc(itemCover(it))}" data-fallback="${esc(it.cover || '')}" loading="lazy" />
        <span class="qmeta">
          <span class="qt">${esc(it.title)}</span>
          <span class="qu">${esc(songArtist(it))}</span>
        </span>
        <span class="qd">${fmtDur(it.duration)}</span>
        <button class="qx" data-x="${i}" title="从待播队列移除">×</button>
      </div>`
      )
      .join('');
    box.querySelectorAll('.q-row').forEach((el) => {
      el.oncontextmenu = event => {
        event.preventDefault();
        const item = S.queue[+el.dataset.i];
        if (item) showCtxMenu(event.clientX, event.clientY, [{ label: '编辑歌曲信息…', action: () => editSongInfo(item) },
          { label: '解析歌曲信息', action: () => parseSongMetadata([item]) }]);
      };
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

// 用一份曲目替换整个待播队列，并从 startIdx 开始（不自动播放）
function loadQueue(items, startIdx = -1) {
  S.queue = (items || []).map((it) => ({ ...it }));
  S.qcur = startIdx >= 0 && startIdx < S.queue.length ? startIdx : -1;
  save();
  renderQueue();
  queueSongTitles(S.queue);
}

function appendQueue(items) {
  const keys = new Set(S.queue.map(itemKey));
  const add = (items || []).filter((it) => { const key = itemKey(it); if (keys.has(key)) return false; keys.add(key); return true; });
  S.queue = S.queue.concat(add.map((it) => ({ ...it })));
  save();
  renderQueue();
  queueSongTitles(S.queue);
  return add.length;
}

function removeFromQueue(i) {
  if (i < 0 || i >= S.queue.length) return;
  const wasCurrent = S.qcur === i;
  S.queue.splice(i, 1);
  if (S.qcur > i) S.qcur -= 1;
  else if (S.qcur === i) S.qcur = -1;
  save();
  renderQueue();
  if (wasCurrent) {
    if (S.queue.length) playQueueAt(Math.min(i, S.queue.length - 1));
    else clearQueue();
  }
}

function clearQueue() {
  clearInterval(agcTimer); agcTimer = null; rememberVolumeReference();
  playback.sequence++; clearTimeout(playback.stallTimer);
  playback.current = null; playback.requested = null;
  playback.seekTarget = null; playback.seekRevision++;
  if (playback.seekListener) audio.removeEventListener('loadedmetadata', playback.seekListener);
  playback.seekListener = null;
  audio.pause(); audio.removeAttribute('src'); audio.load();
  curSplitStart = null; curSplitEnd = null;
  $('#bTitle').textContent = '选择一首音乐'; $('#bUp').textContent = '';
  $('#cur').textContent = '00:00'; $('#dur').textContent = '00:00'; $('#seek').value = '0';
  curKbps = 0; curFormat = ''; syncQualityBtn(); setPlaybackStatus('');
  S.queue = [];
  S.qcur = -1;
  save();
  renderQueue();
}

// 右键「加入待播队列」
function qToastAdd(items) {
  const n = appendQueue(items);
  toast(n ? `已加入待播队列（${n} 首）` : '已经在待播队列里了');
}

// 待播队列里的第 i 首（同时同步歌单列表的高亮）
async function playQueueAt(i) {
  if (i < 0 || i >= S.queue.length) return;
  const it = S.queue[i];
  const f = folder();
  const idx = f ? f.items.findIndex((x) => itemKey(x) === itemKey(it)) : -1;
  S.qcur = i;
  const played = await playTrack(it, idx);
  if (!played || !S.queue[i] || itemKey(S.queue[i]) !== itemKey(it)) return;
  save();
  renderQueue();
}

// ---------------------------------------------------------------- 播放
async function playIndex(i) {
  const f = folder();
  if (i < 0 || i >= f.items.length) return;
  loadQueue(f.items, i); // 从歌单起播 = 整张歌单作为待播队列
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
let curFormat = '';

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
  it.partsCount = Math.max(1, (meta.parts || []).length);
  it.cover = meta.cover; // 统一用视频主封面，与首页一致
  if (!it.split && !it.identifySource && p && p.part) it.title = p.part;
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
        it.partsCount = Math.max(1, (meta.parts || []).length);
        it.cover = meta.cover;
        if (!it.split && !it.identifySource && p && p.part) it.title = p.part;
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

// 分歌曲目的播放区间（null = 整段播放）
let splitAdvancing = false;
let curSplitStart = null;
let curSplitEnd = null;
const playback = { sequence: 0, current: null, seekListener: null, recovering: false, lastPosition: 0, stallTimer: null,
  seekTarget: null, seekRevision: 0 };
function setPlaybackStatus(text, failed = false) {
  const status = $('#playStatus');
  if (status) {
    const quiet = !failed && ['播放中', '已暂停', '等待播放', '已停止', ''].includes(text);
    status.textContent = quiet ? '' : text; status.hidden = quiet;
    status.classList.toggle('failed', failed);
    status.title = failed ? '点击重试' : text;
    status.disabled = !failed;
  }
}

function scheduleStallRecovery() {
  clearTimeout(playback.stallTimer);
  const ticket = playback.sequence, revision = playback.seekRevision;
  if (!playback.current || audio.paused) return;
  playback.stallTimer = setTimeout(() => {
    if (ticket === playback.sequence && revision === playback.seekRevision && !audio.paused &&
      (audio.seeking || audio.readyState < 3)) recoverPlayback();
  }, 12000);
}
function playbackDuration(item) {
  const actual = playback.current?.ticket === playback.sequence && audio.readyState >= 1 ? audio.duration : NaN;
  if (Number.isFinite(actual) && actual > 0) return actual;
  const known = Number(item?.duration);
  return Number.isFinite(known) && known > 0 ? known : null;
}
function seekPlayback(position) {
  if (!Number.isFinite(position) || !playback.requested) return;
  const item = playback.current?.item || playback.requested.item;
  const start = item.split ? item.startSec : 0;
  const end = item.split ? item.endSec : (playbackDuration(item) ?? Infinity);
  const target = Math.max(start, Math.min(position, end));
  playback.seekRevision++;
  playback.lastPosition = target; playback.seekTarget = target;
  playback.requested.position = target; playback.requested.userSeek = true;
  clearTimeout(playback.stallTimer);
  // While a new URL/metadata is pending, retain only the latest desired position.
  // Writing currentTime here would seek the old source, then get overwritten.
  if (playback.current?.ticket === playback.sequence && audio.readyState >= 1) {
    if (playback.seekListener) audio.removeEventListener('loadedmetadata', playback.seekListener);
    playback.seekListener = null;
    try { audio.currentTime = target; } catch (_) {}
    scheduleStallRecovery();
  }
}

async function playTrack(it, idx, options = {}) {
  const ticket = ++playback.sequence;
  clearTimeout(playback.stallTimer);
  if (playback.seekListener) audio.removeEventListener('loadedmetadata', playback.seekListener);
  playback.seekListener = null;
  playback.current = null;
  const request = { item: it, idx, position: options.position ?? it.startSec ?? 0, userSeek: false };
  playback.requested = request;
  playback.lastPosition = request.position;
  playback.seekTarget = null; playback.seekRevision++;
  if (audio.pause) audio.pause();
  setPlaybackStatus(options.recovery ? '正在恢复播放…' : '正在加载…');
  try {
    await ensureCid(it);
    if (ticket !== playback.sequence) return false;
    const p = await B.playurl(it.bvid, it.cid, !!options.refresh);
    if (ticket !== playback.sequence) return false;
    const track = pickTrack(p);
    if (!track?.url) throw new Error('没有可用音频地址');
    if (idx !== undefined) S.cur = idx;
    // 分歌曲目只播自己那一段：播完由 timeupdate 自动接下一首
    curSplitStart = it.split && it.startSec != null ? it.startSec : null;
    curSplitEnd = it.split && it.endSec != null ? it.endSec : null;
    const urls = [...new Set([track.url, ...(track.backupUrls || [])])];
    playback.lastPosition = request.position;
    playback.current = { item: it, idx, track, urls, urlIndex: options.urlIndex || 0, attempts: options.attempts || 0, ticket, preview: !!options.preview };
    playback.seekTarget = request.position > 0 || request.userSeek ? request.position : null;
    audio.src = urls[playback.current.urlIndex] || urls[0];
    const seekTo = () => {
      if (ticket !== playback.sequence) return;
      playback.seekListener = null;
      if (request.position > 0 || request.userSeek) {
        const target = Math.max(curSplitStart ?? 0, Math.min(request.position, (curSplitEnd ?? Infinity) - 0.05));
        playback.lastPosition = target; playback.seekTarget = target;
        try { audio.currentTime = target; } catch (_) {}
      }
    };
    if (audio.readyState >= 1) seekTo();
    else { playback.seekListener = seekTo; audio.addEventListener('loadedmetadata', seekTo, { once: true }); }
    applyBalanceRouting();
    startAgc(it, track);
    await audio.play();
    if (ticket !== playback.sequence) return false;
    // 首次异步取流可能失去用户手势，播放成功后恢复被浏览器挂起的音频图。
    if (ac && ac.state === 'suspended') await ac.resume().catch(() => {});
    if (ticket !== playback.sequence) return false;
    setSongCover($('#bCover'), it);
    requestSongCover(it);
    $('#bTitle').textContent = it.title;
    $('#bUp').textContent = songArtist(it);
    curKbps = track.kbps || 0;
    curFormat = p.flac === track ? 'FLAC' : /mp4a/i.test(track.codecs || '') ? 'AAC' : String(track.codecs || '音频').split('.')[0];
    syncQualityBtn();
    setPlayIcon(true);
    setPlaybackStatus('播放中');
    B.setTrayTip(it.title); // 托盘悬停时显示当前曲目
    if (it.split) mergeAdjacentIdentified(it.splitBatch);
    renderList();
    renderQueue();
    return true;
  } catch (e) {
    if (ticket !== playback.sequence) return false;
    setPlaybackStatus('播放失败 · 点击重试', true);
    setPlayIcon(false);
    toast('播放失败：' + e.message);
    return false;
  }
}

async function recoverPlayback() {
  const current = playback.current;
  if (!current || playback.recovering || current.ticket !== playback.sequence) return;
  if (current.attempts >= 2) { setPlaybackStatus('播放中断 · 点击重试', true); return; }
  playback.recovering = true;
  // lastPosition is updated synchronously by explicit seeks. Taking the maximum
  // with currentTime can resurrect an older forward position after seeking back.
  const position = playback.seekTarget ?? playback.lastPosition;
  const hasBackup = current.urlIndex + 1 < current.urls.length;
  try {
    await playTrack(current.item, current.idx, { recovery: true, position, attempts: current.attempts + 1,
      refresh: !hasBackup, urlIndex: hasBackup ? current.urlIndex + 1 : 0, preview: current.preview });
  } finally { playback.recovering = false; }
}

// 上一首 / 下一首：优先走待播队列，没有队列时退回当前歌单
function step(d) {
  const q = S.queue;
  if (q.length) {
    let n;
    if (S.mode === 'shuffle') {
      const choices = q.map((_item, index) => index).filter(index => q.length === 1 || index !== S.qcur);
      n = choices[Math.floor(Math.random() * choices.length)];
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
  dismissStartupLoginReminder();
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
        toast('登录成功，已更新可用音质');
        checkLogin();
        resumeDownloadsAfterLogin();
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
    if (el.dataset.view === 'home') renderHome(); // 回到首页时刷新最近播放/歌单
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
    agcTimer = null;
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
  el.setAttribute('aria-pressed', String(on));
  el.textContent = '无损优先';
  el.title = (curFormat ? `当前 ${curFormat}${curKbps ? ` · ${curKbps} kbps` : ''}\n` : '')
    + (on ? '无损优先已开启' : '无损优先已关闭') + '，点击切换';
  const actual = $('#actualQuality');
  if (actual) { actual.textContent = ''; actual.hidden = true; }
}
syncQualityBtn();

$('#go').onclick = handleSearch;
$('#kw').onkeydown = (e) => { if (e.key === 'Enter') handleSearch(); };
$('#results').addEventListener('scroll', scheduleSearchMore, { passive: true });
$('#results').addEventListener('wheel', event => { if (event.deltaY > 0) searchScrollIntent(); }, { passive: true });
$('#results').addEventListener('keydown', event => { if (['End', 'PageDown', 'ArrowDown'].includes(event.key)) searchScrollIntent(); });
window.addEventListener('resize', scheduleSearchMore);
const homeScroller = $('#view-home .page');
homeScroller.addEventListener('scroll', scheduleHomeMore, { passive: true });
homeScroller.addEventListener('wheel', event => { if (event.deltaY > 0) homeScrollIntent(); }, { passive: true });
homeScroller.addEventListener('keydown', event => { if (['End', 'PageDown', 'ArrowDown'].includes(event.key)) homeScrollIntent(); });
window.addEventListener('resize', scheduleHomeMore);

// ---------------------------------------------------------------- 分 P 面板事件
$('#addForm').onsubmit = confirmAddDialog;
$('#addCancel').onclick = () => closeAddDialog(null);
$('#addModal').onclick = e => { if (e.target.id === 'addModal') closeAddDialog(null); };
$('#addFolder').onchange = () => {
  $('#addNewWrap').hidden = $('#addFolder').value !== '__new__';
  $('#addError').hidden = true;
  if (!$('#addNewWrap').hidden) $('#addNewName').focus();
};
$('#pmCancel').onclick = closePartsPicker;
$('#partsModal').onclick = (e) => { if (e.target.id === 'partsModal') closePartsPicker(); };
$('#pmAdd').onclick = () => pmCommit('add');
$('#pmPlay').onclick = () => pmCommit('addplay');
$('#pmPlayOnly').onclick = () => pmCommit('play');
$('#pmDownload').onclick = () => pmCommit('download');

// 待播队列面板
$('#qBtn').onclick = () => {
  $('#downloadsPanel').hidden = true;
  $('#tasksPanel').hidden = true;
  const p = $('#queuePanel');
  p.hidden = !p.hidden;
  if (!p.hidden) renderQueue();
};
$('#qClose').onclick = () => { $('#queuePanel').hidden = true; };
$('#qClear').onclick = () => { clearQueue(); toast('待播队列已清空'); };
$('#qSave').onclick = async () => {
  if (!S.queue.length) return toast('待播队列是空的');
  await saveItemsToFolder(S.queue.map(it => ({ ...it })));
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

$('#play').onclick = async () => {
  if (audio.error || (!playback.current && playback.requested)) {
    const last = playback.current || playback.requested;
    if (last) return playTrack(last.item, last.idx, { refresh: true, position: playback.lastPosition });
  }
  if (!audio.src) return step(1);
  try { audio.paused ? await audio.play() : audio.pause(); }
  catch (error) { setPlaybackStatus('播放失败 · 点击重试', true); toast(error.message); }
};
$('#prev').onclick = () => step(-1);
$('#next').onclick = () => step(1);
$('#mode').onclick = () => {
  S.mode = S.mode === 'loop' ? 'single' : S.mode === 'single' ? 'shuffle' : 'loop';
  try { localStorage.playMode = S.mode; } catch (_) {}
  setModeIcon();
  $('#mode').classList.add('on-mode');
  toast({ loop: '列表循环', single: '单曲循环', shuffle: '随机播放' }[S.mode]);
};

audio.onplay = () => setPlayIcon(true);
audio.onpause = () => { clearTimeout(playback.stallTimer); setPlayIcon(false); setPlaybackStatus('已暂停'); };
audio.onplaying = () => { clearTimeout(playback.stallTimer); setPlaybackStatus('播放中'); };
audio.onseeking = () => { scheduleStallRecovery(); };
audio.onseeked = () => {
  if (!playback.current || playback.current.ticket !== playback.sequence || audio.seeking) return;
  if (playback.seekTarget != null && Math.abs(audio.currentTime - playback.seekTarget) > 0.5) return;
  playback.seekTarget = null;
  playback.lastPosition = audio.currentTime;
  if (audio.readyState < 3) scheduleStallRecovery();
  else clearTimeout(playback.stallTimer);
};
audio.onwaiting = () => {
  setPlaybackStatus('正在缓冲…'); scheduleStallRecovery();
};
audio.onerror = () => {
  const ticket = playback.sequence, revision = playback.seekRevision;
  setTimeout(() => { if (ticket === playback.sequence && revision === playback.seekRevision) recoverPlayback(); }, 0);
};
audio.onended = () => {
  if (playback.current?.preview) { audio.pause(); setPlaybackStatus('试听结束'); return; }
  if (S.mode === 'single') {
    seekPlayback(curSplitStart ?? 0);
    audio.play().catch(() => recoverPlayback());
  } else step(1);
};
audio.ontimeupdate = () => {
  if (!audio.duration || !playback.current || playback.current.ticket !== playback.sequence || audio.seeking) return;
  if (playback.seekTarget != null) {
    if (Math.abs(audio.currentTime - playback.seekTarget) > 0.5) return;
    playback.seekTarget = null;
  }
  playback.lastPosition = audio.currentTime;
  const st = curSplitStart, en = curSplitEnd;
  if (st != null && en != null) {
    if (audio.currentTime >= en) {
      if (playback.current?.preview) { audio.pause(); setPlaybackStatus('试听结束'); return; }
      if (S.mode === 'single') seekPlayback(st);
      else if (!splitAdvancing) { splitAdvancing = true; Promise.resolve(step(1)).finally(() => { splitAdvancing = false; }); }
      return;
    } // 这首播完，自动接下一首
    const span = Math.max(1, en - st);
    const pos = Math.max(0, audio.currentTime - st);
    $('#seek').value = String(Math.round(Math.min(1, pos / span) * 1000));
    $('#cur').textContent = fmt(pos);
    $('#dur').textContent = fmt(span);
    return;
  }
  $('#seek').value = String(Math.round((audio.currentTime / audio.duration) * 1000));
  $('#cur').textContent = fmt(audio.currentTime);
  $('#dur').textContent = fmt(audio.duration);
};
$('#seek').oninput = () => {
  const item = playback.current?.item || playback.requested?.item;
  const st = item?.split ? item.startSec : null, en = item?.split ? item.endSec : null;
  if (st != null && en != null) {
    // 分歌曲目：拖动只在自己那一段里走
    seekPlayback(st + ($('#seek').value / 1000) * (en - st));
    return;
  }
  const duration = playbackDuration(item);
  if (duration) seekPlayback(($('#seek').value / 1000) * duration);
};
// 音量走感知曲线：滑块位置 → 音量 = 位置²
// 线性映射时低端一动就从"还能听"掉到"没声"，平方后低端变化平缓、好微调，高端变化也更明显
const volFromPos = (pos) => {
  const t = Math.max(0, Math.min(100, +pos || 0)) / 100;
  return t * t;
};
const posFromVol = (v) => Math.round(Math.sqrt(Math.max(0, Math.min(1, +v || 0))) * 100);
$('#vol').oninput = () => setUserVolume(volFromPos($('#vol').value));
$('#loginClose').onclick = () => {
  cancelPendingDownloadLogin();
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
  if (!$('#startupLoginModal').hidden) {
    if (e.key === 'Escape') { e.preventDefault(); dismissStartupLoginReminder(); }
    if (e.key === 'Tab') {
      const controls = [...$('#startupLoginModal').querySelectorAll('button')].filter(el => !el.disabled);
      const index = controls.indexOf(document.activeElement);
      if (index < 0 || (e.shiftKey ? index === 0 : index === controls.length - 1)) {
        e.preventDefault(); controls[e.shiftKey ? controls.length - 1 : 0].focus();
      }
    }
    return;
  }
  if (!$('#downloadLoginModal').hidden || !$('#downloadPickerModal').hidden) return;
  if (!$('#editModal').hidden || !$('#reviewModal').hidden) return;
  if (!$('#addModal').hidden) {
    if (e.key === 'Escape') { e.preventDefault(); closeAddDialog(null); }
    if (e.key === 'Tab') {
      const controls = Array.from($('#addModal').querySelectorAll('button, input, select'))
        .filter(el => !el.disabled && el.getClientRects().length);
      const index = controls.indexOf(document.activeElement);
      if (controls.length && (index < 0 || (e.shiftKey ? index === 0 : index === controls.length - 1))) {
        e.preventDefault();
        controls[e.shiftKey ? controls.length - 1 : 0].focus();
      }
    }
    return;
  }
  if (e.key === 'Escape') {
    if (!$('#confirmModal').hidden) return closeConfirm(false);
    if (!$('#settingsModal').hidden) return closeSettings();
    if (!$('#partsModal').hidden) return closePartsPicker();
    if (!$('#loginModal').hidden) return $('#loginClose').click();
  }
  if (e.code === 'Space' && !e.target.closest('input, textarea, select, button, [contenteditable]')) {
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
initWorkflows();
initDownloads();
initStartupLoginReminder();
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
