// Actual startup/QR/reminder DOM; all account, network and media calls mocked.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { mockBridge } = require('./test-ui.cjs');
const root = path.resolve(__dirname, '..');
async function makePage(browser, options = {}) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 }, serviceWorkers: 'block' });
  page.errors = []; page.on('pageerror', e => page.errors.push(e.message));
  await page.route('**/*', route => {
    const name = new URL(route.request().url()).pathname;
    if (!/^\/renderer\/[a-z.-]+\.(?:html|css|js)$/.test(name) && name !== '/assets/icon.png') return route.abort();
    const file = path.join(root, name); if (!fs.existsSync(file)) return route.abort();
    return route.fulfill({ body: fs.readFileSync(file), contentType: name.endsWith('.html') ? 'text/html; charset=utf-8' : name.endsWith('.css') ? 'text/css' : name.endsWith('.png') ? 'image/png' : 'text/javascript; charset=utf-8' });
  });
  await page.addInitScript(mockBridge, { startupLoginReminder: true });
  await page.addInitScript(options => {
    if (!localStorage.loginFixtureInitialized) {
      localStorage.loginFixtureInitialized = '1';
      if (options.disabled) localStorage.startupLoginReminder = '0';
    }
    window.loginReply = options.status || { logged: false };
    window.pendingLogins = []; window.loginChecks = 0; window.qrRequests = 0;
    window.api.loginState = async () => {
      window.loginChecks++;
      if (window.testLogged) return { logged: true, name: '已登录用户' };
      if (options.deferred) return new Promise(resolve => window.pendingLogins.push(resolve));
      if (options.throw) throw Error('网络不可用');
      return window.loginReply;
    };
    window.api.loginQrcode = async () => { window.qrRequests++; return { key: 'mock', dataUrl: '' }; };
  }, options);
  await page.goto('http://ccmusic.test/renderer/index.html'); await page.locator('#folders .folder').first().waitFor();
  return page;
}
async function run() {
  fs.mkdirSync(path.join(root, 'validation'), { recursive: true });
  const { chromium } = require(process.env.CCMUSIC_PLAYWRIGHT || 'playwright');
  const browser = await chromium.launch({ executablePath: process.env.CCMUSIC_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
  try {
    const page = await makePage(browser);
    await page.locator('#startupLoginModal:not([hidden])').waitFor();
    assert.equal(await page.locator('.modal:not([hidden])').count(), 1);
    assert.equal(await page.locator('#startupLoginNow').textContent(), '立即登录');
    assert.equal(await page.locator('#startupLoginNever').textContent(), '不再提醒');
    assert.equal(await page.locator('#startupLoginClose').textContent(), '×');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'startupLoginNow');
    assert.equal(await page.evaluate(() => window.qrRequests), 0, 'reminding alone must not fetch a QR code');
    await page.keyboard.press('Tab'); assert.equal(await page.evaluate(() => document.activeElement.id), 'startupLoginClose');
    await page.keyboard.press('Shift+Tab'); assert.equal(await page.evaluate(() => document.activeElement.id), 'startupLoginNow');
    await page.evaluate(() => { document.querySelector('#startupLoginTitle').tabIndex = -1; document.querySelector('#startupLoginTitle').focus(); });
    await page.keyboard.press('Space'); assert.equal(await page.evaluate(() => audio.paused), true, 'reminder keys must not control playback');
    await page.evaluate(() => { document.querySelector('#startupLoginTitle').removeAttribute('tabindex'); document.querySelector('#startupLoginNow').focus(); });
    await page.screenshot({ path: path.join(root, 'validation/ui-startup-login-reminder.png') });
    await page.setViewportSize({ width: 900, height: 660 });
    assert.equal(await page.locator('.startup-login-box').evaluate(el => { const r = el.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight; }), true);
    await page.locator('#startupLoginClose').click();
    await page.evaluate(() => checkLogin()); await page.waitForTimeout(400);
    assert.equal(await page.locator('#startupLoginModal').isHidden(), true, 'close dismisses for the rest of this launch');
    assert.notEqual(await page.evaluate(() => localStorage.startupLoginReminder), '0', 'close is not a permanent opt-out');
    await page.reload(); await page.locator('#startupLoginModal:not([hidden])').waitFor();
    await page.keyboard.press('Escape'); assert.equal(await page.locator('#startupLoginModal').isHidden(), true);
    await page.reload(); await page.locator('#startupLoginModal:not([hidden])').waitFor();
    await page.locator('#startupLoginNever').click();
    assert.equal(await page.evaluate(() => localStorage.startupLoginReminder), '0');
    await page.reload(); await page.waitForFunction(() => window.loginChecks > 0); await page.waitForTimeout(450);
    assert.equal(await page.locator('#startupLoginModal').isHidden(), true, 'never remind persists across restart');
    await page.locator('#avatarBtn').click(); await page.locator('#amItems [data-act="login"]').click();
    await page.locator('#loginModal:not([hidden])').waitFor(); await page.locator('#loginClose').click();
    assert.equal(await page.evaluate(() => window.qrRequests), 1, 'opting out does not disable manual login');
    assert.deepEqual(page.errors, []); await page.close();
    const login = await makePage(browser);
    await login.locator('#startupLoginModal:not([hidden])').waitFor(); await login.locator('#startupLoginNow').click();
    await login.locator('#loginModal:not([hidden])').waitFor();
    assert.equal(await login.locator('#startupLoginModal').isHidden(), true); assert.equal(await login.locator('.modal:not([hidden])').count(), 1);
    await login.waitForFunction(() => accountState.logged);
    assert.equal(await login.evaluate(() => qrRequests), 1); assert.equal(await login.locator('#startupLoginModal').isHidden(), true);
    await login.evaluate(() => { window.testLogged = false; window.loginReply = { logged: false }; return checkLogin(); });
    await login.waitForTimeout(450); assert.equal(await login.locator('#startupLoginModal').isHidden(), true, 'logout does not trigger a second startup reminder');
    assert.deepEqual(login.errors, []); await login.close();
    for (const options of [{ status: { logged: true, name: '启动已登录' } }, { status: { logged: false, stale: true, saved: true } }, { throw: true }, { disabled: true }]) {
      const quiet = await makePage(browser, options);
      await quiet.waitForFunction(() => window.loginChecks > 0); await quiet.waitForTimeout(450);
      assert.equal(await quiet.locator('#startupLoginModal').isHidden(), true, 'logged-in/unknown/opt-out states do not show a reminder');
      if (options.status?.stale) {
        await quiet.evaluate(() => openAccountMenu());
        assert.ok((await quiet.locator('#amHead').textContent()).includes('登录信息已保留'));
      }
      assert.deepEqual(quiet.errors, []); await quiet.close();
    }
    const retry = await makePage(browser, { status: { logged: false, stale: true } });
    await retry.waitForFunction(() => accountState.stale); await retry.clock.install();
    await retry.evaluate(() => { window.loginReply = { logged: false }; }); await retry.clock.fastForward(10010);
    await retry.waitForFunction(() => !accountState.stale && window.loginChecks === 2); await retry.clock.runFor(350);
    assert.equal(await retry.locator('#startupLoginModal').isVisible(), true, 'unknown network state may show later after a definite logged-out retry');
    assert.deepEqual(retry.errors, []); await retry.close();
    const deferred = await makePage(browser, { deferred: true });
    await deferred.waitForFunction(() => window.pendingLogins.length === 1);
    await deferred.evaluate(() => { void editText('编辑歌单', '还没有保存的名字'); window.pendingLogins[0]({ logged: false }); });
    await deferred.waitForTimeout(450);
    assert.equal(await deferred.locator('#startupLoginModal').isHidden(), true); assert.equal(await deferred.locator('#editValue').inputValue(), '还没有保存的名字');
    assert.equal(await deferred.locator('#editModal').isVisible(), true);
    await deferred.locator('#editCancel').click(); await deferred.locator('#startupLoginModal:not([hidden])').waitFor();
    assert.equal(await deferred.locator('.modal:not([hidden])').count(), 1, 'pending reminder waits until the other modal closes');
    assert.deepEqual(deferred.errors, []); await deferred.close();
    const race = await makePage(browser, { deferred: true });
    await race.waitForFunction(() => pendingLogins.length === 1);
    await race.evaluate(() => { void checkLogin(); }); await race.waitForFunction(() => pendingLogins.length === 2);
    await race.evaluate(() => { pendingLogins[1]({ logged: true, name: '最新状态' }); }); await race.waitForFunction(() => accountState.logged);
    await race.evaluate(() => pendingLogins[0]({ logged: false })); await race.waitForTimeout(450);
    assert.equal(await race.locator('#startupLoginModal').isHidden(), true); assert.equal(await race.evaluate(() => accountState.logged), true);
    assert.deepEqual(race.errors, []); await race.close();
    const stuck = await makePage(browser, { deferred: true });
    await stuck.waitForFunction(() => pendingLogins.length === 1); await stuck.clock.install();
    await stuck.clock.fastForward(18010); await stuck.waitForFunction(() => accountState.stale);
    await stuck.evaluate(() => { window.api.loginState = async () => ({ logged: false }); });
    await stuck.clock.fastForward(10010); await stuck.clock.runFor(350);
    assert.equal(await stuck.locator('#startupLoginModal').isVisible(), true, 'a hung state IPC times out, then the definite retry can remind');
    await stuck.evaluate(() => pendingLogins[0]({ logged: true, name: '过期请求' }));
    assert.equal(await stuck.evaluate(() => accountState.logged), false, 'late timed-out replies cannot change current state');
    assert.deepEqual(stuck.errors, []); await stuck.close();
    console.log('PASS: anonymous startup reminder, accurate copy/three controls, focus/keyboard, close vs persistent opt-out, QR login handoff, no repeat after logout, logged-in/stale/error silence, retry, modal deferral, request-race protection and 900px layout; no Electron/audio/network');
  } finally { await browser.close(); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
