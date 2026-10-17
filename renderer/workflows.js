// Persistent task feedback and reversible library operations. No network calls at load time.
const splitTasks = new Map();
let reviewTask = null;
let editResolve = null;
let undoAction = null;
const librarySelection = new Set();
let librarySelecting = false;
let libraryQuery = '';
let searchFilter = 'all';
let searchSort = 'relevance';
let searchAudience = 'music';
let selectedResult = null;
let reviewAudio = null;
let reviewSequence = 0;
function stopReviewAudio() {
  reviewSequence++;
  if (reviewAudio) { reviewAudio.pause(); reviewAudio.removeAttribute('src'); reviewAudio.load(); reviewAudio = null; }
}
async function listenReviewTrack(task, track) {
  stopReviewAudio();
  const ticket = reviewSequence;
  audio.pause();
  await ensureCid(task.item);
  const stream = await B.playurl(task.item.bvid, task.item.cid);
  if (ticket !== reviewSequence) return;
  const sample = new Audio(); reviewAudio = sample;
  sample.src = pickTrack(stream).url;
  sample.addEventListener('loadedmetadata', () => { if (ticket === reviewSequence) sample.currentTime = track.start; }, { once: true });
  sample.ontimeupdate = () => { if (sample.currentTime >= track.end) sample.pause(); };
  await sample.play();
}
function uniqueId() { return 'f' + Date.now() + Math.random().toString(36).slice(2, 9); }
function setPlayIcon(playing) {
  $('#play').innerHTML = playing ? '<svg viewBox="0 0 24 24"><path d="M8 5v14M16 5v14" stroke="currentColor" stroke-width="4"/></svg>' : '<svg viewBox="0 0 24 24"><path d="M8 4v16l13-8Z" fill="currentColor"/></svg>';
  $('#play').setAttribute('aria-label', playing ? '暂停' : '播放');
}
function setModeIcon() {
  const button = $('#mode');
  const label = { loop: '列表循环', single: '单曲循环', shuffle: '随机播放' }[S.mode];
  button.innerHTML = S.mode === 'shuffle' ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 5h3c5 0 7 14 12 14h3m-4-4 4 4-4 4M3 19h3c2 0 4-4 6-7m3-5c1-1 2-2 4-2h2m-4-4 4 4-4 4"/></svg>'
    : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="m16 2 4 4-4 4M4 10V8a2 2 0 0 1 2-2h14M8 22l-4-4 4-4m12 0v2a2 2 0 0 1-2 2H4"/>${S.mode === 'single' ? '<path d="M11 9h2v6"/>' : ''}</svg>`;
  button.title = label; button.setAttribute('aria-label', label);
}
function offerUndo(label, action) {
  undoAction = action;
  $('#undoText').textContent = label;
  $('#undoBar').hidden = false;
}
function editText(title, value = '', label = '名称') {
  if (editResolve) closeEdit(null);
  $('#editTitle').textContent = title;
  $('#editLabel').textContent = label;
  $('#editValue').value = value;
  $('#editModal').hidden = false;
  $('#editValue').focus(); $('#editValue').select();
  return new Promise(resolve => { editResolve = resolve; });
}
function closeEdit(value) {
  $('#editModal').hidden = true;
  const resolve = editResolve; editResolve = null;
  if (resolve) resolve(value);
}
function taskProgress(progress) {
  const task = splitTasks.get(progress.requestId);
  if (!task || task.state !== 'running') return;
  task.progress = progress;
  renderTasks();
}
function setActivityIndicator(selector, state, label) {
  const button = $(selector);
  button.dataset.state = state;
  button.querySelector('.activity-dot').hidden = state === 'idle';
  const status = { idle: '', running: '进行中', attention: '待处理', error: '有任务失败' }[state];
  button.title = label + (status ? ` · ${status}` : '');
  button.setAttribute('aria-label', button.title);
}
function renderTasks() {
  const list = [...splitTasks.values()];
  const state = list.some(task => task.state === 'error') ? 'error' : list.some(task => task.state === 'ready') ? 'attention' : list.some(task => task.state === 'running') ? 'running' : 'idle';
  setActivityIndicator('#taskBtn', state, '分歌任务');
  $('#taskEmpty').hidden = !!list.length;
  $('#taskList').innerHTML = list.map(task => {
    const p = task.progress || {};
    const status = task.state === 'ready' ? `待确认 · ${task.result.tracks.length} 首，识别 ${task.result.named || 0} 首`
      : task.state === 'error' ? task.error : task.state === 'cancelled' ? '已取消，原曲目保留'
      : ({ queued: '排队等待分析', download: `正在下载 ${p.pct || 0}%`, analyze: '正在分析歌曲间隔', identify: `正在识别 ${p.done || 0}/${p.total || '?'}`, lyrics: `正在转写唱词 ${(+p.done || 0) + 1}/${p.total || '?'}`, cached: '正在读取分析结果' }[p.stage] || '正在准备…');
    return `<div class="task-card"><strong>${esc(task.item.title)}</strong><small>${esc(status)}</small>
      ${task.state === 'running' && p.stage === 'download' ? `<progress max="100" value="${Number(p.pct) || 0}"></progress>` : ''}
      <div class="task-actions">${task.state === 'running' ? `<button data-cancel="${task.id}">取消</button>` : ''}
      ${task.state === 'ready' ? `<button class="primary" data-review="${task.id}">查看并确认</button>` : ''}
      ${['error', 'cancelled'].includes(task.state) ? `<button data-retry="${task.id}">重试</button>` : ''}
      ${task.state !== 'running' ? `<button data-dismiss="${task.id}">移除任务</button>` : ''}</div></div>`;
  }).join('');
  $('#taskList').onclick = async event => {
    const button = event.target.closest('button'); if (!button) return;
    const id = button.dataset.cancel || button.dataset.review || button.dataset.retry || button.dataset.dismiss;
    const task = splitTasks.get(id); if (!task) return;
    if (button.dataset.cancel) {
      task.state = 'cancelled'; renderTasks();
      await B.splitCancel(id).catch(() => {});
    } else if (button.dataset.review) openSplitReview(task);
    else if (button.dataset.retry) { splitTasks.delete(id); maybeSplit(task.folder, task.item, task.description); }
    else { splitTasks.delete(id); renderTasks(); }
  };
  try { localStorage.splitTaskDrafts = JSON.stringify(list.map(task => ({ folderId: task.folder.id, key: itemKey(task.item),
    description: task.description, state: task.state, result: task.result, error: task.error }))); } catch (_) {}
}
async function runSplitTask(f, item, description) {
  if ([...splitTasks.values()].some(t => t.item === item && ['running', 'ready'].includes(t.state))) { $('#tasksPanel').hidden = false; return; }
  if (!f.items.includes(item)) return;
  if (splitTasks.size >= 20) { toast('任务列表已满，请先确认或移除旧任务'); return; }
  const task = { id: uniqueId(), folder: f, item, description, state: 'running' };
  splitTasks.set(task.id, task); $('#tasksPanel').hidden = false; renderTasks();
  try {
    const result = await B.splitAnalyze(item.bvid, item.cid, undefined, description, task.id);
    if (task.state === 'cancelled') return;
    if (!f.items.includes(item)) throw new Error('原曲目已移除，请重新添加后分析');
    if (result.tracks?.length < 2) throw new Error('没有发现明显分曲间隔，整段已保留');
    task.result = result; task.state = 'ready';
  } catch (error) { if (task.state !== 'cancelled') { task.state = 'error'; task.error = error.message; } }
  renderTasks();
}
function restorePendingTasks() {
  try {
    const drafts = JSON.parse(localStorage.splitTaskDrafts || '[]');
    if (!Array.isArray(drafts)) return;
    for (const draft of drafts.slice(0, 20)) {
      const f = S.folders.find(folder => folder.id === draft.folderId), item = f?.items.find(candidate => itemKey(candidate) === draft.key);
      if (!item) continue;
      let state = draft.state === 'ready' ? 'ready' : draft.state === 'cancelled' ? 'cancelled' : 'error';
      if (state === 'ready') {
        try { LibraryModel.validateTracks(draft.result.tracks, draft.result.duration || draft.result.tracks.at(-1).end); }
        catch (_) { state = 'error'; }
      }
      const task = { id: uniqueId(), folder: f, item, description: String(draft.description || ''), state,
        result: draft.result, error: draft.error || '上次分析已中断，可以重试' };
      splitTasks.set(task.id, task);
    }
  } catch (_) {}
  renderTasks();
}
function restoreSplitBatch(f, original, batch) {
  const replace = list => {
    const first = list.findIndex(item => item.splitBatch === batch);
    if (first < 0) return list;
    const items = list.filter(item => item.splitBatch !== batch);
    items.splice(first, 0, { ...original }); return items;
  };
  if (S.folders.includes(f)) f.items = replace(f.items);
  const current = S.queue[S.qcur], currentKey = current && itemKey(current);
  S.queue = replace(S.queue);
  if (current?.splitBatch === batch) {
    S.qcur = S.queue.findIndex(item => sourceKey(item) === sourceKey(original) && !item.split);
    curSplitStart = null; curSplitEnd = null;
    $('#bTitle').textContent = original.title;
    if (playback.current) playback.current.item = S.queue[S.qcur] || original;
  } else if (currentKey) S.qcur = S.queue.findIndex(item => itemKey(item) === currentKey);
  S.cur = folder()?.items.findIndex(item => S.queue[S.qcur] && itemKey(item) === itemKey(S.queue[S.qcur])) ?? -1;
}
async function restoreWholeVideo(f, item) {
  const parts = f.items.filter(candidate => candidate.split && sourceKey(candidate) === sourceKey(item));
  if (!parts.length || !await askConfirm('恢复整段', `把 ${parts.length} 个分段合并回完整视频，可撤销。`, '恢复整段')) return;
  const oldQueue = S.queue.slice();
  const original = { ...item, title: item.vtitle || item.title, duration: item.originalDuration || Math.max(...parts.map(part => part.endSec)) };
  for (const key of ['split', 'splitBatch', 'startSec', 'endSec', 'identifySource', 'artist', 'referenceArtist', 'originalDuration']) delete original[key];
  const batch = uniqueId();
  for (const list of [f.items, S.queue]) for (const candidate of list) if (candidate.split && sourceKey(candidate) === sourceKey(item)) candidate.splitBatch = batch;
  restoreSplitBatch(f, original, batch); save(); renderList(); renderFolders(); renderQueue();
  offerUndo('已恢复完整视频', () => {
    const current = S.queue[S.qcur], currentKey = current && itemKey(current);
    const restore = list => {
      const index = list.findIndex(candidate => !candidate.split && sourceKey(candidate) === sourceKey(item));
      if (index >= 0) list.splice(index, 1, ...parts);
    };
    if (S.folders.includes(f)) restore(f.items);
    const index = S.queue.findIndex(candidate => !candidate.split && sourceKey(candidate) === sourceKey(item));
    if (index >= 0) S.queue.splice(index, 1, ...oldQueue.filter(candidate => candidate.split && sourceKey(candidate) === sourceKey(item)));
    if (current && !current.split && sourceKey(current) === sourceKey(item) && index >= 0) {
      const active = S.queue.findIndex(candidate => candidate.split && sourceKey(candidate) === sourceKey(item) && audio.currentTime >= candidate.startSec && audio.currentTime < candidate.endSec);
      S.qcur = active >= 0 ? active : index;
    } else if (currentKey) S.qcur = S.queue.findIndex(candidate => itemKey(candidate) === currentKey);
    syncCurrentSegment();
  });
}
function syncCurrentSegment() {
  const current = S.queue[S.qcur];
  if (current) {
    curSplitStart = current.split ? current.startSec : null; curSplitEnd = current.split ? current.endSec : null;
    $('#bTitle').textContent = current.title;
    if (playback.current && sourceKey(playback.current.item) === sourceKey(current)) {
      playback.current.item = current;
      playback.current.idx = folder()?.items.findIndex(item => itemKey(item) === itemKey(current)) ?? -1;
    }
  }
}
async function deleteFolder(f) {
  if (S.folders.length < 2) return toast('至少保留一个歌单');
  if (!await askConfirm('删除歌单', `删除《${f.name}》及其中 ${f.items.length} 首，可撤销。`, '删除')) return;
  if (!S.folders.includes(f) || S.folders.length < 2) return;
  const index = S.folders.indexOf(f);
  S.folders.splice(index, 1);
  if (S.active === f.id) S.active = S.folders[0].id;
  librarySelection.clear(); save(); renderFolders(); renderList();
  offerUndo('歌单已删除', () => { if (!S.folders.some(folder => folder.id === f.id)) S.folders.splice(Math.min(index, S.folders.length), 0, f); });
}
function openSplitReview(task) {
  reviewTask = { task, tracks: task.result.tracks.map(t => ({ ...t })) };
  $('#reviewTitle').textContent = task.item.title;
  $('#reviewWarning').textContent = (task.result.warnings || []).join('；');
  $('#reviewModal').hidden = false;
  renderReview();
  $('#reviewRows').querySelector('input')?.focus();
}
function renderReview() {
  $('#reviewRows').innerHTML = reviewTask.tracks.map((track, i) => `<div class="review-row" data-index="${i}">
    <span>${i + 1}</span><input class="review-name" aria-label="第 ${i + 1} 首歌名" placeholder="未识别，可填写歌名" value="${esc(track.title || '')}" />
    <span class="review-start">${fmt(track.start)}</span><span>—</span><input class="review-end" aria-label="第 ${i + 1} 首结束时间" value="${timeLabel(track.end)}" />
    <button data-listen="${i}">试听</button><button data-cut="${i}">拆分</button>${i ? `<button data-merge="${i}">合并前首</button>` : ''}</div>`).join('');
}
function timeLabel(seconds) {
  const value = Math.round(Number(seconds) * 10) / 10;
  return `${Math.floor(value / 60)}:${(value % 60).toFixed(1).padStart(4, '0')}`;
}
function readReview() {
  const rows = Array.from($('#reviewRows').querySelectorAll('.review-row'));
  let start = 0;
  const tracks = rows.map((row, i) => {
    const previous = reviewTask.tracks[i];
    const title = row.querySelector('.review-name').value.trim(), end = LibraryModel.duration(row.querySelector('.review-end').value);
    const changed = title !== (previous.title || '') || Math.abs(end - previous.end) > 0.01 || Math.abs(start - previous.start) > 0.01;
    const track = { ...previous, title, start, end, source: changed ? 'manual' : previous.source };
    start = end; return track;
  });
  return LibraryModel.validateTracks(tracks, reviewTask.task.result.duration || reviewTask.task.result.tracks.at(-1).end);
}
function updateLibrarySelection() {
  $('#libSelected').textContent = `已选 ${librarySelection.size} 首`;
  $('#libBatch').hidden = !librarySelecting;
}
async function renameFolder(f) {
  const name = await editText('重命名歌单', f.name);
  if (!name || !S.folders.includes(f)) return;
  if (S.folders.some(other => other !== f && other.name === name)) return toast('已有同名歌单');
  const old = f.name; f.name = name; save(); renderFolders(); renderList();
  offerUndo('歌单已重命名', () => { if (S.folders.includes(f)) f.name = old; });
}
async function renameSong(item) {
  const title = await editText('修改歌名', item.title);
  if (!title) return;
  const old = [];
  for (const list of [...S.folders.map(f => f.items), S.queue]) for (const candidate of list) if (itemKey(candidate) === itemKey(item)) { old.push({ item: candidate, title: candidate.title, source: candidate.identifySource }); candidate.title = title; candidate.identifySource = 'manual'; }
  save(); renderList(); renderQueue();
  if (S.queue[S.qcur] && itemKey(S.queue[S.qcur]) === itemKey(item)) $('#bTitle').textContent = title;
  offerUndo('歌名已修改', () => { for (const entry of old) { entry.item.title = entry.title; entry.item.identifySource = entry.source; } syncCurrentSegment(); });
}
function downloadLibrary() {
  const content = JSON.stringify({ format: 'ccmusic-library', version: 1, folders: S.folders.map(f => ({ name: f.name, items: f.items })) }, null, 2);
  const url = URL.createObjectURL(new Blob([content], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = `ccMusic-歌单-${new Date().toISOString().slice(0, 10)}.json`; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function addNext(items) {
  const existing = new Set(S.queue.map(itemKey));
  const fresh = items.filter(item => { const key = itemKey(item); if (existing.has(key)) return false; existing.add(key); return true; });
  S.queue.splice(Math.max(0, S.qcur + 1), 0, ...fresh.map(item => ({ ...item })));
  save(); renderQueue(); toast(`已添加 ${fresh.length} 首到下一首`);
}
function showSearchHistory() {
  const history = readSearchHistory();
  const list = $('#searchHistory'); list.innerHTML = history.map(text => `<option value="${esc(text)}"></option>`).join('');
}
function rememberSearch(text) {
  const history = readSearchHistory();
  try { localStorage.searchHistory = JSON.stringify([text.slice(0, 240), ...history.filter(value => value !== text)].slice(0, 15)); } catch (_) {}
  showSearchHistory();
}
function readSearchHistory() {
  try { const data = JSON.parse(localStorage.searchHistory || '[]'); return Array.isArray(data) ? data.filter(value => typeof value === 'string').slice(0, 15) : []; }
  catch (_) { return []; }
}
function visibleSearchResults() {
  if (S.searchDirect) return S.results;
  let list = S.results.filter(item => (searchAudience === 'all' || MusicSearch.eligible(item, S.kw))
    && (searchFilter === 'all' || (searchFilter === 'long' ? durSec(item.duration) >= 600 : searchFilter === 'parts' ? item.partsCount > 1 : durSec(item.duration) >= 180 && durSec(item.duration) < 600 && !(item.partsCount > 1))));
  if (searchSort === 'relevance') list = MusicSearch.order(list, S.kw);
  else if (searchSort === 'platform') list = list.slice().sort(MusicSearch.platformCompare);
  else list = list.slice().sort((a, b) => searchSort === 'duration' ? durSec(b.duration) - durSec(a.duration) : (+b.play || 0) - (+a.play || 0));
  return list;
}
function initWorkflows() {
  setPlayIcon(false); setModeIcon(); showSearchHistory();
  $('#taskBtn').onclick = () => { $('#downloadsPanel').hidden = true; $('#queuePanel').hidden = true; $('#tasksPanel').hidden = !$('#tasksPanel').hidden; renderTasks(); };
  $('#tasksClose').onclick = () => { $('#tasksPanel').hidden = true; };
  $('#undoButton').onclick = () => { const action = undoAction; undoAction = null; $('#undoBar').hidden = true; if (action) { action(); save(); renderFolders(); renderList(); renderQueue(); } };
  $('#undoClose').onclick = () => { undoAction = null; $('#undoBar').hidden = true; };
  $('#editCancel').onclick = () => closeEdit(null);
  $('#editForm').onsubmit = event => { event.preventDefault(); const value = $('#editValue').value.trim(); if (value) closeEdit(value); };
  $('#editModal').onclick = event => { if (event.target.id === 'editModal') closeEdit(null); };
  $('#reviewClose').onclick = () => {
    if (reviewTask) {
      try { const tracks = readReview(); reviewTask.task.result = { ...reviewTask.task.result, tracks, named: tracks.filter(track => track.title).length }; renderTasks(); }
      catch (_) { toast('时间范围有误，本次编辑未保存'); }
    }
    stopReviewAudio(); $('#reviewModal').hidden = true; reviewTask = null;
  };
  $('#reviewRows').onclick = async event => {
    const button = event.target.closest('button'); if (!button || !reviewTask) return;
    try {
      reviewTask.tracks = readReview();
      if (button.dataset.merge !== undefined) reviewTask.tracks = LibraryModel.mergeTrack(reviewTask.tracks, +button.dataset.merge);
      else if (button.dataset.cut !== undefined) {
        const index = +button.dataset.cut, at = await editText('添加切点', '', '视频绝对时间，例如 3:25.5');
        if (at == null || !reviewTask) return;
        reviewTask.tracks = LibraryModel.cutTrack(reviewTask.tracks, index, at);
      } else if (button.dataset.listen !== undefined) {
        const track = reviewTask.tracks[+button.dataset.listen];
        await listenReviewTrack(reviewTask.task, track);
        return;
      }
      renderReview();
    } catch (error) { $('#reviewWarning').textContent = error.message; }
  };
  $('#reviewConfirm').onclick = () => {
    if (!reviewTask) return;
    try {
      const tracks = readReview(), task = reviewTask.task;
      if (!S.folders.includes(task.folder) || !task.folder.items.includes(task.item)) throw new Error('原视频或歌单已移除，无法应用');
      applySplitResult(task.folder, task.item, { ...task.result, tracks, named: tracks.filter(t => t.title).length });
      stopReviewAudio();
      splitTasks.delete(task.id); renderTasks(); $('#reviewModal').hidden = true; reviewTask = null;
    } catch (error) { $('#reviewWarning').textContent = error.message; }
  };
  $('#libFilter').oninput = () => { libraryQuery = $('#libFilter').value.trim().toLowerCase(); renderList(); };
  $('#libSelect').onclick = () => { librarySelecting = !librarySelecting; librarySelection.clear(); $('#libSelect').textContent = librarySelecting ? '完成选择' : '多选'; updateLibrarySelection(); renderList(); };
  $('#libAll').onclick = () => { folder().items.filter(libraryMatches).forEach(item => librarySelection.add(itemKey(item))); updateLibrarySelection(); renderList(); };
  $('#libMove').onclick = async () => {
    const f = folder(), selected = f.items.filter(item => librarySelection.has(itemKey(item)));
    if (!selected.length) return toast('先选择曲目');
    const result = await saveItemsToFolder(selected, { allowSplit: false, confirmText: '移动到歌单' });
    if (!result || result.folder === f) return;
    const removed = selected.map(item => ({ item, index: f.items.indexOf(item) }));
    f.items = f.items.filter(item => !selected.includes(item));
    librarySelection.clear(); save(); renderFolders(); renderList(); updateLibrarySelection();
    offerUndo('曲目已移动', () => { if (S.folders.includes(f)) for (const entry of removed) f.items.splice(Math.min(entry.index, f.items.length), 0, entry.item); result.folder.items = result.folder.items.filter(item => !result.added.includes(item)); });
  };
  $('#libRemove').onclick = async () => {
    const f = folder(), selected = f.items.filter(item => librarySelection.has(itemKey(item)));
    if (!selected.length || !await askConfirm('移除选中曲目', `从《${f.name}》移除 ${selected.length} 首，可撤销。`, '移除')) return;
    const removed = selected.map(item => ({ item, index: f.items.indexOf(item) }));
    f.items = f.items.filter(item => !selected.includes(item)); librarySelection.clear(); save(); renderFolders(); renderList(); updateLibrarySelection();
    offerUndo('已移除选中曲目', () => { if (S.folders.includes(f)) for (const entry of removed) f.items.splice(Math.min(entry.index, f.items.length), 0, entry.item); });
  };
  $('#libSort').onchange = () => {
    const f = folder(), old = f.items.slice(), mode = $('#libSort').value;
    if (!mode) return;
    f.items.sort((a, b) => mode === 'duration' ? durSec(a.duration) - durSec(b.duration) : String(mode === 'artist' ? a.artist || a.up : a.title).localeCompare(String(mode === 'artist' ? b.artist || b.up : b.title), 'zh-CN'));
    $('#libSort').value = ''; save(); renderList(); offerUndo('歌单已排序', () => { if (f.items.length === old.length && old.every(item => f.items.includes(item))) f.items = old; });
  };
  $('#libRename').onclick = () => renameFolder(folder());
  $('#libExport').onclick = downloadLibrary;
  $('#libImport').onclick = () => $('#importFile').click();
  $('#importFile').onchange = async () => {
    const file = $('#importFile').files[0]; $('#importFile').value = ''; if (!file) return;
    try {
      if (file.size > 5 * 1024 * 1024) throw new Error('歌单文件不能超过 5 MB');
      const imported = LibraryModel.importedFolders(JSON.parse(await file.text()));
      if (!await askConfirm('导入歌单', `新增 ${imported.length} 个歌单，现有歌单保留。`, '导入')) return;
      const added = imported.map(f => ({ ...f, id: uniqueId() }));
      S.folders.push(...added); save(); renderFolders();
      offerUndo('歌单已导入', () => { S.folders = S.folders.filter(f => !added.includes(f)); if (!S.folders.some(f => f.id === S.active)) S.active = S.folders[0].id; });
      toast(`已导入 ${added.length} 个歌单`);
    } catch (error) { toast('导入失败：' + error.message); }
  };
  $('#searchFilter').onchange = () => { searchFilter = $('#searchFilter').value; renderResults(); };
  $('#searchAudience').onchange = () => { searchAudience = $('#searchAudience').value; renderResults(); };
  $('#searchSort').onchange = () => { searchSort = $('#searchSort').value; renderResults(); };
  $('#clearSearch').onclick = () => { $('#kw').value = ''; $('#kw').focus(); };
  $('#playStatus').onclick = () => { const last = playback.current || playback.requested; if (last) playTrack(last.item, last.idx, { refresh: true, position: playback.lastPosition }); };
  document.addEventListener('keydown', event => {
    const modal = !$('#editModal').hidden ? $('#editModal') : !$('#reviewModal').hidden ? $('#reviewModal') : null;
    if (modal && event.key === 'Tab') {
      const controls = Array.from(modal.querySelectorAll('button, input, select')).filter(el => !el.disabled && el.getClientRects().length);
      const index = controls.indexOf(document.activeElement);
      if (controls.length && (index < 0 || (event.shiftKey ? index === 0 : index === controls.length - 1))) {
        event.preventDefault(); controls[event.shiftKey ? controls.length - 1 : 0].focus();
      }
    }
    if (event.key !== 'Escape') return;
    if (!$('#editModal').hidden) { event.preventDefault(); event.stopImmediatePropagation(); closeEdit(null); }
    else if (!$('#reviewModal').hidden) { event.preventDefault(); event.stopImmediatePropagation(); $('#reviewClose').click(); }
  });
}
function libraryMatches(item) {
  return !libraryQuery || `${item.title} ${item.artist || ''} ${item.up || ''} ${item.vtitle || ''}`.toLowerCase().includes(libraryQuery);
}
