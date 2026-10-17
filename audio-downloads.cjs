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
  if (split || track.lossless || /flac/i.test(track.codecs) || Number(track.id) === 30251) return { extension: 'flac', format: 'flac', label: split ? '分段 FLAC' : 'FLAC 无损' };
  if (/opus/i.test(track.codecs)) return { extension: 'opus', format: 'opus', label: 'Opus' };
  if (/ec-3|eac3|ac-3/i.test(track.codecs) || Number(track.id) === 30250) return { extension: 'eac3', format: 'eac3', label: '杜比音频' };
  return { extension: 'm4a', format: 'mp4', label: 'AAC' };
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
async function convertAudio({ executable, input, output, track, item, signal }) {
  signal.throwIfAborted();
  const format = outputFormat(track, item.split);
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-n', '-i', input];
  if (item.split) args.push('-ss', String(item.startSec), '-t', String(item.endSec - item.startSec));
  args.push('-map', '0:a:0', '-vn', '-map_metadata', '-1', '-metadata', `title=${item.title}`, '-metadata', `artist=${item.artist || ''}`);
  if (item.split) args.push('-c:a', 'flac', '-sample_fmt', 's32');
  else args.push('-c:a', 'copy');
  if (format.format === 'mp4') args.push('-movflags', '+faststart');
  args.push('-f', format.format, output);
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
}
function createDownloader({ getPlayurl, resolveItem, request, headers, executable, onUpdate, tempRoot = os.tmpdir(), convert = convertAudio }) {
  const jobs = new Map();
  let tail = Promise.resolve(), pending = 0, closing = false;
  const view = job => ({ id: job.id, title: job.item.title, state: job.state, pct: job.pct || 0, quality: job.quality || '', error: job.error || '', file: job.file || '' });
  const update = job => { if (jobs.get(job.id) !== job) return; try { onUpdate(job.owner, view(job)); } catch (_) {} };
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
  async function run(job) {
    const signal = job.controller.signal;
    let temporary;
    try {
      signal.throwIfAborted();
      job.state = 'preparing'; update(job);
      job.item = await require('./cancellation.cjs').waitFor(resolveItem(job.item), signal);
      signal.throwIfAborted();
      const info = await require('./cancellation.cjs').waitFor(getPlayurl(job.item.bvid, job.item.cid, true), signal);
      signal.throwIfAborted();
      const track = bestTrack(info), format = outputFormat(track, job.item.split);
      job.quality = `${format.label}${track.kbps ? ` · 源音轨 ${track.kbps} kbps` : ''}`;
      temporary = await fs.promises.mkdtemp(path.join(tempRoot, 'ccmusic-download-'));
      let input = path.join(temporary, 'source.audio');
      const output = path.join(temporary, 'result.' + format.extension);
      const cacheKey = `${job.item.bvid}:${job.item.cid}:${track.id}:${track.codecs}:${track.kbps}`;
      if (job.batch.cache) {
        if (!job.batch.temporary) job.batch.temporary = await fs.promises.mkdtemp(path.join(tempRoot, 'ccmusic-download-'));
        input = path.join(job.batch.temporary, 'source.audio');
      }
      job.state = 'downloading'; update(job);
      let failure;
      if (!job.batch.cache || job.batch.cacheKey !== cacheKey) {
        job.batch.cacheKey = null;
        for (const url of [...new Set([track.url, ...(track.backupUrls || [])])]) {
          try { await transfer(job, url, input); failure = null; break; }
          catch (error) { signal.throwIfAborted(); failure = error; }
        }
        if (!failure && job.batch.cache) job.batch.cacheKey = cacheKey;
      }
      if (failure) throw failure;
      signal.throwIfAborted(); job.state = 'saving'; job.pct = 100; update(job);
      await convert({ executable, input, output, track, item: job.item, signal });
      signal.throwIfAborted();
      if (!(await fs.promises.stat(output)).size) throw new Error('生成的音频为空');
      signal.throwIfAborted(); job.state = 'committing'; update(job);
      const stem = safeName((job.item.artist ? job.item.artist + ' - ' : '') + job.item.title);
      for (let attempt = 0; attempt < 10000; attempt++) {
        const filename = path.join(job.directory, `${stem}${attempt ? ` (${attempt})` : ''}.${format.extension}`);
        try { await fs.promises.copyFile(output, filename, fs.constants.COPYFILE_EXCL); job.file = filename; break; }
        catch (error) { if (error.code !== 'EEXIST') throw error; }
      }
      if (!job.file) throw new Error('同名文件过多，请更换保存目录');
      job.state = 'done'; update(job);
    } catch (error) {
      job.state = signal.aborted ? 'cancelled' : 'error'; job.error = signal.aborted ? '' : error.message; update(job);
    } finally {
      if (temporary) {
        for (const name of ['source.audio', ...['flac', 'm4a', 'eac3', 'opus'].map(ext => 'result.' + ext)]) await fs.promises.unlink(path.join(temporary, name)).catch(() => {});
        await fs.promises.rmdir(temporary).catch(() => {});
      }
      if (--job.batch.remaining === 0 && job.batch.temporary) {
        await fs.promises.unlink(path.join(job.batch.temporary, 'source.audio')).catch(() => {});
        await fs.promises.rmdir(job.batch.temporary).catch(() => {});
      }
      pending--;
    }
  }
  return {
    add(owner, items, directory) {
      if (closing) throw new Error('软件正在退出，无法开始下载');
      const active = [...jobs.values()].filter(job => !['done', 'error', 'cancelled'].includes(job.state)).length;
      if (active + items.length > 100) throw new Error('下载队列已满，请先完成或取消部分任务');
      pending += items.length;
      const batch = { remaining: items.length, cache: items.length > 1 && items.some(item => item.split) };
      const added = items.map(item => {
        const job = { id: randomUUID(), owner, item, directory, batch, state: 'queued', controller: new AbortController() };
        jobs.set(job.id, job); update(job);
        job.finished = tail = tail.then(() => run(job)).catch(error => { job.state = 'error'; job.error = error.message; update(job); });
        return view(job);
      });
      return added;
    },
    list(owner) { return [...jobs.values()].filter(job => job.owner === owner).map(view); },
    retry(owner, id) { const job = jobs.get(id); if (!job || job.owner !== owner || !['error', 'cancelled'].includes(job.state)) throw new Error('该任务不能重试'); return this.add(owner, [{ ...job.item }], job.directory); },
    cancel(owner, id) { const job = jobs.get(id); if (!job || job.owner !== owner || ['done', 'error', 'cancelled', 'committing'].includes(job.state)) return false; job.controller.abort(); job.state = 'cancelled'; update(job); return true; },
    dismiss(owner, id) { const job = jobs.get(id); if (!job || job.owner !== owner || !['done', 'error', 'cancelled'].includes(job.state)) return false; jobs.delete(id); return true; },
    reveal(owner, id) { const job = jobs.get(id); return job?.owner === owner && job.state === 'done' ? job.file : null; },
    cancelOwner(owner) { for (const job of jobs.values()) if (job.owner === owner) { if (!['done', 'error', 'cancelled'].includes(job.state)) job.controller.abort(); jobs.delete(job.id); } },
    hasPending() { return pending > 0; },
    async shutdown() { closing = true; for (const job of jobs.values()) if (!['done', 'error', 'cancelled', 'committing'].includes(job.state)) job.controller.abort(); await tail; },
    async idle() { await tail; },
  };
}
module.exports = { normalizePlayInfo, bestTrack, outputFormat, safeName, validateItems, convertAudio, createDownloader };
