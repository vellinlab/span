const { contextBridge, ipcRenderer } = require('electron');

const listeners = new Set();
ipcRenderer.on('span:event', (_event, packet) => {
  for (const listener of listeners) listener(packet);
});

contextBridge.exposeInMainWorld('span', {
  request: (method, params = {}) => ipcRenderer.invoke('span:request', method, params),
  workspace: (choose = false) => ipcRenderer.invoke('span:workspace', choose),
  openLink: url => ipcRenderer.invoke('span:link', url),
  onEvent: listener => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
});
