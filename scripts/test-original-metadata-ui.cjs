// Actual renderer, controlled metadata and silent media. Never starts Electron.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { mockBridge } = require('./test-ui.cjs');
const root = path.resolve(__dirname, '..');
async function run() {
  const { chromium } = require(process.env.CCMUSIC_PLAYWRIGHT || 'playwright');
  const browser = await chromium.launch({ executablePath: process.env.CCMUSIC_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true, args: ['--disable-background-networking'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 }, serviceWorkers: 'block' });
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    const files = ['/renderer/index.html', '/renderer/style.css', '/renderer/app.js', '/renderer/downloads.js', '/renderer/workflows.js', '/renderer/library-model.js', '/renderer/volume-balance.js', '/renderer/music-search-policy.js', '/assets/icon.png'];
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.host === 'art.test') return route.fulfill({ body: fs.readFileSync(path.join(root, 'assets/icon.png')), contentType: 'image/png' });
      if (!files.includes(url.pathname)) return route.abort();
      return route.fulfill({ body: fs.readFileSync(path.join(root, url.pathname)), contentType: url.pathname.endsWith('.html') ? 'text/html; charset=utf-8' : url.pathname.endsWith('.css') ? 'text/css; charset=utf-8' : url.pathname.endsWith('.png') ? 'image/png' : 'text/javascript; charset=utf-8' });
    });
    await page.addInitScript(mockBridge);
    await page.goto('http://ccmusic.test/renderer/index.html'); await page.locator('#folders .folder').first().waitFor();
    // An already matched v1 song has a cover, yet must be repaired from its raw P title.
    await page.evaluate(() => {
      window.testHoldTitles = true; window.testHoldCovers = true;
      S.active = 'a'; showView('library');
      folder().items = [{ bvid: 'BV15C41187cx', cid: 11, page: 7, partTitle: '07. 稻香', sourceTitle: '07. 稻香', vtitle: '周杰伦歌曲全集',
        title: '稻香(治愈版)', artist: '周杰伦./街道办GDC/欧阳耀莹', identifySource: 'title', titleMetaVersion: 1, neteaseId: '3381542797', songCover: 'https://art.test/wrong.png', cover: '/assets/icon.png', duration: 224 }];
      loadQueue(folder().items, 0); playback.current = { item: S.queue[0], idx: 0 }; audio.currentTime = 99;
      save(); renderFolders(); renderList(); renderQueue();
    });
    await page.waitForFunction(() => window.testTitleRequests.length === 1);
    assert.deepEqual(await page.evaluate(() => window.testTitleRequests[0].input), { title: '07. 稻香', parentTitle: '周杰伦歌曲全集' });
    await page.evaluate(() => window.testTitleRequests[0].resolve({ name: '稻香', artist: '周杰伦', cover: 'https://art.test/mojiezhuo.png', matched: true }));
    await page.waitForFunction(() => folder().items[0].titleMetaVersion === 2);
    assert.equal(await page.evaluate(() => folder().items[0].neteaseId), undefined, 'QQ repair removes stale NetEase cover-version ID');
    assert.equal(await page.evaluate(() => S.queue[0].artist), '周杰伦'); assert.equal(await page.locator('#bTitle').textContent(), '稻香');
    assert.equal(await page.locator('#bCover').getAttribute('src'), 'https://art.test/mojiezhuo.png'); assert.equal(await page.evaluate(() => audio.currentTime), 99);
    // Existing description-based segments already have art, but no performer.
    await page.evaluate(() => {
      const names = ['普通朋友', '就是爱你', '爱我还是他', '流沙', 'Melody'];
      folder().items.push(...names.map((name, i) => ({ bvid: 'BV12M4m1y7hf', cid: 12, page: 1, vtitle: 'R&B陶喆热门歌曲合集【52分钟精选】', title: `《${name}》`, artist: '',
        identifySource: 'description', split: true, splitBatch: 'old-description', startSec: i * 240, endSec: (i + 1) * 240, duration: 240, originalDuration: 1200,
        songCover: 'https://art.test/old-album.png', cover: '/assets/icon.png', up: '浮梦探影_' })));
      loadQueue(folder().items, 2); playback.current = { item: S.queue[2], idx: 2 }; audio.currentTime = 300;
      save(); renderList(); renderQueue();
    });
    for (let i = 0; i < 5; i++) {
      await page.waitForFunction(n => window.testTitleRequests.length >= n, i + 2);
      const input = await page.evaluate(n => window.testTitleRequests[n].input, i + 1);
      assert.equal(input.parentTitle, 'R&B陶喆热门歌曲合集【52分钟精选】');
      await page.evaluate(n => { const job = window.testTitleRequests[n], name = job.input.title.replace(/[《》]/g, ''); job.resolve({ name, artist: '陶喆', neteaseId: String(150000 + n), cover: `https://art.test/tao-${n}.png`, matched: true }); }, i + 1);
    }
    await page.waitForFunction(() => folder().items.slice(1).every(i => i.artist === '陶喆'));
    assert.equal(await page.evaluate(() => folder().items.slice(1).every(i => i.identifySource === 'description' && i.titleMetaVersion === 2)), true);
    assert.equal(await page.locator('#bTitle').textContent(), '就是爱你'); assert.equal(await page.locator('#bUp').textContent(), '陶喆');
    assert.equal(await page.evaluate(() => audio.currentTime), 300);
    const captions = await page.locator('#list .row.child .u').allTextContents();
    assert(captions.every(text => text === '陶喆 · 04:00'), JSON.stringify(captions));
    assert.equal(await page.locator('#list').textContent().then(text => text.includes('简介时间轴')), false);
    const boundaries = await page.evaluate(() => folder().items.slice(1).map(i => [i.startSec, i.endSec]));
    assert.deepEqual(boundaries, [[0,240],[240,480],[480,720],[720,960],[960,1200]]);
    await page.screenshot({ path: path.join(root, 'validation/ui-original-metadata-repair.png') });
    // Newly confirmed named description tracks also enrich without fingerprint calls.
    await page.evaluate(async () => {
      const f = folder(), item = { bvid: 'BV1uuHd6cEhy', cid: 13, page: 1, title: '陶喆歌曲合集', duration: 480, cover: '/assets/icon.png' };
      f.items.push(item); const tracks = [{ start: 0, end: 240, title: '《普通朋友》', source: 'description' }, { start: 240, end: 480, title: '《流沙》', source: 'description' }];
      const batch = applySplitResult(f, item, { tracks, duration: 480 });
      window.descriptionTask = { id: 'desc-task', item, folder: f, batch, result: { tracks, duration: 480 }, state: 'ready' };
      splitTasks.set(descriptionTask.id, descriptionTask); await runRecognitionTask(descriptionTask);
    });
    await page.waitForFunction(() => window.testTitleRequests.length >= 7);
    await page.evaluate(() => window.testTitleRequests[6].resolve({ name: '普通朋友', artist: '陶喆', cover: 'https://art.test/new-tao.png', matched: true }));
    await page.waitForFunction(() => window.testTitleRequests.length === 8);
    // Manual edit while the second lookup waits always wins.
    await page.evaluate(() => editSongInfo(folder().items.at(-1)));
    await page.locator('#songInfoTitle').fill('我的流沙'); await page.locator('#songInfoArtist').fill('我选的表演者');
    await page.locator('#songInfoForm [type="submit"]').click();
    await page.evaluate(() => window.testTitleRequests[7].resolve({ name: '流沙', artist: '陶喆', cover: 'https://art.test/new-quicksand.png', matched: true }));
    await page.waitForFunction(() => folder().items.at(-1).songCover === 'https://art.test/new-quicksand.png');
    await page.evaluate(() => applyRecognizedTrack(descriptionTask, 0, { ...descriptionTask.result.tracks[0], checked: true }));
    assert.equal(await page.evaluate(() => folder().items.at(-2).artist), '陶喆', 'a later description event must not blank an enriched performer');
    assert.equal(await page.evaluate(() => folder().items.at(-1).title), '我的流沙');
    assert.equal(await page.evaluate(() => window.testRecognitionRequests.length + window.testSplitCalls), 0, 'known names use metadata only');
    const imported = await page.evaluate(() => LibraryModel.importedFolders({ folders: [{ name: 'test', items: folder().items }] })[0].items);
    assert.equal(imported[1].titleMetaVersion, 2); assert.equal(imported[1].artist, '陶喆');
    await page.evaluate(() => save()); await page.reload(); await page.locator('#folders .folder').first().waitFor(); await page.locator('#folders [data-id="a"]').click();
    await page.waitForTimeout(80);
    assert.equal(await page.evaluate(() => folder().items[0].title), '稻香'); assert.equal(await page.evaluate(() => folder().items[1].artist), '陶喆');
    assert.equal(await page.evaluate(() => window.testTitleRequests.length), 0, 'corrected and manual records survive restart without lookup');
    assert.deepEqual(errors, []);
    console.log('PASS: legacy wrong-cover repair including old ID removal; description performer enrichment for old/new splits; clear captions; fixed boundaries/playhead; no fingerprint; repeated events/manual edits/import/restart safety');
  } finally { await browser.close(); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
