const { app, BrowserWindow, clipboard, dialog, ipcMain, shell } = require('electron');
const { spawn } = require('node:child_process');
const { mkdir, mkdtemp, rm, writeFile } = require('node:fs/promises');
const { createInterface } = require('node:readline');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const binary = process.platform === 'win32' ? 'span-workbench-core.exe' : 'span-workbench-core';
const demo = process.argv.includes('--demo');
const allowed = new Set([
  'agent.start', 'agent.send', 'agent.close',
  'terminal.start', 'terminal.write', 'terminal.resize', 'terminal.ack', 'terminal.close',
  'files.list', 'files.preview',
]);
const terminalEvents = new Set(['terminal', 'terminal-error', 'terminal-closed']);
const maxClipboardLength = 64 * 1024 * 1024;
const maxScreenshotBytes = 4 * 1024 * 1024;
const imageExtensions = ['png', 'jpg', 'jpeg', 'gif', 'webp'];
const selectedImages = new Set();
const stagedScreenshots = new Set();
const screenshotSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
let screenshotNumber = 0;

const screenshotRoot = () => path.join(app.getPath('userData'), 'screenshots');

function isStoredScreenshot(file) {
  const directory = path.dirname(file);
  return path.dirname(directory) === screenshotRoot() &&
    /^paste-[a-z0-9]{6}$/i.test(path.basename(directory)) &&
    /^截图 \d+\.png$/.test(path.basename(file));
}

async function discardScreenshot(file) {
  if (!stagedScreenshots.has(file)) return;
  await rm(path.dirname(file), { recursive: true, force: true });
  stagedScreenshots.delete(file);
}

function rememberImage(file) {
  const normalized = path.normalize(file);
  if (!imageExtensions.includes(path.extname(normalized).slice(1).toLowerCase())) return;
  selectedImages.delete(normalized);
  selectedImages.add(normalized);
  if (selectedImages.size > 96) selectedImages.delete(selectedImages.values().next().value);
}

app.setName('Span Workbench Preview');
if (process.platform === 'win32') app.commandLine.appendSwitch('disable-lcd-text');
if (process.env.SPAN_PREVIEW_PROFILE) {
  app.setPath('userData', path.resolve(process.env.SPAN_PREVIEW_PROFILE));
}

let window;
let core;
let closing = false;
let sequence = 0;
let terminalGeneration = null;
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
  if (terminalEvents.has(packet.event) && packet.generation !== terminalGeneration) return;
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

function closeTerminal() {
  if (terminalGeneration === null) return;
  const generation = terminalGeneration;
  terminalGeneration = null;
  request('terminal.close', { generation }).catch(() => {});
}

ipcMain.handle('span:request', (event, method, params) => {
  if (!trusted(event) || !allowed.has(method)) throw new Error('无效的工作台请求。');
  if (method === 'agent.start') params = { ...params, demo };
  if (method === 'terminal.start') {
    const generation = params?.generation;
    if (!Number.isSafeInteger(generation) || generation <= 0) throw new Error('无效的终端标识。');
    terminalGeneration = generation;
    return request(method, params).catch(error => {
      if (terminalGeneration === generation) terminalGeneration = null;
      throw error;
    });
  }
  if (method === 'terminal.close' && params?.generation === terminalGeneration) terminalGeneration = null;
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

ipcMain.handle('span:choose-files', async event => {
  if (!trusted(event)) throw new Error('无效的工作台请求。');
  const result = await dialog.showOpenDialog(window, { properties: ['openFile', 'multiSelections'] });
  if (result.canceled) return [];
  return result.filePaths.map(file => {
    rememberImage(file);
    return { path: file, name: path.basename(file) };
  });
});

ipcMain.handle('span:stage-screenshot', async (event, bytes) => {
  if (!trusted(event) || !(bytes instanceof ArrayBuffer)) throw new Error('无效的工作台请求。');
  if (bytes.byteLength > maxScreenshotBytes) {
    throw new Error('截图不能超过 4 MiB。');
  }
  const png = Buffer.from(bytes);
  if (!png.subarray(0, screenshotSignature.length).equals(screenshotSignature)) {
    throw new Error('剪贴板中没有可用的 PNG 图片。');
  }
  const root = screenshotRoot();
  await mkdir(root, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(path.join(root, 'paste-'));
  const name = `截图 ${++screenshotNumber}.png`;
  const file = path.join(directory, name);
  try {
    await writeFile(file, png, { flag: 'wx', mode: 0o600 });
    stagedScreenshots.add(file);
    if (!window || window.isDestroyed() || closing) {
      await discardScreenshot(file);
      return null;
    }
    return { path: file, name };
  } catch (error) {
    await rm(directory, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
});

ipcMain.handle('span:discard-screenshot', (event, file) => {
  if (trusted(event)) return discardScreenshot(file);
});

ipcMain.on('span:retain-screenshots', (event, files) => {
  if (!trusted(event) || !Array.isArray(files) || files.length > 6) return;
  for (const file of files) stagedScreenshots.delete(file);
});

ipcMain.handle('span:preview-image', async (event, file) => {
  if (!trusted(event) || typeof file !== 'string' || file.includes('\0') || !path.isAbsolute(file) ||
    !imageExtensions.includes(path.extname(file).slice(1).toLowerCase())) throw new Error('无效的图片位置。');
  const normalized = path.normalize(file);
  if (isStoredScreenshot(normalized)) {
    const cwd = screenshotRoot();
    return request('files.preview', { cwd, path: path.relative(cwd, normalized), imageOnly: true });
  }
  if (!selectedImages.has(normalized)) {
    const result = await dialog.showOpenDialog(window, {
      title: '选择会话中的原图',
      defaultPath: path.basename(normalized),
      filters: [{ name: '图片', extensions: imageExtensions }],
      properties: ['openFile'],
    });
    if (result.canceled) return null;
    if (!result.filePaths[0] || path.normalize(result.filePaths[0]) !== normalized) throw new Error('请选择会话中记录的原图。');
    rememberImage(normalized);
  }
  return request('files.preview', { cwd: path.dirname(normalized), path: path.basename(normalized), imageOnly: true });
});

ipcMain.handle('span:link', (event, url) => {
  if (!trusted(event) || typeof url !== 'string' || url.length > 8192) return;
  const link = new URL(url);
  if (link.protocol === 'https:' || link.protocol === 'http:') return shell.openExternal(link.href);
});

ipcMain.handle('span:copy-text', (event, text) => {
  if (!trusted(event) || typeof text !== 'string' || text.length > maxClipboardLength) {
    throw new Error('无效的剪贴板文本。');
  }
  clipboard.writeText(text);
});

app.whenReady().then(() => {
  window = new BrowserWindow({
    title: 'Span · 工作台预览',
    width: 1240,
    height: 840,
    minWidth: 740,
    minHeight: 520,
    autoHideMenuBar: true,
    backgroundColor: '#181a1b',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#181a1b', symbolColor: '#ededed', height: 44 },
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
  window.webContents.on('did-start-navigation', event => {
    if (event.isMainFrame && !event.isSameDocument) closeTerminal();
  });
  const publishWindowHidden = () => {
    if (window.isDestroyed()) return;
    window.webContents.send('span:window-hidden', window.isMinimized() || !window.isVisible());
  };
  for (const event of ['minimize', 'restore', 'show', 'hide']) window.on(event, publishWindowHidden);
  window.webContents.on('did-finish-load', publishWindowHidden);
  window.webContents.on('render-process-gone', closeTerminal);
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, reply) => reply(false));
  spawnCore();
  window.loadFile(path.join(root, 'dist/index.html'));
});

app.on('window-all-closed', () => app.quit());
let cleaningScreenshots = false;
app.on('will-quit', event => {
  if (cleaningScreenshots || !stagedScreenshots.size) return;
  event.preventDefault();
  cleaningScreenshots = true;
  Promise.allSettled([...stagedScreenshots].map(discardScreenshot)).then(() => app.quit());
});
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
