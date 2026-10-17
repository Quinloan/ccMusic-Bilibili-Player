// Download state comes from the main process; URLs and login credentials stay there.
const downloadTasks = new Map();
const downloadUnseen = new Set();
let pendingDownload = null, resumeDownload = null, downloadBusy = false, downloadFocus = null;
let downloadPicker = null;
function openDownloadPicker(items, source = '当前歌单') {
  if (!items?.length) return toast('这里还没有可下载的歌曲');
  downloadPicker = { items: items.map(item => ({ ...item })), selected: new Set(), focus: document.activeElement };
  $('#downloadPickerSource').textContent = `${source} · 共 ${items.length} 首，勾选想下载的歌曲`;
  $('#downloadPickerQuery').value = '';
  $('#downloadPickerModal').hidden = false;
  renderDownloadPicker(); $('#downloadPickerQuery').focus();
}
function downloadPickerVisible() {
  const query = $('#downloadPickerQuery').value.trim().toLocaleLowerCase();
  return downloadPicker.items.map((item, index) => ({ item, index })).filter(({ item }) => !query || [item.title, item.artist, item.up, item.vtitle].filter(Boolean).join(' ').toLocaleLowerCase().includes(query));
}
function renderDownloadPickerSummary() {
  const count = downloadPicker.selected.size, visible = downloadPickerVisible();
  const hidden = count - visible.filter(({ index }) => downloadPicker.selected.has(index)).length;
  $('#downloadPickerSummary').textContent = `已选 ${count} 首${hidden ? `（${hidden} 首不在当前筛选中）` : ''}${count > 100 ? '，超过单批上限，请减少选择' : ''}`;
  $('#downloadPickerConfirm').textContent = count ? `下载所选 ${count} 首` : '下载所选';
  $('#downloadPickerConfirm').disabled = count === 0 || count > 100;
}
function renderDownloadPicker() {
  const visible = downloadPickerVisible();
  $('#downloadPickerList').innerHTML = visible.map(({ item, index }) => `<label class="download-picker-row">
    <input type="checkbox" data-pick-download="${index}" aria-label="选择 ${esc(item.title)}" ${downloadPicker.selected.has(index) ? 'checked' : ''} />
    <span class="download-picker-name"><strong>${esc(item.title)}</strong><small>${esc([item.artist || item.up, item.split ? `分段 ${fmt(item.startSec)}—${fmt(item.endSec)}` : (+item.page > 1 ? `P${item.page}` : '')].filter(Boolean).join(' · '))}</small></span>
    <span class="muted">${fmtDur(item.duration)}</span></label>`).join('') || '<div class="empty">没有匹配的歌曲，试试其他关键词</div>';
  renderDownloadPickerSummary();
}
function closeDownloadPicker() {
  const focus = downloadPicker?.focus; downloadPicker = null;
  $('#downloadPickerModal').hidden = true; focus?.focus();
}
function renderDownloads() {
  const tasks = [...downloadTasks.values()];
  const active = tasks.some(task => !['done', 'error', 'cancelled'].includes(task.state));
  const failed = tasks.some(task => task.state === 'error' && downloadUnseen.has(task.id));
  setActivityIndicator('#downloadsBtn', failed ? 'error' : active ? 'running' : downloadUnseen.size ? 'attention' : 'idle', '音频下载');
  $('#downloadsEmpty').hidden = !!tasks.length;
  $('#downloadsList').innerHTML = tasks.map(task => {
    const terminal = ['done', 'error', 'cancelled'].includes(task.state);
    const status = { queued: '排队中', preparing: '获取最高音质音轨…', downloading: `下载中 ${task.pct || 0}%`, saving: '正在处理音频…', committing: '正在保存文件…', done: '已完成', cancelled: '已取消', error: '下载失败：' + task.error }[task.state] || '准备中';
    return `<div class="task-card"><strong>${esc(task.title)}</strong><small class="download-status" role="status">${esc(status)}</small>${task.quality ? `<small>${esc(task.quality)}</small>` : ''}
      ${task.state === 'downloading' ? `<progress max="100" value="${Number(task.pct) || 0}" aria-label="下载进度"></progress>` : ''}
      ${task.file ? `<small class="download-path" title="${esc(task.file)}">${esc(task.file)}</small>` : ''}
      <div class="task-actions">${!terminal && task.state !== 'committing' ? `<button data-dl-cancel="${task.id}">取消</button>` : ''}
      ${task.state === 'done' ? `<button data-dl-reveal="${task.id}">打开文件位置</button>` : ''}
      ${['error', 'cancelled'].includes(task.state) ? `<button data-dl-retry="${task.id}">重试</button>` : ''}
      ${terminal ? `<button data-dl-dismiss="${task.id}">移除记录</button>` : ''}</div></div>`;
  }).join('');
}
function showDownloads() {
  $('#queuePanel').hidden = true; $('#tasksPanel').hidden = true;
  $('#downloadsPanel').hidden = false;
  downloadUnseen.clear(); renderDownloads();
}
function closeDownloadPrompt() {
  $('#downloadLoginModal').hidden = true; pendingDownload = null;
  downloadFocus?.focus(); downloadFocus = null;
}
async function performDownload(operation, allowLimited = false) {
  if (downloadBusy) return false;
  downloadBusy = true;
  try {
    const result = operation.id ? await B.downloadRetry(operation.id, allowLimited) : await B.downloadStart(operation.items, allowLimited);
    if (result.needsLogin) {
      pendingDownload = operation; downloadFocus = document.activeElement;
      $('#downloadLoginText').textContent = result.stale
        ? '暂时无法确认登录状态，请检查网络后重试或重新登录。继续下载只能获取当前可用音质；部分高音质需要对应账号权益和源音轨。'
        : '未登录时无法获取账号可用的最高音质。请先登录 B 站；部分音质还需要对应权益，且视频本身提供该音轨。';
      $('#downloadLoginModal').hidden = false; $('#downloadLoginGo').focus(); return false;
    }
    if (result.cancelled) return false;
    for (const task of result.tasks || []) if (!downloadTasks.has(task.id)) downloadTasks.set(task.id, task);
    renderDownloads(); showDownloads(); toast('已加入下载队列'); return true;
  } catch (error) { toast('下载失败：' + error.message); return false; }
  finally { downloadBusy = false; }
}
async function requestDownloads(items) {
  if (!items.length) return toast('先选择曲目');
  if (items.length > 100) return toast('每批最多下载 100 首，请分批选择');
  return performDownload({ items: items.map(item => ({ ...item, artist: item.artist || '' })) });
}
async function downloadSearchItem(result) {
  try {
    const meta = await B.video(result.bvid);
    if (meta.parts?.length > 1 || meta.season?.episodes?.length > 1) { openPartsPicker(meta); return; }
    const part = meta.parts?.[0];
    await requestDownloads([{ bvid: meta.bvid, cid: part?.cid || meta.cid, page: part?.page || 1, title: meta.title, duration: part?.duration || meta.duration }]);
  } catch (error) { toast('无法准备下载：' + error.message); }
}
function cancelPendingDownloadLogin() { resumeDownload = null; }
function resumeDownloadsAfterLogin() { const operation = resumeDownload; resumeDownload = null; if (operation) return performDownload(operation); }
function initDownloads() {
  $('#libPickDownload').onclick = () => openDownloadPicker(folder()?.items, folder()?.name);
  $('#downloadPickerQuery').oninput = renderDownloadPicker;
  $('#downloadPickerList').onchange = event => {
    const input = event.target.closest('[data-pick-download]'); if (!input || !downloadPicker) return;
    const index = Number(input.dataset.pickDownload);
    input.checked ? downloadPicker.selected.add(index) : downloadPicker.selected.delete(index);
    renderDownloadPickerSummary();
  };
  $('#downloadPickerAll').onclick = () => { downloadPickerVisible().forEach(({ index }) => downloadPicker.selected.add(index)); renderDownloadPicker(); };
  $('#downloadPickerInvert').onclick = () => { downloadPickerVisible().forEach(({ index }) => downloadPicker.selected.has(index) ? downloadPicker.selected.delete(index) : downloadPicker.selected.add(index)); renderDownloadPicker(); };
  $('#downloadPickerClear').onclick = () => { downloadPicker.selected.clear(); renderDownloadPicker(); };
  $('#downloadPickerCancel').onclick = closeDownloadPicker;
  $('#downloadPickerConfirm').onclick = () => {
    if (!downloadPicker || !downloadPicker.selected.size || downloadPicker.selected.size > 100) return;
    const items = downloadPicker.items.filter((_, index) => downloadPicker.selected.has(index));
    closeDownloadPicker(); requestDownloads(items);
  };
  $('#downloadPickerModal').onclick = event => { if (event.target.id === 'downloadPickerModal') closeDownloadPicker(); };
  $('#downloadPickerModal').onkeydown = event => {
    if (event.key === 'Escape') { event.stopPropagation(); closeDownloadPicker(); }
    if (event.key === 'Tab') {
      const controls = [...$('#downloadPickerModal').querySelectorAll('input, button')].filter(element => !element.disabled);
      const index = controls.indexOf(document.activeElement);
      if (index < 0 || (event.shiftKey ? index === 0 : index === controls.length - 1)) {
        event.preventDefault(); controls[event.shiftKey ? controls.length - 1 : 0]?.focus();
      }
    }
  };
  B.onDownloadProgress(task => {
    downloadTasks.set(task.id, task);
    if (['done', 'error'].includes(task.state) && $('#downloadsPanel').hidden) downloadUnseen.add(task.id);
    renderDownloads();
  });
  B.downloadList().then(tasks => { for (const task of Array.isArray(tasks) ? tasks : []) if (!downloadTasks.has(task.id)) downloadTasks.set(task.id, task); renderDownloads(); }).catch(() => {});
  $('#downloadsBtn').onclick = () => { const visible = !$('#downloadsPanel').hidden; showDownloads(); $('#downloadsPanel').hidden = visible; };
  $('#downloadsClose').onclick = () => { $('#downloadsPanel').hidden = true; };
  $('#downloadCurrent').onclick = () => { const item = playback.current?.item || S.queue[S.qcur]; if (item) requestDownloads([item]); else toast('请先播放一首歌'); };
  $('#libDownload').onclick = () => requestDownloads(folder().items.filter(item => librarySelection.has(itemKey(item))));
  $('#downloadsList').onclick = async event => {
    const button = event.target.closest('button'); if (!button) return;
    try {
      if (button.dataset.dlCancel) await B.downloadCancel(button.dataset.dlCancel);
      if (button.dataset.dlReveal) await B.downloadReveal(button.dataset.dlReveal);
      if (button.dataset.dlRetry) await performDownload({ id: button.dataset.dlRetry });
      if (button.dataset.dlDismiss && await B.downloadDismiss(button.dataset.dlDismiss)) { downloadTasks.delete(button.dataset.dlDismiss); downloadUnseen.delete(button.dataset.dlDismiss); renderDownloads(); }
    } catch (error) { toast(error.message); }
  };
  $('#downloadLoginCancel').onclick = closeDownloadPrompt;
  $('#downloadLoginModal').onclick = event => { if (event.target.id === 'downloadLoginModal') closeDownloadPrompt(); };
  $('#downloadLimited').onclick = () => { const operation = pendingDownload; closeDownloadPrompt(); if (operation) performDownload(operation, true); };
  $('#downloadLoginGo').onclick = () => { const operation = pendingDownload; closeDownloadPrompt(); resumeDownload = operation; openLogin(); };
  $('#downloadLoginModal').onkeydown = event => {
    if (event.key === 'Escape') { event.stopPropagation(); closeDownloadPrompt(); }
    if (event.key === 'Tab') {
      const buttons = [...$('#downloadLoginModal').querySelectorAll('button')], i = buttons.indexOf(document.activeElement);
      event.preventDefault(); buttons[(i + (event.shiftKey ? buttons.length - 1 : 1)) % buttons.length].focus();
    }
  };
}
