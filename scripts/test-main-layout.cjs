// Reference-layout interaction and geometry checks; IPC/media mocked, no Electron/audio.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { mockBridge } = require('./test-ui.cjs');
const root = path.resolve(__dirname, '..');
(async () => {
  const { chromium } = require(process.env.CCMUSIC_PLAYWRIGHT || 'playwright');
  const browser = await chromium.launch({ executablePath: process.env.CCMUSIC_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } }), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => {
      const name = new URL(route.request().url()).pathname;
      if (!/^\/renderer\/[a-z.-]+\.(?:js|css|html)$/.test(name) && name !== '/assets/icon.png') return route.abort();
      const file = path.join(root, name);
      return route.fulfill({ body: fs.readFileSync(file), contentType: file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.css') ? 'text/css' : file.endsWith('.png') ? 'image/png' : 'text/javascript; charset=utf-8' });
    });
    await page.addInitScript(mockBridge);
    await page.goto('http://layout.test/renderer/index.html');
    await page.locator('#folders .folder').first().waitFor();
    assert.equal(await page.locator('.side #downloadsBtn').count(), 1);
    assert.equal(await page.locator('.topbar #downloadsBtn').count(), 0);
    assert.equal(await page.locator('#nfName').count(), 0);
    assert.equal(await page.locator('#libImport').textContent(), '＋');
    await page.locator('#libImport').click(); await page.getByText('新建歌单', { exact: true }).click();
    await page.locator('#editValue').fill('新的音乐收藏'); await page.locator('#editForm button[type="submit"]').click();
    await page.waitForFunction(() => folder()?.name === '新的音乐收藏');
    assert.equal(await page.locator('#libTitle').textContent(), '新的音乐收藏');
    await page.locator('#libImport').click(); await page.getByText('导入歌单…', { exact: true }).click();
    assert(await page.locator('#playlistImport').isVisible()); await page.locator('#playlistHide').click();
    await page.locator('.history-nav').click(); assert(await page.locator('#view-history').isVisible());
    await page.locator('#downloadsBtn').click(); assert.equal(await page.evaluate(() => S.view), 'downloads');
    await page.locator('#downloadsBtn').click(); assert(await page.locator('#downloadsPanel').isVisible(), 'selected page stays open');
    await page.locator('#qBtn').click(); assert(await page.locator('#downloadsPanel').isVisible(), 'queue does not blank the records page');
    await page.locator('#qClose').click();
    await page.locator('#backBtn').click(); assert(await page.locator('#view-history').isVisible());
    await page.evaluate(async () => {
      window.testLogged = true;
      const item = { bvid: 'BV0000000001', cid: 1, page: 1, partsCount: 1, title: '晴天', artist: '周杰伦', duration: 269, cover: '/assets/icon.png', identifySource: 'manual' };
      loadQueue([item], 0); await playQueueAt(0); audio.currentTime = 45; audio.dispatchEvent(new Event('timeupdate'));
    });
    await page.locator('#barDownload').click(); await page.locator('#downloadsPanel').waitFor();
    assert.equal(await page.evaluate(() => testDownloadCalls.length), 1, 'player download button uses the existing download flow');
    await page.evaluate(() => {
      downloadTasks.clear();
      for (let i = 0; i < 15; i++) downloadTasks.set('layout-' + i, { id: 'layout-' + i, title: ['晴天', '普通朋友', '流沙', '夜曲', '稻香'][i % 5],
        state: i === 3 ? 'saving' : i === 4 ? 'downloading' : 'done', pct: i === 3 ? 68 : 36, quality: 'MP3 · 320 kbps', file: i < 3 ? 'D:/音乐/歌曲.mp3' : '' });
      renderDownloads();
    });
    for (const width of [1280, 900]) {
      await page.setViewportSize({ width, height: width === 900 ? 600 : 820 });
      const layout = await page.evaluate(() => {
        const box = selector => { const b = document.querySelector(selector).getBoundingClientRect(); return { left: b.left, right: b.right, top: b.top, bottom: b.bottom }; };
        return { track: box('.player-track'), controls: box('.ctrls'), seek: box('.seek'), tools: box('.bar .right'), page: box('#downloadsPanel'), bar: box('.bar'),
          buttons: [...document.querySelectorAll('.bar button, .bar input')].filter(node => node.getClientRects().length).map(node => box('#' + node.id)) };
      });
      assert(layout.track.right <= layout.seek.left); assert(layout.seek.right <= layout.tools.left);
      assert(layout.controls.bottom <= layout.seek.top + 1); assert(layout.page.bottom <= layout.bar.top);
      assert.equal(layout.bar.bottom - layout.bar.top, 82);
      assert(Math.abs((layout.tools.top + layout.tools.bottom) / 2 - (layout.bar.top + layout.bar.bottom) / 2) <= 2, 'right-hand buttons centre vertically');
      assert(layout.buttons.every(b => b.left >= 0 && b.right <= width && b.bottom <= (width === 900 ? 600 : 820)));
      assert(await page.locator('#downloadsList').evaluate(el => el.scrollHeight > el.clientHeight));
      await page.screenshot({ path: path.join(root, 'validation/ui-main-layout-' + width + '.png') });
    }
    assert.equal(await page.locator('.player-track #likeButton').count(), 1);
    assert.equal(await page.locator('.ctrls #mode').count(), 1);
    assert(await page.evaluate(() => $('#mode').getBoundingClientRect().right < $('#prev').getBoundingClientRect().left));
    const seek = await page.locator('#seek').boundingBox();
    await page.mouse.click(seek.x + seek.width * .25, seek.y + seek.height / 2);
    const early = await page.evaluate(() => audio.currentTime);
    await page.mouse.move(seek.x + seek.width * .25, seek.y + seek.height / 2); await page.mouse.down();
    await page.mouse.move(seek.x + seek.width * .75, seek.y + seek.height / 2, { steps: 8 }); await page.mouse.up();
    assert(await page.evaluate(() => audio.currentTime) > early + 100, 'thin thumb-free progress bar still supports clicking and dragging');
    assert(Math.abs(await page.locator('#seek').evaluate(el => parseFloat(el.style.getPropertyValue('--seek-progress'))) - 75) < 1);
    await page.mouse.move(400, 100); await page.locator('#volumePopover').waitFor({ state: 'hidden' });
    await page.locator('#volumeButton').hover(); await page.locator('#volumePopover').waitFor({ state: 'visible' });
    const previousVolume = await page.evaluate(() => userVolume);
    await page.mouse.wheel(0, -100);
    assert(Math.abs(await page.evaluate(() => userVolume) - previousVolume - .02) < 1e-8, 'wheel up increases volume');
    const slider = await page.locator('#vol').boundingBox();
    assert(slider.height > slider.width * 3, 'volume expands vertically above the speaker');
    await page.mouse.click(slider.x + slider.width / 2, slider.y + slider.height - 8);
    const lowVolume = await page.evaluate(() => userVolume);
    await page.mouse.move(slider.x + slider.width / 2, slider.y + slider.height - 8); await page.mouse.down();
    await page.mouse.move(slider.x + slider.width / 2, slider.y + 8, { steps: 8 }); await page.mouse.up();
    assert(await page.evaluate(() => userVolume) > lowVolume + .5, 'click and native drag adjust volume bottom-to-top');
    await page.screenshot({ path: path.join(root, 'validation/ui-player-volume-popup.png') });
    await page.mouse.move(400, 100); await page.locator('#volumePopover').waitFor({ state: 'hidden' });
    await page.locator('#volumeButton').focus(); await page.locator('#vol').press('Home');
    assert.equal(await page.evaluate(() => userVolume), 0);
    await page.locator('#vol').press('End'); assert.equal(await page.evaluate(() => userVolume), 1);
    await page.locator('#vol').press('Escape'); await page.locator('#volumePopover').waitFor({ state: 'hidden' });
    assert.equal(await page.evaluate(() => localStorage.savedVolume), '1');
    assert.deepEqual(errors, []);
    console.log('PASS sidebar history/download navigation/back, one plus menu/create/import, player download flow, 1280/900px three-part player geometry, records scrolling and queue coexistence; no audio/Electron');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
