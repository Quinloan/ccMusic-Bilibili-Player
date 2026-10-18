// Headless Edge against actual renderer files and mocked IPC. Never starts Electron or plays media.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const runtime = process.env.CCMUSIC_PLAYWRIGHT || 'playwright';
function mockBridge() {
  localStorage.autoCheck = '0';
  window.testLibrary = JSON.parse(localStorage.mockLibrary || 'null') || { folders: [{ id: 'a', name: '我的歌单', items: [] }, { id: 'b', name: '欧美收藏', items: [] }], active: 'a' };
  window.testSplitDelay = 10; window.testSplitCalls = 0;
  let progress; const cancelled = new Set(); window.testRecognitionRequests = [];
  window.testCoverRequests = [];
  window.testTitleRequests = [];
  let downloadProgress; window.testDownloadCalls = []; window.testLogged = false;
  const title = '〖The Weeknd合集|Hi-Res〗“如果你也喜欢The Weeknd”';
  const video = { bvid: 'BV1uuHd6cEhy', cid: 1, title, up: '界面测试', cover: '/assets/icon.png', duration: 1200, parts: [{ cid: 1, page: 1, part: title, duration: 1200 }] };
  Object.defineProperties(HTMLMediaElement.prototype, {
    src: { get() { return this._src || ''; }, set(value) { this._src = value; } },
    currentTime: { get() { return this._time || 0; }, set(value) { this._time = value; } },
    readyState: { get: () => window.testAudioReadyState ?? 1 }, duration: { get: () => 1200 }, paused: { get() { return !this._playing; } },
  });
  HTMLMediaElement.prototype.play = async function () { this._playing = true; this.dispatchEvent(new Event('loadedmetadata')); this.dispatchEvent(new Event('play')); };
  HTMLMediaElement.prototype.pause = function () { this._playing = false; this.dispatchEvent(new Event('pause')); };
  HTMLMediaElement.prototype.load = function () {};
  window.api = new Proxy({
    resolveSongTitle: async input => {
      if (!window.testHoldTitles) { window.testTitleRequests.push({ input }); return null; }
      return new Promise(resolve => window.testTitleRequests.push({ input, resolve }));
    },
    songCover: async match => {
      if (!window.testHoldCovers) { window.testCoverRequests.push({ match }); return ''; }
      return new Promise(resolve => window.testCoverRequests.push({ match, resolve }));
    },
    onDownloadProgress: callback => { downloadProgress = callback; window.emitDownload = callback; },
    downloadList: async () => [],
    downloadStart: async (items, limited) => {
      window.testDownloadCalls.push({ items, limited });
      if (!window.testLogged && !limited) return { needsLogin: true };
      const tasks = items.map((item, i) => ({ id: 'download-' + window.testDownloadCalls.length + '-' + i, title: item.title, state: 'queued', pct: 0 }));
      for (const task of tasks) downloadProgress?.(task);
      return { tasks };
    },
    downloadCancel: async id => { downloadProgress?.({ id, title: '已取消的歌曲', state: 'cancelled' }); return true; },
    downloadDismiss: async () => true,
    downloadReveal: async id => { window.testRevealed = id; return true; },
    loginQrcode: async () => ({ key: 'mock', dataUrl: '' }), loginPoll: async () => { window.testLogged = true; return { status: 'done' }; },
    getLibrary: async () => structuredClone(window.testLibrary), setLibrary: async value => { window.testLibrary = structuredClone(value); localStorage.mockLibrary = JSON.stringify(value); },
    getVersion: async () => '1.5.0-test', loginState: async () => ({ logged: false }), diagEnv: async () => ({ version: '1.5.0', dataDir: '模拟数据', repo: '' }),
    search: async keyword => ['theweekend', '音乐'].includes(keyword) ? { list: [
      { bvid: 'dance', title: '【爵士入门】《The Weekend》', author: 'KWB咖舞吧', duration: '3:18', pic: video.cover },
      { bvid: 'clip', title: 'The weekend BIBI 编舞', duration: '0:45', pic: video.cover },
      { bvid: 'wrong-song', title: 'Coldplay - Hymn For The Weekend', duration: '4:20', pic: video.cover },
      { bvid: 'single', title: 'The Weeknd - Die For You', duration: '4:21', pic: video.cover },
      { bvid: 'playlist', title: 'The Weeknd 合集', duration: '50:29', pic: video.cover },
    ], corrected: true, effectiveQuery: 'The Weeknd', hasMore: false } : { list: [{ bvid: video.bvid, title, author: video.up, pic: video.cover, duration: 1200 }, { bvid: 'BV1TBEK6jEps', title: '短视频测试', author: '界面测试', pic: video.cover, duration: 220 }], hasMore: false, supplemented: true },
    video: async id => ({ ...structuredClone(video), bvid: id, ...(id === 'BV1HE411E7Gx' ? { duration: 50, parts: [{ cid: 1, page: 1, part: '指定短视频', duration: 50 }] } : {}) }),
    onSplitProgress: callback => { progress = callback; window.emitSplit = callback; },
    splitAnalyze: async (_bv, _cid, _max, _desc, id, options = {}) => {
      if (options.mode === 'recognize') {
        if (!window.testHoldRecognition) return { tracks: options.tracks.map(t => ({ ...t, checked: true })), warnings: [] };
        return new Promise((resolve, reject) => window.testRecognitionRequests.push({ id, options,
          emit: (index, hit = {}) => { Object.assign(options.tracks[index], hit, { checked: true }); progress?.({ requestId: id, stage: 'identify', index, track: { ...options.tracks[index] }, done: index + 1, total: options.tracks.length }); },
          finish: () => resolve({ tracks: options.tracks.map(t => ({ ...t, checked: true })), warnings: [] }),
          fail: () => reject(new Error('识别服务暂时不可用')),
        }));
      }
      window.testSplitCalls++; progress?.({ requestId: id, stage: 'download', pct: 30 });
      await new Promise(resolve => setTimeout(resolve, window.testSplitDelay));
      if (cancelled.has(id)) throw new Error('cancelled');
      return { duration: 1200, tracks: [{ start: 0, end: 240, title: '第一首', source: 'netease' }, { start: 240, end: 480, title: '第二首' }, { start: 480, end: 1200, title: '第三首' }], named: 3 };
    },
    splitCancel: async id => { cancelled.add(id); return true; },
    playurl: async () => ({ tracks: [{ url: 'https://audio.invalid/mock', kbps: 128, codecs: 'mp4a.40.2' }] }),
  }, { get: (target, key) => target[key] || (() => Promise.resolve({})) });
}
async function run() {
  const { chromium } = require(runtime);
  const browser = await chromium.launch({ executablePath: process.env.CCMUSIC_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true, args: ['--disable-background-networking', '--disable-component-update'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 }, serviceWorkers: 'block' });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    const routes = new Map(['/renderer/index.html', '/renderer/style.css', '/renderer/app.js', '/renderer/downloads.js', '/renderer/workflows.js', '/renderer/library-model.js', '/renderer/volume-balance.js', '/renderer/music-search-policy.js', '/assets/icon.png'].map(url => [url, path.join(root, url)]));
    await page.route('**/*', route => {
      const file = routes.get(new URL(route.request().url()).pathname);
      if (!file) return route.abort();
      return route.fulfill({ body: fs.readFileSync(file), contentType: file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.css') ? 'text/css; charset=utf-8' : file.endsWith('.png') ? 'image/png' : 'text/javascript; charset=utf-8' });
    });
    await page.addInitScript(mockBridge);
    await page.goto('http://ccmusic.test/renderer/index.html');
    await page.locator('#folders .folder').first().waitFor();
    await page.locator('#homeHot .hcard').first().waitFor();
    assert.equal(await page.locator('.home-nav.on').count(), 1);
    assert.equal(await page.locator('#folders .folder.on').count(), 0, 'home must not select the remembered playlist');
    assert.equal(await page.locator('#quality').getAttribute('aria-pressed'), 'true', 'lossless preference defaults on');
    assert.equal(await page.evaluate(() => pickTrack({ flac: { url: 'flac' }, tracks: [{ url: 'aac' }] }).url), 'flac');
    assert.equal(await page.locator('#actualQuality').isHidden(), true);
    assert.equal(await page.locator('#playStatus').isHidden(), true);
    assert.equal(await page.locator('#taskBtn').textContent(), '任务');
    assert.equal(await page.locator('#downloadsBtn').textContent(), '下载');
    assert.equal(await page.locator('#downloadsPanel').evaluate(el => el.getBoundingClientRect().height <= 440), true, 'download popover must stay compact');
    assert.equal(await page.locator('#taskCount').isHidden(), true);
    assert.equal(await page.locator('#downloadCount').isHidden(), true);
    assert.equal(await page.evaluate(() => fmtDur('1221:46')), '20:21:46', 'long compilations use hours rather than four-digit minutes');
    await page.locator('#folders [data-id="a"]').click();
    assert.equal(await page.locator('#folders .folder.on').count(), 1);
    assert.equal(await page.locator('.home-nav.on').count(), 0);
    await page.locator('.home-nav').click(); await page.evaluate(() => renderFolders());
    assert.equal(await page.locator('#folders .folder.on').count(), 0, 'rerendering folders preserves exclusive navigation');
    await page.evaluate(() => { setPlaybackStatus('播放中'); }); assert.equal(await page.locator('#playStatus').isHidden(), true);
    await page.evaluate(() => { setPlaybackStatus('已暂停'); }); assert.equal(await page.locator('#playStatus').isHidden(), true);
    await page.evaluate(() => { setPlaybackStatus('正在加载…'); }); assert.equal(await page.locator('#playStatus').isVisible(), true);
    await page.evaluate(() => { setPlaybackStatus('播放失败 · 点击重试', true); }); assert.equal(await page.locator('#playStatus').isEnabled(), true);
    await page.evaluate(() => { setPlaybackStatus(''); curFormat = 'AAC'; curKbps = 128; syncQualityBtn(); });
    assert.ok((await page.locator('#quality').getAttribute('title')).includes('AAC · 128 kbps'));
    assert.equal(await page.locator('#actualQuality').isHidden(), true);
    await page.evaluate(() => { curFormat = ''; curKbps = 0; syncQualityBtn(); });
    await page.screenshot({ path: path.join(root, 'validation/ui-home-refined.png') });
    await page.locator('#quality').click(); await page.reload(); await page.locator('#homeHot .hcard').first().waitFor();
    assert.equal(await page.locator('#quality').getAttribute('aria-pressed'), 'false', 'explicit opt-out survives restart');
    await page.locator('#quality').click();
    assert.equal(await page.evaluate(() => S.hot.every(item => MusicSearch.eligible(item, '音乐'))), true);
    await page.locator('#kw').fill('The Weeknd'); await page.locator('#go').click();
    await page.locator('#results .row').first().waitFor();
    await page.locator('#results [data-download="0"]').click();
    await page.locator('#downloadLoginModal:not([hidden])').waitFor();
    assert.equal(await page.evaluate(() => window.testDownloadCalls.length), 1);
    assert.equal(await page.evaluate(() => downloadTasks.size), 0, 'login prompt must not start a task');
    await page.screenshot({ path: path.join(root, 'validation/ui-download-login.png') });
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#downloadLoginModal').isHidden(), true);
    await page.locator('#results [data-download="0"]').click(); await page.locator('#downloadLimited').click();
    await page.locator('#downloadsPanel:not([hidden])').waitFor();
    assert.equal(await page.locator('#downloadsBtn').getAttribute('data-state'), 'running');
    assert.equal(await page.locator('#downloadsBtn').textContent(), '下载');
    assert.equal(await page.evaluate(() => document.querySelector('#downloadsPanel').getBoundingClientRect().bottom <= document.querySelector('.bar').getBoundingClientRect().top), true, 'download panel must leave playback controls accessible');
    await page.locator('[data-dl-cancel]').click();
    assert.equal(await page.locator('#downloadsBtn').getAttribute('data-state'), 'idle');
    await page.locator('[data-dl-dismiss]').click(); await page.locator('#downloadsClose').click();
    await page.locator('#results [data-download="0"]').click(); await page.locator('#downloadLoginGo').click();
    await page.locator('#loginModal:not([hidden])').waitFor();
    await page.locator('#downloadsPanel:not([hidden])').waitFor();
    assert.equal(await page.locator('#loginModal').isHidden(), true, 'successful login resumes pending download');
    await page.locator('#downloadsClose').click();
    await page.evaluate(() => { const task = [...downloadTasks.values()][0]; window.emitDownload({ ...task, state: 'done', pct: 100, quality: 'FLAC 无损 · 源音轨 900 kbps', file: 'D:\\音乐\\测试.flac' }); });
    assert.equal(await page.locator('#downloadsBtn').getAttribute('data-state'), 'attention');
    await page.locator('#downloadsBtn').click();
    assert.equal(await page.locator('#downloadsBtn').getAttribute('data-state'), 'idle', 'opening completed downloads acknowledges the dot');
    await page.locator('[data-dl-reveal]').click();
    assert.ok(await page.evaluate(() => window.testRevealed));
    await page.screenshot({ path: path.join(root, 'validation/ui-downloads.png') });
    await page.locator('[data-dl-dismiss]').click(); await page.locator('#downloadsClose').click();
    await page.locator('#results .row').first().click({ position: { x: 170, y: 20 } });
    assert.equal(await page.evaluate(() => S.queue.length), 0, 'single click selects without replacing queue');
    await page.locator('#results [data-add="0"]').click();
    await page.locator('#addModal:not([hidden])').waitFor();
    assert.equal(await page.locator('#addSplit').isChecked(), true);
    assert.equal(await page.locator('#addSplitOptions input').first().getAttribute('id'), 'addSplit');
    assert.ok((await page.locator('#addForm').boundingBox()).width >= 400);
    await page.screenshot({ path: path.join(root, 'validation/ui-add-dialog.png') });
    await page.locator('#addCancel').click();
    assert.equal(await page.evaluate(() => S.folders.every(f => f.items.length === 0)), true);
    await page.locator('#results [data-add="0"]').click(); await page.locator('#addFolder').selectOption('b'); await page.locator('#addWhole').check(); await page.locator('#addConfirm').click();
    assert.equal(await page.evaluate(() => S.folders[1].items.length), 1);
    assert.equal(await page.evaluate(() => window.testSplitCalls), 0);
    await page.locator('#folders [data-id="b"]').click();
    await page.evaluate(() => { loadQueue(folder().items, 0); audio.currentTime = 300; $('#downloadsPanel').hidden = false; });
    await page.locator('#list .row').first().click({ button: 'right' }); await page.getByText('智能分歌…', { exact: true }).click();
    await page.locator('#reviewModal:not([hidden])').waitFor();
    assert.equal(await page.locator('.completion-notice').count(), 0, 'ready result opens directly without a duplicate reminder');
    assert.equal(await page.locator('#downloadsPanel').isHidden(), true, 'task and download popovers must not stack');
    await page.screenshot({ path: path.join(root, 'validation/ui-completion-popover.png') });
    assert.equal(await page.locator('#reviewModal').isVisible(), true);
    assert.equal(await page.locator('.completion-notice').count(), 0);
    await page.locator('#reviewClose').click();
    assert.equal(await page.locator('#tasksPanel').evaluate(el => el.getBoundingClientRect().height <= 440), true);
    assert.equal(await page.locator('#taskBtn').getAttribute('data-state'), 'attention');
    assert.equal(await page.locator('#taskBtn').textContent(), '任务');
    assert.equal(await page.evaluate(() => S.folders[1].items.length), 1, 'ready result still preserves original');
    await page.reload(); await page.locator('#reviewModal:not([hidden])').waitFor();
    assert.equal(await page.evaluate(() => S.folders[1].items.length), 1, 'ready tasks survive a reload without auto-applying');
    assert.ok((await page.locator('.review-box').boundingBox()).width <= 620);
    assert.equal(await page.locator('.review-name').count(), 0, 'default preview must not be an editing form');
    await page.locator('#reviewAdjust').click();
    await page.locator('.review-name').first().fill('手动修正的歌名');
    await page.locator('[data-merge="1"]').click();
    assert.equal(await page.locator('.review-row').count(), 2);
    await page.locator('[data-cut="0"]').click(); await page.locator('#editValue').fill('2:00'); await page.locator('#editForm [type="submit"]').click();
    assert.equal(await page.locator('.review-row').count(), 3);
    await page.locator('#reviewClose').click();
    await page.locator('#taskBtn').click();
    await page.locator('[data-review]').click();
    await page.locator('#reviewAdjust').click();
    assert.equal(await page.locator('.review-name').first().inputValue(), '手动修正的歌名');
    await page.screenshot({ path: path.join(root, 'validation/ui-split-review.png') });
    await page.evaluate(() => { audio.currentTime = 300; });
    await page.locator('#reviewConfirm').click();
    assert.equal(await page.evaluate(() => S.folders[1].items.length), 3);
    assert.equal(await page.evaluate(() => S.qcur), 1);
    assert.equal(await page.evaluate(() => curSplitStart), 120);
    await page.locator('#undoButton').click();
    assert.equal(await page.evaluate(() => S.folders[1].items.length), 1);
    assert.equal(await page.evaluate(() => S.queue.length), 1);
    assert.equal(await page.evaluate(() => curSplitStart), null);
    if (await page.locator('#tasksPanel').isVisible()) await page.locator('#tasksClose').click();
    await page.evaluate(() => applySplitResult(folder(), folder().items[0], { duration: 1200, named: 2, tracks: [{ start: 0, end: 240, title: '甲' }, { start: 240, end: 1200, title: '乙' }] }));
    await page.locator('#list .group').click({ button: 'right' }); await page.getByText('恢复整段…', { exact: true }).click(); await page.locator('#cfOk').click();
    assert.equal(await page.evaluate(() => folder().items.length), 1);
    await page.locator('#undoButton').click();
    assert.equal(await page.evaluate(() => folder().items.length), 2);
    assert.equal(await page.evaluate(() => S.qcur), 1);
    await page.locator('#list .group').click({ button: 'right' }); await page.getByText('恢复整段…', { exact: true }).click(); await page.locator('#cfOk').click();
    await page.locator('#libRename').click(); await page.locator('#editValue').fill('我的欧美合集'); await page.locator('#editForm [type="submit"]').click();
    assert.equal(await page.locator('#libTitle').textContent(), '我的欧美合集');
    await page.locator('#libSelect').click(); await page.locator('#libAll').click();
    await page.locator('#libMove').click(); await page.locator('#addFolder').selectOption('a'); await page.locator('#addConfirm').click();
    assert.deepEqual(await page.evaluate(() => S.folders.map(f => f.items.length)), [1, 0]);
    await page.locator('#undoButton').click();
    assert.deepEqual(await page.evaluate(() => S.folders.map(f => f.items.length)), [0, 1]);
    await page.locator('#libSelect').click();
    await page.locator('#folders [data-id="b"]').click();
    const downloadEvent = page.waitForEvent('download');
    await page.locator('#libExport').click();
    const download = await downloadEvent;
    const downloaded = await download.path();
    const exported = JSON.parse(fs.readFileSync(downloaded, 'utf8'));
    assert.equal(exported.folders.length, 2);
    assert.equal(exported.cookies, undefined);
    await page.locator('#importFile').setInputFiles({ name: 'test-library.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ folders: [{ name: '导入测试', items: [{ bvid: 'BV1TBEK6jEps', title: '测试曲目', duration: 300 }] }] })) });
    await page.locator('#confirmModal:not([hidden])').waitFor(); await page.locator('#cfOk').click();
    await page.waitForFunction(() => S.folders.length === 3);
    await page.locator('#undoButton').click();
    assert.equal(await page.evaluate(() => S.folders.length), 2);
    await page.locator('#folders [data-id="b"] [data-menu]').click();
    await page.getByText('删除歌单', { exact: true }).click(); await page.locator('#cfOk').click();
    assert.equal(await page.evaluate(() => S.folders.length), 1);
    await page.locator('#undoButton').click();
    assert.equal(await page.evaluate(() => S.folders.length), 2);
    await page.locator('#folders [data-id="b"]').click();
    await page.evaluate(() => { window.testSplitDelay = 500; });
    await page.locator('#list .row').first().click({ button: 'right' }); await page.getByText('智能分歌…', { exact: true }).click();
    assert.ok((await page.locator('#taskList').textContent()).includes('正在智能解析 30%'));
    assert.equal((await page.locator('#taskList').textContent()).includes('正在下载'), false);
    await page.screenshot({ path: path.join(root, 'validation/ui-task-parsing.png') });
    await page.locator('[data-cancel]').click();
    await page.waitForTimeout(550);
    assert.equal(await page.evaluate(() => S.folders[1].items.length), 1, 'cancelled task cannot change library');
    await page.locator('[data-dismiss]').click(); await page.locator('#tasksClose').click();
    await page.screenshot({ path: path.join(root, 'validation/ui-library.png') });
    await page.setViewportSize({ width: 960, height: 700 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.ok(await page.locator('#vol').evaluate(el => el.getBoundingClientRect().right <= innerWidth), 'volume must stay inside a narrow window');
    await page.screenshot({ path: path.join(root, 'validation/ui-library-small.png') });
    await page.evaluate(() => clearQueue());
    assert.equal(await page.evaluate(() => S.queue.length), 0);
    assert.equal(await page.evaluate(() => audio.src), '');
    assert.equal(await page.evaluate(() => playback.current), null);
    await page.setViewportSize({ width: 1280, height: 820 });
    await page.locator('#kw').fill('theweekend'); await page.locator('#go').click();
    await page.waitForFunction(() => document.querySelector('#searchHint').textContent.includes('The Weeknd'));
    assert.equal(await page.locator('#results .row').count(), 2);
    assert.ok((await page.locator('#results').textContent()).includes('Die For You'));
    assert.ok(!(await page.locator('#results').textContent()).includes('爵士入门'));
    assert.ok(!(await page.locator('#results').textContent()).includes('Hymn For The Weekend'));
    await page.screenshot({ path: path.join(root, 'validation/ui-search-listening.png') });
    await page.locator('#searchAudience').selectOption('all');
    assert.equal(await page.locator('#results .row').count(), 5);
    await page.locator('#searchAudience').selectOption('music'); await page.locator('#searchFilter').selectOption('long');
    assert.equal(await page.locator('#results .row').count(), 1);
    await page.locator('#kw').fill('BV1HE411E7Gx'); await page.locator('#go').click();
    await page.waitForFunction(() => S.searchDirect === true);
    assert.equal(await page.locator('#results .row').count(), 1, 'direct link remains visible even with duration/type filters');
    // Download selection must preserve P identity and segment boundaries, without adding to a playlist.
    await page.evaluate(() => {
      window.testLogged = true;
      window.api.video = async bvid => ({ bvid, title: '多 P 下载验证', parts: [{ page: 1, cid: 11, part: '第一 P', duration: 200 }, { page: 2, cid: 22, part: '第二 P', duration: 250 }] });
    });
    await page.locator('#results [data-download="0"]').click();
    await page.locator('#partsModal:not([hidden])').waitFor();
    await page.locator('#pmNone').click(); await page.locator('#pmList input').nth(1).check(); await page.locator('#pmDownload').click();
    assert.equal(await page.locator('#partsModal').isHidden(), true);
    assert.deepEqual(await page.evaluate(() => window.testDownloadCalls.at(-1).items.map(item => [item.page, item.cid])), [[2, 22]]);
    await page.locator('#downloadsClose').click();
    await page.evaluate(() => {
      const f = folder(); f.items = [{ bvid: 'BV1uuHd6cEhy', page: 1, cid: 1, title: '分段甲', vtitle: '合集', split: true, startSec: 0, endSec: 180, duration: 180 }, { bvid: 'BV1uuHd6cEhy', page: 1, cid: 1, title: '分段乙', vtitle: '合集', split: true, startSec: 180, endSec: 360, duration: 180 }, { bvid: 'BV1uuHd6cEhy', page: 1, cid: 1, title: '分段丙', vtitle: '合集', split: true, startSec: 360, endSec: 540, duration: 180 }, { bvid: 'BV1TBEK6jEps', page: 1, cid: 2, title: '独立单曲', duration: 240 }];
      renderList(); showView('library');
    });
    await page.locator('#list [data-gdl]').click();
    await page.locator('#downloadPickerModal:not([hidden])').waitFor();
    assert.equal(await page.locator('#downloadPickerList input').count(), 3, 'group picker excludes other songs in the playlist');
    assert.equal(await page.locator('#downloadPickerConfirm').isDisabled(), true, 'no automatic all-song selection');
    const callsBeforePick = await page.evaluate(() => window.testDownloadCalls.length);
    await page.locator('#downloadPickerList input').nth(0).check(); await page.locator('#downloadPickerList input').nth(2).check();
    await page.locator('#downloadPickerQuery').fill('乙');
    assert.ok((await page.locator('#downloadPickerSummary').textContent()).includes('2 首不在当前筛选中'));
    await page.locator('#downloadPickerAll').click();
    assert.ok((await page.locator('#downloadPickerSummary').textContent()).includes('已选 3 首'));
    await page.locator('#downloadPickerInvert').click();
    assert.ok((await page.locator('#downloadPickerSummary').textContent()).includes('已选 2 首'));
    await page.locator('#downloadPickerQuery').fill('');
    await page.screenshot({ path: path.join(root, 'validation/ui-download-picker.png') });
    assert.equal(await page.evaluate(() => window.testDownloadCalls.length), callsBeforePick, 'checking songs must not submit downloads');
    await page.locator('#downloadPickerConfirm').click();
    await page.locator('#downloadsPanel:not([hidden])').waitFor();
    assert.deepEqual(await page.evaluate(() => window.testDownloadCalls.at(-1).items.map(item => [item.split, item.startSec, item.endSec])), [[true, 0, 180], [true, 360, 540]], 'download only nonadjacent selected segments');
    assert.equal(await page.evaluate(() => folder().items.length), 4, 'download selection must not change playlist');
    await page.locator('#downloadsClose').click();
    await page.locator('#libPickDownload').click();
    assert.equal(await page.locator('#downloadPickerList input').count(), 4);
    await page.locator('#downloadPickerAll').click(); await page.locator('#downloadPickerClear').click();
    assert.equal(await page.locator('#downloadPickerConfirm').isDisabled(), true);
    await page.locator('#downloadPickerList input').nth(0).check(); await page.locator('#downloadPickerList input').nth(3).check();
    await page.locator('#downloadPickerConfirm').click(); await page.locator('#downloadsPanel:not([hidden])').waitFor();
    assert.deepEqual(await page.evaluate(() => window.testDownloadCalls.at(-1).items.map(item => item.title)), ['分段甲', '独立单曲'], 'playlist picker supports mixed groups and singles');
    await page.locator('#downloadsClose').click();
    const callsBeforeCancel = await page.evaluate(() => window.testDownloadCalls.length);
    await page.locator('#libPickDownload').click(); await page.locator('#downloadPickerList input').first().check(); await page.keyboard.press('Escape');
    assert.equal(await page.locator('#downloadPickerModal').isHidden(), true);
    assert.equal(await page.evaluate(() => window.testDownloadCalls.length), callsBeforeCancel);
    await page.evaluate(() => openDownloadPicker(Array.from({ length: 101 }, (_, i) => ({ ...folder().items[0], title: '歌曲 ' + i })), '上限测试'));
    await page.locator('#downloadPickerAll').click(); assert.equal(await page.locator('#downloadPickerConfirm').isDisabled(), true);
    await page.locator('#downloadPickerCancel').click();
    await page.setViewportSize({ width: 900, height: 700 });
    assert.equal(await page.evaluate(() => {
      const elements = ['#backBtn', '#kw', '#taskBtn', '#downloadsBtn', '#avatarBtn', '#wMin'].map(selector => document.querySelector(selector).getBoundingClientRect());
      return elements.every((box, i) => box.right <= innerWidth && (i === 0 || box.left >= elements[i - 1].right));
    }), true, 'download entry must fit minimum 900px window without overlapping search/account/window buttons');
    assert.deepEqual(errors, []);
    await page.locator('#libPickDownload').click();
    assert.equal(await page.locator('#downloadPickerModal').evaluate(element => { const box = element.querySelector('.modal-box').getBoundingClientRect(); return box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight; }), true);
    await page.locator('#downloadPickerCancel').click();
    await page.evaluate(() => {
      window.savedDownloadTasks = [...downloadTasks.entries()];
      for (let i = 0; i < 16; i++) downloadTasks.set('layout-' + i, { id: 'layout-' + i, title: '很长的下载标题 '.repeat(12), state: 'done', quality: 'FLAC', file: 'D:/' + '很长的文件路径'.repeat(20) + '.flac' });
      showDownloads();
    });
    assert.equal(await page.locator('#downloadsPanel').evaluate(el => el.getBoundingClientRect().height <= 440), true);
    assert.equal(await page.locator('#downloadsList').evaluate(el => el.scrollHeight > el.clientHeight), true, 'many downloads scroll inside the popover');
    await page.screenshot({ path: path.join(root, 'validation/ui-downloads-compact.png') });
    await page.evaluate(() => { downloadTasks.clear(); for (const [id, task] of window.savedDownloadTasks) downloadTasks.set(id, task); delete window.savedDownloadTasks; renderDownloads(); });
    await page.locator('#downloadsClose').click();
    // Group action buttons must dispatch from the clicked button, never toggle
    // the group. Include a nonzero start index and nested button content.
    for (const kind of ['split', 'parts']) for (const collapsed of [false, true]) {
      await page.evaluate(({ kind, collapsed }) => {
        const first = { bvid: 'BV1TBEK6jEps', cid: 2, page: 1, duration: 240, title: '组内第一首', vtitle: '整组测试', up: '测试作者',
          ...(kind === 'split' ? { split: true, startSec: 0, endSec: 240 } : {}) };
        const second = { ...first, cid: kind === 'split' ? 2 : 3, page: kind === 'split' ? 1 : 2, title: '组内第二首',
          ...(kind === 'split' ? { startSec: 240, endSec: 480 } : {}) };
        const leading = { bvid: 'BV1HE411E7Gx', cid: 4, page: 1, duration: 220, title: '组前单曲' };
        folder().items = [leading, first, second, { ...leading, bvid: 'BV1uuHd6cEhy', title: '组后单曲' }];
        librarySelecting = false; librarySelection.clear(); libraryQuery = ''; $('#libFilter').value = '';
        localStorage.collapsedVideos = JSON.stringify(collapsed ? [first.bvid] : []);
        S.queue = [{ ...leading }]; S.qcur = 0; playback.current = null; playback.requested = null;
        renderList(); renderQueue();
        document.querySelector('#list [data-grm]').innerHTML = '<span>移除</span>';
      }, { kind, collapsed });
      const openBefore = await page.locator('#list .group').evaluate(el => el.classList.contains('open'));
      await page.locator('#list [data-grm] span').click();
      assert.equal(await page.locator('#confirmModal').isVisible(), true, `${kind} group removal must show confirmation`);
      assert.equal(await page.locator('#list .group').evaluate(el => el.classList.contains('open')), openBefore, 'remove must not fold or unfold');
      await page.locator('#cfCancel').click();
      assert.equal(await page.evaluate(() => folder().items.length), 4, 'cancel preserves the whole group');
      await page.locator('#list [data-grm]').click(); await page.locator('#cfOk').click();
      assert.deepEqual(await page.evaluate(() => folder().items.map(item => item.title)), ['组前单曲', '组后单曲']);
      assert.equal(await page.evaluate(() => S.queue.length), 1, 'library removal preserves independent playback queue');
      await page.locator('#undoButton').click();
      assert.deepEqual(await page.evaluate(() => folder().items.map(item => item.title)), ['组前单曲', '组内第一首', '组内第二首', '组后单曲']);
      assert.equal(await page.locator('#list .group').evaluate(el => el.classList.contains('open')), openBefore);
    }
    await page.locator('#list [data-gplay]').click();
    await page.waitForFunction(() => S.queue[S.qcur]?.title === '组内第一首');
    assert.equal(await page.locator('#list .group').evaluate(el => el.classList.contains('open')), false, 'group play must not unfold');
    await page.locator('#list .group').click({ button: 'right' }); await page.getByText('移除全部', { exact: true }).click();
    await page.locator('#cfOk').click(); assert.equal(await page.evaluate(() => folder().items.length), 2);
    await page.locator('#undoButton').click(); assert.equal(await page.evaluate(() => folder().items.length), 4);
    // Editing an already saved segment updates the same segment's copies only.
    await page.evaluate(() => {
      const first = { bvid: 'BV1TBEK6jEps', cid: 2, page: 1, split: true, startSec: 0, endSec: 240, duration: 240, title: '原识别歌名', artist: '错误的原唱', up: '视频上传者', identifySource: 'netease' };
      const next = { ...first, startSec: 240, endSec: 480, title: '另一分段', artist: '另一歌手' };
      S.folders[0].items = [{ ...first }]; folder().items = [first, next];
      S.queue = [first, { ...next }]; S.qcur = 0;
      playback.current = { item: { ...first }, idx: 0 }; playback.requested = { item: { ...first } };
      audio.currentTime = 123; libraryQuery = ''; $('#libFilter').value = ''; renderList(); renderFolders(); renderQueue();
    });
    await page.locator('#list .row:not(.group)').first().click({ button: 'right' });
    await page.getByText('编辑歌曲信息…', { exact: true }).click();
    assert.equal(await page.locator('#songInfoArtist').inputValue(), '错误的原唱');
    await page.locator('#songInfoTitle').fill('翻唱歌名 <现场>'); await page.locator('#songInfoArtist').fill('实际翻唱者');
    assert.equal(await page.locator('#songInfoModal').evaluate(element => { const box = element.querySelector('.modal-box').getBoundingClientRect(); return box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight; }), true);
    await page.screenshot({ path: path.join(root, 'validation/ui-song-info-editor.png') });
    await page.locator('#songInfoForm [type="submit"]').click();
    assert.equal(await page.locator('#songInfoModal').isHidden(), true);
    assert.equal(await page.locator('#bTitle').textContent(), '翻唱歌名 <现场>');
    assert.equal(await page.locator('#bUp').textContent(), '实际翻唱者');
    assert.equal(await page.locator('#queueList .qu').first().textContent(), '实际翻唱者');
    assert.equal(await page.evaluate(() => audio.currentTime), 123, 'metadata edits must not restart playback');
    assert.equal(await page.evaluate(() => S.folders.flatMap(f => f.items).filter(item => item.startSec === 0).every(item => item.title === '翻唱歌名 <现场>' && item.artist === '实际翻唱者' && item.identifySource === 'manual')), true);
    assert.equal(await page.evaluate(() => folder().items[1].artist), '另一歌手', 'different segment must remain unchanged');
    assert.equal(await page.evaluate(() => playback.current.item.artist), '实际翻唱者');
    assert.equal(await page.evaluate(() => playback.requested.item.artist), '实际翻唱者');
    assert.equal(await page.evaluate(() => folder().items[0].up), '视频上传者', 'performer edits must preserve the uploader');
    await page.locator('#undoButton').click();
    assert.equal(await page.evaluate(() => S.queue[0].artist), '错误的原唱', 'shared object must be snapshotted once for correct undo');
    assert.equal(await page.locator('#bTitle').textContent(), '原识别歌名');
    assert.equal(await page.locator('#bUp').textContent(), '错误的原唱');
    await page.locator('#qBtn').click();
    await page.locator('#queueList .q-row').first().click({ button: 'right' });
    await page.getByText('编辑歌曲信息…', { exact: true }).click();
    await page.locator('#songInfoTitle').fill('取消修改'); await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => S.queue[0].title), '原识别歌名');
    await page.locator('#queueList .q-row').first().click({ button: 'right' }); await page.getByText('编辑歌曲信息…', { exact: true }).click();
    await page.locator('#songInfoTitle').fill(''); await page.locator('#songInfoForm [type="submit"]').click();
    assert.equal(await page.locator('#songInfoModal').isHidden(), false, 'empty title cannot be saved');
    await page.locator('#songInfoTitle').fill('持久化的新歌名'); await page.locator('#songInfoArtist').fill(''); await page.keyboard.press('Enter');
    assert.equal(await page.locator('#bUp').textContent(), '', 'explicitly clearing singer must not reveal the uploader as singer');
    assert.equal(await page.evaluate(() => LibraryModel.importedFolders({ folders: [{ name: '测试', items: [S.queue[0]] }] })[0].items[0].artist), '', 'export/import retains an explicitly cleared singer');
    await page.reload(); await page.locator('#folders [data-id="b"]').click();
    assert.equal(await page.evaluate(() => folder().items[0].title), '持久化的新歌名');
    assert.equal(await page.evaluate(() => S.queue[0].artist), '');
    assert.equal(await page.evaluate(() => S.queue[0].identifySource), 'manual');
    console.log('PASS: real DOM startup and existing workflows; collapsed/expanded split and multi-P group removal, nested button target, cancel/undo, group play/context menu; downloads and arbitrary subsets; saved song metadata sync/undo/persistence, 900px layout; IPC and media mocked');
  } finally { await browser.close(); }
}
if (require.main === module) run().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { mockBridge };
