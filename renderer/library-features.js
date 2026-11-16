function specialFolder(kind, name) {
  let entry = S.folders.find(f => f.kind === kind);
  if (!entry) {
    entry = { id: uniqueId(), name, kind, items: [] };
    S.folders.push(entry);
  }
  return entry;
}
function openSpecialFolder(kind, name) {
  const entry = specialFolder(kind, name);
  S.active = entry.id;
  libraryQuery = ''; librarySelection.clear(); $('#libFilter').value = '';
  save(); renderFolders(); renderList(); showView('library');
  return entry;
}
function updateLikeButton() {
  const item = playback.current?.item || playback.requested?.item;
  const liked = !!item && !!S.folders.find(f => f.kind === 'likes')?.items.some(t => itemKey(t) === itemKey(item));
  $('#likeButton').textContent = liked ? '♥' : '♡';
  $('#likeButton').setAttribute('aria-pressed', String(liked));
  $('#likeButton').title = liked ? '取消喜欢' : '加入我喜欢';
  $('#likeButton').disabled = !item;
}
function toggleLike() {
  const item = playback.current?.item || playback.requested?.item;
  if (!item) return toast('先选择一首歌曲');
  const liked = specialFolder('likes', '我喜欢');
  const index = liked.items.findIndex(t => itemKey(t) === itemKey(item));
  if (index >= 0) liked.items.splice(index, 1);
  else liked.items.push({ ...item });
  save(); updateLikeButton(); renderFolders(); renderList();
  toast(index >= 0 ? '已取消喜欢' : '已加入我喜欢');
}
function syncLibraryTools() {
  const f = folder();
  $('#likedNav').classList.toggle('on', S.view === 'library' && f?.kind === 'likes');
  $('#localNav').classList.toggle('on', S.view === 'library' && f?.kind === 'local');
  $('#libRename').disabled = !!f?.kind;
  $('#libRename').hidden = !!f?.kind;
  $('#libSync').hidden = !f?.sourceUrl;
  $('#localScan').hidden = f?.kind !== 'local';
  $('#libPickDownload').disabled = f?.kind === 'local';
  $('#libPickDownload').hidden = f?.kind === 'local';
  updateLikeButton();
}
function canRememberPosition(item) {
  // A split song uses its own length, not the length of its source compilation.
  const seconds = item.split ? item.endSec - item.startSec : LibraryModel.duration(item.duration);
  return Number.isFinite(seconds) && seconds >= 30 * 60;
}
function captureListeningPosition() {
  const current = playback.current;
  if (!current || current.preview || current.ticket !== playback.sequence) return;
  const item = current.item;
  const position = audio.seeking ? playback.lastPosition : playbackTime();
  if (!Number.isFinite(position)) return;
  S.positions ||= {};
  const end = item.split ? item.endSec : (Number(item.duration) || audio.duration);
  const key = itemKey(item);
  if (canRememberPosition(item) && position > (item.startSec || 0) + 1 && !(end > 0 && position >= end - 2)) S.positions[key] = position;
  else delete S.positions[key];
  S.positions = Object.fromEntries(Object.entries(S.positions).slice(-500));
  S.lastPlayed = { item: { ...item } };
}
function rememberedPosition(item) {
  const start = item.split ? item.startSec : 0;
  if (!canRememberPosition(item)) {
    if (S.positions) delete S.positions[itemKey(item)];
    return start;
  }
  const position = S.positions?.[itemKey(item)];
  const end = item.split ? item.endSec : Number(item.duration);
  return Number.isFinite(position) && position >= start && (!(end > 0) || position < end - 2) ? position : start;
}
function restoreListeningPosition() {
  let item;
  try { item = LibraryModel.importedFolders({ folders: [{ name: '恢复', items: [S.lastPlayed?.item] }] })[0].items[0]; }
  catch (_) { return; }
  const index = S.queue.findIndex(t => itemKey(t) === itemKey(item));
  if (index >= 0) { S.qcur = index; item = S.queue[index]; }
  else { S.queue.push(item); S.qcur = S.queue.length - 1; }
  const position = rememberedPosition(item);
  playback.requested = { item, idx: -1, position };
  playback.lastPosition = position;
  $('#bTitle').textContent = item.title; $('#bUp').textContent = songArtist(item);
  setSongCover($('#bCover'), item);
  $('#cur').textContent = fmt(position - (item.startSec || 0));
  $('#dur').textContent = fmt(item.duration);
  $('#seek').value = item.duration ? String(Math.round((position - (item.startSec || 0)) / item.duration * 1000)) : '0';
  refreshMiniRanges();
}

function bindSongDragging(container, items, rerender) {
  let dragging = null;
  container.querySelectorAll('.row, .q-row').forEach(row => {
    row.draggable = container.id === 'queueList' || !librarySelecting;
    row.querySelectorAll('img').forEach(image => { image.draggable = false; });
  });
  const rowRange = row => ({ start: Number(row.dataset.start ?? row.dataset.i), count: Number(row.dataset.count || 1) });
  container.ondragstart = event => {
    if (event.target.closest('button, input')) { event.preventDefault(); return; }
    const row = event.target.closest('.row, .q-row');
    if (!row) return;
    dragging = { ...rowRange(row), entries: items.slice(rowRange(row).start, rowRange(row).start + rowRange(row).count) };
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', 'ccMusic');
    row.classList.add('dragging');
  };
  container.ondragover = event => {
    if (!dragging) return;
    event.preventDefault();
    container.querySelector('.drop-before')?.classList.remove('drop-before');
    const row = event.target.closest('.row, .q-row');
    if (row) row.classList.add('drop-before');
  };
  container.ondragend = () => {
    dragging = null;
    container.querySelectorAll('.dragging, .drop-before').forEach(row => row.classList.remove('dragging', 'drop-before'));
  };
  container.ondrop = event => {
    event.preventDefault();
    const row = event.target.closest('.row, .q-row');
    if (!dragging || !row || dragging.entries.some((item, offset) => items[dragging.start + offset] !== item)) return;
    const target = rowRange(row);
    let at = target.start + (event.clientY > row.getBoundingClientRect().top + row.offsetHeight / 2 ? target.count : 0);
    if (at >= dragging.start && at <= dragging.start + dragging.count) { container.ondragend(); return; }
    const current = S.queue[S.qcur];
    items.splice(dragging.start, dragging.count);
    if (at > dragging.start) at -= dragging.count;
    items.splice(at, 0, ...dragging.entries);
    if (items === S.queue) S.qcur = current ? S.queue.indexOf(current) : -1;
    dragging = null;
    save(); rerender();
  };
}
async function scanLocalMusic() {
  const button = $('#localScan');
  button.disabled = true;
  try {
    const result = await B.localLibraryScan();
    if (!result) return;
    const target = specialFolder('local', '本地音乐');
    const previous = new Map(target.items.map(item => [item.localId, item]));
    target.items = result.items.map(item => previous.get(item.localId)?.identifySource === 'manual' ? { ...item, ...previous.get(item.localId) } : item);
    save(); renderFolders(); renderList();
    toast('已扫描 ' + target.items.length + ' 首' + (result.warnings.length ? '，' + result.warnings.length + ' 项未能读取' : ''));
  } catch (error) { toast('扫描失败：' + error.message); }
  finally { button.disabled = false; button.textContent = '扫描文件夹'; }
}
function showDuplicateSongs() {
  const target = folder(), groups = LibraryModel.duplicateGroups(target?.items || []);
  if (!groups.length) return toast('没有发现歌名、歌手相同的重复歌曲');
  const modal = $('#duplicatesDialog');
  const snapshot = target.items.slice();
  $('#duplicateRows').innerHTML = groups.map(group => '<section><h4>' + esc(group[0].item.title) + ' · ' + esc(songArtist(group[0].item)) + '</h4>' +
    group.map(({ item, index }) => '<label class="duplicate-entry"><input type="checkbox" data-index="' + index + '" />' +
      '<span>' + esc(item.localId ? '本地音频 · ' + (item.album || '') : item.vtitle || item.title) + '<small>' + esc(item.bvid || '') + ' · ' + esc(fmtDur(item.duration)) + '</small></span></label>').join('') + '</section>').join('');
  $('#duplicateRemove').onclick = async () => {
    const indices = [...modal.querySelectorAll('input:checked')].map(input => Number(input.dataset.index));
    if (!indices.length) return toast('请勾选要移除的版本');
    if (!S.folders.includes(target)) { modal.close(); return toast('该歌单已移除'); }
    const selected = new Set(indices.map(index => snapshot[index]));
    const removed = target.items.flatMap((item, index) => selected.has(item) ? [{ index, item }] : []);
    target.items = target.items.filter(item => !selected.has(item));
    save(); renderFolders(); renderList(); modal.close();
    offerUndo('已移除 ' + removed.length + ' 首重复歌曲', () => {
      if (S.folders.includes(target)) for (const entry of removed) target.items.splice(Math.min(entry.index, target.items.length), 0, entry.item);
    });
  };
  modal.showModal();
}
function initLibraryFeatures() {
  $('#likedNav').onclick = () => openSpecialFolder('likes', '我喜欢');
  $('#localNav').onclick = async () => {
    const target = openSpecialFolder('local', '本地音乐');
    try {
      const items = await B.localLibraryList();
      if (Array.isArray(items) && !target.items.length) { target.items = items; save(); renderList(); }
    } catch (error) { toast(error.message); }
  };
  $('#likeButton').onclick = toggleLike;
  $('#localScan').onclick = scanLocalMusic;
  B.onLocalLibraryProgress(progress => { $('#localScan').textContent = '扫描 ' + progress.done + '/' + progress.total; });
  $('#libDuplicates').onclick = showDuplicateSongs;
  $('#duplicateClose').onclick = () => $('#duplicatesDialog').close();
  $('#libSync').onclick = () => syncSourceFolder(folder());
  let lastSaved = 0;
  audio.addEventListener('timeupdate', () => {
    if (Date.now() - lastSaved > 5000 && playback.current) { lastSaved = Date.now(); save(); }
  });
  audio.addEventListener('pause', () => { if (playback.current) save(); });
  audio.addEventListener('seeked', () => { if (playback.current) save(); });
  window.addEventListener('beforeunload', () => { if (playback.current) save(); });
  updateLikeButton();
}

function initCustomShortcuts() {
  const fields = [...document.querySelectorAll('[data-shortcut]')];
  B.getShortcuts().then(state => {
    for (const field of fields) field.value = state.bindings?.[field.dataset.shortcut] || '';
    $('#shortcutStatus').textContent = state.error || '';
  }).catch(error => { $('#shortcutStatus').textContent = error.message; });
  for (const field of fields) field.onkeydown = event => {
    if (event.key === 'Tab') return;
    event.preventDefault(); event.stopPropagation();
    if (['Backspace', 'Delete'].includes(event.key)) { field.value = ''; return; }
    const key = /^Key[A-Z]$/.test(event.code) ? event.code.slice(3)
      : /^Digit\d$/.test(event.code) ? event.code.slice(5)
      : /^F\d+$/.test(event.code) || event.code === 'Space' ? event.code
      : /^Arrow/.test(event.code) ? event.code.slice(5) : '';
    if (!key) return;
    field.value = [event.ctrlKey && 'Control', event.altKey && 'Alt', event.shiftKey && 'Shift', key].filter(Boolean).join('+');
  };
  $('#saveShortcuts').onclick = async () => {
    try {
      const bindings = Object.fromEntries(fields.map(field => [field.dataset.shortcut, field.value]));
      await B.setShortcuts(bindings);
      $('#shortcutStatus').textContent = '快捷键已保存';
    } catch (error) { $('#shortcutStatus').textContent = error.message; }
  };
}
