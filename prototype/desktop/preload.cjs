const { contextBridge, ipcRenderer, webUtils } = require('electron');

let windowHidden = false;
const visibilityListeners = new Set();
ipcRenderer.on('span:window-hidden', (_event, hidden) => {
  if (windowHidden === hidden) return;
  windowHidden = hidden;
  for (const listener of visibilityListeners) listener(hidden);
});

const listeners = new Set();
ipcRenderer.on('span:event', (_event, packet) => {
  for (const listener of listeners) listener(packet);
});

contextBridge.exposeInMainWorld('span', {
  request: (method, params = {}) => ipcRenderer.invoke('span:request', method, params),
  workspace: (choose = false) => ipcRenderer.invoke('span:workspace', choose),
  filePath: file => webUtils.getPathForFile(file),
  openLink: url => ipcRenderer.invoke('span:link', url),
  copyText: text => ipcRenderer.invoke('span:copy-text', text),
  onWindowHidden: listener => {
    visibilityListeners.add(listener);
    listener(windowHidden);
    return () => visibilityListeners.delete(listener);
  },
  onEvent: listener => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
});
