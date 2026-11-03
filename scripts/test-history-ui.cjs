const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { mockBridge } = require('./test-ui.cjs');
async function run() {
  const { chromium } = require(process.env.CCMUSIC_PLAYWRIGHT || 'playwright');
  const browser = await chromium.launch({ executablePath: process.env.CCMUSIC_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
  try {
    const page = await browser.newPage(), errors = [], root = path.resolve(__dirname, '..');
    page.on('pageerror', e => errors.push(e.message));
    await page.route('**/*', route => {
      const name = new URL(route.request().url()).pathname;
      if (!/^\/renderer\/[a-z.-]+\.(?:js|css|html)$/.test(name) && name !== '/assets/icon.png') return route.abort();
      const file = path.join(root, name); if (!fs.existsSync(file)) return route.abort();
      return route.fulfill({ body: fs.readFileSync(file), contentType: file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.css') ? 'text/css' : file.endsWith('.png') ? 'image/png' : 'text/javascript; charset=utf-8' });
    });
    await page.addInitScript(mockBridge); await page.goto('http://history.test/renderer/index.html');
    await page.locator('#folders .folder').first().waitFor();
    await page.locator('.history-nav').click(); assert.equal(await page.locator('#historyList .empty').textContent(), '还没有播放记录');
    await page.evaluate(async () => {
      window.song = { bvid: 'BV1CaPrz7EL6', cid: 36468035480, page: 1, title: '月光', artist: '胡彦斌', duration: 269.2, split: true, startSec: 0, endSec: 269.2, url: 'https://secret.invalid/token' };
      await playTrack(song); await playTrack(song, undefined, { recovery: true }); await playTrack({ ...song, startSec: 269.2, endSec: 480, title: '红颜' }, undefined, { preview: true });
    });
    assert.equal(await page.evaluate(() => S.history.length), 1);
    assert.equal(await page.evaluate(() => JSON.stringify(S.history).includes('secret.invalid')), false);
    await page.evaluate(async () => { await playTrack({ ...song, startSec: 269.2, endSec: 480, title: '红颜' }); await playTrack(song); });
    assert.deepEqual(await page.evaluate(() => S.history.map(r => r.item.title)), ['月光', '红颜']);
    await page.evaluate(() => { const old = window.api.playurl; window.api.playurl = async () => { throw Error('failed'); }; window.failure = playTrack({ ...song, title: '失败曲目', bvid: 'BV15C41187cx' }); window.restorePlayurl = () => { window.api.playurl = old; }; });
    await page.evaluate(() => failure); assert.equal(await page.evaluate(() => S.history.length), 2); await page.evaluate(() => restorePlayurl());
    await page.reload(); await page.locator('#folders .folder').first().waitFor(); await page.locator('.history-nav').click();
    assert.equal(await page.locator('#historyList .row').count(), 2);
    await page.screenshot({ path: path.join(root, 'validation/ui-history.png') });
    await page.locator('#historyFilter').fill('红颜'); assert.equal(await page.locator('#historyList .row').count(), 1);
    await page.locator('#historyList [data-history-play]').click(); await page.waitForFunction(() => playback.current?.item.title === '红颜');
    assert.equal(await page.evaluate(() => playback.current.item.startSec), 269.2);
    await page.locator('#historyFilter').fill('');
    await page.locator('#historyList [data-history-remove]').first().click(); assert.equal(await page.evaluate(() => S.history.length), 1);
    await page.locator('#historyClear').click(); await page.getByRole('button', { name: '清空', exact: true }).click();
    assert.equal(await page.evaluate(() => S.history.length), 0);
    await page.reload(); await page.locator('#folders .folder').first().waitFor(); assert.equal(await page.evaluate(() => S.history.length), 0);
    assert.equal(await page.evaluate(() => cleanPlayHistory([{ playedAt: Date.now(), item: { bvid: 'invalid' } }]).length), 0);
    assert.equal(await page.evaluate(() => cleanPlayHistory(Array.from({ length: 510 }, (_, i) => ({ playedAt: Date.now() - i, item: { title: '曲目', duration: 200, bvid: 'BV' + String(i).padStart(10, '0') } }))).length), 500);
    assert.deepEqual(errors, []);
    console.log('PASS: actual play/preview/recovery/failure history, deduplication/order, persistence, filter/replay with segment bounds, remove/confirm-clear/restart and credential exclusion; no audio/Electron');
  } finally { await browser.close(); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
