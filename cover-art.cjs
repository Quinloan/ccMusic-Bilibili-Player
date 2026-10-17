// Metadata only: no audio URLs, account cookies or fingerprint requests.
const fs = require('node:fs'), path = require('node:path');
const { randomUUID } = require('node:crypto');
const { encodeRequest } = require('./netease-lyrics.cjs');
const { songCoverUrl, songTitleIntent } = require('./renderer/library-model.js');
const simplify = require('opencc-js').Converter({ from: 'tw', to: 'cn' });
const normalize = value => simplify(String(value || '').normalize('NFKC').toLowerCase()).replace(/[^\p{L}\p{N}]/gu, '');
// Versions are part of the recording identity. Never erase “治愈版”, Live, etc.
const titleKey = value => normalize(String(value || '').replace(/[（(\[]\s*(?:original(?:\s+version)?|原版|原唱|官方音源|\d{4}\s*remaster(?:ed)?)\s*[）)\]]/gi, ''));
const artistNames = value => String(value || '').split(/\/|、|&|,|，|\bfeat\.?\s*/i).map(normalize).filter(Boolean).sort();
const sameArtists = (a, b) => {
  const wanted = artistNames(a), found = artistNames(b);
  return wanted.length > 0 && wanted.length === found.length && wanted.every((name, i) => name === found[i]);
};
const alternateVersion = value => /\blive\b|现场|演唱会|翻唱|\bcover\b|remix|混音|伴奏|instrumental|钢琴|piano|治愈版|深情版|加速|降速|slowed|sped\s*up|rehearsal|demo|\bAI\b/i.test(String(value || ''));
function sameSong(match, name, artist) {
  const title = titleKey(match.name);
  if (!title || title !== titleKey(name)) return false;
  if (!match.artist) return true;
  return sameArtists(match.artist, artist);
}
function createArtworkResolver({ request = fetch, dispatcher, cacheFile, now = Date.now, interval = 500 } = {}) {
  const cache = new Map(), pending = new Map();
  const deviceId = randomUUID();
  let tail = Promise.resolve(), nextAt = 0, blockedNetease = 0, blockedQQ = 0;
  if (cacheFile) try {
    if (fs.statSync(cacheFile).size <= 2 * 1024 * 1024) {
      const stored = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      if (stored.version === 1 && Array.isArray(stored.entries)) for (const [key, value] of stored.entries.slice(-500)) {
        if (typeof key === 'string' && value.expires > now() && (songCoverUrl(value.url) || value.song?.name)) cache.set(key, value);
      }
    }
  } catch (_) {}
  function remember(key, url, song) {
    cache.delete(key); cache.set(key, { url, song, expires: now() + (url || song ? 30 * 86400000 : 15 * 60000) });
    while (cache.size > 500) cache.delete(cache.keys().next().value);
    if (!cacheFile || (!url && !song)) return;
    const temp = cacheFile + '.' + randomUUID() + '.tmp';
    try {
      fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
      fs.writeFileSync(temp, JSON.stringify({ version: 1, entries: [...cache].filter(([, value]) => (value.url || value.song) && value.expires > now()) }));
      fs.renameSync(temp, cacheFile);
    } catch (_) {} finally { try { fs.unlinkSync(temp); } catch (_) {} }
  }
  async function netease(route, data, signal) {
    if (now() < blockedNetease) return null;
    const header = { os: 'osx', appver: '3.1.0', deviceId, requestId: String(now()) };
    try {
      const params = encodeRequest(route, { ...data, e_r: false, header });
      const res = await request('https://interface.music.163.com/eapi' + route.slice(4), {
        method: 'POST', body: new URLSearchParams({ params }).toString(), dispatcher,
        signal: AbortSignal.any([signal, AbortSignal.timeout(4500)]),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Mozilla/5.0', Referer: 'https://music.163.com/', Cookie: 'os=osx; appver=3.1.0' },
      });
      if ([403, 405, 429].includes(res.status)) blockedNetease = now() + 60000;
      if (!res.ok) return null;
      const json = await res.json();
      if ([403, 405, 429].includes(json.code)) blockedNetease = now() + 60000;
      return json.code === 200 ? json : null;
    } catch (_) { return null; }
  }
  const neteaseCover = song => songCoverUrl(song?.al?.picUrl || song?.album?.picUrl);
  function qqSong(song) {
    let name = song.name || song.title;
    if (alternateVersion(song.subtitle) && !alternateVersion(name)) name += ` (${song.subtitle})`;
    return { name, artist: (song.singer || []).map(a => a.name).join('/'), album: song.album?.name || '',
      cover: /^[a-zA-Z0-9]{5,40}$/.test(song.album?.mid || '') ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${song.album.mid}.jpg` : '' };
  }
  async function searchQQCatalog(query, signal) {
    if (signal.aborted || now() < blockedQQ) return [];
    try {
      const res = await request('https://u.y.qq.com/cgi-bin/musicu.fcg', {
        method: 'POST', dispatcher, signal: AbortSignal.any([signal, AbortSignal.timeout(4500)]),
        headers: { 'Content-Type': 'application/json', Referer: 'https://y.qq.com/', 'User-Agent': 'Mozilla/5.0' },
        body: JSON.stringify({ comm: { ct: '19', cv: '1859', uin: '0' }, req: {
          module: 'music.search.SearchCgiService', method: 'DoSearchForQQMusicDesktop',
          param: { grp: 1, num_per_page: 8, page_num: 1, query, search_type: 0 },
        } }),
      });
      if ([403, 405, 429].includes(res.status)) blockedQQ = now() + 60000;
      if (!res.ok) return [];
      const data = await res.json();
      if (data.code !== 0 || data.req?.code !== 0) return [];
      return (data.req?.data?.body?.song?.list || []).map(qqSong);
    } catch (_) { return []; }
  }
  async function searchQQ(query, signal, intent) {
    const songs = await searchQQCatalog(query, signal);
    if (titleMatch(intent, songs) || signal.aborted || now() < blockedQQ) return songs;
    // Desktop search sometimes returns 2001/empty. Public suggestions still expose
    // song IDs; hydrate one verified candidate to check its version and album.
    try {
      const options = { dispatcher, signal: AbortSignal.any([signal, AbortSignal.timeout(4500)]), headers: { Referer: 'https://y.qq.com/', 'User-Agent': 'Mozilla/5.0' } };
      const res = await request('https://c.y.qq.com/splcloud/fcgi-bin/smartbox_new.fcg?' + new URLSearchParams({ key: query, format: 'json' }), options);
      if ([403, 405, 429].includes(res.status)) blockedQQ = now() + 60000;
      if (!res.ok) return [];
      const data = await res.json();
      const hints = (data.code === 0 ? data.data?.song?.itemlist || [] : []).slice(0, 8)
        .filter(s => /^\d{1,20}$/.test(String(s.id)) && /^[a-zA-Z0-9]{5,40}$/.test(s.mid || ''))
        .map(s => ({ name: s.name, artist: s.singer || '', id: String(s.id), mid: s.mid }));
      const best = titleMatch(intent, hints);
      if (!best) return [];
      const detail = await request('https://u.y.qq.com/cgi-bin/musicu.fcg', { ...options, method: 'POST', headers: { ...options.headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ comm: { ct: 24, cv: 0 }, req: { module: 'music.pf_song_detail_svr', method: 'get_song_detail_yqq', param: { song_type: 0, song_mid: best.mid, song_id: Number(best.id) } } }) });
      if ([403, 405, 429].includes(detail.status)) blockedQQ = now() + 60000;
      if (!detail.ok) return [];
      const json = await detail.json(), track = json.req?.data?.track_info;
      if (json.code !== 0 || json.req?.code !== 0 || !track || String(track.id) !== best.id) return [];
      const song = qqSong(track);
      return titleMatch(intent, [song]) ? [song] : [];
    } catch (_) { return []; }
  }
  function titleMatch(intent, songs) {
    const ranked = songs.map(song => {
      let score = 0;
      const explicitVersion = alternateVersion(intent.raw);
      if (!explicitVersion && alternateVersion(song.name + ' ' + (song.album || ''))) return { song, score };
      for (const candidate of intent.candidates) {
        if (sameSong(candidate, song.name, song.artist)) score = Math.max(score, candidate.artist ? 140 : 60);
        const context = normalize(intent.raw + ' ' + intent.parentArtist);
        const singers = artistNames(song.artist);
        if (!candidate.artist && titleKey(candidate.name) === titleKey(song.name) && singers.length && singers.every(a => a.length >= 2 && context.includes(a))) score = Math.max(score, 120);
      }
      const combined = normalize(intent.raw), name = titleKey(song.name), artist = normalize(song.artist);
      if (artist && name && [artist + name, name + artist].includes(combined)) score = Math.max(score, 140);
      if (score && artist && combined.includes(artist)) score += 20;
      return { song, score };
    }).filter(hit => hit.score).sort((a, b) => b.score - a.score);
    const best = ranked[0];
    if (best?.score <= 60 && ranked.some(hit => hit.score === best.score && normalize(hit.song.artist) !== normalize(best.song.artist))) return null;
    if (!best) return null;
    const { album, ...metadata } = best.song;
    return metadata;
  }
  function resolveTitle(input = {}) {
    const intent = songTitleIntent(input);
    if (!intent) return Promise.resolve(null);
    const key = 'title:v2:' + normalize(input.title) + '|' + normalize(input.parentTitle);
    if (cache.get(key)?.expires > now()) return Promise.resolve(cache.get(key).song || (intent.fallback ? { ...intent.fallback, matched: false } : null));
    if (pending.has(key)) return pending.get(key);
    if (pending.size >= 200) return Promise.resolve(null);
    const job = tail.then(async () => {
      await require('node:timers/promises').setTimeout(Math.max(0, nextAt - now()));
      const signal = AbortSignal.timeout(12000);
      const data = await netease('/api/cloudsearch/pc', { s: intent.query, type: 1, limit: 8, offset: 0, total: true }, signal);
      let song = titleMatch(intent, (data?.result?.songs || []).map(song => ({ name: song.name, artist: (song.ar || song.artists || []).map(a => a.name).join('/'),
        album: song.al?.name || song.album?.name || '', neteaseId: String(song.id || ''), cover: neteaseCover(song) })));
      if (!song?.cover) {
        const other = titleMatch(intent, await searchQQ(intent.query, signal, intent));
        if (other) song = song && sameSong(song, other.name, other.artist) ? { ...song, cover: other.cover || '' } : other;
      }
      nextAt = now() + interval;
      const result = song ? { ...song, matched: true } : intent.fallback ? { ...intent.fallback, matched: false } : null;
      remember(key, song?.cover || '', song ? result : undefined);
      return result;
    }).catch(() => null).finally(() => pending.delete(key));
    tail = job; pending.set(key, job); return job;
  }
  async function lookup(match) {
    const signal = AbortSignal.timeout(12000);
    const intent = { raw: match.name, candidates: [match], parentArtist: match.artist };
    if (match.neteaseId) {
      const data = await netease('/api/v3/song/detail', { c: JSON.stringify([{ id: match.neteaseId }]) }, signal);
      const song = data?.songs?.find(song => String(song.id) === match.neteaseId);
      const url = neteaseCover(song); if (url) return url; // Playback privileges are irrelevant to artwork.
    }
    if (!signal.aborted && match.name) {
      const data = await netease('/api/cloudsearch/pc', { s: `${match.name} ${match.artist}`.trim(), type: 1, limit: 8, offset: 0, total: true }, signal);
      const song = titleMatch(intent, (data?.result?.songs || []).map(s => ({ name: s.name, artist: (s.ar || s.artists || []).map(a => a.name).join('/'), album: s.al?.name || s.album?.name || '', cover: neteaseCover(s) })));
      if (song?.cover) return song.cover;
    }
    if (match.name) return titleMatch(intent, await searchQQ(`${match.name} ${match.artist}`.trim(), signal, intent))?.cover || '';
    return '';
  }
  function resolve(input = {}) {
    const match = { name: String(input.name || '').trim().slice(0, 500), artist: String(input.artist || '').trim().slice(0, 300),
      neteaseId: /^\d{1,20}$/.test(String(input.neteaseId || '')) ? String(input.neteaseId) : '' };
    const key = match.neteaseId ? 'netease:' + match.neteaseId : 'art:v2:' + titleKey(match.name) + '|' + normalize(match.artist);
    const direct = songCoverUrl(input.cover);
    if (direct) { remember(key, direct); return Promise.resolve(direct); }
    if (!match.name && !match.neteaseId) return Promise.resolve('');
    if (cache.get(key)?.expires > now()) return Promise.resolve(cache.get(key).url);
    if (pending.has(key)) return pending.get(key);
    if (pending.size >= 200) return Promise.resolve('');
    const job = tail.then(async () => {
      await require('node:timers/promises').setTimeout(Math.max(0, nextAt - now()));
      const url = await lookup(match); nextAt = now() + interval; remember(key, url); return url;
    }).catch(() => '').finally(() => pending.delete(key));
    tail = job; pending.set(key, job); return job;
  }
  return { resolve, resolveTitle };
}
module.exports = { createArtworkResolver, sameSong };
