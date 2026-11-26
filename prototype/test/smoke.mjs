import { _electron as electron } from 'playwright';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
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
  const composer = page.getByRole('textbox', { name: '消息' });
  const insertSelection = page.getByRole('button', { name: '加入选区', exact: true });
  assert.equal(await insertSelection.count(), 0);
  const selectionDraft = '核对输出。继续编辑。';
  const insertionPoint = selectionDraft.indexOf('继续');
  await composer.fill(selectionDraft);
  await composer.evaluate((element, end) => element.setSelectionRange(1, end), insertionPoint);
  const selectedLine = await page.locator('.xterm-rows > div').filter({ hasText: /^\s*span_local_pty\s*$/ }).boundingBox();
  assert.ok(selectedLine);
  const selectionX = selectedLine.x + 12;
  const selectionY = selectedLine.y + selectedLine.height / 2;
  await page.mouse.dblclick(selectionX, selectionY);
  await insertSelection.press('Enter');
  const insertedSelection = '\n\n[终端选区]\nspan_local_pty\n[/终端选区]\n';
  assert.equal(await composer.inputValue(), selectionDraft.slice(0, insertionPoint) + insertedSelection +
    selectionDraft.slice(insertionPoint));
  assert.ok(await composer.evaluate((element, end) => document.activeElement === element &&
    element.selectionStart === end && element.selectionEnd === end, insertionPoint + insertedSelection.length));
  await composer.fill('');
  await page.mouse.click(selectionX, selectionY);
  await insertSelection.waitFor({ state: 'detached' });
  await terminal.focus();

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
  const goal = page.getByRole('button', { name: '会话目标', exact: true });
  await composer.fill('/goal 验证会话目标');
  await composer.press('Enter');
  await goal.getByText('验证会话目标').waitFor();
  assert.deepEqual(await goal.evaluate(button => button.getAttribute('aria-describedby').split(' ')
    .map(id => button.ownerDocument.getElementById(id)?.textContent)), ['进行中', '验证会话目标']);
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
  const longDraft = Array.from({ length: 12 }, (_, index) =>
    `草稿第 ${index + 1} 行，准备继续核对会话。`).join('\n');
  const draftHeight = () => composer.evaluate(element => element.getBoundingClientRect().height);
  async function attachReviewFiles() {
    const names = Array.from({ length: 4 }, (_, index) => `验收 ${index + 1} · 工作区走查记录与附加参考清单.txt`);
    const paths = names.map(name => join(profile, name));
    await Promise.all(paths.map(path => writeFile(path, '工作区验收记录')));
    await app.evaluate(({ dialog }, filePaths) => {
      const original = dialog.showOpenDialog;
      dialog.showOpenDialog = async () => {
        dialog.showOpenDialog = original;
        return { canceled: false, filePaths };
      };
    }, paths);
    const tray = page.getByRole('list', { name: '待发送的附件' });
    await page.getByRole('button', { name: '添加本机文件', exact: true }).click();
    await tray.getByTitle(paths.at(-1), { exact: true }).waitFor();
    const removeButtons = names.map(name => tray.getByRole('button', { name: '移除附件 · ' + name, exact: true }));
    return { tray, removeButtons };
  }
  await composer.fill(longDraft);
  const originalDraftHeight = await draftHeight();
  assert.ok(originalDraftHeight >= 80);
  await composer.evaluate(element => element.setSelectionRange(12, 20));
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
  const goalObjective = goal.locator('#goal-strip-objective');
  const shortRtlGoal = 'راجع السجل';
  await goalInput.fill(shortRtlGoal);
  await saveGoal.press('Enter');
  await goal.getByText(shortRtlGoal, { exact: true }).waitFor();
  assert.ok(await goalObjective.evaluate(element => {
    const bounds = element.getBoundingClientRect();
    const icon = element.previousElementSibling.getBoundingClientRect();
    const status = element.nextElementSibling.getBoundingClientRect();
    return bounds.left - icon.right <= 10 && status.left - bounds.right > bounds.width;
  }), 'A short Arabic objective should sit next to the Goal icon.');
  await editGoal.press('Enter');
  const rtlGoal = 'راجع حالة Windows وEL8، واحفظ موضع القراءة قبل المتابعة. '.repeat(8).trim();
  await goalInput.fill(rtlGoal);
  await saveGoal.press('Enter');
  await goal.getByText(rtlGoal, { exact: true }).waitFor();
  assert.equal(await goalText.evaluate(element => getComputedStyle(element).direction), 'rtl');
  assert.ok(await goalObjective.evaluate(element => {
    const bounds = element.getBoundingClientRect();
    const start = document.createRange();
    start.setStart(element.firstChild, 0);
    start.setEnd(element.firstChild, 1);
    const first = start.getBoundingClientRect();
    const icon = element.previousElementSibling.getBoundingClientRect();
    const status = element.nextElementSibling.getBoundingClientRect();
    return getComputedStyle(element).direction === 'rtl' && element.scrollWidth > element.clientWidth &&
      first.left >= bounds.left && Math.abs(first.right - bounds.right) <= 4 &&
      icon.right < bounds.left && bounds.right < status.left;
  }), 'The clipped Goal should retain its Arabic start with the icon and status in their original positions.');
  if (screenshot) {
    await page.screenshot({ path: screenshot.replace(/\.png$/, '-goal-rtl.png') });
    const objectiveText = page.locator('#goal-strip-objective, #goal-panel .goal-objective');
    const setDirection = direction => objectiveText.evaluateAll((nodes, value) => {
      for (const node of nodes) node.setAttribute('dir', value);
    }, direction);
    await setDirection('ltr');
    try {
      await page.screenshot({ path: screenshot.replace(/\.png$/, '-goal-rtl-before.png') });
    } finally {
      await setDirection('auto');
    }
  }
  await editGoal.press('Enter');
  assert.equal(await goalInput.evaluate(element => getComputedStyle(element).direction), 'rtl');
  const longGoal = Array.from({ length: 10 }, (_, index) =>
    `第 ${index + 1} 项。对照窗口尺寸、输入响应与会话恢复，记录对应的验收证据。`).join('\n');
  await goalInput.fill(longGoal);
  assert.equal(await goalInput.evaluate(element => getComputedStyle(element).direction), 'ltr');
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
    const actions = panel.querySelector('.goal-actions');
    const hit = document.elementFromPoint(close.left + close.width / 2, close.top + close.height / 2);
    const actionsVisible = [...actions.querySelectorAll('button')].every(button => {
      const rect = button.getBoundingClientRect();
      return rect.height >= 28 && button.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
    });
    return { fits: bounds.top >= timeline.top + 34 && bounds.bottom < card.top,
      fillsColumn: Math.abs(bounds.left - card.left) <= 1 && Math.abs(bounds.right - card.right) <= 1,
      scrolls: body.scrollTop === 0 && body.scrollHeight > body.clientHeight,
      closeVisible: panel.querySelector('header button').contains(hit),
      actionsVisible: actionsVisible && actions.getBoundingClientRect().top > body.getBoundingClientRect().top };
  });
  assert.deepEqual(compactGoal, {
    fits: true, fillsColumn: true, scrolls: true, closeVisible: true, actionsVisible: true,
  });
  assert.equal(await draftHeight(), 46);
  const goalViewport = goalPanel.locator('.agent-panel-content');
  const goalReadingHeight = () => goalViewport.evaluate(element => {
    const panelTop = element.closest('.agent-panel').getBoundingClientRect().top;
    const timelineTop = document.querySelector('.timeline').getBoundingClientRect().top;
    return element.clientHeight + panelTop - timelineTop;
  });
  const largerGoalReading = await goalReadingHeight();
  await composer.evaluate(element => { element.style.maxHeight = 'max(48px, min(156px, 25cqb))'; });
  try {
    assert.equal(await draftHeight(), originalDraftHeight);
    const originalGoalReading = await goalReadingHeight();
    assert.ok(largerGoalReading - originalGoalReading >= 32);
    console.log(`Conversation and Goal reading height with the terminal open: ${originalGoalReading} → ${largerGoalReading} CSS px.`);
    if (screenshot) await page.screenshot({ path: screenshot.replace(/\.png$/, '-goal-compact-before.png') });
  } finally {
    await composer.evaluate(element => element.style.removeProperty('max-height'));
  }
  if (screenshot) await page.screenshot({ path: screenshot.replace(/\.png$/, '-goal-compact.png') });
  if (!process.env.SPAN_TEST_SSH_ALIAS) {
    const { tray, removeButtons } = await attachReviewFiles();
    await dismissGoal.focus();
    const compact = await tray.evaluate(element => ({ height: element.clientHeight, scrollable: element.scrollHeight > element.clientHeight }));
    assert.deepEqual(compact, { height: 28, scrollable: true });
    assert.equal(await draftHeight(), 24);
    const readingSpace = () => goalViewport.evaluate(element => {
      const panel = element.closest('.agent-panel');
      const timeline = document.querySelector('.timeline');
      const abovePanel = panel.getBoundingClientRect().top - timeline.getBoundingClientRect().top;
      const style = getComputedStyle(element);
      const objectiveHeight = element.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
      const objectiveLineHeight = parseFloat(getComputedStyle(element.querySelector('.goal-objective')).lineHeight);
      return { abovePanel, objectiveHeight, objectiveLineHeight, scrolls: element.scrollHeight > element.clientHeight };
    });
    const compactReading = await readingSpace();
    assert.ok(compactReading.scrolls && compactReading.objectiveHeight >= 2 * compactReading.objectiveLineHeight);
    await tray.evaluate(element => { element.style.maxHeight = '56px'; });
    try {
      const fullTray = await readingSpace();
      assert.ok(compactReading.abovePanel + compactReading.objectiveHeight - fullTray.abovePanel - fullTray.objectiveHeight >= 22,
        'The compact attachment tray must make room for another line of the conversation or goal.');
    } finally {
      await tray.evaluate(element => { element.style.removeProperty('max-height'); });
    }
    const originalSpacing = await page.addStyleTag({ content: `
      #goal-panel { --panel-height: max(128px, calc(100% - 64px)); }
      #goal-panel > header, #goal-panel :is(.goal-actions, .agent-panel-content) { padding-block: 4px; }
    ` });
    try {
      const original = await readingSpace();
      assert.ok(compactReading.abovePanel + compactReading.objectiveHeight - original.abovePanel - original.objectiveHeight >= 10,
        'Goal spacing should free room for reading while the action buttons stay reachable.');
    } finally {
      await originalSpacing.evaluate(element => element.remove());
    }
    const fullGoalLayout = await page.addStyleTag({ content: `
      #goal-panel { --panel-height: 400px; }
      #goal-panel .agent-panel-content { padding-block: 8px; }
      .composer-wrap:has(#goal-panel) .composer textarea { min-height: 32px; max-height: 46px; }
    ` });
    try {
      const fullPanel = await readingSpace();
      assert.ok(compactReading.abovePanel - fullPanel.abovePanel >= 22,
        'The conversation should keep at least one extra line above the expanded goal.');
      console.log(`Conversation space above the goal: ${fullPanel.abovePanel} → ${compactReading.abovePanel} CSS px.`);
      if (screenshot) await page.screenshot({ path: screenshot.replace(/\.png$/, '-goal-compact-attachments-before.png') });
    } finally {
      await fullGoalLayout.evaluate(element => element.remove());
    }
    if (screenshot) await page.screenshot({ path: screenshot.replace(/\.png$/, '-goal-compact-attachments.png') });
    await removeButtons.at(-1).focus();
    assert.ok(await tray.evaluate(element => element.clientHeight > 28 && element.contains(document.activeElement)));
    assert.equal(await draftHeight(), originalDraftHeight);
    for (const button of removeButtons) await button.press('Enter');
    await tray.waitFor({ state: 'detached' });
    await dismissGoal.focus();
    assert.equal(await composer.inputValue(), longDraft);
  }
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
  assert.equal(await draftHeight(), originalDraftHeight);
  assert.deepEqual(await composer.evaluate(element => [element.value, element.selectionStart, element.selectionEnd]),
    [longDraft, 12, 20]);
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
  const liveGoalRect = await goal.boundingBox();
  await composer.fill('/goal resume');
  await composer.press('Enter');
  await goal.getByText('进行中', { exact: true }).waitFor();
  await liveReasoning.getByText('确认目标卡片和输入区之间的间距。', { exact: true }).waitFor();
  assert.ok(await liveElement.evaluate((element, initial) => {
    const rect = element.getBoundingClientRect();
    const goalRect = element.nextElementSibling.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
    return element.contains(hit) && rect.y === initial.y && rect.height === initial.height
      && rect.x === goalRect.x && rect.width === goalRect.width && rect.bottom < goalRect.top;
  }, liveRect));
  assert.deepEqual(await goal.boundingBox(), liveGoalRect);
  assert.equal(await transcript.evaluate(element => element.scrollTop), reasoningAnchor);
  if (screenshot) {
    await checkTranscriptEdge(app, page, transcript, screenshot);
    await page.screenshot({ path: screenshot.replace(/\.png$/, '-reasoning.png') });
  }
  const steerWhileReading = '保持历史阅读位置，继续核对。';
  await composer.fill(steerWhileReading);
  await composer.press('Enter');
  await page.getByRole('status').filter({ hasText: '已追加' }).waitFor();
  await reasoningJump.getByText('最新消息', { exact: true }).waitFor();
  assert.equal(await composer.inputValue(), '');
  assert.ok(Math.abs(await transcript.evaluate(element => element.scrollTop) - reasoningAnchor) <= 2);
  if (screenshot) await page.screenshot({ path: screenshot.replace(/\.png$/, '-steer-while-reading.png') });
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
  assert.ok(Math.abs(await transcript.evaluate(element => element.scrollTop) - reasoningAnchor) <= 2);

  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(740, 520));
  await page.waitForFunction(() => innerWidth === 740 && innerHeight === 520);
  await composer.fill(longDraft);
  assert.equal(await draftHeight(), originalDraftHeight);
  await liveReasoning.press('Enter');
  await reasoningBody.getByText('保留列表缩进', { exact: true }).waitFor();
  assert.equal(await draftHeight(), 46);
  assert.ok(await reasoningPanel.evaluate(panel => {
    const strip = document.querySelector('.reasoning-strip');
    const card = document.querySelector('.goal-strip');
    const form = document.querySelector('.composer');
    const box = element => element.getBoundingClientRect();
    const timeline = document.querySelector('.timeline');
    return box(panel).bottom <= box(strip).top && box(strip).bottom < box(card).top &&
      box(card).bottom < box(form).top && box(panel).left === box(form).left && box(panel).top >= box(timeline).top + 34;
  }));
  if (screenshot) await page.screenshot({ path: screenshot.replace(/\.png$/, '-reasoning-compact-draft.png') });
  if (!process.env.SPAN_TEST_SSH_ALIAS) {
    const { tray, removeButtons } = await attachReviewFiles();
    const closeReasoning = reasoningPanel.getByRole('button', { name: '关闭面板' });
    await closeReasoning.focus();
    assert.equal(await draftHeight(), 24);
    assert.equal(await tray.evaluate(element => element.clientHeight), 28);
    const readingSpace = () => reasoningPanel.evaluate(panel => {
      const above = panel.getBoundingClientRect().top - document.querySelector('.timeline').getBoundingClientRect().top;
      const body = panel.querySelector('.agent-panel-content');
      const style = getComputedStyle(body);
      return { above, detail: body.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom) };
    });
    const compact = await readingSpace();
    assert.ok(compact.above >= 34);
    const originalSpacing = await page.addStyleTag({ content: `
      .composer-wrap:has(#reasoning-panel) { padding-block-end: 15px; }
      .composer-wrap:has(#reasoning-panel) > .composer { padding-block: 8px; }
      #reasoning-panel { --panel-height: max(112px, calc(100% - 52px)); }
      #reasoning-panel .agent-panel-content { padding-block: 10px 12px; }
    ` });
    try {
      const original = await readingSpace();
      assert.ok(compact.above + compact.detail - original.above - original.detail >= 17,
        'Compact spacing should preserve room for another line across the transcript and reasoning detail.');
      console.log(`Conversation and reasoning reading height with attachments: ${original.above + original.detail} → ${compact.above + compact.detail} CSS px.`);
    } finally {
      await originalSpacing.evaluate(element => element.remove());
    }
    if (screenshot) await page.screenshot({ path: screenshot.replace(/\.png$/, '-reasoning-compact-attachments.png') });
    const last = removeButtons.at(-1);
    await last.focus();
    assert.ok(await last.evaluate(button => {
      const bounds = button.getBoundingClientRect();
      const list = button.closest('ul').getBoundingClientRect();
      return document.activeElement === button && bounds.top >= list.top && bounds.bottom <= list.bottom;
    }));
    assert.equal(await draftHeight(), originalDraftHeight);
    assert.equal(await composer.inputValue(), longDraft);
    for (const button of removeButtons) await button.press('Enter');
    await tray.waitFor({ state: 'detached' });
    await closeReasoning.focus();
    assert.equal(await draftHeight(), 46);
  }
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1040, 520));
  await page.waitForFunction(() => innerWidth === 1040 && innerHeight === 520);
  const wideReadingSpace = panel => panel.evaluate(element => {
    const box = selector => document.querySelector(selector).getBoundingClientRect();
    const bounds = element.getBoundingClientRect();
    const detail = element.querySelector('.agent-panel-content');
    const readable = detail.clientHeight > 0 && detail.clientHeight >= Math.min(42, detail.scrollHeight);
    return bounds.top >= box('.timeline').top + 48 && readable &&
      box('.composer').bottom < box('section.terminal-panel').top;
  });
  assert.ok(await wideReadingSpace(reasoningPanel), 'A short wide window should leave room above reasoning with the terminal open.');
  if (screenshot) await page.screenshot({ path: screenshot.replace(/\.png$/, '-reasoning-wide-short.png') });
  await goal.press('Enter');
  await goalPanel.waitFor();
  assert.ok(await wideReadingSpace(goalPanel), 'A short wide window should leave room above the Goal with the terminal open.');
  await liveReasoning.press('Enter');
  await reasoningPanel.waitFor();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(740, 520));
  await page.waitForFunction(() => innerWidth === 740 && innerHeight === 520);
  const stripColors = locator => locator.evaluate(element => {
    const style = getComputedStyle(element);
    return {
      expanded: element.getAttribute('aria-expanded') === 'true',
      foreground: style.color, background: style.backgroundColor,
      colorAdjust: style.forcedColorAdjust,
      uniform: [...element.querySelectorAll('span, small, svg')].every(child => getComputedStyle(child).color === style.color),
      iconsMatchText: [...element.querySelectorAll('svg')].every(icon => getComputedStyle(icon).stroke === style.color),
    };
  });
  await page.emulateMedia({ forcedColors: 'active' });
  try {
    const openReasoning = await stripColors(liveReasoning);
    assert.ok(openReasoning.expanded && openReasoning.uniform && openReasoning.colorAdjust === 'none');
    const closedGoal = await stripColors(goal);
    assert.ok(closedGoal.iconsMatchText);
    assert.notEqual(openReasoning.background, closedGoal.background);
    if (screenshot) await page.screenshot({ path: screenshot.replace(/\.png$/, '-reasoning-forced-colors.png') });
    await reasoningBody.press('Escape');
    await reasoningPanel.waitFor({ state: 'detached' });
    assert.ok(await liveReasoning.evaluate(element => element.matches(':focus-visible')));
    await goal.press('Enter');
    await goalPanel.waitFor();
    assert.deepEqual(await stripColors(goal), openReasoning);
    const closedReasoning = await stripColors(liveReasoning);
    assert.ok(closedReasoning.iconsMatchText);
    assert.notEqual(closedReasoning.background, openReasoning.background);
    if (screenshot) await page.screenshot({ path: screenshot.replace(/\.png$/, '-goal-forced-colors.png') });
    await dismissGoal.press('Escape');
    await goalPanel.waitFor({ state: 'detached' });
    assert.ok(await goal.evaluate(element => element.matches(':focus-visible')));
  } finally {
    await page.emulateMedia({ forcedColors: null });
  }
  assert.equal(await draftHeight(), originalDraftHeight);
  assert.equal(await composer.inputValue(), longDraft);
  await composer.fill('');
  await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(...size), goalWindowSize);
  await page.waitForFunction(([width, height]) => innerWidth === width && innerHeight === height, goalWindowSize);
  await reasoningJump.waitFor();
  const restoredReasoningAnchor = await transcript.evaluate(element => new Promise(resolve => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve(element.scrollTop)));
  }));
  await liveReasoning.press('Enter');
  const stop = page.getByRole('button', { name: '停止', exact: true });
  await stop.press('Enter');
  await page.getByRole('button', { name: '发送', exact: true }).waitFor();
  await liveReasoning.waitFor({ state: 'detached' });
  await reasoningPanel.getByText('已归档', { exact: true }).waitFor();
  assert.ok(await composer.evaluate(element => element === document.activeElement));
  assert.ok(Math.abs(await transcript.evaluate(element => element.scrollTop) - restoredReasoningAnchor) <= 2);
  await reasoningJump.press('Enter');
  await reasoningPanel.waitFor({ state: 'detached' });
  await reasoningJump.waitFor({ state: 'detached' });
  assert.ok(await transcript.evaluate(element => element === document.activeElement));
  await transcript.getByText('流式输出已接通。', { exact: true }).waitFor();
  await transcript.getByText(steerWhileReading, { exact: true }).waitFor();
  const earlyReasoning = archivedReasoning.filter({ hasText: '再确认工具结果和最终回复的前后顺序。' });
  const lateReasoning = archivedReasoning.filter({ hasText: '确认目标卡片和输入区之间的间距。' });
  await earlyReasoning.locator('summary').click();
  await earlyReasoning.locator('ul ul').getByText('保留列表缩进', { exact: true }).waitFor();
  await lateReasoning.locator('summary').waitFor();
  assert.equal(await lateReasoning.locator('.card-body').count(), 0);
  assert.equal(await transcript.locator('[data-card="command"] pre').count(), 0);
  await earlyReasoning.locator('summary').click();
  assert.equal(await page.getByRole('alert').count(), 0);
  console.log('Verified the fixed reasoning strip and Goal positions during a Goal status change, nested details, and archived summary.');
  console.log('Verified steering while reading, acknowledgement, and keyboard return to the latest conversation.');

  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(740, 520));
  await page.waitForFunction(() => Math.abs(innerWidth - 740) <= 2 && Math.abs(innerHeight - 520) <= 2);
  const agentToggle = page.getByRole('button', { name: 'Agent 控件' });
  const agentMenu = page.locator('.agent-menu-entries');
  const createGoal = agentMenu.getByRole('button', { name: '会话目标', exact: true });
  const usageEntry = agentMenu.getByRole('button', { name: '用量', exact: true });
  const agentsEntry = agentMenu.getByRole('button', { name: '代理与团队', exact: true });
  const settingsEntry = page.getByRole('button', { name: '运行设置' });
  const settings = page.getByRole('region', { name: '运行设置' });
  const closeSettings = settings.getByRole('button', { name: '关闭面板' });
  const modelSetting = settings.getByRole('combobox', { name: '模型', exact: true });
  const settingsDraft = '检查设置关闭后，原草稿和选区都保留。';
  await composer.fill(settingsDraft);
  await composer.evaluate(element => element.setSelectionRange(2, 6));
  await agentToggle.getByText('Agent', { exact: true }).waitFor();
  await agentToggle.press('Enter');
  assert.equal(await createGoal.count(), 0, 'The Goal card is the sole entry point while an objective exists.');
  assert.equal(await usageEntry.locator('code').textContent(), '/usage');
  assert.equal(await agentsEntry.locator('code').textContent(), '/agents');
  assert.match(await agentToggle.getAttribute('aria-description'), /用量、代理与团队/);
  await settingsEntry.getByText('Fixture', { exact: true }).waitFor();
  assert.match(await settingsEntry.getAttribute('aria-description'), /^Fixture/);
  await page.keyboard.press('Tab');
  assert.ok(await settingsEntry.evaluate(element => document.activeElement === element));
  assert.ok(await settingsEntry.evaluate(element => {
    const menu = element.closest('.agent-menu-entries').getBoundingClientRect();
    const trigger = element.closest('.agent-menu').querySelector('.composer-control').getBoundingClientRect();
    return Math.abs(menu.right - trigger.right) <= 1 && menu.bottom < trigger.top;
  }), 'Agent menu should align with its trigger');
  if (screenshot) await page.screenshot({ path: screenshot.replace(/\.png$/, '-agent-menu.png') });
  await page.keyboard.press('Escape');
  await settingsEntry.waitFor({ state: 'detached' });
  assert.ok(await agentToggle.evaluate(element => document.activeElement === element));
  const beforeMenuNavigation = await transcript.evaluate(element => element.scrollTop);
  await page.keyboard.press('ArrowDown');
  assert.equal(await agentToggle.getAttribute('aria-controls'), await agentMenu.getAttribute('id'));
  assert.ok(await settingsEntry.evaluate(element => document.activeElement === element));
  await page.keyboard.press('ArrowDown');
  assert.ok(await usageEntry.evaluate(element => document.activeElement === element));
  await page.keyboard.press('ArrowDown');
  assert.ok(await agentsEntry.evaluate(element => document.activeElement === element));
  await page.keyboard.press('End');
  const lastEntry = agentMenu.getByRole('button').last();
  assert.ok(await lastEntry.evaluate(element => document.activeElement === element));
  await page.keyboard.press('Home');
  assert.ok(await settingsEntry.evaluate(element => document.activeElement === element));
  await page.keyboard.press('ArrowUp');
  assert.ok(await lastEntry.evaluate(element => document.activeElement === element));
  await page.keyboard.press('Escape');
  await agentMenu.waitFor({ state: 'detached' });
  assert.ok(await agentToggle.evaluate(element => document.activeElement === element));
  assert.equal(await transcript.evaluate(element => element.scrollTop), beforeMenuNavigation);
  await page.keyboard.press('Enter');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  await closeSettings.waitFor();
  assert.ok(await closeSettings.evaluate(element => document.activeElement === element));
  await page.keyboard.press('Tab');
  assert.ok(await modelSetting.evaluate(element => document.activeElement === element));
  assert.ok(await settings.evaluate(panel => {
    const body = panel.querySelector('.agent-panel-content');
    const selects = [...body.querySelectorAll('select')].map(element => element.getBoundingClientRect());
    const composer = document.querySelector('.composer').getBoundingClientRect();
    const bounds = panel.getBoundingClientRect();
    return selects.length === 5 && selects.every(select => select.left === selects[0].left && select.right === selects[0].right)
      && body.scrollWidth === body.clientWidth && body.scrollHeight === body.clientHeight
      && Math.abs(bounds.left - composer.left) <= 1
      && Math.abs(bounds.right - composer.right) <= 1 && bounds.bottom < composer.top;
  }), 'The compact settings should align with the composer and show all five settings without scrolling');
  if (screenshot) {
    const previousSpacing = await page.addStyleTag({ content: `
      .agent-panel[data-kind="settings"] { width: min(100%, 420px); }
      .agent-panel[data-kind="settings"] .agent-panel-content { padding: 12px; }
      .agent-panel[data-kind="settings"] > header .icon-button { width: 30px; height: 30px; }
      .settings-grid { grid-template-columns: none; gap: 10px; }
      .agent-setting { grid-column: auto; grid-template-columns: 92px minmax(0, 1fr); gap: 8px; }
      .agent-setting select { min-height: 0; padding-block: 6px; }
    ` });
    await page.screenshot({ path: screenshot.replace(/\.png$/, '-agent-settings-before.png') });
    await previousSpacing.evaluate(element => element.remove());
    await page.screenshot({ path: screenshot.replace(/\.png$/, '-agent-settings.png') });
  }
  await modelSetting.dispatchEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true });
  assert.ok(await settings.isVisible(), 'Cancelling IME composition should keep the panel open');
  await page.keyboard.press('Escape');
  await settings.waitFor({ state: 'detached' });
  assert.ok(await agentToggle.evaluate(element => document.activeElement === element));
  await page.keyboard.press('Enter');
  await page.keyboard.press('Shift+Tab');
  await settingsEntry.waitFor({ state: 'detached' });
  assert.equal(await composer.inputValue(), settingsDraft);
  assert.deepEqual(await composer.evaluate(element => [element.selectionStart, element.selectionEnd]), [2, 6]);
  const usage = page.getByRole('region', { name: '用量', exact: true });
  await agentToggle.press('Enter');
  await usageEntry.press('Enter');
  await usage.getByRole('button', { name: '关闭面板' }).press('Escape');
  await usage.waitFor({ state: 'detached' });
  assert.ok(await agentToggle.evaluate(element => document.activeElement === element));
  assert.equal(await composer.inputValue(), settingsDraft);

  await composer.fill('/model');
  await composer.press('Enter');
  await closeSettings.waitFor();
  assert.ok(await closeSettings.evaluate(element => document.activeElement === element));
  await page.keyboard.press('Escape');
  await settings.waitFor({ state: 'detached' });
  assert.ok(await composer.evaluate(element => document.activeElement === element));
  await composer.fill('/pwd');
  await composer.press('Enter');
  const directoryPanel = page.getByRole('region', { name: '工作目录', exact: true });
  const directoryDetails = directoryPanel.getByRole('group', { name: '工作目录正文' });
  await directoryPanel.waitFor();
  assert.ok(await directoryPanel.getByRole('button', { name: '关闭面板' }).evaluate(element => document.activeElement === element));
  await page.keyboard.press('Tab');
  assert.ok(await directoryDetails.evaluate(element => document.activeElement === element));
  await page.keyboard.press('Escape');
  await directoryPanel.waitFor({ state: 'detached' });
  assert.ok(await composer.evaluate(element => document.activeElement === element));
  await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(...size), goalWindowSize);
  await page.waitForFunction(([width, height]) => Math.abs(innerWidth - width) <= 2 && Math.abs(innerHeight - height) <= 2, goalWindowSize);
  console.log('Verified Agent menu and settings keyboard paths, compact alignment, and preserved draft selection.');

  await composer.fill('/usage');
  await composer.press('Enter');
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
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(740, 520));
  await page.waitForFunction(() => innerWidth === 740 && innerHeight === 520);
  await composer.fill('/mcp');
  await composer.press('Enter');
  const inventory = page.getByRole('region', { name: 'MCP 服务器' });
  const inventoryBody = inventory.getByRole('group', { name: 'MCP 服务器正文' });
  const docsName = '团队文档与历史记录检索服务';
  const docsServer = inventory.locator('summary').filter({ hasText: docsName });
  const tools = inventory.getByRole('list', { name: docsName + ' 的工具' });
  await docsServer.getByText('已连接 · 42 个工具', { exact: true }).waitFor();
  assert.equal(await tools.count(), 0);
  await docsServer.press('Enter');
  await tools.getByText('document_tool_01', { exact: true }).waitFor();
  assert.equal(await tools.locator('li').count(), 40);
  await inventory.getByText('OAuth 鉴权', { exact: true }).waitFor();
  await inventory.getByRole('button', { name: '显示更多工具' }).press('Enter');
  await tools.getByText('document_tool_42', { exact: true }).waitFor();
  await docsServer.press('Enter');
  await tools.waitFor({ state: 'detached' });
  const failedServer = inventory.locator('summary').filter({ hasText: '缺陷跟踪服务' });
  await failedServer.getByText('需要登录 · 工具读取失败', { exact: true }).waitFor();
  await failedServer.press('Enter');
  await inventory.getByText('登录已过期，请重新授权后读取工具。', { exact: true }).waitFor();
  assert.equal(await inventory.getByText('未登录', { exact: true }).count(), 0);
  assert.ok(await inventoryBody.evaluate(element => element.scrollWidth === element.clientWidth));
  assert.ok(await inventory.evaluate(element => {
    const panel = element.getBoundingClientRect();
    const input = document.querySelector('form.composer').getBoundingClientRect();
    return panel.left === input.left && panel.right === input.right;
  }));
  if (screenshot) await page.screenshot({ path: screenshot.replace(/\.png$/, '-mcp-compact.png') });
  await writeFile(join(profile, 'mcp-next-error'), '');
  await inventory.getByRole('button', { name: '加载更多' }).press('Enter');
  await inventory.getByRole('alert').filter({ hasText: '模拟读取下一页失败' }).waitFor();
  assert.equal(await docsServer.count(), 1);
  await inventory.getByRole('button', { name: '重试' }).press('Enter');
  await inventory.getByText('不支持登录 · 0 个工具', { exact: true }).waitFor();
  assert.equal(await docsServer.count(), 1);
  assert.ok(await inventoryBody.evaluate(element => element === document.activeElement));
  await page.keyboard.press('Escape');
  await inventory.waitFor({ state: 'detached' });
  await composer.fill('/mcp verbose');
  await composer.press('Enter');
  await tools.getByText('document_tool_01', { exact: true }).waitFor();
  await inventoryBody.press('Escape');
  await inventory.waitFor({ state: 'detached' });
  assert.ok(await composer.evaluate(element => document.activeElement === element));
  await composer.fill('/skills');
  await composer.press('Enter');
  const skills = page.getByRole('region', { name: '技能', exact: true });
  const searchSkills = skills.getByRole('searchbox', { name: '搜索技能' });
  const skillRows = skills.locator('.extension-skill');
  await skills.getByText('工作区复核', { exact: true }).waitFor();
  await skills.getByText('核对改动、测试证据和交付记录。', { exact: true }).waitFor();
  const disabledSkill = skillRows.filter({ hasText: 'offline-handbook' });
  await disabledSkill.getByText('用户 · 已停用', { exact: true }).waitFor();
  assert.equal(await skillRows.count(), 30);
  assert.equal(await skills.getByText('workspace-checklist-32', { exact: true }).count(), 0);
  assert.ok(await skills.getByRole('group').evaluate(element => element.scrollWidth === element.clientWidth));
  if (screenshot) await page.screenshot({ path: screenshot.replace(/\.png$/, '-skills-compact.png') });
  await searchSkills.fill('workspace-review');
  await skillRows.nth(1).waitFor({ state: 'detached' });
  await skillRows.getByText('工作区复核', { exact: true }).waitFor();
  await searchSkills.fill('交接清单 32');
  await skills.getByText('workspace-checklist-32', { exact: true }).waitFor();
  assert.equal(await skillRows.count(), 1);
  await searchSkills.fill('不存在的技能');
  await skills.getByRole('status').getByText('没有匹配的技能。', { exact: true }).waitFor();
  await searchSkills.fill('');
  assert.equal(await skillRows.count(), 30);
  const moreSkills = skills.getByRole('button', { name: '加载更多' });
  await moreSkills.press('Enter');
  await moreSkills.waitFor({ state: 'detached' });
  assert.equal(await skillRows.count(), 34);
  assert.ok(await skills.getByRole('group').evaluate(element => document.activeElement === element));
  await page.keyboard.press('Escape');
  await skills.waitFor({ state: 'detached' });
  assert.ok(await composer.evaluate(element => document.activeElement === element));
  await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(...size), usageSize);
  await page.waitForFunction(([width, height]) => Math.abs(innerWidth - width) <= 2 && Math.abs(innerHeight - height) <= 2, usageSize);
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
  const approvalSummary = '已核对待执行命令和工作目录。';
  await liveReasoning.getByText(approvalSummary, { exact: true }).waitFor();
  const approvalContext = archivedReasoning.filter({ hasText: approvalSummary });
  assert.equal(await approvalContext.count(), 0);
  await transcript.evaluate(async element => {
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
    element.scrollTop = 300;
  });
  const latest = page.getByRole('button', { name: '滚到最新消息' });
  await latest.waitFor();
  const readingPosition = () => transcript.evaluate(async element => {
    let previous;
    let stable = 0;
    for (let frame = 0; frame < 30; frame++) {
      await new Promise(requestAnimationFrame);
      const viewport = element.getBoundingClientRect();
      const first = [...element.querySelectorAll('.message[data-empty="false"] > *')].find(row => {
        const bounds = row.getBoundingClientRect();
        return bounds.bottom > viewport.top + 2 && bounds.top < viewport.bottom;
      });
      if (!first) continue;
      const offset = first.getBoundingClientRect().top - viewport.top;
      const current = { text: first.textContent.trim().slice(0, 100), offset, scrollTop: element.scrollTop };
      stable = current.text === previous?.text && current.offset === previous.offset &&
        current.scrollTop === previous.scrollTop ? stable + 1 : 0;
      if (stable === 2) return current;
      previous = current;
    }
    throw new Error('The reading position did not settle.');
  });
  const anchor = await readingPosition();
  await composer.fill('/usage');
  await composer.press('Enter');
  const approval = page.getByRole('region', { name: '确认命令操作' });
  await approval.getByText('还有 1 项', { exact: true }).waitFor();
  await approval.getByText(process.env.SPAN_TEST_SSH_ALIAS || '本机', { exact: true }).waitFor();
  await approval.getByText('工作目录', { exact: true }).waitFor();
  await page.getByText('等待审批', { exact: true }).waitFor();
  const afterApproval = await readingPosition();
  assert.equal(afterApproval.text, anchor.text);
  assert.ok(Math.abs(afterApproval.offset - anchor.offset) <= 2,
    `Approval moved the visible message from ${anchor.offset}px to ${afterApproval.offset}px.`);
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
  await liveReasoning.waitFor({ state: 'detached' });
  await latest.press('Enter');
  const contextTitle = approvalContext.locator('summary');
  await contextTitle.press('Enter');
  await approvalContext.locator('.card-body').getByText(approvalSummary, { exact: true }).waitFor();
  assert.ok(await approval.isVisible());
  await contextTitle.press('Enter');
  await transcript.evaluate((element, top) => { element.scrollTop = top; }, anchor.scrollTop);
  await latest.waitFor();
  if (screenshot) await page.screenshot({ path: screenshot.replace(/\.png$/, '-approval.png') });
  const windowSize = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getContentSize());
  const terminalToggle = page.getByRole('button', { name: '切换终端' });
  const wasTerminalOpen = await terminalToggle.getAttribute('aria-pressed') === 'true';
  if (!wasTerminalOpen) await terminalToggle.click();
  await page.locator('section.terminal-panel').waitFor();
  const preview = page.getByRole('complementary', { name: '文件预览' });
  const restorePreview = page.getByRole('button', { name: '继续预览', exact: true });
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
  const draftAction = page.getByRole('button', { name: '追加', exact: true });
  assert.ok(await draftAction.isEnabled());
  assert.ok(await draftAction.evaluate(button => {
    const [red, green, blue] = getComputedStyle(button).backgroundColor.match(/\d+/g).map(Number);
    return Math.max(red, green, blue) < 120;
  }), 'Pending approval should take visual priority over the enabled draft action.');
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
      rect('.approval').bottom < rect('.goal-strip').top && rect('.goal-strip').bottom < rect('.composer').top &&
      rect('.terminal-canvas').height >= 70 &&
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
  assert.equal(await approvalContext.count(), 1);
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
  await composer.fill('验证后台撤回审批。');
  await composer.press('Enter');
  await liveReasoning.getByText('已准备可撤回的审批请求。', { exact: true }).waitFor();
  await liveReasoning.press('Enter');
  const approvalReference = reasoningPanel.getByRole('link', { name: '审批说明' });
  await approvalReference.focus();
  assert.ok(await approvalReference.evaluate(element => document.activeElement === element));
  await writeFile(join(profile, 'show-withdrawable-approval'), '');
  await reasoningPanel.waitFor({ state: 'detached' });
  await approvalDetails.waitFor();
  assert.ok(await approval.evaluate(element => document.activeElement === element),
    'A new approval should take focus from a link inside the closing reasoning panel.');
  if (await latest.isVisible()) await latest.click();
  const inlineSummary = archivedReasoning.filter({ hasText: '已准备可撤回的审批请求。' });
  await inlineSummary.locator('summary').press('Enter');
  const inlineReference = inlineSummary.getByRole('link', { name: '审批说明' });
  await inlineReference.focus();
  assert.ok(await inlineReference.evaluate(element => document.activeElement === element));
  await writeFile(join(profile, 'withdraw-focused-approval'), '');
  await approval.waitFor({ state: 'detached' });
  await liveReasoning.waitFor();
  assert.ok(await liveReasoning.evaluate(element => document.activeElement === element),
    'When the approval ends during the turn, focus should follow the reasoning back to its fixed line.');
  await writeFile(join(profile, 'show-withdrawable-approval-again'), '');
  await approvalDetails.waitFor();
  await approvalDetails.focus();
  await approvalDetails.evaluate(element => element.blur());
  const focusOutsideCard = () => page.evaluate(() => document.activeElement === document.body);
  assert.ok(await focusOutsideCard());
  await readingPosition();
  await transcript.hover({ position: { x: 12, y: 12 } });
  await page.mouse.wheel(0, -640);
  await page.waitForFunction(() => {
    const element = document.querySelector('.timeline');
    return element.scrollHeight - element.clientHeight - element.scrollTop >= 240;
  });
  const beforeWithdrawal = await readingPosition();
  assert.ok(await transcript.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop >= 240),
    'The reader should be well above the live turn before the approval is withdrawn.');
  await writeFile(join(profile, 'withdraw-approval'), '');
  await approval.waitFor({ state: 'detached' });
  assert.ok(await focusOutsideCard(), 'Withdrawing an approval after the reader left it must not focus the composer.');
  const afterWithdrawal = await readingPosition();
  assert.equal(afterWithdrawal.text, beforeWithdrawal.text);
  assert.ok(Math.abs(afterWithdrawal.offset - beforeWithdrawal.offset) <= 2);
  await page.getByRole('button', { name: '停止', exact: true }).waitFor({ state: 'detached' });
  console.log('Verified backend approval withdrawal preserves the reading position and leaves focus outside the card.');
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
  await writeFile(join(profile, 'hold-goal-clear'), '');
  await composer.fill('/goal clear');
  await composer.press('Enter');
  await goal.focus();
  assert.ok(await goal.evaluate(button => document.activeElement === button));
  await writeFile(join(profile, 'goal-clear'), '');
  await goal.waitFor({ state: 'detached' });
  assert.ok(await composer.evaluate(element => document.activeElement === element));

  await rm(join(profile, 'goal-clear'));
  await composer.fill('/goal 验证展开时清除目标');
  await composer.press('Enter');
  await goal.getByText('验证展开时清除目标', { exact: true }).waitFor();
  await composer.fill('/goal clear');
  await composer.press('Enter');
  const draftAfterClear = '后端清除目标时保留这段草稿。';
  await composer.fill(draftAfterClear);
  await composer.evaluate(element => element.setSelectionRange(2, 5));
  await goal.press('Enter');
  await dismissGoal.press('Tab');
  assert.ok(await goalText.evaluate(element => document.activeElement === element));
  await writeFile(join(profile, 'goal-clear'), '');
  await goalInput.waitFor();
  assert.ok(await goalInput.evaluate(element => document.activeElement === element));
  await page.keyboard.press('Escape');
  await goalPanel.waitFor({ state: 'detached' });
  assert.deepEqual(await composer.evaluate(element => [
    document.activeElement === element, element.value, element.selectionStart, element.selectionEnd,
  ]), [true, draftAfterClear, 2, 5]);
  console.log('Verified focus stays in the expanded Goal panel after a delayed clear and Escape restores the message draft.');
  await agentToggle.press('Enter');
  await createGoal.waitFor();
  await agentToggle.press('Escape');
  await createGoal.waitFor({ state: 'detached' });

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
  await page.getByRole('button', { name: '停止', exact: true }).waitFor({ state: 'detached' });
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

  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(740, 520));
  await page.waitForFunction(() => innerWidth === 740 && innerHeight === 520);
  await sendPlanMessage('验证任务计划。');
  await planSummary.getByText('已完成 1/3', { exact: true }).waitFor();
  await composer.fill('保留准备好的草稿和选区。');
  await composer.evaluate(element => element.setSelectionRange(2, 7));
  await writeFile(join(profile, 'hold-stop'), '');
  await writeFile(join(profile, 'fail-stop'), '');
  await stop.press('Enter');
  const stopError = page.getByRole('alert').filter({ hasText: '模拟停止请求失败' });
  await stopError.waitFor();
  assert.ok(await stop.isEnabled());
  await stop.press('Enter');
  const stopping = page.getByRole('status').filter({ hasText: '正在停止…' });
  await stopping.waitFor();
  await stopError.waitFor({ state: 'detached' });
  assert.equal(await stop.getAttribute('aria-disabled'), 'true');
  assert.ok(await stop.evaluate(element => element === document.activeElement));
  assert.ok(await stopping.evaluate(element => element.clientWidth >= element.scrollWidth));
  await page.keyboard.press('Enter');
  await page.keyboard.press('Space');
  if (screenshot) await page.screenshot({ path: screenshot.replace(/\.png$/, '-stop-pending.png') });
  await writeFile(join(profile, 'release-stop'), '');
  await stop.waitFor({ state: 'detached' });
  await stopping.waitFor({ state: 'detached' });
  assert.deepEqual(await composer.evaluate(element => [element === document.activeElement,
    element.value, element.selectionStart, element.selectionEnd]), [true, '保留准备好的草稿和选区。', 2, 7]);
  await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(...size), windowSize);
  await page.waitForFunction(([width, height]) => innerWidth === width && innerHeight === height, windowSize);

  await composer.fill('验证连续工具活动。');
  await composer.press('Enter');
  const progressHeading = transcript.getByRole('heading', { name: '正在核对工作区', level: 1 });
  const group = transcript.getByRole('button', { name: '6 条命令 · 2 次工具调用', exact: true });
  const groupAnswer = transcript.getByRole('heading', { name: '连续工具活动验收完成。', level: 2 });
  const firstCommand = transcript.locator('[data-card="command"]').filter({ hasText: 'git status --short -- review-1' });
  const failedCommand = transcript.locator('[data-card="command"]').filter({ hasText: 'git diff --check -- review-missing' });
  const change = transcript.locator('[data-card="patch"]').filter({ hasText: 'review-notes.md' });
  await group.waitFor();
  await groupAnswer.waitFor();
  assert.equal(await readFile(join(profile, 'stop-requests'), 'utf8'), '11');
  await rm(join(profile, 'hold-stop'));
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
  const failureSummary = failedCommand.locator('summary');
  const diagnostic = failureSummary.locator('.card-failure-preview');
  await diagnostic.filter({ hasText: '缺少待复核的记录。' }).waitFor();
  assert.equal(await failedCommand.locator('.tool-output').count(), 0);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(740, 520));
  await page.waitForFunction(() => Math.abs(innerWidth - 740) <= 2 && Math.abs(innerHeight - 520) <= 2);
  const terminalPanel = page.locator('section.terminal-panel');
  const showTerminalAfterReview = await terminalToggle.getAttribute('aria-pressed') === 'true';
  if (showTerminalAfterReview) {
    await terminalToggle.click();
    await terminalPanel.waitFor({ state: 'hidden' });
  }
  await waitForTranscriptEnd();
  const messageType = heading => {
    const prose = heading.closest('.prose');
    const viewport = heading.closest('.timeline').getBoundingClientRect();
    const block = prose.getBoundingClientRect();
    return {
      headingSize: parseFloat(getComputedStyle(heading).fontSize),
      lineHeight: parseFloat(getComputedStyle(prose).lineHeight),
      inView: block.top >= viewport.top && block.bottom <= viewport.bottom,
      offset: block.top - viewport.top,
    };
  };
  const progressType = await progressHeading.evaluate(messageType);
  const answerType = await groupAnswer.evaluate(messageType);
  assert.ok(progressType.inView && answerType.inView && progressType.headingSize < answerType.headingSize &&
    progressType.lineHeight < answerType.lineHeight, `Expected a clear reading hierarchy in view. ${JSON.stringify({ progressType, answerType })}`);
  assert.ok(await progressHeading.evaluate(heading => {
    const prose = heading.closest('.prose');
    const outer = prose.querySelector(':scope > ul');
    const inner = outer.querySelector('li > ul');
    return inner.querySelector('li').getBoundingClientRect().left > outer.querySelector('li').getBoundingClientRect().left;
  }), 'Nested steps in the progress message should remain indented.');
  const progressBox = await progressHeading.boundingBox();
  const groupBox = await group.boundingBox();
  const failureBox = await failedCommand.boundingBox();
  const answerBox = await groupAnswer.boundingBox();
  assert.ok(progressBox.y < groupBox.y && groupBox.y < failureBox.y && failureBox.y < answerBox.y);
  if (screenshot) {
    const progressBlock = await progressHeading.evaluateHandle(heading => heading.closest('.agent-commentary'));
    await progressBlock.evaluate(element => {
      element.style.color = getComputedStyle(element).color;
      element.classList.remove('agent-commentary');
    });
    await waitForTranscriptEnd();
    await page.screenshot({ path: screenshot.replace(/\.png$/, '-commentary-before.png') });
    await progressBlock.evaluate(element => {
      element.classList.add('agent-commentary');
      element.style.removeProperty('color');
    });
    await progressBlock.dispose();
    await waitForTranscriptEnd();
    await page.screenshot({ path: screenshot.replace(/\.png$/, '-commentary.png') });
  }
  if (showTerminalAfterReview) {
    await terminalToggle.click();
    await terminalPanel.waitFor();
    await waitForTranscriptEnd();
  }
  assert.ok(await failureSummary.evaluate(summary => {
    const title = summary.querySelector('.card-title').getBoundingClientRect();
    const preview = summary.querySelector('.card-failure-preview').getBoundingClientRect();
    const viewport = summary.closest('.timeline').getBoundingClientRect();
    return Math.abs(title.left - preview.left) <= 1 && title.bottom <= preview.top &&
      preview.top >= viewport.top && preview.bottom <= viewport.bottom;
  }), 'The compact failure diagnostic should align beneath the title and be fully visible');
  if (screenshot) {
    const previous = await page.addStyleTag({ content:
      '.activity summary:has(> .card-failure-preview) { padding-block-end: 4px; } .card-failure-preview { display: none; }' });
    await waitForTranscriptEnd();
    await page.screenshot({ path: screenshot.replace(/\.png$/, '-failure-diagnostic-before.png') });
    await previous.evaluate(element => element.remove());
    await waitForTranscriptEnd();
    await page.screenshot({ path: screenshot.replace(/\.png$/, '-failure-diagnostic.png') });
  }
  await failureSummary.press('Enter');
  await failedCommand.locator('.tool-output').getByText('缺少待复核的记录。', { exact: true }).waitFor();
  assert.equal(await diagnostic.count(), 0);
  assert.ok(await failureSummary.evaluate(element => document.activeElement === element));
  await failureSummary.press('Enter');
  await diagnostic.waitFor();
  await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(...size), windowSize);
  await page.waitForFunction(([width, height]) => Math.abs(innerWidth - width) <= 2 && Math.abs(innerHeight - height) <= 2, windowSize);
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
  console.log('Verified completed tool groups, concise failure diagnostics, and unmounting folded output.');

  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(740, 520));
  await page.waitForFunction(() => Math.abs(innerWidth - 740) <= 2 && Math.abs(innerHeight - 520) <= 2);
  if (showTerminalAfterReview) {
    await terminalToggle.click();
    await terminalPanel.waitFor({ state: 'hidden' });
  }
  await composer.fill('验证结构化工具错误。');
  await composer.press('Enter');
  const errorTool = transcript.locator('[data-card="tool"]').filter({ hasText: '打开复核记录' });
  const errorHeading = errorTool.locator('summary');
  await errorHeading.getByText('失败', { exact: true }).waitFor();
  const errorPreview = errorHeading.locator('.card-failure-preview');
  await errorHeading.getByText('无法读取共享资料。', { exact: true }).waitFor();
  await transcript.getByText('已保留错误详情供复核。', { exact: true }).waitFor();
  assert.equal(await errorTool.locator('.tool-output').count(), 0);
  if (screenshot) await page.screenshot({ path: screenshot.replace(/\.png$/, '-tool-error-collapsed.png') });
  await errorHeading.press('Enter');
  const errorDetail = errorTool.locator('pre[aria-label="工具错误"]');
  await errorDetail.waitFor();
  await errorTool.getByText('错误详情', { exact: true }).waitFor();
  assert.equal(await errorPreview.count(), 0);
  const diagnosticText = await errorDetail.textContent();
  assert.match(diagnosticText, /^无法读取共享资料。\n请核对共享资料的访问权限/);
  assert.match(diagnosticText, /\n错误码 WORKSPACE_ACCESS$/);
  assert.ok(await errorDetail.evaluate(element => getComputedStyle(element).whiteSpace === 'pre-wrap' &&
    element.scrollWidth <= element.clientWidth + 1), 'The full diagnostic should wrap within the compact tool card.');
  await page.waitForFunction(() => {
    const detail = document.querySelector('pre[aria-label="工具错误"]');
    const viewport = detail?.closest('.timeline').getBoundingClientRect();
    const heading = detail?.closest('details').querySelector('summary').getBoundingClientRect();
    return viewport && heading.top >= viewport.top - 1 && detail.getBoundingClientRect().bottom <= viewport.bottom + 1;
  });
  if (screenshot) await page.screenshot({ path: screenshot.replace(/\.png$/, '-tool-error-detail.png') });
  await errorTool.getByRole('button', { name: '复制错误详情', exact: true }).press('Enter');
  await errorTool.locator('[title="已复制错误详情"]').waitFor();
  assert.equal((await app.evaluate(({ clipboard }) => clipboard.readText())).replaceAll('\r\n', '\n'), diagnosticText);
  await errorHeading.press('Enter');
  await errorDetail.waitFor({ state: 'detached' });
  assert.ok(await errorHeading.evaluate(element => element === document.activeElement));
  if (showTerminalAfterReview) {
    await terminalToggle.click();
    await terminalPanel.waitFor();
  }
  await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(...size), windowSize);
  await page.waitForFunction(([width, height]) => innerWidth === width && innerHeight === height, windowSize);
  console.log('Verified a readable structured tool error, compact wrapping, and full diagnostic copy.');

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
    const imageUrl = await preview.getByRole('img', { name: imageName }).getAttribute('src');
    assert.match(imageUrl, /^blob:/);
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
    const imageReleases = await page.evaluateHandle(() => {
      const revoke = URL.revokeObjectURL;
      const released = [];
      URL.revokeObjectURL = url => {
        released.push(url);
        revoke.call(URL, url);
      };
      return {
        released,
        stop() { URL.revokeObjectURL = revoke; },
      };
    });
    await sentImage.press('Enter');
    const image = page.locator('#file-preview img');
    const waitForImage = () => page.waitForFunction(() => document.querySelector('#file-preview img')?.naturalWidth > 0);
    await waitForImage();
    assert.ok(await page.locator('main').evaluate(element => element.inert));
    const originalUrl = await image.getAttribute('src');
    assert.match(originalUrl, /^blob:/);
    await page.getByRole('button', { name: '返回会话', exact: true }).click();
    await image.waitFor({ state: 'detached' });
    assert.deepEqual(await imageReleases.evaluate(state => state.released), [originalUrl]);
    assert.equal(await transcript.evaluate(element => element.scrollTop), readingTop);
    await restorePreview.click();
    await waitForImage();
    const resumedUrl = await image.getAttribute('src');
    assert.match(resumedUrl, /^blob:/);
    assert.notEqual(resumedUrl, originalUrl);
    const closeImage = preview.getByRole('button', { name: '关闭预览' });
    assert.ok(await closeImage.evaluate(element => element === document.activeElement));
    await closeImage.press('Escape');
    await preview.waitFor({ state: 'detached' });
    assert.deepEqual(await imageReleases.evaluate(state => {
      state.stop();
      return state.released;
    }), [originalUrl, resumedUrl]);
    await imageReleases.dispose();
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
  const agentName = '键盘导航与窄窗口布局复核，核对 Windows 和 EL8 下的状态、结果与会话归属，并逐项检查审批、文件预览和历史恢复';
  const agentModel = 'fixture-review-workbench-layout-keyboard-navigation-window-rendering-delegated-agent-long-model-identifier';
  const openAgent = `查看 ${agentName} 的会话记录`;
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
  const cardAgent = waitCard.getByRole('button', { name: openAgent });
  await cardAgent.waitFor();
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
  const memberLayout = await rosterAgent.evaluate(button => {
    const row = button.closest('.agent-member-row');
    const name = button.querySelector('.agent-member-label');
    const model = row.querySelector('.agent-member-meta');
    const status = row.querySelector('.agent-state');
    const view = row.closest('.agent-panel-content');
    const box = element => element.getBoundingClientRect();
    const wraps = element => box(element).height > 1.5 * Number.parseFloat(getComputedStyle(element).lineHeight);
    return {
      nameWraps: wraps(name), modelWraps: wraps(model),
      statusOnFirstLine: Math.abs(box(button).top - box(status).top) <= 2 && box(button).right < box(status).left,
      modelBelowName: box(model).top >= box(button).bottom,
      fitsViewport: view.scrollWidth === view.clientWidth,
    };
  });
  assert.deepEqual(memberLayout, {
    nameWraps: true, modelWraps: true, statusOnFirstLine: true, modelBelowName: true, fitsViewport: true,
  }, 'Long member names and model IDs should wrap with the status on the first line');
  if (screenshot) await page.screenshot({ path: screenshot.replace(/\.png$/, '-agents-panel.png') });
  assert.ok(await failedAgent.evaluate(detail => detail.getBoundingClientRect().bottom <=
    detail.closest('.agent-panel-content').getBoundingClientRect().bottom + 1),
    'Both lines of the failure detail should be visible in the narrow roster');
  const rosterBounds = await agents.boundingBox();
  const agentDetails = agents.getByRole('group', { name: '代理与团队明细' });
  await agents.getByRole('button', { name: '关闭面板' }).press('Tab');
  assert.ok(await agentDetails.evaluate(element => element === document.activeElement));
  await page.keyboard.press('Escape');
  await agents.waitFor({ state: 'detached' });
  assert.ok(await composer.evaluate(element => element === document.activeElement));
  const trace = page.getByTestId('subagent-transcript');
  const panel = page.getByRole('region', { name: agentName, exact: true });
  await cardAgent.focus();
  const parentTop = await transcript.evaluate(element => element.scrollTop);
  await cardAgent.press('Enter');
  const taskNote = trace.locator('.user-message').filter({ hasText: '复核工作台键盘导航。' });
  await taskNote.waitFor();
  await trace.getByText('检查窄窗口与返回焦点。', { exact: true }).waitFor();
  await trace.getByText('子代理的会话记录。', { exact: true }).waitFor();
  const traceBounds = await panel.boundingBox();
  assert.ok(Math.abs(traceBounds.x - rosterBounds.x) <= 1 && Math.abs(traceBounds.width - rosterBounds.width) <= 1,
    'The roster and the child transcript should occupy the same horizontal space');
  assert.ok(await taskNote.evaluate(element => {
    const task = element.getBoundingClientRect();
    const track = element.closest('.message').getBoundingClientRect();
    return Math.abs(task.left - track.left) <= 1;
  }), 'The delegated instruction should start at the same edge as the child conversation');
  assert.ok(await panel.evaluate(element => element.getBoundingClientRect().height <= 244),
    'The child panel should fit the short transcript instead of using its full height.');
  assert.equal(await trace.getByText('已记录首轮检查。', { exact: true }).count(), 0);
  await trace.hover();
  await page.mouse.wheel(0, -240);
  await trace.getByText('已记录首轮检查。', { exact: true }).waitFor();
  assert.equal(await transcript.getByText('子代理的会话记录。', { exact: true }).count(), 0);
  assert.equal(await transcript.evaluate(element => element.scrollTop), parentTop);
  if (screenshot) await page.screenshot({ path: screenshot.replace(/\.png$/, '-codex-child-trace.png') });
  await page.keyboard.press('Escape');
  await panel.waitFor({ state: 'detached' });
  assert.ok(await cardAgent.evaluate(element => element === document.activeElement));
  await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(...size), agentsSize);
  await page.waitForFunction(([width, height]) => Math.abs(innerWidth - width) <= 2 && Math.abs(innerHeight - height) <= 2, agentsSize);
  await composer.fill('/agents');
  await composer.press('Enter');
  await rosterAgent.press('Enter');
  await agents.waitFor({ state: 'detached' });
  await trace.getByText('子代理的会话记录。', { exact: true }).waitFor();
  assert.equal((await panel.getByRole('button', { name: '返回代理与团队' }).textContent()).trim(), '返回');
  await page.keyboard.press('Escape');
  await rosterAgent.waitFor();
  assert.ok(await rosterAgent.evaluate(element => element === document.activeElement));
  await rosterAgent.press('Enter');
  await panel.getByRole('button', { name: '打开会话', exact: true }).press('Enter');
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

  await page.getByRole('button', { name: '停止', exact: true }).waitFor({ state: 'detached' });
  const readClipboard = () => app.evaluate(async ({ clipboard }) => {
    const [item] = await clipboard.read();
    const read = async type => item?.types.includes(type) ? (await item.getType(type)).text() : '';
    return { text: (await read('text/plain')).replaceAll('\r\n', '\n'), html: await read('text/html') };
  });
  const feedback = page.locator('.composer-status');
  await composer.fill('/copy');
  const formats = page.getByLabel('会话命令');
  await formats.getByRole('button', { name: '/copy 复制 Markdown', exact: true }).waitFor();
  await formats.getByRole('button', { name: '/copy rich 复制富文本', exact: true }).waitFor();
  if (screenshot) await page.screenshot({ path: screenshot.replace(/\.png$/, '-copy-formats.png') });
  await composer.press('ArrowDown');
  await composer.press('Enter');
  const copyReady = feedback.filter({ hasText: /^已复制富文本$/ });
  const copyError = page.getByRole('alert');
  await copyReady.or(copyError).first().waitFor();
  if (!await copyReady.isVisible()) assert.fail(await copyError.innerText());
  const richReply = await readClipboard();
  assert.ok(richReply.text.startsWith('# 工作台会话验收\n') &&
    richReply.text.endsWith('回放和继续会话均已验证。'));
  const pasted = await page.evaluate(html => {
    const parsed = new DOMParser().parseFromString(html, 'text/html');
    return {
      heading: parsed.querySelector('h1')?.textContent,
      nested: parsed.querySelector('ul ul li')?.textContent,
      value: parsed.querySelector('tbody tr td:last-child')?.textContent,
      alignment: parsed.querySelector('tbody tr td:last-child')?.style.textAlign,
      command: parsed.querySelector('pre code')?.textContent?.trim(),
      link: parsed.querySelector('a')?.getAttribute('href'),
    };
  }, richReply.html);
  assert.deepEqual(pasted, {
    heading: '工作台会话验收', nested: '审批出现后，仍可看到原先阅读的段落。',
    value: '已通过', alignment: 'right',
    command: 'git diff --check -- prototype/ui/transcript.jsx prototype/core/src/fixture.rs',
    link: 'https://example.com/span',
  });
  assert.ok(await composer.evaluate(element => document.activeElement === element));
  if (screenshot) await page.screenshot({ path: screenshot.replace(/\.png$/, '-copy-feedback.png') });
  await composer.fill('/copy markdown');
  await composer.press('Enter');
  await feedback.filter({ hasText: /^已复制 Markdown$/ }).waitFor();
  assert.deepEqual(await readClipboard(), { text: richReply.text, html: '' });

  const markup = '<script data-example>字面示例</script>\n\n' +
    '[本地](file:///tmp/span-copy) ![图片](https://example.com/sample.png) [文档](https://example.com/guide)';
  assert.ok(await page.evaluate(text => window.span.copyRich(text), markup));
  const safe = await readClipboard();
  assert.equal(safe.text, markup);
  assert.match(safe.html, /&lt;script/);
  assert.match(safe.html, /href="https:\/\/example\.com\/guide"/);
  assert.doesNotMatch(safe.html, /<script|<img|href="file:/i);
  await assert.rejects(page.evaluate(() => window.span.copyRich({ text: '无效' })), /无效的剪贴板文本/);
  await assert.rejects(page.evaluate(() => window.span.copyRich('文'.repeat(350000))), /富文本超出长度限制/);
  assert.deepEqual(await readClipboard(), safe);
  console.log('Verified rich and Markdown copies through the native clipboard and kept untrusted markup inert.');

  const reviewWorkspace = join(profile, 'review-workspace');
  const reviewDirectory = join(reviewWorkspace, 'workbench-guides', 'interface-review');
  const reviewName = 'windows-and-el8-workbench-navigation-checklist.md';
  const notesName = 'windows-and-el8-workbench-verification-notes.md';
  await mkdir(reviewDirectory, { recursive: true });
  await writeFile(join(reviewWorkspace, reviewName), '# 工作区索引');
  const reviewSteps = Array.from({ length: 36 }, (_, index) =>
    `${index + 1}. 确认文件名、目录与预览内容对应。`).join('\n');
  await writeFile(join(reviewDirectory, reviewName), `# 窗口布局复核\n\n检查窄窗里的文件位置与阅读顺序。\n\n${reviewSteps}`);
  await writeFile(join(reviewDirectory, notesName), `# 键盘操作记录\n\n通过键盘切换和关闭预览。\n\n${reviewSteps}`);
  await app.evaluate(({ dialog }, workspace) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [workspace] });
  }, reviewWorkspace);
  await page.getByRole('button', { name: '停止', exact: true }).waitFor({ state: 'detached' });
  await page.getByRole('button', { name: '文件', exact: true }).click();
  await page.getByRole('button', { name: '选择本地工作区', exact: true }).click();
  const location = sidebar.locator('.file-directory');
  await page.waitForFunction(() => document.querySelector('.file-directory')?.textContent === 'review-workspace');
  await sidebar.getByRole('button', { name: 'workbench-guides', exact: true }).press('Enter');
  await sidebar.getByRole('button', { name: 'interface-review', exact: true }).press('Enter');
  assert.equal(await location.textContent(), 'interface-review');
  assert.equal(await location.getAttribute('title'), reviewDirectory);
  assert.ok(await location.evaluate(element => element === document.activeElement));
  const upDirectory = sidebar.getByRole('button', { name: '上一级', exact: true });
  await page.keyboard.press('Tab');
  assert.ok(await upDirectory.evaluate(element => element === document.activeElement));

  const reviewFile = sidebar.getByRole('button', { name: reviewName, exact: true });
  const notesFile = sidebar.getByRole('button', { name: notesName, exact: true });
  await reviewFile.press('Enter');
  const previewContent = preview.locator('.preview-content');
  const previewTitle = preview.locator('header strong');
  const previewFolder = preview.locator('.preview-directory');
  const checkPreviewHeader = async () => {
    assert.ok(await previewFolder.evaluate(folder => {
      const name = folder.previousElementSibling;
      const nameBounds = name.getBoundingClientRect();
      const folderBounds = folder.getBoundingClientRect();
      return nameBounds.left === folderBounds.left && nameBounds.bottom <= folderBounds.top &&
        folder.scrollWidth === folder.clientWidth;
    }), 'The nested folder uses a separate line below the file title and fits without clipping');
  };
  await preview.getByRole('heading', { name: '窗口布局复核' }).waitFor();
  assert.equal(await reviewFile.getAttribute('aria-current'), 'true');
  assert.equal(await previewTitle.textContent(), reviewName);
  assert.equal(await previewFolder.textContent(), 'workbench-guides/interface-review');
  await checkPreviewHeader();
  assert.ok(await reviewFile.evaluate(element => {
    const name = element.querySelector('.file-reference-name');
    const start = name.firstElementChild;
    const range = document.createRange();
    range.selectNode(name.lastChild);
    return start.scrollWidth > start.clientWidth && name.textContent.endsWith('.md') &&
      range.getBoundingClientRect().right <= element.getBoundingClientRect().right;
  }), 'The side list clips the long filename stem while keeping its suffix visible');
  if (screenshot) await page.screenshot({ path: screenshot.replace(/\.png$/, '-file-location-narrow.png') });

  await previewContent.press('End');
  await page.waitForFunction(() => document.querySelector('#file-preview .preview-content').scrollTop > 100);
  await notesFile.press('Enter');
  await preview.getByRole('heading', { name: '键盘操作记录' }).waitFor();
  assert.equal(await previewContent.evaluate(element => element.scrollTop), 0);
  assert.equal(await notesFile.getAttribute('aria-current'), 'true');
  assert.equal(await reviewFile.getAttribute('aria-current'), null);
  await previewContent.press('Escape');
  assert.equal(await notesFile.getAttribute('aria-current'), null);
  assert.ok(await notesFile.evaluate(element => element === document.activeElement));

  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1240, 840));
  await page.waitForFunction(() => innerWidth === 1240 && innerHeight === 840);
  await reviewFile.press('Enter');
  await preview.getByRole('heading', { name: '窗口布局复核' }).waitFor();
  await checkPreviewHeader();
  if (screenshot) await page.screenshot({ path: screenshot.replace(/\.png$/, '-file-location-wide.png') });

  const holdNotesPreview = async () => {
    await app.evaluate(({ BrowserWindow }) => {
      const { ipc } = BrowserWindow.getAllWindows()[0].webContents;
      let receive;
      let release;
      const request = new Promise(resolve => { receive = resolve; });
      const reply = new Promise(resolve => { release = resolve; });
      globalThis.spanNotesPreview = { request, release };
      ipc.handleOnce('span:request', (_event, method, params) => {
        receive({ method, path: params?.path });
        return reply;
      });
    });
    await notesFile.press('Enter');
    const request = await app.evaluate(() => Promise.race([
      globalThis.spanNotesPreview.request,
      new Promise(resolve => setTimeout(resolve, 5000).unref()),
    ]));
    assert.deepEqual(request, { method: 'files.preview', path: 'workbench-guides/interface-review/' + notesName });
  };
  const releaseNotesPreview = async () => {
    await app.evaluate(() => {
      globalThis.spanNotesPreview.release({ kind: 'text', data: '旧目录的预览回包' });
      delete globalThis.spanNotesPreview;
    });
    // A subsequent renderer request and frame let the earlier preview reply reach its caller.
    await page.evaluate(async cwd => {
      await window.span.request('files.list', { cwd, path: '' });
      await new Promise(requestAnimationFrame);
    }, reviewWorkspace);
    assert.equal(await previewTitle.textContent(), reviewName);
  };
  await holdNotesPreview();
  await upDirectory.press('Enter');
  const interfaceDirectory = sidebar.getByRole('button', { name: 'interface-review', exact: true });
  await interfaceDirectory.waitFor();
  assert.equal(await location.textContent(), 'workbench-guides');
  await releaseNotesPreview();
  await interfaceDirectory.press('Enter');
  await holdNotesPreview();
  await sidebar.getByRole('button', { name: '会话', exact: true }).click();
  await releaseNotesPreview();
  await sidebar.getByRole('button', { name: '文件', exact: true }).click();
  await upDirectory.press('Enter');
  await upDirectory.press('Enter');
  await reviewFile.waitFor();
  assert.equal(await location.textContent(), 'review-workspace');
  assert.equal(await reviewFile.getAttribute('aria-current'), null);
  assert.equal(await previewTitle.textContent(), reviewName);
  console.log('Verified changing directory or leaving the files tab discards a pending preview without replacing the open file.');
  console.log('Verified folder context, current-file styling, filename suffix, scroll reset, and keyboard navigation in the file preview.');
} finally {
  await app.close();
  await rm(profile, { recursive: true, force: true, maxRetries: 3 });
}
