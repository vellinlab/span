import { _electron as electron } from 'playwright';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const [binary, screenshot, renderer] = process.argv.slice(2);
const exerciseWebgl = renderer === 'webgl';
const profile = await mkdtemp(join(tmpdir(), 'span-preview-'));
const linux = process.platform === 'linux';
const verifySandbox = process.env.SPAN_TEST_SANDBOX === '1';
const app = await electron.launch({
  executablePath: binary,
  chromiumSandbox: verifySandbox,
  args: [
    '--demo',
    ...(linux && !verifySandbox ? ['--no-sandbox'] : []),
    ...(exerciseWebgl ? ['--use-gl=angle', '--use-angle=swiftshader']
      : [linux ? '--disable-webgl' : '--terminal-renderer=dom']),
  ],
  env: { ...process.env, SPAN_PREVIEW_PROFILE: profile },
});
try {
  const page = await app.firstWindow();
  page.on('pageerror', error => console.error(error));
  page.on('console', message => {
    if (message.type() === 'error') console.error(message.text());
  });
  await page.getByText('第 160 项', { exact: false }).waitFor({ timeout: 20_000 });
  await page.waitForFunction(() => {
    const overlay = navigator.windowControlsOverlay;
    if (!overlay?.visible) return false;
    const region = overlay.getTitlebarAreaRect();
    const terminal = document.querySelector('.topbar .terminal-toggle').getBoundingClientRect();
    return region.width > 0 && region.width < innerWidth && region.height > 0
      && terminal.left >= region.left && terminal.right <= region.right;
  });
  const windowId = linux && await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].getNativeWindowHandle().readUInt32LE(0));
  if (verifySandbox) {
    const rendererPid = await app.evaluate(({ app, BrowserWindow }) => {
      if (app.commandLine.hasSwitch('no-sandbox')) throw new Error('The sandbox was disabled.');
      return BrowserWindow.getAllWindows()[0].webContents.getOSProcessId();
    });
    assert.match(await readFile(`/proc/${rendererPid}/status`, 'utf8'), /^Seccomp:\s+2$/m);
    console.log('Verified the installed preview as a regular user with the renderer sandbox enabled.');
    const position = await page.evaluate(() => ({ x: screenX, y: screenY }));
    const dragPoint = await page.evaluate(() => {
      const region = navigator.windowControlsOverlay.getTitlebarAreaRect();
      return [region.x + Math.floor(region.width / 2), region.y + Math.floor(region.height / 2)];
    });
    execFileSync('xdotool', ['mousemove', '--window', String(windowId), ...dragPoint.map(String),
      'mousedown', '1', 'sleep', '0.08', 'mousemove_relative', '24', '18',
      'sleep', '0.08', 'mousemove_relative', '24', '18', 'sleep', '0.08', 'mouseup', '1']);
    await page.waitForFunction(({ x, y }) => screenX !== x || screenY !== y, position, { timeout: 5000 });
    const doubleClickTitlebar = () => execFileSync('xdotool', ['mousemove', '--window', String(windowId),
      ...dragPoint.map(String), 'click', '--repeat', '2', '--delay', '100', '1']);
    doubleClickTitlebar();
    await page.waitForFunction(() => outerWidth >= screen.availWidth - 2, null, { timeout: 5000 });
    doubleClickTitlebar();
    await page.waitForFunction(() => outerWidth < screen.availWidth - 2, null, { timeout: 5000 });
    console.log('Verified moving, maximizing and restoring the window using the integrated title bar.');
  }
  const transcript = page.getByTestId('transcript');
  assert.equal(Number(await transcript.getAttribute('data-items')), 21);
  const area = await transcript.boundingBox();
  await page.mouse.move(area.x + area.width / 2, area.y + 150);
  await transcript.evaluate(element => { element.scrollTop = 25; });
  await page.mouse.wheel(0, -300);
  await page.waitForFunction(() => Number(document.querySelector('[data-items]').dataset.items) >= 41);
  assert.ok(await transcript.locator('.message').count() < 30);

  await page.getByRole('button', { name: '文件', exact: true }).click();
  await page.getByRole('button', { name: 'README.md' }).click();
  await page.locator('.preview .prose').waitFor();
  await page.getByRole('button', { name: '关闭预览' }).click();

  await page.getByRole('button', { name: '切换终端' }).click();
  const terminal = page.locator('.xterm-helper-textarea');
  await terminal.waitFor();
  if (!linux) {
    await page.waitForFunction(() => [...document.querySelectorAll('.xterm-rows > div')]
      .some(line => /app\\sample>/i.test(line.textContent)));
    assert.equal(await page.locator('.xterm-rows').getByText('UNC paths are not supported.', { exact: false }).count(), 0);
  }
  await terminal.focus();
  await page.keyboard.type(linux ? 'printf "span_%s_%s\\n" local pty' : 'echo span_local_pty');
  await page.keyboard.press('Enter');
  if (exerciseWebgl) {
    const accelerated = page.locator('.terminal-canvas[data-renderer="webgl"]');
    await accelerated.waitFor();
    assert.equal(await accelerated.locator('.xterm-rows').count(), 0);
    assert.ok(await accelerated.evaluate(host => {
      for (const canvas of host.querySelectorAll('.xterm-screen canvas')) {
        const extension = canvas.getContext('webgl2')?.getExtension('WEBGL_lose_context');
        if (extension) {
          extension.loseContext();
          return true;
        }
      }
      return false;
    }));
    await page.locator('.terminal-canvas[data-renderer="dom"] .xterm-rows').waitFor();
    console.log('Verified the terminal returned to DOM rendering after WebGL context loss.');
  }
  await page.waitForFunction(() => [...document.querySelectorAll('.xterm-rows > div')]
    .some(line => line.textContent.trim() === 'span_local_pty'), null, { timeout: 10_000 });

  if (process.env.SPAN_TEST_SSH_ALIAS) {
    await page.getByRole('button', { name: '主机', exact: true }).click();
    await page.getByLabel('SSH 目标').fill(process.env.SPAN_TEST_SSH_ALIAS);
    await page.getByRole('button', { name: '连接 SSH' }).click();
    await page.waitForFunction(() => [...document.querySelectorAll('.xterm-rows > div')]
      .some(line => line.textContent.trim() === 'span_ssh_connected'));
    await terminal.focus();
    await page.keyboard.type('printf "span_%s_%s\\n" remote pty');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => [...document.querySelectorAll('.xterm-rows > div')]
      .some(line => line.textContent.trim() === 'span_remote_pty'));
  }
  await page.getByRole('button', { name: '会话', exact: true }).click();
  await page.getByRole('textbox', { name: '消息' }).fill('验证流式会话与底部终端。');
  await page.getByRole('textbox', { name: '消息' }).press('Enter');
  await page.getByText('流式输出已接通。', { exact: true }).waitFor();
  await page.getByRole('button', { name: '停止', exact: true }).click();
  await page.getByRole('button', { name: '发送', exact: true }).waitFor();
  assert.equal(await page.getByRole('alert').count(), 0);
  if (screenshot) {
    await page.getByRole('button', { name: '滚到最新消息' }).click();
    if (linux) execFileSync('import', ['-window', String(windowId), screenshot]);
    else await page.screenshot({ path: screenshot });
  }
  console.log('Verified history paging, file preview, PTY, streaming and interrupt.');
} finally {
  await app.close();
  await rm(profile, { recursive: true, force: true, maxRetries: 3 });
}
