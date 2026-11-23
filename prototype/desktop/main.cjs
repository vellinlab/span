const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const binary = process.platform === 'win32' ? 'span-workbench-core.exe' : 'span-workbench-core';
const demo = process.argv.includes('--demo');
const allowed = new Set([
  'agent.start', 'agent.send', 'agent.close',
  'terminal.start', 'terminal.write', 'terminal.resize', 'terminal.close',
  'files.list', 'files.preview',
]);

app.setName('Span Workbench Preview');
if (process.platform === 'win32') app.commandLine.appendSwitch('disable-lcd-text');
if (process.env.SPAN_PREVIEW_PROFILE) {
  app.setPath('userData', path.resolve(process.env.SPAN_PREVIEW_PROFILE));
}

let window;
let core;
let closing = false;
let sequence = 0;
const pending = new Map();

function request(method, params) {
  if (!core || core.exitCode !== null || core.stdin.destroyed) {
    return Promise.reject(new Error('Rust 服务未连接。'));
  }
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const expires = setTimeout(() => {
      pending.delete(id);
      reject(new Error('工作台请求超时。'));
    }, 20000);
    pending.set(id, { resolve, reject, expires });
    core.stdin.write(JSON.stringify({ id, method, params }) + '\n', error => {
      if (error) finish(id, error.message);
    });
  });
}

function finish(id, error, payload) {
  const call = pending.get(id);
  if (!call) return;
  pending.delete(id);
  clearTimeout(call.expires);
  if (error) call.reject(new Error(error));
  else call.resolve(payload);
}

function publish(packet) {
  if (window && !window.isDestroyed()) window.webContents.send('span:event', packet);
}

function spawnCore() {
  core = spawn(process.env.SPAN_PREVIEW_CORE || path.join(root, 'bin', binary), [], {
    cwd: demo ? path.join(root, 'sample') : app.getPath('home'),
    stdio: ['pipe', 'pipe', 'ignore'],
    windowsHide: true,
  });
  const input = createInterface({ input: core.stdout, crlfDelay: Infinity });
  input.on('line', line => {
    try {
      const packet = JSON.parse(line);
      if (typeof packet.id === 'number') finish(packet.id, packet.error, packet.result);
      else if (packet.event) publish(packet);
    } catch {
      publish({ event: 'core-error', data: '无法读取 Rust 服务的响应。' });
    }
  });
  core.stdin.on('error', () => {});
  core.on('error', error => publish({ event: 'core-error', data: error.message }));
  core.on('close', () => {
    for (const id of pending.keys()) finish(id, 'Rust 服务已退出。');
    if (!closing) publish({ event: 'core-error', data: 'Rust 服务已退出。' });
    if (closing) app.quit();
  });
}

function trusted(event) {
  return window && event.sender === window.webContents
    && event.senderFrame === window.webContents.mainFrame;
}

ipcMain.handle('span:request', (event, method, params) => {
  if (!trusted(event) || !allowed.has(method)) throw new Error('无效的工作台请求。');
  if (method === 'agent.start') params = { ...params, demo };
  return request(method, params);
});

ipcMain.handle('span:workspace', (event, choose) => {
  if (!trusted(event)) throw new Error('无效的工作台请求。');
  if (!choose) return {
    cwd: demo ? path.join(root, 'sample') : app.getPath('home'),
    demo,
    terminalRenderer: app.commandLine.getSwitchValue('terminal-renderer') === 'dom' ? 'dom' : 'auto',
  };
  return dialog.showOpenDialog(window, { properties: ['openDirectory'] })
    .then(result => result.filePaths[0] ?? null);
});

ipcMain.handle('span:link', (event, url) => {
  if (!trusted(event) || typeof url !== 'string' || url.length > 8192) return;
  const link = new URL(url);
  if (link.protocol === 'https:' || link.protocol === 'http:') return shell.openExternal(link.href);
});

app.whenReady().then(() => {
  window = new BrowserWindow({
    title: 'Span · 工作台预览',
    width: 1240,
    height: 840,
    minWidth: 740,
    minHeight: 520,
    autoHideMenuBar: true,
    backgroundColor: '#181818',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#181818', symbolColor: '#ededed', height: 44 },
    ...(process.platform === 'win32' && { icon: path.join(root, 'span.ico') }),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, reply) => reply(false));
  spawnCore();
  window.loadFile(path.join(root, 'dist/index.html'));
});

app.on('window-all-closed', () => app.quit());
app.on('before-quit', event => {
  if (closing || !core || core.exitCode !== null || core.stdin.destroyed) return;
  event.preventDefault();
  closing = true;
  core.stdin.end();
  setTimeout(() => {
    if (core.exitCode === null) core.kill();
    app.quit();
  }, 1200).unref();
});
