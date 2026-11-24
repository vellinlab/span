import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron } from 'playwright';

const [binary, piPath, screenshot, ssh] = process.argv.slice(2);
const profile = await mkdtemp(join(tmpdir(), 'span-pi-preview-'));
const state = process.env.SPAN_TEST_PI_STATE ?? join(profile, "Pi's state");
const prompts = [];
const initialPrompt = '核对 Pi 的推理、工具与用量。';
const resumePrompt = '继续刚才保存的 Pi 会话。';
const firstAnswer = 'Pi 已完成工作台验收。';
let releaseReasoning;
const gateway = createServer(async (request, response) => {
  try {
    assert.equal(request.url, '/v1/chat/completions');
    let body = '';
    for await (const chunk of request) body += chunk;
    const { messages, model } = JSON.parse(body);
    assert.equal(model, 'span-pi');
    const userMessages = messages.filter(message => message.role === 'user');
    const prompt = JSON.stringify(userMessages.at(-1)?.content);
    const tool = messages.findLast(message => message.role === 'tool');
    const initial = prompt.includes(initialPrompt);
    assert.ok(initial || prompt.includes(resumePrompt));
    if (!initial) assert.ok(messages.some(message => message.role === 'assistant' &&
      JSON.stringify(message.content).includes(firstAnswer)));
    if (tool) assert.ok(JSON.stringify(tool.content).includes('pi tool result'));
    prompts.push({ initial, tool: Boolean(tool) });
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (delta, finish_reason = null, usage = undefined) => {
      const choices = [{ index: 0, delta, finish_reason }];
      response.write('data: ' + JSON.stringify({
        id: 'span-fixture-' + prompts.length, model, created: 1, object: 'chat.completion.chunk', choices, usage,
      }) + '\n\n');
    };
    send({ role: 'assistant' });
    if (initial && !tool) {
      send({ reasoning_content: '先核对 Pi 会话。' });
      await new Promise(done => { releaseReasoning = done; });
      send({ reasoning_content: '\n再核对工具和用量。' });
      send({ tool_calls: [{ index: 0, id: 'span-tool', type: 'function',
        function: { name: 'bash', arguments: JSON.stringify({ command: 'echo pi tool result' }) } }] });
      send({}, 'tool_calls', { prompt_tokens: 20, completion_tokens: 9, total_tokens: 29 });
    } else {
      send({ content: initial ? firstAnswer : 'Pi 已恢复原会话。' });
      send({}, 'stop', { prompt_tokens: 20, completion_tokens: 9, total_tokens: 29 });
    }
    response.end('data: [DONE]\n\n');
  } catch (error) {
    console.error(error);
    if (!response.headersSent) response.writeHead(400);
    response.end(String(error.message));
  }
});

let app;
gateway.listen(0, '127.0.0.1');
await once(gateway, 'listening');
try {
  await mkdir(join(state, 'extensions'), { recursive: true });
  await writeFile(join(state, 'settings.json'), JSON.stringify({
    defaultProvider: 'span-preview', defaultModel: 'span-pi', defaultThinkingLevel: 'medium',
  }));
  await writeFile(join(state, 'models.json'), JSON.stringify({
    providers: { 'span-preview': {
      baseUrl: 'http://127.0.0.1:' + gateway.address().port + '/v1',
      api: 'openai-completions', apiKey: 'span-test',
      models: [{ id: 'span-pi', name: 'Span Pi', reasoning: true, input: ['text'] }],
    } },
  }));
  await writeFile(join(state, 'extensions', 'span-form.ts'), `
export default function (pi) {
  pi.registerCommand('span-form', {
    description: '打开工作台验收表单',
    async handler(_args, ctx) {
      const confirmed = await ctx.ui.confirm('核对 Pi 操作', '只在这个测试会话显示表单。');
      if (!confirmed) return;
      const answer = await ctx.ui.editor('编辑 Pi 说明', '第一行\\n第二行');
      ctx.ui.notify(answer === undefined ? 'Pi 表单已取消。' : 'Pi 答案：' + answer, 'info');
    },
  });
}
`);
  if (ssh) execFileSync('chown', ['-R', 'span-preview-ci:span-preview-ci', state]);

  async function open() {
    app = await electron.launch({
      executablePath: binary,
      args: ['--no-sandbox', '--disable-gpu'],
      env: { ...process.env, SPAN_PREVIEW_PROFILE: profile, SPAN_PI_PATH: resolve(piPath), PI_CODING_AGENT_DIR: state },
    });
    const page = await app.firstWindow();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.getByRole('button', { name: '主机', exact: true }).click();
    if (ssh) await page.getByLabel('SSH 目标').fill(ssh);
    await page.getByLabel('Agent 后端').selectOption('pi');
    await page.getByRole('button', { name: ssh ? '连接 SSH' : '连接本机', exact: true }).click();
    const connected = page.locator('.connection[data-route="stdio"]').filter({
      hasText: ssh ? 'Pi · ' + ssh : 'Pi · 本机', has: page.locator('i.ready'),
    });
    await connected.waitFor({ timeout: 30_000 });
    assert.deepEqual(errors, []);
    return { page, errors };
  }
  const first = await open();
  const page = first.page;
  const composer = page.getByRole('textbox', { name: '消息' });
  const send = async text => { await composer.fill(text); await composer.press('Enter'); };
  const transcript = page.getByTestId('transcript');
  await send(initialPrompt);
  const reasoning = page.getByRole('button', { name: '实时推理摘要' });
  await reasoning.getByText('先核对 Pi 会话。', { exact: true }).waitFor();
  if (screenshot) await page.screenshot({ path: screenshot.replace(/\.png$/, '-reasoning.png') });
  releaseReasoning();
  await transcript.getByText(firstAnswer, { exact: true }).waitFor();
  await page.getByRole('button', { name: '发送', exact: true }).waitFor();
  assert.equal(await reasoning.count(), 0);
  assert.equal(await transcript.getByText(initialPrompt, { exact: true }).count(), 1);
  const tool = transcript.locator('[data-card="command"]').filter({ hasText: 'echo pi tool result' });
  await tool.locator('summary').click();
  await tool.getByText('pi tool result', { exact: true }).waitFor();
  await send('/usage');
  const usage = page.getByRole('region', { name: '用量' });
  await usage.getByText('总计', { exact: true }).waitFor();
  await usage.getByRole('button', { name: '关闭面板' }).click();
  await send('/span-form');
  const confirm = page.getByRole('region', { name: '核对 Pi 操作' });
  await confirm.getByRole('button', { name: '确认', exact: true }).click();
  const editor = page.getByRole('region', { name: '编辑 Pi 说明' });
  const answer = editor.getByRole('textbox', { name: '回答' });
  assert.equal(await answer.inputValue(), '第一行\n第二行');
  await editor.getByRole('button', { name: '取消' }).click();
  await transcript.getByText('Pi 表单已取消。', { exact: true }).waitFor();
  await page.getByRole('button', { name: '发送', exact: true }).waitFor();
  await send('/rename Pi 原生会话验收');
  await page.locator('.breadcrumb strong').getByText('Pi 原生会话验收', { exact: true }).waitFor();
  if (screenshot) await page.screenshot({ path: screenshot });
  assert.deepEqual(first.errors, []);
  await app.close();
  app = undefined;

  const resumed = await open();
  await resumed.page.getByTestId('session-catalog').getByRole('treeitem', { name: 'Pi 原生会话验收' })
    .or(resumed.page.getByTestId('session-catalog').getByRole('treeitem', { name: initialPrompt })).click();
  await resumed.page.getByTestId('transcript').getByText(firstAnswer, { exact: true }).waitFor();
  const editorAfterRestart = resumed.page.getByRole('textbox', { name: '消息' });
  await editorAfterRestart.fill(resumePrompt);
  await editorAfterRestart.press('Enter');
  await resumed.page.getByTestId('transcript').getByText('Pi 已恢复原会话。', { exact: true }).waitFor();
  assert.deepEqual(prompts.map(entry => entry.initial), [true, true, false]);
  assert.deepEqual(resumed.errors, []);
  console.log('Verified real Pi streaming, tools, native extension dialogs, usage, and persisted resume on ' + (ssh ?? process.platform));
} finally {
  releaseReasoning?.();
  gateway.closeAllConnections();
  gateway.close();
  await app?.close();
  await rm(profile, { recursive: true, force: true, maxRetries: 3 });
}
