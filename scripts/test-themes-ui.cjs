// Real renderer theme controls, persisted/system appearance and mini isolation. No Electron/audio.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { mockBridge } = require('./test-ui.cjs'), T = require('../renderer/themes.js');
const root = path.resolve(__dirname, '..');
function rgb(hex) { return 'rgb(' + hex.slice(1).match(/../g).map(s => parseInt(s, 16)).join(', ') + ')'; }
function luminance(hex) { return hex.slice(1).match(/../g).map(v => parseInt(v, 16) / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4).reduce((s, v, i) => s + v * [.2126, .7152, .0722][i], 0); }
function contrast(a, b) { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); }
for (const mode of ['light', 'dark']) for (const color of Object.keys(T.palettes)) {
  const { values: v } = T.tokens({ mode, color }, false);
  for (const surface of ['--bg', '--panel', '--accent-soft']) for (const text of ['--text', '--muted']) assert(contrast(v[surface], v[text]) >= 4.5, mode + color + surface + text);
  assert(contrast(v['--accent'], v['--on-accent']) >= 4.5);
}
assert.deepEqual(T.clean({ mode: 'invalid', color: '__proto__' }), { mode: 'light', color: 'pink' });
(async () => {
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
      if (localStorage.holdThemeLibrary) api.getLibrary = () => new Promise(() => {});
    });
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto('http://themes.test/renderer/index.html'); await page.locator('#folders .folder').first().waitFor();
    assert.equal(await page.evaluate(() => AppTheme.state().mode), 'light', 'new users retain the light appearance');
    await page.evaluate(async () => {
      const item = { bvid:'BV0000000001', cid:1, page:1, title:'晴天', artist:'周杰伦', duration:269, cover:'/assets/icon.png', identifySource:'manual' };
      S.folders[0].items = [item, { ...item, bvid:'BV0000000002', cid:2, title:'普通朋友', artist:'陶喆' }];
      S.active = S.folders[0].id; renderFolders(); renderList(); showView('library'); loadQueue([item], 0); await playQueueAt(0); audio.currentTime = 42;
      window.originalThemeAudio = audio; window.originalThemeSequence = playback.sequence; openSettings();
    });
    async function verify(mode, color) {
      const v = T.tokens({ mode, color }, false).values;
      const styles = await page.evaluate(() => {
        const bg = selector => getComputedStyle(document.querySelector(selector)).backgroundColor;
        return { body:bg('body'), side:bg('.side'), modal:bg('.settings-box'), filter:bg('#libFilter'), button:bg('#playAll'), bar:bg('.bar'),
          text:getComputedStyle(document.body).color, foreground:getComputedStyle($('#playAll')).color,
          sequence:playback.sequence, sameAudio:audio === originalThemeAudio, time:audio.currentTime };
      });
      assert.equal(styles.body, rgb(v['--bg']));
      for (const field of ['side', 'modal', 'filter']) assert.equal(styles[field], rgb(v['--panel']), mode + color + field);
      assert.equal(styles.bar, rgb(v['--bar'])); assert.equal(styles.button, rgb(v['--accent'])); assert.equal(styles.foreground, rgb(v['--on-accent']));
      assert(styles.sameAudio); assert.equal(styles.time, 42); assert.equal(styles.sequence, await page.evaluate(() => originalThemeSequence));
    }
    for (const mode of ['light', 'dark']) {
      await page.locator('#themeMode').selectOption(mode);
      for (const color of Object.keys(T.palettes)) { await page.locator('#themeColor').selectOption(color); await verify(mode, color); }
    }
    await page.locator('#themeMode').selectOption('system'); await page.emulateMedia({ colorScheme:'light' });
    await page.waitForFunction(() => document.documentElement.dataset.appearance === 'light');
    await page.emulateMedia({ colorScheme:'dark' }); await page.waitForFunction(() => document.documentElement.dataset.appearance === 'dark');
    await page.locator('#themeMode').selectOption('light'); await page.emulateMedia({ colorScheme:'dark' });
    assert.equal(await page.evaluate(() => document.documentElement.dataset.appearance), 'light');
    await page.locator('#themeMode').selectOption('dark'); await page.locator('#themeColor').selectOption('green');
    await page.waitForTimeout(200);
    assert.equal(await page.locator('#mediaKeys + .slider').evaluate(el => getComputedStyle(el).backgroundColor), rgb(T.tokens({mode:'dark',color:'green'}).values['--accent']));
    await page.screenshot({ path:path.join(root,'validation/ui-themes-settings-dark.png') });
    await page.locator('#settingsClose').click();
    await page.evaluate(() => {
      api.winCoverColor = async () => ({background:[36,70,125],primary:[255,255,255],secondary:[220,230,245],accent:[245,210,150],accentText:[20,30,50],track:[95,110,140],error:[155,30,45],errorText:[255,255,255],opacity:1,dark:true});
      renderWindowMode({mini:true,layout:'compact',revision:100,pinned:true});
    });
    await page.waitForFunction(() => document.body.style.getPropertyValue('--mini-color') === '36, 70, 125');
    await page.evaluate(() => AppTheme.configure({mode:'light',color:'cream'}));
    assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgb(36, 70, 125)', 'main theme cannot overwrite artwork colour');
    assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor), 'rgba(0, 0, 0, 0)', 'no painted corners around the mini outline');
    await page.evaluate(() => renderWindowMode({mini:false,layout:'compact',revision:101,pinned:true}));
    assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), rgb(T.tokens({mode:'light',color:'cream'}).values['--bg']));
    await page.evaluate(() => closeVolume());
    await page.screenshot({ path:path.join(root,'validation/ui-themes-cream.png') });
    await page.evaluate(() => AppTheme.configure({mode:'dark',color:'blue'}));
    await page.screenshot({ path:path.join(root,'validation/ui-themes-blue-dark.png') });
    await page.evaluate(() => { AppTheme.configure({mode:'dark',color:'blue'}); localStorage.holdThemeLibrary='1'; });
    await page.reload(); await page.locator('#themeMode').waitFor({ state:'attached' });
    assert.equal(await page.evaluate(() => document.documentElement.dataset.appearance), 'dark', 'saved theme applies before library/network init resolves');
    assert.equal(await page.locator('#themeColor').inputValue(), 'blue');
    await page.evaluate(() => { localStorage.removeItem('holdThemeLibrary'); }); await page.reload();
    await page.locator('#folders .folder').first().waitFor();
    await page.evaluate(() => openSettings());
    await page.locator('#themeColor').selectOption('purple');
    await page.setViewportSize({width:900,height:600});
    await page.waitForTimeout(200);
    assert(await page.locator('#appearanceSettings').evaluate(el => el.scrollWidth <= el.clientWidth));
    await page.screenshot({path:path.join(root,'validation/ui-themes-small.png')});
    await page.evaluate(() => {
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function(key,value) { if (key === 'appearanceV1') throw new Error('storage full'); return original.call(this,key,value); };
    });
    await page.locator('#themeColor').selectOption('green'); assert.equal(await page.locator('#themeColor').inputValue(), 'purple');
    assert((await page.locator('#themeStatus').textContent()).includes('无法保存'));
    assert.deepEqual(errors, []);
    console.log('PASS 10 light/dark palettes and text contrast, complete themed surfaces, system changes/fixed override, persistence before data load, playback continuity, mini cover/corner isolation, 900px settings and failed-save rollback');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
