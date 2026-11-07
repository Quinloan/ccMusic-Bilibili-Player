// One update state machine for the settings, manual actions and background checks.
const fs = require('node:fs'), path = require('node:path');
function createUpdateFeeds(config = require('./update-sources.json')) {
  const repository = String(config.domestic?.repository || '');
  const branch = config.domestic?.branch || 'main';
  if (repository && (!/^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)+$/.test(repository) || repository.split('/').some(p => p === '.' || p === '..'))) throw Error('无效的国内发布仓库');
  if (!/^[a-zA-Z0-9_.-]+$/.test(branch) || branch === '.' || branch === '..') throw Error('无效的国内发布分支');
  const { owner, repo } = config.github || {};
  if (![owner, repo].every(value => typeof value === 'string' && /^[a-zA-Z0-9_.-]+$/.test(value))) throw Error('无效的 GitHub 发布仓库');
  return {
    domestic: repository ? { provider: 'generic', url: `https://cnb.cool/${repository}/-/git/raw/${branch}/updates/`, useMultipleRangeRequest: false } : null,
    github: { provider: 'github', owner, repo, channel: 'latest', private: false },
  };
}
function releaseNotes(value) {
  const text = Array.isArray(value) ? value.map(v => v.note || '').join('\n') : String(value || '');
  return text.replace(/^## (?:下载软件|下载与升级|界面示例|界面预览)[^\n]*\n[\s\S]*?(?=^## |$(?![\s\S]))/gm, '')
    .replace(/<[^>]*>/g, '').replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '').replace(/\*\*|`/g, '').slice(0, 20000).trim();
}
function createAppUpdates({ updater, version, preferences, feeds = createUpdateFeeds(), emit = () => {}, beforeInstall = async () => {}, installFailed = () => {}, timers = globalThis }) {
  let autoCheck = null, source = 'domestic';
  try { const saved = JSON.parse(fs.readFileSync(preferences, 'utf8')); if (typeof saved.autoCheck === 'boolean') autoCheck = saved.autoCheck; if (['domestic', 'github'].includes(saved.source)) source = saved.source; } catch (_) {}
  let state = { revision: 0, current: version, supported: !!updater, source, autoCheck, status: 'idle', latest: '', notes: '', percent: 0, transferred: 0, total: 0, error: '', lastChecked: null };
  let checkPromise = null, downloadPromise = null, installing = false, initialTimer, interval;
  const snapshot = () => ({ ...state });
  const set = patch => { state = { ...state, ...patch, revision: state.revision + 1 }; emit(snapshot()); return snapshot(); };
  function fail(error, stage) { return set({ status: 'error', errorStage: stage, error: String(error?.message || error).slice(0, 500) }); }
  function requireUpdater() { if (!updater) throw Error('测试运行模式不下载安装更新，请使用正式版软件'); }
  if (updater) {
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    updater.disableDifferentialDownload = true; // Both mirrors publish full installers, no blockmap needed.
    updater.allowPrerelease = false; updater.allowDowngrade = false;
    updater.on('update-available', info => { if (state.status === 'checking') set({ status: 'available', latest: info.version, notes: releaseNotes(info.releaseNotes), error: '', errorStage: '', percent: 0 }); });
    updater.on('update-not-available', () => { if (state.status === 'checking') set({ status: 'latest', latest: '', notes: '', error: '', errorStage: '' }); });
    updater.on('download-progress', progress => {
      if (state.status !== 'downloading') return;
      set({ percent: Math.min(100, Math.max(0, Number(progress.percent) || 0)), transferred: Math.max(0, Number(progress.transferred) || 0), total: Math.max(0, Number(progress.total) || 0) });
    });
    updater.on('update-downloaded', info => { if (state.status === 'downloading') set({ status: 'downloaded', latest: info.version, notes: releaseNotes(info.releaseNotes) || state.notes, percent: 100, error: '', errorStage: '' }); });
    updater.on('error', error => {
      if (!checkPromise && !downloadPromise && !installing && !['checking','downloading','restarting'].includes(state.status)) return;
      if (state.status === 'restarting') { installing = false; installFailed(); set({ status: 'downloaded', error: String(error?.message || error).slice(0, 500) }); }
      else fail(error, state.status === 'downloading' ? 'download' : state.errorStage || 'check');
    });
  }
  async function check() {
    requireUpdater();
    if (checkPromise) return checkPromise;
    if (['available', 'downloading', 'downloaded', 'restarting'].includes(state.status)) return snapshot();
    set({ status: 'checking', error: '', errorStage: '', percent: 0, lastChecked: new Date().toISOString() });
    checkPromise = Promise.resolve().then(() => {
      const feed = feeds[state.source];
      if (!feed) throw Error('国内更新入口尚未配置，请切换 GitHub 或稍后重试');
      updater.setFeedURL({ ...feed });
      return updater.checkForUpdates();
    }).then(() => snapshot(), error => fail(error, 'check')).finally(() => { checkPromise = null; });
    return checkPromise;
  }
  async function download() {
    requireUpdater();
    if (downloadPromise) return snapshot();
    if (!state.latest || !['available', 'error'].includes(state.status) || (state.status === 'error' && state.errorStage !== 'download')) return snapshot();
    set({ status: 'downloading', percent: 0, transferred: 0, total: 0, error: '', errorStage: '' });
    // Return immediately so IPC never blocks the progress UI until the file completes.
    downloadPromise = Promise.resolve().then(() => updater.downloadUpdate()).catch(error => fail(error, 'download')).finally(() => { downloadPromise = null; });
    return snapshot();
  }
  async function install() {
    requireUpdater();
    if (state.status !== 'downloaded' || installing) return snapshot();
    installing = true;
    try {
      await beforeInstall();
      set({ status: 'restarting', error: '' });
      updater.quitAndInstall(true, true);
    } catch (error) { installing = false; installFailed(); set({ status: 'downloaded', error: String(error.message || error).slice(0, 500) }); }
    return snapshot();
  }
  const stop = () => { timers.clearTimeout(initialTimer); timers.clearInterval(interval); initialTimer = interval = undefined; };
  function schedule() {
    stop(); if (!updater || !state.autoCheck) return;
    const tick = () => { if (state.autoCheck && !['available', 'downloading', 'downloaded', 'restarting'].includes(state.status)) void check().catch(() => {}); };
    initialTimer = timers.setTimeout(tick, 15000); initialTimer?.unref?.();
    interval = timers.setInterval(tick, 4 * 60 * 60 * 1000); interval?.unref?.();
  }
  function persist(patch) {
    fs.mkdirSync(path.dirname(preferences), { recursive: true });
    const partial = preferences + '.tmp'; fs.writeFileSync(partial, JSON.stringify({ autoCheck: state.autoCheck, source: state.source, ...patch })); fs.renameSync(partial, preferences);
  }
  function configure(on) {
    if (typeof on !== 'boolean') throw Error('无效的更新设置');
    persist({ autoCheck: on });
    set({ autoCheck: on }); schedule(); return snapshot();
  }
  function setSource(value) {
    if (!['domestic', 'github'].includes(value)) throw Error('无效的更新来源');
    if (value === state.source) return snapshot();
    if (checkPromise || downloadPromise || installing || ['checking','downloading','downloaded','restarting'].includes(state.status)) throw Error('请先完成当前更新，再切换来源');
    persist({ source: value });
    return set({ source: value, status: 'idle', latest: '', notes: '', percent: 0, transferred: 0, total: 0, error: '', errorStage: '', lastChecked: null });
  }
  schedule();
  return { snapshot, check, download, install, configure, setSource, dispose: stop };
}
module.exports = { createAppUpdates, createUpdateFeeds, releaseNotes };
