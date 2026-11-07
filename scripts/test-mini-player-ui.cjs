// Actual renderer controls with mocked native window resizing and media; no Electron/audio.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { mockBridge } = require('./test-ui.cjs');
const { MINI_SIZE, MINI_SIZES } = require('../window-mode.cjs');
const { themeFromColors, extractPalette } = require('../cover-palette.cjs');
const root = path.resolve(__dirname, '..');
const lightTheme = themeFromColors([150,192,224]), darkTheme = themeFromColors([18,46,86]);
(async () => {
  const { chromium } = require(process.env.CCMUSIC_PLAYWRIGHT || 'playwright');
  const browser = await chromium.launch({ executablePath: process.env.CCMUSIC_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1120, height: 760 } }), errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.route('**/*', route => {
      const name = new URL(route.request().url()).pathname;
      if (!/^\/renderer\/[a-z.-]+\.(?:js|css|html)$/.test(name) && name !== '/assets/icon.png') return route.abort();
      const file = path.join(root, name); if (!fs.existsSync(file)) return route.abort();
      return route.fulfill({ body: fs.readFileSync(file), contentType: file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.css') ? 'text/css' : file.endsWith('.png') ? 'image/png' : 'text/javascript; charset=utf-8' });
    });
    let state = { mini: false, pinned: true, revision: 0, glass: false, layout: 'compact' };
    await page.exposeFunction('miniThemeFixture', color => themeFromColors(color));
    await page.exposeFunction('nativeWindowMode', async (action, value) => {
      if (action === 'get') return state;
      if (action === 'mini') { state = { ...state, mini: value, glass: false, revision: state.revision + 1 }; await page.setViewportSize(value ? MINI_SIZES[state.layout] : { width: 1120, height: 760 }); }
      if (action === 'layout') { state = { ...state, layout: value, revision: state.revision + 1 }; if (state.mini) await page.setViewportSize(MINI_SIZES[value]); }
      if (action === 'pin') state = { ...state, pinned: value, revision: state.revision + 1 };
      return state;
    });
    await page.addInitScript(mockBridge);
    await page.addInitScript(() => {
      api.winModeState = () => nativeWindowMode('get');
      api.winMini = async on => { const state = await nativeWindowMode('mini', on); window.emitWindowMode?.(state); return state; };
      api.winPin = async on => { const state = await nativeWindowMode('pin', on); window.emitWindowMode?.(state); return state; };
      api.winMiniLayout = async layout => { const state = await nativeWindowMode('layout', layout); window.emitWindowMode?.(state); return state; };
      api.onWinMode = callback => { window.emitWindowMode = callback; };
      api.winClose = async () => { window.testWindowClosed = true; };
      window.testMiniColors = [];
      api.winCoverColor = async source => { testMiniColors.push(source); await new Promise(resolve => setTimeout(resolve, source.includes('old-cover') ? 200 : 10)); return source.includes('failed-cover') ? null : source.includes('malformed-cover') ? { background: [0,0,0], opacity: Infinity } : miniThemeFixture(source.includes('dark-cover') ? [18, 46, 86] : source.includes('old-cover') ? [220, 175, 155] : [150, 192, 224]); };
    });
    await page.goto('http://mini.test/renderer/index.html'); await page.locator('#folders .folder').first().waitFor();
    await page.locator('#homeHot .hcard').first().waitFor();
    await page.evaluate(async () => {
      const item = { bvid: 'BV1CaPrz7EL6', cid: 1, page: 1, partsCount: 1, cover: '/assets/icon.png',
        title: '晴天 · 小窗播放验证', artist: '周杰伦', duration: 240, split: true, startSec: 600, endSec: 840 };
      loadQueue([item, { ...item, title: '第二首歌', startSec: 840, endSec: 1080 }], 0);
      await playQueueAt(0); window.originalAudio = audio;
      audio.currentTime = 630; playback.seekTarget = null; audio.ontimeupdate();
      window.originalPlaySequence = playback.sequence;
      window.originalView = S.view;
    });
    assert.equal(await page.evaluate(() => testMiniColors.length), 0, 'normal view does not fetch cover palettes');
    await page.locator('#wMini').click();
    await page.waitForFunction(() => miniModeState.mini && !miniModeBusy);
    assert.equal(await page.locator('.app').isVisible(), false);
    assert.equal(await page.locator('#bTitle').textContent(), '晴天 · 小窗播放验证');
    assert.equal(await page.locator('#bUp').textContent(), '周杰伦');
    assert.equal(await page.evaluate(() => audio === originalAudio && playback.sequence === originalPlaySequence && audio.currentTime === 630 && !audio.paused), true, 'switch never reloads or restarts audio');
    const visibleControls = ['#bCover', '#bTitle', '#bUp', '#prev', '#play', '#next', '#seek', '#vol', '#miniLayout', '#miniPin', '#miniRestore', '#miniClose'];
    assert.deepEqual(await page.evaluate(selectors => selectors.filter(s => {
      const el = document.querySelector(s), r = el.getBoundingClientRect();
      return !r.width || !r.height || r.left < 0 || r.top < 0 || r.right > innerWidth || r.bottom > innerHeight;
    }), visibleControls), []);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight), true);
    await page.waitForFunction(expected => document.body.style.getPropertyValue('--mini-color') === expected, lightTheme.background.join(', '));
    assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), `rgb(${lightTheme.background.join(', ')})`, 'cover-colour surface is fully opaque');
    assert.equal(await page.evaluate(() => !document.body.classList.contains('mini-glass') && getComputedStyle(document.body).backgroundImage === 'none'), true, 'no glass backdrop or background gradient');
    assert.equal(await page.evaluate(() => getComputedStyle(document.body).borderRadius), '20px', 'round outline remains without Acrylic');
    assert.equal(await page.evaluate(() => getComputedStyle(document.body).borderWidth), '0px', 'no fixed white CSS frame');
    assert.equal(await page.locator('#miniPin').evaluate(el => getComputedStyle(el).backgroundColor), 'rgba(0, 0, 0, 0)', 'pinned state does not add a hard white tile');
    assert.deepEqual(page.viewportSize(), MINI_SIZE, 'renderer uses the actual compact native window dimensions');
    await page.locator('#miniLayout').click(); await page.waitForFunction(() => miniModeState.layout === 'square' && !miniModeBusy);
    assert.deepEqual(page.viewportSize(), MINI_SIZES.square);
    assert.equal(await page.locator('#miniLayout').getAttribute('aria-label'), '切换为紧凑小窗');
    assert.deepEqual(await page.evaluate(selectors => selectors.filter(s => { const r = document.querySelector(s).getBoundingClientRect(); return !r.width || !r.height || r.left < 0 || r.top < 0 || r.right > innerWidth || r.bottom > innerHeight; }), visibleControls), []);
    assert.equal(await page.evaluate(() => audio === originalAudio && playback.sequence === originalPlaySequence && audio.currentTime === 630), true, 'shape switching never reloads audio or changes its position');
    await page.screenshot({ path: path.join(root, 'validation/ui-mini-square.png') });
    await page.locator('#miniLayout').click(); await page.waitForFunction(() => miniModeState.layout === 'compact' && !miniModeBusy);
    assert.deepEqual(page.viewportSize(), MINI_SIZES.compact);
    assert.equal(await page.locator('#miniLayout').getAttribute('aria-label'), '切换为方形小窗');
    await page.evaluate(() => document.querySelector('#bCover').src = '/assets/icon.png?dark-cover');
    await page.waitForFunction(expected => document.body.style.getPropertyValue('--mini-color') === expected, darkTheme.background.join(', '));
    assert.equal(await page.locator('#bTitle').evaluate(el => getComputedStyle(el).color), `rgb(${darkTheme.primary.join(', ')})`, 'dark covers use the paired cover-colour foreground');
    await page.screenshot({ path: path.join(root, 'validation/ui-mini-dark.png') });
    await page.evaluate(() => document.querySelector('#bCover').src = '/assets/icon.png?old-cover');
    await page.waitForTimeout(20);
    assert.equal(await page.evaluate(() => document.body.style.getPropertyValue('--mini-color')), darkTheme.background.join(', '), 'retain the previous complete theme while the next artwork loads');
    await page.evaluate(() => document.querySelector('#bCover').src = '/assets/icon.png?new-cover');
    await page.waitForTimeout(240);
    assert.equal(await page.evaluate(() => document.body.style.getPropertyValue('--mini-color')), lightTheme.background.join(', '), 'late previous-song palette cannot overwrite the current cover');
    assert.equal(await page.evaluate(() => document.body.classList.contains('mini-dark')), lightTheme.dark, 'text polarity follows the current cover instead of forcing dark mode');
    await page.evaluate(() => document.querySelector('#bCover').src = '/assets/icon.png?failed-cover');
    await page.waitForTimeout(40);
    assert.equal(await page.evaluate(() => document.body.style.getPropertyValue('--mini-color')), '', 'unavailable artwork resets to neutral instead of retaining the previous song colour');
    await page.evaluate(() => document.querySelector('#bCover').src = '/assets/icon.png?malformed-cover');
    await page.waitForTimeout(40);
    assert.equal(await page.evaluate(() => ['--text','--muted','--accent','--mini-color'].every(name => !document.body.style.getPropertyValue(name))), true, 'an incomplete or invalid theme cannot leave a half-updated colour scheme');
    await page.evaluate(() => document.querySelector('#bCover').src = '/assets/icon.png');
    await page.waitForFunction(expected => document.body.style.getPropertyValue('--mini-color') === expected, lightTheme.background.join(', '));
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.bar')).backgroundColor), 'rgba(0, 0, 0, 0)');
    assert.equal(await page.evaluate(() => ['body', '.bar', '#bTitle', '#bCover', '#play', '#seek'].every(selector => getComputedStyle(document.querySelector(selector)).opacity === '1')), true, 'the whole player surface and UI are fully opaque');
    await page.screenshot({ path: path.join(root, 'validation/ui-mini-player.png') });
    await page.screenshot({ path: path.join(root, 'validation/ui-mini-player-translucent.png'), omitBackground: true });
    await page.locator('#play').click(); assert.equal(await page.evaluate(() => audio.paused), true);
    await page.locator('#play').click(); assert.equal(await page.evaluate(() => audio.paused), false);
    await page.locator('#miniPin').click(); await page.waitForFunction(() => miniModeState.pinned === false);
    assert.equal(await page.locator('#miniPin').getAttribute('aria-pressed'), 'false');
    await page.locator('#seek').fill('500');
    assert.equal(await page.evaluate(() => audio.currentTime), 720, 'mini seeking retains absolute segment offset');
    assert.equal(await page.locator('#seek').evaluate(el=>el.style.getPropertyValue('--range-progress')), '50%', 'Material track follows seeking');
    await page.locator('#vol').fill('65');
    assert.equal(await page.evaluate(() => document.querySelector('#vol').value), '65');
    assert.equal(await page.locator('#vol').evaluate(el=>el.style.getPropertyValue('--range-progress')), '65%', 'Material volume track follows input');
    await page.locator('#next').click(); await page.waitForFunction(() => S.qcur === 1 && playback.current?.item.title === '第二首歌');
    assert.equal(await page.locator('#bTitle').textContent(), '第二首歌');
    await page.locator('#prev').click(); await page.waitForFunction(() => S.qcur === 0);
    await page.locator('#miniRestore').click(); await page.waitForFunction(() => !miniModeState.mini && !miniModeBusy);
    assert.equal(await page.evaluate(() => S.view === originalView && audio === originalAudio), true);
    assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgb(245, 245, 247)', 'main interface stays opaque');
    assert.equal(await page.evaluate(() => document.body.classList.contains('mini-glass')), false);
    assert.equal(await page.evaluate(() => ['--text','--muted','--accent','--mini-track','--mini-error','--mini-accent-text'].every(name => !document.body.style.getPropertyValue(name))), true, 'returning to the main interface clears the entire artwork theme');
    assert.equal(await page.locator('#vol').inputValue(), '65');
    // Native/tray state and renderer refresh are synchronized, including pin state.
    await page.locator('#wMini').click(); await page.waitForFunction(() => miniModeState.mini && !miniModeBusy);
    await page.locator('#miniLayout').click(); await page.waitForFunction(() => miniModeState.layout === 'square' && !miniModeBusy);
    await page.reload(); await page.waitForFunction(() => miniModeState.mini);
    assert.equal(await page.evaluate(() => miniModeState.layout), 'square', 'reload keeps the native shape preference');
    assert.equal(await page.locator('#miniPin').getAttribute('aria-pressed'), 'false');
    await page.evaluate(() => emitWindowMode({ mini: false, pinned: true, revision: 0 }));
    assert.equal(await page.evaluate(() => miniModeState.mini), true, 'late state must not roll back the current mode');
    // A background split result may open a dialog: restore a usable full-size window.
    await page.evaluate(() => { document.querySelector('#editModal').hidden = false; });
    await page.waitForFunction(() => !miniModeState.mini && !miniModeBusy);
    assert.equal(page.viewportSize().width, 1120);
    await page.evaluate(() => { document.querySelector('#editModal').hidden = true; });
    await page.keyboard.press('Control+Shift+M'); await page.waitForFunction(() => miniModeState.mini && !miniModeBusy);
    await page.keyboard.press('Escape'); await page.waitForFunction(() => !miniModeState.mini && !miniModeBusy);
    // Long titles remain within the small card and failure feedback stays actionable.
    await page.locator('#wMini').click(); await page.waitForFunction(() => miniModeState.mini && !miniModeBusy);
    await page.evaluate(() => { document.querySelector('#bTitle').textContent = '很长的歌曲名称'.repeat(25); document.querySelector('#bUp').textContent = '很长的歌手名称'; setPlaybackStatus('播放失败 · 点击重试', true); });
    assert.equal(await page.locator('#playStatus').isVisible(), true);
    assert.equal(await page.locator('#bUp').isVisible(), false, 'error replaces the secondary artist line instead of overlapping playback buttons');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(root, 'validation/ui-mini-player-long-title.png') });
    // Optional offline real-cover check, generated by probe-cover-art --palette.
    // Run the production extractor, not the simple theme fixtures above.
    const preview = path.join(root, 'validation/palette-preview.html');
    if (fs.existsSync(preview)) {
      const images = [...fs.readFileSync(preview, 'utf8').matchAll(/<img src="(data:image\/[^\"]+)"/g)].map(match => match[1]);
      const image = images.at(-1);
      if (image) {
        const rgba = await page.evaluate(async data => {
          const bitmap = new Image(); bitmap.src = data; await bitmap.decode();
          const canvas = document.createElement('canvas'); canvas.width = canvas.height = 48;
          const ctx = canvas.getContext('2d'); ctx.drawImage(bitmap, 0, 0, 48, 48);
          return [...ctx.getImageData(0, 0, 48, 48).data];
        }, image);
        const bgra = Buffer.from(rgba);
        for (let i = 0; i < bgra.length; i += 4) [bgra[i], bgra[i + 2]] = [bgra[i + 2], bgra[i]];
        const theme = extractPalette(bgra, 48, 48);
        await page.route('http://mini.test/assets/material-test.jpg', route => route.fulfill({ body: Buffer.from(image.split(',')[1], 'base64'), contentType: 'image/jpeg' }));
        await page.evaluate(theme => {
          const previous = api.winCoverColor;
          api.winCoverColor = source => source.includes('material-test') ? Promise.resolve(theme) : previous(source);
          window.materialAudio = audio; window.materialSequence = playback.sequence;
          setPlaybackStatus('');
          document.querySelector('#bTitle').textContent = '流沙';
          document.querySelector('#bUp').textContent = '陶喆';
          document.querySelector('#bCover').src = '/assets/material-test.jpg';
        }, theme);
        await page.waitForFunction(expected => document.body.style.getPropertyValue('--mini-color') === expected, theme.background.join(', '));
        assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), `rgb(${theme.background.join(', ')})`, 'actual cover uses an opaque cover-colour surface');
        assert.equal(await page.locator('#bTitle').evaluate(el => getComputedStyle(el).color), `rgb(${theme.primary.join(', ')})`);
        assert.equal(await page.locator('#play').evaluate(el => getComputedStyle(el).backgroundColor), `rgb(${theme.accent.join(', ')})`);
        assert.equal(await page.locator('#play').evaluate(el => getComputedStyle(el).color), `rgb(${theme.accentText.join(', ')})`);
        for (const layout of ['square', 'compact']) {
          if (state.layout !== layout) { await page.locator('#miniLayout').click(); await page.waitForFunction(layout => miniModeState.layout === layout && !miniModeBusy, layout); }
          await page.locator('#bCover').evaluate(el => el.decode());
          await page.evaluate(()=>document.activeElement?.blur());
          await page.mouse.move(1,70);
          await page.screenshot({ path: path.join(root, `validation/ui-mini-cover-direct-${layout}.png`) });
        }
        assert.equal(await page.evaluate(() => audio === materialAudio && playback.sequence === materialSequence), true, 'real cover palette does not restart playback');
      }
    }
    await page.locator('#miniClose').click(); assert.equal(await page.evaluate(() => testWindowClosed), true);
    assert.deepEqual(errors, []);
    console.log('PASS: compact real DOM layout, original audio/position continuity, play/pause/skip/volume/segment seeking, pin/native sync, return/reload/stale events, modal auto-restore, keyboard, long title/errors and close; IPC/media mocked');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
