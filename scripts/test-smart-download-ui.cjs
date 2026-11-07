// Actual renderer DOM, mocked IPC and media only. No Electron, network or audio.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { mockBridge } = require('./test-ui.cjs');
const root = path.resolve(__dirname, '..');
async function run() {
  const { chromium } = require(process.env.CCMUSIC_PLAYWRIGHT || 'playwright');
  const browser = await chromium.launch({ executablePath: process.env.CCMUSIC_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } }), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => {
      const name = new URL(route.request().url()).pathname;
      if (!/^\/renderer\/[a-z.-]+\.(?:js|css|html)$/.test(name) && name !== '/assets/icon.png') return route.abort();
      const file = path.join(root, name); if (!fs.existsSync(file)) return route.abort();
      return route.fulfill({ body: fs.readFileSync(file), contentType: file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.css') ? 'text/css' : file.endsWith('.png') ? 'image/png' : 'text/javascript; charset=utf-8' });
    });
    await page.addInitScript(mockBridge); await page.goto('http://smart-download.test/renderer/index.html');
    await page.locator('#folders .folder').first().waitFor();
    const original = await page.evaluate(() => JSON.stringify([S.folders, S.queue]));
    // A long single-P video exposes smart splitting directly, even outside a playlist.
    await page.evaluate(() => { window.testHoldRecognition = true; void downloadSearchItem({ bvid: 'BV1uuHd6cEhy' }); });
    await page.locator('#downloadModeModal:not([hidden])').waitFor();
    assert.equal(await page.locator('#downloadModeSplit').isChecked(), true);
    await page.screenshot({ path: path.join(root, 'validation/ui-smart-download-mode.png') });
    await page.locator('#downloadModeForm button[type="submit"]').click();
    await page.locator('#reviewModal:not([hidden])').waitFor();
    assert.equal(await page.locator('#reviewConfirm').textContent(), '确认并识曲');
    assert.ok((await page.locator('#reviewHint').textContent()).includes('MP3'));
    assert.equal(await page.evaluate(() => testDownloadCalls.length), 0);
    await page.locator('#reviewConfirm').click();
    // Fake provider returns no names initially, forcing the real recognition path.
    // The base fixture already has names, so verify its immediate download result first.
    await page.locator('#downloadPickerModal:not([hidden])').waitFor();
    assert.equal(await page.locator('#downloadPickerList input:checked').count(), 3);
    await page.locator('#downloadPickerList input').nth(1).uncheck();
    await page.locator('#downloadPickerConfirm').click();
    await page.locator('#downloadLoginModal:not([hidden])').waitFor();
    assert.equal(await page.evaluate(() => [...splitTasks.values()][0].state), 'download-ready', 'login prompt must keep the selected results recoverable');
    await page.locator('#downloadLimited').click();
    await page.locator('#downloadsPanel:not([hidden])').waitFor();
    assert.deepEqual(await page.evaluate(() => testDownloadCalls.at(-1).items.map(it => [it.title, it.split, it.startSec, it.endSec])), [['第一首', true, 0, 240], ['第三首', true, 480, 1200]]);
    assert.equal(await page.evaluate(() => splitTasks.size), 0);
    assert.equal(await page.evaluate(() => JSON.stringify([S.folders, S.queue])), original);
    await page.locator('#downloadsClose').click();

    // The same single-P video can belong to a season: its download button must still offer splitting.
    await page.evaluate(() => {
      window.api.video = async bvid => ({ bvid, cid: 77, title: '七小时粤语歌曲合集', duration: 1200, desc: '视频简介',
        parts: [{ page: 1, cid: 77, duration: 1200 }], season: { title: '精选合集', episodes: [{ bvid, cid: 77, duration: 1200, title: '七小时粤语歌曲合集' }, { bvid: 'other', cid: 88, title: '其他视频', duration: 240 }] } });
      void downloadSearchItem({ bvid: 'BV1uuHd6cEhy' });
    });
    await page.locator('#partsModal:not([hidden])').waitFor();
    await page.locator('#pmDownload').click();
    await page.locator('#downloadModeModal:not([hidden])').waitFor();
    // Cancel and Escape never start a download or touch the library.
    const count = await page.evaluate(() => testDownloadCalls.length);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#downloadModeModal').isHidden(), true);
    assert.equal(await page.evaluate(() => testDownloadCalls.length), count);

    // An explicit whole download preserves the complete source; no forced splitting.
    await page.evaluate(() => { void requestDownloads([{ bvid: 'whole', cid: 12, page: 1, title: '整段', duration: 1200 }]); });
    await page.locator('#downloadModeWhole').check();
    await page.locator('#downloadModeForm button[type="submit"]').click();
    await page.locator('#downloadLoginModal:not([hidden])').waitFor(); await page.locator('#downloadLimited').click();
    await page.locator('#downloadsPanel:not([hidden])').waitFor();
    assert.equal(await page.evaluate(() => !!testDownloadCalls.at(-1).items[0].split), false);
    await page.locator('#downloadsClose').click();

    // Recognition updates stay on the private task; cancellation ignores late results.
    await page.evaluate(() => {
      window.api.splitAnalyze = async (_bv, _cid, _max, _desc, id, options) => {
        if (options.mode === 'split') return { duration: 1200, sessionId: 'mock-session', tracks: [{ start: 0, end: 90 }, { start: 90, end: 300 }, { start: 300, end: 1200 }] };
        return new Promise((resolve, reject) => {
          window.finishSmartRecognition = () => resolve({ tracks: options.tracks.map((t, i) => ({ ...t, checked: true, title: i < 2 ? '同一首歌' : '另一首歌', artist: '歌手', source: 'netease' })) });
          window.failSmartRecognition = () => reject(new Error('模拟识曲失败'));
          window.emitSmartRecognition = () => emitSplit({ requestId: id, stage: 'identify', index: 0, track: { ...options.tracks[0], title: '同一首歌', artist: '歌手', source: 'netease' }, done: 1, total: 3 });
        });
      };
      void runDownloadSplit({ bvid: 'recognize', cid: 1, page: 2, partsCount: 2, title: '长分P', duration: 1200 });
    });
    await page.locator('#reviewModal:not([hidden])').waitFor();
    await page.locator('#reviewConfirm').click();
    await page.waitForFunction(() => !!window.finishSmartRecognition);
    await page.evaluate(() => { emitSmartRecognition(); finishSmartRecognition(); });
    await page.locator('#downloadPickerModal:not([hidden])').waitFor();
    assert.equal(await page.locator('#downloadPickerList input').count(), 2, 'recognized fragments use the existing safe same-song merge policy');
    assert.deepEqual(await page.evaluate(() => downloadPicker.items.map(it => [it.page, it.cid, it.title, it.startSec, it.endSec])), [[2, 1, '同一首歌', 0, 300], [2, 1, '另一首歌', 300, 1200]]);
    await page.screenshot({ path: path.join(root, 'validation/ui-smart-download-songs.png') });
    await page.locator('#downloadPickerCancel').click();
    await page.reload(); await page.locator('#folders .folder').first().waitFor();
    assert.equal(await page.evaluate(() => [...splitTasks.values()][0]?.state), 'download-ready', 'ready download results survive a restart without playlist insertion');
    await page.locator('#taskBtn').click(); await page.locator('[data-download-results]').click();
    assert.equal(await page.locator('#downloadPickerList input').count(), 2);
    await page.locator('#downloadPickerCancel').click();
    await page.evaluate(() => { for (const task of [...splitTasks.values()]) dismissSplitTask(task); });

    await page.evaluate(() => {
      window.testHoldRecognition = true;
      const base = window.api.splitAnalyze;
      window.api.splitAnalyze = (...args) => args[5].mode === 'split' ? Promise.resolve({ duration: 1200, tracks: [{ start: 0, end: 600 }, { start: 600, end: 1200 }] }) : base(...args);
      void runDownloadSplit({ bvid: 'cancel', cid: 1, page: 1, partsCount: 1, title: '取消测试', duration: 1200 });
    });
    await page.locator('#reviewModal:not([hidden])').waitFor(); await page.locator('#reviewConfirm').click();
    await page.waitForFunction(() => testRecognitionRequests.length === 1);
    await page.evaluate(() => { const task = [...splitTasks.values()][0]; cancelSplitTask(task); testRecognitionRequests[0].finish(); });
    await page.waitForTimeout(50);
    assert.equal(await page.evaluate(() => splitTasks.size), 0);
    assert.equal(await page.locator('#downloadPickerModal').isHidden(), true);
    assert.equal(await page.evaluate(() => JSON.stringify([S.folders, S.queue])), original);
    // Partial recognition failures must retain all segment ranges and offer a fallback.
    await page.evaluate(() => {
      void runDownloadSplit({ bvid: 'partial', cid: 1, page: 1, partsCount: 1, title: '识曲失败测试', duration: 1200 });
    });
    await page.locator('#reviewModal:not([hidden])').waitFor(); await page.locator('#reviewConfirm').click();
    await page.waitForFunction(() => testRecognitionRequests.length === 2);
    await page.evaluate(() => { testRecognitionRequests[1].emit(0, { title: '已识别歌曲', artist: '已识别歌手', source: 'shazam' }); testRecognitionRequests[1].fail(); });
    await page.waitForFunction(() => [...splitTasks.values()][0]?.state === 'error');
    await page.locator('[data-download-results]').click();
    assert.deepEqual(await page.evaluate(() => downloadPicker.items.map(it => [it.title, it.artist, it.startSec, it.endSec])), [['已识别歌曲', '已识别歌手', 0, 600], ['曲目 2', '', 600, 1200]]);
    await page.locator('#downloadPickerCancel').click();
    await page.evaluate(() => { for (const task of [...splitTasks.values()]) dismissSplitTask(task); });
    await page.evaluate(() => {
      window.api.splitAnalyze = async () => ({ duration: 1200, tracks: [{ start: 0, end: 1200 }] });
      void runDownloadSplit({ bvid: 'no-cut', cid: 1, page: 1, partsCount: 1, title: '无间隔视频', duration: 1200 });
    });
    await page.locator('[data-download-whole]').waitFor();
    assert.equal(await page.locator('#reviewModal').isHidden(), true);
    await page.evaluate(() => { for (const task of [...splitTasks.values()]) dismissSplitTask(task); });
    await page.setViewportSize({ width: 900, height: 700 });
    await page.evaluate(() => { void requestDownloads([{ bvid: 'layout', cid: 1, title: '长视频', duration: 1200 }]); });
    assert.equal(await page.locator('#downloadModeModal .modal-box').evaluate(el => { const r = el.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight; }), true);
    await page.locator('#downloadModeCancel').click();
    assert.deepEqual(errors, []);
    console.log('PASS: smart download mode, standalone split review/recognition/selection, segment bounds and safe merge, login recovery, season and long P support, whole/cancel, persistence, unchanged playlists/queue and minimum window layout');
  } finally { await browser.close(); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
