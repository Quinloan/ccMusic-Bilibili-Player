const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
function normalizePlayInfo(data) {
  const dash = data?.dash || {};
  const norm = audio => ({ id: audio.id, codecs: audio.codecs || '', kbps: Math.round((audio.bandwidth || 0) / 1000),
    url: audio.baseUrl || audio.base_url || audio.url,
    backupUrls: [audio.backupUrl, audio.backup_url].flatMap(value => Array.isArray(value) ? value : []).filter(url => /^https?:\/\//.test(url)) });
  const audio = Array.isArray(dash.audio) ? dash.audio : [];
  const flac = dash.flac?.audio || data?.flac?.audio;
  const dolby = dash.dolby?.audio || data?.dolby?.audio || [];
  const dolbyTracks = (Array.isArray(dolby) ? dolby : [dolby]).filter(Boolean).map(norm).sort((a, b) => b.kbps - a.kbps);
  return { raw: audio.map(a => ({ id: a.id, kbps: Math.round((a.bandwidth || 0) / 1000) })),
    tracks: audio.map(norm).sort((a, b) => b.kbps - a.kbps), flac: flac ? { ...norm(flac), lossless: true } : null,
    dolby: dolbyTracks[0] || null, dolbyTracks };
}
function bestTrack(info) {
  const all = [info.flac, ...(info.tracks || []), ...(info.dolbyTracks || []), info.dolby].filter(track => /^https?:\/\//.test(track?.url || ''));
  if (!all.length) throw new Error('没有可下载音轨');
  return all.sort((a, b) => Number(!!b.lossless || /flac/i.test(b.codecs) || Number(b.id) === 30251) - Number(!!a.lossless || /flac/i.test(a.codecs) || Number(a.id) === 30251) || b.kbps - a.kbps)[0];
}
function outputFormat(track, split) {
  return { extension: 'mp3', format: 'mp3', label: 'MP3 320 kbps' };
}
function safeName(value) {
  let name = Array.from(String(value || '音频')).slice(0, 100).join('').replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').replace(/[. ]+$/g, '').trim();
  if (!name) name = '音频';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = '_' + name;
  return name;
}
function validateItems(items) {
  if (!Array.isArray(items) || !items.length || items.length > 100) throw new Error('每批请选择 1～100 首');
  return items.map(item => {
    if (!/^BV[\da-z]{10}$/i.test(item?.bvid || '')) throw new Error('视频 BV 号无效');
    const page = Number(item.page || 1), cid = Number(item.cid || 0);
    if (!Number.isInteger(page) || page < 1 || page > 10000 || !Number.isSafeInteger(cid) || cid < 0) throw new Error('分 P 信息无效');
    const clean = { bvid: item.bvid, page, cid, title: String(item.title || item.bvid).slice(0, 500), artist: String(item.artist || '').slice(0, 200) };
    if (item.split) {
      if (![item.startSec, item.endSec].every(Number.isFinite) || item.startSec < 0 || item.endSec <= item.startSec) throw new Error('分段时间无效');
      Object.assign(clean, { split: true, startSec: item.startSec, endSec: item.endSec });
    }
    return clean;
  });
}
async function convertAudio({ executable, input, output, track, item, signal, onProgress = () => {} }) {
  signal.throwIfAborted();
  const pcm = output + '.pcm';
  try {
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-n', '-i', input];
  if (item.split) args.push('-ss', String(item.startSec), '-t', String(item.endSec - item.startSec));
  args.push('-map', '0:a:0', '-vn', '-map_metadata', '-1', '-metadata', `title=${item.title}`, '-metadata', `artist=${item.artist || ''}`);
  args.push('-c:a', 'pcm_s16le', '-ac', '2', '-ar', '44100', '-f', 's16le', pcm);
  await new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, signal });
    let errorText = '', spawnError;
    const timer = setTimeout(() => child.kill(), 20 * 60 * 1000);
    child.stdout.on('data', () => {});
    child.stderr.on('data', chunk => { errorText = (errorText + chunk).slice(-2000); });
    child.once('error', error => { spawnError = error; if (error.name !== 'AbortError') { clearTimeout(timer); reject(error); } });
    child.once('close', code => {
      clearTimeout(timer);
      if (signal.aborted) reject(signal.reason);
      else if (spawnError || code !== 0) reject(new Error('音频保存失败：' + (errorText || spawnError?.message || code)));
      else resolve();
    });
  });
  signal.throwIfAborted();
  const { Worker } = require('node:worker_threads');
  await new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'mp3-worker.cjs'), { workerData: { input: pcm, output, title: item.title, artist: item.artist } });
    let workerError;
    worker.on('message', value => { if (!signal.aborted && Number.isFinite(value)) onProgress(Math.max(0, Math.min(100, value))); });
    const abort = () => worker.terminate();
    const timer = setTimeout(abort, 20 * 60 * 1000);
    signal.addEventListener('abort', abort, { once: true });
    worker.once('error', error => { workerError = error; });
    worker.once('exit', code => {
      clearTimeout(timer); signal.removeEventListener('abort', abort);
      if (signal.aborted) reject(signal.reason);
      else if (workerError) reject(workerError);
      else if (code) reject(new Error('MP3 编码失败，请重试'));
      else resolve();
    });
    if (signal.aborted) abort();
  });
  } finally { try { await fs.promises.unlink(pcm); } catch (_) {} }
}
function createDownloader({ getPlayurl, resolveItem, request, headers, executable, onUpdate, tempRoot = os.tmpdir(), convert = convertAudio }) {
  const jobs = new Map();
  let downloadTail = Promise.resolve(), conversionTail = Promise.resolve(), closing = false;
  // Kept independently of visible records: dismissed/cancelled jobs must still
  // finish cleanup before idle/shutdown returns.
  const unfinished = new Set();
  const view = job => ({ id: job.id, title: job.item.title, state: job.state, pct: job.pct || 0, quality: job.quality || '', error: job.error || '', file: job.file || '',
    batchId: job.batch.id, batchRevision: job.batch.revision,
    sharedSource: job.batch.cache && job.batch.members.some(other => other !== job && other.item.bvid === job.item.bvid &&
      (+other.item.page || 1) === (+job.item.page || 1) && (!other.item.cid || !job.item.cid || +other.item.cid === +job.item.cid)),
    batchProgress: {
      total: job.batch.total, downloaded: job.batch.members.filter(j => j.downloaded).length,
      saved: job.batch.members.filter(j => j.state === 'done').length,
      waiting: job.batch.members.filter(j => j.state === 'waiting-conversion').length,
      converting: job.batch.members.filter(j => ['saving', 'committing'].includes(j.state)).length,
      failed: job.batch.members.filter(j => j.state === 'error').length,
      cancelled: job.batch.members.filter(j => j.state === 'cancelled').length,
    } });
  const update = job => { if (jobs.get(job.id) !== job) return; job.batch.revision++; try { onUpdate(job.owner, view(job)); } catch (_) {} };
  async function transfer(job, url, input) {
    job.controller.signal.throwIfAborted();
    const signal = AbortSignal.any([job.controller.signal, AbortSignal.timeout(20 * 60 * 1000)]);
    const response = await request(url, { headers: headers(), signal });
    if (!response.ok || !response.body) { await response.body?.cancel().catch(() => {}); throw new Error('下载失败 HTTP ' + response.status); }
    const total = !response.headers.get('content-encoding') ? Number(response.headers.get('content-length') || 0) : 0;
    const file = await fs.promises.open(input, 'w');
    let bytes = 0;
    try {
      for await (const chunk of response.body) {
        signal.throwIfAborted();
        let offset = 0;
        while (offset < chunk.length) { const written = await file.write(chunk, offset, chunk.length - offset); if (!written.bytesWritten) throw new Error('无法写入临时音频'); offset += written.bytesWritten; }
        bytes += chunk.length;
        const pct = total ? Math.min(99, Math.floor(bytes / total * 100)) : 0;
        if (pct !== job.pct) { job.pct = pct; update(job); }
      }
      if (!bytes || (total && bytes !== total)) throw new Error('音频下载不完整，请重试');
    } finally { await file.close(); }
  }
  async function finish(job, error) {
    if (job.finalizing) return;
    job.finalizing = true;
    if (error) {
      job.state = job.controller.signal.aborted ? 'cancelled' : 'error';
      job.error = job.controller.signal.aborted ? '' : error.message || String(error); update(job);
    }
    if (job.temporary) {
      for (const name of ['source.audio', 'result.mp3.pcm', 'result.mp3']) await fs.promises.unlink(path.join(job.temporary, name)).catch(() => {});
      await fs.promises.rmdir(job.temporary).catch(() => {});
    }
    // One immutable source file per key. A later download must never overwrite
    // an earlier source while the conversion queue is still reading it.
    if (--job.batch.remaining === 0) for (const entry of job.batch.sources.values()) {
      await fs.promises.unlink(entry.input).catch(() => {});
      await fs.promises.rmdir(entry.directory).catch(() => {});
    }
    unfinished.delete(job); job.resolveFinished();
  }
  async function download(job) {
    const signal = job.controller.signal;
    try {
      signal.throwIfAborted();
      job.state = 'preparing'; update(job);
      job.item = await require('./cancellation.cjs').waitFor(resolveItem(job.item), signal);
      signal.throwIfAborted();
      const info = await require('./cancellation.cjs').waitFor(getPlayurl(job.item.bvid, job.item.cid, true), signal);
      signal.throwIfAborted();
      const track = bestTrack(info), format = outputFormat(track, job.item.split);
      job.quality = `${format.label}${track.kbps ? ` · 源音轨 ${track.kbps} kbps` : ''}`;
      job.temporary = await fs.promises.mkdtemp(path.join(tempRoot, 'ccmusic-download-'));
      let input = path.join(job.temporary, 'source.audio');
      const output = path.join(job.temporary, 'result.' + format.extension);
      const cacheKey = `${job.item.bvid}:${job.item.cid}:${track.id}:${track.codecs}:${track.kbps}`;
      let source;
      if (job.batch.cache) {
        source = job.batch.sources.get(cacheKey);
        if (!source) {
          const directory = await fs.promises.mkdtemp(path.join(tempRoot, 'ccmusic-download-'));
          source = { directory, input: path.join(directory, 'source.audio'), ready: false };
          job.batch.sources.set(cacheKey, source);
        }
        input = source.input;
      }
      job.state = 'downloading'; update(job);
      let failure;
      if (!source?.ready) {
        for (const url of [...new Set([track.url, ...(track.backupUrls || [])])]) {
          try { await transfer(job, url, input); failure = null; break; }
          catch (error) { signal.throwIfAborted(); failure = error; }
        }
        if (!failure && source) source.ready = true;
      }
      if (failure) throw failure;
      signal.throwIfAborted();
      job.downloaded = true;
      job.state = 'waiting-conversion'; job.pct = 0; update(job);
      conversionTail = conversionTail.then(() => convertJob(job, { input, output, track })).catch(error => finish(job, error));
    } catch (error) { await finish(job, error); }
  }
  async function convertJob(job, { input, output, track }) {
    if (job.finalizing) return;
    const signal = job.controller.signal;
    try {
      signal.throwIfAborted(); job.state = 'saving'; job.pct = 0; update(job);
      await convert({ executable, input, output, track, item: job.item, signal,
        onProgress: pct => { if (job.state === 'saving') { job.pct = pct; update(job); } } });
      signal.throwIfAborted();
      if (!(await fs.promises.stat(output)).size) throw new Error('生成的音频为空');
      signal.throwIfAborted(); job.state = 'committing'; update(job);
      const stem = safeName((job.item.artist ? job.item.artist + ' - ' : '') + job.item.title);
      for (let attempt = 0; attempt < 10000; attempt++) {
        const filename = path.join(job.directory, `${stem}${attempt ? ` (${attempt})` : ''}.mp3`);
        try { await fs.promises.copyFile(output, filename, fs.constants.COPYFILE_EXCL); job.file = filename; break; }
        catch (error) { if (error.code !== 'EEXIST') throw error; }
      }
      if (!job.file) throw new Error('同名文件过多，请更换保存目录');
      job.state = 'done'; update(job);
    } catch (error) { await finish(job, error); }
    finally { await finish(job); }
  }
  function cancelJob(job) {
    const waiting = job.state === 'waiting-conversion';
    job.controller.abort(); job.state = 'cancelled'; update(job);
    if (waiting) void finish(job, job.controller.signal.reason);
  }
  async function idle() {
    while (unfinished.size) await Promise.all([...unfinished].map(job => job.finished));
  }
  return {
    add(owner, items, directory) {
      if (closing) throw new Error('软件正在退出，无法开始下载');
      if (unfinished.size + items.length > 100) throw new Error('下载队列已满，请先完成或取消部分任务');
      const batch = { id: randomUUID(), total: items.length, revision: 0, members: [], remaining: items.length, cache: items.length > 1 && items.some(item => item.split), sources: new Map() };
      const added = items.map(item => {
        const job = { id: randomUUID(), owner, item, directory, batch, state: 'queued', controller: new AbortController() };
        job.finished = new Promise(resolve => { job.resolveFinished = resolve; });
        batch.members.push(job);
        unfinished.add(job); jobs.set(job.id, job); update(job);
        downloadTail = downloadTail.then(() => download(job)).catch(error => finish(job, error));
        return view(job);
      });
      return added;
    },
    list(owner) { return [...jobs.values()].filter(job => job.owner === owner).map(view); },
    retry(owner, id) { const job = jobs.get(id); if (!job || job.owner !== owner || !['error', 'cancelled'].includes(job.state)) throw new Error('该任务不能重试'); return this.add(owner, [{ ...job.item }], job.directory); },
    cancel(owner, id) { const job = jobs.get(id); if (!job || job.owner !== owner || ['done', 'error', 'cancelled', 'committing'].includes(job.state)) return false; cancelJob(job); return true; },
    dismiss(owner, id) { const job = jobs.get(id); if (!job || job.owner !== owner || !['done', 'error', 'cancelled'].includes(job.state)) return false; jobs.delete(id); return true; },
    manage(owner, action, batchId) {
      if (!['cancel', 'clear'].includes(action) || (batchId != null && (typeof batchId !== 'string' || batchId.length > 100))) throw Error('无效的任务操作');
      const removed = []; let cancelled = 0, committing = 0;
      for (const job of jobs.values()) {
        if (job.owner !== owner || (batchId != null && job.batch.id !== batchId)) continue;
        if (action === 'cancel') {
          if (job.state === 'committing') { committing++; continue; }
          if (!['done', 'error', 'cancelled'].includes(job.state)) { cancelJob(job); cancelled++; }
          if (job.state !== 'cancelled') continue;
        } else if (!['done', 'error', 'cancelled'].includes(job.state)) continue;
        jobs.delete(job.id); removed.push(job.id);
      }
      return { removed, cancelled, committing };
    },
    reveal(owner, id) { const job = jobs.get(id); return job?.owner === owner && job.state === 'done' ? job.file : null; },
    cancelOwner(owner) { for (const job of jobs.values()) if (job.owner === owner) { if (!['done', 'error', 'cancelled', 'committing'].includes(job.state)) cancelJob(job); jobs.delete(job.id); } },
    hasPending() { return unfinished.size > 0; },
    async shutdown() { closing = true; for (const job of unfinished) if (!['done', 'error', 'cancelled', 'committing'].includes(job.state)) cancelJob(job); await idle(); },
    idle,
  };
}
module.exports = { normalizePlayInfo, bestTrack, outputFormat, safeName, validateItems, convertAudio, createDownloader };
