const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { songTitleIntent } = require('../renderer/library-model.js');
const { createArtworkResolver } = require('../cover-art.cjs');
async function run() {
  assert.deepEqual(songTitleIntent({ title: '【无损】周杰伦《七里香》官方MV' }).candidates, [{ name: '七里香', artist: '周杰伦' }]);
  for (const title of ['P1', '01', '正片', '周杰伦全部歌曲合集', 'The Weeknd Playlist', '周杰伦《晴天》《七里香》串烧']) assert.equal(songTitleIntent({ title }), null, title);
  for (const title of ['01. 晴天', '01 晴天', '001-晴天', 'P2 - 晴天']) assert.equal(songTitleIntent({ title, parentTitle: '【无损】周杰伦歌曲全集' }).candidates[0].name, '晴天');
  const root = fs.mkdtempSync(path.join(__dirname, '../validation/title-unit-')), file = path.join(root, 'cache.json');
  let count = 0;
  const song = (id, name, artist, cover = true) => ({ id, name, ar: [{ name: artist }], al: cover ? { picUrl: `https://p1.music.126.net/${id}.jpg` } : {} });
  const catalog = [song(1, 'Out of Time', 'The Weeknd'), song(2, '晴天', '周杰伦'), song(3, '晴天', '无关翻唱'), song(4, 'One Of The Girls', 'The Weeknd'), song(5, '七里香', '周杰伦', false)];
  try {
    const resolver = createArtworkResolver({ cacheFile: file, interval: 0, request: async url => {
      count++;
      if (String(url).includes('music.163.com')) return Response.json({ code: 200, result: { songs: catalog } });
      return Response.json({ code: 0, req: { code: 0, data: { body: { song: { list: [{ name: '七里香', singer: [{ name: '周杰伦' }], album: { mid: 'album123456' } }] } } } } });
    } });
    const original = { title: '[Hi-Res/48kHz/24bit]Out of Time - The Weeknd' };
    const [a, b] = await Promise.all([resolver.resolveTitle(original), resolver.resolveTitle(original)]);
    assert.equal(a.name, 'Out of Time'); assert.equal(a.artist, 'The Weeknd'); assert.equal(a.neteaseId, '1'); assert.equal(a.cover, 'https://p1.music.126.net/1.jpg'); assert(a.matched);
    assert.deepEqual(a, b); assert.equal(count, 1, 'same title requests share one metadata query');
    assert.equal((await resolver.resolveTitle({ title: 'The Weeknd - Out of Time [Hi-Res]' })).name, 'Out of Time', 'artist-song and song-artist order both work');
    assert.equal((await resolver.resolveTitle({ title: '周杰伦 晴天' })).name, '晴天');
    assert.equal(await resolver.resolveTitle({ title: '晴天' }), null, 'an ambiguous title without artist evidence must not pick an arbitrary singer');
    assert.equal((await resolver.resolveTitle({ title: 'P1 - 晴天', parentTitle: '周杰伦歌曲全集' })).artist, '周杰伦');
    assert.equal((await resolver.resolveTitle({ title: '01. 晴天', parentTitle: '【无损】周杰伦 (Jay Chou) 全集' })).artist, '周杰伦', 'parent artist aliases do not block exact song matches');
    const fallback = await resolver.resolveTitle({ title: '周杰伦《七里香》' });
    assert.equal(fallback.name, '七里香'); assert.equal(fallback.neteaseId, '5'); assert(fallback.cover.includes('gtimg.cn'), 'QQ fills missing NetEase artwork without changing song identity');
    const reopened = createArtworkResolver({ cacheFile: file, interval: 0, request: async () => { throw Error('cache should prevent network'); } });
    assert.deepEqual(await reopened.resolveTitle(original), a);
    catalog.push(song(6, '坏女孩', '徐良/小凌'), song(7, '坏女孩 (Live)', '无关翻唱'));
    const badGirl = await resolver.resolveTitle({ title: '在百万豪装录音棚大声听 徐良&小凌《坏女孩》【Hi-res】' });
    assert.equal(badGirl.name, '坏女孩'); assert.equal(badGirl.artist, '徐良/小凌'); assert.equal(badGirl.matched, true);
    assert.equal(await resolver.resolveTitle({ title: '你 我 怎 么 两 清' }), null, 'a lyrical caption cannot be mapped to an unrelated original artist');
    const before = count; assert.equal(await resolver.resolveTitle({ title: '周杰伦歌曲合集' }), null); assert.equal(count, before, 'collections never become their first song');
    assert.equal(await resolver.resolveTitle({ title: '未知标题-no matching singer' }), null, 'uncertain titles remain unchanged');
    const offline = createArtworkResolver({ interval: 0, request: async () => { throw Error('offline'); } });
    const explicit = await offline.resolveTitle({ title: '【无损】周杰伦《稻香》' });
    assert.equal(explicit.name, '稻香'); assert.equal(explicit.artist, '周杰伦'); assert.equal(explicit.matched, false, 'explicit quoted title can be cleaned offline without inventing a catalog match');
    console.log('PASS: title/artist extraction, quality/index removal, both title orders, multi-P parent artist, ambiguity/noise/collection rejection, QQ art fallback, dedup/cache persistence and safe offline title cleanup');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
