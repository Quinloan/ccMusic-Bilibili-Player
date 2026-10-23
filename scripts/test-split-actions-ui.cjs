// Actual menus, metadata retries, progressive merging and transactional re-splitting.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { mockBridge } = require('./test-ui.cjs');
const root = path.resolve(__dirname, '..');
async function run() {
  const historyFile = path.join(root, 'validation', `split-ui-history-${process.pid}.json`);
  const historyCache = require('../analysis-cache.cjs'), { createHash } = require('node:crypto');
  for (const [start, end] of [[2667, 2735.4], [2735.4, 2800.6], [2800.6, 2930.1]]) {
    const key = createHash('sha256').update(`progressive:BV1CaPrz7EL6:36468035480:false:${start}:${end}`).digest('hex');
    historyCache.saveAnalysis(historyFile, key, { tracks: [{ start, end, title: '再见爱人', artist: '胡彦斌', neteaseId: '2655113815', source: 'netease' }] });
  }
  const { chromium } = require(process.env.CCMUSIC_PLAYWRIGHT || 'playwright');
  const browser = await chromium.launch({ executablePath: process.env.CCMUSIC_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 }, serviceWorkers: 'block' });
    await page.exposeFunction('lookupFragmentHistory', items => historyCache.getFragmentHistories(historyFile, items));
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.route('**/*', route => {
      const pathname = new URL(route.request().url()).pathname;
      if (!/^\/renderer\/[a-z.-]+\.(?:html|css|js)$/.test(pathname) && pathname !== '/assets/icon.png') return route.abort();
      const file = path.join(root, pathname); if (!fs.existsSync(file)) return route.abort();
      return route.fulfill({ body: fs.readFileSync(file), contentType: file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.css') ? 'text/css' : file.endsWith('.png') ? 'image/png' : 'text/javascript; charset=utf-8' });
    });
    await page.addInitScript(mockBridge); await page.goto('http://ccmusic.test/renderer/index.html');
    await page.locator('#folders .folder').first().waitFor();
    await page.evaluate(() => {
      S.active = 'a'; showView('library');
      const base = { bvid: 'BV15C41187cx', cid: 42, page: 1, split: true, splitBatch: 'fragments', vtitle: 'R&B歌单', originalDuration: 500, cover: '/assets/icon.png' };
      window.parts = [{ ...base, startSec: 0, endSec: 89, duration: 89, title: '曲目 1' }, { ...base, startSec: 89, endSec: 217, duration: 128, title: '曲目 2' },
        { ...base, startSec: 217, endSec: 500, duration: 283, title: '曲目 3' }];
      folder().items = parts; loadQueue(parts, 1); playback.current = { item: S.queue[1], idx: 1 }; audio.currentTime = 140;
      window.task = { id: 'progressive-test', folder: folder(), item: wholeSourceItem(parts[0]), batch: 'fragments', state: 'running',
        result: { duration: 500, tracks: parts.map(item => ({ start: item.startSec, end: item.endSec })) } };
      splitTasks.set(task.id, task); renderList(); renderQueue();
    });
    await page.locator('#list .group').click({ button: 'right' });
    assert.equal(await page.getByText('解析整组歌曲信息', { exact: true }).isVisible(), true);
    assert.equal(await page.getByText('重新智能分歌…', { exact: true }).isVisible(), true);
    await page.mouse.click(330, 110);
    await page.locator('#list .row.child').first().click({ button: 'right' });
    assert.equal(await page.getByText('解析歌曲信息', { exact: true }).isVisible(), true);
    assert.equal(await page.getByText('重新智能分歌…', { exact: true }).isVisible(), true);
    await page.mouse.click(330, 110);
    await page.evaluate(() => {
      window.hit = { title: 'Mr. "Broken Heart"', artist: '松下優也', source: 'shazam' };
      applyRecognizedTrack(task, 0, { start: 0, end: 89, ...hit });
      applyRecognizedTrack(task, 1, { start: 89, end: 217, ...hit });
    });
    assert.deepEqual(await page.evaluate(() => folder().items.map(i => [i.startSec, i.endSec])), [[0, 217], [217, 500]]);
    assert.equal(await page.evaluate(() => S.queue.length), 2); assert.equal(await page.evaluate(() => S.qcur), 0);
    assert.equal(await page.evaluate(() => curSplitEnd), 217); assert.equal(await page.evaluate(() => audio.currentTime), 140);
    await page.locator('#undoButton').click();
    assert.equal(await page.evaluate(() => folder().items.length), 3); assert.equal(await page.evaluate(() => S.qcur), 1);
    await page.evaluate(() => { applyRecognizedTrack(task, 1, { start: 89, end: 217, ...hit }); });
    assert.equal(await page.evaluate(() => folder().items.length), 3, 'undo locks the restored boundary against late results');
    // Known split names use title+performer metadata, not a full audio download.
    await page.evaluate(() => {
      stopBatchRecognition('fragments'); window.titleLookups = [];
      window.api.resolveSongTitle = async input => { titleLookups.push(input); return { name: 'Mr. "Broken Heart"', artist: '松下優也', matched: true }; };
    });
    await page.locator('#list .row.child').first().click({ button: 'right' }); await page.getByText('解析歌曲信息', { exact: true }).click();
    await page.waitForFunction(() => titleLookups.length === 1 && metadataParseJobs.size === 0);
    assert.equal(await page.evaluate(() => titleLookups[0].artist), '松下優也');
    assert.equal(await page.evaluate(() => folder().items[0].identifySource), 'shazam');
    // Unknown segments retry only the selected audio interval; other/gone ranges are checked skips.
    await page.evaluate(() => { window.testHoldRecognition = true; });
    await page.locator('#list .row.child').nth(2).click({ button: 'right' }); await page.getByText('解析歌曲信息', { exact: true }).click();
    await page.waitForFunction(() => testRecognitionRequests.length === 1);
    assert.deepEqual(await page.evaluate(() => testRecognitionRequests[0].options.tracks.map(t => !!t.checked)), [true, true, false]);
    assert.equal(await page.evaluate(() => testRecognitionRequests[0].options.tracks[2].refresh), true);
    await page.evaluate(() => { testRecognitionRequests[0].emit(2, { title: 'Alive', artist: 'Blue', source: 'netease' }); testRecognitionRequests[0].finish(); });
    await page.waitForFunction(() => folder().items[2].title === 'Alive');
    // A failed new analysis leaves every old segment untouched.
    await page.evaluate(() => { window.originalSegments = folder().items.slice(); window.api.splitAnalyze = async () => { throw Error('模拟网络失败'); }; });
    await page.locator('#list .group').click({ button: 'right' }); await page.getByText('重新智能分歌…', { exact: true }).click();
    await page.waitForFunction(() => [...splitTasks.values()].some(t => t.previous && t.state === 'error'));
    assert.equal(await page.evaluate(() => folder().items.every((item, i) => item === originalSegments[i])), true);
    // Successful analysis waits for confirmation, then supports undo back to the old songs.
    await page.evaluate(() => {
      window.api.splitAnalyze = async (...args) => args[5]?.mode === 'recognize' ? { tracks: args[5].tracks.map(t => ({ ...t, checked: true })) } :
        { duration: 500, tracks: [{ start: 0, end: 250 }, { start: 250, end: 500 }], named: 0 };
      for (const [id, t] of splitTasks) if (t.previous) splitTasks.delete(id);
    });
    await page.locator('#list .group').click({ button: 'right' }); await page.getByText('重新智能分歌…', { exact: true }).click();
    await page.locator('#reviewModal:not([hidden])').waitFor();
    assert.equal(await page.evaluate(() => folder().items.every((item, i) => item === originalSegments[i])), true);
    await page.locator('#reviewConfirm').click();
    await page.waitForFunction(() => folder().items.length === 2);
    assert.equal(await page.evaluate(() => S.queue.length), 2); assert.equal(await page.evaluate(() => audio.currentTime), 140);
    await page.locator('#undoButton').click();
    assert.deepEqual(await page.evaluate(() => folder().items.map(i => [i.startSec, i.endSec])), [[0, 89], [89, 217], [217, 500]]);
    assert.equal(await page.evaluate(() => S.queue.length), 3); assert.equal(await page.evaluate(() => audio.currentTime), 140);
    // Several fragments merged in one pass must all be recoverable with one Undo.
    await page.evaluate(() => {
      for (const batch of new Set(folder().items.map(item => item.splitBatch))) stopBatchRecognition(batch);
      const base = { ...folder().items[0], splitBatch: 'chain', title: hit.title, artist: hit.artist, identifySource: 'shazam', boundaryLocked: false };
      folder().items = [[0, 89], [89, 189], [189, 259]].map(([startSec, endSec]) => ({ ...base, startSec, endSec, duration: endSec - startSec }));
      loadQueue(folder().items, 2); audio.currentTime = 220; playback.current = null; playback.requested = { item: S.queue[2] };
      mergeAdjacentIdentified('chain');
    });
    assert.equal(await page.evaluate(() => folder().items.length), 2, 'unrelated completed fragments may merge while a later fragment is loading');
    await page.evaluate(() => { playback.current = { item: S.queue[S.qcur], idx: S.qcur }; mergeAdjacentIdentified('chain'); });
    assert.equal(await page.evaluate(() => folder().items.length), 1); assert.equal(await page.evaluate(() => curSplitEnd), 259);
    await page.locator('#undoButton').click();
    assert.equal(await page.evaluate(() => folder().items.length), 2, 'latest undo restores only its own merge');
    await page.evaluate(() => {
      const base = { ...folder().items[0], boundaryLocked: false };
      folder().items = [[0, 89], [89, 189], [189, 259]].map(([startSec, endSec]) => ({ ...base, startSec, endSec, duration: endSec - startSec }));
      loadQueue(folder().items, 2); playback.current = { item: S.queue[2], idx: 2 }; mergeAdjacentIdentified('chain');
    });
    assert.equal(await page.evaluate(() => folder().items.length), 1);
    await page.locator('#undoButton').click();
    assert.equal(await page.evaluate(() => folder().items.length), 3, 'one pass undo restores a whole three-fragment chain');
    assert.equal(await page.evaluate(() => S.qcur), 2); assert.equal(await page.evaluate(() => audio.currentTime), 220);
    await page.evaluate(() => {
      [...folder().items, ...S.queue].forEach(item => { item.boundaryLocked = false; });
      S.folders[1].items = [{ ...folder().items[1], identifySource: 'manual', title: '保留翻唱名' }];
      mergeAdjacentIdentified('chain');
    });
    assert.equal(await page.evaluate(() => folder().items.length), 3, 'a manually edited copy protects the shared recording boundary');
    await page.evaluate(() => { S.folders[1].items = []; mergeAdjacentIdentified('chain'); folder().items = []; });
    await page.locator('#undoButton').click();
    assert.equal(await page.evaluate(() => folder().items.length), 0, 'undo never resurrects a merged song removed afterwards');
    await page.evaluate(async () => {
      const base = { ...parts[0], title: hit.title, artist: hit.artist, identifySource: 'shazam', splitBatch: 'existing', boundaryLocked: false };
      folder().items = [{ ...base, startSec: 0, endSec: 89 }, { ...base, startSec: 89, endSec: 217 }];
      loadQueue(folder().items, 0); playback.current = { item: S.queue[0], idx: 0 };
      const old = folder().items[0]; await parseSongMetadata([old]);
      await parseSongMetadata([{ ...old, bvid: 'BV12M4m1y7hf', splitBatch: 'removed' }]);
    });
    assert.equal(await page.evaluate(() => folder().items.length), 1, 'parsing an old duplicate merges immediately and resolves the new live item');
    assert.equal(await page.evaluate(() => metadataParseJobs.size), 0, 'stale selections finish cleanly without a pending progress job');
    // Actual reported three-way cut: the first merge becomes 133.6 seconds,
    // and must still accept the final 129.5-second fragment on a later event.
    await page.evaluate(() => {
      stopBatchRecognition('existing');
      const base = { ...parts[0], bvid: 'BV1CaPrz7EL6', cid: 36468035480, splitBatch: 'reported', originalDuration: 3167,
        boundaryLocked: false, splitFragments: undefined, identifySource: undefined, title: '曲目 1' };
      window.reportedParts = [[2667, 2735.4], [2735.4, 2800.6], [2800.6, 2930.1]].map(([startSec, endSec]) => ({ ...base, startSec, endSec, duration: endSec - startSec }));
      folder().items = reportedParts; loadQueue(reportedParts, 2); playback.current = { item: S.queue[2], idx: 2 }; audio.currentTime = 2850;
      window.reportedTask = { batch: 'reported', item: wholeSourceItem(base), folder: folder(), result: { duration: 3167, tracks: reportedParts.map(i => ({ start: i.startSec, end: i.endSec })) } };
      window.reportedHit = { title: '再见爱人', artist: '胡彦斌', neteaseId: '2655113815', source: 'netease' };
      applyRecognizedTrack(reportedTask, 0, { ...reportedHit, start: 2667, end: 2735.4 });
      applyRecognizedTrack(reportedTask, 1, { ...reportedHit, start: 2735.4, end: 2800.6 });
    });
    assert.equal(await page.evaluate(() => folder().items.length), 2);
    await page.evaluate(() => applyRecognizedTrack(reportedTask, 2, { ...reportedHit, start: 2800.6, end: 2930.1 }));
    assert.deepEqual(await page.evaluate(() => folder().items.map(i => [i.startSec, i.endSec])), [[2667, 2930.1]]);
    assert.equal(await page.evaluate(() => folder().items[0].splitFragments.length), 3);
    assert.equal(await page.evaluate(() => JSON.parse(JSON.stringify(folder().items))[0].splitFragments.length), 3, 'source cuts survive serialization');
    assert.equal(await page.evaluate(() => S.queue.length), 1); assert.equal(await page.evaluate(() => audio.currentTime), 2850);
    await page.locator('#undoButton').click();
    assert.equal(await page.evaluate(() => folder().items.length), 2);
    // An old saved 133.6 + 129.5 pair only repairs with complete real cache proof.
    await page.evaluate(async () => {
      const base = { ...reportedParts[0], ...reportedHit, identifySource: 'netease', boundaryLocked: false, splitFragments: undefined };
      folder().items = [[2667, 2800.6], [2800.6, 2930.1]].map(([startSec, endSec]) => ({ ...base, startSec, endSec, duration: endSec - startSec }));
      loadQueue(folder().items, 1); playback.current = { item: S.queue[1], idx: 1 };
      window.api.resolveSongTitle = async () => ({ matched: false });
      window.api.splitHistory = async items => items.map(() => null);
      await parseSongMetadata(folder().items.slice());
    });
    assert.equal(await page.evaluate(() => folder().items.length), 2, 'two full-length songs with no original-cut proof stay separate');
    await page.evaluate(async () => {
      window.api.splitHistory = window.lookupFragmentHistory;
      await parseSongMetadata(folder().items.slice());
    });
    assert.deepEqual(await page.evaluate(() => folder().items.map(i => [i.startSec, i.endSec])), [[2667, 2930.1]]);
    assert.equal(await page.evaluate(() => folder().items[0].splitFragments.length), 3);
    assert.equal(await page.evaluate(() => S.queue.length), 1);
    assert.deepEqual(errors, []);
    console.log('PASS: split group/child menus; live same-recording fragment merge + queue/playhead; undo/late-result boundary lock; known-title metadata vs selected unknown recognition; transactional re-split failure/confirmation/undo; no Electron/audio/network');
  } finally { await browser.close(); if (fs.existsSync(historyFile)) fs.unlinkSync(historyFile); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
