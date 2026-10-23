// Real renderer DOM with deterministic media/IPC, never starts Electron or audio.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { mockBridge } = require('./test-ui.cjs');
const root = path.resolve(__dirname, '..');
const sliderTime = seconds => Math.round(seconds / 269.2 * 1000) * 269.2 / 1000;
async function run() {
  const { chromium } = require(process.env.CCMUSIC_PLAYWRIGHT || 'playwright');
  const browser = await chromium.launch({ executablePath: process.env.CCMUSIC_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
  try {
    const page = await browser.newPage({ serviceWorkers: 'block' }), errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.route('**/*', route => {
      const name = new URL(route.request().url()).pathname;
      if (!/^\/renderer\/[a-z.-]+\.(?:js|css|html)$/.test(name) && name !== '/assets/icon.png') return route.abort();
      const file = path.join(root, name);
      if (!fs.existsSync(file)) return route.abort();
      return route.fulfill({ body: fs.readFileSync(file), contentType: name.endsWith('.html') ? 'text/html; charset=utf-8' : name.endsWith('.css') ? 'text/css' : name.endsWith('.png') ? 'image/png' : 'text/javascript; charset=utf-8' });
    });
    await page.addInitScript(mockBridge);
    await page.addInitScript(() => {
      window.testSeeking = false;
      Object.defineProperty(HTMLMediaElement.prototype, 'seeking', { get: () => window.testSeeking });
    });
    await page.goto('http://ccmusic.test/renderer/index.html');
    await page.locator('#folders .folder').first().waitFor(); await page.clock.install();
    await page.evaluate(async () => {
      window.moon = { bvid: 'BV1CaPrz7EL6', cid: 36468035480, page: 1, title: '月光', split: true, startSec: 0, endSec: 269.2, duration: 269.2 };
      window.playCalls = [];
      window.api.playurl = async (...args) => { playCalls.push(args); return { tracks: [{ url: 'https://audio.invalid/main', backupUrls: ['https://audio.invalid/backup'] }] }; };
      loadQueue([moon], 0); await playTrack(moon); audio.currentTime = 80; audio.dispatchEvent(new Event('timeupdate'));
      $('#seek').value = String(20 / 269.2 * 1000); $('#seek').dispatchEvent(new Event('input'));
      await recoverPlayback();
    });
    assert(Math.abs(await page.evaluate(() => audio.currentTime) - sliderTime(20)) < 1e-8);
    assert.equal(await page.evaluate(() => S.queue.length), 1);
    // Progress/seeked from the previous drag cannot alter the current target.
    await page.evaluate(() => {
      for (const target of [60, 10, 45, 4, 25]) {
        $('#seek').value = String(target / 269.2 * 1000); $('#seek').dispatchEvent(new Event('input'));
      }
      audio.currentTime = 60; audio.dispatchEvent(new Event('seeked')); audio.dispatchEvent(new Event('timeupdate'));
    });
    assert(Math.abs(await page.evaluate(() => playback.lastPosition) - sliderTime(25)) < 1e-8);
    await page.evaluate(() => { audio.currentTime = 25; audio.dispatchEvent(new Event('seeked')); });
    // Seek at 11.9 seconds invalidates a pending 12-second buffering timeout.
    await page.evaluate(() => { window.testAudioReadyState = 2; audio.dispatchEvent(new Event('waiting')); });
    await page.clock.runFor(11900);
    const before = await page.evaluate(() => playCalls.length);
    await page.evaluate(() => { $('#seek').value = String(7 / 269.2 * 1000); $('#seek').dispatchEvent(new Event('input')); });
    await page.clock.runFor(200);
    assert.equal(await page.evaluate(() => playCalls.length), before);
    await page.evaluate(() => { window.testAudioReadyState = 4; audio.dispatchEvent(new Event('seeked')); audio.dispatchEvent(new Event('playing')); });
    await page.clock.runFor(12500);
    assert.equal(await page.evaluate(() => playCalls.length), before, 'successful seek leaves no automatic restart behind');
    // The last drag during an outstanding URL request wins.
    await page.evaluate(() => {
      window.api.playurl = (...args) => { playCalls.push(args); return new Promise(resolve => { window.resolvePlay = resolve; }); };
      window.loadingPlay = playTrack(moon, undefined, { position: 55 });
    });
    await page.waitForFunction(() => !!window.resolvePlay);
    await page.evaluate(() => {
      for (let i = 0; i < 100; i++) { $('#seek').value = String(i % 64); $('#seek').dispatchEvent(new Event('input')); }
      $('#seek').value = String(13 / 269.2 * 1000); $('#seek').dispatchEvent(new Event('input'));
      audio.currentTime = 88; audio.dispatchEvent(new Event('timeupdate'));
      resolvePlay({ tracks: [{ url: 'https://audio.invalid/new' }] });
    });
    await page.evaluate(() => loadingPlay);
    assert(Math.abs(await page.evaluate(() => audio.currentTime) - sliderTime(13)) < 1e-8);
    assert.equal(await page.evaluate(() => S.queue.length), 1);
    assert.equal(await page.locator('#bTitle').textContent(), '月光');
    // A newly selected split uses its own interval, not the previous song's range.
    await page.evaluate(() => {
      window.resolvePlay = null;
      window.loadingPlay = playTrack({ ...moon, startSec: 300, endSec: 500, title: '下一首' });
    });
    await page.waitForFunction(() => !!window.resolvePlay);
    await page.evaluate(() => { $('#seek').value = '250'; $('#seek').dispatchEvent(new Event('input')); resolvePlay({ tracks: [{ url: 'https://audio.invalid/next' }] }); });
    await page.evaluate(() => loadingPlay);
    assert.equal(await page.evaluate(() => audio.currentTime), 350);
    await page.evaluate(() => {
      window.resolvePlay = null;
      window.loadingPlay = playTrack({ ...moon, split: false, startSec: undefined, endSec: undefined, duration: 100, title: '单曲' });
    });
    await page.waitForFunction(() => !!window.resolvePlay);
    await page.evaluate(() => { $('#seek').value = '250'; $('#seek').dispatchEvent(new Event('input')); resolvePlay({ tracks: [{ url: 'https://audio.invalid/single' }] }); });
    await page.evaluate(() => loadingPlay);
    assert.equal(await page.evaluate(() => audio.currentTime), 25, 'new whole-video request uses its own known duration while the old media is still loaded');
    await page.evaluate(() => { clearQueue(); audio.dispatchEvent(new Event('seeked')); audio.dispatchEvent(new Event('timeupdate')); });
    assert.equal(await page.evaluate(() => playback.current), null);
    assert.equal(await page.evaluate(() => playback.seekTarget), null);
    assert.deepEqual(errors, []);
    console.log('PASS: actual DOM backwards seek/recovery, rapid drag, obsolete progress, 12-second stall invalidation, delayed URL, split isolation and queue cleanup; no audio/Electron/network');
  } finally { await browser.close(); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
