import { _electron as electron } from 'playwright';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { burstMarker, terminalBurst } from './terminal-fixture.mjs';

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

async function checkAlignment(page) {
  const { reading, composer, brand, sidebar, controls, send, pageWidth } = await page.evaluate(() => {
    const rect = selector => document.querySelector(selector).getBoundingClientRect().toJSON();
    return {
      reading: rect('.timeline .reading-column'), composer: rect('.composer'),
      brand: rect('.brand'), sidebar: rect('.sidebar'), controls: rect('.titlebar-content'),
      send: rect('.send'), pageWidth: document.documentElement.scrollWidth,
    };
  });
  const close = (a, b) => Math.abs(a - b) <= 1;
  assert.ok(close(reading.left, composer.left) && close(reading.right, composer.right),
    `Reading column [${reading.left}, ${reading.right}] and composer [${composer.left}, ${composer.right}] must align`);
  assert.ok(close(brand.right, sidebar.right), 'Title bar and sidebar edges must align');
  assert.ok(close(controls.left, sidebar.right), 'Title bar controls must start in the workspace column');
  assert.ok(send.right <= composer.right && composer.right <= pageWidth, 'Composer must fit within the window');
}

try {
  const page = await app.firstWindow();
  page.on('pageerror', error => console.error(error));
  page.on('console', message => {
    if (message.type() === 'error') console.error(message.text());
  });
  await page.getByText('第 160 项', { exact: false }).waitFor({ timeout: 20_000 });
  await page.locator('.branch').getByText('prototype/web-workbench', { exact: true }).waitFor();
  await page.waitForFunction(() => {
    const overlay = navigator.windowControlsOverlay;
    if (!overlay?.visible) return false;
    const region = overlay.getTitlebarAreaRect();
    const terminal = document.querySelector('.topbar .terminal-toggle').getBoundingClientRect();
    return region.width > 0 && region.width < innerWidth && region.height > 0
      && terminal.left >= region.left && terminal.right <= region.right;
  });
  await checkAlignment(page);
  await page.getByRole('button', { name: '搜索' }).click();
  const search = page.getByRole('textbox', { name: '搜索会话' });
  await search.fill('没有对应的会话名称');
  await page.getByText('没有匹配的会话', { exact: true }).waitFor();
  await search.press('Escape');
  await page.getByRole('button', { name: '收起侧栏' }).click();
  await page.getByRole('button', { name: '展开侧栏' }).click();
  const windowId = linux && await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].getNativeWindowHandle().readUInt32LE(0));
  const grip = page.getByRole('separator', { name: '调整侧栏宽度' });
  const sidebar = page.locator('#workbench-sidebar');
  const original = Math.round((await sidebar.boundingBox()).width);
  const handle = await grip.boundingBox();
  const x = handle.x + handle.width / 2;
  const y = handle.y + handle.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 72, y, { steps: 4 });
  await page.mouse.up();
  await page.waitForFunction(expected =>
    document.getElementById('workbench-sidebar').offsetWidth === expected, original + 72);
  await checkAlignment(page);
  if (verifySandbox) {
    await page.reload();
    await page.getByText('第 160 项', { exact: false }).waitFor();
    assert.equal(Math.round((await sidebar.boundingBox()).width), original + 72);
  }
  await grip.dblclick();
  assert.equal(Math.round((await sidebar.boundingBox()).width), original);
  console.log('Verified sidebar drag and double-click reset.');
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
  await page.waitForFunction(() => Number(document.querySelector('[data-testid="transcript"]').dataset.items) >= 41);
  assert.ok(await transcript.locator('.message').count() < 30);

  await page.getByRole('button', { name: '文件', exact: true }).click();
  await page.getByRole('button', { name: 'README.md' }).click();
  await page.locator('.preview .prose').waitFor();
  await checkAlignment(page);
  if (!linux) {
    const size = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getContentSize());
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(800, 640));
    await page.waitForFunction(() => innerWidth <= 850);
    await checkAlignment(page);
    await app.evaluate(({ BrowserWindow }, [width, height]) =>
      BrowserWindow.getAllWindows()[0].setContentSize(width, height), size);
    await page.waitForFunction(width => innerWidth === width, size[0]);
  }
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

  if (!verifySandbox && !exerciseWebgl) {
    await page.keyboard.type(terminalBurst(!linux, true));
    await page.keyboard.press('Enter');
    await page.waitForFunction(marker => [...document.querySelectorAll('.xterm-rows > div')]
      .some(line => line.textContent.trim() === marker), burstMarker, { timeout: 25_000 });
    console.log('Verified terminal output larger than the acknowledgment window reached the screen.');
  }

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
  const composer = page.getByRole('textbox', { name: '消息' });
  const goal = page.locator('.goal-strip');
  await composer.fill('/goal 验证会话目标');
  await composer.press('Enter');
  await goal.getByText('验证会话目标').waitFor();
  assert.ok(await goal.evaluate(card => {
    const form = card.nextElementSibling;
    if (!form?.matches('form.composer')) return false;
    const a = card.getBoundingClientRect();
    const b = form.getBoundingClientRect();
    return a.bottom < b.top && Math.abs(a.left - b.left) <= 1 && Math.abs(a.right - b.right) <= 1;
  }));
  await goal.press('Enter');
  const goalPanel = page.getByRole('region', { name: '会话目标' });
  const dismissGoal = goalPanel.getByRole('button', { name: '关闭面板' });
  assert.ok(await dismissGoal.evaluate(button => button === document.activeElement));
  await page.keyboard.press('Escape');
  await goalPanel.waitFor({ state: 'detached' });
  assert.ok(await goal.evaluate(button => button === document.activeElement));
  await composer.fill('/goal pause');
  await composer.press('Enter');
  await goal.getByText('已暂停').waitFor();
  await composer.fill('验证流式会话与底部终端。');
  await composer.press('Enter');
  const reasoning = page.locator('[data-card="reasoning"]');
  const summary = reasoning.locator('summary');
  const summaryElement = await summary.elementHandle();
  const initialHeight = await summaryElement.evaluate(element => element.offsetHeight);
  assert.equal(await reasoning.locator('.card-body').count(), 0);
  await summary.getByText('确认目标卡片和输入区之间的间距。', { exact: true }).waitFor();
  assert.equal(await reasoning.count(), 1);
  assert.ok(await summaryElement.evaluate((element, height) => element.isConnected && element.offsetHeight === height, initialHeight));
  assert.ok(await goal.isVisible());
  if (screenshot) {
    await summary.scrollIntoViewIfNeeded();
    await page.screenshot({ path: screenshot.replace(/\.png$/, '-reasoning.png') });
  }
  await page.getByText('流式输出已接通。', { exact: true }).waitFor();
  await reasoning.getByText('推理摘要', { exact: true }).click();
  await reasoning.locator('ul ul').getByText('保留列表缩进', { exact: true }).waitFor();
  await reasoning.getByText('再确认工具结果和最终回复的前后顺序。', { exact: true }).waitFor();
  assert.equal(await page.locator('[data-card="command"] pre').count(), 0);
  if (screenshot) await page.screenshot({ path: screenshot.replace(/\.png$/, '-expanded.png') });
  await page.getByRole('button', { name: '停止', exact: true }).click();
  await page.getByRole('button', { name: '发送', exact: true }).waitFor();
  await summary.click();
  assert.equal(await summary.locator('.reasoning-preview').count(), 0);
  assert.equal(await page.getByRole('alert').count(), 0);
  await composer.fill('/usage');
  await composer.press('Enter');
  await page.getByRole('region', { name: '用量' }).getByText('已用 24%', { exact: true }).waitFor();
  await page.getByRole('button', { name: '关闭面板' }).click();
  await composer.fill('/agents');
  await composer.press('Enter');
  await page.getByRole('region', { name: '代理与团队' }).getByText('fixture-subagent', { exact: true }).waitFor();
  await page.getByRole('button', { name: '关闭面板' }).click();
  if (screenshot) {
    const latest = page.getByRole('button', { name: '滚到最新消息' });
    if (await latest.isVisible()) await latest.click();
    if (linux) execFileSync('import', ['-window', String(windowId), screenshot]);
    else {
      await page.getByRole('button', { name: '切换终端' }).click();
      await checkAlignment(page);
      await page.screenshot({ path: screenshot });
    }
  }
  await composer.fill('/goal clear');
  await composer.press('Enter');
  await goal.waitFor({ state: 'detached' });
  await page.getByRole('button', { name: /新会话/ }).click();
  await page.getByRole('heading', { name: '开始新会话' }).waitFor();
  assert.ok(await page.getByRole('textbox', { name: '消息' }).evaluate(element => document.activeElement === element));
  console.log('Verified history paging, file preview, PTY, streaming and interrupt.');
} finally {
  await app.close();
  await rm(profile, { recursive: true, force: true, maxRetries: 3 });
}
