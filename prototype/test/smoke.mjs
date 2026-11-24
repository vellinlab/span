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
  assert.ok(await dismissGoal.evaluate(button => button === document.activeElement));
  await page.keyboard.press('Escape');
  await goalPanel.waitFor({ state: 'detached' });
  assert.ok(await goal.evaluate(button => button === document.activeElement));
  await composer.fill('/goal pause');
  await composer.press('Enter');
  await goal.getByText('已暂停').waitFor();
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
  if (screenshot) await page.screenshot({ path: screenshot.replace(/\.png$/, '-reasoning.png') });
  await liveReasoning.press('Enter');
  const reasoningPanel = page.getByRole('region', { name: '推理摘要' });
  await reasoningPanel.locator('ul ul').getByText('保留列表缩进', { exact: true }).waitFor();
  await reasoningPanel.getByText('再确认工具结果和最终回复的前后顺序。', { exact: true }).waitFor();
  if (screenshot) await page.screenshot({ path: screenshot.replace(/\.png$/, '-expanded.png') });
  await reasoningPanel.getByRole('button', { name: '关闭面板' }).press('Escape');
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
  await archivedReasoning.locator('summary').click();
  await archivedReasoning.locator('ul ul').getByText('保留列表缩进', { exact: true }).waitFor();
  await archivedReasoning.getByText('确认目标卡片和输入区之间的间距。', { exact: false }).waitFor();
  assert.equal(await transcript.locator('[data-card="command"] pre').count(), 0);
  await archivedReasoning.locator('summary').click();
  assert.equal(await page.getByRole('alert').count(), 0);
  console.log('Verified the fixed reasoning strip, history scroll position, nested details, and archived summary.');
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
  await page.getByRole('region', { name: '用量' }).waitFor({ state: 'detached' });
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
    const refuse = rect('.approval-actions button');
    const hit = document.elementFromPoint(refuse.left + refuse.width / 2, refuse.top + refuse.height / 2);
    return rect('.timeline').height >= 44 && rect('.approval-context').bottom <= rect('.approval-body').bottom &&
      rect('.approval-actions').bottom <= rect('.composer').top && rect('.terminal-canvas').height >= 70 &&
      rect('.composer').bottom <= rect('.terminal-panel').top && Boolean(hit?.closest('.approval-actions button'));
  }), 'History, approval scope and actions, the long draft and terminal fit at the minimum window size');
  if (screenshot) await page.screenshot({ path: screenshot.replace(/\.png$/, '-approval-compact.png') });
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
  await group.waitFor();
  await groupAnswer.waitFor();
  await failedCommand.getByText('退出码 1', { exact: true }).waitFor();
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
  await page.getByRole('heading', { name: '开始新会话' }).waitFor();
  assert.equal(await branch.count(), 0);
  assert.ok(await composer.evaluate(element => document.activeElement === element));
  assert.equal(await composer.inputValue(), '');
  const retryDraft = '验证新会话草稿重试。';
  await composer.fill(retryDraft);
  await composer.press('Enter');
  await page.getByRole('alert').getByText('模拟发送失败，请重试。', { exact: true }).waitFor();
  assert.equal(await composer.inputValue(), retryDraft);
  assert.equal(await transcript.getByText(retryDraft, { exact: true }).count(), 0);
  await composer.press('Enter');
  await transcript.getByText('草稿已成功重试。', { exact: true }).waitFor();
  assert.equal(await transcript.getByText(retryDraft, { exact: true }).count(), 1);
  await page.waitForFunction(() => document.querySelector('.composer textarea').value === '');
  assert.equal(await page.getByRole('alert').count(), 0);
  console.log('Verified history paging, file preview, PTY, streaming and interrupt.');
  console.log('Verified a new session keeps a rejected draft and clears it after one successful retry.');

  await composer.fill('验证子代理导航。');
  await composer.press('Enter');
  await transcript.getByText('代理导航验收完成。', { exact: true }).waitFor();
  const agentName = '键盘导航和窄窗布局复核';
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
  assert.equal(await waitCard.getByRole('list', { name: '代理成员' }).count(), 0);
  await waitCard.locator('summary').press('Enter');
  await waitCard.getByRole('button', { name: openAgent }).waitFor();
  await waitCard.getByText('已核对键盘焦点。', { exact: true }).waitFor();
  await waitCard.getByText('失败', { exact: true }).waitFor();
  if (screenshot) await page.screenshot({ path: screenshot.replace(/\.png$/, '-agents-card.png') });
  await composer.fill('/agents');
  await composer.press('Enter');
  const agents = page.getByRole('region', { name: '代理与团队' });
  const rosterAgent = agents.getByRole('button', { name: openAgent });
  await rosterAgent.waitFor();
  await agents.getByText('fixture-review', { exact: true }).waitFor();
  await agents.getByText('已完成', { exact: true }).waitFor();
  await agents.getByText('失败', { exact: true }).waitFor();
  if (screenshot) await page.screenshot({ path: screenshot.replace(/\.png$/, '-agents-panel.png') });
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
