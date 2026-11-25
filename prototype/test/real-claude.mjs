import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron } from 'playwright';

const [binary, executable, screenshot, ssh] = process.argv.slice(2);
const profile = await mkdtemp(join(tmpdir(), 'span-claude-'));
const workspaceName = 'Claude 工作区';
const workspace = join(profile, workspaceName);
const config = join(profile, 'claude');
const model = 'claude-sonnet-4-6';
const initial = '核对 Claude 的推理与工具审批。';
const next = '继续已保存的 Claude 会话。';
const reasoningStart = '先检查当前任务。';
const reasoningUpdate = '随后核对命令与权限。';
const command = 'echo span-claude-tool';
const answer = '已完成 Claude 的首次检查。';
const continued = 'Claude 已继续原会话。';
const objective = '验收结束时保持工作目录不变。';
const toolId = 'toolu_span_claude_command';
let releaseReasoning;
let releaseTool;
let toolResult;
let resumedWithHistory = false;
let failure;
let messages = 0;

const gateway = createServer(async (request, response) => {
  try {
    const path = new URL(request.url, 'http://127.0.0.1').pathname;
    if (request.method === 'GET' && path === '/v1/models') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ data: [{ id: model, type: 'model', display_name: 'Claude Sonnet',
        created_at: '2026-01-01T00:00:00Z' }], has_more: false, first_id: model, last_id: model }));
      return;
    }
    if (path === '/v1/messages/count_tokens') {
      request.resume();
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ input_tokens: 32 }));
      return;
    }
    assert.equal(path, '/v1/messages');
    let data = '';
    for await (const chunk of request) data += chunk;
    const body = JSON.parse(data);
    const message = { id: `msg_span_${++messages}`, type: 'message', role: 'assistant', content: [],
      model: body.model, stop_reason: null, stop_sequence: null,
      usage: { input_tokens: 32, output_tokens: 0, cache_read_input_tokens: 7, cache_creation_input_tokens: 3 } };
    if (!body.stream) {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ ...message, stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'Claude 会话检查' }] }));
      return;
    }
    const users = body.messages.filter(message => message.role === 'user');
    const last = users.at(-1)?.content;
    const lastText = typeof last === 'string' ? last : (last ?? [])
      .filter(part => part.type === 'text').map(part => part.text).join('\n');
    const result = Array.isArray(last) ? last.find(part => part.type === 'tool_result' && part.tool_use_id === toolId) : null;
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const emit = (type, value = {}) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`);
    const start = (index, content_block) => emit('content_block_start', { index, content_block });
    const delta = (index, delta) => emit('content_block_delta', { index, delta });
    const stop = index => emit('content_block_stop', { index });
    const reply = text => {
      start(0, { type: 'text', text: '' });
      delta(0, { type: 'text_delta', text });
      stop(0);
    };
    emit('message_start', { message });
    let stopReason = 'end_turn';
    if (result) {
      toolResult = JSON.stringify(result.content);
      reply(answer);
    } else if (lastText.includes(next) && JSON.stringify(users).includes(initial)) {
      resumedWithHistory = true;
      reply(continued);
    } else if (lastText.includes(initial) && body.tools?.length) {
      start(0, { type: 'thinking', thinking: '' });
      delta(0, { type: 'thinking_delta', thinking: reasoningStart });
      await new Promise(done => { releaseReasoning = done; });
      delta(0, { type: 'thinking_delta', thinking: '\n' + reasoningUpdate });
      delta(0, { type: 'signature_delta', signature: 'span-fixture-thinking' });
      stop(0);
      await new Promise(done => { releaseTool = done; });
      start(1, { type: 'tool_use', id: toolId, name: 'Bash', input: {} });
      delta(1, { type: 'input_json_delta', partial_json: JSON.stringify({ command, description: '输出验收标记' }) });
      stop(1);
      stopReason = 'tool_use';
    } else {
      reply('Claude 会话检查');
    }
    emit('message_delta', { delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 12 } });
    emit('message_stop');
    response.end();
  } catch (error) {
    failure = error;
    if (!response.headersSent) response.writeHead(400, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'Unexpected fixture request' } }));
  }
});
gateway.listen(0, '127.0.0.1');
await once(gateway, 'listening');

const shellQuote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const remoteBin = '/home/span-preview-ci/.claude-agent-acp/bin';
const wrapper = join(remoteBin, 'claude-agent-acp');
const remoteLog = join(config, 'acp-stderr.log');
let app;
let page;
try {
  await mkdir(workspace);
  await mkdir(config);
  await writeFile(join(config, 'settings.json'), JSON.stringify({ permissions: { ask: ['Bash'] } }));
  const env = {
    CLAUDE_CONFIG_DIR: config, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: 'false', DISABLE_AUTOUPDATER: '1',
    ANTHROPIC_API_KEY: 'span-fixture', ANTHROPIC_MODEL: model,
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:' + gateway.address().port,
  };
  if (ssh) {
    await mkdir(remoteBin, { recursive: true });
    const exports = Object.entries(env).map(([key, value]) => key + '=' + shellQuote(value)).join(' ');
    await writeFile(wrapper, `#!/bin/sh\nexec env ${exports} ${shellQuote(resolve(executable))} "$@" 2>>${shellQuote(remoteLog)}\n`,
      { mode: 0o755 });
    execFileSync('chmod', ['0711', profile]);
    execFileSync('chown', ['-R', 'span-preview-ci:span-preview-ci', config]);
  }
  async function open(selectConnection) {
    app = await electron.launch({
      executablePath: binary, args: ['--no-sandbox', '--disable-gpu'],
      env: { ...process.env, ...env, SPAN_PREVIEW_PROFILE: profile, SPAN_CLAUDE_ACP_PATH: resolve(executable) },
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
      await page.getByLabel('Agent 后端').selectOption('claude');
      await page.getByRole('button', { name: ssh ? '连接 SSH' : '连接本机', exact: true }).click();
    }
    await page.locator('.connection[data-route="stdio"]').filter({
      hasText: 'Claude Code · ' + (ssh ?? '本机'), has: page.locator('i.ready'),
    }).waitFor({ timeout: 40_000 });
  }

  async function send(text) {
    const composer = page.getByRole('textbox', { name: '消息' });
    await composer.fill(text);
    await composer.press('Enter');
  }

  async function narrow() {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(740, 520));
    await page.waitForFunction(() => Math.abs(innerWidth - 740) <= 2 && Math.abs(innerHeight - 520) <= 2);
  }

  await open(true);
  await narrow();
  await send(initial);
  const reasoning = page.getByRole('button', { name: '实时推理摘要' });
  await reasoning.getByText(reasoningStart, { exact: true }).waitFor();
  const position = await reasoning.boundingBox();
  releaseReasoning();
  await reasoning.getByText(reasoningUpdate, { exact: true }).waitFor();
  assert.deepEqual(await reasoning.boundingBox(), position);
  if (screenshot) await page.screenshot({ path: screenshot.replace(/\.png$/, '-reasoning.png') });
  releaseTool();
  const approval = page.getByRole('button', { name: '仅允许这次', exact: true });
  await approval.waitFor();
  assert.equal(await page.getByLabel('待执行命令').textContent(), command);
  if (screenshot) await page.screenshot({ path: screenshot.replace(/\.png$/, '-approval.png') });
  await approval.press('Enter');
  const transcript = () => page.getByTestId('transcript');
  await transcript().getByText(answer, { exact: true }).waitFor();
  assert.match(toolResult ?? '', /span-claude-tool/);
  await page.getByRole('button', { name: '发送', exact: true }).waitFor();
  await send('/usage');
  const usage = page.getByRole('region', { name: '用量', exact: true });
  const recentUsage = usage.getByRole('region', { name: '最近一次用量' });
  await recentUsage.getByText('总计', { exact: true }).waitFor();
  await recentUsage.getByText('缓存写入', { exact: true }).waitFor();
  await usage.getByRole('button', { name: '关闭面板' }).press('Escape');
  await app.close();

  await open(false);
  await transcript().getByText(answer, { exact: true }).waitFor();
  await transcript().locator('[data-card="command"]').filter({ hasText: command }).waitFor();
  assert.equal(await transcript().getByText(initial, { exact: true }).count(), 1);
  await send(next);
  await transcript().getByText(continued, { exact: true }).waitFor();
  assert.ok(resumedWithHistory, 'Claude should receive the original request on resume');
  await page.getByRole('button', { name: '发送', exact: true }).waitFor();
  await narrow();
  await send('/goal ' + objective);
  const goal = page.locator('.goal-strip').filter({ hasText: objective });
  await goal.waitFor();
  await page.getByRole('button', { name: '发送', exact: true }).waitFor();
  assert.ok(await goal.evaluate(element => {
    const bounds = element.getBoundingClientRect();
    const composer = document.querySelector('.composer').getBoundingClientRect();
    return bounds.bottom < composer.top && Math.abs(bounds.left - composer.left) <= 1;
  }), 'The Goal card belongs above the composer and aligns with it');
  await goal.click();
  const goalPanel = page.getByRole('region', { name: '会话目标', exact: true });
  await goalPanel.getByRole('button', { name: '编辑', exact: true }).waitFor();
  assert.equal(await goalPanel.getByRole('button', { name: '暂停', exact: true }).count(), 0);
  assert.equal(await goalPanel.getByRole('button', { name: '继续', exact: true }).count(), 0);
  if (screenshot) await page.screenshot({ path: screenshot.replace(/\.png$/, '-goal.png') });
  await goalPanel.getByRole('button', { name: '清除', exact: true }).click();
  await goal.waitFor({ state: 'hidden' });
  if (screenshot) await page.screenshot({ path: screenshot });
  assert.equal(failure, undefined);
  console.log(`Verified Claude Code ACP reasoning, tool permission, usage, history, continuation and goal controls on ${ssh ?? process.platform}`);
} catch (error) {
  if (page) {
    console.error(await page.getByRole('alert').allTextContents().catch(() => []));
    if (screenshot) await page.screenshot({ path: screenshot.replace(/\.png$/, '-failure.png') }).catch(() => {});
  }
  if (failure) console.error(failure);
  if (ssh) {
    const stderr = await readFile(remoteLog, 'utf8').catch(() => '');
    if (stderr) console.error(stderr.slice(-6000));
  }
  throw error;
} finally {
  releaseReasoning?.();
  releaseTool?.();
  await app?.close().catch(() => {});
  gateway.closeAllConnections();
  gateway.close();
  if (ssh) await rm(wrapper, { force: true });
  await rm(profile, { recursive: true, force: true, maxRetries: 3 });
}
