// Actual queue events -> actual renderer, controlled source/encoder barriers.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { createDownloader } = require('../audio-downloads.cjs'), { mockBridge } = require('./test-ui.cjs');
const root = path.resolve(__dirname, '..');
const defer = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function run() {
  const { chromium } = require(process.env.CCMUSIC_PLAYWRIGHT || 'playwright');
  const browser = await chromium.launch({ executablePath: process.env.CCMUSIC_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
  const dir = fs.mkdtempSync(path.join(root, 'validation/progress-ui-')), owner = {};
  const gates = [defer(), defer(), defer()], started = [defer(), defer(), defer()], half = defer(), allReady = defer();
  let manager, delivery = Promise.resolve(), stream, ready = 0, encoded = 0, transferCount = 0, firstProgress;
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } }), errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.route('**/*', route => {
      const name = new URL(route.request().url()).pathname;
      if (!/^\/renderer\/[a-z.-]+\.(?:js|css|html)$/.test(name) && name !== '/assets/icon.png') return route.abort();
      const file = path.join(root, name); if (!fs.existsSync(file)) return route.abort();
      return route.fulfill({ body: fs.readFileSync(file), contentType: file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.css') ? 'text/css' : file.endsWith('.png') ? 'image/png' : 'text/javascript; charset=utf-8' });
    });
    await page.addInitScript(mockBridge); await page.goto('http://progress.test/renderer/index.html');
    await page.locator('#folders .folder').first().waitFor();
    await page.exposeFunction('pipelineDismiss', id => manager.dismiss(owner, id));
    await page.evaluate(() => { downloadTasks.clear(); window.api.downloadDismiss = window.pipelineDismiss; showDownloads(); });
    manager = createDownloader({ executable: '', tempRoot: dir, resolveItem: async i => i, headers: () => ({}),
      getPlayurl: async () => ({ tracks: [{ id: 30280, codecs: 'aac', kbps: 192, url: 'https://fixture.invalid/source' }] }),
      request: async () => { transferCount++; return new Response(new ReadableStream({ start(s) { stream = s; s.enqueue(Buffer.alloc(50)); } }), { headers: { 'content-length': '100' } }); },
      onUpdate: (_, task) => {
        delivery = delivery.then(() => page.evaluate(t => emitDownload(t), task));
        if (task.state === 'downloading' && task.pct === 50) half.resolve();
        if (task.state === 'waiting-conversion' && ++ready === 3) allReady.resolve();
      }, convert: async ({ output, onProgress }) => {
        const index = encoded++; onProgress(37); if (!index) firstProgress = onProgress;
        started[index].resolve(); await gates[index].promise;
        await fs.promises.writeFile(output, 'finished');
      } });
    const tasks = manager.add(owner, ['月光', '红颜', '诀别诗'].map((title, i) => ({ title, bvid: 'BV1CaPrz7EL6', cid: 36468035480, page: 1, split: true, startSec: i * 10, endSec: (i + 1) * 10 })), dir);
    await half.promise; await delivery;
    assert.equal(await page.getByText('批量下载 · 已保存 0/3 首', { exact: true }).isVisible(), true);
    assert.equal(await page.getByText('共用音源下载 50%', { exact: true }).isVisible(), true);
    assert.equal(await page.locator('.task-card progress').count(), 0, 'shared source progress is not presented under one song');
    stream.enqueue(Buffer.alloc(50)); stream.close(); await allReady.promise; await started[0].promise; await delivery;
    assert.equal(transferCount, 1);
    assert.equal(await page.getByRole('progressbar', { name: '整批歌曲保存进度' }).getAttribute('value'), '0');
    assert.equal(await page.getByText('音源就绪 3/3 · 转换中 1 · 等待转换 2', { exact: true }).isVisible(), true);
    assert.equal(await page.getByRole('progressbar', { name: '歌曲转换进度' }).getAttribute('value'), '37');
    firstProgress(100); await delivery;
    assert.equal(await page.getByRole('progressbar', { name: '整批歌曲保存进度' }).getAttribute('value'), '0', 'even encoder 100% cannot claim files have been saved');
    gates[0].resolve(); await started[1].promise; await delivery;
    assert.equal(await page.getByText('批量下载 · 已保存 1/3 首', { exact: true }).isVisible(), true);
    await page.screenshot({ path: path.join(root, 'validation/ui-download-batch-progress.png') });
    gates[1].resolve(); await started[2].promise; gates[2].resolve(); await manager.idle(); await delivery;
    assert.equal(await page.getByRole('progressbar', { name: '整批歌曲保存进度' }).getAttribute('value'), '3');
    assert.equal(await page.getByText('批量任务已结束 · 已保存 3/3 首', { exact: true }).isVisible(), true);
    await page.locator(`[data-dl-dismiss="${tasks[2].id}"]`).click();
    assert.equal(await page.getByText('批量任务已结束 · 已保存 3/3 首', { exact: true }).isVisible(), true, 'dismissing the last event record cannot roll back batch completion');
    assert.deepEqual(errors, []);
    console.log('PASS: real queue/renderer shared-source 50%, all-source-ready is not all-saved, conversion 100% is not saved, 1/3 -> 3/3 persisted files, and dismiss without summary regression');
  } finally {
    for (const gate of gates) gate.resolve();
    if (stream) { try { stream.close(); } catch (_) {} }
    if (manager) { await manager.shutdown(); await delivery; for (const task of manager.list(owner)) if (task.file) fs.unlinkSync(task.file); }
    // A dismissed completed record is intentionally absent from manager.list().
    for (const name of ['月光.mp3', '红颜.mp3', '诀别诗.mp3']) { const file = path.join(dir, name); if (fs.existsSync(file)) fs.unlinkSync(file); }
    await browser.close(); fs.rmdirSync(dir);
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
