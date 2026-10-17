// Real renderer DOM with controlled recognition replies; no Electron or playback.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { mockBridge } = require('./test-ui.cjs');
const root = path.resolve(__dirname, '..');
async function run() {
  const { chromium } = require(process.env.CCMUSIC_PLAYWRIGHT || 'playwright');
  const browser = await chromium.launch({ executablePath: process.env.CCMUSIC_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true, args: ['--disable-background-networking'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 }, serviceWorkers: 'block' });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    const allowed = ['/renderer/index.html', '/renderer/style.css', '/renderer/app.js', '/renderer/downloads.js', '/renderer/workflows.js', '/renderer/library-model.js', '/renderer/music-search-policy.js', '/assets/icon.png'];
    await page.route('**/*', route => {
      const name = new URL(route.request().url()).pathname;
      if (!allowed.includes(name)) return route.abort();
      return route.fulfill({ body: fs.readFileSync(path.join(root, name)), contentType: name.endsWith('.html') ? 'text/html; charset=utf-8' : name.endsWith('.css') ? 'text/css; charset=utf-8' : name.endsWith('.png') ? 'image/png' : 'text/javascript; charset=utf-8' });
    });
    await page.addInitScript(mockBridge);
    await page.goto('http://ccmusic.test/renderer/index.html');
    await page.locator('#folders .folder').first().waitFor();
    await page.evaluate(async () => {
      window.testHoldRecognition = true;
      const f = S.folders[0]; S.active = f.id; showView('library');
      f.items = [{ bvid: 'BV12M4m1y7hf', cid: 11, page: 1, title: '渐进识曲合集', duration: 1200, vtitle: '渐进识曲合集' }];
      loadQueue(f.items, 0); audio.currentTime = 120;
      await runSplitTask(f, f.items[0], '');
      const task = [...splitTasks.values()][0];
      task.result.tracks = [0, 240, 480, 720].map((start, i, all) => ({ start, end: all[i + 1] || 1200, title: '', source: 'manual' }));
      task.result.named = 0; renderTasks();
    });
    assert.equal(await page.evaluate(() => window.testRecognitionRequests.length), 0, 'no recognition before confirmation');
    assert.equal(await page.evaluate(() => folder().items.length), 1);
    await page.locator('#reviewModal:not([hidden])').waitFor();
    assert.equal(await page.locator('.review-name').count(), 0);
    assert.equal(await page.locator('[data-cut]').count(), 0);
    assert.ok((await page.locator('#reviewRows').textContent()).includes('曲目 1（待识别）'));
    await page.locator('#reviewAdjust').click();
    await page.locator('.review-end').first().fill('3:30');
    await page.locator('.review-name').nth(2).fill('用户填写的第三首');
    await page.locator('#reviewAdjust').click();
    assert.equal(await page.locator('.review-name').count(), 0);
    await page.evaluate(() => { S.active = 'b'; showView('home'); });
    await page.locator('#reviewConfirm').click();
    await page.waitForFunction(() => window.testRecognitionRequests.length === 1);
    assert.equal(await page.locator('#reviewModal').isHidden(), true);
    assert.equal(await page.evaluate(() => S.view), 'library');
    assert.equal(await page.evaluate(() => S.active), 'a', 'joining opens the task destination playlist');
    assert.deepEqual(await page.evaluate(() => folder().items.map(i => i.title)), ['曲目 1', '曲目 2', '用户填写的第三首', '曲目 4']);
    assert.deepEqual(await page.evaluate(() => window.testRecognitionRequests[0].options.tracks.map(t => [t.start, t.end])), [[0, 210], [210, 480], [480, 720], [720, 1200]]);
    assert.equal(await page.evaluate(() => window.testRecognitionRequests[0].options.tracks[0].title), '', 'manual cut/merge without a name must still be recognized');
    assert.equal(await page.evaluate(() => audio.currentTime), 120);
    await page.evaluate(() => window.testRecognitionRequests[0].emit(0, { title: '第一首已识别', artist: '歌手甲', source: 'netease' }));
    assert.equal(await page.evaluate(() => folder().items[0].title), '第一首已识别');
    assert.equal(await page.locator('#bTitle').textContent(), '第一首已识别');
    assert.equal(await page.locator('#bUp').textContent(), '歌手甲');
    assert.equal(await page.evaluate(() => S.queue[0].title), '第一首已识别');
    assert.equal(await page.evaluate(() => [...splitTasks.values()][0].state), 'running', 'first song is visible while the batch is still running');
    assert.equal(await page.evaluate(() => audio.currentTime), 120, 'metadata update must not seek or restart playback');
    await page.screenshot({ path: path.join(root, 'validation/ui-progressive-recognition.png') });
    // A manual edit after the request starts must survive the late result.
    await page.evaluate(() => editSongInfo(folder().items[1]));
    await page.locator('#songInfoTitle').fill('现场翻唱名'); await page.locator('#songInfoArtist').fill('现场歌手');
    await page.locator('#songInfoForm [type="submit"]').click();
    await page.evaluate(() => window.testRecognitionRequests[0].emit(1, { title: '接口原曲名', artist: '原唱', source: 'netease' }));
    assert.equal(await page.evaluate(() => folder().items[1].title), '现场翻唱名');
    assert.equal(await page.evaluate(() => S.queue[1].artist), '现场歌手');
    // Removing a library row must not be undone by the background task.
    await page.evaluate(() => { folder().items.splice(2, 1); save(); renderList(); window.testRecognitionRequests[0].emit(2, { title: '迟到的第三首', source: 'shazam' }); });
    assert.equal(await page.evaluate(() => folder().items.length), 3);
    await page.locator('#taskBtn').click();
    await page.locator('[data-cancel]').click();
    await page.evaluate(() => window.testRecognitionRequests[0].emit(0, { title: '取消后的迟到结果', source: 'netease' }));
    assert.equal(await page.evaluate(() => folder().items[0].title), '第一首已识别');
    assert.equal(await page.evaluate(() => folder().items.length), 3);
    await page.locator('[data-retry]').click();
    await page.waitForFunction(() => window.testRecognitionRequests.length === 2);
    assert.equal(await page.evaluate(() => window.testRecognitionRequests[1].options.tracks[0].title), '第一首已识别');
    assert.equal(await page.evaluate(() => window.testRecognitionRequests[1].options.tracks[1].source), 'manual');
    assert.equal(await page.evaluate(() => window.testRecognitionRequests[1].options.tracks[2].checked), true, 'removed row is skipped');
    await page.evaluate(() => { window.testRecognitionRequests[0].finish(); window.testRecognitionRequests[1].fail(); });
    await page.waitForFunction(() => [...splitTasks.values()][0].state === 'error');
    assert.equal(await page.evaluate(() => folder().items.at(-1).title), '曲目 4');
    await page.reload(); await page.locator('#folders .folder').first().waitFor();
    await page.locator('#folders [data-id="a"]').click(); await page.locator('#taskBtn').click();
    assert.equal(await page.evaluate(() => window.testRecognitionRequests.length), 0, 'restart does not automatically make requests');
    assert.deepEqual(await page.evaluate(() => folder().items.map(i => i.title)), ['第一首已识别', '现场翻唱名', '曲目 4']);
    await page.evaluate(() => { window.testHoldRecognition = true; });
    await page.locator('[data-retry]').click(); await page.waitForFunction(() => window.testRecognitionRequests.length === 1);
    assert.equal(await page.evaluate(() => window.testRecognitionRequests[0].options.tracks[1].title), '现场翻唱名');
    await page.evaluate(() => { window.testRecognitionRequests[0].emit(3, { title: '第四首已识别', artist: '歌手乙', source: 'shazam' }); window.testRecognitionRequests[0].finish(); });
    await page.waitForFunction(() => [...splitTasks.values()][0].state === 'done');
    assert.ok((await page.locator('.completion-notice').textContent()).includes('识曲完成'));
    assert.equal(await page.evaluate(() => folder().items.length), 3, 'resume never duplicates confirmed segments');
    assert.equal((await page.locator('#taskList').textContent()).includes('移除任务'), false);
    assert.equal(await page.locator('#taskList .task-dismiss').count(), 1);
    await page.screenshot({ path: path.join(root, 'validation/ui-task-completed.png') });
    await page.evaluate(() => {
      const task = [...splitTasks.values()][0]; window.completedTaskId = task.id;
      window.beforeAutoDismiss = JSON.stringify({ folders: S.folders, queue: S.queue });
      splitTasks.set('pending-dismiss-test', { ...task, id: 'pending-dismiss-test', state: 'ready', batch: undefined });
      splitTasks.set('stopped-dismiss-test', { ...task, id: 'stopped-dismiss-test', state: 'cancelled', batch: undefined });
      renderTasks();
    });
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.splitTaskDrafts).some(t => t.state === 'done')), false, 'completed tasks are not restored after restart');
    await page.waitForFunction(() => !splitTasks.has(window.completedTaskId), undefined, { timeout: 7000 });
    assert.deepEqual(await page.evaluate(() => [...splitTasks.keys()]), ['pending-dismiss-test', 'stopped-dismiss-test'], 'only completed tasks expire');
    assert.equal(await page.locator('#tasksPanel').isVisible(), true, 'unfinished cards keep the popover open');
    assert.equal(await page.locator('.completion-notice').count(), 0, 'completed notification expires with the task');
    assert.equal(await page.evaluate(() => JSON.stringify({ folders: S.folders, queue: S.queue }) === window.beforeAutoDismiss), true, 'automatic dismissal preserves library and queue');
    await page.locator('[data-dismiss="stopped-dismiss-test"]').click();
    await page.locator('[data-dismiss="pending-dismiss-test"]').click();
    assert.equal(await page.evaluate(() => splitTasks.size), 0);
    assert.equal(await page.evaluate(() => JSON.stringify({ folders: S.folders, queue: S.queue }) === window.beforeAutoDismiss), true, 'corner close only removes task feedback');
    await page.evaluate(() => {
      const f = folder(); const task = { id: 'last-completed-test', state: 'done', folder: f, item: f.items[0], result: { tracks: [] } };
      splitTasks.set(task.id, task); $('#tasksPanel').hidden = false; renderTasks();
    });
    await page.waitForFunction(() => !splitTasks.size, undefined, { timeout: 7000 });
    assert.equal(await page.locator('#tasksPanel').isHidden(), true, 'the last completed task also closes the empty popover');
    // A fresh confirmed batch is immediately undoable while recognition is pending.
    await page.evaluate(async () => {
      for (const task of splitTasks.values()) stopBatchRecognition(task.batch);
      const f = folder(); f.items = [{ bvid: 'BV15C41187cx', cid: 12, page: 1, title: '撤销测试', duration: 1200 }];
      loadQueue(f.items, 0); audio.currentTime = 300;
      await runSplitTask(f, f.items[0], '');
      const task = [...splitTasks.values()][0]; task.result.tracks.forEach(t => { t.title = ''; }); openSplitReview(task);
    });
    await page.locator('#reviewConfirm').click(); await page.waitForFunction(() => window.testRecognitionRequests.length === 2);
    await page.locator('#undoButton').click();
    await page.evaluate(() => { window.testRecognitionRequests[1].emit(0, { title: '不应复活', source: 'netease' }); window.testRecognitionRequests[1].finish(); });
    assert.deepEqual(await page.evaluate(() => folder().items.map(i => [i.title, !!i.split])), [['撤销测试', false]]);
    assert.equal(await page.evaluate(() => S.queue.length), 1);
    assert.equal(await page.evaluate(() => splitTasks.size), 0);
    assert.equal(await page.evaluate(() => audio.currentTime), 300);
    // Long collections use a compact read-only preview, with editing opt-in.
    await page.evaluate(() => {
      const item = { ...folder().items[0], title: 'Playlist · 如果你也喜欢 The Weeknd｜放松、专注和通勤都能听的欧美歌曲精选合集'.repeat(3) };
      const tracks = Array.from({ length: 12 }, (_, i) => ({ start: i * 200, end: (i + 1) * 200, title: '' }));
      folder().items.push(item);
      const task = { id: 'layout-preview', state: 'ready', folder: folder(), item, result: { tracks, duration: 2400 } };
      splitTasks.set(task.id, task); openSplitReview(task);
    });
    assert.equal(await page.locator('#reviewHeading').textContent(), '已分成 12 首');
    assert.equal(await page.locator('#reviewConfirm').textContent(), '加入歌单');
    assert.equal(await page.locator('#reviewRows input').count(), 0);
    assert.equal(await page.locator('#reviewRows [data-merge]').count(), 0);
    assert.equal(await page.locator('#reviewAdjust').getAttribute('aria-expanded'), 'false');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'reviewConfirm', 'focus the main action instead of an empty name field');
    const measure = () => page.evaluate(() => {
      const box = document.querySelector('.review-box').getBoundingClientRect();
      const title = document.querySelector('#reviewTitle').getBoundingClientRect();
      const rows = document.querySelector('#reviewRows');
      const hint = document.querySelector('#reviewHint').getBoundingClientRect();
      return { inside: box.top >= 0 && box.bottom <= innerHeight && box.left >= 0 && box.right <= innerWidth,
        titleVisible: title.height >= 20 && title.bottom <= hint.top, width: box.width,
        listScrolls: rows.scrollHeight > rows.clientHeight, noHorizontalScroll: rows.scrollWidth <= rows.clientWidth };
    });
    assert.deepEqual(await measure(), { inside: true, titleVisible: true, width: 600, listScrolls: true, noHorizontalScroll: true });
    await page.screenshot({ path: path.join(root, 'validation/ui-split-preview-simple.png') });
    await page.setViewportSize({ width: 900, height: 620 });
    assert.equal((await measure()).inside, true); assert.equal((await measure()).titleVisible, true);
    await page.screenshot({ path: path.join(root, 'validation/ui-split-preview-small.png') });
    await page.locator('#reviewAdjust').click();
    assert.equal(await page.locator('.review-end').count(), 12);
    await page.locator('.review-end').first().fill('0:00');
    await page.locator('#reviewAdjust').click();
    assert.equal(await page.locator('#reviewWarning').isVisible(), true);
    assert.equal(await page.locator('#reviewAdjust').getAttribute('aria-expanded'), 'true', 'invalid edits cannot be hidden and silently applied');
    await page.locator('.review-end').first().fill('3:20');
    await page.locator('.review-name').first().fill('自行命名');
    await page.locator('#reviewAdjust').click();
    assert.equal(await page.locator('#reviewWarning').isHidden(), true);
    assert.equal(await page.locator('.review-track-title').first().textContent(), '自行命名');
    assert.equal(await page.locator('#reviewRows input').count(), 0);
    await page.locator('#reviewClose').click();
    assert.deepEqual(errors, []);
    console.log('PASS: compact read-only preview, long title/12 tracks/900px layout, opt-in editing and validation; immediate insertion, progressive metadata, manual edits, cancellation/resume/restart and undo; actual DOM, mocked IPC/media');
  } finally { await browser.close(); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
