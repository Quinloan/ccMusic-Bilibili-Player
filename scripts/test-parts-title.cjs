const assert = require('node:assert/strict');
const { songTitleIntent } = require('../renderer/library-model.js');
const { createArtworkResolver } = require('../cover-art.cjs');
async function run() {
  const parentTitle = '【B站最高音质·附MV】陶喆 录音室作品 合集 (音乐 歌曲)';
  const names = ['飞机场的10:30', '爱,很简单', '沙滩', '十七岁', '望春风'];
  for (const name of names) {
    const intent = songTitleIntent({ title: `${name} 陶喆同名专辑`, parentTitle });
    assert.deepEqual(intent.candidates, [{ name, artist: '陶喆' }]);
    assert.equal(intent.metadataVersion, 3); assert.equal(intent.parentArtist, '陶喆');
  }
  assert.deepEqual(songTitleIntent({ title: 'P1 - 《普通朋友》陶喆同名专辑', parentTitle }).candidates, [{ name: '普通朋友', artist: '陶喆' }]);
  assert.deepEqual(songTitleIntent({ title: '01. 普通朋友', parentTitle }).candidates, [{ name: '普通朋友', artist: '陶喆' }]);
  for (const name of ['Doxology', '找自己', '小镇姑娘', '夜来香', '普通朋友', "I'm OK", '飞机场的10:30', '沙滩 (钢琴版)', '王八蛋 (Full Mix)', '普通朋友 (Live)']) {
    const intent = songTitleIntent({ title: `14 ${name}【专辑：I'm OK】`, parentTitle });
    assert.deepEqual(intent.candidates, [{ name, artist: '陶喆' }]); assert.equal(intent.metadataVersion, 4);
  }
  assert.notEqual(songTitleIntent({ title: '找自己【专辑：不明专辑】' }).candidates[0].name, '找自己', 'no artist evidence: do not guess an album artist');
  assert.equal(songTitleIntent({ title: '翻唱 找自己【专辑：I’m OK】', parentTitle }), null);
  for (const title of ["普通朋友 陶喆I'm OK专辑", "普通朋友 陶喆《I'm OK》专辑"]) assert.deepEqual(songTitleIntent({ title, parentTitle }).candidates, [{ name: '普通朋友', artist: '陶喆' }]);
  for (const title of ['翻唱《普通朋友》陶喆同名专辑', '普通朋友 陶喆同名专辑 (AI Cover)']) assert.equal(songTitleIntent({ title, parentTitle }), null);
  assert.equal(songTitleIntent({ title: '普通朋友 陶喆同名专辑', parentTitle: '陶喆歌曲翻唱合集' }), null);
  assert.equal(songTitleIntent({ title: '你 我 怎 么 两 清' }).metadataVersion, 2);
  let network = 0, available = false;
  const input = { title: '飞机场的10:30 陶喆同名专辑', parentTitle };
  const resolver = createArtworkResolver({ interval: 0, request: async url => {
    network++;
    if (String(url).includes('music.163.com')) return Response.json({ code: 200, result: { songs: available ? [
      { id: 1, name: '飞机场的10:30 (Live)', ar: [{ name: '陶喆' }], al: { name: '演唱会', picUrl: 'https://art.test/live.png' } },
      { id: 2, name: '飞机场的10:30', ar: [{ name: '翻唱者' }], al: { picUrl: 'https://art.test/cover.png' } },
      { id: 3, name: '飞机场的10:30', ar: [{ name: '陶喆' }], al: { picUrl: 'https://art.test/original.png' } },
    ] : [] } });
    return Response.json({ code: 0, req: { code: 0, data: {} }, data: { song: { itemlist: [] } } });
  } });
  const missed = await resolver.resolveTitle(input);
  assert.deepEqual(missed, { name: '飞机场的10:30', artist: '陶喆', matched: false });
  const before = network; available = true;
  assert.equal((await resolver.resolveTitle(input)).matched, false); assert.equal(network, before, 'automatic negative-cache reads do not hammer providers');
  const found = await resolver.resolveTitle({ ...input, refresh: true });
  assert.equal(found.artist, '陶喆'); assert.equal(found.neteaseId, '3'); assert.equal(found.cover, 'https://art.test/original.png');
  assert.equal(network, before + 1, 'explicit parse retries a negative cache while retaining exact-match fast path');
  assert.equal((await resolver.resolveTitle(input)).matched, true, 'a successful retry replaces the negative cache');
  console.log('PASS: decorated multi-P artist, album suffix, clock/punctuation titles, revisioned identity, conservative cover rejection, original/version matching and explicit negative-cache retry');
}
run().catch(error => { console.error(error); process.exitCode = 1; });
