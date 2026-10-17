const fs = require('node:fs');
const { createDownloader, validateItems } = require('./audio-downloads.cjs');
function registerDownloads({ app, ipcMain, dialog, BrowserWindow, shell, executable, getLoginState, getPlayurl, resolveItem, request, headers }) {
  const owners = new WeakSet();
  const manager = createDownloader({ executable, getPlayurl, resolveItem, request, headers,
    onUpdate: (owner, task) => { if (!owner.isDestroyed()) owner.send('download:progress', task); } });
  let quitting = false, quitReady = false;
  app?.on('before-quit', event => {
    if (quitReady || !manager.hasPending()) return;
    event.preventDefault();
    if (quitting) return;
    quitting = true;
    // Wait for FFmpeg to exit and temporary files to close before the parent exits.
    manager.shutdown().finally(() => { quitReady = true; app.quit(); });
  });
  async function loginGate(allowLimited) {
    const state = await getLoginState().catch(() => ({ logged: false, stale: true }));
    if (!state.logged && !allowLimited) return { needsLogin: true, stale: !!state.stale };
    if (!fs.existsSync(executable)) throw new Error('缺少下载组件，请重新安装完整版本');
  }
  ipcMain.handle('download:start', async (event, input, allowLimited = false) => {
    const items = validateItems(input), owner = event.sender;
    const gate = await loginGate(allowLimited === true); if (gate) return gate;
    const options = { title: '选择音频下载目录', properties: ['openDirectory', 'createDirectory'] };
    const window = BrowserWindow.fromWebContents(owner);
    const result = await (window ? dialog.showOpenDialog(window, options) : dialog.showOpenDialog(options));
    if (result.canceled || !result.filePaths?.length || owner.isDestroyed()) return { cancelled: true };
    if (!owners.has(owner)) { owners.add(owner); owner.once('destroyed', () => manager.cancelOwner(owner)); }
    return { tasks: manager.add(owner, items, result.filePaths[0]) };
  });
  ipcMain.handle('download:retry', async (event, id, allowLimited = false) => {
    const gate = await loginGate(allowLimited === true); if (gate) return gate;
    return { tasks: manager.retry(event.sender, id) };
  });
  ipcMain.handle('download:list', event => manager.list(event.sender));
  ipcMain.handle('download:cancel', (event, id) => manager.cancel(event.sender, id));
  ipcMain.handle('download:dismiss', (event, id) => manager.dismiss(event.sender, id));
  ipcMain.handle('download:reveal', (event, id) => { const file = manager.reveal(event.sender, id); if (file) shell.showItemInFolder(file); return !!file; });
  return manager;
}
module.exports = { registerDownloads };
