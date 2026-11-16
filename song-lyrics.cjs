'use strict';
const fs = require('node:fs');
const { sameSong } = require('./cover-art.cjs');
const { parseLrc } = require('./renderer/lyrics-model.js');
function createLyricsProvider({ request, resolveTitle, cacheFile }) {
  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch {}
  const pending = new Map();
  async function lookup(input) {
    const key = JSON.stringify([input.title, input.artist || '', input.neteaseId || '']);
    if (cache[key]?.expires > Date.now()) return cache[key].value;
    if (pending.has(key)) return pending.get(key);
    const work = load(input).then(value => {
      if (value) {
        cache[key] = { expires: Date.now() + 30 * 86400000, value };
        cache = Object.fromEntries(Object.entries(cache).slice(-300));
        try { fs.writeFileSync(cacheFile + '.tmp', JSON.stringify(cache)); fs.renameSync(cacheFile + '.tmp', cacheFile); } catch {}
      }
      return value;
    }).finally(() => pending.delete(key));
    pending.set(key, work);
    return work;
  }
  async function load(input) {
    const signal = AbortSignal.timeout(16000);
    const get = async (url, referer) => {
      const r = await request(url, { signal, headers: { Referer: referer } });
      return r.ok ? r.json() : null;
    };
    let id = /^\d{1,20}$/.test(input.neteaseId || '') ? input.neteaseId : '';
    let song;
    if (!id) {
      song = await resolveTitle({ title: input.title, artist: input.artist || '' }).catch(() => null);
      if (song?.matched) id = song.neteaseId;
    }
    if (id) try {
      const j = await get('https://music.163.com/api/song/lyric?' + new URLSearchParams({ id, lv: -1, kv: -1, tv: -1 }), 'https://music.163.com/');
      const lyric = j?.lrc?.lyric;
      if (lyric && !/纯音乐，请欣赏/.test(lyric)) return { lyric, translation: j.tlyric?.lyric || '', source: '网易云音乐' };
    } catch {}
    // Verify both the title and performer before choosing a QQ catalogue entry.
    try {
      let mid = song?.qqMid || '';
      if (!mid) {
        const j = await get('https://c.y.qq.com/splcloud/fcgi-bin/smartbox_new.fcg?' + new URLSearchParams({ key: input.title + ' ' + (input.artist || ''), format: 'json' }), 'https://y.qq.com/');
        const match = (j?.data?.song?.itemlist || []).find(s => input.artist && sameSong({ name: input.title, artist: input.artist }, s.name, s.singer));
        mid = match?.mid || '';
      }
      if (/^[a-z0-9]{5,40}$/i.test(mid)) {
        const j = await get('https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?' + new URLSearchParams({ songmid: mid, format: 'json', nobase64: 1 }), 'https://y.qq.com/');
        if (j?.code === 0 && j.lyric) return { lyric: j.lyric, translation: j.trans || '', source: 'QQ 音乐' };
      }
    } catch {}
    return null;
  }
  return { lookup };
}
module.exports = { createLyricsProvider, parseLrc };
