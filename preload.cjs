const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // 收藏夹数据
  getLibrary: () => ipcRenderer.invoke('store:get'),
  setLibrary: (lib) => ipcRenderer.invoke('store:set', lib),

  // B 站
  search: (keyword, page) => ipcRenderer.invoke('bili:search', keyword, page),
  video: (id) => ipcRenderer.invoke('bili:video', id),
  playurl: (bvid, cid) => ipcRenderer.invoke('bili:playurl', bvid, cid),
  resolve: (url) => ipcRenderer.invoke('bili:resolve', url),

  // 系统
  openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),
  copyText: (text) => ipcRenderer.invoke('app:copyText', text),

  // 窗口控制（自绘标题栏）
  winMin: () => ipcRenderer.invoke('win:minimize'),
  winMaxToggle: () => ipcRenderer.invoke('win:maxToggle'),
  winClose: () => ipcRenderer.invoke('win:close'),

  // 系统托盘 / 全局媒体键
  onMediaCmd: (cb) => ipcRenderer.on('media:cmd', (_e, cmd) => cb(cmd)),
  setTrayTip: (text) => ipcRenderer.invoke('tray:title', text),
  appQuit: () => ipcRenderer.invoke('app:quit'),
  setMediaKeys: (on) => ipcRenderer.invoke('settings:mediaKeys', !!on),
  setCloseToTray: (on) => ipcRenderer.invoke('settings:closeToTray', !!on),
  setAutoLaunch: (on) => ipcRenderer.invoke('settings:autoLaunch', !!on),
  getAutoLaunch: () => ipcRenderer.invoke('settings:autoLaunchState'),

  // 诊断 / 关于 / 更新
  diagEnv: () => ipcRenderer.invoke('diag:env'),
  diagApi: (bv) => ipcRenderer.invoke('diag:api', bv),
  diagOpenData: () => ipcRenderer.invoke('diag:openData'),
  diagExport: () => ipcRenderer.invoke('diag:export'),
  checkUpdate: () => ipcRenderer.invoke('update:check'),
  getVersion: () => ipcRenderer.invoke('app:version'),

  // 登录
  loginState: () => ipcRenderer.invoke('login:state'),
  loginQrcode: () => ipcRenderer.invoke('login:qrcode'),
  loginPoll: (key) => ipcRenderer.invoke('login:poll', key),
  logout: () => ipcRenderer.invoke('login:logout'),
});
