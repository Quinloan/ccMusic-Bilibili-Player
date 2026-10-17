const assert = require('node:assert/strict');
const { normalize, chooseLyricMatch, searchLyrics } = require('../lyric-recognition.cjs');
async function run() {
  assert.equal(normalize('謝謝你，一直不離不棄'), '谢谢你一直不离不弃');
  const segments = [{ text: '我要飞越春夏秋冬' }, { text: '守住你给我的美' }, { text: '要一生爱你千百回' }];
  const reference = { id: 1, name: '一生爱你千百回', artists: [{ name: '参考歌手' }], lyrics: segments.map(s => s.text) };
  const hit = chooseLyricMatch(segments, [reference, { ...reference, id: 2, name: reference.name + 'R&B' }]);
  assert.equal(hit.name, reference.name);
  assert.equal(hit.artist, ''); // Lyrics establish composition, not identity of the performer.
  assert.equal(hit.referenceArtist, '参考歌手');
  assert.equal(chooseLyricMatch(segments, [reference, { ...reference, id: 3, name: '不同歌曲同样歌词' }]), null);
  assert.equal(chooseLyricMatch([{ text: '我要飞越春夏秋冬' }], [reference]), null);
  assert.equal(chooseLyricMatch([{ text: '我爱你' }, { text: '你爱我' }], [reference]), null);
  assert.equal(chooseLyricMatch([{ text: '感谢收看字幕由网友制作' }, { text: '请大家点赞订阅支持' }], [reference]), null);
  assert.equal(chooseLyricMatch([{ text: '今天的天气很好' }, { text: '明天还要出门工作' }], [reference]), null);
  assert.equal(chooseLyricMatch([{ text: '我要飛越春夏秋冬' }, { text: '守住你給我的美' }], [reference]).name, reference.name);
  const wrong = { id: 4, name: '错误歌', lyrics: ['今天的天气很好', '明天还要出门工作'] };
  const searched = await searchLyrics(segments, async () => ({ ok: true, json: async () => ({ code: 200, result: { songs: [wrong, reference] } }) }));
  assert.equal(searched.match.name, reference.name);
  await assert.rejects(searchLyrics([{ text: '独立的网络错误测试短句' }], async () => ({ ok: false, status: 503 })), /HTTP 503/);
  console.log('PASS: simplified/traditional lyrics, version deduplication, multiple phrases, ambiguity rejection, wrong candidates, performer attribution, search errors');
}
run().catch(error => { console.error(error); process.exitCode = 1; });
