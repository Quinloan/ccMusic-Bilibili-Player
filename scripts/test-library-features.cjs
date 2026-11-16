// Lightweight native-module and headless renderer checks. No Electron or real audio playback.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { fileURLToPath } = require('node:url');
const { mockBridge } = require('./test-ui.cjs');
const root = path.resolve(__dirname, '..');

async function nativeChecks() {
  const { createShortcuts } = require('../custom-shortcuts.cjs');
  const keys = new Map([['Control+X', () => {}]]), sent = [];
  let saved = {};
  const shortcuts = createShortcuts({ shortcut: {
    register(key, callback) { if (keys.has(key)) return false; keys.set(key, callback); return true; },
    unregister(key) { keys.delete(key); },
  }, send: command => sent.push(command), read: () => saved, write: value => { saved = value; } });
  shortcuts.configure({ playPause: 'Ctrl+Shift+P', like: 'Shift+F8' });
  keys.get('Control+Shift+P')(); assert.deepEqual(sent, ['playPause']);
  assert.throws(() => shortcuts.configure({ playPause: 'Ctrl+N', next: 'Ctrl+X' }), /占用/);
  assert(keys.has('Control+X'), 'failed registration must not unregister another app action');
  assert(keys.has('Control+Shift+P')); assert(!keys.has('Control+N'));
  assert.equal(saved.playPause, 'Control+Shift+P');
  assert.throws(() => shortcuts.configure({ playPause: 'Ctrl+P', next: 'Control+P' }), /相同/);
  assert.throws(() => shortcuts.configure({ playPause: 'P' }), /组合键/);
  shortcuts.dispose(); assert.deepEqual([...keys.keys()], ['Control+X']);

  const dir = fs.mkdtempSync(path.join(root, 'validation/library-features-'));
  const mediaDir = path.join(dir, 'music'), dataDir = path.join(dir, 'data');
  fs.mkdirSync(mediaDir); fs.mkdirSync(path.join(mediaDir, 'album'));
  try {
    const wav = Buffer.alloc(44 + 16000);
    wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28);
    wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(16000, 40);
    const file = path.join(mediaDir, 'album', 'tagged.wav'); fs.writeFileSync(file, wav);
    const { updateFile } = await import('music-metadata');
    await updateFile(file, { title: '本地标题', artist: '本地歌手', album: '本地专辑', track: { no: 3 },
      picture: [{ format: 'image/png', data: fs.readFileSync(path.join(root, 'assets/icon.png')) }] });
    fs.writeFileSync(path.join(mediaDir, 'broken.mp3'), 'not an audio file');
    const { createMusicLibrary } = require('../music-library.cjs');
    let lib = createMusicLibrary(dataDir);
    const scanned = await lib.scan(mediaDir);
    assert.equal(scanned.items.length, 1); assert.equal(scanned.warnings.length, 1);
    const item = scanned.items[0];
    assert.equal(item.title, '本地标题'); assert.equal(item.artist, '本地歌手'); assert.equal(item.album, '本地专辑');
    assert.equal(item.trackNumber, 3); assert.equal(item.duration, 1);
    assert(fs.existsSync(fileURLToPath(item.cover)));
    const local = await lib.find(item); assert.equal(fileURLToPath(local.url), file); assert.equal(local.codecs, 'WAV');
    assert.equal((await lib.scan(mediaDir)).items[0].localId, item.localId);
    lib = createMusicLibrary(dataDir); assert.equal((await lib.find(item)).url, local.url);
    fs.unlinkSync(file); assert.equal(await lib.find(item), null); assert.equal((await lib.scan(mediaDir)).items.length, 0);
    const model = require('../renderer/library-model.js');
    const sync = model.importedFolders({ folders: [{ name: '同步备份', sourceUrl: 'https://space.bilibili.com/1/favlist?fid=2',
      sourceSeen: ['BV0000000001:1', 'invalid'], items: [{ ...item, identifySource: 'manual' }] }] })[0];
    assert.equal(sync.items[0].identifySource, 'manual'); assert.deepEqual(sync.sourceSeen, ['BV0000000001:1']); assert(sync.sourceUrl);
    assert.equal(model.duplicateGroups([{ title: '歌曲', artist: '歌手' }, { title: '歌曲 (Live)', artist: '歌手' }]).length, 0);
  } finally {
    // This directory was created by mkdtemp within this workspace, never a user library.
    assert(dir.startsWith(path.join(root, 'validation') + path.sep));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function rendererChecks() {
  const { chromium } = require(process.env.CCMUSIC_PLAYWRIGHT || 'playwright');
  const browser = await chromium.launch({ executablePath: process.env.CCMUSIC_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } }), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => {
      const name = new URL(route.request().url()).pathname;
      if (!/^\/renderer\/[a-z.-]+\.(?:js|css|html)$/.test(name) && name !== '/assets/icon.png') return route.abort();
      const file = path.join(root, name);
      return route.fulfill({ body: fs.readFileSync(file), contentType: file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.css') ? 'text/css' : file.endsWith('.png') ? 'image/png' : 'text/javascript; charset=utf-8' });
    });
    await page.addInitScript(mockBridge);
    await page.addInitScript(() => {
      window.song = n => ({ bvid: 'BV' + String(n).padStart(10, '0'), cid: n, page: 1, partsCount: 1, title: '测试曲' + n, artist: '测试歌手', duration: 200 });
      if (!localStorage.mockLibrary) window.testLibrary.folders[0].items = [song(1), song(2), song(3)];
      window.api.getImportDraft = async () => JSON.parse(localStorage.importDraft || 'null');
      window.api.saveImportDraft = async value => { localStorage.importDraft = JSON.stringify(value); };
      window.api.localAudio = async item => ({ url: item.localId ? 'file:///local.wav' : 'https://audio.invalid/mock', local: !!item.localId, codecs: 'MP3' });
      window.api.getShortcuts = async () => ({ bindings: JSON.parse(localStorage.mockShortcuts || '{}') });
      window.api.setShortcuts = async bindings => { localStorage.mockShortcuts = JSON.stringify(bindings); };
      window.api.localLibraryList = async () => [];
      window.api.localLibraryScan = async () => ({ items: [1, 2].map(n => ({ localId: String(n).repeat(32), title: '本地' + n, artist: '本地歌手', album: '专辑', duration: 200 })), warnings: [] });
      window.api.readSharedPlaylist = async raw => {
        const fid = new URL(raw).searchParams.get('fid');
        if (fid === 'pause' && !localStorage.resumeImport) throw new Error('搜索失败：B 站需要验证');
        return { name: '收藏夹' + fid, tracks: (fid === '1' ? [1, 2, ...(localStorage.newFavorite ? [3] : [])] : [4]).map(n => ({ title: song(n).title, item: song(n) })) };
      };
    });
    await page.goto('http://library.test/renderer/index.html');
    await page.locator('#folders .folder').first().waitFor();
    await page.locator('#folders .folder').first().click();

    // Playlist drag reorder using actual HTML5 drag events from the browser.
    await page.locator('#list .row').first().dragTo(page.locator('#list .row').last(), { targetPosition: { x: 150, y: 65 } });
    assert.deepEqual(await page.evaluate(() => folder().items.map(item => item.cid)), [2, 3, 1]);
    await page.evaluate(async () => { folder().items[0].duration = 1800; loadQueue(folder().items, 0); await playQueueAt(0); });
    await page.locator('#likeButton').click();
    assert.equal(await page.locator('#likeButton').getAttribute('aria-pressed'), 'true');
    await page.locator('#likedNav').click();
    assert.equal(await page.locator('#list .row').count(), 1);
    assert.equal(await page.evaluate(() => folder().kind), 'likes');
    assert.equal(await page.locator('#folders .folder').count(), 2, 'special folders have dedicated navigation');

    await page.locator('#qBtn').click();
    await page.locator('#queueList .q-row').first().dragTo(page.locator('#queueList .q-row').last(), { targetPosition: { x: 100, y: 42 } });
    assert.deepEqual(await page.evaluate(() => S.queue.map(item => item.cid)), [3, 1, 2]);
    assert.equal(await page.evaluate(() => S.qcur), 2); assert.equal(await page.evaluate(() => playback.current.item.cid), 2);
    await page.locator('#qClose').click();
    await page.evaluate(() => { audio.currentTime = 37; audio.dispatchEvent(new Event('seeked')); });
    await page.reload();
    await page.locator('#folders .folder').first().waitFor();
    assert.equal(await page.evaluate(() => audio.src), '', 'restoring a position must not load/play audio');
    assert.equal(await page.locator('#bTitle').textContent(), '测试曲2');
    assert.equal(await page.locator('#cur').textContent(), '00:37');
    await page.locator('#play').click();
    await page.waitForFunction(() => playback.current?.item.cid === 2);
    assert.equal(await page.evaluate(() => audio.currentTime), 37);

    // Old short-song bookmarks are ignored; the threshold uses each segment's length.
    const memory = await page.evaluate(async () => {
      const rows = [];
      for (const duration of [200, 1199, 1200, 1500, 1799, 1800, 1801]) {
        const item = { ...song(10 + duration), duration };
        S.positions[itemKey(item)] = 45;
        const remembered = rememberedPosition(item);
        audio.currentTime = 0;
        await playTrack(item);
        audio.currentTime = 75; audio.dispatchEvent(new Event('seeked'));
        rows.push({ duration, remembered, saved: S.positions[itemKey(item)] ?? null });
      }
      const segment = { ...song(20), split: true, startSec: 2000, endSec: 2200, duration: 200, originalDuration: 7200 };
      S.positions[itemKey(segment)] = 2045;
      rows.push({ splitStart: rememberedPosition(segment) });
      return rows;
    });
    for (const row of memory.slice(0, -1)) {
      assert.equal(row.remembered, row.duration >= 1800 ? 45 : 0);
      assert.equal(row.saved, row.duration >= 1800 ? 75 : null);
    }
    assert.equal(memory.at(-1).splitStart, 2000);

    // Choosing duplicate removals remains safe if another operation changes row order.
    await page.evaluate(() => {
      const f = S.folders[0]; f.items = [song(1), { ...song(2), title: '测试曲1' }, song(3)];
      S.active = f.id; renderFolders(); renderList(); showView('library');
    });
    await page.locator('#libDuplicates').click();
    await page.locator('#duplicateRows input').nth(1).check();
    await page.evaluate(() => folder().items.unshift(song(5)));
    await page.locator('#duplicateRemove').click();
    assert.deepEqual(await page.evaluate(() => folder().items.map(item => item.cid)), [5, 1, 3]);
    await page.locator('#undoButton').click();
    assert.deepEqual(await page.evaluate(() => folder().items.map(item => item.cid)), [5, 1, 2, 3]);

    await page.locator('#localNav').click(); await page.locator('#localScan').click();
    await page.waitForFunction(() => folder().items.length === 2);
    await page.evaluate(async () => { window.api.playurl = async () => { throw new Error('local song must not fetch Bilibili'); }; loadQueue(folder().items, 0); await playQueueAt(0); await playQueueAt(1); });
    assert.equal(await page.locator('#bTitle').textContent(), '本地2');
    assert.equal(await page.evaluate(() => S.history.filter(row => row.item.localId).length), 2);
    assert.equal(await page.locator('#list [data-dl]').first().textContent(), '位置');
    assert.equal(await page.locator('#libPickDownload').isDisabled(), true);

    // Two independent jobs, persisted through restart, individually saved to playlists.
    await page.locator('#libImport').click(); await page.getByText('导入歌单…', { exact: true }).click();
    await page.locator('#playlistSource').fill('https://space.bilibili.com/1/favlist?fid=1\nhttps://space.bilibili.com/1/favlist?fid=2');
    await page.locator('#playlistAction').click();
    await page.waitForFunction(() => playlistImportJobs.size === 2 && [...playlistImportJobs.values()].every(job => job.state === 'ready'));
    await page.reload(); await page.locator('#folders .folder').first().waitFor();
    await page.waitForFunction(() => playlistImportJobs.size === 2);
    await page.locator('#libImport').click(); await page.getByText('导入歌单…', { exact: true }).click(); await page.locator('#playlistAction').click();
    assert.equal(await page.evaluate(() => folder().items.length), 2);
    assert.equal(await page.evaluate(() => playlistImportJobs.size), 1);
    assert.equal(await page.evaluate(() => folder().sourceSeen.length), 2);
    await page.locator('#libImport').click(); await page.getByText('导入歌单…', { exact: true }).click(); await page.locator('#playlistAction').click();
    assert.equal(await page.evaluate(() => folder().name), '收藏夹2');
    assert.equal(await page.evaluate(() => playlistImportJobs.size), 0);

    // Incremental sync retains renamed metadata and intentional local removals.
    await page.evaluate(() => {
      const f = S.folders.find(f => f.name === '收藏夹1'); f.items[0].title = '手动歌名'; f.items[0].songCover = 'https://example.com/custom.jpg';
      f.items.splice(1, 1); S.active = f.id; localStorage.newFavorite = '1'; save(); renderList();
    });
    await page.locator('#libSync').click();
    await page.waitForFunction(() => playlistImportJob?.state === 'ready');
    assert.equal(await page.evaluate(() => playlistImportJob.items.length), 1);
    await page.locator('#libImport').click(); await page.getByText('导入歌单…', { exact: true }).click(); await page.locator('#playlistAction').click();
    assert.deepEqual(await page.evaluate(() => folder().items.map(item => item.cid)), [1, 3]);
    assert.equal(await page.evaluate(() => folder().items[0].title), '手动歌名');
    assert.equal(await page.evaluate(() => folder().items[0].songCover), 'https://example.com/custom.jpg');
    await page.locator('#libSync').click(); await page.waitForFunction(() => playlistImportJob?.state === 'ready');
    assert.equal(await page.evaluate(() => playlistImportJob.items.length), 0);
    await page.locator('#libImport').click(); await page.getByText('导入歌单…', { exact: true }).click(); await page.locator('#playlistAction').click();
    assert.equal(await page.evaluate(() => folder().items.length), 2);

    // Verification pauses the queue; a queued job cannot silently issue more requests.
    await page.locator('#libImport').click(); await page.getByText('导入歌单…', { exact: true }).click();
    await page.locator('#playlistSource').fill('https://space.bilibili.com/1/favlist?fid=pause\nhttps://space.bilibili.com/1/favlist?fid=3');
    await page.locator('#playlistAction').click();
    await page.waitForFunction(() => [...playlistImportJobs.values()].some(job => job.state === 'paused'));
    assert.deepEqual(await page.evaluate(() => [...playlistImportJobs.values()].map(job => job.state)), ['paused', 'queued']);
    await page.locator('#libImport').click(); await page.getByText('导入歌单…', { exact: true }).click(); await page.evaluate(() => { localStorage.resumeImport = '1'; });
    await page.locator('#playlistResume').click();
    await page.waitForFunction(() => [...playlistImportJobs.values()].every(job => job.state === 'ready'));

    await page.evaluate(() => { $('#settingsModal').hidden = false; });
    await page.locator('#customShortcuts summary').click();
    await page.locator('[data-shortcut="like"]').press('Control+Alt+L');
    await page.locator('#saveShortcuts').click();
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.mockShortcuts).like), 'Control+Alt+L');
    await page.locator('[data-shortcut="like"]').press('Backspace'); await page.locator('#saveShortcuts').click();
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.mockShortcuts).like), '');
    await page.locator('#settingsClose').click();
    await page.evaluate(() => { $('#tasksPanel').hidden = true; });
    await page.locator('#localNav').click();
    await page.screenshot({ path: path.join(root, 'validation/library-features-local.png') });
    await page.setViewportSize({ width: 900, height: 600 });
    await page.screenshot({ path: path.join(root, 'validation/library-features-small.png') });
    const controls = await page.locator('.bar').evaluate(bar => [...bar.querySelectorAll('button, input')]
      .filter(node => node.getClientRects().length).map(node => ({ id: node.id, left: node.getBoundingClientRect().left, right: node.getBoundingClientRect().right })));
    assert(controls.every(control => control.left >= 0 && control.right <= 900), 'player controls fit minimum window width: ' + JSON.stringify(controls));
    assert.deepEqual(errors, []);
    console.log('PASS favorites, real DOM drag sorting, paused position restore, duplicate selection races/undo, local playback/history, multiple import jobs/restart, incremental sync/metadata retention, verification queue pause/resume, shortcut editor');
  } finally { await browser.close(); }
}
nativeChecks().then(rendererChecks).catch(error => { console.error(error); process.exitCode = 1; });
