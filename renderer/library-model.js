/* Pure data rules shared by the UI and headless regression tests. */
(function (root) {
  const duration = value => typeof value === 'string' && value.includes(':')
    ? value.split(':').reduce((n, part) => n * 60 + Number(part), 0) : Number(value);
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
        if (item.split) {
          if (![item.startSec, item.endSec].every(n => typeof n === 'number' && Number.isFinite(n)) || item.startSec < 0 || item.endSec <= item.startSec) throw new Error('分段时间无效');
          Object.assign(clean, { split: true, startSec: item.startSec, endSec: item.endSec, duration: item.endSec - item.startSec });
          if (Number.isFinite(item.originalDuration) && item.originalDuration >= item.endSec && item.originalDuration <= 1e7) clean.originalDuration = item.originalDuration;
        }
        for (const key of ['artist', 'referenceArtist', 'identifySource']) if (item[key]) clean[key] = String(item[key]).slice(0, 200);
        return clean;
      }) };
    });
  }
  const api = { duration, validateTracks, mergeTrack, cutTrack, importedFolders };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.LibraryModel = api;
})(globalThis);
