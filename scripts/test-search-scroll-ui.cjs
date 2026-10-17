// Actual renderer with controlled pagination/timers; no Electron, network or audio.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { mockBridge } = require('./test-ui.cjs');
const root = path.resolve(__dirname, '..');
async function makePage(browser) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 }, serviceWorkers: 'block' });
  page.errors = []; page.on('pageerror', e => page.errors.push(e.message));
  const files = ['/renderer/index.html', '/renderer/style.css', '/renderer/app.js', '/renderer/downloads.js', '/renderer/workflows.js', '/renderer/library-model.js', '/renderer/music-search-policy.js', '/assets/icon.png'];
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (!files.includes(url.pathname)) return route.abort();
    return route.fulfill({ body: fs.readFileSync(path.join(root, url.pathname)), contentType: url.pathname.endsWith('.html') ? 'text/html; charset=utf-8' : url.pathname.endsWith('.css') ? 'text/css; charset=utf-8' : url.pathname.endsWith('.png') ? 'image/png' : 'text/javascript; charset=utf-8' });
  });
  await page.addInitScript(mockBridge);
  await page.goto('http://ccmusic.test/renderer/index.html'); await page.locator('#folders .folder').first().waitFor(); await page.locator('#homeHot .hcard').first().waitFor();
  return page;
}
async function undoTest(browser) {
  const page = await makePage(browser);
  await page.clock.install(); await page.mouse.move(5, 5);
  await page.evaluate(() => { window.undoHits = 0; offerUndo('已移除 90 首', () => window.undoHits++); });
  await page.clock.fastForward(6100);
  assert.equal(await page.locator('#undoBar').isHidden(), true, 'notification expires without clicking close');
  assert.equal(await page.evaluate(() => undoAction), null);
  assert.equal(await page.evaluate(() => window.undoHits), 0, 'expiration must not undo the action');
  await page.evaluate(() => offerUndo('旧操作', () => window.undoHits++));
  await page.clock.fastForward(4000);
  await page.evaluate(() => offerUndo('新操作', () => window.undoHits += 10));
  await page.clock.fastForward(2100);
  assert.equal(await page.locator('#undoBar').isVisible(), true, 'old timer cannot dismiss a new notification');
  await page.locator('#undoButton').hover(); await page.clock.fastForward(7000);
  assert.equal(await page.locator('#undoBar').isVisible(), true, 'hover pauses expiration');
  await page.mouse.move(5, 5); await page.clock.fastForward(4000);
  assert.equal(await page.locator('#undoBar').isHidden(), true, 'leaving resumes the remaining time');
  await page.evaluate(() => { offerUndo('键盘撤销', () => window.undoHits++); document.querySelector('#undoButton').focus(); });
  await page.clock.fastForward(7000);
  assert.equal(await page.locator('#undoBar').isVisible(), true, 'keyboard focus pauses expiration');
  await page.locator('#kw').focus(); await page.clock.fastForward(6100);
  assert.equal(await page.locator('#undoBar').isHidden(), true, 'keyboard blur resumes expiration');
  await page.evaluate(() => offerUndo('立即撤销', () => window.undoHits++));
  await page.locator('#undoButton').click();
  assert.equal(await page.locator('#undoBar').isHidden(), true); assert.equal(await page.evaluate(() => window.undoHits), 1);
  await page.evaluate(() => { document.querySelector('#kw').focus(); offerUndo('关闭通知', () => window.undoHits++); });
  await page.locator('#undoClose').click(); await page.clock.fastForward(7000);
  assert.equal(await page.locator('#undoBar').isHidden(), true); assert.equal(await page.evaluate(() => window.undoHits), 1);
  assert.deepEqual(page.errors, []); await page.close();
}
async function searchTest(browser) {
  const page = await makePage(browser);
  await page.evaluate(() => {
    window.searchCalls = []; window.searchWaiters = {}; window.retryFailed = false;
    window.rows = (page, count, seconds = 240, query = '周杰伦') => Array.from({ length: count }, (_, i) => ({ bvid: `${query}-${page}-${i}`, title: `${query} 歌曲 ${page}-${i}`, duration: seconds, pic: '/assets/icon.png', author: '音乐发布者', platformRank: page * 100 + i }));
    window.api.search = async (query, page) => {
      window.searchCalls.push({ query, page });
      if (query === '周杰伦') {
        if (page === 1) return { list: rows(page, 18, 1800).concat(rows('single', 3)), hasMore: true };
        if (page === 2) return { list: rows(page, 10, 1800), hasMore: true };
        if (page === 3) return { list: rows(page, 12), hasMore: true };
        return new Promise(resolve => { window.searchWaiters.more = () => resolve({ list: rows(page, 12), hasMore: false }); });
      }
      if (query === '重试') {
        if (page === 2 && !window.retryFailed) { window.retryFailed = true; throw Error('模拟网络失败'); }
        return { list: rows(page, 12, 240, query), hasMore: page < 2 };
      }
      if (query === '无匹配') return { list: rows(page, 12, page < 7 ? 1800 : 240, query), hasMore: page < 7 };
      if (query === '旧搜索') return new Promise(resolve => { window.searchWaiters.old = () => resolve({ list: rows(1, 12, 240, query), hasMore: true }); });
      if (query === '旧翻页' && page === 2) return new Promise(resolve => { window.searchWaiters.oldAppend = () => resolve({ list: rows(2, 12, 240, query), hasMore: true }); });
      if (query === '首屏失败' && !window.firstFailed) { window.firstFailed = true; throw Error('模拟首屏失败'); }
      if (query === '旧翻页') return { list: rows(1, 12, 240, query), hasMore: true };
      return { list: rows(1, 12, 240, query), hasMore: false };
    };
  });
  await page.locator('#kw').fill('周杰伦'); await page.locator('#go').click();
  await page.waitForFunction(() => S.page === 1 && !searchLoading);
  assert.equal(await page.locator('#results .row').count(), 21);
  assert.equal(await page.locator('#more').count(), 0, 'manual load-more button is removed');
  await page.locator('#searchFilter').selectOption('short');
  await page.waitForFunction(() => S.page === 3 && !searchLoading);
  assert.equal(await page.locator('#results .row').count(), 15, 'three sparse results automatically fill from later pages, even through a page without matching songs');
  assert.deepEqual(await page.evaluate(() => window.searchCalls.map(c => c.page)), [1,2,3]);
  await page.waitForTimeout(800);
  assert.equal(await page.evaluate(() => window.searchCalls.length), 3, 'a filled viewport does not fetch unseen pages');
  await page.evaluate(() => { const el = document.querySelector('#results'); el.scrollTop = el.scrollHeight; });
  await page.waitForFunction(() => !!window.searchWaiters.more);
  assert.equal(await page.locator('#searchPager span').textContent(), '正在加载…');
  await page.evaluate(() => {
    const el = document.querySelector('#results');
    const row = [...el.querySelectorAll('.row')].find(r => r.getBoundingClientRect().bottom > el.getBoundingClientRect().top);
    window.scrollAnchor = { index: row.dataset.i, top: row.getBoundingClientRect().top };
    for (let n = 0; n < 10; n++) el.dispatchEvent(new Event('scroll'));
  });
  await page.waitForTimeout(800);
  assert.equal(await page.evaluate(() => window.searchCalls.length), 4, 'repeated scrolling never overlaps pagination');
  await page.evaluate(() => window.searchWaiters.more()); await page.waitForFunction(() => S.page === 4 && !searchLoading);
  assert.equal(await page.locator('#results .row').count(), 27);
  assert.equal(await page.evaluate(() => new Set(S.results.map(i => i.bvid)).size === S.results.length), true);
  assert(await page.evaluate(() => Math.abs(document.querySelector(`.row[data-i="${scrollAnchor.index}"]`).getBoundingClientRect().top - scrollAnchor.top) < 2), 'append preserves the visible row position');
  assert.equal(await page.locator('#searchPager span').textContent(), '没有更多了');
  await page.evaluate(() => { const el = document.querySelector('#results'); el.scrollTop = el.scrollHeight; el.dispatchEvent(new Event('scroll')); });
  await page.waitForTimeout(600); assert.equal(await page.evaluate(() => window.searchCalls.length), 4);
  await page.screenshot({ path: path.join(root, 'validation/ui-search-auto-scroll.png') });
  // A failed next page preserves rows and retries the same page only on request.
  await page.locator('#kw').fill('重试'); await page.locator('#go').click();
  await page.waitForFunction(() => S.kw === '重试' && !searchLoading);
  await page.evaluate(() => { const el = document.querySelector('#results'); el.scrollTop = el.scrollHeight; });
  await page.locator('#searchPager button:not([hidden])').waitFor();
  assert.equal(await page.locator('#results .row').count(), 12);
  const before = await page.evaluate(() => window.searchCalls.length);
  await page.waitForTimeout(800); assert.equal(await page.evaluate(() => window.searchCalls.length), before);
  await page.locator('#searchPager button').click(); await page.waitForFunction(() => S.page === 2 && !searchLoading);
  assert.equal(await page.locator('#results .row').count(), 24);
  assert.deepEqual(await page.evaluate(() => window.searchCalls.filter(c => c.query === '重试').map(c => c.page)), [1,2,2]);
  await page.locator('#kw').fill('首屏失败'); await page.locator('#go').click();
  await page.locator('#searchPager button:not([hidden])').waitFor();
  assert.equal(await page.locator('#results .empty').textContent(), '搜索暂时不可用');
  await page.locator('#searchPager button').click(); await page.waitForFunction(() => S.kw === '首屏失败' && !searchLoading && !searchError);
  assert.equal(await page.locator('#results .row').count(), 12);
  // A restrictive filter cannot autonomously crawl all 100 upstream pages.
  await page.locator('#kw').fill('无匹配'); await page.locator('#go').click();
  await page.waitForFunction(() => S.kw === '无匹配' && searchAutoPaused && !searchLoading);
  assert.equal(await page.evaluate(() => S.page), 6);
  assert.equal(await page.locator('#results .empty').textContent(), '没有符合当前筛选的结果', 'paused empty scans must not look like an endless spinner');
  await page.waitForTimeout(800); assert.equal(await page.evaluate(() => S.page), 6);
  await page.locator('#results').hover(); await page.mouse.wheel(0, 500);
  await page.waitForFunction(() => S.page === 7 && !searchLoading);
  assert.equal(await page.locator('#results .row').count(), 12, 'downward scroll intent can resume a bounded empty batch');
  // A late result must not replace a newer search, nor revive its pagination.
  await page.locator('#kw').fill('旧搜索'); await page.locator('#go').click();
  await page.waitForFunction(() => !!window.searchWaiters.old);
  await page.locator('#kw').fill('新搜索'); await page.locator('#go').click();
  await page.waitForFunction(() => S.kw === '新搜索' && !searchLoading);
  await page.evaluate(() => window.searchWaiters.old()); await page.waitForTimeout(600);
  assert.equal(await page.evaluate(() => S.results.every(i => i.title.includes('新搜索'))), true);
  assert.equal(await page.evaluate(() => S.hasMore), false);
  await page.locator('#kw').fill('旧翻页'); await page.locator('#go').click();
  await page.waitForFunction(() => S.kw === '旧翻页' && !searchLoading);
  await page.evaluate(() => { const el = document.querySelector('#results'); el.scrollTop = el.scrollHeight; });
  await page.waitForFunction(() => !!window.searchWaiters.oldAppend);
  await page.locator('#kw').fill('BV15C41187cx'); await page.locator('#go').click();
  await page.waitForFunction(() => S.searchDirect && !searchLoading);
  await page.evaluate(() => window.searchWaiters.oldAppend()); await page.waitForTimeout(600);
  assert.equal(await page.locator('#results .row').count(), 1); assert.equal(await page.locator('#searchPager').count(), 0, 'direct video links never paginate');
  assert.equal(await page.evaluate(() => S.hasMore), false, 'a late keyword page cannot overwrite a resolved video link');
  assert.deepEqual(page.errors, []); await page.close();
}
async function run() {
  const { chromium } = require(process.env.CCMUSIC_PLAYWRIGHT || 'playwright');
  const browser = await chromium.launch({ executablePath: process.env.CCMUSIC_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true, args: ['--disable-background-networking'] });
  try { await undoTest(browser); await searchTest(browser); console.log('PASS: timed undo with hover/focus/reset protection; sparse-filter autofill, infinite scroll, request dedup, anchor preservation, terminal state, retry, bounded empty pages, stale-query and direct-link safety'); }
  finally { await browser.close(); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
