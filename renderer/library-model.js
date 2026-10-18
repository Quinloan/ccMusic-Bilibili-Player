/* Pure data rules shared by the UI and headless regression tests. */
(function (root) {
  const duration = value => typeof value === 'string' && value.includes(':')
    ? value.split(':').reduce((n, part) => n * 60 + Number(part), 0) : Number(value);
  const isVideoPart = item => !!item && !item.split && ((+item.page || 1) > 1 || Number(item.partsCount) > 1 ||
    (Number(item.partsCount) !== 1 && !!item.partTitle));
  function songCoverUrl(value) {
    if (typeof value !== 'string' || value.length > 2000) return '';
    try {
      const url = new URL(value);
      if (url.protocol === 'http:' && /(?:^|\.)(?:music\.126\.net|gtimg\.cn|mzstatic\.com)$/.test(url.hostname)) url.protocol = 'https:';
      return url.protocol === 'https:' && !url.username && !url.password ? url.href : '';
    } catch (_) { return ''; }
  }
  function songTitleIntent(input = {}) {
    const quality = /\bhi[ -]?res\b|\b(?:flac|wav|mp3|aac|mv|pv|hd|uhd|official\s*(?:audio|video|mv)?)\b|\b\d+(?:\.\d+)?\s*(?:khz|hz|kbps|bit|fps|k)\b|无损音质|无损|高音质|高品质|高解析|母带|杜比|音质|中英字幕|中英双字|中文字幕|中字|双语字幕|官方音乐录影带|官方MV|高清修复|超清修复|高清|超清|纯享版|纯享|百万级(?:装备|设备)(?:试)?听|设备试听|耳机试听|音箱试听/gi;
    const clean = text => String(text || '').slice(0, 500).normalize('NFKC')
      .replace(/<[^>]*>/g, '').replace(/&amp;/gi, '&').replace(/&quot;|&#34;/gi, '"').replace(/&#39;|&apos;/gi, "'")
      .replace(/[\u200b-\u200d\ufeff]/g, '').replace(quality, ' ')
      .replace(/[【\[〖]([^】\]〗]*)[】\]〗]/g, ' $1 ')
      .replace(/[（(]\s*(?:官方|official|修复|完整版|\d{4})[^）)]*[）)]/gi, ' ')
      .replace(/^\s*(?:p\s*\d+\s*[-.、_:：]?|\d{1,3}\s*[.、_：:\-]|\d{1,3}\s+(?=\D))\s*/i, '')
      .replace(/^[\s/|:：,，\-–—]+|[\s/|:：,，\-–—]+$/g, '').replace(/\s+/g, ' ').trim();
    const raw = clean(input.title);
    if (!raw || /^(?:p?\d+|正片|完整版|视频|高清版本?|曲目\s*\d+(?:[（(].*[）)])?)$/i.test(raw)) return null;
    if (/合集|歌单|串烧|精选集|全专辑|专辑完整|playlist|full\s+album/i.test(raw)) return null;
    const parentSource = String(input.parentTitle || '');
    const parentLabelFree = parentSource.replace(/[【\[〖]([^】\]〗]*)[】\]〗]/g, (whole, label) => /B\s*站|bilibili|附\s*MV/i.test(label) ? ' ' : whole);
    let parentArtist = clean(parentLabelFree).replace(/[《「“][^》」”]*[》」”]/g, ' ')
      .replace(/[（(][^）)]*[）)]/g, ' ')
      .replace(/\bR\s*&\s*B\b|\b(?:pop|hip\s*hop|rock|jazz)\b/gi, ' ')
      .replace(/\d+(?:\.\d+)?\s*(?:小时|分钟|分|小时版)|热门|热歌|金曲|精选/gi, ' ')
      .replace(/录音室作品|录音室专辑|音乐作品|作品全集|作品合集|歌曲全集|音乐全集|歌曲合集|音乐合集|全专辑|全歌曲|全部歌曲|热门歌曲|精选歌曲|歌曲精选|金曲精选|精选|全集|合集|合辑|专辑|音乐|歌曲|收录|大全|全辑|完整|\d+首/gi, '').trim();
    if (!parentArtist || parentArtist.length > 45 || /[《》「」“”!?！？:：|]|B站|华语|欧美|热门|流行|经典|歌单|串烧|推荐|盘点|放松|通勤|专注|翻唱|现场|演唱会|\bcover\b|\bAI\b/i.test(parentArtist)) parentArtist = '';
    const versioned = /翻唱|现场|演唱会|伴奏|\b(?:cover|live|remix|AI)\b/i.test(raw + ' ' + parentSource);
    if (input.parentTitle && /专辑/.test(raw) && /翻唱|伴奏|\b(?:cover|AI)\b/i.test(raw + ' ' + parentSource)) return null;
    let albumPart = null, albumLabel = false;
    // An explicit trailing album label is metadata, not part of the song name.
    // Require the collection's artist; keep real colons and recording versions.
    const labelled = input.parentTitle && parentArtist && raw.match(/^(.+?)\s+专辑\s*[:：]\s*([^:：]{1,80})$/);
    if (labelled) { albumPart = { name: labelled[1].trim(), artist: parentArtist }; albumLabel = true; }
    if (input.parentTitle && !versioned) {
      const suffix = parentArtist && parentArtist + '同名专辑';
      if (suffix && raw.endsWith(suffix) && raw.slice(0, -suffix.length).trim()) albumPart = { name: raw.slice(0, -suffix.length).trim(), artist: parentArtist };
      if (!albumPart && parentArtist) {
        const at = raw.lastIndexOf(' ' + parentArtist);
        const album = at >= 0 ? raw.slice(at + 1 + parentArtist.length).trim() : '';
        if (at > 0 && album.length <= 80 && /专辑$/.test(album)) albumPart = { name: raw.slice(0, at).trim(), artist: parentArtist };
      }
      if (!albumPart) {
        const match = raw.match(/^(.+)\s+([\p{L}\p{N}][\p{L}\p{N}.&/、·-]{0,44})同名专辑$/u);
        if (match && (!parentArtist || parentArtist === match[2])) albumPart = { name: match[1].trim(), artist: match[2] };
      }
      if (albumPart) albumPart.name = albumPart.name.replace(/^[《「“]([^》」”]+)[》」”]$/, '$1');
    }
    const quoted = [...raw.matchAll(/[《「“]([^》」”]+)[》」”]/g)];
    if (quoted.length > 1 && (!albumPart || /[《「“]/.test(albumPart.name))) return null;
    let candidates, query, fallback = null;
    if (albumPart) {
      candidates = [albumPart]; query = `${albumPart.name} ${albumPart.artist}`; fallback = { ...albumPart };
    } else if (quoted.length === 1) {
      let name = quoted[0][1].trim();
      let artist = clean(raw.replace(quoted[0][0], ' '));
      artist = artist.replace(/[（(]([^）)]*)[）)]/g, (whole, text) => {
        if (/live|现场|remix|伴奏|版|cover|翻唱/i.test(text)) { name += whole; return ' '; }
        return whole;
      }).trim();
      if (artist.length > 45 || /携手|翻唱|现场|好听|天籁|百万|设备|试听|首秀|字幕|原唱|歌词|版本|录音|一首|听哭|演唱会/.test(artist)) artist = '';
      artist ||= parentArtist;
      candidates = [{ name, artist }]; query = `${name} ${artist}`.trim(); fallback = { name, artist };
    } else {
      let parts = raw.split(/\s+[-–—|]\s+|[–—|]/).map(clean).filter(Boolean);
      if (parts.length === 1 && raw.includes('-')) parts = raw.split('-').map(clean).filter(Boolean);
      if (parts.length === 2) candidates = [{ name: parts[1], artist: parts[0] }, { name: parts[0], artist: parts[1] }];
      else candidates = [{ name: raw, artist: parentArtist }];
      query = parts.length === 2 ? parts.join(' ') : `${raw} ${parentArtist}`.trim();
    }
    candidates = candidates.filter(c => c.name && c.name.length <= 100 && !/^\d+$/.test(c.name));
    if (!fallback && candidates.length === 1 && parentArtist) fallback = { ...candidates[0] };
    const metadataVersion = albumLabel ? 4 : albumPart || (parentArtist && (parentLabelFree !== parentSource || /录音室作品|录音室专辑|音乐作品|作品全集|作品合集/.test(parentSource))) ? 3 : 2;
    return candidates.length ? { raw, candidates, query: query.slice(0, 240), fallback, parentArtist, metadataVersion } : null;
  }
  function validateTracks(tracks, seconds) {
    if (!Array.isArray(tracks) || tracks.length < 2 || tracks.length > 1000) throw new Error('请保留至少两首曲目');
    let end = 0;
    const result = tracks.map((track, i) => {
      const start = Number(track.start), next = Number(track.end);
      if (![start, next].every(Number.isFinite) || Math.abs(start - end) > 0.2 || next - start < 0.1 || next > seconds + 0.2) throw new Error(`第 ${i + 1} 首的时间范围不正确`);
      end = next;
      return { ...track, start, end: next, title: String(track.title || '').trim().slice(0, 500) };
    });
    if (Math.abs(end - seconds) > 0.2) throw new Error('曲目需要覆盖完整视频，不能遗漏结尾');
    return result;
  }
  function mergeTrack(tracks, index) {
    if (index < 1 || index >= tracks.length) return tracks;
    const rows = tracks.map(t => ({ ...t }));
    rows[index - 1].end = rows[index].end;
    rows[index - 1].source = 'manual';
    rows.splice(index, 1);
    return rows;
  }
  function cutTrack(tracks, index, time) {
    const rows = tracks.map(t => ({ ...t })), track = rows[index], at = duration(time);
    if (!track || !Number.isFinite(at) || at <= track.start + 0.1 || at >= track.end - 0.1) throw new Error('切点需要位于这首曲目内部');
    rows.splice(index, 1, { ...track, end: at, source: 'manual' }, { ...track, start: at, title: '', source: 'manual' });
    return rows;
  }
  function importedFolders(raw) {
    const folders = raw?.folders || raw?.library?.folders;
    if (!Array.isArray(folders) || !folders.length || folders.length > 200) throw new Error('文件中没有有效歌单，或歌单数量超过 200');
    let count = 0;
    return folders.map(folder => {
      if (!Array.isArray(folder.items) || !String(folder.name || '').trim()) throw new Error('歌单名称或曲目列表不完整');
      return { name: String(folder.name).trim().slice(0, 80), items: folder.items.map(item => {
        if (++count > 50000) throw new Error('最多一次导入 50000 首');
        if (!/^BV[\da-z]{10}$/i.test(item?.bvid || '')) throw new Error('存在无效 BV 号，导入已取消');
        const page = Number(item.page || 1), seconds = duration(item.duration || 0);
        if (!Number.isInteger(page) || page < 1 || page > 10000 || !Number.isFinite(seconds) || seconds < 0) throw new Error('曲目时长或分 P 无效');
        const clean = { bvid: item.bvid, page, title: String(item.title || item.bvid).slice(0, 500), duration: seconds,
          vtitle: String(item.vtitle || '').slice(0, 500), up: String(item.up || '').slice(0, 200),
          cover: /^https?:\/\//i.test(item.cover || '') ? String(item.cover).slice(0, 2000) : '' };
        if (Number.isSafeInteger(Number(item.cid)) && Number(item.cid) > 0) clean.cid = Number(item.cid);
        if (Number.isInteger(Number(item.partsCount)) && Number(item.partsCount) >= 1 && Number(item.partsCount) <= 10000) clean.partsCount = Number(item.partsCount);
        if (item.split) {
          if (![item.startSec, item.endSec].every(n => typeof n === 'number' && Number.isFinite(n)) || item.startSec < 0 || item.endSec <= item.startSec) throw new Error('分段时间无效');
          Object.assign(clean, { split: true, startSec: item.startSec, endSec: item.endSec, duration: item.endSec - item.startSec });
          if (Number.isFinite(item.originalDuration) && item.originalDuration >= item.endSec && item.originalDuration <= 1e7) clean.originalDuration = item.originalDuration;
        }
        for (const key of ['artist', 'referenceArtist', 'identifySource']) if (typeof item[key] === 'string') clean[key] = item[key].slice(0, 200);
        const artwork = songCoverUrl(item.songCover);
        if (artwork) clean.songCover = artwork;
        if (/^\d{1,20}$/.test(String(item.neteaseId || ''))) clean.neteaseId = String(item.neteaseId);
        for (const key of ['sourceTitle', 'partTitle']) if (typeof item[key] === 'string') clean[key] = item[key].slice(0, 500);
        if ([1, 2, 3, 4].includes(item.titleMetaVersion)) clean.titleMetaVersion = item.titleMetaVersion;
        return clean;
      }) };
    });
  }
  // Shared by renderer and provider: bounded work, promotable waiting requests,
  // and a deadline even when an IPC/transport ignores AbortSignal.
  function createMetadataQueue({ concurrency = 2, timeout = 15000, interval = 0 } = {}) {
    const waiting = [];
    let active = 0, nextAt = 0, wake = null, scheduled = false;
    function schedule() {
      if (scheduled) return;
      scheduled = true;
      queueMicrotask(() => { scheduled = false; pump(); });
    }
    function pump() {
      if (active >= concurrency || !waiting.length) return;
      const delay = nextAt - Date.now();
      if (delay > 0) { if (wake === null) wake = setTimeout(() => { wake = null; pump(); }, delay); return; }
      waiting.sort((a, b) => b.priority - a.priority);
      const entry = waiting.shift(); entry.started = true; active++;
      nextAt = Date.now() + interval;
      const controller = new AbortController();
      let timer;
      const expired = new Promise(resolve => { timer = setTimeout(() => { controller.abort(); resolve(null); }, timeout); });
      Promise.race([Promise.resolve().then(() => entry.run(controller.signal)), expired])
        .catch(() => null).then(entry.resolve).finally(() => { clearTimeout(timer); active--; schedule(); });
      schedule();
    }
    return {
      add(run, priority = 0) {
        const entry = { run, priority, started: false };
        const promise = new Promise(resolve => { entry.resolve = resolve; });
        promise.promote = value => { if (!entry.started) { entry.priority = Math.max(entry.priority, value); schedule(); } };
        waiting.push(entry); schedule(); return promise;
      },
      get active() { return active; }, get waiting() { return waiting.length; },
    };
  }
  const api = { duration, isVideoPart, songCoverUrl, songTitleIntent, validateTracks, mergeTrack, cutTrack, importedFolders, createMetadataQueue };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.LibraryModel = api;
})(globalThis);
