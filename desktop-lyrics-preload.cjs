const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('desktopLyrics', {
  onLine: callback => ipcRenderer.on('lyrics:desktop-line', (_event, line) => callback(line)),
  onStyle: callback => ipcRenderer.on('lyrics:desktop-style', (_event, style) => callback(style)),
  onControls: callback => ipcRenderer.on('lyrics:desktop-controls', (_event, visible) => callback(visible)),
  configure: patch => ipcRenderer.invoke('lyrics:desktop-configure', patch),
  offset: delta => ipcRenderer.invoke('lyrics:desktop-offset', delta),
  close: () => ipcRenderer.invoke('lyrics:desktop-close'),
});
