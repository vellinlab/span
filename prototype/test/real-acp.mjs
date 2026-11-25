import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron } from 'playwright';

const [backend, binary, executable, screenshot, ssh] = process.argv.slice(2);
const label = { opencode: 'OpenCode', kilo: 'Kilo' }[backend];
assert.ok(label, 'Select opencode or kilo');
const envPrefix = backend.toUpperCase();
const workspaceName = `${label} 工作区`;
const profile = await mkdtemp(join(tmpdir(), `span-${backend}-`));
const workspace = join(profile, workspaceName);
const state = join(profile, 'state');
const command = 'echo span-acp-tool';
const initial = `核对 ${label} 的推理、工具和审批。`;
const next = `继续已经保存的 ${label} 会话。`;
const answer = `${label} 已交付结果。`;
const continued = `${label} 已继续原会话。`;
const firstReasoning = `先核对 ${label}。`;
const goalObjective = '核对目标卡片和实际任务状态。';
const goalReasoning = '检查原生目标的暂停与恢复。';
const goalReport = '已核对目标卡片和会话状态。';
const goalAnswer = '原生目标已完成。';
let goalRequests = 0;
let toolResult;
let gatewayError;
let releaseReasoning;
let releaseTool;
const gateway = createServer(async (request, response) => {
  try {
    assert.equal(request.url, '/v1/chat/completions');
    let data = '';
    for await (const chunk of request) data += chunk;
    const { messages, model } = JSON.parse(data);
    assert.equal(model, 'span-acp');
    const last = messages.findLast(message => message.role === 'user');
    const text = typeof last.content === 'string' ? last.content : last.content.map(part => part.text).join('\n');
    const tool = messages.at(-1)?.role === 'tool' ? messages.at(-1) : undefined;
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const emit = (delta, finish_reason = null, usage) => {
      response.write('data: ' + JSON.stringify({ id: 'span-acp-test', object: 'chat.completion.chunk', model,
        choices: [{ index: 0, delta, finish_reason }], usage }) + '\n\n');
    };
    emit({ role: 'assistant' });
    if (backend === 'kilo' && text.startsWith('Generate a title for this conversation:')) {
      emit({ content: 'Kilo 会话验证' });
      emit({}, 'stop', { prompt_tokens: 15, completion_tokens: 4, total_tokens: 19 });
    } else if (text.includes(goalObjective)) {
      if (tool) {
        assert.match(JSON.stringify(tool.content), /Report recorded/);
        emit({ content: goalAnswer });
        emit({}, 'stop', { prompt_tokens: 28, completion_tokens: 10, total_tokens: 38 });
      } else if (++goalRequests === 1) {
        emit({ reasoning_content: goalReasoning });
        await once(response, 'close');
        return;
      } else {
        emit({ tool_calls: [{ index: 0, id: 'span-goal-report', type: 'function',
          function: { name: 'goal_report', arguments: JSON.stringify({ status: 'complete', reason: goalReport }) } }] });
        emit({}, 'tool_calls', { prompt_tokens: 26, completion_tokens: 9, total_tokens: 35 });
      }
    } else if (text.includes(initial) && !tool) {
      emit({ reasoning_content: firstReasoning });
      await new Promise(done => { releaseReasoning = done; });
      emit({ reasoning_content: '\n再检查工具与审批。' });
      await new Promise(done => { releaseTool = done; });
      emit({ tool_calls: [{ index: 0, id: 'span-acp-call', type: 'function',
        function: { name: 'bash', arguments: JSON.stringify({ command, description: '输出验收标记' }) } }] });
      emit({}, 'tool_calls', { prompt_tokens: 21, completion_tokens: 8, total_tokens: 29 });
    } else {
      if (tool) {
        toolResult = JSON.stringify(tool.content);
      } else assert.ok(text.includes(next), text);
      emit({ content: tool ? answer : continued });
      emit({}, 'stop', { prompt_tokens: 25, completion_tokens: 9, total_tokens: 34 });
    }
    response.end('data: [DONE]\n\n');
  } catch (error) {
    gatewayError = error;
    if (!response.headersSent) response.writeHead(400);
    response.end('ACP test gateway received an unexpected request.');
  }
});
gateway.listen(0, '127.0.0.1');
await once(gateway, 'listening');

const shellQuote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const remoteBin = `/home/span-preview-ci/.${backend}/bin`;
const remoteWrapper = join(remoteBin, backend);
const remoteLog = join(state, 'acp-stderr.log');
let app;
let page;
try {
  await mkdir(workspace);
  await mkdir(state);
  const configPath = join(state, `${backend}.json`);
  const config = {
    model: 'span/span-acp', enabled_providers: ['span'],
    provider: { span: {
      name: 'Span ACP', npm: '@ai-sdk/openai-compatible',
      options: { baseURL: 'http://127.0.0.1:' + gateway.address().port + '/v1', apiKey: 'preview-test' },
      models: { 'span-acp': { name: 'Span ACP', reasoning: true, limit: { context: 32768, output: 4096 } } },
    } },
    permission: { bash: 'ask' },
  };
  await writeFile(configPath, JSON.stringify(config));
  const env = {
    [`${envPrefix}_CONFIG`]: configPath, [`${envPrefix}_TEST_HOME`]: state,
    [`${envPrefix}_DISABLE_AUTOUPDATE`]: '1', [`${envPrefix}_DISABLE_MODELS_FETCH`]: '1',
    ...Object.fromEntries(['DATA', 'CACHE', 'CONFIG', 'STATE'].map(name => ['XDG_' + name + '_HOME', join(state, name)])),
  };
  if (ssh) {
    await mkdir(remoteBin, { recursive: true });
    const exports = Object.entries(env).map(([key, value]) => key + '=' + shellQuote(value)).join(' ');
    await writeFile(remoteWrapper,
      `#!/bin/sh\nexec env ${exports} ${shellQuote(resolve(executable))} "$@" 2>>${shellQuote(remoteLog)}\n`,
      { mode: 0o755 });
    execFileSync('chmod', ['0711', profile]);
    execFileSync('chown', ['-R', 'span-preview-ci:span-preview-ci', state]);
    const installed = execFileSync('ssh', ['-T', '-o', 'BatchMode=yes', '--', ssh,
      `"$HOME/.${backend}/bin/${backend}" --version`], { encoding: 'utf8', timeout: 10_000 });
    console.log(label + ' on ' + ssh + ': ' + installed.trim().replace(/\n/g, ' '));
  }
  async function open(selectConnection) {
    app = await electron.launch({
      executablePath: binary, args: ['--no-sandbox', '--disable-gpu'],
      env: { ...process.env, ...env, SPAN_PREVIEW_PROFILE: profile, [`SPAN_${envPrefix}_PATH`]: resolve(executable) },
    });
    page = await app.firstWindow();
    if (selectConnection) {
      await page.getByRole('button', { name: '主机', exact: true }).click();
      if (ssh) await page.getByLabel('SSH 目标').fill(ssh);
      else {
        await app.evaluate(({ dialog }, directory) => {
          dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] });
        }, workspace);
        await page.locator('.host-form').getByRole('button', { name: '选择本地工作区' }).click();
        await page.locator('.host-form').getByText(workspaceName, { exact: true }).waitFor();
      }
      await page.getByLabel('Agent 后端').selectOption(backend);
      await page.getByRole('button', { name: ssh ? '连接 SSH' : '连接本机', exact: true }).click();
    }
    const connected = page.locator('.connection[data-route="stdio"]').filter({
      hasText: label + ' · ' + (ssh ?? '本机'), has: page.locator('i.ready'),
    });
    await connected.waitFor({ timeout: 30_000 });
  }

  async function narrow() {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(740, 520));
    await page.waitForFunction(() => Math.abs(innerWidth - 740) <= 2 && Math.abs(innerHeight - 520) <= 2);
  }

  await open(true);
  await narrow();
  const send = async text => {
    const composer = page.getByRole('textbox', { name: '消息' });
    await composer.fill(text);
    await composer.press('Enter');
  };
  await send(initial);
  const transcript = page.getByTestId('transcript');
  const reasoning = page.getByRole('button', { name: '实时推理摘要' });
  await reasoning.getByText(firstReasoning, { exact: true }).waitFor();
  const position = await reasoning.boundingBox();
  releaseReasoning();
  await reasoning.getByText('再检查工具与审批。', { exact: true }).waitFor();
  assert.deepEqual(await reasoning.boundingBox(), position);
  if (screenshot) await page.screenshot({ path: screenshot.replace(/\.png$/, '-reasoning.png') });
  releaseTool();
  const approval = page.getByRole('region', { name: '执行命令', exact: true });
  const allow = approval.getByRole('button', { name: '仅允许这次', exact: true });
  await allow.waitFor();
  const commandText = approval.getByLabel('待执行命令');
  assert.equal(await commandText.textContent(), command);
  assert.ok(await commandText.evaluate(element => {
    const bounds = element.getBoundingClientRect();
    const visible = element.closest('.approval-body').getBoundingClientRect();
    return bounds.top >= Math.max(0, visible.top) && bounds.bottom <= Math.min(innerHeight, visible.bottom);
  }), 'The complete short command is visible before approval');
  assert.ok(await allow.evaluate(element => {
    const bounds = element.getBoundingClientRect();
    return element.contains(document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2));
  }));
  const remember = approval.getByRole('button', { name: '始终允许', exact: true });
  assert.equal(await remember.getAttribute('data-remember'), 'true');
  const background = button => button.evaluate(element => getComputedStyle(element).backgroundColor);
  assert.notEqual(await background(allow), await background(remember));
  if (screenshot) await page.screenshot({ path: screenshot.replace(/\.png$/, '-approval.png') });
  await allow.press('Enter');
  await approval.waitFor({ state: 'detached' });
  const activity = transcript.locator('[data-card="command"]').filter({ hasText: command });
  await activity.waitFor();
  await transcript.getByText(answer, { exact: true }).waitFor();
  assert.ok(toolResult.includes('span-acp-tool'));
  await page.getByRole('button', { name: '发送', exact: true }).waitFor();
  await send('/usage');
  const usage = page.getByRole('region', { name: '用量', exact: true });
  const currentUsage = usage.getByRole('region', { name: '会话用量', exact: true });
  await currentUsage.getByText('上下文', { exact: true }).waitFor();
  assert.equal(await currentUsage.getByText('总计', { exact: true }).count(), 0);
  await usage.getByRole('region', { name: '最近一次用量' }).getByText('总计', { exact: true }).waitFor();
  if (screenshot) await page.screenshot({ path: screenshot.replace(/\.png$/, '-usage.png') });
  await usage.getByRole('button', { name: '关闭面板' }).press('Escape');
  await usage.waitFor({ state: 'detached' });
  if (screenshot) await page.screenshot({ path: screenshot });
  await app.close();

  await open(false);
  const reopened = page.getByTestId('transcript');
  await reopened.getByText(answer, { exact: true }).waitFor();
  assert.equal(await reopened.getByText(initial, { exact: true }).count(), 1);
  await reopened.locator('[data-card="command"]').filter({ hasText: command }).waitFor();
  await send('/plan');
  await send('/model');
  const settings = page.getByRole('region', { name: '运行设置' });
  const mode = settings.getByRole('combobox', { name: '模式', exact: true });
  await mode.waitFor();
  await settings.getByRole('option', { name: 'Span ACP', exact: true }).waitFor({ state: 'attached' });
  assert.equal(await mode.inputValue(), 'plan');
  await settings.getByRole('button', { name: '关闭面板' }).press('Escape');
  await settings.waitFor({ state: 'detached' });
  await send('/plan');
  await send('/model');
  await mode.waitFor();
  assert.equal(await mode.inputValue(), backend === 'kilo' ? 'code' : 'build');
  await settings.getByRole('button', { name: '关闭面板' }).press('Escape');
  await send(next);
  await reopened.getByText(continued, { exact: true }).waitFor();
  assert.equal(await reopened.getByText(initial, { exact: true }).count(), 1);
  await page.getByRole('button', { name: '发送', exact: true }).waitFor();
  const model = page.getByRole('button', { name: 'Agent 控件', exact: true }).getByText('Span ACP', { exact: false });
  await model.waitFor();
  await send('/new');
  await page.getByPlaceholder('描述要完成的任务…').waitFor();
  assert.equal(await model.count(), 0);
  if (backend === 'kilo') {
    await narrow();
    const goalPanel = () => page.getByRole('region', { name: '会话目标', exact: true });
    const goalStrip = () => page.locator('.goal-strip').filter({ hasText: goalObjective });
    const closeGoal = () => goalPanel().getByRole('button', { name: '关闭面板' }).press('Escape');
    await send('/goal');
    await goalPanel().getByRole('textbox', { name: '目标', exact: true }).fill(goalObjective);
    assert.equal(await goalPanel().getByText('Token 预算').count(), 0);
    await goalPanel().getByRole('button', { name: '启动目标', exact: true }).press('Enter');
    await goalStrip().getByText('进行中', { exact: true }).waitFor();
    await page.getByRole('button', { name: '实时推理摘要' }).getByText(goalReasoning, { exact: true }).waitFor();
    await closeGoal();
    await goalPanel().waitFor({ state: 'detached' });
    assert.ok(await goalStrip().evaluate(element => {
      const bounds = element.getBoundingClientRect();
      const composer = document.querySelector('.composer').getBoundingClientRect();
      return bounds.bottom < composer.top && Math.abs(bounds.left - composer.left) <= 1;
    }));
    if (screenshot) await page.screenshot({ path: screenshot.replace(/\.png$/, '-goal.png') });
    await goalStrip().press('Enter');
    await goalPanel().getByRole('button', { name: '暂停', exact: true }).press('Enter');
    await goalStrip().getByText('已暂停', { exact: true }).waitFor();
    await app.close();
    await open(false);
    await narrow();
    await goalStrip().getByText('已暂停', { exact: true }).waitFor();
    assert.equal(await page.getByTestId('transcript').getByText('Continue working toward this session goal:').count(), 0);
    await goalStrip().press('Enter');
    await goalPanel().getByRole('button', { name: '继续', exact: true }).press('Enter');
    await goalStrip().getByText('已完成', { exact: true }).waitFor();
    await page.getByTestId('transcript').getByText(goalAnswer, { exact: true }).waitFor();
    await goalPanel().locator('.goal-reason').filter({ hasText: goalReport }).waitFor();
    if (screenshot) await page.screenshot({ path: screenshot.replace(/\.png$/, '-goal-complete.png') });
    await goalPanel().getByRole('button', { name: '清除', exact: true }).press('Enter');
    await goalStrip().waitFor({ state: 'detached' });
    console.log(`Verified Kilo's native goal start, pause, persisted state, resume, completion and clear on ${ssh ?? process.platform}`);
  }
  assert.equal(gatewayError, undefined);
  console.log(`Verified ${label} ACP reasoning, permission, usage, persisted history and continuation on ${ssh ?? process.platform}`);
} catch (error) {
  if (page) {
    console.error(await page.getByRole('alert').allTextContents().catch(() => []));
    if (screenshot) await page.screenshot({ path: screenshot.replace(/\.png$/, '-failure.png') }).catch(() => {});
  }
  if (gatewayError) console.error(gatewayError);
  if (ssh) {
    const stderr = await readFile(remoteLog, 'utf8').catch(() => '');
    if (stderr) console.error(stderr.slice(-8000));
  }
  throw error;
} finally {
  releaseReasoning?.();
  releaseTool?.();
  await app?.close().catch(() => {});
  gateway.closeAllConnections();
  gateway.close();
  if (ssh) await rm(remoteWrapper, { force: true });
  await rm(profile, { recursive: true, force: true, maxRetries: 3 });
}
