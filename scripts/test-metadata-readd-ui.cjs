// Real renderer/add/remove UI, deterministic catalog replies, no Electron/audio.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { mockBridge } = require('./test-ui.cjs');
const root = path.resolve(__dirname, '..');
function replies() {
  window.rawSingle = '在百万豪装录音棚大声听 徐良&小凌《坏女孩》【Hi-res】';
  window.singleMatch = { name: '坏女孩', artist: '徐良/小凌', cover: 'https://art.test/bad-girl.png', matched: true };
  window.metadataCalls = 0; window.artCalls = 0;
  window.api.video = async bvid => ({ bvid, cid: 73, title: rawSingle, duration: 244, cover: '/assets/icon.png', up: 'JLRS-LeoFM',
    parts: [{ page: 1, cid: 73, part: rawSingle, duration: 244 }] });
  window.api.resolveSongTitle = async () => { window.metadataCalls++; return { ...singleMatch }; };
  window.api.songCover = async () => { window.artCalls++; return 'https://art.test/cover-only.png'; };
}
async function pageFor(browser, legacy = false) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 }, serviceWorkers: 'block' });
  page.errors = []; page.on('pageerror', e => page.errors.push(e.message));
  const source = legacy ? path.join(root, 'release-work/v1.6.1') : root;
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.host === 'art.test') return route.fulfill({ body: fs.readFileSync(path.join(root, 'assets/icon.png')), contentType: 'image/png' });
    if (!/^\/renderer\/[a-z.-]+\.(?:html|css|js)$/.test(url.pathname) && url.pathname !== '/assets/icon.png') return route.abort();
    const file = path.join(source, url.pathname); if (!fs.existsSync(file)) return route.abort();
    return route.fulfill({ body: fs.readFileSync(file), contentType: file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.css') ? 'text/css' : file.endsWith('.png') ? 'image/png' : 'text/javascript; charset=utf-8' });
  });
  await page.addInitScript(mockBridge); await page.addInitScript(replies);
  await page.goto('http://ccmusic.test/renderer/index.html'); await page.locator('#folders .folder').first().waitFor();
  await page.locator('#folders [data-id="a"]').click();
  return page;
}
async function addSingle(page) {
  await page.evaluate(() => { void addToFolder({ bvid: 'BV12M4m1y7hf' }); });
  await page.locator('#addModal:not([hidden])').waitFor(); await page.locator('#addFolder').selectOption('a');
  await page.locator('#addConfirm').click();
  await page.evaluate(async () => { await requestSongTitle(folder().items[0]); });
}
async function removeFirst(page) {
  await page.locator('#list .row:not(.group)').first().hover();
  await page.locator('#list [data-rm="0"]').click();
  await page.locator('#confirmModal:not([hidden])').waitFor(); await page.locator('#cfOk').click();
  assert.equal(await page.evaluate(() => folder().items.length), 0);
}
async function basic(page) {
  await addSingle(page); await page.waitForFunction(() => folder().items[0]?.title === '坏女孩');
  const firstBadge = await page.locator('#list .ptag').count();
  await removeFirst(page); await addSingle(page);
  const second = await page.evaluate(() => ({ title: folder().items[0].title, artist: folder().items[0].artist || '', cover: folder().items[0].songCover || '', calls: metadataCalls }));
  // Also reproduce cover-only memoization independently of the title resolver.
  const cover = await page.evaluate(async () => {
    folder().items = [{ bvid: 'BV15C41187cx', cid: 74, page: 1, title: '封面缓存', artist: '已识别歌手', identifySource: 'shazam', duration: 220, cover: '/assets/icon.png' }];
    await requestSongCover(folder().items[0]);
    const original = folder().items[0];
    folder().items = [{ ...original, songCover: undefined }];
    await requestSongCover(folder().items[0]);
    return { value: folder().items[0].songCover || '', calls: artCalls };
  });
  return { firstBadge, second, cover };
}
async function run() {
  fs.mkdirSync(path.join(root, 'validation'), { recursive: true });
  const { chromium } = require(process.env.CCMUSIC_PLAYWRIGHT || 'playwright');
  const browser = await chromium.launch({ executablePath: process.env.CCMUSIC_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
  try {
    // Optional local evidence against the untouched published release, never its installer.
    if (process.argv.includes('--reproduce-old')) {
      const old = await pageFor(browser, true); const result = await basic(old);
      assert.equal(result.firstBadge, 1); assert.notEqual(result.second.title, '坏女孩'); assert.equal(result.cover.value, '');
      console.log('REPRODUCED published v1.6.1:', JSON.stringify(result)); await old.close();
    }
    const page = await pageFor(browser); const result = await basic(page);
    assert.equal(result.firstBadge, 0, 'a cleaned single is not P1');
    assert.deepEqual(result.second, { title: '坏女孩', artist: '徐良/小凌', cover: 'https://art.test/bad-girl.png', calls: 1 }, 'cached result applies to the new item without a redundant lookup');
    assert.deepEqual(result.cover, { value: 'https://art.test/cover-only.png', calls: 1 });
    await page.evaluate(() => {
      S.queue = []; folder().items = [];
      window.api.resolveSongTitle = () => { window.metadataCalls++; return new Promise(resolve => { window.finishTitle = resolve; }); };
      window.pendingItem = { bvid: 'BV1uuHd6cEhy', cid: 75, page: 1, title: 'The Weeknd - Starboy', duration: 220 };
      folder().items.push(pendingItem); requestSongTitle(pendingItem);
    });
    await page.waitForFunction(() => !!window.finishTitle);
    await page.evaluate(async () => {
      folder().items = [{ ...pendingItem }];
      const waiting = requestSongTitle(folder().items[0]);
      window.finishTitle({ name: 'Starboy', artist: 'The Weeknd', cover: 'https://art.test/starboy.png', matched: true }); await waiting;
    });
    assert.equal(await page.evaluate(() => folder().items[0].title), 'Starboy', 'remove/readd during an in-flight query receives the shared result');
    assert.equal(await page.evaluate(() => pendingItem.title), 'The Weeknd - Starboy', 'removed object is never changed or restored');
    assert.equal(await page.evaluate(() => metadataCalls), 2, 'one provider request for both old/new instances');
    // An old response must not apply after the identity for that key changes.
    await page.evaluate(() => {
      folder().items = [{ bvid: 'BV1TBEK6jEps', cid: 76, page: 1, title: '周杰伦《晴天》', duration: 220 }];
      requestSongTitle(folder().items[0]);
    });
    await page.waitForFunction(() => metadataCalls === 3);
    await page.evaluate(() => {
      const finishOld = window.finishTitle;
      folder().items = [{ ...folder().items[0], title: '陶喆《普通朋友》' }];
      requestSongTitle(folder().items[0]);
      finishOld({ name: '晴天', artist: '周杰伦', cover: 'https://art.test/old.png', matched: true });
    });
    // The queued second identity waits for a controlled provider response.
    await page.waitForFunction(() => metadataCalls === 4);
    assert.equal(await page.evaluate(() => folder().items[0].title), '陶喆《普通朋友》');
    assert.equal(await page.evaluate(() => folder().items[0].songCover), undefined);
    await page.evaluate(async () => { window.finishTitle({ name: '普通朋友', artist: '陶喆', cover: 'https://art.test/new.png', matched: true }); await requestSongTitle(folder().items[0]); });
    assert.equal(await page.evaluate(() => folder().items[0].artist), '陶喆');
    // Null result throttles repeated scans of one item, but a fresh addition can retry.
    await page.evaluate(async () => {
      window.nullCalls = 0;
      window.api.resolveSongTitle = async () => ++window.nullCalls === 1 ? null : { name: '稻香', artist: '周杰伦', matched: true };
      folder().items = [{ bvid: 'BV1HE411E7Gx', page: 1, cid: 77, title: '周杰伦《稻香》', duration: 220 }];
      await requestSongTitle(folder().items[0]);
      for (let i = 0; i < 10; i++) await requestSongTitle(folder().items[0]);
    });
    assert.equal(await page.evaluate(() => nullCalls), 1);
    await page.evaluate(async () => { folder().items = [{ ...folder().items[0] }]; await requestSongTitle(folder().items[0]); });
    assert.equal(await page.evaluate(() => nullCalls), 2); assert.equal(await page.evaluate(() => folder().items[0].title), '稻香');
    await page.evaluate(async () => {
      window.undoneItem = { bvid: 'BV15C41187cx', cid: 74, page: 1, title: '周杰伦《七里香》', duration: 220 };
      folder().items = [undoneItem];
      const skipped = requestSongTitle(undoneItem);
      folder().items = []; await skipped;
      window.api.resolveSongTitle = async () => ({ name: '七里香', artist: '周杰伦', matched: true });
      folder().items = [undoneItem]; await requestSongTitle(undoneItem);
    });
    assert.equal(await page.evaluate(() => folder().items[0].title), '七里香', 'undo can retry work skipped while the item was absent');
    await page.evaluate(async () => {
      window.nullArtCalls = 0;
      window.api.songCover = async () => ++window.nullArtCalls === 1 ? '' : 'https://art.test/retried.png';
      folder().items = [{ bvid: 'BV1MsQdBNExh', cid: 78, page: 1, title: '封面重试', artist: '已识别歌手', identifySource: 'shazam', duration: 220 }];
      await requestSongCover(folder().items[0]);
      for (let i = 0; i < 10; i++) await requestSongCover(folder().items[0]);
    });
    assert.equal(await page.evaluate(() => nullArtCalls), 1);
    await page.evaluate(async () => { folder().items = [{ ...folder().items[0] }]; await requestSongCover(folder().items[0]); });
    assert.equal(await page.evaluate(() => nullArtCalls), 2); assert.equal(await page.evaluate(() => folder().items[0].songCover), 'https://art.test/retried.png');
    await page.evaluate(async () => {
      window.api.resolveSongTitle = async () => null;
      folder().items = [{ bvid: 'BV1uuHd6cEhy', page: 1, cid: 75, title: '你 我 怎 么 两 清', up: '星瞳_Official', duration: 197, cover: '/assets/icon.png' }];
      await requestSongTitle(folder().items[0]);
    });
    assert.deepEqual(await page.evaluate(() => [folder().items[0].title, songArtist(folder().items[0]), folder().items[0].songCover || '']), ['你 我 怎 么 两 清', '星瞳_Official', ''], 'uncertain cover caption preserves uploader/title/video artwork');
    // Real P1/P2 metadata survives title cleanup and importing; legacy singles don't gain P1.
    const badges = await page.evaluate(() => {
      const single = { bvid: 'BV12M4m1y7hf', title: '坏女孩', vtitle: rawSingle, sourceTitle: rawSingle, duration: 244, page: 1 };
      const first = { ...single, partsCount: 2, partTitle: '坏女孩' }, second = { ...first, page: 2 };
      return { legacy: rowHtml(single, 0).includes('ptag'), first: rowHtml(first, 0).includes('>P1<'), second: rowHtml(second, 0).includes('>P2<'),
        split: rowHtml({ ...first, split: true }, 0).includes('ptag'),
        imported: LibraryModel.importedFolders({ folders: [{ name: '多P', items: [first] }] })[0].items[0].partsCount };
    });
    assert.deepEqual(badges, { legacy: false, first: true, second: true, split: false, imported: 2 });
    await page.evaluate(() => { folder().items = [{ bvid: 'BV12M4m1y7hf', cid: 73, page: 1, title: '坏女孩', vtitle: rawSingle, sourceTitle: rawSingle, partsCount: 1, artist: '徐良/小凌', songCover: 'https://art.test/bad-girl.png', duration: 244, titleMetaVersion: 2, identifySource: 'title' }]; save(); renderList(); });
    await page.screenshot({ path: path.join(root, 'validation/ui-single-readd-fixed.png') });
    await page.reload(); await page.locator('#folders [data-id="a"]').click();
    assert.equal(await page.locator('#list .ptag').count(), 0); assert.equal(await page.evaluate(() => folder().items[0].artist), '徐良/小凌');
    assert.deepEqual(page.errors, []);
    console.log('PASS: single badge, actual remove/re-add title/artist/art, cover-only cache reuse, in-flight sharing, stale identity protection, null retry/no scan storm, real P1/P2, import and restart; no Electron/audio');
  } finally { await browser.close(); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
