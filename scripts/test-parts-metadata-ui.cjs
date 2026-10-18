// Actual renderer plus actual metadata resolver, with a synthetic catalog only.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { mockBridge } = require('./test-ui.cjs');
const { createArtworkResolver } = require('../cover-art.cjs');
const root = path.resolve(__dirname, '..');
async function run() {
  fs.mkdirSync(path.join(root, 'validation'), { recursive: true });
  const { chromium } = require(process.env.CCMUSIC_PLAYWRIGHT || 'playwright');
  const browser = await chromium.launch({ executablePath: process.env.CCMUSIC_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
  const names = ['飞机场的10:30', '爱,很简单', '沙滩', '十七岁', '望春风'];
  let requests = 0, available = true, holding = false;
  const calls = [], waiting = [];
  const resolver = createArtworkResolver({ interval: 0, request: async url => {
    requests++;
    if (String(url).includes('music.163.com')) return Response.json({ code: 200, result: { songs: available ? names.map((name, i) => ({ id: i + 1, name, ar: [{ name: '陶喆' }], al: { picUrl: `https://art.test/${i}.png` } })) : [] } });
    return Response.json({ code: 0, req: { code: 0, data: {} }, data: { song: { itemlist: [] } } });
  } });
  async function finishNext() { const next = waiting.shift(); assert.ok(next); next.resolve(await resolver.resolveTitle(next.input)); }
  async function waitForRequest() {
    const deadline = Date.now() + 15000;
    while (!waiting.length) { assert.ok(Date.now() < deadline, 'expected a pending metadata request'); await new Promise(resolve => setTimeout(resolve, 10)); }
  }
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 }, serviceWorkers: 'block' });
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.host === 'art.test') return route.fulfill({ body: fs.readFileSync(path.join(root, 'assets/icon.png')), contentType: 'image/png' });
      if (!/^\/renderer\/[a-z.-]+\.(?:html|css|js)$/.test(url.pathname) && url.pathname !== '/assets/icon.png') return route.abort();
      const file = path.join(root, url.pathname); if (!fs.existsSync(file)) return route.abort();
      return route.fulfill({ body: fs.readFileSync(file), contentType: file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.css') ? 'text/css' : file.endsWith('.png') ? 'image/png' : 'text/javascript; charset=utf-8' });
    });
    await page.exposeFunction('lookupMetadata', input => { calls.push(input); return holding ? new Promise(resolve => waiting.push({ input, resolve })) : resolver.resolveTitle(input); });
    await page.addInitScript(mockBridge);
    await page.addInitScript(() => { window.api.resolveSongTitle = input => window.lookupMetadata(input); });
    await page.goto('http://ccmusic.test/renderer/index.html'); await page.locator('#folders .folder').first().waitFor();
    await page.evaluate(names => {
      S.active = 'a'; showView('library');
      const parent = '【B站最高音质·附MV】陶喆 录音室作品 合集 (音乐 歌曲)';
      folder().items = names.map((name, i) => ({ bvid: 'BV15C41187cx', cid: 100 + i, page: i + 1, partsCount: 134, duration: 240,
        title: name + ' 陶喆同名专辑', sourceTitle: name + ' 陶喆同名专辑', partTitle: name + ' 陶喆同名专辑', vtitle: parent,
        artist: 'B站最·附 陶喆录音室作品', up: '飞翔的石头s', identifySource: 'title', titleMetaVersion: 2, cover: '/assets/icon.png', songCover: 'https://art.test/old.png' }));
      loadQueue(folder().items, 0); playback.current = { item: S.queue[0], idx: 0 }; audio.currentTime = 88;
      queueSongTitles(folder().items); save(); renderFolders(); renderList(); renderQueue();
    }, names);
    await page.waitForFunction(() => folder().items.every(item => item.titleMetaVersion === 3));
    assert.deepEqual(await page.evaluate(() => folder().items.map(item => item.title)), names);
    assert.equal(await page.evaluate(() => folder().items.every(item => item.artist === '陶喆' && item.songCover.startsWith('https://art.test/'))), true);
    assert.equal(await page.locator('#list .row.child .ptag').first().textContent(), 'P1');
    assert.equal(await page.locator('#list .group img').getAttribute('src'), '/assets/icon.png');
    assert.equal(await page.locator('#bTitle').textContent(), names[0]); assert.equal(await page.evaluate(() => audio.currentTime), 88);
    assert.equal(requests, 5); assert.equal(calls.length, 5, 'old bad v2 items automatically repair once with a fresh parser identity');
    const imported = await page.evaluate(() => LibraryModel.importedFolders({ folders: [{ name: 'roundtrip', items: folder().items }] })[0].items[0]);
    assert.equal(imported.titleMetaVersion, 3); assert.equal(imported.partsCount, 134);
    await page.screenshot({ path: path.join(root, 'validation/ui-parts-metadata-parse.png') });
    // Actual child context-menu action retries a completed, positive cached lookup.
    holding = true;
    await page.locator('#list .row.child').first().click({ button: 'right' }); await page.getByText('解析歌曲信息', { exact: true }).click();
    await page.waitForFunction(() => metadataParseJobs.size === 1);
    await waitForRequest();
    assert.equal(waiting[0].input.refresh, true); await finishNext();
    await page.waitForFunction(() => metadataParseJobs.size === 0); assert.equal(requests, 6);
    // Group parsing updates progressively, deduplicates clicks and honors later user edits/deletion.
    await page.evaluate(() => { const item = folder().items[4]; item.title = '我收藏的望春风'; item.artist = '手动歌手'; item.identifySource = 'manual'; renderList(); });
    await page.locator('#list .group').click({ button: 'right' }); await page.getByText('解析整组歌曲信息', { exact: true }).click();
    await waitForRequest();
    const firstGroupCount = calls.length;
    await page.evaluate(() => { void parseSongMetadata(folder().items); });
    assert.equal(calls.length, firstGroupCount, 'same group action shares a running job');
    await page.evaluate(() => { folder().items[1].title = '保留我的名字'; folder().items[1].artist = '实际演唱者'; folder().items[1].identifySource = 'manual'; folder().items.splice(3, 1); save(); renderList(); });
    await finishNext();
    await waitForRequest();
    assert.equal(waiting[0].input.title, '沙滩 陶喆同名专辑');
    await finishNext(); await page.waitForFunction(() => metadataParseJobs.size === 0);
    assert.equal(calls.length, firstGroupCount + 1);
    assert.deepEqual(await page.evaluate(() => folder().items.map(item => item.title)), [names[0], '保留我的名字', names[2], '我收藏的望春风']);
    assert.equal(await page.evaluate(() => audio.currentTime), 88); assert.equal(await page.evaluate(() => window.testSplitCalls), 0);
    // A manual retry that finds nothing cannot erase already matched identity/art.
    holding = false; available = false;
    const previous = await page.evaluate(() => JSON.stringify(folder().items[0]));
    await page.evaluate(() => parseSongMetadata([folder().items[0]]));
    assert.equal(await page.evaluate(() => JSON.stringify(folder().items[0])), previous);
    available = true; await page.evaluate(() => parseSongMetadata([folder().items[0]]));
    assert.equal(await page.evaluate(() => folder().items[0].artist), '陶喆');
    await page.evaluate(() => save());
    await page.reload(); await page.locator('#folders [data-id="a"]').click(); await page.waitForTimeout(150);
    assert.equal(calls.length, firstGroupCount + 3, 'restart does not repeat matched v3 or manually edited lookups');
    assert.deepEqual(errors, []);
    console.log('PASS: actual metadata resolver/DOM, decorated multi-P automatic migration and art, P1 retention, group/child context actions, explicit cache refresh, sequential progressive updates, duplicate-job protection, edits/removal, failed-retry preservation, playback/import/restart; mocked catalog/network, no audio/Electron');
  } finally { await browser.close(); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
