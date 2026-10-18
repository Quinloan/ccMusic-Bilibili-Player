// Actual home DOM with controlled IPC pagination. No Electron/network/audio.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { mockBridge } = require('./test-ui.cjs');
const root = path.resolve(__dirname, '..');
function homeBridge() {
  const search = window.api.search; window.homeCalls = []; window.homeWaiters = {};
  window.homeRows = (page, count = 24, duration = 1800) => Array.from({ length: count }, (_, i) => ({ bvid: `home-${page}-${i}`, title: `音乐合辑 ${page}-${i}`, duration, author: '音乐发布者', pic: '/assets/icon.png', play: 1000 }));
  window.api.search = async (query, page) => {
    if (query !== '音乐') return search(query, page);
    window.homeCalls.push(page);
    if (window.homeTestMode === 'sparse') return { list: homeRows(page, 12, page <= 5 ? 45 : 1800), hasMore: page <= 5 };
    if (window.homeTestMode === 'first-fail') {
      if (window.homeCalls.length === 1) throw Error('首屏网络失败');
      return { list: homeRows(page), hasMore: false };
    }
    if (page === 1) return { list: homeRows(1, 1), hasMore: true };
    if (page === 2) return { list: [...homeRows(1, 1), ...homeRows(2), ...homeRows('clip', 3, 45)], hasMore: true };
    if (page === 3 || page === 5) return new Promise(resolve => { window.homeWaiters[page] = () => resolve({ list: homeRows(page), hasMore: true }); });
    if (page === 4 && !window.homeFailed) { window.homeFailed = true; throw Error('翻页网络失败'); }
    return { list: homeRows(page), hasMore: page < 6 };
  };
}
async function makePage(browser, mode = 'normal') {
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 }, serviceWorkers: 'block' });
  page.errors = []; page.on('pageerror', e => page.errors.push(e.message));
  await page.route('**/*', route => {
    const name = new URL(route.request().url()).pathname;
    if (!/^\/renderer\/[a-z.-]+\.(?:html|css|js)$/.test(name) && name !== '/assets/icon.png') return route.abort();
    const file = path.join(root, name); if (!fs.existsSync(file)) return route.abort();
    return route.fulfill({ body: fs.readFileSync(file), contentType: name.endsWith('.html') ? 'text/html; charset=utf-8' : name.endsWith('.css') ? 'text/css' : name.endsWith('.png') ? 'image/png' : 'text/javascript; charset=utf-8' });
  });
  await page.addInitScript(mockBridge);
  await page.addInitScript(mode => { window.homeTestMode = mode; }, mode);
  await page.addInitScript(homeBridge);
  await page.goto('http://ccmusic.test/renderer/index.html');
  await page.locator('#folders .folder').first().waitFor();
  return page;
}
async function bottom(page) {
  await page.evaluate(() => { const el = document.querySelector('#view-home .page'); el.scrollTop = el.scrollHeight; el.dispatchEvent(new Event('scroll')); });
}
async function run() {
  const { chromium } = require(process.env.CCMUSIC_PLAYWRIGHT || 'playwright');
  const browser = await chromium.launch({ executablePath: process.env.CCMUSIC_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true, args: ['--disable-background-networking'] });
  try {
    const page = await makePage(browser);
    await page.waitForFunction(() => homePage === 2 && !homeLoading);
    assert.equal(await page.locator('#homeHot .hcard').count(), 25, 'short first page is automatically filled; duplicates and short clips are excluded');
    assert.deepEqual(await page.evaluate(() => homeCalls), [1, 2]);
    await page.waitForTimeout(750); assert.deepEqual(await page.evaluate(() => homeCalls), [1, 2], 'do not fetch unseen pages');
    await page.evaluate(() => { window.firstCard = document.querySelector('#homeHot .hcard'); window.queueBefore = JSON.stringify(S.queue); });
    await bottom(page); await page.waitForFunction(() => !!homeWaiters[3]);
    assert.equal(await page.locator('#homePager span').textContent(), '正在加载…');
    await page.evaluate(() => {
      const el = document.querySelector('#view-home .page');
      const card = [...el.querySelectorAll('.hcard')].find(c => c.getBoundingClientRect().bottom > el.getBoundingClientRect().top);
      window.homeAnchor = { index: card.dataset.idx, top: card.getBoundingClientRect().top };
      for (let i = 0; i < 10; i++) el.dispatchEvent(new Event('scroll'));
    });
    await page.waitForTimeout(600); assert.deepEqual(await page.evaluate(() => homeCalls), [1, 2, 3], 'scroll events cannot overlap requests');
    await page.evaluate(() => homeWaiters[3]()); await page.waitForFunction(() => homePage === 3 && !homeLoading);
    assert.equal(await page.locator('#homeHot .hcard').count(), 49);
    assert.equal(await page.evaluate(() => firstCard === document.querySelector('#homeHot .hcard')), true, 'append retains existing card DOM');
    assert.ok(await page.evaluate(() => Math.abs(document.querySelector(`#homeHot [data-idx="${homeAnchor.index}"]`).getBoundingClientRect().top - homeAnchor.top) < 2), 'scroll anchor is retained');
    assert.equal(await page.evaluate(() => JSON.stringify(S.queue) === queueBefore && playback.current === null), true, 'pagination does not alter playback');
    await page.locator('#homeHot [data-idx="48"] [data-act="queue"]').click();
    assert.equal(await page.evaluate(() => S.queue.at(-1).bvid), 'home-3-23', 'new card actions target the correct appended item');
    await bottom(page); await page.locator('#homePager button:not([hidden])').waitFor();
    assert.equal(await page.evaluate(() => homePage), 3); assert.equal(await page.locator('#homeHot .hcard').count(), 49);
    await page.waitForTimeout(650); assert.deepEqual(await page.evaluate(() => homeCalls), [1, 2, 3, 4], 'failure does not cause a retry storm');
    await page.locator('#homePager button').click(); await page.waitForFunction(() => homePage === 4 && !homeLoading);
    assert.deepEqual(await page.evaluate(() => homeCalls), [1, 2, 3, 4, 4], 'retry requests the failed page');
    await bottom(page); await page.waitForFunction(() => !!homeWaiters[5]);
    await page.locator('#folders .folder').first().click();
    await page.evaluate(() => homeWaiters[5]()); await page.waitForFunction(() => homePage === 5 && !homeLoading);
    await page.waitForTimeout(650); assert.equal(await page.evaluate(() => S.view), 'library'); assert.equal(await page.evaluate(() => homeCalls.at(-1)), 5, 'hidden home stops automatically fetching');
    await page.locator('.home-nav').click(); await bottom(page);
    await page.waitForFunction(() => homePage === 6 && !homeLoading);
    assert.equal(await page.locator('#homeHot .hcard').count(), 121);
    assert.equal(await page.locator('#homePager span').textContent(), '没有更多了');
    assert.equal(await page.evaluate(() => new Set(S.hot.map(i => i.bvid)).size), 121);
    assert.equal(await page.evaluate(() => firstCard === document.querySelector('#homeHot .hcard')), true, 'returning to home preserves loaded cards');
    await bottom(page); await page.waitForTimeout(600); assert.equal(await page.evaluate(() => homeCalls.length), 7);
    await page.screenshot({ path: path.join(root, 'validation/ui-home-auto-scroll.png') });
    assert.deepEqual(page.errors, []); await page.close();
    const sparse = await makePage(browser, 'sparse');
    await sparse.waitForFunction(() => homeAutoPaused && !homeLoading);
    assert.equal(await sparse.evaluate(() => homePage), 5, 'filtering cannot crawl every upstream page without user intent');
    await sparse.waitForTimeout(650); assert.equal(await sparse.evaluate(() => homeCalls.length), 5);
    await sparse.locator('#view-home .page').hover(); await sparse.mouse.wheel(0, 600);
    await sparse.waitForFunction(() => homePage === 6 && !homeLoading);
    assert.equal(await sparse.locator('#homeHot .hcard').count(), 12); assert.deepEqual(sparse.errors, []); await sparse.close();
    const failed = await makePage(browser, 'first-fail');
    await failed.locator('#homePager button:not([hidden])').waitFor();
    assert.equal(await failed.evaluate(() => homePage), 0);
    await failed.locator('#homePager button').click(); await failed.waitForFunction(() => homePage === 1 && !homeLoading);
    assert.equal(await failed.locator('#homeHot .hcard').count(), 24); assert.deepEqual(await failed.evaluate(() => homeCalls), [1, 1]);
    assert.deepEqual(failed.errors, []); await failed.close();
    console.log('PASS: home infinite scroll, short-page autofill, dedup/filtering, request guard, DOM/scroll anchor retention, correct card actions, playback isolation, failed-page retry, hidden-view stop/resume, terminal state and bounded sparse-page scan; no Electron or audio');
  } finally { await browser.close(); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
