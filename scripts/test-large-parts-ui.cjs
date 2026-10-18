// 148 parts, actual renderer and metadata resolver; synthetic catalog/IPC only.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { mockBridge } = require('./test-ui.cjs');
const { createArtworkResolver } = require('../cover-art.cjs');
const root = path.resolve(__dirname, '..');
async function run() {
  const { chromium } = require(process.env.CCMUSIC_PLAYWRIGHT || 'playwright');
  const browser = await chromium.launch({ executablePath: process.env.CCMUSIC_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
  const names = Array.from({ length: 148 }, (_, i) => ['飞机场的10:30', '爱,很简单', '沙滩 (钢琴版)', 'Answering Machine', '王八蛋 (Full Mix)', 'Doxology', '找自己', '普通朋友', "I'm OK"][i] || `测试曲目${String(i + 1).padStart(3, '0')}`);
  const catalog = names.map((name, i) => ({ id: i + 1, name, ar: [{ name: '陶喆' }], al: { picUrl: `https://art.test/${i + 1}.png` } }));
  const resolver = createArtworkResolver({ interval: 0, request: async () => Response.json({ code: 200, result: { songs: catalog } }) });
  const calls = [], held = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 }, serviceWorkers: 'block' });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.host === 'art.test') return route.fulfill({ body: fs.readFileSync(path.join(root, 'assets/icon.png')), contentType: 'image/png' });
      if (!/^\/renderer\/[a-z.-]+\.(?:html|css|js)$/.test(url.pathname) && url.pathname !== '/assets/icon.png') return route.abort();
      const file = path.join(root, url.pathname); if (!fs.existsSync(file)) return route.abort();
      return route.fulfill({ body: fs.readFileSync(file), contentType: file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.css') ? 'text/css' : file.endsWith('.png') ? 'image/png' : 'text/javascript; charset=utf-8' });
    });
    await page.exposeFunction('largeLookup', input => {
      calls.push(input);
      return calls.length <= 2 ? new Promise(resolve => held.push({ input, resolve })) : resolver.resolveTitle(input);
    });
    await page.addInitScript(mockBridge);
    await page.addInitScript(() => { window.api.resolveSongTitle = input => window.largeLookup(input); });
    await page.goto('http://ccmusic.test/renderer/index.html'); await page.locator('#folders .folder').first().waitFor();
    await page.clock.install();
    await page.evaluate(names => {
      window.largeItems = names.map((name, i) => ({ bvid: 'BV15C41187cx', page: i + 1, partsCount: 148, cid: 1000 + i,
        title: `${String(i + 1).padStart(2, '0')} ${name}【专辑：I'm OK】`,
        partTitle: `${String(i + 1).padStart(2, '0')} ${name}【专辑：I'm OK】`,
        vtitle: '【B站最高音质·附MV】陶喆 录音室作品 合集 (音乐 歌曲)', duration: 220, cover: '/assets/icon.png' }));
      folder().items = largeItems; queueSongTitles(largeItems);
    }, names);
    await page.waitForFunction(() => metadataQueue.active === 2);
    // A user requests the last part while both first requests are held.
    await page.evaluate(() => { void parseSongMetadata([largeItems[147]]); });
    await page.waitForTimeout(80);
    assert.equal(calls.length, 2, 'only two IPC requests active, not 148');
    assert.ok((await page.locator('#taskList').textContent()).includes('正在解析歌曲信息 0/1'));
    const second = held[1]; second.resolve(await resolver.resolveTitle(second.input));
    await page.waitForFunction(() => largeItems[147].titleMetaVersion === 4);
    assert.equal(calls[2].title.includes('测试曲目148'), true, 'manual selection jumps ahead of the 146 waiting automatic requests');
    await page.waitForFunction(() => largeItems.slice(1).every(item => item.titleMetaVersion === 4), null, { timeout: 30000 });
    assert.equal(await page.evaluate(() => largeItems[0].titleMetaVersion), undefined, 'the first IPC is still hung while the rest complete');
    assert.equal(await page.evaluate(() => metadataQueue.active), 1);
    await page.clock.fastForward(25010);
    await page.waitForFunction(() => metadataQueue.active === 0);
    // Explicit retry is allowed after the timeout; the old IPC reply is ignored.
    await page.evaluate(() => parseSongMetadata([largeItems[0]]));
    held[0].resolve({ name: '迟到的错误标题', artist: '错误歌手', matched: true });
    await page.waitForTimeout(50);
    assert.deepEqual(await page.evaluate(() => largeItems.map(item => item.title)), names);
    assert.equal(await page.evaluate(() => largeItems.every(item => item.artist === '陶喆' && item.titleMetaVersion === 4 && item.songCover)), true);
    assert.equal(await page.evaluate(() => metadataParseJobs.size), 0);
    assert.equal(await page.evaluate(() => LibraryModel.importedFolders({ folders: [folder()] })[0].items[147].titleMetaVersion), 4);
    assert.deepEqual(errors, []);
    console.log('PASS: 148-part actual renderer/provider integration, album-label cleanup, versions/clock preserved, bounded IPC, manual priority and progress, continuation past hung first request, timeout/retry, ignored late reply and v4 import; no Electron/audio/network/profile writes');
  } finally { await browser.close(); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
