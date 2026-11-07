const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict'), { EventEmitter } = require('node:events');
const { mockBridge } = require('./test-ui.cjs'), { createAppUpdates } = require('../app-updates.cjs');
const root = path.resolve(__dirname, '..');
const feeds = { domestic: { provider: 'generic', url: 'https://cnb.cool/test/ccmusic/-/git/raw/main/updates/', useMultipleRangeRequest: false }, github: { provider: 'github', owner: 'Quinloan', repo: 'ccMusic-Bilibili-Player' } };
async function run() {
  const { chromium } = require(process.env.CCMUSIC_PLAYWRIGHT || 'playwright');
  const browser = await chromium.launch({ executablePath: process.env.CCMUSIC_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
  const dir = fs.mkdtempSync(path.join(root, 'validation/update-ui-')); let controller, delivery = Promise.resolve();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } }), errors = [], updater = new EventEmitter(); let calls = 0, installs = 0, rejectDownload, busy = true;
    page.on('pageerror', e => errors.push(e.message));
    updater.setFeedURL = feed => { updater.selectedFeed = feed; };
  updater.checkForUpdates = async () => { updater.emit('update-available', { version: '1.7.0', releaseNotes: '1. MP3下载：统一保存为MP3\n2. 最近播放：找回听过的歌曲\n<script>alert(1)</script>' }); };
    updater.downloadUpdate = () => { calls++; return new Promise((_r, reject) => { rejectDownload = reject; }); };
    updater.quitAndInstall = () => { installs++; };
    controller = createAppUpdates({ feeds, updater, version: '1.6.3', preferences: path.join(dir, 'settings.json'),
      emit: state => { delivery = delivery.then(() => page.evaluate(s => emitAppUpdate(s), state)); },
      beforeInstall: async () => { if (busy) throw Error('请先完成或取消下载任务'); } });
    await page.exposeFunction('updaterAction', (action, arg) => controller[action](arg));
    await page.route('**/*', route => {
      const name = new URL(route.request().url()).pathname;
      if (!/^\/renderer\/[a-z.-]+\.(?:js|css|html)$/.test(name) && name !== '/assets/icon.png') return route.abort();
      const file = path.join(root, name); if (!fs.existsSync(file)) return route.abort();
      return route.fulfill({ body: fs.readFileSync(file), contentType: file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.css') ? 'text/css' : file.endsWith('.png') ? 'image/png' : 'text/javascript; charset=utf-8' });
    });
    await page.addInitScript(mockBridge);
    await page.addInitScript(() => {
      api.updateState = () => updaterAction('snapshot'); api.updateConfigure = on => updaterAction('configure', on);
      api.updateSource = source => updaterAction('setSource', source);
      api.checkUpdate = () => updaterAction('check'); api.updateDownload = () => updaterAction('download'); api.updateInstall = () => updaterAction('install');
    });
    await page.goto('http://updater.test/renderer/index.html'); await page.locator('#folders .folder').first().waitFor();
    await page.evaluate(() => openUpdateSettings()); await delivery;
    await page.getByRole('button', { name: '立即更新', exact: true }).waitFor();
    assert.equal(await page.locator('#updateSource').inputValue(), 'domestic', 'domestic is the default');
    assert.equal(updater.selectedFeed.provider, 'generic');
    await page.locator('#updateSource').selectOption('github');
    await page.waitForFunction(() => appUpdateState.source === 'github' && appUpdateState.status === 'available');
    assert.equal(updater.selectedFeed.provider, 'github');
    await page.locator('#updateSource').selectOption('domestic');
    await page.waitForFunction(() => appUpdateState.source === 'domestic' && appUpdateState.status === 'available');
    assert.equal(calls, 0); assert.equal(await page.locator('.update-notes pre script').count(), 0);
    await page.screenshot({ path: path.join(root, 'validation/ui-app-update-available.png') });
    await page.locator('label.switch').filter({ has: page.locator('#autoCheck') }).click(); await delivery; assert.equal(controller.snapshot().autoCheck, true);
    await page.locator('label.switch').filter({ has: page.locator('#autoCheck') }).click(); await delivery; assert.equal(controller.snapshot().autoCheck, false);
    await page.locator('#updateAction').click(); await delivery;
    updater.emit('download-progress', { percent: 47.5, transferred: 50 * 1048576, total: 105 * 1048576 }); await delivery;
    assert.equal(await page.getByRole('progressbar', { name: '软件更新下载进度' }).getAttribute('value'), '47.5');
    assert.equal(await page.locator('#checkBtn').isDisabled(), true);
    assert.equal(await page.locator('#updateSource').isDisabled(), true, 'cannot switch sources midway through a download');
    await page.screenshot({ path: path.join(root, 'validation/ui-app-update-downloading.png') });
    rejectDownload(Error('网络中断，请重试')); await new Promise(setImmediate); await delivery;
    await page.getByRole('button', { name: '重试下载', exact: true }).click(); await delivery; assert.equal(calls, 2);
    updater.emit('update-downloaded', { version: '1.7.0' }); await delivery;
    assert.equal(installs, 0);
    await page.getByRole('button', { name: '重启完成更新', exact: true }).click(); await delivery;
    assert.equal(installs, 0); assert.match(await page.locator('.update-error').textContent(), /取消下载/);
    busy = false; await page.getByRole('button', { name: '重启完成更新', exact: true }).click(); await delivery; assert.equal(installs, 1);
    assert.equal(await page.getByText('正在重启更新…', { exact: true }).isVisible(), true);
    assert.deepEqual(errors, []);
    console.log('PASS: actual controller -> real DOM check/notes, explicit download/progress/failure/retry, preference, restart guard/install, safe text; no Electron/network/installer');
  } finally { controller?.dispose(); await delivery; await browser.close(); const file = path.join(dir, 'settings.json'); if (fs.existsSync(file)) fs.unlinkSync(file); fs.rmdirSync(dir); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
