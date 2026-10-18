// Real add/parts-picker/queue UI with controlled title metadata. No audio/Electron.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { mockBridge } = require('./test-ui.cjs');
const root = path.resolve(__dirname, '..');
async function run() {
  const { chromium } = require(process.env.CCMUSIC_PLAYWRIGHT || 'playwright');
  const browser = await chromium.launch({ executablePath: process.env.CCMUSIC_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true, args: ['--disable-background-networking'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 }, serviceWorkers: 'block' });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    const files = ['/renderer/index.html', '/renderer/style.css', '/renderer/app.js', '/renderer/downloads.js', '/renderer/workflows.js', '/renderer/library-model.js', '/renderer/volume-balance.js', '/renderer/music-search-policy.js', '/assets/icon.png'];
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.host === 'art.test') return route.fulfill({ body: fs.readFileSync(path.join(root, 'assets/icon.png')), contentType: 'image/png' });
      if (!files.includes(url.pathname)) return route.abort();
      return route.fulfill({ body: fs.readFileSync(path.join(root, url.pathname)), contentType: url.pathname.endsWith('.html') ? 'text/html; charset=utf-8' : url.pathname.endsWith('.css') ? 'text/css; charset=utf-8' : url.pathname.endsWith('.png') ? 'image/png' : 'text/javascript; charset=utf-8' });
    });
    await page.addInitScript(mockBridge);
    await page.goto('http://ccmusic.test/renderer/index.html'); await page.locator('#folders .folder').first().waitFor();
    await page.evaluate(() => {
      window.testHoldTitles = true;
      window.singleRaw = '[Hi-Res/48kHz/24bit]Out of Time - The Weeknd';
      window.api.video = async bvid => bvid === 'BV15C41187cx'
        ? { bvid, cid: 11, title: '周杰伦歌曲全集', duration: 1350, cover: '/assets/icon.png', up: '合集发布者', parts: [
          { page: 1, cid: 11, part: '01. 晴天', duration: 900 }, { page: 2, cid: 12, part: 'P2 - 发如雪', duration: 230 }, { page: 3, cid: 13, part: '正片', duration: 220 },
        ] }
        : { bvid, cid: 9, title: window.singleRaw, duration: 220, cover: '/assets/icon.png', up: '视频发布者', parts: [{ page: 1, cid: 9, part: window.singleRaw, duration: 220 }] };
      void addToFolder({ bvid: 'BV12M4m1y7hf' });
    });
    await page.locator('#addModal:not([hidden])').waitFor(); await page.locator('#addFolder').selectOption('a'); await page.locator('#addConfirm').click();
    await page.waitForFunction(() => window.testTitleRequests.length === 1);
    assert.equal(await page.evaluate(() => S.folders[0].items.length), 1);
    assert.equal(await page.evaluate(() => window.testSplitCalls), 0, 'single song must use title lookup, not audio analysis');
    await page.locator('#folders [data-id="a"]').click();
    await page.evaluate(async () => { loadQueue(folder().items, 0); await playQueueAt(0); audio.currentTime = 100; });
    await page.evaluate(() => window.testTitleRequests[0].resolve({ name: 'Out of Time', artist: 'The Weeknd', neteaseId: '1909926104', cover: 'https://art.test/out-of-time.png', matched: true }));
    await page.waitForFunction(() => S.folders[0].items[0].title === 'Out of Time');
    assert.equal(await page.evaluate(() => S.queue[0].title), 'Out of Time'); assert.equal(await page.locator('#bTitle').textContent(), 'Out of Time');
    assert.equal(await page.locator('#bUp').textContent(), 'The Weeknd'); assert.equal(await page.locator('#bCover').getAttribute('src'), 'https://art.test/out-of-time.png');
    assert.equal(await page.evaluate(() => folder().items[0].sourceTitle === window.singleRaw && folder().items[0].up === '视频发布者'), true);
    assert.equal(await page.evaluate(() => audio.currentTime), 100);
    // The first P is also metadata eligible even when it is longer than the split threshold.
    await page.evaluate(() => { void addToFolder({ bvid: 'BV15C41187cx' }); });
    await page.locator('#partsModal:not([hidden])').waitFor(); await page.locator('#pmAdd').click();
    await page.locator('#addModal:not([hidden])').waitFor(); assert.equal(await page.locator('#addSplitOptions').isHidden(), true);
    await page.locator('#addFolder').selectOption('a'); await page.locator('#addConfirm').click();
    await page.waitForFunction(() => window.testTitleRequests.length === 2);
    assert.deepEqual(await page.evaluate(() => window.testTitleRequests[1].input), { title: '01. 晴天', parentTitle: '周杰伦歌曲全集' });
    await page.evaluate(async () => { loadQueue(folder().items.slice(1), 1); await playQueueAt(1); audio.currentTime = 55; });
    await page.evaluate(() => window.testTitleRequests[1].resolve({ name: '晴天', artist: '周杰伦', cover: 'https://art.test/qingtian.png', matched: true }));
    await page.waitForFunction(() => window.testTitleRequests.length === 3);
    assert.deepEqual(await page.evaluate(() => window.testTitleRequests[2].input), { title: 'P2 - 发如雪', parentTitle: '周杰伦歌曲全集' });
    await page.evaluate(() => window.testTitleRequests[2].resolve({ name: '发如雪', artist: '周杰伦', cover: 'https://art.test/faruxue.png', matched: true }));
    await page.waitForFunction(() => S.folders[0].items[2].title === '发如雪');
    assert.deepEqual(await page.evaluate(() => folder().items.slice(1).map(i => [i.title, i.page, !!i.split])), [['晴天', 1, false], ['发如雪', 2, false], ['正片', 3, false]]);
    assert.equal(await page.evaluate(() => folder().items[1].duration), 900);
    assert.equal(await page.locator('#bTitle').textContent(), '发如雪'); assert.equal(await page.locator('#bCover').getAttribute('src'), 'https://art.test/faruxue.png');
    assert.equal(await page.evaluate(() => audio.currentTime), 55); assert.equal(await page.evaluate(() => window.testSplitCalls), 0);
    assert.equal(await page.locator('#list .group img').getAttribute('src'), '/assets/icon.png');
    await page.screenshot({ path: path.join(root, 'validation/ui-single-and-parts-metadata.png') });
    // Visible legacy singles are fixed without deleting and re-adding them.
    await page.evaluate(() => { folder().items.push({ bvid: 'BV1uuHd6cEhy', cid: 25, page: 1, title: 'The Weeknd - Die For You [Hi-Res]', duration: 250, cover: '/assets/icon.png' }); save(); renderList(); });
    await page.waitForFunction(() => window.testTitleRequests.length === 4);
    await page.evaluate(() => window.testTitleRequests[3].resolve({ name: 'Die For You', artist: 'The Weeknd', cover: 'https://art.test/die-for-you.png', matched: true }));
    await page.waitForFunction(() => S.folders[0].items.at(-1).title === 'Die For You');
    // Manual edits win over a pending title lookup; artwork can still finish.
    await page.evaluate(() => { folder().items.push({ bvid: 'BV1TBEK6jEps', cid: 26, page: 1, title: '周杰伦《稻香》官方MV', duration: 220, cover: '/assets/icon.png' }); save(); queueSongTitles(folder().items); renderList(); });
    await page.waitForFunction(() => window.testTitleRequests.length === 5);
    await page.evaluate(() => editSongInfo(folder().items.at(-1))); await page.locator('#songInfoTitle').fill('手动歌名'); await page.locator('#songInfoArtist').fill('实际表演者'); await page.locator('#songInfoForm [type="submit"]').click();
    await page.evaluate(() => window.testTitleRequests[4].resolve({ name: '稻香', artist: '周杰伦', cover: 'https://art.test/daoxiang.png', matched: true }));
    await page.waitForFunction(() => S.folders[0].items.at(-1).songCover === 'https://art.test/daoxiang.png');
    assert.equal(await page.evaluate(() => folder().items.at(-1).title), '手动歌名');
    // Long whole videos keep their title, and removed songs never return.
    await page.evaluate(() => {
      folder().items.push({ bvid: 'BV1HE411E7Gx', cid: 27, page: 1, title: '周杰伦《晴天》', vtitle: '周杰伦《晴天》', duration: 1800 });
      folder().items.push({ bvid: 'BV1MsQdBNExh', cid: 28, page: 1, title: 'The Weeknd - Starboy', duration: 220 });
      save(); queueSongTitles(folder().items); renderList();
    });
    await page.waitForFunction(() => window.testTitleRequests.length === 6);
    assert.equal(await page.evaluate(() => window.testTitleRequests[5].input.title), 'The Weeknd - Starboy');
    await page.evaluate(() => { folder().items.pop(); save(); renderList(); window.testTitleRequests[5].resolve({ name: 'Starboy', artist: 'The Weeknd', cover: 'https://art.test/late.png', matched: true }); });
    await page.waitForTimeout(30);
    assert.equal(await page.evaluate(() => folder().items.some(i => i.bvid === 'BV1MsQdBNExh')), false);
    assert.equal(await page.evaluate(() => folder().items.at(-1).title), '周杰伦《晴天》');
    await page.evaluate(async () => { const it = folder().items[0]; it.cid = 0; await ensureCid(it); save(); });
    assert.equal(await page.evaluate(() => folder().items[0].title), 'Out of Time', 'video metadata repair cannot undo cleaned song names');
    const imported = await page.evaluate(() => LibraryModel.importedFolders({ folders: [{ name: 'roundtrip', items: folder().items }] })[0].items[0]);
    assert.equal(imported.sourceTitle.includes('Hi-Res'), true); assert.equal(imported.titleMetaVersion, 2);
    await page.reload(); await page.locator('#folders .folder').first().waitFor(); await page.locator('#folders [data-id="a"]').click();
    assert.equal(await page.evaluate(() => folder().items[0].title), 'Out of Time'); assert.equal(await page.evaluate(() => folder().items[1].partTitle), '01. 晴天');
    await page.waitForTimeout(50); assert.equal(await page.evaluate(() => window.testTitleRequests.length), 0, 'restart does not redo matched metadata or override manual names');
    assert.deepEqual(errors, []);
    console.log('PASS: actual single add and multi-P picker including P1>10min; automatic title/artist/art without audio analysis; queue/player sync; existing singles, raw title persistence, manual edits, long-video/removal protection, metadata repair and restart');
  } finally { await browser.close(); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
