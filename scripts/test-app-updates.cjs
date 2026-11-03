// Real controller with controlled updater events/timers; never invokes Electron/installers.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict'), { EventEmitter } = require('node:events');
const { createAppUpdates } = require('../app-updates.cjs');
const root = path.resolve(__dirname, '..'), dir = fs.mkdtempSync(path.join(root, 'validation/updates-'));
const deferred = () => { let resolve, reject; const promise = new Promise((r, j) => { resolve = r; reject = j; }); return { promise, resolve, reject }; };
async function run() {
  const updater = new EventEmitter(), checks = [], downloads = [], states = [], timers = new Map(); let timerId = 0, installs = 0, busy = true;
  updater.checkForUpdates = () => { const gate = deferred(); checks.push(gate); return gate.promise; };
  updater.downloadUpdate = () => { const gate = deferred(); downloads.push(gate); return gate.promise; };
  updater.quitAndInstall = (silent, force) => { assert.equal(silent, true); assert.equal(force, true); installs++; };
  const preferences = path.join(dir, 'updates.json');
  const clock = { setTimeout: fn => { timers.set(++timerId, fn); return timerId; }, setInterval: fn => { timers.set(++timerId, fn); return timerId; }, clearTimeout: id => timers.delete(id), clearInterval: id => timers.delete(id) };
  const service = createAppUpdates({ updater, version: '1.6.3', preferences, emit: s => states.push(s), timers: clock,
    beforeInstall: async () => { if (busy) throw Error('任务尚未完成'); } });
  assert.equal(service.snapshot().autoCheck, null); assert.equal(timers.size, 0);
  assert.equal(updater.autoDownload, false); assert.equal(updater.autoInstallOnAppQuit, false);
  service.configure(true); assert.equal(timers.size, 2); const oldTimer = [...timers.values()][0];
  service.configure(false); oldTimer(); await Promise.resolve(); assert.equal(checks.length, 0); assert.equal(timers.size, 0);
  const first = service.check(), same = service.check(); await Promise.resolve(); assert.equal(checks.length, 1);
  assert.equal(service.snapshot().status, 'checking');
  updater.emit('update-available', { version: '1.7.0', releaseNotes: '<b>MP3</b>\n![image](http://bad)\n[历史记录](http://bad)' }); checks[0].resolve();
  await Promise.all([first, same]); assert.equal(service.snapshot().status, 'available'); assert.equal(downloads.length, 0);
  assert(!service.snapshot().notes.includes('<b>')); assert(!service.snapshot().notes.includes('http://bad'));
  await service.check(); assert.equal(checks.length, 1, 'checking must not lose a ready update');
  await service.download(); await service.download(); await Promise.resolve(); assert.equal(downloads.length, 1);
  updater.emit('download-progress', { percent: 42.7, total: 1000, transferred: 427 }); assert.equal(service.snapshot().percent, 42.7);
  downloads[0].reject(Error('网络暂时不可用')); await new Promise(setImmediate);
  assert.equal(service.snapshot().errorStage, 'download');
  await service.download(); await Promise.resolve(); assert.equal(downloads.length, 2);
  updater.emit('update-downloaded', { version: '1.7.0' }); downloads[1].resolve(); await new Promise(setImmediate);
  assert.equal(service.snapshot().status, 'downloaded'); assert.equal(installs, 0, 'download never silently installs');
  updater.emit('download-progress', { percent: 12 }); assert.equal(service.snapshot().percent, 100, 'late progress cannot roll back completion');
  await service.install(); assert.equal(installs, 0); assert.match(service.snapshot().error, /任务/);
  busy = false; await service.install(); await service.install(); assert.equal(installs, 1);
  updater.emit('error', Error('安装未能启动')); assert.equal(service.snapshot().status, 'downloaded');
  await service.install(); assert.equal(installs, 2, 'failed installation can retry');
  service.dispose(); assert.equal(timers.size, 0);
  const dev = createAppUpdates({ updater: null, version: '1.7.0', preferences });
  assert.equal(dev.snapshot().autoCheck, false, 'preference survives restart');
  await assert.rejects(dev.download(), /测试运行/); await assert.rejects(dev.check(), /测试运行/); await assert.rejects(dev.install(), /测试运行/);
  assert.throws(() => dev.configure('false'), /无效/); dev.dispose();
  const failure = new EventEmitter(); failure.checkForUpdates = async () => { throw Error('检查超时'); };
  const failedCheck = createAppUpdates({ updater: failure, version: '1.7.0', preferences });
  await failedCheck.check(); assert.equal(failedCheck.snapshot().status, 'error'); assert.equal(failedCheck.snapshot().errorStage, 'check'); failedCheck.dispose();
  fs.unlinkSync(preferences);
  console.log('PASS: updater state machine, shared checks, manual download/progress/retry, no silent install, restart guard/retry, preferences/timer migration, no dev installation');
}
run().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => fs.rmdirSync(dir));
