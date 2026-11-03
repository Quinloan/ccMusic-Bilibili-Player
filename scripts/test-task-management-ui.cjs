// Headless real DOM, mock IPC; no Electron, external requests or audio playback.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { mockBridge } = require('./test-ui.cjs');
const root = path.resolve(__dirname, '..');
async function run() {
  const { chromium } = require(process.env.CCMUSIC_PLAYWRIGHT || 'playwright');
  const browser = await chromium.launch({ executablePath: process.env.CCMUSIC_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } }), errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.route('**/*', route => {
      const name = new URL(route.request().url()).pathname;
      if (!/^\/renderer\/[a-z.-]+\.(?:js|css|html)$/.test(name) && name !== '/assets/icon.png') return route.abort();
      const file = path.join(root, name); if (!fs.existsSync(file)) return route.abort();
      return route.fulfill({ body: fs.readFileSync(file), contentType: file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.css') ? 'text/css' : file.endsWith('.png') ? 'image/png' : 'text/javascript; charset=utf-8' });
    });
    await page.addInitScript(mockBridge); await page.goto('http://tasks.test/renderer/index.html');
    await page.locator('#folders .folder').first().waitFor();
    await page.evaluate(() => {
      window.manageCalls = []; window.serverDownloads = new Map();
      window.api.downloadManage = async (action, batchId) => {
        manageCalls.push({ action, batchId }); const removed = []; let cancelled = 0;
        for (const [id, task] of serverDownloads) {
          if (batchId && batchId !== task.batchId) continue;
          if (action === 'cancel' ? task.state === 'committing' || ['done', 'error'].includes(task.state) : !downloadEnded(task)) continue;
          if (action === 'cancel' && task.state !== 'cancelled') cancelled++;
          serverDownloads.delete(id); removed.push(id);
          if (action === 'cancel') emitDownload({ ...task, state: 'cancelled' });
        }
        return { removed, cancelled, committing: 0 };
      };
      const batchProgress = { total: 3, downloaded: 2, saved: 1, waiting: 1, converting: 1, failed: 0, cancelled: 0 };
      const tasks = [
        { id: 'a-done', title: '已保存的歌曲', batchId: 'A', state: 'done', file: 'D:/歌曲/已保存.mp3' },
        { id: 'a-saving', title: '正在转换的歌曲', batchId: 'A', state: 'saving', pct: 38 },
        { id: 'a-waiting', title: '等待转换的歌曲', batchId: 'A', state: 'waiting-conversion' },
        { id: 'b-downloading', title: '另一批歌曲', batchId: 'B', state: 'downloading', pct: 45 }
      ];
      for (const task of tasks) {
        if (task.batchId === 'A') Object.assign(task, { batchProgress, batchRevision: 1 });
        serverDownloads.set(task.id, task); emitDownload(task);
      }
      showDownloads();
    });
    assert.equal(await page.locator('#downloadsCancelAll').isEnabled(), true);
    await page.screenshot({ path: path.join(root, 'validation/ui-task-bulk-actions.png') });
    await page.locator('[data-dl-batch-cancel="A"]').click();
    await page.waitForFunction(() => !downloadTasks.has('a-saving') && !downloadTasks.has('a-waiting'));
    assert.deepEqual(await page.evaluate(() => [...downloadTasks.keys()]), ['a-done', 'b-downloading']);
    await page.evaluate(() => emitDownload({ id: 'a-waiting', title: '迟到的事件', state: 'cancelled' }));
    assert.equal(await page.evaluate(() => downloadTasks.has('a-waiting')), false);
    await page.locator('#downloadsClear').click();
    await page.waitForFunction(() => !downloadTasks.has('a-done'));
    assert.equal(await page.locator('#downloadsClear').isDisabled(), true);
    await page.locator('#downloadsCancelAll').click();
    await page.waitForFunction(() => !downloadTasks.size);
    assert.equal(await page.locator('#downloadsEmpty').isVisible(), true);
    assert.equal(await page.locator('#downloadsTools').isHidden(), true);
    assert.deepEqual(await page.evaluate(() => manageCalls), [{ action: 'cancel', batchId: 'A' }, { action: 'clear', batchId: undefined }, { action: 'cancel', batchId: undefined }]);

    await page.evaluate(() => {
      window.testSplitDelay = 350;
      const f = S.folders[0];
      const items = [1, 2].map(cid => ({ title: '待分歌' + cid, bvid: 'BV1CaPrz7EL6', cid, duration: 1200 }));
      f.items.push(...items);
      for (const item of items) void runSplitTask(f, item, '');
      splitTasks.set('ready', { id: 'ready', state: 'ready', folder: f, item: items[0], result: { tracks: [{ start: 0, end: 600 }, { start: 600, end: 1200 }] } });
      splitTasks.set('error', { id: 'error', state: 'error', folder: f, item: items[1], error: '测试失败' });
      renderTasks();
    });
    await page.locator('#tasksCancelAll').click();
    await page.waitForFunction(() => [...splitTasks.values()].every(t => t.state !== 'running'));
    assert.deepEqual(await page.evaluate(() => [...splitTasks.keys()]), ['ready', 'error']);
    await page.locator('#tasksClear').click();
    assert.deepEqual(await page.evaluate(() => [...splitTasks.keys()]), ['ready'], 'pending confirmation is preserved');
    await page.waitForTimeout(450);
    assert.deepEqual(await page.evaluate(() => [...splitTasks.keys()]), ['ready'], 'late split responses never restore cancelled work');
    assert.equal(await page.evaluate(() => S.folders[0].items.length), 2, 'cancellation preserves library items');
    assert.equal(await page.locator('#tasksCancelAll').isDisabled(), true);
    assert.deepEqual(errors, []);
    console.log('PASS: per-batch/global cancel, one-click terminal cleanup, late-event suppression, empty state, split cancellation and preserved pending results/library');
  } finally { await browser.close(); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
