import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

const following = process.argv.includes('--following');
const grouped = process.argv.includes('--grouped-history');
const toolOutput = process.argv.includes('--tool-output');
const reasoningFollowing = process.argv.includes('--reasoning-following');
const reasoningDetails = reasoningFollowing || process.argv.includes('--reasoning-details');
const streamedReasoning = reasoningDetails || process.argv.includes('--reasoning');
const [candidate, baseline, screenshot] = process.argv.slice(2).filter(arg => !arg.startsWith('--'));
const linux = process.platform === 'linux';
const lastFragment = `追加记录 ${following ? '160' : '040'}。继续核对正在生成的结果。`;

const settleFrame = page => page.evaluate(async () => {
  await new Promise(requestAnimationFrame);
  await new Promise(requestAnimationFrame);
});

async function waitForMarker(file) {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (existsSync(file)) return;
    await delay(25);
  }
  throw Error('The fixture did not publish all fragments.');
}

async function observeDesktopDraft(app, area) {
  const origin = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getContentBounds());
  const script = fileURLToPath(new URL('./observe-draft-x11.py', import.meta.url));
  const observer = spawn('python3.9', [script, origin.x + area.x, origin.y + area.y, area.width, area.height],
    { stdio: ['pipe', 'pipe', 'inherit'] });
  await once(observer, 'spawn');
  const lines = createInterface({ input: observer.stdout });
  const replies = lines[Symbol.asyncIterator]();
  return {
    async request(command) {
      observer.stdin.write(command + '\n');
      const { value, done } = await replies.next();
      assert.ok(!done, 'The X11 draft observer exited before acknowledging ' + command);
      return JSON.parse(value);
    },
    close() {
      lines.close();
      observer.kill();
    },
  };
}

async function prepareInputSampling(app, page, composer, area, desktop) {
  await composer.evaluate(element => { element.style.caretColor = 'transparent'; });
  const pixels = async value => {
    await composer.fill(value);
    await settleFrame(page);
    const captured = await app.evaluate(async ({ BrowserWindow }, rect) => {
      const capture = await BrowserWindow.getAllWindows()[0].webContents.capturePage(rect);
      return capture.toBitmap().toString('hex');
    }, area);
    if (desktop) await desktop.request(value);
    return captured;
  };
  const inserted = await pixels('MMW');
  const removed = await pixels('MM');
  assert.ok(inserted.length && removed.length && inserted !== removed, 'Composer pixels must reflect the input.');
  await composer.press('End');
  await composer.evaluate(element => {
    element.spanInputStages = [];
    element.addEventListener('input', () => {
      const stage = { value: element.value, receivedAt: performance.timeOrigin + performance.now() };
      element.spanInputStages.push(stage);
      requestAnimationFrame(() => { stage.frameRequestedAt = performance.timeOrigin + performance.now(); });
    });
  });
  await app.evaluate(({ BrowserWindow }, rect) => {
    const contents = BrowserWindow.getAllWindows()[0].webContents;
    const state = { frames: 0, pending: null };
    globalThis.spanLongReplyInput = state;
    contents.beginFrameSubscription(false, image => {
      state.frames++;
      if (state.pending && image.crop(rect).toBitmap().equals(state.pending.pixels)) {
        state.pending.resolve(performance.now() - state.pending.start);
      }
    });
  }, area);
  const input = append => app.evaluate(({ BrowserWindow }, { append, expected }) => new Promise((resolve, reject) => {
    const contents = BrowserWindow.getAllWindows()[0].webContents;
    const state = globalThis.spanLongReplyInput;
    const timer = setTimeout(() => {
      state.pending = null;
      reject(Error('The frame observer did not see the expected draft pixels.'));
    }, 2_000);
    const start = performance.now();
    state.pending = {
      pixels: Buffer.from(expected, 'hex'),
      start,
      resolve(latency) {
        clearTimeout(timer);
        state.pending = null;
        resolve({ latency, sentAt: performance.timeOrigin + start });
      },
    };
    if (append) contents.sendInputEvent({ type: 'char', keyCode: 'W' });
    else {
      contents.sendInputEvent({ type: 'keyDown', keyCode: 'Backspace' });
      contents.sendInputEvent({ type: 'keyUp', keyCode: 'Backspace' });
    }
  }), { append, expected: append ? inserted : removed });
  // Verify both paint events and exact pixels before recording timed inputs.
  if (desktop) await desktop.request('observe');
  await input(true);
  await input(false);
  if (desktop) {
    await settleFrame(page);
    const warmup = await desktop.request('finish');
    assert.deepEqual(warmup.edits.map(edit => edit.value), ['MMW', 'MM']);
  }
  return async () => {
    const startFrames = await app.evaluate(() => globalThis.spanLongReplyInput.frames);
    await composer.evaluate(element => { element.spanInputStages.length = 0; });
    if (desktop) await desktop.request('observe');
    const samples = [];
    for (let index = 0; index < 14; index++) {
      await delay(index % 2 ? 139 : 73);
      samples.push(await input(index % 2 === 0));
    }
    const frames = await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].webContents.endFrameSubscription();
      return globalThis.spanLongReplyInput.frames;
    });
    await settleFrame(page);
    const received = await composer.evaluate(element => element.spanInputStages);
    assert.deepEqual(received.map(event => event.value), samples.map((_, index) => index % 2 ? 'MM' : 'MMW'));
    const desktopPaints = desktop && await desktop.request('finish');
    if (desktopPaints) assert.deepEqual(desktopPaints.edits.map(edit => edit.value), received.map(event => event.value));
    const stages = samples.map(({ sentAt }, index) => {
      const { receivedAt, frameRequestedAt } = received[index];
      assert.ok(Number.isFinite(frameRequestedAt), 'Each edit must reach a renderer animation frame.');
      return {
        inputMs: receivedAt - sentAt,
        animationFrameMs: frameRequestedAt - sentAt,
        desktopMs: desktopPaints ? desktopPaints.edits[index].shownAt - sentAt : undefined,
      };
    });
    const latencies = samples.map(({ latency }) => latency);
    const p95 = values => [...values].sort((a, b) => a - b)[Math.ceil(values.length * .95) - 1];
    return {
      samples: latencies, stages, p95Ms: p95(latencies),
      observedFrames: frames - startFrames, desktopCaptures: desktopPaints?.captures,
      desktopP95Ms: desktopPaints ? p95(stages.map(stage => stage.desktopMs)) : undefined,
    };
  };
}

async function checkToolOutput(app, page, composer, profile, rendererPid, label, trial) {
  await composer.fill('验证流式命令输出。');
  await composer.press('Enter');
  const command = page.getByTestId('transcript').locator('[data-card="command"]').filter({ hasText: 'workspace verify --all' });
  await command.locator('summary').press('Enter');
  const output = command.getByLabel('工具输出');
  const next = command.getByRole('button', { name: '下一段' });
  await next.press('Enter');
  await next.press('Enter');
  await output.getByText('feature_16384.rs', { exact: false }).waitFor();
  let desktop;
  try {
    let sampleInput;
    if (linux && baseline) {
      const box = await composer.boundingBox();
      const area = { x: Math.ceil(box.x), y: Math.ceil(box.y), width: 56, height: 24 };
      desktop = await observeDesktopDraft(app, area);
      sampleInput = await prepareInputSampling(app, page, composer, area, desktop);
    }
    await output.evaluate(element => { element.scrollTop = 90; });
    await settleFrame(page);
    const offsets = () => output.evaluate(element => ({
      log: element.scrollTop, conversation: element.closest('.timeline').scrollTop,
    }));
    const position = await offsets();
    assert.equal(position.log, 90);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Performance.enable');
    const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics
      .map(({ name, value }) => [name, value]));
    const pss = async () => linux ? Number((await readFile(`/proc/${rendererPid}/smaps_rollup`, 'utf8'))
      .match(/^Pss:\s+(\d+) kB$/m)[1]) : undefined;
    const startPssKiB = await pss();
    const start = await metrics();
    await writeFile(join(profile, 'append'), '');
    const [typing] = await Promise.all([sampleInput?.(), waitForMarker(join(profile, 'appended'))]);
    await delay(160);
    await settleFrame(page);
    const end = await metrics();
    const endPssKiB = await pss();
    assert.deepEqual(await offsets(), position);
    if (label === 'candidate') await command.getByText('16385–20073 行', { exact: true }).waitFor();
    await output.evaluate(element => { element.scrollTop = element.scrollHeight; });
    await output.getByText('workspace/source/stream_072.rs', { exact: false }).waitFor();
    assert.equal(await output.evaluate(element => element.tabIndex), 0);
    await writeFile(join(profile, 'finish'), '');
    await page.getByRole('button', { name: '发送', exact: true }).waitFor();
    await output.getByText('workspace/source/stream_072.rs', { exact: false }).waitFor();
    if (screenshot && trial === 0) {
      await settleFrame(page);
      await page.screenshot({ path: `${screenshot}-${label}.png` });
    }
    return { label, startPssKiB, endPssKiB, typing,
      rendererCpuMs: (end.ProcessTime - start.ProcessTime) * 1000,
      mainThreadCpuMs: (end.ThreadTime - start.ThreadTime) * 1000,
      scriptMs: (end.ScriptDuration - start.ScriptDuration) * 1000 };
  } finally {
    desktop?.close();
  }
}

async function checkReasoning(app, page, composer, transcript, profile, rendererPid, label, trial) {
  const goalText = '核对 Windows 与 EL8 的会话状态和历史阅读位置';
  await composer.fill('/goal ' + goalText);
  await composer.press('Enter');
  const goal = page.locator('.goal-strip');
  await goal.getByText(goalText).waitFor();
  await composer.fill('验证高频推理摘要。');
  await composer.press('Enter');
  const strip = page.getByRole('button', { name: '实时推理摘要' });
  const lastBatch = '步骤 072';
  await strip.getByText('开始复核长会话。').waitFor();
  const panel = page.getByRole('region', { name: '推理摘要' });
  const detail = reasoningDetails ? panel.locator('.agent-panel-content') : null;
  const heading = panel.getByRole('heading', { name: '复核顺序' });
  let detailPosition;
  let initialHeading;
  const revealBottom = () => page.waitForFunction(() => {
    const region = document.querySelector('#reasoning-panel .agent-panel-content');
    return region.scrollHeight - region.clientHeight - region.scrollTop <= 2;
  });
  if (detail) {
    await strip.press('Enter');
    await heading.waitFor();
    await panel.locator('ul ul').getByText('保留两级缩进', { exact: true }).waitFor();
    detailPosition = await heading.boundingBox();
    if (reasoningFollowing) {
      initialHeading = await heading.elementHandle();
      await detail.evaluate(element => { element.scrollTop = element.scrollHeight; });
      await revealBottom();
    }
  }
  let desktop;
  try {
    let sampleInput;
    if (linux && baseline) {
      const box = await composer.boundingBox();
      const area = { x: Math.ceil(box.x), y: Math.ceil(box.y), width: 56, height: 24 };
      desktop = await observeDesktopDraft(app, area);
      sampleInput = await prepareInputSampling(app, page, composer, area, desktop);
    }
    // The fixed strip changes the timeline height. Let its resize observer
    // settle before leaving the bottom to inspect an older message.
    await settleFrame(page);
    await transcript.evaluate(element => {
      element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight - 640);
    });
    const latest = page.getByRole('button', { name: '滚到最新消息' });
    await latest.waitFor();
    await settleFrame(page);
    const position = () => transcript.evaluate(element => element.scrollTop);
    const before = await position();
    const geometry = await strip.boundingBox();
    assert.ok(geometry);
    const mutating = await strip.evaluateHandle(element => {
      const preview = element.querySelector('bdi');
      const seen = new Set();
      const observer = new MutationObserver(() => seen.add(preview.textContent));
      observer.observe(preview, { subtree: true, childList: true, characterData: true });
      return () => {
        observer.disconnect();
        return { connected: element.isConnected, updates: seen.size };
      };
    });
    const detailMutations = await detail?.evaluateHandle(element => {
      let mutations = 0;
      const observer = new MutationObserver(() => { mutations++; });
      observer.observe(element.querySelector('.prose'), { subtree: true, childList: true, characterData: true });
      return () => {
        observer.disconnect();
        return mutations;
      };
    });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Performance.enable');
    const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics
      .map(({ name, value }) => [name, value]));
    const pss = async () => linux ? Number((await readFile(`/proc/${rendererPid}/smaps_rollup`, 'utf8'))
      .match(/^Pss:\s+(\d+) kB$/m)[1]) : undefined;
    const startPssKiB = await pss();
    const start = await metrics();
    await writeFile(join(profile, 'append'), '');
    const [typing] = await Promise.all([sampleInput?.(), waitForMarker(join(profile, 'appended'))]);
    await strip.getByText(lastBatch, { exact: false }).waitFor();
    if (reasoningFollowing) {
      await panel.getByText(lastBatch, { exact: false }).waitFor();
      await revealBottom();
    }
    await settleFrame(page);
    const end = await metrics();
    const endPssKiB = await pss();
    const { connected, updates } = await mutating.evaluate(read => read());
    await mutating.dispose();
    const bodyUpdates = await detailMutations?.evaluate(read => read());
    await detailMutations?.dispose();
    assert.ok(connected && updates >= 20, `Only ${updates} updates reached the original strip.`);
    assert.equal(await position(), before);
    assert.deepEqual(await strip.boundingBox(), geometry);
    assert.ok(await goal.evaluate(element => {
      const goal = element.getBoundingClientRect();
      const strip = element.previousElementSibling.getBoundingClientRect();
      const composer = element.nextElementSibling.getBoundingClientRect();
      return strip.bottom < goal.top && goal.bottom < composer.top && strip.x === goal.x && goal.x === composer.x
        && strip.width === goal.width && goal.width === composer.width;
    }));
    if (screenshot && trial === 0) await page.screenshot({ path: `${screenshot}-${label}.png` });

    if (detail) {
      if (reasoningFollowing) {
        assert.ok(bodyUpdates >= 15, 'The summary should continue to refresh while following.');
        assert.ok(await initialHeading.evaluate(element => element.isConnected));
        await initialHeading.dispose();
      } else {
        assert.deepEqual(await heading.boundingBox(), detailPosition);
        assert.equal(await detail.evaluate(element => element.scrollTop), 0);
        if (label === 'candidate') assert.equal(bodyUpdates, 0);
        else assert.ok(bodyUpdates > 0, 'The baseline must render updates below the viewport.');
        await detail.evaluate(element => { element.scrollTop = element.scrollHeight; });
        await panel.getByText(lastBatch, { exact: false }).waitFor();
      }
      if (label === 'candidate') await revealBottom();
      await writeFile(join(profile, 'follow-detail'), '');
      await panel.getByText('步骤 073', { exact: false }).waitFor();
      if (label === 'candidate') await revealBottom();
      if (screenshot && trial === 0) await page.screenshot({ path: `${screenshot}-${label}-tail.png` });
    }
    let archived = detail ? '步骤 073' : lastBatch;
    if (reasoningFollowing) {
      await writeFile(join(profile, 'reference-prefix'), '');
      await panel.getByText('[迟到引用]', { exact: true }).waitFor();
      await writeFile(join(profile, 'reference-definition'), '');
      const link = panel.getByRole('link', { name: '迟到引用', exact: true });
      await link.waitFor();
      assert.equal(await link.getAttribute('href'), 'https://example.com/span/reference');
      archived = '引用检查完成。';
    }
    await writeFile(join(profile, 'finish'), '');
    await strip.waitFor({ state: 'detached' });
    if (detail) await detail.waitFor({ state: 'detached' });
    await latest.click();
    await transcript.locator('[data-card="reasoning"]').getByText(archived, { exact: false }).waitFor();
    return { label, updates, bodyUpdates, startPssKiB, endPssKiB, typing,
      rendererCpuMs: (end.ProcessTime - start.ProcessTime) * 1000,
      mainThreadCpuMs: (end.ThreadTime - start.ThreadTime) * 1000,
      scriptMs: (end.ScriptDuration - start.ScriptDuration) * 1000 };
  } finally {
    desktop?.close();
  }
}

async function check(binary, label, trial) {
  const profile = await mkdtemp(join(tmpdir(), 'span-long-reply-'));
  let app;
  let desktop;
  try {
    if (following) await writeFile(join(profile, 'fast'), '');
    if (grouped) await writeFile(join(profile, 'grouped-history'), '');
    if (reasoningDetails) await writeFile(join(profile, reasoningFollowing ? 'reasoning-following' : 'reasoning-details'), '');
    app = await electron.launch({
      executablePath: binary,
      args: ['--demo', '--force-device-scale-factor=1',
        ...(linux ? ['--no-sandbox', '--disable-gpu', '--disable-webgl'] : [])],
      env: { ...process.env, SPAN_PREVIEW_PROFILE: profile, SPAN_PREVIEW_STREAM_GATE: profile },
    });
    const page = await app.firstWindow();
    const size = streamedReasoning ? [740, 520] : [800, 640];
    const rendererPid = await app.evaluate(({ BrowserWindow }, [width, height]) => {
      const window = BrowserWindow.getAllWindows()[0];
      window.setContentSize(width, height);
      return window.webContents.getOSProcessId();
    }, size);
    await page.waitForFunction(([width, height]) => innerWidth === width && innerHeight === height, size);
    const composer = page.getByRole('textbox', { name: '消息' });
    const transcript = page.getByTestId('transcript');
    await transcript.getByText('第 160 项', { exact: false }).waitFor();
    if (toolOutput) return await checkToolOutput(app, page, composer, profile, rendererPid, label, trial);
    if (streamedReasoning) return await checkReasoning(app, page, composer, transcript, profile, rendererPid, label, trial);
    if (grouped) {
      assert.equal(await transcript.getAttribute('data-items'), '2901');
      const group = transcript.getByRole('button', { name: '6 条命令', exact: true }).last();
      await group.press('Enter');
      await transcript.getByText('workspace verify --record 160-143', { exact: true }).waitFor();
    }
    await composer.fill('验证长回复末尾。');
    await composer.press('Enter');
    const heading = transcript.getByRole('heading', { name: '长回复的开头', exact: true });
    const initialTail = transcript.getByRole('heading', { name: '预置正文末尾', exact: true });
    const latest = page.getByRole('button', { name: '滚到最新消息' });
    const tailInView = () => page.waitForFunction(() => {
      const timeline = document.querySelector('.timeline');
      return timeline.scrollHeight - timeline.clientHeight - timeline.scrollTop <= 2;
    });
    await initialTail.waitFor();
    await tailInView();
    let sampleInput;
    if (linux && baseline) {
      const box = await composer.boundingBox();
      const area = { x: Math.ceil(box.x), y: Math.ceil(box.y), width: 56, height: 24 };
      if (following || grouped) desktop = await observeDesktopDraft(app, area);
      sampleInput = await prepareInputSampling(app, page, composer, area, desktop);
    }
    await settleFrame(page);
    const headingOffset = () => heading.evaluate(element =>
      element.getBoundingClientRect().top - element.closest('.timeline').getBoundingClientRect().top);
    let position;
    if (!following) {
      await heading.evaluate(async element => {
        const timeline = element.closest('.timeline');
        // The first scroll can mount nearby rows and change their estimated heights.
        let stableFrames = 0;
        for (let frame = 0; frame < 30; frame++) {
          const offset = element.getBoundingClientRect().top - timeline.getBoundingClientRect().top;
          if (Math.abs(offset - 28) <= 2) {
            if (++stableFrames === 3) return;
          } else {
            stableFrames = 0;
            timeline.scrollTop += offset - 28;
          }
          await new Promise(requestAnimationFrame);
        }
        throw new Error('Could not settle the initial reading position.');
      });
      await latest.waitFor();
      position = await headingOffset();
      assert.ok(Math.abs(position - 28) <= 2, `Expected to start reading the reply at 28 pixels, observed ${position}.`);
    }

    const observation = await heading.evaluateHandle(element => {
      const parent = element.closest('.prose');
      let mutationBatches = 0;
      let lastBatch;
      let maxBatchGapMs = 0;
      const observer = new MutationObserver(() => {
        mutationBatches++;
        const now = performance.now();
        if (lastBatch !== undefined) maxBatchGapMs = Math.max(maxBatchGapMs, now - lastBatch);
        lastBatch = now;
      });
      observer.observe(parent, { childList: true, subtree: true, characterData: true });
      return () => { observer.disconnect(); return { mutationBatches, maxBatchGapMs }; };
    });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Performance.enable');
    const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics
      .map(({ name, value }) => [name, value]));
    const pss = async () => linux ? Number((await readFile(`/proc/${rendererPid}/smaps_rollup`, 'utf8'))
      .match(/^Pss:\s+(\d+) kB$/m)[1]) : undefined;
    const startPssKiB = await pss();
    const start = await metrics();
    const fragment = transcript.getByText(lastFragment, { exact: true });
    await writeFile(join(profile, 'append'), '');
    const [typing] = await Promise.all([sampleInput?.(), waitForMarker(join(profile, 'appended'))]);
    if (following) {
      await fragment.waitFor();
      await tailInView();
    }
    await settleFrame(page);
    const end = await metrics();
    const endPssKiB = await pss();
    const { mutationBatches, maxBatchGapMs } = await observation.evaluate(read => read());
    await observation.dispose();
    if (typing) assert.equal(await composer.inputValue(), 'MM');
    if (following) {
      assert.ok(mutationBatches >= 10, `Only ${mutationBatches} updates reached the viewport.`);
      if (label === 'candidate') assert.ok(mutationBatches <= 70 && maxBatchGapMs < 350,
        `Unexpected visible rendering cadence: ${mutationBatches} updates, gap ${maxBatchGapMs} ms.`);
    } else {
      const offset = await headingOffset();
      assert.ok(Math.abs(offset - position) <= 2, `Reading anchor moved from ${position} to ${offset}.`);
      if (grouped) {
        await latest.click();
        await tailInView();
        await transcript.getByText('workspace verify --live 40', { exact: true }).waitFor();
      } else if (label === 'baseline') assert.ok(mutationBatches > 0);
      else {
        assert.equal(mutationBatches, 0);
        assert.equal(await fragment.count(), 0);
      }
      if (!grouped) {
        await initialTail.evaluate(element => {
          const timeline = element.closest('.timeline');
          timeline.scrollTop += element.getBoundingClientRect().bottom - timeline.getBoundingClientRect().bottom - 74;
        });
        await fragment.waitFor();
        await latest.click();
        await tailInView();
      }
    }

    if (!grouped) assert.ok(await fragment.evaluate(element => {
      const text = element.getBoundingClientRect();
      const viewport = element.closest('.timeline').getBoundingClientRect();
      return text.top >= viewport.top && text.bottom <= viewport.bottom;
    }));
    await writeFile(join(profile, 'finish'), '');
    await transcript.getByText('长回复已全部生成。', { exact: true }).waitFor();
    if (grouped) {
      const group = transcript.getByRole('button', { name: '40 条命令', exact: true });
      await group.waitFor();
      await tailInView();
      assert.equal(await group.getAttribute('aria-expanded'), 'false');
      if (screenshot) await page.screenshot({ path: `${screenshot}-${label}-${trial}.png` });
    }
    if (following) {
      await tailInView();
      assert.equal(await transcript.getByRole('link', { name: '后补引用' }).getAttribute('href'),
        'https://example.com/span/reference');
    }
    const link = transcript.getByRole('link', { name: '复核链接' });
    assert.equal(await link.getAttribute('href'), 'https://example.com/span');
    assert.equal(await link.evaluate(element => {
      const selection = element.ownerDocument.getSelection();
      selection.selectAllChildren(element);
      return selection.toString();
    }), '复核链接');
    return { label, following, grouped, mutationBatches, maxBatchGapMs, startPssKiB, endPssKiB, typing,
      rendererCpuMs: (end.ProcessTime - start.ProcessTime) * 1000,
      mainThreadCpuMs: (end.ThreadTime - start.ThreadTime) * 1000,
      scriptMs: (end.ScriptDuration - start.ScriptDuration) * 1000,
      layouts: end.LayoutCount - start.LayoutCount };
  } finally {
    desktop?.close();
    await app?.close();
    await rm(profile, { recursive: true, force: true, maxRetries: 3 });
  }
}

const trials = [];
const alternate = grouped || toolOutput || streamedReasoning;
for (let trial = 0; trial < (baseline ? 2 : 1); trial++) {
  if (baseline && (!alternate || trial === 0)) trials.push(await check(baseline, 'baseline', trial));
  trials.push(await check(candidate, 'candidate', trial));
  if (baseline && alternate && trial === 1) trials.push(await check(baseline, 'baseline', trial));
}
const scenario = toolOutput ? 'tool-output' : reasoningFollowing ? 'reasoning-following' :
  reasoningDetails ? 'reasoning-details' : streamedReasoning ? 'reasoning' : undefined;
console.log(JSON.stringify({ platform: process.platform, scenario, trials }, null, 2));
