const { contextBridge, ipcRenderer } = require('electron');

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
  chooseFiles: () => ipcRenderer.invoke('span:choose-files'),
  stageScreenshot: bytes => ipcRenderer.invoke('span:stage-screenshot', bytes),
  discardScreenshot: file => ipcRenderer.invoke('span:discard-screenshot', file),
  retainScreenshots: files => ipcRenderer.send('span:retain-screenshots', files),
  previewImage: file => ipcRenderer.invoke('span:preview-image', file),
  openLink: url => ipcRenderer.invoke('span:link', url),
  copyText: text => ipcRenderer.invoke('span:copy-text', text),
  copyRich: markdown => ipcRenderer.invoke('span:copy-rich', markdown),
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
