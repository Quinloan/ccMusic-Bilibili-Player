// Split completion opens the actual review UI; mocked IPC/media, no Electron.
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
      const name = new URL(route.request().url()).pathname;
      if (!files.includes(name)) return route.abort();
      return route.fulfill({ body: fs.readFileSync(path.join(root, name)), contentType: name.endsWith('.html') ? 'text/html; charset=utf-8' : name.endsWith('.css') ? 'text/css; charset=utf-8' : name.endsWith('.png') ? 'image/png' : 'text/javascript; charset=utf-8' });
    });
    await page.addInitScript(mockBridge);
    await page.goto('http://ccmusic.test/renderer/index.html'); await page.locator('#folders .folder').first().waitFor();
    await page.evaluate(() => {
      S.active = 'a'; showView('library'); window.splitReplies = {}; window.recognitions = 0;
      const original = window.api.splitAnalyze;
      window.api.splitAnalyze = (...args) => args[5]?.mode === 'split'
        ? new Promise(resolve => { window.splitReplies[args[0]] = () => resolve({ duration: 600, tracks: [{ start: 0, end: 300, title: '' }, { start: 300, end: 600, title: '' }] }); })
        : (window.recognitions++, original(...args));
      folder().items = ['BV12M4m1y7hf', 'BV15C41187cx', 'BV1uuHd6cEhy', 'BV1TBEK6jEps'].map((bvid, i) => ({ bvid, cid: i + 1, title: `待切分合集 ${i + 1}`, duration: 600, page: 1 }));
      save(); renderList();
      void runSplitTask(folder(), folder().items[0], '');
      void runSplitTask(folder(), folder().items[1], '');
      window.splitReplies.BV12M4m1y7hf();
    });
    await page.locator('#reviewModal:not([hidden])').waitFor();
    assert.equal(await page.locator('#reviewTitle').textContent(), '待切分合集 1');
    assert.equal(await page.locator('#tasksPanel').isHidden(), true);
    assert.equal(await page.locator('.completion-notice').count(), 0);
    assert.equal(await page.evaluate(() => folder().items.length), 4);
    assert.equal(await page.evaluate(() => window.recognitions), 0, 'automatic preview does not auto-confirm or identify audio');
    await page.locator('#reviewAdjust').click(); await page.locator('.review-name').first().fill('保留这次编辑');
    await page.evaluate(() => window.splitReplies.BV15C41187cx());
    await page.waitForFunction(() => [...splitTasks.values()].every(t => t.state === 'ready'));
    assert.equal(await page.locator('#reviewTitle').textContent(), '待切分合集 1');
    assert.equal(await page.locator('.review-name').first().inputValue(), '保留这次编辑', 'second completion cannot replace the active review');
    await page.locator('#reviewConfirm').click();
    await page.waitForFunction(() => reviewTask?.task.item.bvid === 'BV15C41187cx');
    assert.equal(await page.evaluate(() => folder().items.filter(i => i.split).length), 2, 'only explicitly confirmed first task is inserted');
    await page.locator('#reviewClose').click(); await page.waitForTimeout(80);
    assert.equal(await page.locator('#reviewModal').isHidden(), true, 'Later does not immediately reopen the same task');
    await page.locator('#taskBtn').click(); await page.locator('[data-review]').click();
    assert.equal(await page.locator('#reviewTitle').textContent(), '待切分合集 2', 'deferred preview remains manually accessible');
    await page.locator('#reviewClose').click();
    // Completion waits for other modal interactions, then opens without a click.
    await page.evaluate(() => { void editText('正在编辑', '未保存内容'); void runSplitTask(folder(), folder().items.find(i => i.bvid === 'BV1uuHd6cEhy'), ''); window.splitReplies.BV1uuHd6cEhy(); });
    await page.waitForFunction(() => [...splitTasks.values()].some(t => t.item.bvid === 'BV1uuHd6cEhy' && t.state === 'ready'));
    assert.equal(await page.locator('#reviewModal').isHidden(), true);
    assert.equal(await page.locator('#editValue').inputValue(), '未保存内容');
    await page.locator('#editCancel').click();
    await page.waitForFunction(() => reviewTask?.task.item.bvid === 'BV1uuHd6cEhy');
    await page.screenshot({ path: path.join(root, 'validation/ui-split-auto-review.png') });
    await page.locator('#reviewClose').click();
    // A queued result removed before the modal closes must never reappear.
    await page.evaluate(() => { void editText('编辑中', '保留'); void runSplitTask(folder(), folder().items.find(i => i.bvid === 'BV1TBEK6jEps'), ''); window.splitReplies.BV1TBEK6jEps(); });
    await page.waitForFunction(() => [...splitTasks.values()].some(t => t.item.bvid === 'BV1TBEK6jEps' && t.state === 'ready'));
    await page.evaluate(() => dismissSplitTask([...splitTasks.values()].find(t => t.item.bvid === 'BV1TBEK6jEps')));
    await page.locator('#editCancel').click(); await page.waitForTimeout(80);
    assert.equal(await page.locator('#reviewModal').isHidden(), true);
    assert.deepEqual(errors, []);
    console.log('PASS: completion auto-opens review without auto-insertion; multiple tasks queued with edit preservation; confirm/Later/manual reopen; modal deferral and removed-task safety');
  } finally { await browser.close(); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
