import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const winDriver = fileURLToPath(new URL('./window-edge-win.ps1', import.meta.url));

async function windowGeometry(app) {
  return app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    const handle = window.getNativeWindowHandle();
    return { id: process.platform === 'win32' ? String(handle.readBigUInt64LE()) : String(handle.readUInt32LE()),
      ...window.getContentBounds() };
  });
}

export async function dragWindowEdge(app, distance) {
  const { id, x, y, width, height } = await windowGeometry(app);
  if (process.platform === 'win32') {
    await run('powershell.exe', ['-NoProfile', '-File', winDriver, '-Handle', id, '-Distance', String(distance)]);
    return;
  }
  const start = x + width - 8;
  const center = String(y + Math.floor(height / 2));
  // Openbox handles Alt + right-button drag from this side of the frame.
  const commands = ['windowactivate', '--sync', id, 'mousemove', String(start), center, 'keydown', 'Alt', 'mousedown', '3', 'sleep', '0.045'];
  const move = offset => commands.push('mousemove', String(start + offset), center, 'sleep', '0.045');
  move(3 * Math.sign(distance));
  for (let step = 1; step <= 6; step++) move(Math.round(distance * step / 6));
  await run('xdotool', [...commands, 'mouseup', '3', 'keyup', 'Alt']);
}

export async function captureWindowDesktop(app, path) {
  const { id, x, y, width, height } = await windowGeometry(app);
  if (process.platform === 'win32') {
    await run('powershell.exe', ['-NoProfile', '-File', winDriver, '-Handle', id, '-Screenshot', path]);
  } else {
    await run('import', ['-window', 'root', '-crop', `${width}x${height}+${x}+${y}`, '+repage', path]);
  }
}
