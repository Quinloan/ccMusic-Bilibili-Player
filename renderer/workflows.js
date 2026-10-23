// Persistent task feedback and reversible library operations. No network calls at load time.
const splitTasks = new Map();
const taskDismissTimers = new Map();
const TASK_DONE_VISIBLE_MS = 5000;
const coverRequests = new Map();
const titleRequests = new Map();
const metadataQueue = LibraryModel.createMetadataQueue({ concurrency: 2, timeout: 25000 });
// Cache provider work, but apply its result once to each new live item instance.
// A removed/re-added song has the same key and a different object.
function consumeMetadata(entry, item, apply) {
  if (!entry.consumers.has(item)) entry.consumers.set(item, entry.promise.then(apply).catch(() => null));
  return entry.consumers.get(item);
}
function needsSongTitle(item, force = false) {
  if (!item || item.identifySource === 'manual') return false;
  if (item.split ? (!force && item.identifySource !== 'description') : (item.identifySource && item.identifySource !== 'title')) return false;
  const part = item.partTitle || (+item.page || 1) > 1 || (item.vtitle && item.vtitle !== (item.sourceTitle || item.title));
  const duration = LibraryModel.duration(item.duration);
  if (!item.split && !part && (!(duration > 0) || duration >= 600)) return false;
  const intent = LibraryModel.songTitleIntent({ title: item.sourceTitle || item.partTitle || item.title, parentTitle: part ? item.vtitle : '', ...(item.split && force && item.artist ? { artist: item.artist } : {}) });
  return !!intent && (force || item.titleMetaVersion !== (intent.metadataVersion || 2));
}
function requestSongTitle(item, options = {}) {
  if (!needsSongTitle(item, !!options.force)) return Promise.resolve(null);
  const input = { title: item.sourceTitle || item.partTitle || item.title,
    parentTitle: item.vtitle !== (item.sourceTitle || item.title) ? item.vtitle || '' : '',
    ...(item.split && options.force && item.artist ? { artist: item.artist } : {}) };
  const key = itemKey(item), token = input.title + '|' + input.parentTitle + '|' + (input.artist || '');
  let entry = titleRequests.get(key);
  if (entry?.token !== token || Date.now() - entry.at >= 15 * 60000 || (options.force && entry.settled) ||
    (entry.settled && (entry.skipped || (!entry.result?.name && !entry.consumers.has(item))))) {
    entry = { token, force: !!options.force, at: Date.now(), consumers: new WeakMap(), applied: new WeakSet() };
    entry.work = metadataQueue.add(async () => {
      const live = [...S.folders.flatMap(f => f.items), ...S.queue].find(candidate => itemKey(candidate) === key && needsSongTitle(candidate, entry.force));
      if (!live || titleRequests.get(key) !== entry) { entry.skipped = true; return null; }
      return B.resolveSongTitle({ ...input, ...(entry.force ? { refresh: true, priority: 10 } : {}) });
    }, options.force ? 10 : options.priority || 0);
    entry.promise = entry.work.then(result => { entry.result = result; entry.settled = true; return result; });
    titleRequests.delete(key); titleRequests.set(key, entry);
    while (titleRequests.size > 2000) titleRequests.delete(titleRequests.keys().next().value);
  }
  if (options.force) entry.force = true;
  entry.work.promote(options.force ? 10 : options.priority || 0);
  return consumeMetadata(entry, item, result => {
    if (!result?.name || titleRequests.get(key) !== entry) return null;
    const targets = new Set([...S.folders.flatMap(f => f.items), ...S.queue, playback.current?.item, playback.requested?.item]
      .filter(candidate => candidate && !!candidate.split === !!item.split && itemKey(candidate) === key &&
        !entry.applied.has(candidate) && (candidate.identifySource === 'manual' || needsSongTitle(candidate, entry.force))));
    let changed = false;
    for (const candidate of targets) {
      if (candidate.identifySource !== 'manual' && (candidate.sourceTitle || candidate.partTitle || candidate.title) !== input.title) continue;
      if (!result.matched && (candidate.titleMetaVersion >= 2 || (candidate.split && candidate.identifySource))) continue;
      entry.applied.add(candidate);
      if (candidate.identifySource !== 'manual') {
        candidate.sourceTitle = input.title;
        candidate.title = String(result.name).trim().slice(0, 500);
        candidate.artist = String(result.artist || '').slice(0, 300);
        if (candidate.identifySource !== 'description' && !(candidate.split && candidate.identifySource)) candidate.identifySource = 'title';
        delete candidate.neteaseId; delete candidate.songCover; delete candidate.titleMetaVersion;
        if (result.matched) candidate.titleMetaVersion = LibraryModel.songTitleIntent(input)?.metadataVersion || 2;
        changed = true;
      }
      // Invalidate an older cover-only request before replacing the identity.
      coverRequests.delete(key);
      if (/^\d{1,20}$/.test(String(result.neteaseId || ''))) { candidate.neteaseId = String(result.neteaseId); changed = true; }
      const cover = LibraryModel.songCoverUrl(result.cover);
      if (cover) { candidate.songCover = cover; changed = true; }
    }
    if (changed) {
      const playing = playback.current?.item || S.queue[S.qcur];
      if (playing && itemKey(playing) === key) {
        $('#bTitle').textContent = playing.title; $('#bUp').textContent = songArtist(playing); B.setTrayTip(playing.title);
      }
      save(); renderList(); renderQueue(); refreshSongCoverImages();
    }
    return result;
  });
}
function queueSongTitles(items) { items.forEach(item => requestSongTitle(item)); }
const metadataParseJobs = new Map();
async function parseSongMetadata(items) {
  // Older builds did not persist the constituent cuts. Recover only matching,
  // unexpired fingerprint cache entries; never infer history from song names alone.
  const historyCandidates = items.filter(item => item.split && !item.boundaryLocked && ['netease', 'shazam'].includes(item.identifySource) && LibraryModel.fragmentRanges(item).length === 1);
  if (historyCandidates.length && B.splitHistory) try {
    const queries = historyCandidates.map(({ bvid, cid, startSec, endSec, title, artist, neteaseId }) => ({ bvid, cid, startSec, endSec, title, artist, neteaseId }));
    const histories = await B.splitHistory(queries);
    if (Array.isArray(histories)) for (let i = 0; i < historyCandidates.length; i++) {
      const item = historyCandidates[i], ranges = histories[i];
      if (!Array.isArray(ranges) || LibraryModel.fragmentRanges({ ...item, splitFragments: ranges }).length < 2) continue;
      for (const candidate of [...S.folders.flatMap(f => f.items), ...S.queue]) if (candidate.split && candidate.splitBatch === item.splitBatch && itemKey(candidate) === itemKey(item) && !candidate.boundaryLocked && ['netease', 'shazam'].includes(candidate.identifySource) &&
        candidate.title === queries[i].title && candidate.artist === queries[i].artist && candidate.neteaseId === queries[i].neteaseId) candidate.splitFragments = ranges;
    }
  } catch (_) {} // Missing/expired history keeps the conservative original rule.
  // Repair already identified duplicates immediately, before catalog lookups queue.
  for (const batch of new Set(items.filter(item => item.split).map(item => item.splitBatch))) mergeAdjacentIdentified(batch);
  const live = [...S.folders.flatMap(f => f.items), ...S.queue];
  items = items.map(item => item.split && !live.includes(item) ? live.find(candidate => candidate.splitBatch === item.splitBatch &&
    sourceKey(candidate) === sourceKey(item) && candidate.startSec <= item.startSec && candidate.endSec >= item.endSec) || item : item);
  const unique = [...new Map(items.map(item => [itemKey(item), item])).values()];
  const unnamed = unique.filter(item => item.split && item.identifySource !== 'manual' && !needsSongTitle(item, true));
  if (unnamed.length) return Promise.all([retrySplitMetadata(unnamed), unique.length > unnamed.length ? parseSongMetadata(unique.filter(item => !unnamed.includes(item))) : Promise.resolve()]);
  const eligible = unique.filter(item => needsSongTitle(item, true));
  if (!eligible.length) { toast(unique.some(item => item.identifySource === 'manual') ? '已保留手动修改的歌曲信息' : '没有明确的单曲标题可供解析'); return Promise.resolve(); }
  const key = eligible.map(itemKey).sort().join('|');
  if (metadataParseJobs.has(key)) { $('#tasksPanel').hidden = false; toast('这些歌曲正在解析中'); return metadataParseJobs.get(key); }
  toast(`正在解析 ${eligible.length} 首，匹配后逐首更新`);
  const progress = { done: 0, total: eligible.length, title: eligible[0].vtitle || eligible[0].title };
  const job = (async () => {
    let matched = 0, missed = 0;
    for (const item of eligible) {
      if (![...S.folders.flatMap(f => f.items), ...S.queue].includes(item) || item.identifySource === 'manual') { progress.done++; renderTasks(); continue; }
      const result = await requestSongTitle(item, { force: true });
      progress.done++; renderTasks();
      if (item.identifySource === 'manual' || ![...S.folders.flatMap(f => f.items), ...S.queue].includes(item)) continue;
      if (result?.matched) matched++; else missed++;
    }
    for (const batch of new Set(eligible.filter(item => item.split).map(item => item.splitBatch))) mergeAdjacentIdentified(batch);
    toast(`解析完成，匹配 ${matched} 首${missed ? `，${missed} 首暂未匹配` : ''}`);
    return { matched, missed };
  })().finally(() => {
    metadataParseJobs.delete(key); renderTasks();
    if (!metadataParseJobs.size && !splitTasks.size) $('#tasksPanel').hidden = true;
  });
  job.progress = progress;
  metadataParseJobs.set(key, job);
  $('#downloadsPanel').hidden = true; $('#queuePanel').hidden = true; $('#tasksPanel').hidden = false;
  renderTasks(); return job;
}
let coverScanFrame = null;
const itemCover = item => LibraryModel.songCoverUrl(item?.songCover) || item?.cover || '';
function setSongCover(image, item) {
  image.dataset.fallback = item?.cover || '';
  const desired = itemCover(item);
  image.src = image.dataset.failedCover === desired ? item?.cover || '' : desired;
}
function refreshSongCoverImages() {
  for (const image of document.querySelectorAll('#list .row:not(.group) img, #queueList .qcover')) {
    const row = image.closest('[data-i]');
    const item = image.classList.contains('qcover') ? S.queue[+row.dataset.i] : folder()?.items[+row.dataset.i];
    if (item && image.getAttribute('src') !== itemCover(item)) setSongCover(image, item);
  }
  const playing = playback.current?.item || S.queue[S.qcur];
  if (playing) setSongCover($('#bCover'), playing);
}
function requestSongCover(item, match) {
  if (!item) return Promise.resolve('');
  if (!match && needsSongTitle(item)) { requestSongTitle(item, { priority: 1 }); return Promise.resolve(''); }
  if (LibraryModel.songCoverUrl(item.songCover)) return Promise.resolve(item.songCover);
  if (!match && !item.neteaseId && !['netease', 'shazam', 'lyrics', 'description', 'title'].includes(item.identifySource)) return Promise.resolve('');
  const input = match || { name: item.title, artist: item.artist || item.referenceArtist || '', neteaseId: item.neteaseId };
  const key = itemKey(item), token = input.neteaseId || `${input.name}|${input.artist}`;
  let entry = coverRequests.get(key);
  if (entry?.token !== token || Date.now() - entry.at >= 15 * 60000 ||
    (entry.settled && !entry.result && !entry.consumers.has(item))) {
    entry = { token, at: Date.now(), consumers: new WeakMap(), applied: new WeakSet() };
    entry.promise = metadataQueue.add(() => B.songCover(input), 1).catch(() => '')
      .then(result => { entry.result = result; entry.settled = true; return result; });
    coverRequests.delete(key); coverRequests.set(key, entry);
    while (coverRequests.size > 2000) coverRequests.delete(coverRequests.keys().next().value);
  }
  return consumeMetadata(entry, item, value => {
    const url = LibraryModel.songCoverUrl(value);
    if (!url || coverRequests.get(key) !== entry) return '';
    // Look up live items, never reinsert an item removed or undone during lookup.
    const targets = new Set([...S.folders.flatMap(f => f.items), ...S.queue, playback.current?.item, playback.requested?.item]
      .filter(candidate => candidate && itemKey(candidate) === key && !entry.applied.has(candidate)));
    for (const candidate of targets) { candidate.songCover = url; entry.applied.add(candidate); }
    if (targets.size) { save(); refreshSongCoverImages(); }
    return url;
  });
}
function scheduleVisibleSongCovers() {
  if (coverScanFrame !== null) return;
  coverScanFrame = requestAnimationFrame(() => {
    coverScanFrame = null;
    for (const row of document.querySelectorAll('#list .row:not(.group), #queueList .q-row')) {
      const rect = row.getBoundingClientRect();
      if (!rect.width || !rect.height || rect.bottom <= 0 || rect.top >= innerHeight - 76) continue;
      const item = row.classList.contains('q-row') ? S.queue[+row.dataset.i] : folder()?.items[+row.dataset.i];
      requestSongCover(item);
    }
  });
}
let reviewTask = null;
const pendingSplitReviews = new Map();
let splitReviewTimer = null;
let editResolve = null;
let songInfoEdit = null;
let undoAction = null;
let undoTimer = null;
let undoRemaining = 0;
let undoExpiresAt = 0;
const UNDO_VISIBLE_MS = 6000;
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
  clearTimeout(undoTimer); undoTimer = null;
  undoAction = action;
  $('#undoText').textContent = label;
  $('#undoBar').hidden = false;
  undoRemaining = UNDO_VISIBLE_MS;
  resumeUndoTimer();
}
function dismissUndo() {
  clearTimeout(undoTimer); undoTimer = null; undoAction = null;
  $('#undoBar').hidden = true;
}
function pauseUndoTimer() {
  if (undoTimer === null) return;
  clearTimeout(undoTimer); undoTimer = null;
  undoRemaining = Math.max(0, undoExpiresAt - Date.now());
}
function resumeUndoTimer() {
  const bar = $('#undoBar');
  if (bar.hidden || bar.matches(':hover') || bar.contains(document.activeElement)) return;
  clearTimeout(undoTimer);
  undoExpiresAt = Date.now() + undoRemaining;
  undoTimer = setTimeout(dismissUndo, undoRemaining);
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
  const task = splitTasks.get(progress.requestId) || [...splitTasks.values()].find(t => t.runId === progress.requestId);
  if (!task || task.state !== 'running') return;
  task.progress = progress;
  if (task.batch && progress.track) applyRecognizedTrack(task, progress.index, progress.track);
  renderTasks();
}
function batchItems(task) {
  if (!task.batch) return [];
  return S.folders.flatMap(f => f.items).filter(item => item.splitBatch === task.batch);
}
function applyRecognizedTrack(task, index, track) {
  const expected = task.result.tracks[index];
  if (!expected || expected.start !== track.start || expected.end !== track.end) return;
  task.result.tracks[index] = { ...track, checked: true };
  if (!track.title) return;
  const keyMatches = item => item?.splitBatch === task.batch && item.startSec === track.start && item.endSec === track.end;
  // A user edit wins even if it was made while this request was in flight.
  const targets = new Set([...S.folders.flatMap(f => f.items), ...S.queue, playback.current?.item, playback.requested?.item].filter(keyMatches));
  for (const item of targets) if (item.identifySource !== 'manual' && !(item.titleMetaVersion >= 2 && track.source === 'description' && item.sourceTitle === track.title)) Object.assign(item, {
    title: track.title, artist: track.artist || '', identifySource: track.source || '', referenceArtist: track.referenceArtist || '',
  });
  const cover = LibraryModel.songCoverUrl(track.songCover);
  for (const item of targets) {
    if (/^\d{1,20}$/.test(String(track.neteaseId || ''))) item.neteaseId = String(track.neteaseId);
    if (cover) item.songCover = cover;
  }
  syncCurrentSegment();
  const playing = playback.current?.item || S.queue[S.qcur];
  if (keyMatches(playing)) { $('#bTitle').textContent = playing.title; $('#bUp').textContent = songArtist(playing); B.setTrayTip(playing.title); }
  save(); renderList(); renderQueue();
  refreshSongCoverImages();
  const target = [...targets][0];
  if (target) {
    if (needsSongTitle(target)) requestSongTitle(target);
    else requestSongCover(target, { name: track.title, artist: track.artist || track.referenceArtist || '', neteaseId: track.neteaseId });
  }
  mergeAdjacentIdentified(task.batch);
}
function refreshMergedPlayback(current) {
  if (current) S.qcur = S.queue.indexOf(current);
  syncCurrentSegment();
  S.cur = folder()?.items.findIndex(item => current && itemKey(item) === itemKey(current)) ?? -1;
  updateLibrarySelection();
  save(); renderFolders(); renderList(); renderQueue(); refreshSongCoverImages();
}
function mergeAdjacentIdentified(batch) {
  if (!batch) return;
  const operations = [];
  let current = S.queue[S.qcur];
  const lists = [...S.folders.map(f => f.items), S.queue];
  for (const f of S.folders) for (let i = 0; i + 1 < f.items.length; i++) {
    const left = f.items[i], right = f.items[i + 1];
    if (left.splitBatch !== batch || !LibraryModel.canMergeFragments(left, right)) continue;
    const same = (item, ref) => item?.splitBatch === batch && itemKey(item) === itemKey(ref);
    if (!playback.current && (same(playback.requested?.item, left) || same(playback.requested?.item, right))) continue;
    if (lists.flat().some(item => (same(item, left) || same(item, right)) && (item.identifySource === 'manual' || item.boundaryLocked))) continue;
    for (const list of lists) for (let j = 0; j < list.length; j++) {
      if (!same(list[j], left) && !same(list[j], right)) continue;
      const old = [list[j]];
      if (same(list[j], left) && same(list[j + 1], right)) old.push(list[j + 1]);
      const joined = { ...list[j], ...left, startSec: left.startSec, endSec: right.endSec,
        duration: +(right.endSec - left.startSec).toFixed(3), songCover: left.songCover || right.songCover,
        splitFragments: [...LibraryModel.fragmentRanges(left), ...LibraryModel.fragmentRanges(right)] };
      list.splice(j, old.length, joined); operations.push({ list, old, joined });
      if (old.includes(current)) current = joined;
      const selected = old.some(item => librarySelection.has(itemKey(item)));
      old.forEach(item => librarySelection.delete(itemKey(item)));
      if (selected) librarySelection.add(itemKey(joined));
    }
    i--; // A third short fragment can join the same recording.
  }
  if (!operations.length) return;
  refreshMergedPlayback(current);
  offerUndo('已合并相邻的同曲片段', () => {
    let playing = S.queue[S.qcur];
    for (const { list, old, joined } of operations.slice().reverse()) {
      if (!lists.includes(list) || (list !== S.queue && !S.folders.some(f => f.items === list))) continue;
      const at = list.indexOf(joined); if (at < 0) continue; // Never resurrect removed rows.
      const restored = old.map(item => {
        item.boundaryLocked = true;
        if (joined.identifySource === 'manual') Object.assign(item, { title: joined.title, artist: joined.artist, identifySource: 'manual' });
        return item;
      });
      list.splice(at, 1, ...restored);
      if (playing === joined) playing = restored.find(item => audio.currentTime >= item.startSec && audio.currentTime < item.endSec) || restored[0];
      const selected = librarySelection.delete(itemKey(joined));
      if (selected) restored.forEach(item => librarySelection.add(itemKey(item)));
    }
    refreshMergedPlayback(playing);
  });
}
function wholeSourceItem(item) {
  const whole = { ...item, title: item.vtitle || item.title, duration: item.originalDuration || item.endSec };
  for (const key of ['split', 'splitBatch', 'splitFragments', 'boundaryLocked', 'startSec', 'endSec', 'identifySource', 'artist', 'referenceArtist', 'songCover', 'neteaseId', 'sourceTitle', 'titleMetaVersion']) delete whole[key];
  return whole;
}
async function retrySplitMetadata(items) {
  const groups = new Map();
  for (const item of items) {
    const f = S.folders.find(f => f.items.some(candidate => candidate.split && itemKey(candidate) === itemKey(item)));
    if (!f) { toast('请先将待识别片段加入歌单'); continue; }
    const key = f.id + '|' + sourceKey(item) + '|' + (item.splitBatch || '');
    if (!groups.has(key)) groups.set(key, { f, item, selected: new Set() });
    groups.get(key).selected.add(itemKey(item));
  }
  await Promise.all([...groups.values()].map(async ({ f, item, selected }) => {
    const active = [...splitTasks.values()].find(task => task.batch && task.batch === item.splitBatch && task.state === 'running');
    if (active) { $('#tasksPanel').hidden = false; toast('这些片段正在识别中'); return; }
    if (splitTasks.size >= 20) { toast('任务列表已满，请先处理旧任务'); return; }
    const parts = f.items.filter(candidate => candidate.split && sourceKey(candidate) === sourceKey(item) && candidate.splitBatch === item.splitBatch).sort((a, b) => a.startSec - b.startSec);
    const batch = item.splitBatch || uniqueId();
    for (const candidate of [...parts, ...S.queue.filter(candidate => parts.some(part => itemKey(part) === itemKey(candidate)))]) candidate.splitBatch = batch;
    const seconds = Number(item.originalDuration) || Math.max(...parts.map(part => part.endSec));
    const tracks = []; let end = 0;
    for (const part of parts) {
      if (part.startSec < end - 0.15) { toast('片段时间有重叠，请先重新分歌'); return; }
      if (part.startSec > end + 0.15) tracks.push({ start: end, end: part.startSec, checked: true });
      const retry = selected.has(itemKey(part)) && part.identifySource !== 'manual';
      tracks.push({ start: part.startSec, end: part.endSec, title: retry ? '' : part.title, artist: part.artist || '',
        source: part.identifySource, checked: !retry, refresh: retry, boundaryLocked: part.boundaryLocked }); end = part.endSec;
    }
    if (end < seconds - 0.15) tracks.push({ start: end, end: seconds, checked: true });
    const task = { id: uniqueId(), folder: f, item: wholeSourceItem(item), batch, description: '', state: 'ready', result: { tracks, duration: seconds } };
    splitTasks.set(task.id, task); $('#tasksPanel').hidden = false;
    await runRecognitionTask(task);
  }));
}
async function resplitVideo(f, item) {
  const previous = f.items.filter(candidate => candidate.split && sourceKey(candidate) === sourceKey(item));
  if (!previous.length) return;
  for (const batch of new Set(previous.map(part => part.splitBatch))) stopBatchRecognition(batch);
  const original = wholeSourceItem(item);
  let description = '';
  try { const meta = await B.video(item.bvid); if ((meta.parts?.length || 1) === 1) description = meta.desc || ''; } catch (_) {}
  if (!previous.every(part => f.items.includes(part))) return toast('原分段已变更，请重试');
  return runSplitTask(f, original, description, previous);
}
function undoResplit(f, previous, oldQueue, batch) {
  stopBatchRecognition(batch);
  const current = S.queue[S.qcur], key = current && itemKey(current);
  const restore = (list, old) => {
    const at = list.findIndex(item => item.splitBatch === batch);
    if (at < 0) return;
    for (let i = list.length - 1; i >= 0; i--) if (list[i].splitBatch === batch) list.splice(i, 1);
    list.splice(at, 0, ...old);
  };
  if (S.folders.includes(f)) restore(f.items, previous);
  restore(S.queue, oldQueue.filter(item => previous.some(part => itemKey(part) === itemKey(item))));
  const playing = current?.splitBatch === batch ? S.queue.find(item => item.split && sourceKey(item) === sourceKey(current) && audio.currentTime >= item.startSec && audio.currentTime < item.endSec) : S.queue.find(item => itemKey(item) === key);
  refreshMergedPlayback(playing);
}
function stopBatchRecognition(batch) {
  if (!batch) return;
  for (const task of splitTasks.values()) if (task.batch === batch) {
    const id = task.runId; task.runId = null; task.state = 'cancelled';
    if (id) B.splitCancel(id).catch(() => {});
    dismissTaskNotice(task.id);
    splitTasks.delete(task.id);
  }
  renderTasks();
}
async function runRecognitionTask(task) {
  if (!batchItems(task).length) { task.state = 'cancelled'; renderTasks(); return; }
  queueSongTitles(batchItems(task));
  const runId = uniqueId(); task.runId = runId; task.state = 'running'; task.error = ''; task.progress = { stage: 'identify', done: 0, total: task.result.tracks.length };
  // Include current manual edits and finished rows when resuming a partial task.
  const tracks = task.result.tracks.map(track => {
    const current = batchItems(task).find(item => item.startSec === track.start && item.endSec === track.end);
    if (!current) return { ...track, checked: true };
    if (current.identifySource === 'manual') return { ...track, title: current.title, artist: current.artist || '', source: 'manual' };
    return { ...track };
  });
  if (tracks.every(track => track.title || track.checked)) {
    task.runId = null; task.state = 'done';
    if (task.result.sessionId) B.splitRelease(task.result.sessionId).catch(() => {});
    renderTasks(); notifySplitReady(task); return;
  }
  renderTasks();
  try {
    const result = await B.splitAnalyze(task.item.bvid, task.item.cid, undefined, task.description, runId,
      { mode: 'recognize', sessionId: task.result.sessionId, tracks });
    if (task.runId !== runId || task.state !== 'running') return;
    // Also reconcile the response if the renderer missed a progress event.
    result.tracks.forEach((track, index) => applyRecognizedTrack(task, index, track));
    task.result.warnings = result.warnings || []; task.state = 'done';
    notifySplitReady(task);
  } catch (error) {
    if (task.runId !== runId || task.state !== 'running') return;
    task.state = 'error'; task.error = error.message;
  }
  if (task.runId === runId) { task.runId = null; renderTasks(); }
}
function setActivityIndicator(selector, state, label) {
  const button = $(selector);
  button.dataset.state = state;
  button.querySelector('.activity-dot').hidden = state === 'idle';
  const status = { idle: '', running: '进行中', attention: '待处理', error: '有任务失败' }[state];
  button.title = label + (status ? ` · ${status}` : '');
  button.setAttribute('aria-label', button.title);
}
function dismissTaskNotice(id) {
  for (const notice of $('#completionNotices').children) if (notice.dataset.task === id) notice.remove();
}
function dismissSplitTask(task, automatic = false) {
  if (splitTasks.get(task.id) !== task || task.state === 'running') return;
  clearTimeout(taskDismissTimers.get(task.id)); taskDismissTimers.delete(task.id);
  splitTasks.delete(task.id); dismissTaskNotice(task.id);
  pendingSplitReviews.delete(task.id);
  if (task.result?.sessionId) B.splitRelease(task.result.sessionId).catch(() => {});
  renderTasks();
  if (automatic && !splitTasks.size && !metadataParseJobs.size) $('#tasksPanel').hidden = true;
}
function notifySplitReady(task) {
  dismissTaskNotice(task.id);
  if (task.state === 'ready') { queueSplitReview(task); return; }
  const notice = document.createElement('div');
  notice.className = 'completion-notice'; notice.dataset.task = task.id; notice.setAttribute('role', 'status');
  const complete = task.state === 'done';
  const named = batchItems(task).filter(item => item.identifySource && item.identifySource !== 'manual').length;
  notice.innerHTML = `<button class="notice-close" aria-label="关闭完成提醒">×</button><strong>${complete ? '识曲完成' : '切分完成'}</strong><p title="${esc(task.item.title)}">${esc(task.item.title)}</p><small>${complete ? `已识别 ${named} 首${task.result.warnings?.length ? ' · 部分识别暂时不可用' : ''}` : `${task.result.tracks.length} 首待加入歌单`}</small><button class="notice-review">${complete ? '查看歌单' : '查看分段'}</button>`;
  notice.querySelector('.notice-close').onclick = () => notice.remove();
  notice.querySelector('.notice-review').onclick = () => {
    notice.remove();
    if (splitTasks.get(task.id) !== task) return;
    if (complete) {
      const target = S.folders.find(f => f.items.some(item => item.splitBatch === task.batch));
      if (target) { S.active = target.id; showView('library'); save(); renderFolders(); renderList(); }
      return;
    }
    if (task.state !== 'ready') return;
    if (!splitTaskSourcePresent(task)) return toast('原曲目已移除或变更');
    openSplitReview(task);
  };
  $('#completionNotices').appendChild(notice);
  while ($('#completionNotices').children.length > 2) $('#completionNotices').firstElementChild.remove();
}
function renderTasks() {
  const list = [...splitTasks.values()];
  for (const [id, timer] of taskDismissTimers) if (splitTasks.get(id)?.state !== 'done') {
    clearTimeout(timer); taskDismissTimers.delete(id);
  }
  for (const task of list) if (task.state === 'done' && !taskDismissTimers.has(task.id)) {
    taskDismissTimers.set(task.id, setTimeout(() => dismissSplitTask(task, true), TASK_DONE_VISIBLE_MS));
  }
  const state = list.some(task => task.state === 'error') ? 'error' : list.some(task => task.state === 'ready') ? 'attention' : list.some(task => task.state === 'running') || metadataParseJobs.size ? 'running' : 'idle';
  setActivityIndicator('#taskBtn', state, '后台任务');
  $('#taskEmpty').hidden = !!(list.length || metadataParseJobs.size);
  const metadataCards = [...metadataParseJobs.values()].map(job => `<div class="task-card"><strong>${esc(job.progress.title)}</strong><small>正在解析歌曲信息 ${job.progress.done}/${job.progress.total}</small><progress max="${job.progress.total}" value="${job.progress.done}"></progress></div>`).join('');
  $('#taskList').innerHTML = metadataCards + list.map(task => {
    const p = task.progress || {};
    const status = task.state === 'ready' ? `${task.result.tracks.length} 首待加入`
      : task.state === 'done' ? '识曲完成' : task.state === 'error' ? task.error : task.state === 'cancelled' ? (task.batch ? '识曲已停止，已加入的曲目保留' : '已取消，原曲目保留')
      : ({ queued: task.batch ? '排队等待识曲' : '排队等待解析', download: `正在智能解析 ${p.pct || 0}%`, analyze: '正在智能解析', identify: `正在识别 ${p.done || 0}/${p.total || '?'}`, lyrics: `正在转写唱词 ${(+p.done || 0) + 1}/${p.total || '?'}`, cached: '正在读取解析结果' }[p.stage] || '正在准备…');
    return `<div class="task-card">${task.state !== 'running' ? `<button class="task-dismiss" data-dismiss="${task.id}" aria-label="关闭任务" title="关闭任务">×</button>` : ''}<strong>${esc(task.item.title)}</strong><small>${esc(status)}</small>
      ${task.state === 'running' && p.stage === 'download' ? `<progress max="100" value="${Number(p.pct) || 0}"></progress>` : ''}
      ${task.state !== 'done' ? `<div class="task-actions">${task.state === 'running' ? `<button data-cancel="${task.id}">取消</button>` : ''}
      ${task.state === 'ready' ? `<button class="primary" data-review="${task.id}">加入歌单…</button>` : ''}
      ${['error', 'cancelled'].includes(task.state) ? `<button data-retry="${task.id}">${task.batch ? '继续识曲' : '重试'}</button>` : ''}
      </div>` : ''}</div>`;
  }).join('');
  $('#taskList').onclick = async event => {
    const button = event.target.closest('button'); if (!button) return;
    const id = button.dataset.cancel || button.dataset.review || button.dataset.retry || button.dataset.dismiss;
    const task = splitTasks.get(id); if (!task) return;
    if (button.dataset.cancel) {
      task.state = 'cancelled'; renderTasks();
      const requestId = task.runId || id; task.runId = null;
      await B.splitCancel(requestId).catch(() => {});
    } else if (button.dataset.review) { dismissTaskNotice(task.id); openSplitReview(task); }
    else if (button.dataset.retry) {
      if (task.batch) runRecognitionTask(task);
      else { splitTasks.delete(id); if (task.previous) runSplitTask(task.folder, task.item, task.description, task.previous); else maybeSplit(task.folder, task.item, task.description); }
    }
    else dismissSplitTask(task);
  };
  try { localStorage.splitTaskDrafts = JSON.stringify(list.filter(task => task.state !== 'done').map(task => ({ folderId: task.folder.id, key: itemKey(task.item),
    description: task.description, state: task.state, result: task.result, error: task.error, batch: task.batch, original: task.batch || task.previous ? task.item : undefined,
    previousKeys: task.previous?.map(itemKey) }))); } catch (_) {}
}
function splitTaskSourcePresent(task) {
  return S.folders.includes(task.folder) && (task.previous ? task.previous.length > 0 && task.previous.every(item => task.folder.items.includes(item)) : task.folder.items.includes(task.item));
}
async function runSplitTask(f, item, description, previous = null) {
  if ([...splitTasks.values()].some(t => (t.item === item || (previous && t.previous && t.folder === f && sourceKey(t.item) === sourceKey(item))) && ['running', 'ready'].includes(t.state))) { $('#downloadsPanel').hidden = true; $('#queuePanel').hidden = true; $('#tasksPanel').hidden = false; return; }
  if (previous ? !previous.every(part => f.items.includes(part)) : !f.items.includes(item)) return;
  if (splitTasks.size >= 20) { toast('任务列表已满，请先确认或移除旧任务'); return; }
  const task = { id: uniqueId(), folder: f, item, description, previous, state: 'running' };
  splitTasks.set(task.id, task); $('#downloadsPanel').hidden = true; $('#queuePanel').hidden = true; $('#tasksPanel').hidden = false; renderTasks();
  try {
    const result = await B.splitAnalyze(item.bvid, item.cid, undefined, description, task.id, { mode: 'split' });
    if (task.state === 'cancelled' || !splitTaskSourcePresent(task) || result.tracks?.length < 2) {
      if (result.sessionId) B.splitRelease(result.sessionId).catch(() => {});
    }
    if (task.state === 'cancelled') return;
    if (!splitTaskSourcePresent(task)) throw new Error('原曲目已移除或变更，请重新分析');
    if (result.tracks?.length < 2) throw new Error('没有发现明显分曲间隔，整段已保留');
    task.result = result; task.state = 'ready';
  } catch (error) { if (task.state !== 'cancelled') { task.state = 'error'; task.error = error.message; } }
  renderTasks();
  if (task.state === 'ready') notifySplitReady(task);
}
function restorePendingTasks() {
  try {
    const drafts = JSON.parse(localStorage.splitTaskDrafts || '[]');
    if (!Array.isArray(drafts)) return;
    for (const draft of drafts.slice(0, 20)) {
      if (draft.state === 'done') continue;
      const f = draft.batch ? S.folders.find(folder => folder.items.some(item => item.splitBatch === draft.batch)) : S.folders.find(folder => folder.id === draft.folderId);
      const previous = Array.isArray(draft.previousKeys) ? draft.previousKeys.map(key => f?.items.find(item => itemKey(item) === key)) : null;
      if (previous?.some(item => !item)) continue;
      const item = draft.batch || previous ? draft.original : f?.items.find(candidate => itemKey(candidate) === draft.key);
      if (!f || !item) continue;
      let state = draft.state === 'ready' ? 'ready' : draft.state === 'cancelled' ? 'cancelled' : 'error';
      if (draft.batch) LibraryModel.validateTracks(draft.result.tracks, draft.result.duration, 1);
      if (state === 'ready') {
        try { LibraryModel.validateTracks(draft.result.tracks, draft.result.duration || draft.result.tracks.at(-1).end); }
        catch (_) { state = 'error'; }
      }
      const task = { id: uniqueId(), folder: f, item, description: String(draft.description || ''), state,
        result: draft.result, batch: draft.batch, previous, error: draft.error || (draft.batch ? '上次识曲已中断，已加入的曲目保留' : '上次分析已中断，可以重试') };
      if (task.result) delete task.result.sessionId;
      splitTasks.set(task.id, task);
    }
  } catch (_) {}
  renderTasks();
  for (const task of splitTasks.values()) if (task.state === 'ready') queueSplitReview(task);
}
function restoreSplitBatch(f, original, batch) {
  stopBatchRecognition(batch);
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
  for (const batch of new Set(parts.map(part => part.splitBatch))) stopBatchRecognition(batch);
  const oldQueue = S.queue.slice();
  const original = { ...item, title: item.vtitle || item.title, duration: item.originalDuration || Math.max(...parts.map(part => part.endSec)) };
  for (const key of ['split', 'splitBatch', 'splitFragments', 'boundaryLocked', 'startSec', 'endSec', 'identifySource', 'artist', 'referenceArtist', 'originalDuration', 'songCover', 'neteaseId', 'sourceTitle', 'partTitle', 'titleMetaVersion']) delete original[key];
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
    $('#bUp').textContent = songArtist(current);
    setSongCover($('#bCover'), current);
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
function canReviewSplit(task) {
  return splitTasks.get(task.id) === task && task.state === 'ready' && task.result?.tracks?.length >= 2
    && splitTaskSourcePresent(task);
}
function queueSplitReview(task) {
  if (!canReviewSplit(task) || reviewTask?.task === task) return;
  pendingSplitReviews.set(task.id, task);
  scheduleSplitReview();
}
function scheduleSplitReview() {
  if (!pendingSplitReviews.size || splitReviewTimer !== null) return;
  splitReviewTimer = setTimeout(() => {
    splitReviewTimer = null;
    for (const [id, task] of pendingSplitReviews) if (!canReviewSplit(task)) pendingSplitReviews.delete(id);
    if (reviewTask || document.querySelector('.modal:not([hidden])')) return;
    const task = pendingSplitReviews.values().next().value;
    if (task) openSplitReview(task);
  }, 0);
}
function openSplitReview(task) {
  if (!canReviewSplit(task) || reviewTask?.task === task) return;
  if (reviewTask || document.querySelector('.modal:not([hidden])')) { queueSplitReview(task); return; }
  pendingSplitReviews.delete(task.id);
  dismissTaskNotice(task.id);
  $('#tasksPanel').hidden = true;
  reviewTask = { task, tracks: task.result.tracks.map(t => ({ ...t })), adjusting: false };
  $('#reviewTitle').textContent = task.item.title;
  setReviewWarning((task.result.warnings || []).join('；'));
  $('#reviewModal').hidden = false;
  renderReview();
  $('#reviewConfirm').focus();
}
function setReviewWarning(text) {
  $('#reviewWarning').textContent = text;
  $('#reviewWarning').hidden = !text;
}
function renderReview() {
  const { tracks, adjusting } = reviewTask;
  $('#reviewHeading').textContent = `已分成 ${tracks.length} 首`;
  $('.review-box').classList.toggle('adjusting', adjusting);
  $('#reviewAdjust').textContent = adjusting ? '完成调整' : '调整分段';
  $('#reviewAdjust').setAttribute('aria-expanded', String(adjusting));
  $('#reviewHint').textContent = adjusting ? '可修改结束时间，或拆分、合并分段。' : '加入歌单后自动识别歌名。';
  $('#reviewRows').innerHTML = tracks.map((track, i) => `<div class="review-row" data-index="${i}">
    <div class="review-track">
      ${adjusting ? `<input class="review-name" aria-label="第 ${i + 1} 首歌名" placeholder="曲目 ${i + 1}（待识别）" value="${esc(track.title || '')}" />`
        : `<span class="review-track-title" title="${esc(track.title || `曲目 ${i + 1}（待识别）`)}">${track.title ? esc(track.title) : `曲目 ${i + 1}<span class="review-pending">（待识别）</span>`}</span>`}
      <span class="review-duration">${fmt(track.end - track.start)}</span>
      <button data-listen="${i}" aria-label="试听第 ${i + 1} 首">试听</button>
    </div>
    ${adjusting ? `<div class="review-edit"><span class="review-start">${timeLabel(track.start)}</span><span>至</span><input class="review-end" aria-label="第 ${i + 1} 首结束时间" value="${timeLabel(track.end)}" />
      <div class="review-edit-actions"><button data-cut="${i}">拆分</button>${i ? `<button data-merge="${i}">与前一首合并</button>` : ''}</div></div>` : ''}
    </div>`).join('');
}
function timeLabel(seconds) {
  const value = Math.round(Number(seconds) * 10) / 10;
  return `${Math.floor(value / 60)}:${(value % 60).toFixed(1).padStart(4, '0')}`;
}
function readReview() {
  const seconds = reviewTask.task.result.duration || reviewTask.task.result.tracks.at(-1).end;
  if (!reviewTask.adjusting) return LibraryModel.validateTracks(reviewTask.tracks, seconds);
  const rows = Array.from($('#reviewRows').querySelectorAll('.review-row'));
  let start = 0;
  const tracks = rows.map((row, i) => {
    const previous = reviewTask.tracks[i];
    const title = row.querySelector('.review-name').value.trim(), end = LibraryModel.duration(row.querySelector('.review-end').value);
    const changed = title !== (previous.title || '');
    const track = { ...previous, title, start, end, source: changed ? 'manual' : previous.source,
      boundaryLocked: !!previous.boundaryLocked || previous.start !== start || previous.end !== end };
    start = end; return track;
  });
  return LibraryModel.validateTracks(tracks, seconds);
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
function editSongInfo(item) {
  songInfoEdit = { key: itemKey(item), item, focus: document.activeElement };
  $('#songInfoTitle').value = item.title || '';
  $('#songInfoArtist').value = item.artist || '';
  $('#songInfoModal').hidden = false;
  $('#songInfoTitle').focus(); $('#songInfoTitle').select();
}
function closeSongInfo() {
  const focus = songInfoEdit?.focus;
  songInfoEdit = null; $('#songInfoModal').hidden = true;
  if (focus?.isConnected) focus.focus();
}
function saveSongInfo() {
  const title = $('#songInfoTitle').value.trim(), artist = $('#songInfoArtist').value.trim();
  if (!songInfoEdit || !title) { $('#songInfoTitle').focus(); return; }
  const { key, item } = songInfoEdit;
  const saved = [...S.folders.flatMap(f => f.items), ...S.queue].filter(candidate => itemKey(candidate) === key);
  if (!saved.length) { closeSongInfo(); toast('曲目已移除，请重新选择'); return; }
  if (title === item.title && Object.hasOwn(item, 'artist') && artist === (item.artist || '')) { closeSongInfo(); return; }
  const targets = new Set([...saved, playback.current?.item, playback.requested?.item].filter(candidate => candidate && itemKey(candidate) === key));
  const fields = ['title', 'artist', 'identifySource'];
  const old = [...targets].map(candidate => ({ item: candidate, values: Object.fromEntries(fields.filter(field => Object.hasOwn(candidate, field)).map(field => [field, candidate[field]])) }));
  for (const candidate of targets) Object.assign(candidate, { title, artist, identifySource: 'manual' });
  const refreshPlaying = () => {
    const playing = playback.current?.item || S.queue[S.qcur];
    if (playing && itemKey(playing) === key) {
      $('#bTitle').textContent = playing.title; $('#bUp').textContent = songArtist(playing);
      B.setTrayTip(playing.title);
    }
  };
  closeSongInfo(); refreshPlaying(); save(); renderList(); renderQueue();
  offerUndo('歌曲信息已修改', () => {
    for (const entry of old) for (const field of fields) {
      if (Object.hasOwn(entry.values, field)) entry.item[field] = entry.values[field];
      else delete entry.item[field];
    }
    refreshPlaying();
  });
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
  const modalObserver = new MutationObserver(scheduleSplitReview);
  for (const modal of document.querySelectorAll('.modal')) modalObserver.observe(modal, { attributes: true, attributeFilter: ['hidden'] });
  document.addEventListener('scroll', scheduleVisibleSongCovers, true);
  document.addEventListener('error', event => {
    const image = event.target;
    if (image.tagName !== 'IMG' || !image.dataset.fallback || image.getAttribute('src') === image.dataset.fallback) return;
    image.dataset.failedCover = image.getAttribute('src'); image.src = image.dataset.fallback;
  }, true);
  setPlayIcon(false); setModeIcon(); showSearchHistory();
  $('#taskBtn').onclick = () => { $('#downloadsPanel').hidden = true; $('#queuePanel').hidden = true; $('#tasksPanel').hidden = !$('#tasksPanel').hidden; renderTasks(); };
  $('#tasksClose').onclick = () => { $('#tasksPanel').hidden = true; };
  $('#undoButton').onclick = () => { const action = undoAction; dismissUndo(); if (action) { action(); save(); renderFolders(); renderList(); renderQueue(); } };
  $('#undoClose').onclick = dismissUndo;
  $('#undoBar').onmouseenter = pauseUndoTimer;
  $('#undoBar').onmouseleave = resumeUndoTimer;
  $('#undoBar').addEventListener('focusin', pauseUndoTimer);
  $('#undoBar').addEventListener('focusout', () => queueMicrotask(resumeUndoTimer));
  $('#editCancel').onclick = () => closeEdit(null);
  $('#editForm').onsubmit = event => { event.preventDefault(); const value = $('#editValue').value.trim(); if (value) closeEdit(value); };
  $('#editModal').onclick = event => { if (event.target.id === 'editModal') closeEdit(null); };
  $('#songInfoCancel').onclick = closeSongInfo;
  $('#songInfoForm').onsubmit = event => { event.preventDefault(); saveSongInfo(); };
  $('#songInfoModal').onclick = event => { if (event.target.id === 'songInfoModal') closeSongInfo(); };
  $('#reviewAdjust').onclick = () => {
    if (!reviewTask) return;
    try {
      reviewTask.tracks = readReview(); reviewTask.adjusting = !reviewTask.adjusting;
      setReviewWarning(''); renderReview();
      if (reviewTask.adjusting) $('#reviewRows').querySelector('input')?.focus();
    } catch (error) { setReviewWarning(error.message); }
  };
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
    } catch (error) { setReviewWarning(error.message); }
  };
  $('#reviewConfirm').onclick = () => {
    if (!reviewTask) return;
    try {
      const tracks = readReview(), task = reviewTask.task;
      if (!splitTaskSourcePresent(task)) throw new Error('原视频或歌单已移除或变更，无法应用');
      task.result = { ...task.result, tracks, named: tracks.filter(t => t.title).length };
      S.active = task.folder.id; showView('library');
      task.batch = applySplitResult(task.folder, task.item, task.result, task.previous);
      task.previous = null;
      stopReviewAudio();
      dismissTaskNotice(task.id); $('#reviewModal').hidden = true; reviewTask = null;
      runRecognitionTask(task);
    } catch (error) { setReviewWarning(error.message); }
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
    f.items.sort((a, b) => mode === 'duration' ? durSec(a.duration) - durSec(b.duration) : String(mode === 'artist' ? songArtist(a) : a.title).localeCompare(String(mode === 'artist' ? songArtist(b) : b.title), 'zh-CN'));
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
  const refreshSearchFilter = () => { searchIdlePages = 0; searchAutoPaused = false; renderResults(); };
  $('#searchFilter').onchange = () => { searchFilter = $('#searchFilter').value; refreshSearchFilter(); };
  $('#searchAudience').onchange = () => { searchAudience = $('#searchAudience').value; refreshSearchFilter(); };
  $('#searchSort').onchange = () => { searchSort = $('#searchSort').value; renderResults(); };
  $('#clearSearch').onclick = () => { $('#kw').value = ''; $('#kw').focus(); };
  $('#playStatus').onclick = () => { const last = playback.current || playback.requested; if (last) playTrack(last.item, last.idx, { refresh: true, position: playback.lastPosition }); };
  document.addEventListener('keydown', event => {
    const modal = !$('#songInfoModal').hidden ? $('#songInfoModal') : !$('#editModal').hidden ? $('#editModal') : !$('#reviewModal').hidden ? $('#reviewModal') : null;
    if (modal && event.key === 'Tab') {
      const controls = Array.from(modal.querySelectorAll('button, input, select')).filter(el => !el.disabled && el.getClientRects().length);
      const index = controls.indexOf(document.activeElement);
      if (controls.length && (index < 0 || (event.shiftKey ? index === 0 : index === controls.length - 1))) {
        event.preventDefault(); controls[event.shiftKey ? controls.length - 1 : 0].focus();
      }
    }
    if (event.key !== 'Escape') return;
    if (!$('#songInfoModal').hidden) { event.preventDefault(); event.stopImmediatePropagation(); closeSongInfo(); }
    else if (!$('#editModal').hidden) { event.preventDefault(); event.stopImmediatePropagation(); closeEdit(null); }
    else if (!$('#reviewModal').hidden) { event.preventDefault(); event.stopImmediatePropagation(); $('#reviewClose').click(); }
  });
}
function libraryMatches(item) {
  return !libraryQuery || `${item.title} ${item.artist || ''} ${item.up || ''} ${item.vtitle || ''}`.toLowerCase().includes(libraryQuery);
}
