// Store playable metadata only, never signed audio URLs or login credentials.
function cleanPlayHistory(rows) {
  if (!Array.isArray(rows)) return [];
  const seen = new Set(), out = [];
  for (const row of rows.slice(0, 5000).filter(row => row && Number.isFinite(row.playedAt) && row.playedAt > 0 && row.playedAt <= Date.now()).sort((a, b) => b.playedAt - a.playedAt)) {
    let item;
    try { item = LibraryModel.importedFolders({ folders: [{ name: '历史', items: [row.item] }] })[0]?.items[0]; } catch (_) { continue; }
    if (!item) continue;
    const key = item.bvid + ':' + (item.cid || 0) + ':' + (item.page || 1) + ':' + (item.split ? item.startSec + ':' + item.endSec : '');
    if (seen.has(key)) continue;
    seen.add(key); out.push({ item, playedAt: row.playedAt });
    if (out.length >= 500) break;
  }
  return out;
}
function recordPlayHistory(item) {
  const clean = cleanPlayHistory([{ item, playedAt: Date.now() }]);
  if (!clean.length) return;
  S.history = cleanPlayHistory([...clean, ...S.history]);
  save(); if (S.view === 'history') renderPlayHistory();
}
function renderPlayHistory() {
  const box = $('#historyList'), query = $('#historyFilter').value.trim().toLowerCase();
  $('#historyCount').textContent = `${S.history.length} 首`;
  $('#historyClear').disabled = !S.history.length;
  const rows = S.history.map((row, index) => ({ ...row, index })).filter(({ item }) => `${item.title} ${songArtist(item)}`.toLowerCase().includes(query));
  box.innerHTML = rows.length ? rows.map(({ item, playedAt, index }) => `<div class="row history-row" data-history="${index}">
    <img src="${esc(itemCover(item) || LOGO_SRC)}" loading="lazy" alt="" />
    <div class="history-meta"><div class="history-title">${esc(item.title)}</div><div class="muted">${esc(songArtist(item))}${songArtist(item) ? ' · ' : ''}${esc(fmtDur(item.duration))}</div></div>
    <time class="muted" datetime="${new Date(playedAt).toISOString()}">${esc(new Date(playedAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }))}</time>
    <button data-history-play="${index}">播放</button><button data-history-remove="${index}" aria-label="移除历史记录">×</button></div>`).join('') : `<p class="empty">${query ? '没有找到相关歌曲' : '还没有播放记录'}</p>`;
  box.querySelectorAll('img').forEach(image => { image.onerror = () => { image.onerror = null; image.src = LOGO_SRC; }; });
  box.querySelectorAll('[data-history-play]').forEach(button => { button.onclick = () => {
    const item = S.history[+button.dataset.historyPlay]?.item; if (!item) return;
    loadQueue([{ ...item }], 0); playQueueAt(0);
  }; });
  box.querySelectorAll('[data-history-remove]').forEach(button => { button.onclick = () => {
    S.history.splice(+button.dataset.historyRemove, 1); save(); renderPlayHistory();
  }; });
}
