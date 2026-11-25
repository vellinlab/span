import { _electron as electron } from 'playwright';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { pasteNativeImage, samplePng } from './clipboard-image.mjs';
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
  env: { ...process.env, SPAN_PREVIEW_PROFILE: profile, SPAN_PREVIEW_STREAM_GATE: profile },
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

async function checkTranscriptEdge(app, page, transcript, screenshot) {
  const originalTop = await transcript.evaluate(element => element.scrollTop);
  try {
    const { crop, focusPoint, scrollTop } = await transcript.evaluate(async timeline => {
      const viewport = timeline.getBoundingClientRect();
      const nearby = [...timeline.querySelectorAll('.message[data-kind="message"] strong')]
        .filter(node => /^第 \d+ 项/.test(node.textContent) && Math.abs(node.getBoundingClientRect().top - viewport.bottom) < 100)
        .sort((a, b) => Math.abs(a.getBoundingClientRect().top - viewport.bottom) - Math.abs(b.getBoundingClientRect().top - viewport.bottom));
      const heading = nearby[0];
      if (!heading) throw Error('No history heading near the bottom edge');
      for (let frame = 0; frame < 6; frame++) {
        const rect = heading.getBoundingClientRect();
        timeline.scrollTop += rect.top + rect.height / 2 - viewport.bottom;
        await new Promise(requestAnimationFrame);
      }
      const rect = heading.getBoundingClientRect();
      if (rect.top + 5 >= viewport.bottom || rect.bottom - 5 <= viewport.bottom) throw Error('The history heading was not clipped');
      const x = Math.ceil(rect.left);
      const y = Math.floor(viewport.bottom) - 10;
      return { crop: { x, y, width: Math.floor(rect.right) - x, height: 10 },
        focusPoint: { x: x + 2, y: y + 8 }, scrollTop: timeline.scrollTop };
    });
    const baseline = await page.addStyleTag({ content: '.transcript-viewport::before, .transcript-viewport::after { visibility: hidden }' });
    const before = await page.screenshot({ path: screenshot.replace(/\.png$/, '-transcript-edge-before.png'), scale: 'css' });
    await baseline.evaluate(element => element.remove());
    const after = await page.screenshot({ path: screenshot.replace(/\.png$/, '-transcript-edge-after.png'), scale: 'css' });
    const subdued = await app.evaluate(({ nativeImage }, { before, after, crop }) => {
      const pixels = png => nativeImage.createFromBuffer(Buffer.from(png, 'base64')).crop(crop).toBitmap();
      const original = pixels(before), softened = pixels(after);
      let changed = 0;
      for (let index = 0; index < original.length; index += 4) {
        if (original[index] > 110 && softened[index] < original[index] - 25) changed++;
      }
      return changed;
    }, { before: before.toString('base64'), after: after.toString('base64'), crop });
    assert.ok(subdued >= 12, `Expected the clipped heading to recede, observed ${subdued} toned-down pixels`);
    assert.ok(await transcript.evaluate((element, { focusPoint, scrollTop }) => {
      const overlay = getComputedStyle(element.parentElement, '::after');
      return element.scrollTop === scrollTop && overlay.pointerEvents === 'none' && Number.parseFloat(overlay.height) <= 14 &&
        element.contains(document.elementFromPoint(focusPoint.x, focusPoint.y));
    }, { focusPoint, scrollTop }));
  } finally {
    await transcript.evaluate(async (element, top) => {
      element.scrollTop = top;
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
    }, originalTop);
  }
}

try {
  const page = await app.firstWindow();
  page.on('pageerror', error => console.error(error));
  page.on('console', message => {
    if (message.type() === 'error') console.error(message.text());
  });
  await page.getByText('第 160 项', { exact: false }).waitFor({ timeout: 20_000 });
  const branch = page.locator('.topbar .branch');
  await branch.getByText('prototype/web-workbench', { exact: true }).waitFor();
  assert.equal(await branch.getAttribute('title'), 'prototype/web-workbench');
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
  assert.ok(await grip.evaluate(element => element.dataset.dragging === 'true' &&
    getComputedStyle(element, '::after').borderInlineStartWidth === '1px'));
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
  const localEcho = exerciseWebgl ? 'printf "\\033[31mspan_%s_%s\\033[0m\\n" local pty'
    : linux ? 'printf "span_%s_%s\\n" local pty' : 'echo span_local_pty';
  await page.keyboard.type(localEcho);
  await page.keyboard.press('Enter');
  if (exerciseWebgl) {
    const accelerated = page.locator('.terminal-canvas[data-renderer="webgl"]');
    await accelerated.waitFor();
    assert.equal(await accelerated.locator('.xterm-rows').count(), 0);
    let redPixels = 0;
    for (let frame = 0; frame < 12 && redPixels < 12; frame++) {
      const png = await accelerated.screenshot({ scale: 'css', timeout: 10_000 });
      redPixels = await app.evaluate(({ nativeImage }, data) => {
        const pixels = nativeImage.createFromBuffer(Buffer.from(data, 'base64')).toBitmap();
        let red = 0;
        for (let index = 0; index < pixels.length; index += 4) {
          if (Math.abs(pixels[index] - 121) <= 3 && Math.abs(pixels[index + 1] - 127) <= 3 &&
            Math.abs(pixels[index + 2] - 225) <= 3) red++;
        }
        return red;
      }, png.toString('base64'));
    }
    assert.ok(redPixels >= 12, `WebGL terminal echo painted ${redPixels} pixels matching the error red`);
    if (screenshot) await page.screenshot({ path: screenshot.replace(/\.png$/, '-terminal-color.png') });
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
    const restored = page.locator('.terminal-canvas[data-renderer="dom"] .xterm-rows');
    await restored.locator('.xterm-fg-1').filter({ hasText: /^span_local_pty$/ }).waitFor();
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
    await page.getByRole('textbox', { name: '消息' }).fill('这段文字只属于本机会话。');
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
    assert.equal(await page.getByRole('textbox', { name: '消息' }).inputValue(), '');
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
  assert.ok(await goalPanel.evaluate(panel => {
    const bounds = panel.getBoundingClientRect();
    const card = document.querySelector('.goal-strip').getBoundingClientRect();
    return Math.abs(bounds.left - card.left) <= 1 && bounds.right <= card.right + 1;
  }), 'The Goal panel should start at the left edge of its card and fit its column.');
  assert.ok(await dismissGoal.evaluate(button => button === document.activeElement));
  await page.keyboard.press('Escape');
  await goalPanel.waitFor({ state: 'detached' });
  assert.ok(await goal.evaluate(button => button === document.activeElement));
  await composer.fill('/goal pause');
  await composer.press('Enter');
  await goal.getByText('已暂停').waitFor();
  const goalWindowSize = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getContentSize());
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(740, 520));
  await page.waitForFunction(() => innerWidth <= 760 && innerHeight <= 540);
  await composer.fill(Array(12).fill('保留长草稿，准备继续核对会话。').join('\n'));
  await goal.press('Enter');
  const editGoal = goalPanel.getByRole('button', { name: '编辑', exact: true });
  const saveGoal = goalPanel.getByRole('button', { name: '保存目标' });
  const goalInput = goalPanel.getByRole('textbox', { name: '目标', exact: true });
  const goalBudget = goalPanel.getByRole('spinbutton', { name: 'Token 预算' });
  const goalText = goalPanel.locator('.goal-objective');
  assert.equal(await goalText.textContent(), '验证会话目标');
  assert.equal(await goalInput.count(), 0);
  await editGoal.press('Enter');
  assert.ok(await goalInput.evaluate(field => field === document.activeElement));
  const longGoal = Array.from({ length: 10 }, (_, index) =>
    `第 ${index + 1} 项。对照窗口尺寸、输入响应与会话恢复，记录对应的验收证据。`).join('\n');
  await goalInput.fill(longGoal);
  await goalBudget.fill('40000');
  await saveGoal.press('Enter');
  await goalText.waitFor();
  assert.equal(await goalText.textContent(), longGoal);
  assert.ok(await editGoal.evaluate(button => button === document.activeElement));
  await goal.getByText('已暂停', { exact: true }).waitFor();
  const compactGoal = await goalPanel.evaluate(panel => {
    const bounds = panel.getBoundingClientRect();
    const timeline = document.querySelector('.timeline').getBoundingClientRect();
    const card = document.querySelector('.goal-strip').getBoundingClientRect();
    const close = panel.querySelector('header button').getBoundingClientRect();
    const body = panel.querySelector('.agent-panel-content');
    const actions = panel.querySelector('.goal-actions').getBoundingClientRect();
    const hit = document.elementFromPoint(close.left + close.width / 2, close.top + close.height / 2);
    return { fits: bounds.top >= timeline.top + 4 && bounds.bottom < card.top,
      fillsColumn: Math.abs(bounds.left - card.left) <= 1 && Math.abs(bounds.right - card.right) <= 1,
      scrolls: body.scrollTop === 0 && body.scrollHeight > body.clientHeight,
      closeVisible: panel.querySelector('header button').contains(hit),
      actionsVisible: actions.top > body.getBoundingClientRect().top && actions.bottom <= bounds.bottom };
  });
  assert.deepEqual(compactGoal, {
    fits: true, fillsColumn: true, scrolls: true, closeVisible: true, actionsVisible: true,
  });
  if (screenshot) await page.screenshot({ path: screenshot.replace(/\.png$/, '-goal-compact.png') });
  await goalPanel.getByRole('button', { name: '继续', exact: true }).click();
  await goal.getByText('进行中', { exact: true }).waitFor();
  await goalPanel.getByRole('button', { name: '暂停', exact: true }).click();
  await goal.getByText('已暂停', { exact: true }).waitFor();
  await editGoal.click();
  const editorFits = await goalInput.evaluate(field => {
    const editor = field.closest('form');
    const budget = editor.querySelector('input[type="number"]');
    const save = editor.querySelector('button[type="submit"]');
    const rect = control => control.getBoundingClientRect();
    const reachable = control => {
      const { x, y, width, height } = rect(control);
      return control.contains(document.elementFromPoint(x + width / 2, y + height / 2));
    };
    const budgetTop = rect(budget).top;
    const scrollTop = field.scrollTop;
    field.scrollTop = field.scrollHeight;
    const scrolls = field.scrollTop > scrollTop && rect(budget).top === budgetTop;
    field.scrollTop = scrollTop;
    return scrolls && field.clientHeight >= 42 && reachable(field) && reachable(budget) && reachable(save)
      && Math.abs(rect(budget).top - rect(save).top) <= 1;
  });
  assert.ok(editorFits, 'The editor scrolls independently and the budget and save stay in the same visible row');
  if (screenshot) await page.screenshot({ path: screenshot.replace(/\.png$/, '-goal-editor-compact.png') });
  await goalInput.press('Tab');
  assert.ok(await goalBudget.evaluate(field => field === document.activeElement));
  if (!process.env.SPAN_TEST_SSH_ALIAS) {
    await goalInput.fill('验收延迟目标保存。');
    await saveGoal.press('Enter');
    await goalPanel.getByText('320 / 40,000 tokens', { exact: true }).waitFor();
    const newer = '确认后保留的目标草稿。';
    await goalInput.fill(newer);
    await goalBudget.fill('64000');
    await goalInput.focus();
    await goalInput.evaluate(field => field.setSelectionRange(2, 6));
    await writeFile(join(profile, 'goal-save'), '');
    await goal.getByText('验收延迟目标保存。', { exact: true }).waitFor();
    await goalPanel.locator('button[type="submit"][aria-disabled="false"]').waitFor();
    assert.equal(await goalInput.inputValue(), newer);
    assert.equal(await goalBudget.inputValue(), '64000');
    assert.deepEqual(await goalInput.evaluate(field => [
      field === document.activeElement, field.selectionStart, field.selectionEnd,
    ]), [true, 2, 6]);
    if (screenshot) await page.screenshot({ path: screenshot.replace(/\.png$/, '-goal-edit.png') });
    await saveGoal.press('Enter');
    await goalPanel.getByText(newer, { exact: true }).waitFor();
    await goalPanel.getByText('320 / 64,000 tokens', { exact: true }).waitFor();
    await editGoal.press('Enter');
    await goalBudget.fill('');
    await saveGoal.press('Enter');
    await goalText.waitFor();
    await goal.getByText('已暂停', { exact: true }).waitFor();
    await goalPanel.getByText('320 tokens', { exact: true }).waitFor();
  }
  await dismissGoal.press('Escape');
  await goalPanel.waitFor({ state: 'detached' });
  assert.ok(await goal.evaluate(button => button === document.activeElement));
  await composer.fill('/goal edit');
  await composer.press('Enter');
  assert.ok(await goalInput.evaluate(field => field === document.activeElement));
  await goalInput.press('Escape');
  await goalPanel.waitFor({ state: 'detached' });
  assert.ok(await composer.evaluate(field => field === document.activeElement));
  await composer.fill('/');
  const commandList = page.locator('.command-list');
  await commandList.waitFor();
  for (let index = 1, count = await commandList.locator('button').count(); index < count; index++) await composer.press('ArrowDown');
  assert.ok(await commandList.locator('button[data-active="true"]').evaluate(button => {
    const item = button.getBoundingClientRect(), list = button.parentElement.getBoundingClientRect();
    return item.top >= list.top && item.bottom <= list.bottom;
  }));
  await composer.press('Escape');
  await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(...size), goalWindowSize);
  await page.waitForFunction(([width, height]) => Math.abs(innerWidth - width) <= 2 && Math.abs(innerHeight - height) <= 2, goalWindowSize);
  await composer.fill('验证流式会话与底部终端。');
  await composer.press('Enter');
  const liveReasoning = page.getByRole('button', { name: '实时推理摘要' });
  const archivedReasoning = transcript.locator('[data-card="reasoning"]').filter({ hasText: '推理摘要' });
  const liveElement = await liveReasoning.elementHandle();
  const liveRect = await liveElement.evaluate(element => element.getBoundingClientRect().toJSON());
  assert.equal(await archivedReasoning.count(), 0);
  assert.equal(await page.locator('#reasoning-panel').count(), 0);
  const reasoningJump = page.getByRole('button', { name: '滚到最新消息' });
  await transcript.hover({ position: { x: 12, y: 80 } });
  const beforeReasoningScroll = await transcript.evaluate(element => element.scrollTop);
  await page.mouse.wheel(0, -640);
  await page.waitForFunction(previous => {
    const element = document.querySelector('.timeline');
    return previous - element.scrollTop >= 400 && element.scrollHeight - element.clientHeight - element.scrollTop >= 400;
  }, beforeReasoningScroll);
  await reasoningJump.waitFor();
  const reasoningAnchor = await transcript.evaluate(element => element.scrollTop);
  await liveReasoning.getByText('确认目标卡片和输入区之间的间距。', { exact: true }).waitFor();
  assert.ok(await liveElement.evaluate((element, initial) => {
    const rect = element.getBoundingClientRect();
    const goalRect = element.nextElementSibling.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
    return element.contains(hit) && rect.y === initial.y && rect.height === initial.height
      && rect.x === goalRect.x && rect.width === goalRect.width && rect.bottom < goalRect.top;
  }, liveRect));
  assert.equal(await transcript.evaluate(element => element.scrollTop), reasoningAnchor);
  if (screenshot) {
    await checkTranscriptEdge(app, page, transcript, screenshot);
    await page.screenshot({ path: screenshot.replace(/\.png$/, '-reasoning.png') });
  }
  await liveReasoning.press('Enter');
  const reasoningPanel = page.getByRole('region', { name: '推理摘要' });
  await reasoningPanel.locator('ul ul').getByText('保留列表缩进', { exact: true }).waitFor();
  await reasoningPanel.getByText('再确认工具结果和最终回复的前后顺序。', { exact: true }).waitFor();
  await reasoningPanel.getByText('确认目标卡片和输入区之间的间距。', { exact: false }).waitFor();
  if (screenshot) await page.screenshot({ path: screenshot.replace(/\.png$/, '-expanded.png') });
  const summaryLayout = await reasoningPanel.evaluate(panel => {
    const [earlier, later] = panel.querySelectorAll('.reasoning-sections');
    const [first, second] = earlier.querySelectorAll('.prose');
    const x = element => element.getBoundingClientRect().left;
    const title = panel.querySelector('header strong');
    const list = first.querySelector('ul');
    const indent = x(list.querySelector(':scope > li > ul > li')) - x(list.querySelector(':scope > li'));
    return {
      aligned: Math.abs(x(title) - x(first)) <= 1 && Math.abs(x(first) - x(second)) <= 1,
      nested: indent >= 16 && indent <= 23,
      groups: getComputedStyle(earlier).borderTopWidth === '0px' && getComputedStyle(later).borderTopWidth === '1px',
      aboveStrip: panel.getBoundingClientRect().bottom <= document.querySelector('.reasoning-strip').getBoundingClientRect().top,
    };
  });
  assert.deepEqual(summaryLayout, { aligned: true, nested: true, groups: true, aboveStrip: true });
  await reasoningPanel.getByRole('button', { name: '关闭面板' }).press('Tab');
  const reasoningBody = reasoningPanel.getByRole('group', { name: '推理摘要正文' });
  assert.ok(await reasoningBody.evaluate(element => element === document.activeElement));
  await reasoningBody.press('Escape');
  await reasoningPanel.waitFor({ state: 'detached' });
  assert.ok(await liveReasoning.evaluate(element => element === document.activeElement));
  await liveReasoning.press('Enter');
  await page.getByRole('button', { name: '停止', exact: true }).evaluate(button => button.click());
  await page.getByRole('button', { name: '发送', exact: true }).waitFor();
  await liveReasoning.waitFor({ state: 'detached' });
  await reasoningPanel.waitFor({ state: 'detached' });
  assert.ok(await composer.evaluate(element => element === document.activeElement));
  assert.ok(Math.abs(await transcript.evaluate(element => element.scrollTop) - reasoningAnchor) <= 2);
  await reasoningJump.click();
  await transcript.getByText('流式输出已接通。', { exact: true }).waitFor();
  const earlyReasoning = archivedReasoning.filter({ hasText: '再确认工具结果和最终回复的前后顺序。' });
  const lateReasoning = archivedReasoning.filter({ hasText: '确认目标卡片和输入区之间的间距。' });
  await earlyReasoning.locator('summary').click();
  await earlyReasoning.locator('ul ul').getByText('保留列表缩进', { exact: true }).waitFor();
  await lateReasoning.locator('summary').waitFor();
  assert.equal(await lateReasoning.locator('.card-body').count(), 0);
  assert.equal(await transcript.locator('[data-card="command"] pre').count(), 0);
  await earlyReasoning.locator('summary').click();
  assert.equal(await page.getByRole('alert').count(), 0);
  console.log('Verified the fixed reasoning strip, history scroll position, nested details, and archived summary.');
  await composer.fill('/usage');
  await composer.press('Enter');
  const usage = page.getByRole('region', { name: '用量', exact: true });
  const sessionUsage = usage.getByRole('region', { name: '会话用量' });
  const accountUsage = usage.getByRole('region', { name: '账号额度' });
  await sessionUsage.getByText('140 / 512', { exact: true }).waitFor();
  await accountUsage.getByText('已用 24%', { exact: true }).waitFor();
  const weekly = accountUsage.getByRole('progressbar', { name: /项目共享额度与连续交付窗口 · 7 天$/ });
  await weekly.waitFor();
  const usageSize = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getContentSize());
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(740, 520));
  await page.waitForFunction(() => Math.abs(innerWidth - 740) <= 2 && Math.abs(innerHeight - 520) <= 2);
  assert.ok(await weekly.evaluate(meter => {
    const quota = meter.closest('.quota');
    const [name, percent] = quota.querySelector('.quota-heading').children;
    const outer = quota.closest('.agent-panel-content');
    const nameBox = name.getBoundingClientRect(), valueBox = percent.getBoundingClientRect();
    return quota.dataset.nearLimit === 'true' && valueBox.left > nameBox.right && nameBox.height > valueBox.height
      && outer.scrollWidth === outer.clientWidth && meter.value === 92;
  }), 'Long quota labels wrap while the percentage and meter remain intact');
  assert.equal(await accountUsage.locator('time').getAttribute('datetime'), new Date(1795670400000).toISOString());
  const closeUsage = usage.getByRole('button', { name: '关闭面板' });
  const refreshUsage = usage.getByRole('button', { name: '刷新用量' });
  const usageDetails = usage.getByRole('group', { name: '用量明细' });
  await closeUsage.press('Tab');
  assert.ok(await usageDetails.evaluate(element => document.activeElement === element));
  assert.ok(await usageDetails.evaluate(element => element.scrollHeight > element.clientHeight));
  const refreshPosition = await refreshUsage.boundingBox();
  await usageDetails.press('End');
  await page.waitForFunction(() => {
    const body = document.querySelector('[data-kind="usage"] .agent-panel-content');
    return body.scrollHeight - body.clientHeight - body.scrollTop <= 2;
  });
  assert.deepEqual(await refreshUsage.boundingBox(), refreshPosition);
  const usageScroll = await usageDetails.evaluate(element => element.scrollTop);
  await refreshUsage.focus();
  if (screenshot) await page.screenshot({ path: screenshot.replace(/\.png$/, '-usage-compact.png') });
  await writeFile(join(profile, 'usage-live-update'), '');
  await refreshUsage.press('Enter');
  await accountUsage.getByText('已用 67%', { exact: true }).waitFor();
  await usage.getByRole('button', { name: '刷新中…' }).waitFor();
  await writeFile(join(profile, 'usage-reply'), '');
  await refreshUsage.waitFor();
  await accountUsage.getByText('已用 67%', { exact: true }).waitFor();
  assert.equal(await accountUsage.getByText('已用 31%', { exact: true }).count(), 0);
  assert.ok(Math.abs(await usageDetails.evaluate(element => element.scrollTop) - usageScroll) <= 2);
  await Promise.all([rm(join(profile, 'usage-live-update')), rm(join(profile, 'usage-reply'))]);
  await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(...size), usageSize);
  await page.waitForFunction(([width, height]) => Math.abs(innerWidth - width) <= 2 && Math.abs(innerHeight - height) <= 2, usageSize);
  await writeFile(join(profile, 'usage-context-only'), '');
  await refreshUsage.click();
  await usage.getByRole('button', { name: '刷新中…' }).waitFor();
  await writeFile(join(profile, 'usage-reply'), '');
  await sessionUsage.getByText('上限 512', { exact: true }).waitFor();
  await accountUsage.waitFor({ state: 'detached' });
  assert.equal(await usage.getByRole('progressbar').count(), 0);
  assert.equal(await usage.getByText('当前没有可显示的用量。').count(), 0);
  await refreshUsage.waitFor();
  if (screenshot) await page.screenshot({ path: screenshot.replace(/\.png$/, '-usage-context-only.png') });
  await Promise.all([rm(join(profile, 'usage-context-only')), rm(join(profile, 'usage-reply'))]);
  await closeUsage.press('Tab');
  assert.ok(await usageDetails.evaluate(element => document.activeElement === element));
  await page.keyboard.press('Escape');
  await usage.waitFor({ state: 'detached' });
  assert.ok(await composer.evaluate(element => document.activeElement === element));
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
  await composer.fill('验证审批与表单。');
  await composer.press('Enter');
  await transcript.getByText('验证审批与表单。', { exact: true }).waitFor();
  await page.locator('.send.stop:enabled').waitFor();
  await transcript.evaluate(element => { element.scrollTop = 300; });
  const latest = page.getByRole('button', { name: '滚到最新消息' });
  await latest.waitFor();
  const anchor = await transcript.evaluate(element => element.scrollTop);
  await composer.fill('/usage');
  await composer.press('Enter');
  const approval = page.getByRole('region', { name: '确认命令操作' });
  await approval.getByText('还有 1 项', { exact: true }).waitFor();
  await approval.getByText(process.env.SPAN_TEST_SSH_ALIAS || '本机', { exact: true }).waitFor();
  await approval.getByText('工作目录', { exact: true }).waitFor();
  await page.getByText('等待审批', { exact: true }).waitFor();
  assert.ok(Math.abs(await transcript.evaluate(element => element.scrollTop) - anchor) <= 2);
  const layout = await approval.evaluate(element => {
    const body = element.querySelector('.approval-body');
    const actions = element.querySelector('.approval-actions');
    const button = actions.querySelector('button').getBoundingClientRect();
    const hit = document.elementFromPoint(button.left + button.width / 2, button.top + button.height / 2);
    return { scrolls: body.scrollHeight > body.clientHeight, canAnswer: actions.contains(hit),
      popoverAbove: document.querySelector('.agent-panel')?.getBoundingClientRect().bottom <= element.getBoundingClientRect().top };
  });
  assert.deepEqual(layout, { scrolls: true, canAnswer: true, popoverAbove: true });
  await composer.press('Escape');
  await usage.waitFor({ state: 'detached' });
  if (screenshot) await page.screenshot({ path: screenshot.replace(/\.png$/, '-approval.png') });
  const windowSize = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getContentSize());
  const terminalToggle = page.getByRole('button', { name: '切换终端' });
  const wasTerminalOpen = await terminalToggle.getAttribute('aria-pressed') === 'true';
  if (!wasTerminalOpen) await terminalToggle.click();
  await page.locator('section.terminal-panel').waitFor();
  const preview = page.getByRole('complementary', { name: '文件预览' });
  const restorePreview = page.getByRole('button', { name: '恢复文件预览' });
  let fileContent;
  if (!process.env.SPAN_TEST_SSH_ALIAS) {
    await page.getByRole('button', { name: '文件', exact: true }).click();
    await page.getByRole('button', { name: 'README.md' }).click();
    const content = preview.locator('.preview-content');
    await content.focus();
    fileContent = await content.elementHandle();
    assert.ok(await approval.evaluate(element =>
      element.getBoundingClientRect().right <= document.querySelector('#file-preview').getBoundingClientRect().left));
  }
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(740, 520));
  await page.waitForFunction(() => innerWidth <= 760 && innerHeight <= 540);
  if (fileContent) {
    await preview.waitFor({ state: 'hidden' });
    await restorePreview.waitFor();
    assert.equal(await restorePreview.isEnabled(), false);
    assert.ok(await approval.evaluate(element => document.activeElement === element));
  }
  await composer.fill(Array(20).fill('处理审批后请继续，保留本次检查的结果。').join('\n'));
  assert.ok(await composer.evaluate(element => element.scrollHeight > element.clientHeight));
  assert.ok(await branch.evaluate(element => {
    const bounds = element.getBoundingClientRect();
    const breadcrumb = element.previousElementSibling;
    const title = breadcrumb.querySelector('strong');
    return title.scrollWidth === title.clientWidth &&
      bounds.left >= breadcrumb.getBoundingClientRect().right &&
      bounds.right <= element.parentElement.nextElementSibling.getBoundingClientRect().left &&
      bounds.bottom <= element.closest('.topbar').getBoundingClientRect().bottom;
  }), 'The branch sits between the session title and window actions');
  assert.ok(await page.evaluate(() => {
    const rect = selector => document.querySelector(selector).getBoundingClientRect();
    const body = rect('.approval-body');
    const command = document.querySelector('.approval-operation pre').firstChild;
    const firstLine = document.createRange();
    firstLine.setStart(command, 0);
    firstLine.setEnd(command, command.textContent.indexOf('\n'));
    const commandStart = firstLine.getBoundingClientRect();
    const refuse = rect('.approval-actions button');
    const hit = document.elementFromPoint(refuse.left + refuse.width / 2, refuse.top + refuse.height / 2);
    return rect('.timeline').height >= 44 && rect('.approval-context').bottom <= body.bottom &&
      commandStart.top >= body.top && commandStart.bottom <= body.bottom + 1 &&
      rect('.approval-actions').bottom <= rect('.composer').top && rect('.terminal-canvas').height >= 70 &&
      rect('.composer').bottom <= rect('.terminal-panel').top && Boolean(hit?.closest('.approval-actions button'));
  }), 'History, approval scope, the first command line, actions, the long draft and terminal fit at the minimum window size');
  if (screenshot) await page.screenshot({ path: screenshot.replace(/\.png$/, '-approval-compact.png') });
  const approvalDetails = approval.getByRole('group', { name: '操作详情' });
  await approval.focus();
  await page.keyboard.press('Tab');
  assert.ok(await approvalDetails.evaluate(element => document.activeElement === element));
  await page.keyboard.press('End');
  await page.waitForFunction(() => {
    const reason = document.querySelector('.approval-reason');
    const body = reason.parentElement.getBoundingClientRect();
    const text = reason.getBoundingClientRect();
    return text.top >= body.top && text.bottom <= body.bottom + 1;
  });
  await page.keyboard.press('Home');
  await page.waitForFunction(() => document.querySelector('.approval-body').scrollTop === 0);
  await composer.fill('');
  await approval.getByRole('button', { name: '拒绝' }).press('Enter');
  const question = page.getByRole('region', { name: 'Agent 请求输入' });
  await question.waitFor();
  assert.ok(await question.evaluate(element => document.activeElement === element));
  await question.getByRole('combobox', { name: '验证平台' }).selectOption('桌面');
  await question.getByRole('textbox', { name: '验证结果' }).fill('布局正常');
  await question.getByRole('button', { name: '提交回答' }).press('Enter');
  await question.waitFor({ state: 'detached' });
  assert.ok(await composer.evaluate(element => document.activeElement === element));
  await latest.click();
  await page.getByText('审批回复：拒绝，已收到回答。', { exact: true }).waitFor();
  if (fileContent) {
    await restorePreview.click();
    await preview.getByText('README.md', { exact: true }).waitFor();
    assert.ok(await fileContent.evaluate(element => element.isConnected && document.activeElement === element));
    assert.equal(await page.locator('main[inert]').count(), 1);
    assert.ok(await preview.evaluate(element => element.offsetWidth === element.parentElement.offsetWidth));
    if (screenshot) await page.screenshot({ path: screenshot.replace(/\.png$/, '-preview-restored.png') });
    await terminalToggle.click();
    await preview.waitFor({ state: 'hidden' });
    assert.equal(await terminalToggle.getAttribute('aria-pressed'), 'true');
    await restorePreview.click();
    await fileContent.press('Escape');
    await preview.waitFor({ state: 'detached' });
    assert.equal(await fileContent.evaluate(element => element.isConnected), false);
    assert.ok(await page.getByRole('button', { name: 'README.md' }).evaluate(element => element === document.activeElement));
    console.log('Verified the compact preview fills the workspace, yields to approval or terminal, and restores keyboard focus.');
  }
  await page.getByRole('button', { name: '停止', exact: true }).waitFor({ state: 'detached' });
  const heading = page.locator('.breadcrumb strong');
  const previousTitle = await heading.textContent();
  const longTitle = '工作台架构评审与 Windows 和 EL8 桌面的窗口布局验收';
  await composer.fill('/rename ' + longTitle);
  await composer.press('Enter');
  await heading.filter({ hasText: longTitle }).waitFor();
  await grip.press('End');
  await page.waitForFunction(() => {
    const grip = document.querySelector('.sidebar-grip');
    return grip.getAttribute('aria-valuenow') === grip.getAttribute('aria-valuemax');
  });
  const separatorFocusVisible = () => grip.evaluate(element => {
    const stroke = getComputedStyle(element, '::after');
    return element.matches(':focus-visible') && getComputedStyle(element).outlineStyle === 'none' &&
      stroke.borderInlineStartWidth === '3px' &&
      stroke.borderInlineStartColor !== getComputedStyle(element.parentElement).backgroundColor;
  });
  assert.ok(await separatorFocusVisible(), 'The focused separator should display one visible stroke.');
  if (screenshot) await page.screenshot({ path: screenshot.replace(/\.png$/, '-sidebar-focus.png') });
  await page.emulateMedia({ forcedColors: 'active' });
  assert.ok(await separatorFocusVisible(), 'The separator focus should remain visible in forced colors.');
  await page.emulateMedia({ forcedColors: null });
  const narrowTitle = await heading.evaluate(element => {
    const location = element.closest('.titlebar-location');
    const workspace = location.querySelector('.breadcrumb-workspace');
    const branch = location.querySelector('.branch');
    const terminal = location.parentElement.querySelector('.terminal-toggle').getBoundingClientRect();
    const region = navigator.windowControlsOverlay.getTitlebarAreaRect();
    return {
      width: element.clientWidth, available: location.clientWidth, path: workspace.title, title: element.title,
      workspaceNameHidden: getComputedStyle(workspace.lastElementChild).clipPath !== 'none',
      branchNameHidden: getComputedStyle(branch.lastElementChild).clipPath !== 'none',
      terminalFits: terminal.left >= location.getBoundingClientRect().right && terminal.right <= region.right,
    };
  });
  assert.equal(narrowTitle.title, longTitle);
  assert.ok(narrowTitle.path && narrowTitle.terminalFits);
  const compactTitlebar = narrowTitle.available <= 280;
  assert.equal(narrowTitle.workspaceNameHidden, compactTitlebar);
  assert.equal(narrowTitle.branchNameHidden, compactTitlebar);
  if (compactTitlebar) assert.ok(narrowTitle.width >= narrowTitle.available - 73);
  if (screenshot) {
    await composer.focus();
    await page.screenshot({ path: screenshot.replace(/\.png$/, '-titlebar-narrow.png') });
  }
  const showSidebar = page.getByRole('button', { name: '展开侧栏' });
  await page.getByRole('button', { name: '收起侧栏' }).press('Enter');
  await showSidebar.waitFor();
  assert.ok(await showSidebar.evaluate(element => element === document.activeElement));
  assert.ok(await heading.evaluate((element, previous) => element.clientWidth > previous &&
    getComputedStyle(element.closest('.breadcrumb').querySelector('.breadcrumb-workspace span')).clipPath === 'none',
  narrowTitle.width));
  await showSidebar.press('Enter');
  await grip.dblclick();
  await composer.fill('/rename ' + previousTitle);
  await composer.press('Enter');
  await heading.filter({ hasText: previousTitle }).waitFor();
  console.log('Verified that a long session title keeps space beside the native window controls and sidebar.');
  await app.evaluate(({ BrowserWindow }, [width, height]) =>
    BrowserWindow.getAllWindows()[0].setContentSize(width, height), windowSize);
  await page.waitForFunction(([width, height]) => innerWidth === width && innerHeight === height, windowSize);
  if (!wasTerminalOpen) await terminalToggle.click();
  console.log('Verified long approvals, action visibility, queued input, focus and the backend reply.');
  await composer.fill('/goal clear');
  await composer.press('Enter');
  await goal.waitFor({ state: 'detached' });

  const sendPlanMessage = async text => {
    await composer.fill(text);
    await composer.press('Enter');
  };
  const plan = transcript.locator('[data-card="plan"]').last();
  const planSummary = plan.locator('summary');
  const steps = plan.getByRole('list', { name: '计划步骤' });
  await sendPlanMessage('验证任务计划。');
  await planSummary.getByText('已完成 1/3', { exact: true }).waitFor();
  for (const status of ['已完成', '进行中', '等待中']) {
    await steps.getByRole('img', { name: status, exact: true }).waitFor();
  }
  const waitForTranscriptEnd = () => page.waitForFunction(() => {
    const element = document.querySelector('[data-testid="transcript"]');
    return element && element.scrollHeight - element.clientHeight - element.scrollTop <= 2;
  });
  await waitForTranscriptEnd();
  if (screenshot) await page.screenshot({ path: screenshot.replace(/\.png$/, '-plan-active.png') });
  await sendPlanMessage('完成计划。');
  const planAnswer = transcript.getByText('计划验收完成。', { exact: true });
  await planAnswer.waitFor();
  await planSummary.getByText('已完成 3/3', { exact: true }).waitFor();
  await steps.waitFor({ state: 'detached' });
  await waitForTranscriptEnd();
  assert.ok(await planAnswer.evaluate(element => {
    const answer = element.getBoundingClientRect();
    const viewport = element.closest('[data-testid="transcript"]').getBoundingClientRect();
    return answer.top >= viewport.top && answer.bottom <= viewport.bottom;
  }));
  if (screenshot) await page.screenshot({ path: screenshot.replace(/\.png$/, '-plan-complete.png') });
  await planSummary.press('Enter');
  await steps.waitFor();
  assert.equal(await steps.getByRole('img', { name: '已完成', exact: true }).count(), 3);
  await planSummary.press('Enter');
  await steps.waitFor({ state: 'detached' });

  await sendPlanMessage('验证任务计划。');
  await planSummary.getByText('已完成 1/3', { exact: true }).waitFor();
  await steps.waitFor();
  await planSummary.press('Enter');
  await steps.waitFor({ state: 'detached' });
  await sendPlanMessage('推进计划。');
  await planSummary.getByText('已完成 2/3', { exact: true }).waitFor();
  assert.equal(await steps.count(), 0);
  await planSummary.getByText('复核窄窗中的长草稿。', { exact: true }).waitFor();
  await planSummary.press('Enter');
  await steps.waitFor();
  await sendPlanMessage('完成计划。');
  await page.getByRole('button', { name: '停止', exact: true }).waitFor({ state: 'detached' });
  await planSummary.getByText('已完成 3/3', { exact: true }).waitFor();
  assert.equal(await steps.getByRole('img', { name: '已完成', exact: true }).count(), 3);
  console.log('Verified live and archived plan details, progress updates, and manual disclosure.');

  await composer.fill('验证连续工具活动。');
  await composer.press('Enter');
  const group = transcript.getByRole('button', { name: '6 条命令 · 2 次工具调用', exact: true });
  const groupAnswer = transcript.getByText('连续工具活动验收完成。', { exact: true });
  const firstCommand = transcript.locator('[data-card="command"]').filter({ hasText: 'git status --short -- review-1' });
  const failedCommand = transcript.locator('[data-card="command"]').filter({ hasText: 'git diff --check -- review-missing' });
  const change = transcript.locator('[data-card="patch"]').filter({ hasText: 'review-notes.md' });
  await group.waitFor();
  await groupAnswer.waitFor();
  await change.waitFor();
  assert.equal(await change.locator('summary > .file-reference-name').getAttribute('title'), 'review/notes/review-notes.md');
  await failedCommand.getByText('失败', { exact: true }).waitFor();
  await failedCommand.getByText('退出码 1', { exact: true }).waitFor();
  assert.equal(await failedCommand.getAttribute('data-failed'), 'true');
  assert.equal(await change.getAttribute('data-failed'), null);
  assert.ok(await failedCommand.locator('summary').evaluate(element => {
    const lead = element.querySelector('.card-icon.lucide-circle-alert');
    const title = element.querySelector('.card-title');
    const status = element.querySelector('.card-status');
    return lead?.getBoundingClientRect().right < title.getBoundingClientRect().left &&
      title.getBoundingClientRect().right < status.getBoundingClientRect().left &&
      getComputedStyle(lead).color === getComputedStyle(status).color;
  }), 'Failed activities use the same warning at the leading icon and the status label.');
  await waitForTranscriptEnd();
  assert.ok(await groupAnswer.evaluate(element => {
    const answer = element.getBoundingClientRect();
    const viewport = element.closest('[data-testid="transcript"]').getBoundingClientRect();
    return answer.top >= viewport.top && answer.bottom <= viewport.bottom;
  }));
  assert.equal(await group.getAttribute('aria-expanded'), 'false');
  assert.equal(await firstCommand.count(), 0);
  if (screenshot) await page.screenshot({ path: screenshot.replace(/\.png$/, '-activity-group.png') });
  await group.press('Enter');
  const fileTool = transcript.locator('[data-card="tool"]').filter({ hasText: '复核记录 2' });
  const fileTarget = 'review/checks/工作区检查-2.txt';
  const fileSummary = fileTool.locator('summary');
  assert.equal(await fileSummary.locator('.file-reference-name').getAttribute('title'), fileTarget);
  assert.equal(await fileSummary.locator('.file-reference-name').textContent(), '工作区检查-2.txt');
  assert.equal(await fileTool.locator('.tool-context').count(), 0);
  await fileSummary.press('Enter');
  await fileTool.locator('.tool-context').getByText(fileTarget, { exact: true }).waitFor();
  await fileTool.locator('.tool-context').getByText('工作区', { exact: true }).waitFor();
  await fileTool.getByText('记录可读。', { exact: true }).waitFor();
  await fileSummary.press('Enter');
  await fileTool.locator('.tool-context').waitFor({ state: 'detached' });
  await firstCommand.locator('summary').press('Enter');
  await firstCommand.getByText('第 1 条命令的输出。', { exact: true }).waitFor();
  assert.equal(await group.getAttribute('aria-expanded'), 'true');
  await group.press('Enter');
  await firstCommand.waitFor({ state: 'detached' });
  assert.ok(await group.evaluate(element => element === document.activeElement));
  await failedCommand.getByText('退出码 1', { exact: true }).waitFor();
  console.log('Verified completed tool groups preserve the failure card and unmount folded commands and output.');

  await composer.fill('这段草稿留在原会话。');
  await page.getByRole('button', { name: /新会话/ }).click();
  const welcome = page.getByRole('heading', { name: '开始新会话' });
  await welcome.waitFor();
  assert.equal(await branch.count(), 0);
  assert.ok(await composer.evaluate(element => document.activeElement === element));
  assert.equal(await composer.inputValue(), '');
  const welcomeInputHeight = await composer.evaluate(element => element.clientHeight);
  assert.ok(await welcome.evaluate(element => {
    const heading = element.getBoundingClientRect();
    const form = element.closest('.composer-wrap').querySelector('.composer').getBoundingClientRect();
    return heading.bottom < form.top && Math.abs(heading.left + heading.right - form.left - form.right) <= 1
      && form.width <= 600 && getComputedStyle(element).textAlign === 'center';
  }), 'The welcome heading and composer share a centered column.');
  if (screenshot) await page.screenshot({ path: screenshot.replace(/\.png$/, '-composer-welcome.png') });
  const retryDraft = '验证新会话草稿重试。';
  await composer.fill(retryDraft);
  const attach = page.getByRole('button', { name: '添加本机文件', exact: true });
  const draftFiles = page.getByRole('list', { name: '待发送的附件' });
  const fileName = '会话交接记录.txt';
  const imageName = '会话窗口示意.png';
  const previewImageName = '预览图片 · ' + imageName;
  if (process.env.SPAN_TEST_SSH_ALIAS) {
    assert.equal(await attach.count(), 0);
  } else {
    const reference = join(profile, fileName);
    const image = join(profile, imageName);
    const removedName = '较长文件名用于核对会话附件的省略和键盘移除.txt';
    const removed = join(profile, removedName);
    await Promise.all([writeFile(reference, '附件验收'), writeFile(removed, '这份文件应从草稿移除'), writeFile(image, samplePng)]);
    const pick = async paths => {
      await app.evaluate(({ dialog }, filePaths) => {
        dialog.showOpenDialog = async (_window, options) => ({
          canceled: false, filePaths: options.properties.includes('openFile') &&
            options.properties.includes('multiSelections') ? filePaths : [],
        });
      }, paths);
      await attach.click();
      await page.waitForFunction(() => document.activeElement === document.querySelector('.composer textarea'));
    };
    await pick([reference, image, removed]);
    await draftFiles.getByTitle(removed, { exact: true }).waitFor();
    const draftImage = draftFiles.getByRole('button', { name: previewImageName, exact: true });
    await draftImage.press('Enter');
    const closeImage = preview.getByRole('button', { name: '关闭预览' });
    await page.waitForFunction(() => document.querySelector('#file-preview img')?.naturalWidth > 0);
    assert.ok(await closeImage.evaluate(element => document.activeElement === element));
    await closeImage.press('Escape');
    await preview.waitFor({ state: 'detached' });
    assert.ok(await draftImage.evaluate(element => document.activeElement === element));
    await pick([reference]);
    assert.equal(await draftFiles.getByRole('listitem').count(), 3);
    await draftFiles.getByRole('button', { name: '移除附件 · ' + removedName }).press('Enter');
    assert.ok(await composer.evaluate(element => document.activeElement === element));
    assert.equal(await draftFiles.getByRole('listitem').count(), 2);
    assert.equal(await draftFiles.getByText(fileName, { exact: true }).getAttribute('title'), reference);
    await pasteNativeImage(app, composer);
    const pasted = draftFiles.getByRole('button', { name: '预览图片 · 截图 1.png', exact: true });
    await pasted.waitFor();
    assert.equal(await composer.inputValue(), retryDraft);
    await app.evaluate(async ({ BrowserWindow, clipboard }) => {
      await clipboard.writeText('继续核对');
      BrowserWindow.getAllWindows()[0].webContents.paste();
    });
    await page.waitForFunction(() => document.querySelector('.composer textarea').value.includes('继续核对'));
    await composer.fill(retryDraft);
    assert.equal(await draftFiles.getByRole('listitem').count(), 3);
    await draftFiles.getByRole('button', { name: '移除附件 · 截图 1.png', exact: true }).press('Enter');
    await pasted.waitFor({ state: 'detached' });
    assert.ok(await composer.evaluate(element => document.activeElement === element));
    await pasteNativeImage(app, composer);
    const retryScreenshot = draftFiles.getByRole('button', { name: '预览图片 · 截图 2.png', exact: true });
    await retryScreenshot.waitFor();
    assert.equal((await readdir(join(profile, 'screenshots'))).length, 1);
    await page.getByTestId('session-catalog').getByRole('treeitem', { name: previousTitle, exact: true }).click();
    await transcript.getByText('第 160 项', { exact: false }).waitFor();
    assert.equal(await draftFiles.count(), 0);
    assert.equal(await composer.inputValue(), '这段草稿留在原会话。');
    await page.getByRole('button', { name: /新会话/ }).click();
    await draftFiles.getByText(fileName, { exact: true }).waitFor();
    await retryScreenshot.waitFor();
    assert.equal(await composer.inputValue(), retryDraft);
    if (screenshot) await page.screenshot({ path: screenshot.replace(/\.png$/, '-composer-files.png') });
  }
  await composer.press('Enter');
  await page.getByRole('alert').getByText('模拟发送失败，请重试。', { exact: true }).waitFor();
  assert.equal(await composer.inputValue(), retryDraft);
  if (!process.env.SPAN_TEST_SSH_ALIAS) await draftFiles.getByText(fileName, { exact: true }).waitFor();
  assert.equal(await transcript.getByText(retryDraft, { exact: true }).count(), 0);
  await composer.press('Enter');
  await transcript.getByText('草稿已成功重试。', { exact: true }).waitFor();
  assert.equal(await transcript.getByText(retryDraft, { exact: true }).count(), 1);
  if (!process.env.SPAN_TEST_SSH_ALIAS) {
    const sentFiles = transcript.getByRole('list', { name: '已发送的附件' });
    await sentFiles.getByText(fileName, { exact: true }).waitFor();
    await sentFiles.getByRole('button', { name: '预览图片 · 截图 2.png', exact: true }).waitFor();
    const sentImage = sentFiles.getByRole('button', { name: previewImageName, exact: true });
    await sentImage.waitFor();
    assert.equal(await transcript.getByText('Span 附件路径', { exact: false }).count(), 0);
    assert.equal(await draftFiles.count(), 0);
    const previousSize = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getContentSize());
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(740, 520));
    await page.waitForFunction(() => innerWidth <= 760 && innerHeight <= 540);
    await sentImage.focus();
    const readingTop = await transcript.evaluate(element => element.scrollTop);
    await sentImage.press('Enter');
    await page.waitForFunction(() => document.querySelector('#file-preview img')?.naturalWidth > 0);
    assert.ok(await page.locator('main').evaluate(element => element.inert));
    await preview.getByRole('button', { name: '关闭预览' }).press('Escape');
    await preview.waitFor({ state: 'detached' });
    assert.ok(await sentImage.evaluate(element => document.activeElement === element));
    assert.equal(await transcript.evaluate(element => element.scrollTop), readingTop);
    await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(...size), previousSize);
  }
  await page.waitForFunction(() => document.querySelector('.composer textarea').value === '');
  assert.ok(await composer.evaluate((element, initialHeight) =>
    element.clientHeight <= initialHeight - 12, welcomeInputHeight), 'The empty composer leaves more room for the reply.');
  assert.equal(await page.getByRole('alert').count(), 0);
  console.log('Verified history paging, file preview, PTY, streaming and interrupt.');
  console.log('Verified a new session keeps a rejected draft and clears it after one successful retry.');

  await composer.fill('验证子代理导航。');
  await composer.press('Enter');
  await transcript.getByText('代理导航验收完成。', { exact: true }).waitFor();
  const agentName = '键盘导航与窄窗口布局复核，核对 Windows 和 EL8 下的状态、结果与会话归属';
  const agentModel = 'fixture-review-workbench-layout-keyboard-navigation-window-rendering-delegated-agent';
  const openAgent = `打开 ${agentName} 的会话`;
  const agentCards = transcript.locator('[data-card="delegation"]');
  const spawnCard = agentCards.filter({ hasText: '启动子代理' });
  const waitCard = agentCards.filter({ hasText: '等待子代理' });
  await spawnCard.getByText(agentName, { exact: true }).waitFor();
  await spawnCard.locator('.card-status[data-recorded="true"]').getByText('当时进行中', { exact: true }).waitFor();
  await spawnCard.locator('summary').press('Enter');
  await spawnCard.locator('.agent-state[data-recorded="true"]').getByText('当时进行中', { exact: true }).waitFor();
  await spawnCard.locator('summary').press('Enter');
  await waitCard.getByText('1 个失败', { exact: true }).waitFor();
  assert.equal(await waitCard.getAttribute('data-failed'), 'true');
  assert.equal(await spawnCard.getAttribute('data-failed'), null);
  assert.equal(await waitCard.getByRole('list', { name: '代理成员' }).count(), 0);
  await waitCard.locator('summary').press('Enter');
  await waitCard.getByRole('button', { name: openAgent }).waitFor();
  await waitCard.getByText('已核对键盘焦点。', { exact: true }).waitFor();
  await waitCard.getByText('失败', { exact: true }).waitFor();
  if (screenshot) await page.screenshot({ path: screenshot.replace(/\.png$/, '-agents-card.png') });
  const agentsSize = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getContentSize());
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(740, 520));
  await page.waitForFunction(() => Math.abs(innerWidth - 740) <= 2 && Math.abs(innerHeight - 520) <= 2);
  await composer.fill('/agents');
  await composer.press('Enter');
  const agents = page.getByRole('region', { name: '代理与团队' });
  const rosterAgent = agents.getByRole('button', { name: openAgent });
  await rosterAgent.waitFor();
  await agents.getByText(agentModel, { exact: true }).waitFor();
  await agents.getByText('已完成', { exact: true }).waitFor();
  await agents.getByText('失败', { exact: true }).waitFor();
  const failedAgent = agents.getByText('截图校验失败。', { exact: false });
  await failedAgent.waitFor();
  assert.match(await failedAgent.textContent(), /截图校验失败。\n需要重新采样。/);
  assert.equal(await agents.getByText('已核对键盘焦点。', { exact: true }).count(), 0);
  assert.ok(await rosterAgent.evaluate(button => {
    const row = button.closest('.agent-member-row');
    const name = button.querySelector('.agent-member-label');
    const model = row.querySelector('.agent-member-meta');
    const status = row.querySelector('.agent-state');
    const view = row.closest('.agent-panel-content');
    const box = element => element.getBoundingClientRect();
    const wraps = element => box(element).height > 1.5 * Number.parseFloat(getComputedStyle(element).lineHeight);
    return wraps(name) && wraps(model) && Math.abs(box(button).top - box(status).top) <= 2 &&
      box(button).right < box(status).left && box(model).top >= box(button).bottom && view.scrollWidth === view.clientWidth;
  }), 'Long member names and model IDs should wrap with the status on the first line');
  if (screenshot) await page.screenshot({ path: screenshot.replace(/\.png$/, '-agents-panel.png') });
  assert.ok(await failedAgent.evaluate(detail => detail.getBoundingClientRect().bottom <=
    detail.closest('.agent-panel-content').getBoundingClientRect().bottom + 1),
    'Both lines of the failure detail should be visible in the narrow roster');
  const agentDetails = agents.getByRole('group', { name: '代理与团队明细' });
  await agents.getByRole('button', { name: '关闭面板' }).press('Tab');
  assert.ok(await agentDetails.evaluate(element => element === document.activeElement));
  await page.keyboard.press('Escape');
  await agents.waitFor({ state: 'detached' });
  assert.ok(await composer.evaluate(element => element === document.activeElement));
  await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(...size), agentsSize);
  await page.waitForFunction(([width, height]) => Math.abs(innerWidth - width) <= 2 && Math.abs(innerHeight - height) <= 2, agentsSize);
  await composer.fill('/agents');
  await composer.press('Enter');
  await rosterAgent.press('Enter');
  await agents.waitFor({ state: 'detached' });
  await transcript.getByText('子代理的会话记录。', { exact: true }).waitFor();
  await page.locator('.topbar').getByText(agentName, { exact: true }).waitFor();
  console.log('Verified delegation summaries, shared member rows, and keyboard navigation to the child session.');

  if (await terminalToggle.getAttribute('aria-pressed') === 'true') await terminalToggle.click();
  await composer.fill('整理检查结果，给出可复查的步骤。');
  await composer.press('Enter');
  const titleInReply = page.getByRole('heading', { name: '工作台会话验收', level: 1 });
  const reply = transcript.locator('.agent-reply').filter({ has: titleInReply });
  const readingTitle = reply.getByRole('heading', { level: 1 });
  await readingTitle.waitFor();
  const table = reply.getByRole('table');
  const code = reply.locator('pre');
  const captureReading = async suffix => {
    if (screenshot) await page.screenshot({ path: screenshot.replace(/\.png$/, `-reading-${suffix}.png`) });
  };
  for (const [width, height] of [[1240, 840], [740, 520]]) {
    await app.evaluate(({ BrowserWindow }, [w, h]) =>
      BrowserWindow.getAllWindows()[0].setContentSize(w, h), [width, height]);
    await page.waitForFunction(([w, h]) => innerWidth === w && innerHeight === h, [width, height]);
    const tableLayout = await table.evaluate(element => ({
      compact: element.offsetWidth < element.closest('.prose').clientWidth / 2,
      rightAligned: getComputedStyle(element.querySelector('td:last-child')).textAlign === 'right',
    }));
    assert.ok(tableLayout.compact && tableLayout.rightAligned, 'Short tables keep related values together and preserve Markdown alignment.');
    const codeOverflow = await code.evaluate(element => element.scrollWidth - element.clientWidth);
    assert.equal(codeOverflow > 0, width === 740, 'The long command scrolls horizontally when the reading column is narrow.');
    const hasNestedList = await reply.locator('ul ul').getByText('审批出现后，仍可看到原先阅读的段落。').count();
    assert.equal(hasNestedList, 1);
    if (width === 740) {
      assert.ok(await code.evaluate(element => {
        element.scrollLeft = element.scrollWidth;
        const atEnd = Math.abs(element.scrollLeft - (element.scrollWidth - element.clientWidth)) <= 1;
        element.scrollLeft = 0;
        return atEnd;
      }), 'The horizontal scroller reaches the full command.');
      await readingTitle.evaluate(element => {
        const timeline = element.closest('.timeline');
        timeline.scrollTop += element.getBoundingClientRect().top - timeline.getBoundingClientRect().top - 14;
      });
      await page.waitForFunction(() => {
        const heading = document.querySelector('.agent-reply h1');
        const top = heading.getBoundingClientRect().top - heading.closest('.timeline').getBoundingClientRect().top;
        return top >= 0 && top <= 20;
      });
      await captureReading('narrow');
      await page.getByRole('button', { name: '滚到最新消息' }).click();
      await page.waitForFunction(() => {
        const timeline = document.querySelector('.timeline');
        return timeline.scrollHeight - timeline.clientHeight - timeline.scrollTop <= 2;
      });
    }
    await captureReading(width === 740 ? 'narrow-end' : 'wide');
  }
  console.log('Verified the rich answer layout and long code overflow at two window sizes.');
} finally {
  await app.close();
  await rm(profile, { recursive: true, force: true, maxRetries: 3 });
}
