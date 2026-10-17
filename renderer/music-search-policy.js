// Shared search intent and listening policy; no network or account dependencies.
(function (root) {
  const compact = value => String(value || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  const names = ['The Weeknd', 'Bruno Mars', 'Ariana Grande', 'Billie Eilish', 'Taylor Swift', 'Lana Del Rey', 'Dua Lipa', 'Ed Sheeran', 'Justin Bieber', 'Charlie Puth', 'Post Malone', 'Linkin Park', 'Imagine Dragons', 'Maroon 5', 'Michael Jackson'];
  const aliases = new Map(names.map(name => [compact(name), name]));
  aliases.set('theweekend', 'The Weeknd');
  function intent(keyword) {
    const original = String(keyword || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
    // Only correct a complete artist name, optionally followed by an explicit music qualifier.
    // Do not rewrite song titles such as "Hymn for the Weekend" or "BIBI The Weekend".
    let canonical = aliases.get(compact(original)), suffix = '';
    if (!canonical) {
      const match = original.match(/^(.+?)\s*(合集|歌单|精选|歌曲|音乐|专辑|playlist|songs|hits)$/i);
      if (match) { canonical = aliases.get(compact(match[1])); suffix = canonical ? ' ' + match[2] : ''; }
    }
    const effective = canonical ? canonical + suffix : original;
    const title = !canonical && (/[【〖《“「『\[\]"]/.test(original) || original.length > 32);
    return { original, effective, artist: canonical || '', corrected: effective !== original, title };
  }
  function seconds(value) {
    if (typeof value === 'string' && value.includes(':')) {
      const parts = value.trim().split(':').map(Number);
      return parts.length <= 3 && parts.every(n => Number.isFinite(n) && n >= 0) ? parts.reduce((n, part) => n * 60 + part, 0) : 0;
    }
    const n = Number(value); return Number.isFinite(n) && n >= 0 ? n : 0;
  }
  const tutorial = /舞蹈(?:教学|教程|分解|练习)|(?:慢速|镜面|数拍).*(?:分解|教学|舞)|数拍|跟跳|分解教学|编舞(?:教学|教程|分解)|(?:钢琴|吉他|弹唱|乐理|唱歌)(?:教学|教程|课程)|零基础.*(?:舞|唱|琴)|自我介绍|开箱|(?:歌曲|音乐)(?:解析|讲解)|\breaction\b|乐评/i;
  function nonMusic(item, keyword = '') {
    const title = String(item.title || '');
    if (tutorial.test(title)) return true;
    if (/爵士入门/.test(title) && /舞|编舞|动作/.test(`${title} ${item.author || ''} ${item.category || ''}`)) return true;
    const artist = intent(keyword).artist;
    return artist === 'The Weeknd' && /hymn\s+for\s+the\s+weekend/i.test(title) && !/weeknd/i.test(title);
  }
  function eligible(item, keyword = '') { return seconds(item.duration) >= 180 && !nonMusic(item, keyword); }
  function band(item, keyword) {
    if (!eligible(item, keyword)) return nonMusic(item, keyword) ? 5 : 4;
    if (/混剪|踩点剪辑|\b(?:AMV|MAD)\b/i.test(item.title || '')) return 3;
    const artist = intent(keyword).artist;
    if (!artist) return 0;
    const target = compact(artist);
    if (compact(item.title).includes(target) || compact(item.author || item.up).includes(target)) return 0;
    if (compact(item.tags).includes(target)) return 1;
    return 2;
  }
  function platformCompare(a, b) {
    return (a.queryRank || 0) - (b.queryRank || 0) || (a.platformRank || 0) - (b.platformRank || 0);
  }
  function order(items, keyword, titleScore) {
    const query = intent(keyword);
    return items.slice().sort((a, b) => band(a, keyword) - band(b, keyword)
      || (query.title ? titleScore ? titleScore(b.title, query.effective) - titleScore(a.title, query.effective) : (b.titleMatchScore || 0) - (a.titleMatchScore || 0) : 0)
      || platformCompare(a, b));
  }
  const api = { intent, seconds, eligible, nonMusic, band, platformCompare, order };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MusicSearch = api;
})(globalThis);
