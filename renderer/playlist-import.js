let enqueueSharedPlaylist = null;
function syncSourceFolder(target) {
  if (!target?.sourceUrl || !enqueueSharedPlaylist) return;
  if ([...playlistImportJobs.values()].some(job => job.targetFolderId === target.id)) {
    $('#tasksPanel').hidden = false;
    return toast('这个收藏夹已有同步任务');
  }
  enqueueSharedPlaylist(target.sourceUrl, target.name, target.id);
  toast('已开始检查收藏夹新增内容');
}
function initPlaylistImport() {
  const modal = $('#playlistImport'), source = $('#playlistSource'), name = $('#playlistName');
  const status = $('#playlistStatus'), action = $('#playlistAction'), misses = $('#playlistMisses');
  let ready = false, worker = null, paused = false;
  const active = job => playlistImportJobs.get(job.id) === job;
  function snapshot(job) {
    const { seen, ...value } = job;
    return { ...value, running: false, saving: false };
  }
  function checkpoint() {
    return B.saveImportDraft({ version: 2, jobs: [...playlistImportJobs.values()].map(snapshot) });
  }
  function describe(job) {
    const total = job.list?.tracks.length || 0;
    return job.message || (job.state === 'queued' ? '排队等待导入' : '已恢复进度，可继续导入') + ' · ' + job.index + '/' + (total || '?');
  }
  function refresh() {
    const current = playlistImportJob;
    const attached = current && active(current);
    $('#importTaskCard').hidden = !attached;
    if (attached) {
      $('#importTaskTitle').textContent = (current.targetFolderId ? '同步收藏夹 · ' : '导入歌单 · ') + (current.customName || current.name);
      $('#importTaskStatus').textContent = describe(current);
      $('#importTaskOpen').textContent = current.running || current.state === 'queued' ? '查看进度' : current.state === 'paused' ? '处理暂停任务' : '查看结果';
      const progress = $('#importTaskProgress');
      progress.hidden = !current.running;
      if (current.list) { progress.max = current.list.tracks.length || 1; progress.value = current.index; }
      else progress.removeAttribute('value');
      source.value = current.raw; name.value = current.customName || current.name;
      source.disabled = true; name.disabled = !!current.targetFolderId;
      status.textContent = describe(current);
      $('#playlistHide').hidden = false; $('#playlistBackup').hidden = true; $('#playlistNew').hidden = false;
      $('#playlistResume').hidden = current.running || current.state === 'queued' && !paused || current.state === 'ready';
      action.disabled = current.running || current.state === 'queued' || current.saving;
      action.textContent = current.running ? '正在导入' : current.state === 'queued' ? '等待导入' : current.targetFolderId ? '应用新增 ' + current.items.length + ' 首'
        : current.items.length ? '保存 ' + current.items.length + ' 首到新歌单' : '重新读取';
      misses.hidden = !current.unmatched.length;
      misses.querySelector('pre').textContent = current.unmatched.map(m => current.list?.tracks[m.index]?.title + '（' + m.reason + '）').join('\n');
      $('#playlistReport').hidden = !current.report;
    }
    $('#importQueueCards').innerHTML = [...playlistImportJobs.values()].filter(job => job !== current).map(job =>
      '<div class="task-card"><strong>' + esc(job.customName || job.name) + '</strong><small>' + esc(describe(job)) + '</small><small class="import-source">' + esc(job.raw.slice(0, 180)) + '</small><div class="task-actions">' +
      '<button data-import-open="' + job.id + '">查看</button><button data-import-cancel="' + job.id + '">取消导入</button></div></div>').join('');
    renderTasks();
  }
  function openJob(job) {
    playlistImportJob = job;
    refresh();
    $('#tasksPanel').hidden = true;
    if (!modal.open) modal.showModal();
  }
  function newImport() {
    if (!ready) return toast('正在恢复导入进度…');
    playlistImportJob = null;
    source.value = ''; source.disabled = false; name.value = ''; name.disabled = false;
    status.textContent = ''; misses.hidden = true; $('#playlistReport').hidden = true;
    $('#playlistResume').hidden = true; $('#playlistHide').hidden = false; $('#playlistBackup').hidden = false; $('#playlistNew').hidden = true;
    action.disabled = false; action.textContent = '后台导入';
    refresh();
    $('#tasksPanel').hidden = true;
    if (!modal.open) modal.showModal();
    source.focus();
  }
  function removeJob(job) {
    if (!job || job.saving) return;
    playlistImportJobs.delete(job.id);
    if (paused && ![...playlistImportJobs.values()].some(entry => entry.state === 'paused')) paused = false;
    if (job.reading) B.cancelPlaylistRead(job.id);
    if (playlistImportJob === job) playlistImportJob = [...playlistImportJobs.values()][0] || null;
    checkpoint().catch(error => toast('保存导入进度失败：' + error.message));
    refresh();
    pump();
  }
  function enqueue(raw, customName = '', targetFolderId = null) {
    const target = S.folders.find(f => f.id === targetFolderId);
    const job = { id: uniqueId(), raw, customName, targetFolderId, name: '导入的歌单', items: [], index: 0, unmatched: [],
      skippedDuplicates: [], seen: new Set(target ? target.sourceSeen || target.items.map(itemKey) : []), state: 'queued', running: false };
    playlistImportJobs.set(job.id, job);
    if (!playlistImportJob) playlistImportJob = job;
    checkpoint().catch(error => toast(error.message));
    refresh(); pump();
    return job;
  }
  enqueueSharedPlaylist = enqueue;
  function pump() {
    if (worker || paused) return;
    const next = [...playlistImportJobs.values()].find(job => job.state === 'queued');
    if (!next) return;
    worker = next;
    run(next).finally(() => { worker = null; pump(); });
  }
  async function run(job) {
    job.running = true; job.paused = false; job.state = 'running'; job.message = '正在读取歌单…'; refresh();
    const target = S.folders.find(f => f.id === job.targetFolderId);
    for (const key of target?.sourceSeen || []) job.seen.add(key);
    const add = item => {
      const key = itemKey(item);
      if (job.seen.has(key)) {
        if (!job.targetFolderId) {
          const song = job.list.tracks[job.index];
          job.skippedDuplicates.push({ index: job.index, song: { position: song.position, title: item.title, artist: item.artist || song.artist } });
        }
        return;
      }
      job.seen.add(key); job.items.push(item);
    };
    try {
      await checkpoint();
      if (!active(job)) return;
      if (!job.list) {
        job.reading = true;
        job.list = /https?:\/\//i.test(job.raw) ? await B.readSharedPlaylist(job.raw, job.id) : { tracks: LibraryModel.parseSongList(job.raw) };
        job.reading = false;
        if (!active(job)) return;
        job.name = job.list.name || job.name;
        await checkpoint();
      }
      while (active(job) && job.index < job.list.tracks.length) {
        const song = job.list.tracks[job.index];
        job.message = '正在导入 ' + (job.index + 1) + ' / ' + job.list.tracks.length + ' · ' + song.title;
        refresh();
        try {
          if (song.item) {
            if (song.item.partsCount > 1) {
              const known = job.targetFolderId && Array.from({ length: song.item.partsCount }, (_, i) => song.item.bvid + ':' + (i + 1)).every(key => job.seen.has(key));
              if (!known) {
                const meta = await B.video(song.item.bvid);
                if (!active(job)) return;
                if (!meta.parts?.length) throw new Error('无法读取分 P');
                for (const part of meta.parts) add({ ...song.item, cid: part.cid, page: part.page, title: part.part,
                  partTitle: part.part, duration: part.duration, partsCount: meta.parts.length });
              }
            } else add(song.item);
          } else {
            const videos = await B.searchPlaylistTrack((song.title + ' ' + song.artist).trim());
            if (!active(job)) return;
            let matched = false;
            for (const candidate of LibraryModel.playlistCandidates(song, videos).slice(0, 2)) {
              const meta = await B.video(candidate.bvid);
              if (!active(job)) return;
              if (!meta.cid || meta.parts?.length > 1 || !LibraryModel.playlistCandidates(song, [{ ...meta, author: meta.up }]).length) continue;
              add({ bvid: meta.bvid, cid: meta.cid, page: 1, partsCount: 1, title: song.title, artist: song.artist,
                identifySource: 'playlist', vtitle: meta.title, duration: meta.duration, up: meta.up, cover: meta.cover, songCover: LibraryModel.songCoverUrl(song.cover) });
              matched = true; break;
            }
            if (!matched) job.unmatched.push({ index: job.index, reason: '未匹配到音源' });
          }
        } catch (error) {
          if (!active(job)) return;
          if (/412|352|429|403|509|频繁|验证|banned|风控|timeout|timed out|fetch failed|网络|搜索失败/i.test(error.message)) throw error;
          job.unmatched.push({ index: job.index, reason: cleanError(error) });
        }
        job.index++;
        await checkpoint();
        if (!active(job)) return;
        if (!song.item || song.item.partsCount > 1) await new Promise(resolve => setTimeout(resolve, 700));
        else if (job.index % 50 === 0) await new Promise(resolve => setTimeout(resolve, 0));
      }
      if (!active(job)) return;
      job.state = 'ready';
    } catch (error) {
      if (!active(job)) return;
      job.state = 'paused'; job.error = cleanError(error); paused = true;
    }
    if (!active(job)) return;
    job.running = false; job.reading = false;
    const unavailable = Math.max(0, (job.list?.total || 0) - (job.list?.tracks.length || 0));
    job.report = formatImportReport(job);
    job.message = ['已处理 ' + job.index + ' / ' + (job.list?.tracks.length || '?') + ' 项，可保存 ' + job.items.length + ' 首',
      job.unmatched.length && job.unmatched.length + ' 首未匹配', job.skippedDuplicates.length && job.skippedDuplicates.length + ' 首重复',
      unavailable && unavailable + ' 项不可用', job.error && '已暂停：' + job.error].filter(Boolean).join(' · ');
    job.ready = !!job.items.length;
    try { await checkpoint(); } catch (error) { job.message += ' · 进度保存失败：' + error.message; }
    refresh();
    if (!modal.open) toast(job.state === 'paused' ? '歌单导入已暂停，可在「任务」继续' : '歌单匹配完成，可在「任务」保存结果');
  }

  $('#libImport').onclick = () => {
    const rect = $('#libImport').getBoundingClientRect();
    showCtxMenu(rect.left, rect.bottom + 5, [
      { label: '新建歌单', action: createPlaylist },
      { label: '导入歌单…', action: () => playlistImportJob ? openJob(playlistImportJob) : newImport() },
    ]);
  };
  $('#playlistNew').onclick = newImport;
  $('#importTaskOpen').onclick = () => { if (playlistImportJob) openJob(playlistImportJob); };
  $('#importTaskCancel').onclick = () => removeJob(playlistImportJob);
  $('#importQueueCards').onclick = event => {
    const button = event.target.closest('button');
    if (button?.dataset.importOpen) openJob(playlistImportJobs.get(button.dataset.importOpen));
    if (button?.dataset.importCancel) removeJob(playlistImportJobs.get(button.dataset.importCancel));
  };
  $('#playlistCancel').onclick = () => { removeJob(playlistImportJob); modal.close(); };
  $('#playlistHide').onclick = () => modal.close();
  $('#playlistBackup').onclick = () => { modal.close(); $('#importFile').click(); };
  $('#playlistReport').onclick = () => {
    if (playlistImportJob?.report) saveImportReport(playlistImportJob.customName || playlistImportJob.name, playlistImportJob.report);
  };
  name.oninput = () => {
    if (playlistImportJob) { playlistImportJob.customName = name.value; checkpoint().catch(error => toast(error.message)); }
  };
  $('#playlistResume').onclick = () => {
    const job = playlistImportJob;
    if (!job || job.running) return;
    job.state = 'queued'; job.error = ''; paused = false;
    // Promote the chosen paused job without reprocessing earlier songs.
    playlistImportJobs.delete(job.id);
    const remaining = [...playlistImportJobs.values()];
    playlistImportJobs.clear(); playlistImportJobs.set(job.id, job);
    for (const other of remaining) playlistImportJobs.set(other.id, other);
    modal.close(); refresh(); pump();
  };
  action.onclick = async () => {
    const job = playlistImportJob;
    if (job && (job.running || job.state === 'queued' || job.saving)) return;
    if (job && (job.items.length || job.targetFolderId && job.state === 'ready')) {
      const target = job.targetFolderId ? S.folders.find(f => f.id === job.targetFolderId) : null;
      if (job.targetFolderId && !target) return toast('原歌单已移除，可以取消该同步任务');
      const previous = S.active;
      const f = target || { id: uniqueId(), name: job.customName || job.name, items: [] };
      const oldItems = f.items.slice(), oldSeen = f.sourceSeen, oldJobId = f.importJobId, oldReport = f.importReport, oldSource = f.sourceUrl;
      const keys = new Set(f.items.map(itemKey));
      const added = job.items.filter(item => !keys.has(itemKey(item)));
      f.items = [...f.items, ...added]; f.importJobId = job.id;
      if (/https?:\/\/(?:www\.|space\.|m\.)?bilibili\.com\/|https?:\/\/b23\.tv\//i.test(job.raw)) {
        f.sourceUrl = job.raw;
        f.sourceSeen = [...new Set([...(f.sourceSeen || []), ...job.seen])];
      }
      f.importReport = job.report || '';
      if (!target) S.folders.push(f);
      S.active = f.id; job.saving = true; refresh();
      try { await save(); }
      catch (error) {
        f.items = oldItems; f.sourceSeen = oldSeen; f.importJobId = oldJobId; f.importReport = oldReport; f.sourceUrl = oldSource;
        if (!target) S.folders = S.folders.filter(entry => entry !== f);
        S.active = previous; job.saving = false; refresh(); return toast('保存失败：' + error.message);
      }
      job.saving = false; removeJob(job); modal.close();
      libraryQuery = ''; librarySelection.clear(); $('#libFilter').value = ''; S.cur = -1;
      renderFolders(); renderList(); showView('library');
      offerUndo((target ? '已同步新增 ' : '已导入 ') + added.length + ' 首到《' + f.name + '》', () => {
        if (target) { f.items = oldItems; f.sourceSeen = oldSeen; f.importReport = oldReport; f.importJobId = oldJobId; f.sourceUrl = oldSource; }
        else { S.folders = S.folders.filter(entry => entry !== f); if (S.active === f.id) S.active = S.folders.find(entry => entry.id === previous)?.id || S.folders[0]?.id; }
      });
      return;
    }
    const raw = source.value.trim();
    if (!raw) return toast('请粘贴歌单链接或曲目清单');
    const links = raw.match(/https?:\/\/[^\s<>"'，。【】《》]+/gi) || [];
    if (job) removeJob(job);
    playlistImportJob = null;
    for (const input of links.length > 1 ? [...new Set(links)] : [raw]) enqueue(input, links.length > 1 ? '' : name.value.trim());
    modal.close(); toast('已加入后台导入队列，可在「任务」查看');
  };
  function cleanError(error) { return String(error.message || error).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, ''); }
  B.getImportDraft().then(value => {
    const drafts = Array.isArray(value?.jobs) ? value.jobs : value?.id ? [value] : [];
    for (const draft of drafts) {
      if (!draft?.id || !Array.isArray(draft.items) || !Number.isInteger(draft.index)) continue;
      const target = S.folders.find(f => f.id === draft.targetFolderId);
      const seen = new Set([...(target?.sourceSeen || []), ...draft.items.map(itemKey)]);
      const job = { ...draft, seen, unmatched: draft.unmatched || [], skippedDuplicates: draft.skippedDuplicates || [],
        running: false, saving: false, state: draft.state === 'ready' ? 'ready' : 'paused', paused: true };
      job.report = formatImportReport(job);
      playlistImportJobs.set(job.id, job);
    }
    playlistImportJob = [...playlistImportJobs.values()][0] || null;
    refresh();
  }).catch(error => toast('恢复导入进度失败：' + error.message)).finally(() => { ready = true; });
}
