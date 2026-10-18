// Actual renderer and image error events; controlled IPC, no Electron or playback.
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
      if (url.host === 'art.test') return url.pathname === '/missing.png' ? route.abort() : route.fulfill({ body: fs.readFileSync(path.join(root, 'assets/icon.png')), contentType: 'image/png' });
      if (!files.includes(url.pathname)) return route.abort();
      return route.fulfill({ body: fs.readFileSync(path.join(root, url.pathname)), contentType: url.pathname.endsWith('.html') ? 'text/html; charset=utf-8' : url.pathname.endsWith('.css') ? 'text/css; charset=utf-8' : url.pathname.endsWith('.png') ? 'image/png' : 'text/javascript; charset=utf-8' });
    });
    await page.addInitScript(mockBridge);
    await page.goto('http://ccmusic.test/renderer/index.html');
    await page.locator('#folders .folder').first().waitFor();
    await page.evaluate(() => {
      window.testHoldCovers = true;
      const f = S.folders[0]; S.active = f.id; showView('library');
      window.coverOriginal = { bvid: 'BV12M4m1y7hf', cid: 11, page: 1, title: '封面同步合集', vtitle: '封面同步合集', duration: 600, cover: '/assets/icon.png' };
      f.items = [window.coverOriginal]; loadQueue(f.items, 0); audio.currentTime = 100;
      const tracks = [0, 200, 400].map(start => ({ start, end: start + 200, title: '' }));
      const batch = applySplitResult(f, f.items[0], { tracks, duration: 600 });
      window.coverTask = { id: 'cover-task', runId: 'cover-run', folder: f, item: window.coverOriginal, batch, state: 'running', result: { tracks, duration: 600 } };
      splitTasks.set(coverTask.id, coverTask); renderTasks();
      playback.current = { item: S.queue[0], idx: 0 };
      taskProgress({ requestId: 'cover-run', stage: 'identify', index: 0, done: 1, total: 3, track: { ...tracks[0], title: '第一首', artist: '原唱甲', source: 'netease', neteaseId: '347230' } });
    });
    await page.waitForFunction(() => window.testCoverRequests.length === 1);
    assert.equal(await page.evaluate(() => folder().items[0].title), '第一首');
    assert.equal(await page.locator('#bCover').getAttribute('src'), '/assets/icon.png', 'song name is visible before pending artwork');
    // The next recognized song is usable while the previous cover query waits.
    await page.evaluate(() => taskProgress({ requestId: 'cover-run', stage: 'identify', index: 1, done: 2, total: 3,
      track: { start: 200, end: 400, title: '第二首', artist: '原唱乙', source: 'shazam', songCover: 'https://art.test/second.png' } }));
    assert.equal(await page.evaluate(() => folder().items[1].songCover), 'https://art.test/second.png');
    assert.equal(await page.evaluate(() => window.testCoverRequests.length), 1, 'Shazam-provided image needs no supplementary query');
    await page.evaluate(() => editSongInfo(folder().items[0]));
    await page.locator('#songInfoTitle').fill('翻唱显示名'); await page.locator('#songInfoArtist').fill('实际表演者');
    await page.locator('#songInfoForm [type="submit"]').click();
    await page.evaluate(() => { coverTask.state = 'done'; dismissSplitTask(coverTask); window.testCoverRequests[0].resolve('https://art.test/first.png'); });
    await page.waitForFunction(() => S.folders[0].items[0].songCover === 'https://art.test/first.png');
    assert.equal(await page.evaluate(() => splitTasks.size), 0, 'artwork may finish after completed task feedback disappears');
    assert.equal(await page.locator('#bCover').getAttribute('src'), 'https://art.test/first.png');
    assert.equal(await page.locator('#list .row.child img').first().getAttribute('src'), 'https://art.test/first.png');
    assert.equal(await page.locator('#queueList .qcover').first().getAttribute('src'), 'https://art.test/first.png');
    assert.equal(await page.locator('#list .group img').getAttribute('src'), '/assets/icon.png', 'group retains original video artwork');
    assert.equal(await page.evaluate(() => folder().items[0].cover), '/assets/icon.png');
    assert.equal(await page.evaluate(() => audio.currentTime), 100);
    assert.equal(await page.locator('#bTitle').textContent(), '翻唱显示名');
    assert.equal(await page.locator('#bUp').textContent(), '实际表演者');
    // Image transport failure falls back without losing the recognized title.
    await page.locator('#list .row.child img').first().dispatchEvent('error');
    await page.evaluate(() => refreshSongCoverImages());
    assert.equal(await page.locator('#list .row.child img').first().getAttribute('src'), '/assets/icon.png');
    await page.evaluate(() => { for (const item of [folder().items[1], S.queue[1]]) item.songCover = 'https://art.test/missing.png'; refreshSongCoverImages(); });
    await page.waitForFunction(() => document.querySelectorAll('#list .row.child img')[1].getAttribute('src') === '/assets/icon.png');
    const imported = await page.evaluate(() => LibraryModel.importedFolders({ folders: [{ name: '导出再导入', items: folder().items }] })[0].items[0]);
    assert.equal(imported.songCover, 'https://art.test/first.png'); assert.equal(imported.neteaseId, '347230');
    await page.evaluate(() => { save(); });
    await page.reload(); await page.locator('#folders .folder').first().waitFor(); await page.locator('#folders [data-id="a"]').click();
    assert.equal(await page.evaluate(() => folder().items[0].songCover), 'https://art.test/first.png');
    assert.equal(await page.evaluate(() => window.testCoverRequests.length), 0, 'saved artwork avoids lookup after restart');
    await page.evaluate(async () => { const item = folder().items[0]; item.cid = 0; await ensureCid(item); renderList(); });
    assert.equal(await page.evaluate(() => folder().items[0].songCover), 'https://art.test/first.png', 'video metadata repair does not overwrite album art');
    assert.equal(await page.locator('#list .row.child img').first().getAttribute('src'), 'https://art.test/first.png');
    // An unresolved cover cannot resurrect a split after undo/restoration.
    await page.evaluate(() => {
      window.testHoldCovers = true;
      requestSongCover(folder().items[2], { name: '第三首', artist: '原唱丙', neteaseId: '333' });
    });
    await page.waitForFunction(() => window.testCoverRequests.length === 1);
    await page.evaluate(() => {
      const f = folder(); const batch = f.items[0].splitBatch;
      const original = { bvid: 'BV12M4m1y7hf', cid: 11, page: 1, title: '封面同步合集', duration: 600, cover: '/assets/icon.png' };
      restoreSplitBatch(f, original, batch); save(); renderList(); renderQueue();
      window.testCoverRequests[0].resolve('https://art.test/late.png');
    });
    await page.waitForTimeout(30);
    assert.equal(await page.evaluate(() => folder().items.length), 1);
    assert.equal(await page.evaluate(() => folder().items[0].songCover), undefined);
    assert.equal(await page.evaluate(() => S.queue.length), 1);
    assert.equal(await page.evaluate(() => S.queue[0].songCover), undefined);
    assert.deepEqual(errors, []);
    console.log('PASS: nonblocking progressive art, provider-direct art, library/queue/player sync, video group preservation, manual metadata protection, image-error fallback, restart/import/metadata-repair persistence and late-result undo safety');
  } finally { await browser.close(); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
