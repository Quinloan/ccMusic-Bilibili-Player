// Headless Edge against actual renderer files and mocked IPC. Never starts Electron or plays media.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const runtime = process.env.CCMUSIC_PLAYWRIGHT || 'C:/Users/liungaxing/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright';
function mockBridge() {
  localStorage.autoCheck = '0';
  window.testLibrary = JSON.parse(localStorage.mockLibrary || 'null') || { folders: [{ id: 'a', name: '我的歌单', items: [] }, { id: 'b', name: '欧美收藏', items: [] }], active: 'a' };
  window.testSplitDelay = 10; window.testSplitCalls = 0;
  let progress; const cancelled = new Set();
  let downloadProgress; window.testDownloadCalls = []; window.testLogged = false;
  const title = '〖The Weeknd合集|Hi-Res〗“如果你也喜欢The Weeknd”';
  const video = { bvid: 'BV1uuHd6cEhy', cid: 1, title, up: '界面测试', cover: '/assets/icon.png', duration: 1200, parts: [{ cid: 1, page: 1, part: title, duration: 1200 }] };
  Object.defineProperties(HTMLMediaElement.prototype, {
    src: { get() { return this._src || ''; }, set(value) { this._src = value; } },
    currentTime: { get() { return this._time || 0; }, set(value) { this._time = value; } },
    readyState: { get: () => 1 }, duration: { get: () => 1200 }, paused: { get() { return !this._playing; } },
  });
  HTMLMediaElement.prototype.play = async function () { this._playing = true; this.dispatchEvent(new Event('loadedmetadata')); this.dispatchEvent(new Event('play')); };
  HTMLMediaElement.prototype.pause = function () { this._playing = false; this.dispatchEvent(new Event('pause')); };
  HTMLMediaElement.prototype.load = function () {};
  window.api = new Proxy({
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
    onSplitProgress: callback => { progress = callback; },
    splitAnalyze: async (_bv, _cid, _max, _desc, id) => {
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
    const routes = new Map(['/renderer/index.html', '/renderer/style.css', '/renderer/app.js', '/renderer/downloads.js', '/renderer/workflows.js', '/renderer/library-model.js', '/renderer/music-search-policy.js', '/assets/icon.png'].map(url => [url, path.join(root, url)]));
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
    assert.equal(await page.locator('#addWhole').isChecked(), true);
    assert.ok((await page.locator('#addForm').boundingBox()).width >= 400);
    await page.screenshot({ path: path.join(root, 'validation/ui-add-dialog.png') });
    await page.locator('#addCancel').click();
    assert.equal(await page.evaluate(() => S.folders.every(f => f.items.length === 0)), true);
    await page.locator('#results [data-add="0"]').click(); await page.locator('#addFolder').selectOption('b'); await page.locator('#addConfirm').click();
    assert.equal(await page.evaluate(() => S.folders[1].items.length), 1);
    assert.equal(await page.evaluate(() => window.testSplitCalls), 0);
    await page.locator('#folders [data-id="b"]').click();
    await page.evaluate(() => { loadQueue(folder().items, 0); audio.currentTime = 300; });
    await page.locator('#list .row').first().click({ button: 'right' }); await page.getByText('智能分歌…', { exact: true }).click();
    await page.locator('[data-review]').waitFor();
    assert.equal(await page.locator('#taskBtn').getAttribute('data-state'), 'attention');
    assert.equal(await page.locator('#taskBtn').textContent(), '任务');
    assert.equal(await page.evaluate(() => S.folders[1].items.length), 1, 'ready result still preserves original');
    await page.reload(); await page.locator('#folders [data-id="b"]').click(); await page.locator('#taskBtn').click();
    await page.locator('[data-review]').waitFor();
    assert.equal(await page.evaluate(() => S.folders[1].items.length), 1, 'ready tasks survive a reload without auto-applying');
    await page.locator('[data-review]').click();
    assert.ok((await page.locator('.review-box').boundingBox()).width >= 800);
    await page.locator('.review-name').first().fill('手动修正的歌名');
    await page.locator('[data-merge="1"]').click();
    assert.equal(await page.locator('.review-row').count(), 2);
    await page.locator('[data-cut="0"]').click(); await page.locator('#editValue').fill('2:00'); await page.locator('#editForm [type="submit"]').click();
    assert.equal(await page.locator('.review-row').count(), 3);
    await page.locator('#reviewClose').click();
    await page.locator('[data-review]').click();
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
    await page.locator('#tasksClose').click();
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
    await page.evaluate(() => { window.testSplitDelay = 100; });
    await page.locator('#list .row').first().click({ button: 'right' }); await page.getByText('智能分歌…', { exact: true }).click();
    await page.locator('[data-cancel]').click();
    await page.waitForTimeout(150);
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
    console.log('PASS: real DOM startup and existing workflows; download login/resume/cancel; arbitrary group/playlist subsets, filtered selection, clear/invert, limits, no submit on cancel, P/split identity, 1280/960/900 layout; IPC and media mocked');
  } finally { await browser.close(); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
