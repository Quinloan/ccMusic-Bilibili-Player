'use strict';

const neteaseHosts = new Set(['music.163.com', 'y.music.163.com', '163cn.tv']);
const qqHosts = new Set(['y.qq.com', 'i.y.qq.com', 'y.qq.com.cn', 'i2.y.qq.com', 'c6.y.qq.com', 'c.y.qq.com']);
const biliHosts = new Set(['www.bilibili.com', 'bilibili.com', 'space.bilibili.com', 'm.bilibili.com', 'b23.tv']);
function shareUrl(input) {
  const link = String(input || '').slice(0, 4096).match(/https?:\/\/[^\s<>"'，。【】《》]+/i)?.[0];
  let url;
  try { url = new URL(link); } catch { throw new Error('请粘贴歌单或收藏夹的分享链接'); }
  if ((!neteaseHosts.has(url.hostname) && !qqHosts.has(url.hostname) && !biliHosts.has(url.hostname)) || url.username || url.password || url.port)
    throw new Error('请使用 B 站、网易云音乐或 QQ 音乐的官方链接');
  url.protocol = 'https:';
  return url;
}

function playlistId(url) {
  const route = url.hash.startsWith('#/') ? new URL(url.hash.slice(1), url.origin) : url;
  if (!/(?:^|\/)(?:playlist|playsquare|taoge(?:_detail)?)(?:[/.]|$)/i.test(route.pathname)) return '';
  const id = route.pathname.match(/\/(?:playlist|playsquare|taoge)\/(\d+)(?:\.html|\/|$)/i)?.[1]
    || route.searchParams.get('id') || route.searchParams.get('disstid');
  return /^\d{1,20}$/.test(id || '') ? id : '';
}

async function neteaseList(id, get) {
  const base = 'https://music.163.com/api/';
  const j = await get(base + 'v6/playlist/detail?id=' + id + '&n=100');
  const p = j.playlist;
  if (j.code !== 200 || !p) throw new Error('无法读取网易云歌单，请确认歌单已公开');
  const byId = new Map((p.tracks || []).map(row => [String(row.id), row]));
  const ids = (p.trackIds || []).map(t => String(t.id)).filter(id => /^\d+$/.test(id));
  const missing = [...new Set(ids.filter(id => !byId.has(id)))];
  for (let i = 0; i < missing.length; i += 100) {
    const batch = missing.slice(i, i + 100);
    const details = await get(base + 'song/detail?ids=' + encodeURIComponent('[' + batch.join(',') + ']'));
    if (details.code !== 200 || !Array.isArray(details.songs)) throw new Error('网易云曲目详情读取失败，请稍后重试');
    for (const row of details.songs) byId.set(String(row.id), row);
  }
  const tracks = [], unavailable = [];
  (ids.length ? ids.map(id => byId.get(id)) : [...byId.values()]).forEach((r, i) => {
    if (!r?.name) { unavailable.push({ position: i + 1, title: '网易云曲目 ID ' + ids[i] }); return; }
    tracks.push({ position: i + 1, title: r.name, artist: (r.ar || r.artists || []).map(a => a.name).filter(Boolean).join(' / '),
      seconds: Math.round((r.dt || r.duration || 0) / 1000), cover: listCover((r.al || r.album)?.picUrl) });
  });
  return { name: p.name, total: Math.max(ids.length, Number(p.trackCount) || 0), tracks, unavailable };
}

async function qqList(id, get) {
  const base = 'https://c.y.qq.com/qzone/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg?type=1&json=1&utf8=1&onlysong=0&format=json&disstid=' + id;
  const tracks = [], seenPages = new Set();
  let total = 0, name = '', offset = 0;
  do {
    const j = await get(base + '&song_num=100&song_begin=' + offset);
    const p = j.cdlist?.[0], rows = p?.songlist;
    if (j.code !== 0 || !Array.isArray(rows)) throw new Error('无法读取 QQ 音乐歌单，请确认歌单已公开');
    name = p.dissname; total = Number(p.songnum) || total;
    const pageKey = JSON.stringify(rows.map(r => r.songmid || r.songid || r.songname));
    if (!rows.length || seenPages.has(pageKey)) break;
    seenPages.add(pageKey);
    for (const [i, r] of rows.entries()) if (r.songname) tracks.push({ position: offset + i + 1, title: r.songname, artist: (r.singer || []).map(a => a.name).join(' / '),
      seconds: Number(r.interval), cover: /^[a-z0-9]+$/i.test(r.albummid || '') ? 'https://y.gtimg.cn/music/photo_new/T002R300x300M000' + r.albummid + '.jpg' : '' });
    offset += rows.length;
  } while (offset < total);
  return { name, total, tracks };
}

async function biliList(url, biliGet) {
  const audio = url.pathname.match(/^\/audio\/am(\d+)\/?$/i);
  const fid = url.pathname.match(/\/(?:list\/|medialist\/(?:play\/|detail\/)?)ml(\d+)(?:\/|$)/i)?.[1]
    || url.searchParams.get('fid') || url.searchParams.get('media_id');
  if (!audio && !/^\d{1,20}$/.test(fid || '')) throw new Error('请复制具体收藏夹或音频歌单的分享链接');
  const get = async (path, params) => {
    const j = await biliGet(path, params);
    if (j?.code !== 0) throw new Error('B 站读取失败：' + (j?.message || '请检查访问权限'));
    return j.data;
  };
  let name = 'B 站收藏夹', total = 0, position = 0;
  const unavailable = [];
  if (audio) name = (await get('/audio/music-service-c/web/menu/info', { sid: audio[1] }))?.title || 'B 站歌单';
  const tracks = [], seenPages = new Set();
  for (let page = 1; ; page++) {
    const d = audio ? await get('/audio/music-service-c/web/song/of-menu', { sid: audio[1], pn: page, ps: 20 })
      : await get('/x/v3/fav/resource/list', { media_id: fid, pn: page, ps: 20, order: 'mtime' });
    const rows = (audio ? d?.data : d?.medias) || [];
    name = d?.info?.title || name;
    total = Number(audio ? d?.totalSize : d?.info?.media_count) || total;
    const key = JSON.stringify(rows.map(r => [r.type, r.id]));
    if (!rows.length || seenPages.has(key)) break;
    seenPages.add(key);
    for (const r of rows) {
      position++;
      const bvid = r.bvid || r.bv_id;
      const song = { position, title: r.title, artist: audio ? r.author || r.uname || '' : r.upper?.name || '', seconds: r.duration, cover: r.cover };
      if (!r.title || r.title === '已失效视频' || (!audio && (r.type !== 2 || (r.attr & 9)))) {
        unavailable.push({ position, title: [r.title, bvid || r.id].filter(Boolean).join(' · '), artist: song.artist }); continue;
      }
      if (/^BV[\da-z]{10}$/i.test(bvid || '')) {
        song.item = { bvid, cid: Number(r.ugc?.first_cid || r.cid || 0), page: 1, partsCount: Number(r.page) || 1,
          title: r.title, vtitle: r.title, up: r.upper?.name || r.uname || '', duration: Number(r.duration) || 0, cover: r.cover };
        if (audio) Object.assign(song.item, { artist: song.artist, identifySource: 'playlist' });
      } else if (!audio) { unavailable.push(song); continue; }
      tracks.push(song);
    }
    if (audio ? page >= d.pageCount : !d.has_more) break;
  }
  return { name, total, tracks, unavailable };
}

async function readPlaylist(input, request, biliGet, signal) {
  const deadline = () => signal ? AbortSignal.any([signal, AbortSignal.timeout(18000)]) : AbortSignal.timeout(18000);
  let url = shareUrl(input);
  for (let hop = 0; hop < 4; hop++) {
    if (!(url.hostname === '163cn.tv' || url.hostname === 'b23.tv' || /^\/base\/fcgi-bin\/u\/?$/.test(url.pathname))) break;
    const res = await request(url, { signal: deadline(), redirect: 'manual' });
    await res.body?.cancel();
    const location = res.headers.get('location');
    if (!location || res.status < 300 || res.status > 399) break;
    url = shareUrl(new URL(location, url).href);
  }
  let list;
  if (biliHosts.has(url.hostname)) list = await biliList(url, (path, params) => biliGet(path, params, deadline()));
  else {
    const id = playlistId(url);
    if (!id) throw new Error('未找到歌单编号，请复制歌单详情页链接');
    const netease = neteaseHosts.has(url.hostname);
    const get = async endpoint => {
      const res = await request(endpoint, { signal: deadline(), redirect: 'error', headers: { Referer: netease ? 'https://music.163.com/' : 'https://y.qq.com/' } });
      if (!res.ok) throw new Error('歌单读取失败（HTTP ' + res.status + '）');
      return res.json();
    };
    list = netease ? await neteaseList(id, get) : await qqList(id, get);
  }
  if (!list.tracks.length && !list.total && !list.unavailable?.length) throw new Error('歌单中没有可读取的曲目');
  return list;
}
function listCover(value) {
  try {
    const url = new URL(value);
    return /^(?:https?:)$/.test(url.protocol) && /\.music\.126\.net$/.test(url.hostname) ? 'https://' + url.host + url.pathname : '';
  } catch { return ''; }
}
module.exports = { readPlaylist };
