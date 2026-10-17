const assert = require('node:assert/strict');
const policy = require('../renderer/music-search-policy.js');
const { createVideoSearch } = require('../video-search.cjs');
// Titles/durations reproduced from the user's screenshots; IDs below are test placeholders.
const screenshot = [
  { bvid: 'dance', title: '【爵士入门】《The Weekend》', author: 'KWB咖舞吧', duration: '3:18' },
  { bvid: 'tutorial', title: '《The Weekend》数拍慢速舞蹈分解', duration: '1:47' },
  { bvid: 'game', title: 'BNSK起床音乐The Weekend无人声版', duration: '1:58' },
  { bvid: 'clip', title: 'The weekend BIBI 这段实在是太好听了', duration: '0:45' },
  { bvid: 'coldplay', title: '百万级装备听《Hymn For The Weekend》- Coldplay/Beyoncé【Hi-Res】', duration: '4:20' },
  { bvid: 'amv', title: '50K Mep - Hymn For The Weekend [Edit-AMV]', duration: '0:51' },
  { bvid: 'single', title: 'The Weeknd-Die For You【Hi-Res无损】', duration: '4:21' },
  { bvid: 'playlist', title: '【The Weeknd合集|Hi-Res】“如果你也喜欢The Weeknd”', duration: '50:29' },
  { bvid: 'hits', title: '36 分钟洗澡歌单 | The Weeknd 盆栽热门金曲合集', duration: '36:38' },
];
function response(items, pages = 1) { return { code: 0, data: { result: items, numPages: pages } }; }
async function run() {
  for (const input of ['theweekend', 'the weeknd', 'theweeknd', 'The Weeknd']) assert.equal(policy.intent(input).effective, 'The Weeknd');
  assert.equal(policy.intent('brunomars').effective, 'Bruno Mars');
  assert.equal(policy.intent('Hymn for the Weekend').effective, 'Hymn for the Weekend');
  assert.equal(policy.intent('BIBI The Weekend').effective, 'BIBI The Weekend');
  assert.equal(policy.intent('周杰伦').effective, '周杰伦');
  assert.equal(policy.intent('陶喆').effective, '陶喆');
  assert.equal(policy.eligible({ title: '短歌', duration: '2:59' }), false);
  assert.equal(policy.eligible({ title: '完整歌曲', duration: '3:00' }), true);
  assert.equal(policy.eligible({ title: 'Madonna - Popular', duration: '4:00' }), true, 'MAD must not match Madonna');
  assert.equal(policy.eligible({ title: '爵士入门音乐歌单', author: '爵士乐', duration: '40:00' }), true);
  assert.equal(policy.eligible(screenshot[0], 'theweekend'), false);
  assert.equal(policy.eligible(screenshot[4], 'theweekend'), false);
  assert.equal(policy.eligible(screenshot[4], 'Hymn for the Weekend'), true, 'a different song query must remain valid');
  const calls = [];
  const search = createVideoSearch(async (query, page) => { calls.push([query, page]); return response(screenshot); });
  const result = await search('theweekend');
  assert.equal(calls[0][0], 'The Weeknd');
  assert.equal(result.corrected, true);
  assert.deepEqual(result.list.filter(item => policy.eligible(item, 'theweekend')).map(item => item.bvid), ['single', 'playlist', 'hits']);
  assert.equal(result.list[0].bvid, 'single', 'eligible music keeps upstream order; playlist is not forced ahead of a full single');
  const same = await search('The Weeknd');
  assert.equal(same.corrected, false, 'correction notice belongs to this request, not a cached alias');
  assert.equal(calls.length, 1);
  // Artist/keyword searches keep upstream relevance, rather than preferring short literal titles.
  for (const artist of ['周杰伦', '陶喆']) {
    const server = [
      { bvid: 'collection', title: `${artist} 最全经典歌曲合集`, duration: '60:00' },
      { bvid: 'live', title: `${artist} 演唱会`, duration: '40:00' },
      { bvid: 'literal', title: artist, duration: '4:00' },
    ];
    const chinese = await createVideoSearch(async () => response(server))(artist);
    assert.deepEqual(chinese.list.map(item => item.bvid), server.map(item => item.bvid));
  }
  const pages = [];
  const filled = createVideoSearch(async (_query, page) => {
    pages.push(page);
    return response(page === 1 ? [{ bvid: 'short', title: 'The Weeknd', duration: '0:30' }]
      : Array.from({ length: 8 }, (_, i) => ({ bvid: `music-${page}-${i}`, title: 'The Weeknd 歌单', duration: '20:00' })), 4);
  });
  const initial = await filled('theweekend');
  assert.equal(initial.list.filter(item => policy.eligible(item, 'theweekend')).length, 8);
  assert.deepEqual(pages, [1, 2]);
  await filled('theweekend', 2);
  assert.deepEqual(pages, [1, 2, 3], 'pagination continues after the prefetched server page');
  const budget = [];
  await createVideoSearch(async (_query, page) => { budget.push(page); return response([{ bvid: `s-${page}`, title: '短片', duration: '0:20' }], 100); })('theweekend');
  assert.equal(budget.length, 3, 'sparse pages cannot trigger unlimited requests');
  console.log('PASS: screenshot reproduction, canonical artist query, 180-second boundary, music filtering, Chinese upstream order, no song-title overcorrection, bounded fill and pagination');
}
run().catch(error => { console.error(error); process.exitCode = 1; });
