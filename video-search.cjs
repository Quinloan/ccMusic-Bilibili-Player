// Bounded supplementary searches for copied titles; all results still come from Bilibili.
const musicPolicy = require('./renderer/music-search-policy.js');
function cleanText(value) {
  let text = String(value ?? '');
  for (let i = 0; i < 2; i++) {
    text = text.replace(/<[^>]*>/g, '').replace(/&(#x[\da-f]+|#\d+|amp|quot|apos|lt|gt|nbsp);/gi, (entity, key) => {
      if (key[0] !== '#') return ({ amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' })[key.toLowerCase()];
      const point = key[1].toLowerCase() === 'x' ? parseInt(key.slice(2), 16) : Number(key.slice(1));
      return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : '';
    });
  }
  return text.replace(/<[^>]*>/g, '').replace(/[\u200b-\u200d\ufeff]/g, '').trim();
}
const compact = text => cleanText(text).normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
function plainQuery(text) {
  return text.normalize('NFKC')
    .replace(/hi[\s-]*res|\b(?:\d+(?:\.\d+)?\s*(?:khz|hz|kbps|bit)|flac|wav|mp3)\b/gi, ' ')
    .replace(/无损音质|无损|高音质|超清音质/gu, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/([\p{Script=Han}])([a-z\d])/giu, '$1 $2')
    .replace(/([a-z\d])([\p{Script=Han}])/giu, '$1 $2')
    .replace(/\s+/g, ' ').trim();
}
function titleQueries(keyword) {
  const original = musicPolicy.intent(cleanText(keyword).slice(0, 240)).effective;
  if (!original) return [];
  const queries = [original];
  const add = text => {
    if (text.length >= 2 && !queries.some(q => q.toLowerCase() === text.toLowerCase())) queries.push(text);
  };
  const plain = plainQuery(original);
  if (plain !== original) add(plain);
  const quoted = [...original.matchAll(/[“「『《"]([^”」』》"]{4,})[”」』》"]/gu)]
    .map(m => plainQuery(m[1])).sort((a, b) => b.length - a.length);
  if (quoted.length) add(quoted[0]);
  // Strip bracketed format labels without discarding the song or artist outside them.
  if (queries.length < 3 && /[【〖\[]/.test(original)) {
    add(plainQuery(original.replace(/[【〖\[][^】〗\]]*[】〗\]]/gu, ' ')));
  }
  return queries.slice(0, 3);
}
function titleScore(title, keyword) {
  const a = compact(title), b = compact(keyword);
  if (!a || !b) return 0;
  if (a === b) return 100;
  const pa = compact(plainQuery(cleanText(title))), pb = compact(plainQuery(cleanText(keyword)));
  if (pa && pa === pb) return 98;
  if (a.includes(b) || b.includes(a)) return 65 + 25 * Math.min(a.length, b.length) / Math.max(a.length, b.length);
  const pairs = value => new Set(Array.from({ length: Math.max(0, value.length - 1) }, (_, i) => value.slice(i, i + 2)));
  const x = pairs(pa), y = pairs(pb);
  const shared = [...x].filter(pair => y.has(pair)).length;
  return x.size + y.size ? 80 * 2 * shared / (x.size + y.size) : 0;
}
function mapVideo(it) {
  return { bvid: it.bvid, title: cleanText(it.title), author: cleanText(it.author),
    pic: it.pic?.startsWith('//') ? 'https:' + it.pic : it.pic,
    duration: it.duration, play: it.play, danmaku: it.video_review, tags: cleanText(it.tag || ''), category: cleanText(it.typename || '') };
}
function createVideoSearch(fetchPage, now = Date.now) {
  const cache = new Map();
  return async function search(keyword, page = 1) {
    const queries = titleQueries(keyword);
    if (!queries.length) return { list: [], hasMore: false, supplemented: false };
    const key = queries[0];
    const intent = musicPolicy.intent(cleanText(keyword));
    page = Math.max(1, Math.min(100, Math.floor(Number(page) || 1)));
    let session = cache.get(key);
    if (!session || now() - session.at > 5 * 60 * 1000) {
      session = { at: now(), sources: [], pages: new Map(), seen: new Set(), inflight: new Map() };
      cache.delete(key);
      cache.set(key, session);
      while (cache.size > 20) cache.delete(cache.keys().next().value);
    }
    const decorate = result => ({ ...result, corrected: intent.corrected, effectiveQuery: key });
    if (session.pages.has(page)) return decorate(session.pages.get(page));
    if (session.inflight.has(page)) return decorate(await session.inflight.get(page));
    const task = (async () => {
    // Initialize page 1 before pagination so query choice and duplicate filtering stay consistent.
    if (page > 1 && !session.pages.has(1)) await search(keyword, 1);
    const candidates = page === 1 ? queries.map((query, rank) => ({ query, rank, more: true, nextPage: 1 })) : session.sources.filter(s => s.more);
    const collected = [], successful = [];
    let error = null, partial = false, calls = 0;
    async function collect(source) {
      try {
        const remotePage = source.nextPage;
        calls++;
        const j = await fetchPage(source.query, remotePage);
        if (!j || j.code !== 0) {
          const failure = new Error(j?.message || `搜索失败(${j?.code})`);
          failure.code = j?.code;
          throw failure;
        }
        if (j.data?.v_voucher && !Array.isArray(j.data.result)) {
          const failure = new Error('B 站搜索需要验证，请稍后重试，或在 B 站完成验证后再试；也可以粘贴视频链接或 BV 号');
          failure.code = -352;
          throw failure;
        }
        if (!Array.isArray(j.data?.result)) throw new Error('B 站搜索响应不完整，请稍后重试');
        const rows = (j.data?.result || []).filter(it => it.bvid).map((it, index) => ({ ...mapVideo(it), queryRank: source.rank, platformRank: (remotePage - 1) * 1000 + index,
          titleMatchScore: intent.title ? titleScore(it.title, key) : 0 }));
        collected.push(...rows);
        source.more = Number(j.data?.numPages || 1) > remotePage;
        source.nextPage++;
        if (!successful.includes(source)) successful.push(source);
        return true;
      } catch (failure) {
        error = failure;
        partial = true;
        // Stop on explicit access/rate controls; do not multiply requests after those responses.
        return ![-412, -352, -509, 429, 403].includes(Number(failure.code));
      }
    }
    for (const source of candidates) {
      if (!await collect(source)) break;
      if (page === 1 && intent.title && collected.some(it => titleScore(it.title, key) >= 98)) break;
    }
    // Filtering short clips must not leave an apparently empty first page when more music is available.
    while (page === 1 && !intent.title && !partial && calls < 3
      && new Set(collected.filter(it => musicPolicy.eligible(it, key)).map(it => it.bvid)).size < 8) {
      const source = successful.find(s => s.more);
      if (!source || !await collect(source)) break;
    }
    if (!successful.length && error) throw error;
    if (page === 1) session.sources = successful;
    const unique = new Map();
    for (const it of collected) if (!session.seen.has(it.bvid) && !unique.has(it.bvid)) unique.set(it.bvid, it);
    const list = musicPolicy.order([...unique.values()], key, titleScore);
    for (const it of list) session.seen.add(it.bvid);
    const result = { list, hasMore: successful.some(s => s.more), supplemented: session.sources.length > 1, partial,
      effectiveQuery: key, corrected: intent.corrected, titleMode: intent.title };
    // Cache displayed pages including partial success so a retry cannot lose rows through deduplication.
    session.pages.set(page, result);
    return result;
    })();
    session.inflight.set(page, task);
    try { return decorate(await task); }
    finally { session.inflight.delete(page); }
  };
}
module.exports = { cleanText, compact, titleQueries, titleScore, createVideoSearch };
