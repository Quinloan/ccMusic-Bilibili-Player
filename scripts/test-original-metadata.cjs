// Recording/version selection and service fallback. No live network or audio.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { createArtworkResolver } = require('../cover-art.cjs');
const { songTitleIntent } = require('../renderer/library-model.js');
const netSong = (name, artist, album = '录音室专辑', id = 1) => ({ id, name, ar: artist.split('/').map(name => ({ name })), al: { name: album, picUrl: `https://art.test/${id}.jpg` } });
const qqSong = (name, artist, album = '魔杰座') => ({ id: 449205, name, singer: artist.split('/').map(name => ({ name })), album: { name: album, mid: '002Neh8l0uciQZ' } });
const input = { title: '07. 稻香', parentTitle: '周杰伦歌曲全集' };
const netResponse = songs => Response.json({ code: 200, result: { songs } });
const qqResponse = songs => Response.json({ code: 0, req: { code: 0, data: { body: { song: { list: songs } } } } });
async function run() {
  const parent = 'R&B陶喆热门歌曲合集【52分钟精选】';
  assert.equal(songTitleIntent({ title: '《普通朋友》', parentTitle: parent }).parentArtist, '陶喆');
  assert.equal(songTitleIntent({ title: '周杰伦《稻香》(Live)' }).candidates[0].name, '稻香(Live)');
  let calls = [];
  const wrong = [netSong('稻香(治愈版)', '周杰伦./街道办GDC/欧阳耀莹', '终究意难平'), netSong('稻香 (Live)', '周杰伦'), netSong('稻香', '无关翻唱')];
  const fallback = createArtworkResolver({ interval: 0, request: async url => {
    calls.push(String(url));
    return String(url).includes('music.163.com') ? netResponse(wrong) : qqResponse([qqSong('稻香', '周杰伦')]);
  } });
  const correct = await fallback.resolveTitle(input);
  assert.equal(correct.name, '稻香'); assert.equal(correct.artist, '周杰伦'); assert.equal(correct.neteaseId, undefined);
  assert(correct.cover.includes('002Neh8l0uciQZ')); assert.equal(calls.length, 2, 'wrong NetEase recording must trigger QQ, even if it has artwork');
  calls = [];
  const exact = createArtworkResolver({ interval: 0, request: async url => {
    calls.push(String(url)); return netResponse([netSong('稻香', '周杰伦/其他歌手'), netSong('稻香', '杰伦'), netSong('稻香', '周杰伦', '超时代演唱会'), netSong('稻香', '周杰伦', '魔杰座', 3)]);
  } });
  assert.equal((await exact.resolveTitle(input)).neteaseId, '3');
  assert.equal(calls.length, 1, 'exact original keeps the fast single-provider path');
  const live = createArtworkResolver({ interval: 0, request: async () => netResponse([netSong('稻香', '周杰伦'), netSong('稻香 (Live)', '周杰伦', '演唱会', 4)]) });
  assert.equal((await live.resolveTitle({ title: '周杰伦《稻香》(Live)' })).neteaseId, '4', 'an explicitly requested Live is kept');
  const cover = createArtworkResolver({ interval: 0, request: async url => String(url).includes('music.163.com') ? netResponse(wrong) : qqResponse([qqSong('稻香', '周杰伦')]) });
  assert((await cover.resolve({ name: '稻香', artist: '周杰伦' })).includes('gtimg.cn'), 'art-only lookup also rejects unrelated versions');
  // The suggestions API omits version info: details must be checked before accepting.
  const stages = [];
  function suggestionsResolver(detail) {
    return createArtworkResolver({ interval: 0, request: async (url, options) => {
      if (String(url).includes('music.163.com')) return netResponse(wrong);
      if (String(url).includes('smartbox_new')) { stages.push('suggestions'); return Response.json({ code: 0, data: { song: { itemlist: [{ id: '449205', mid: '003aAYrm3GE0Ac', name: '稻香', singer: '周杰伦' }] } } }); }
      const body = JSON.parse(options.body);
      if (body.req.module === 'music.pf_song_detail_svr') { stages.push('detail'); return Response.json({ code: 0, req: { code: 0, data: { track_info: detail } } }); }
      stages.push('desktop'); return Response.json({ code: 0, req: { code: 2001, data: {} } });
    } });
  }
  const hydrated = await suggestionsResolver(qqSong('稻香', '周杰伦')).resolveTitle(input);
  assert.equal(hydrated.artist, '周杰伦'); assert(hydrated.cover); assert.deepEqual(stages, ['desktop', 'suggestions', 'detail']);
  const hiddenLive = await suggestionsResolver({ ...qqSong('稻香', '周杰伦'), subtitle: 'Live' }).resolveTitle(input);
  assert.equal(hiddenLive.matched, false); assert.equal(hiddenLive.name, '稻香'); assert.equal(hiddenLive.cover, undefined, 'a suggestion cannot disguise a Live recording');
  const mismatch = await suggestionsResolver({ ...qqSong('稻香', '周杰伦'), id: 99 }).resolveTitle(input);
  assert.equal(mismatch.matched, false, 'details must belong to the selected song ID');
  const offline = createArtworkResolver({ interval: 0, request: async () => { throw Error('offline'); } });
  const safe = await offline.resolveTitle(input);
  assert.deepEqual(safe, { name: '稻香', artist: '周杰伦', matched: false }, 'retain trusted source title/artist rather than inventing a cover');
  const root = fs.mkdtempSync(path.join(__dirname, '../validation/original-cache-'));
  try {
    const file = path.join(root, 'cache.json');
    fs.writeFileSync(file, JSON.stringify({ version: 1, entries: [['title:v1:07稻香|周杰伦歌曲全集', { expires: Date.now() + 86400000, url: 'https://art.test/wrong.jpg', song: { name: '稻香(治愈版)', artist: '错误歌手', matched: true } }]] }));
    const resolver = createArtworkResolver({ cacheFile: file, interval: 0, request: async () => netResponse([netSong('稻香', '周杰伦')]) });
    assert.equal((await resolver.resolveTitle(input)).name, '稻香', 'old v1 results must not poison corrected matching');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
  console.log('PASS: original/version/artist-set selection, exact-match fast path, explicit Live, QQ 2001 suggestions/detail validation, art-only matching, safe fallback and stale-cache migration');
}
run().catch(error => { console.error(error); process.exitCode = 1; });
