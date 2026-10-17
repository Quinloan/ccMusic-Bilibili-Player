const assert = require('node:assert/strict');
const { cleanText, titleQueries, titleScore, createVideoSearch } = require('../video-search.cjs');
const title = '〖The Weeknd合集|Hi-Res〗“如果你也喜欢The Weeknd”';
const response = (rows, numPages = 1) => ({ code: 0, data: { result: rows.map(([bvid, title]) => ({ bvid, title, author: 'UP&#x27;主', pic: '//image.test/a', duration: '50:29' })), numPages } });
async function run() {
  assert.equal(cleanText('<em>It</em>&#x27;s &amp; &quot;music&quot;'), 'It\'s & "music"');
  assert.equal(cleanText('&#99999999;'), '');
  assert.equal(titleQueries(title).length, 3);
  assert.ok(!titleQueries(title)[1].includes('Hi-Res'));
  assert.equal(titleQueries(title)[2], '如果你也喜欢 The Weeknd');
  assert.deepEqual(titleQueries('周杰伦'), ['周杰伦']);
  assert.equal(titleScore(title, title), 100);
  let calls = [];
  const search = createVideoSearch(async (query, page) => {
    calls.push([query, page]);
    if (page > 1) return response([['unrelated', 'Out of Time - The Weeknd'], ['second', '如果你也喜欢 The Weeknd 现场']], 2);
    return query === titleQueries(title)[2]
      ? response([['target', title], ['unrelated', 'Out of Time - The Weeknd']], 2)
      : response([['unrelated', 'Out of Time - The Weeknd']], 2);
  });
  const first = await search(title);
  assert.equal(first.list[0].bvid, 'target');
  assert.equal(first.list.length, 2);
  assert.equal(first.list[0].author, "UP'主");
  assert.equal(first.list[0].pic, 'https://image.test/a');
  assert.equal(calls.length, 3);
  assert.equal(first.supplemented, true);
  assert.equal(first.hasMore, true);
  assert.deepEqual(await search(title), first);
  assert.equal(calls.length, 3, 'repeat search uses cached page');
  const second = await search(title, 2);
  assert.deepEqual(second.list.map(it => it.bvid), ['second']);
  assert.equal(second.hasMore, false);
  assert.equal(calls.length, 6);
  const exact = createVideoSearch(async () => { calls.push('exact'); return response([['exact', title]]); });
  await exact(title);
  assert.equal(calls.length, 7, 'exact title avoids extra requests');
  let guardCalls = 0;
  const guard = createVideoSearch(async () => { guardCalls++; return { code: 0, data: { v_voucher: 'verification-required' } }; });
  await assert.rejects(guard(title), /需要验证/);
  assert.equal(guardCalls, 1, 'verification must not look like no results or trigger extra queries');
  const malformed = createVideoSearch(async () => ({ code: 0, data: {} }));
  await assert.rejects(malformed('周杰伦'), /响应不完整/);
  let partialCalls = 0;
  const partial = createVideoSearch(async () => ++partialCalls === 1 ? response([['one', 'The Weeknd']], 2) : { code: -412, message: 'request blocked' });
  const shown = await partial(title);
  assert.equal(shown.list.length, 1);
  assert.equal(shown.partial, true);
  assert.deepEqual(await partial(title), shown);
  assert.equal(partialCalls, 2);
  let clock = 1, ttlCalls = 0;
  const ttl = createVideoSearch(async () => { ttlCalls++; return response([]); }, () => clock);
  await ttl('周杰伦'); clock += 301000; await ttl('周杰伦');
  assert.equal(ttlCalls, 2);
  let concurrentCalls = [];
  const concurrent = createVideoSearch(async (_query, page) => {
    concurrentCalls.push(page);
    await new Promise(resolve => setImmediate(resolve));
    return response(Array.from({ length: 8 }, (_, i) => [`${page}-${i}`, '音乐']), 2);
  });
  const [a, b] = await Promise.all([concurrent('音乐', 1), concurrent('音乐', 2)]);
  assert.equal(a.list.length, 8);
  assert.equal(a.list[0].bvid, '1-0');
  assert.equal(b.list.length, 8);
  assert.equal(b.list[0].bvid, '2-0');
  assert.deepEqual(concurrentCalls, [1, 2], 'home page parallel requests share the first page');
  await testRenderer();
  console.log('PASS: copied-title fallback, ranking, entity decoding, bounded requests, pagination/dedup, cache, verification and partial errors');
}
async function testRenderer() {
  const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
  const source = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
  const controls = new Map();
  const $ = key => { if (!controls.has(key)) controls.set(key, { value: '', textContent: '', innerHTML: '', hidden: false }); return controls.get(key); };
  const pending = [];
  const context = { $, $$: () => [], S: { results: [], folders: [] }, esc: String, fmtPlay: String, fmtDur: String, showView() {}, toast() {}, rememberSearch() {},
    selectedResult: null, durSec: Number,
    B: { search: (query, page) => new Promise(resolve => pending.push({ query, page, resolve })) } };
  vm.createContext(context);
  context.visibleSearchResults = () => context.S.results;
  vm.runInContext(source.slice(source.indexOf('function renderResults('), source.indexOf('// ---------------------------------------------------------------- 右键菜单'))
    + source.slice(source.indexOf('let searchRequest ='), source.indexOf('// ---------------------------------------------------------------- 分 P / 合集选择面板')), context);
  $('#kw').value = '旧查询'; const old = context.doSearch();
  $('#kw').value = '新查询'; const current = context.doSearch();
  pending[1].resolve({ list: [{ bvid: 'first', title: '新结果' }], hasMore: true }); await current;
  pending[0].resolve({ list: [{ bvid: 'old', title: '过期结果' }], hasMore: false }); await old;
  assert.equal(context.S.results[0].bvid, 'first', 'older response cannot overwrite a newer search');
  $('#kw').value = '尚未提交的新文字';
  const more = context.doSearch(2, true);
  assert.equal(pending[2].query, '新查询', 'pagination uses the submitted query');
  pending[2].resolve({ list: [{ bvid: 'first', title: '新结果' }, { bvid: 'next', title: '第二页' }], hasMore: false }); await more;
  assert.equal(context.S.results.length, 2);
  assert.equal(($('#results').innerHTML.match(/class="row(?:\s|")/g) || []).length, 2, 'loading more must not duplicate old rows');
}
run().catch(error => { console.error(error); process.exitCode = 1; });
