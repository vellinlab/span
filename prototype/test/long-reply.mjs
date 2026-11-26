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
import { captureWindowDesktop, dragWindowEdge } from './window-edge.mjs';

const following = process.argv.includes('--following');
const grouped = process.argv.includes('--grouped-history');
const toolOutput = process.argv.includes('--tool-output');
const reasoningFollowing = process.argv.includes('--reasoning-following');
const reasoningIndex = process.argv.includes('--reasoning-index');
const reasoningDetails = reasoningIndex || reasoningFollowing || process.argv.includes('--reasoning-details');
const streamedReasoning = reasoningDetails || process.argv.includes('--reasoning');
const [candidate, baseline, screenshot] = process.argv.slice(2).filter(arg => !arg.startsWith('--'));
const linux = process.platform === 'linux';
const deviceScaleFactor = Number(process.env.SPAN_TEST_DEVICE_SCALE ?? 1);
const lastFragment = `追加记录 ${following ? '160' : '040'}。继续核对正在生成的结果。`;

const settleFrame = page => page.evaluate(async () => {
  await new Promise(requestAnimationFrame);
  await new Promise(requestAnimationFrame);
});

function placeInTimeline(locator, inset, edge = 'top') {
  return locator.evaluate(async (element, { inset, edge }) => {
    const timeline = element.closest('.timeline');
    // Nearby rows can mount and replace their estimated heights after the first scroll.
    let stableFrames = 0;
    for (let frame = 0; frame < 30; frame++) {
      const row = element.getBoundingClientRect();
      const viewport = timeline.getBoundingClientRect();
      const offset = edge === 'bottom' ? viewport.bottom - row.bottom : row.top - viewport.top;
      const delta = offset - inset;
      if (Math.abs(delta) <= 2) {
        if (++stableFrames === 3) return;
      } else {
        stableFrames = 0;
        timeline.scrollTop += edge === 'bottom' ? -delta : delta;
      }
      await new Promise(requestAnimationFrame);
    }
    throw new Error(`Could not position the row ${inset}px from the ${edge} of the timeline.`);
  }, { inset, edge });
}

async function checkSidebarReflow(app, page, transcript, latest, tailInView) {
  const size = [880, 640];
  await app.evaluate(({ BrowserWindow }, [width, height]) => BrowserWindow.getAllWindows()[0].setContentSize(width, height), size);
  await page.waitForFunction(([width, height]) => innerWidth === width && innerHeight === height, size);
  const passage = transcript.getByText('第 080 项。', { exact: true }).locator('..');
  await placeInTimeline(passage, 8);
  await latest.waitFor();
  const measure = () => passage.evaluate(element => {
    const bounds = element.getBoundingClientRect();
    return { top: bounds.top - element.closest('.timeline').getBoundingClientRect().top, height: bounds.height };
  });
  const before = await measure();
  if (screenshot) await page.screenshot({ path: `${screenshot}-sidebar-reading-before.png` });
  const grip = page.getByRole('separator', { name: '调整侧栏宽度' });
  const maximum = Number(await grip.getAttribute('aria-valuemax'));
  const current = Number(await grip.getAttribute('aria-valuenow'));
  const bounds = await grip.boundingBox();
  const x = bounds.x + bounds.width / 2;
  const y = bounds.y + bounds.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + maximum - current, y, { steps: 8 });
  await settleFrame(page);
  const dragging = await measure();
  await page.mouse.up();
  await settleFrame(page);
  const resized = await measure();
  assert.equal(Number(await grip.getAttribute('aria-valuenow')), maximum);
  assert.ok(resized.height > before.height, 'The paragraph must wrap onto another line.');
  assert.ok([dragging, resized].every(({ top }) => Math.abs(top - before.top) <= 2),
    `The paragraph moved during sidebar reflow: ${before.top}, ${dragging.top}, ${resized.top}.`);
  if (screenshot) await page.screenshot({ path: `${screenshot}-sidebar-reading-after.png` });
  await grip.press('Home');
  await settleFrame(page);
  assert.ok(Math.abs((await measure()).top - before.top) <= 2, 'Keyboard resizing should keep the same paragraph in place.');
  await latest.click();
  await tailInView();
  await grip.press('End');
  await settleFrame(page);
  await tailInView();
  const answer = transcript.getByText('长回复已全部生成。', { exact: true });
  assert.ok(await answer.evaluate(element => {
    const text = element.getBoundingClientRect();
    const viewport = element.closest('.timeline').getBoundingClientRect();
    return text.top >= viewport.top && text.bottom <= viewport.bottom;
  }), 'Resizing while following should keep the final text visible.');
}

async function checkWindowReflow(app, page, transcript, latest, tailInView) {
  const setWidth = async width => {
    await app.evaluate(({ BrowserWindow }, width) => {
      const window = BrowserWindow.getAllWindows()[0];
      window.setPosition(20, 20);
      window.setContentSize(width, 640);
      window.focus();
    }, width);
    await page.waitForFunction(width => innerWidth === width && innerHeight === 640, width);
  };
  const passage = transcript.getByText('第 080 项。', { exact: true }).locator('..');
  const measure = () => passage.evaluate(element => {
    const bounds = element.getBoundingClientRect();
    return { top: bounds.top - element.closest('.timeline').getBoundingClientRect().top,
      height: bounds.height, width: bounds.width, left: bounds.left };
  });
  const resize = async distance => {
    const width = await page.evaluate(() => innerWidth);
    const expected = Math.max(740, width + distance);
    const started = Date.now();
    const [handle] = await Promise.all([
      page.waitForFunction(target => Math.abs(innerWidth - target) <= 4 &&
        { width: innerWidth, at: Date.now() }, expected, { timeout: 8000 }),
      dragWindowEdge(app, distance),
    ]);
    const geometry = await handle.jsonValue();
    await handle.dispose();
    await settleFrame(page);
    return { width: await page.evaluate(() => innerWidth), geometryMs: geometry.at - started, started };
  };
  const capture = async (name, timing) => {
    if (screenshot) await captureWindowDesktop(app, `${screenshot}-window-${name}.png`);
    if (timing) return { width: timing.width, geometryMs: timing.geometryMs,
      desktopCaptureMs: screenshot ? Date.now() - timing.started : undefined };
  };

  await setWidth(880);
  await placeInTimeline(passage, 8);
  await latest.waitFor();
  const before = await measure();
  await capture('wide');
  const narrowTiming = await resize(-145);
  const narrow = await measure();
  assert.ok(narrow.height > before.height && narrow.width < before.width, 'The window resize must wrap the text.');
  assert.ok(Math.abs(narrow.top - before.top) <= 2, `The paragraph moved during window reflow: ${before.top} -> ${narrow.top}.`);
  const reflow = await capture('narrow', narrowTiming);
  await resize(140);
  assert.ok(Math.abs((await measure()).top - before.top) <= 2, 'Widening the window should keep the same paragraph visible.');

  const foldSidebar = page.getByRole('button', { name: '收起侧栏', exact: true });
  await foldSidebar.click();
  await setWidth(960);
  await placeInTimeline(passage, 8);
  const centerBefore = await measure();
  const centerTiming = await resize(-80);
  const centerAfter = await measure();
  assert.equal(centerAfter.width, centerBefore.width);
  assert.equal(centerAfter.height, centerBefore.height);
  assert.notEqual(centerAfter.left, centerBefore.left);
  assert.ok(Math.abs(centerAfter.top - centerBefore.top) <= 2, 'Recentering the reading column should preserve its offset.');
  const centered = await capture('centered', centerTiming);
  await page.getByRole('button', { name: '展开侧栏', exact: true }).click();

  await latest.click();
  await tailInView();
  await resize(-145);
  await tailInView();
  assert.ok(await transcript.getByText('长回复已全部生成。', { exact: true }).evaluate(element => {
    const text = element.getBoundingClientRect();
    const viewport = element.closest('.timeline').getBoundingClientRect();
    return text.top >= viewport.top && text.bottom <= viewport.bottom;
  }), 'Resizing the window while following should keep the final text visible.');

  await setWidth(1120);
  await placeInTimeline(passage, 8);
  await latest.waitFor();
  const beforePreview = await measure();
  await page.getByRole('button', { name: '文件', exact: true }).click();
  const openPreview = () => page.getByRole('button', { name: 'README.md', exact: true }).click();
  const preview = page.getByRole('complementary', { name: '文件预览' });
  const closePreview = () => preview.getByRole('button', { name: '关闭预览' }).click();
  await openPreview();
  await preview.getByText('Span 工作台预览', { exact: true }).waitFor();
  await settleFrame(page);
  const besidePreview = await measure();
  assert.ok(besidePreview.width < beforePreview.width && besidePreview.height > beforePreview.height,
    'The split preview must cause the conversation text to wrap.');
  assert.ok(Math.abs(besidePreview.top - beforePreview.top) <= 2,
    `The paragraph moved beside the file preview: ${beforePreview.top} -> ${besidePreview.top}.`);
  console.log(`Split preview reflow at a fixed window width: ${beforePreview.width} → ${besidePreview.width} CSS px.`);
  if (screenshot) await page.screenshot({ path: `${screenshot}-split-preview-reading.png` });
  await closePreview();
  await settleFrame(page);
  assert.ok(Math.abs((await measure()).top - beforePreview.top) <= 2, 'Closing the preview must restore the reading width without a jump.');
  await latest.click();
  await tailInView();
  await openPreview();
  await preview.waitFor();
  await tailInView();
  await closePreview();
  await tailInView();
  await page.getByRole('button', { name: '会话', exact: true }).click();
  return { reflow, centered };
}

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
  const summary = command.locator('summary');
  await summary.waitFor();
  const output = command.getByLabel('工具输出');
  const next = command.getByRole('button', { name: '下一段' });
  await settleFrame(page);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics
    .map(({ name, value }) => [name, value]));
  const readPage = async (button, marker) => {
    const start = await metrics();
    await button.press('Enter');
    await output.getByText(marker, { exact: false }).waitFor();
    await settleFrame(page);
    const end = await metrics();
    return {
      mainThreadCpuMs: (end.ThreadTime - start.ThreadTime) * 1000,
      scriptMs: (end.ScriptDuration - start.ScriptDuration) * 1000,
    };
  };
  const openPage = await readPage(summary, 'feature_00001.rs');
  const nextPages = [await readPage(next, 'feature_08192.rs'), await readPage(next, 'feature_16384.rs')];
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
    await command.getByText('16385–20073 行', { exact: true }).waitFor();
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
    return { label, openPage, nextPages, startPssKiB, endPssKiB, typing,
      rendererCpuMs: (end.ProcessTime - start.ProcessTime) * 1000,
      mainThreadCpuMs: (end.ThreadTime - start.ThreadTime) * 1000,
      scriptMs: (end.ScriptDuration - start.ScriptDuration) * 1000 };
  } finally {
    desktop?.close();
  }
}

async function checkReasoning(app, page, composer, transcript, profile, rendererPid, label, trial) {
  const deferredDetails = label === 'candidate' || reasoningIndex;
  const keepsArchive = label === 'candidate' || reasoningIndex;
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
    if (reasoningIndex) {
      await panel.getByRole('heading', { name: '已核对记录 8', exact: true }).waitFor();
      await panel.getByText('开始复核长会话。', { exact: true }).waitFor();
    }
    detailPosition = await heading.boundingBox();
    if (deferredDetails) {
      const bounds = await detail.boundingBox();
      assert.ok(detailPosition.y - bounds.y >= 8 && detailPosition.y - bounds.y <= 14,
        'The first heading should start just inside the summary viewport.');
    }
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
    const draft = !sampleInput && '推理更新期间保留的草稿';
    if (draft) {
      await composer.fill(draft);
      await composer.press('End');
      await composer.press('Shift+ArrowLeft');
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
    const detailMutations = await detail?.locator('.prose').last().evaluateHandle(element => {
      let mutations = 0;
      const observer = new MutationObserver(() => { mutations++; });
      observer.observe(element, { subtree: true, childList: true, characterData: true });
      return () => {
        observer.disconnect();
        return mutations;
      };
    });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Performance.enable');
    const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics
      .map(({ name, value }) => [name, value]));
    const processMemory = async () => {
      if (!linux) return;
      const memory = await readFile(`/proc/${rendererPid}/smaps_rollup`, 'utf8');
      const kib = field => Number(memory.match(new RegExp(`^${field}:\\s+(\\d+)`, 'm'))[1]);
      return { pssKiB: kib('Pss'), rssKiB: kib('Rss'), privateDirtyKiB: kib('Private_Dirty') };
    };
    const memorySample = (process, performance) => ({
      ...process, usedHeapBytes: performance.JSHeapUsedSize, domNodes: performance.Nodes,
    });
    const startMemory = await processMemory();
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
    const endMemory = await processMemory();
    let diagnosticMemory;
    if (linux && reasoningIndex) {
      await cdp.send('HeapProfiler.collectGarbage');
      await settleFrame(page);
      diagnosticMemory = {
        before: memorySample(startMemory, start),
        after: memorySample(endMemory, end),
        afterGc: memorySample(await processMemory(), await metrics()),
      };
    }
    const { connected, updates } = await mutating.evaluate(read => read());
    await mutating.dispose();
    const bodyUpdates = await detailMutations?.evaluate(read => read());
    await detailMutations?.dispose();
    assert.ok(connected && updates >= 20, `Only ${updates} updates reached the original strip.`);
    assert.equal(await position(), before);
    assert.deepEqual(await strip.boundingBox(), geometry);
    if (draft) assert.deepEqual(await composer.evaluate(element => ({
      value: element.value, focused: element === document.activeElement,
      start: element.selectionStart, end: element.selectionEnd,
    })), { value: draft, focused: true, start: draft.length - 1, end: draft.length });
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
        if (deferredDetails) assert.equal(bodyUpdates, 0);
        else assert.ok(bodyUpdates > 0, 'The baseline must render updates below the viewport.');
        await detail.evaluate(element => { element.scrollTop = element.scrollHeight; });
        await panel.getByText(lastBatch, { exact: false }).waitFor();
      }
      if (deferredDetails) await revealBottom();
      await writeFile(join(profile, 'follow-detail'), '');
      if (reasoningFollowing) {
        if (label === 'candidate') {
          await panel.locator('ol > li').filter({ hasText: /^\s*$/ }).waitFor({ state: 'attached' });
          await strip.getByText(lastBatch, { exact: false }).waitFor();
          assert.deepEqual(await strip.boundingBox(), geometry);
          assert.equal(await position(), before);
        }
        await writeFile(join(profile, 'follow-detail-content'), '');
      }
      await panel.getByText('步骤 073', { exact: false }).waitFor();
      if (label === 'candidate') await strip.getByText('收尾复核完成。步骤 073', { exact: true }).waitFor();
      if (deferredDetails) await revealBottom();
      if (screenshot && trial === 0) await page.screenshot({ path: `${screenshot}-${label}-tail.png` });
    }
    let archived = detail ? '步骤 073' : lastBatch;
    if (reasoningFollowing) {
      await writeFile(join(profile, 'reference-prefix'), '');
      await panel.getByText('[迟到引用]', { exact: true }).waitFor();
      if (label === 'candidate') {
        const ending = 'آخر خطوة: مراجعة النتائج.';
        await strip.getByText(ending, { exact: false }).waitFor();
        const endingVisible = await strip.locator('bdi').evaluate((preview, ending) => {
          const text = preview.firstChild;
          const view = preview.parentElement.getBoundingClientRect();
          const range = document.createRange();
          range.setStart(text, text.length - ending.length);
          range.setEnd(text, text.length);
          const boxes = Array.from(range.getClientRects());
          return preview.getBoundingClientRect().width > view.width && boxes.length > 0 &&
            boxes.every(box => box.left >= view.left - 1 && box.right <= view.right + 1);
        }, ending);
        assert.ok(endingVisible, 'The fixed strip should show the end of a long right-to-left summary.');
        assert.deepEqual(await strip.boundingBox(), geometry);
        if (screenshot && trial === 0) await page.screenshot({ path: `${screenshot}-${label}-rtl.png` });
      }
      await writeFile(join(profile, 'reference-definition'), '');
      const link = panel.getByRole('link', { name: '迟到引用', exact: true });
      await link.waitFor();
      assert.equal(await link.getAttribute('href'), 'https://example.com/span/reference');
      if (label === 'candidate') {
        await panel.getByRole('button', { name: '关闭面板' }).press('Tab');
        assert.ok(await detail.evaluate(element => element === document.activeElement),
          'The reasoning viewport stays keyboard-focusable when it contains a link.');
        await page.keyboard.press('Home');
        await page.waitForFunction(() => document.querySelector('#reasoning-panel .agent-panel-content').scrollTop <= 2);
        await page.keyboard.press('PageDown');
        await page.waitForFunction(() => {
          const body = document.querySelector('#reasoning-panel .agent-panel-content');
          return body.scrollTop >= body.clientHeight / 2;
        });
        await page.keyboard.press('End');
        await revealBottom();
        assert.equal(await position(), before);
      }
      archived = '引用检查完成。';
      await strip.getByText(archived, { exact: true }).waitFor();
      assert.deepEqual(await strip.boundingBox(), geometry);
    }
    if (detail && keepsArchive) await strip.focus();
    await writeFile(join(profile, 'finish'), '');
    await strip.waitFor({ state: 'detached' });
    if (detail && keepsArchive) {
      await panel.getByText('已归档', { exact: true }).waitFor();
      assert.ok(await detail.evaluate(element => element === document.activeElement));
      await detail.press('Escape');
      assert.ok(await composer.evaluate(element => element === document.activeElement));
    }
    if (detail) await detail.waitFor({ state: 'detached' });
    await latest.click();
    const archive = transcript.locator('[data-card="reasoning"]').filter({ hasText: archived });
    await archive.getByText(archived, { exact: false }).waitFor();
    if (reasoningFollowing && label === 'candidate') {
      const header = archive.locator('summary');
      await latest.waitFor({ state: 'detached' });
      await settleFrame(page);
      const beforeOpen = await header.boundingBox();
      await header.press('Enter');
      const startOfSummary = archive.getByRole('link', { name: '迟到引用', exact: true });
      await startOfSummary.waitFor();
      await latest.waitFor();
      await settleFrame(page);
      const expandedHeader = await header.boundingBox();
      assert.ok(Math.abs(beforeOpen.y - expandedHeader.y) <= 2, 'Opening an archived summary should keep its title in place.');
      assert.ok(await header.evaluate(element => element === document.activeElement));
      const beginningInView = () => startOfSummary.evaluate(element => {
        const bounds = element.getBoundingClientRect();
        const view = element.closest('.timeline').getBoundingClientRect();
        return bounds.top >= view.top && bounds.bottom <= view.bottom;
      });
      assert.ok(await beginningInView(), 'The beginning of the summary should be in view.');
      if (screenshot && trial === 0) await page.screenshot({ path: `${screenshot}-${label}-archive.png` });
      await header.press('Enter');
      await startOfSummary.waitFor({ state: 'detached' });
      await placeInTimeline(header, 3, 'bottom');
      const edge = await header.evaluate(element =>
        element.closest('.timeline').getBoundingClientRect().bottom - element.getBoundingClientRect().bottom);
      assert.ok(edge >= 0 && edge <= 5, `The closed title is ${edge}px from the lower edge of the viewport.`);
      const atEdge = await header.boundingBox();
      await header.press('Enter');
      await startOfSummary.waitFor();
      await settleFrame(page);
      const moved = atEdge.y - (await header.boundingBox()).y;
      assert.ok(moved > 0 && moved <= 55 && await beginningInView(), 'Opening should reveal the start with a short scroll.');
      assert.ok(await header.evaluate(element => element === document.activeElement));
      if (screenshot && trial === 0) await page.screenshot({ path: `${screenshot}-${label}-archive-edge.png` });
      await latest.click();
      await latest.waitFor({ state: 'detached' });
      const answer = transcript.getByText('推理核对已完成。', { exact: true });
      assert.ok(await answer.evaluate(element => element.getBoundingClientRect().bottom <=
        element.closest('.timeline').getBoundingClientRect().bottom));
    }
    return { label, updates, bodyUpdates, startPssKiB: startMemory?.pssKiB, endPssKiB: endMemory?.pssKiB, typing, diagnosticMemory,
      rendererCpuMs: (end.ProcessTime - start.ProcessTime) * 1000,
      mainThreadCpuMs: (end.ThreadTime - start.ThreadTime) * 1000,
      scriptMs: (end.ScriptDuration - start.ScriptDuration) * 1000, layouts: end.LayoutCount - start.LayoutCount };
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
    if (grouped || reasoningIndex) await writeFile(join(profile, 'grouped-history'), '');
    if (reasoningDetails) await writeFile(join(profile, reasoningFollowing ? 'reasoning-following' : 'reasoning-details'), '');
    if (reasoningIndex) await writeFile(join(profile, 'reasoning-index'), '');
    app = await electron.launch({
      executablePath: binary,
      args: ['--demo', `--force-device-scale-factor=${deviceScaleFactor}`,
        ...(linux ? ['--no-sandbox', '--disable-gpu', '--disable-webgl'] : [])],
      env: { ...process.env, SPAN_PREVIEW_PROFILE: profile, SPAN_PREVIEW_STREAM_GATE: profile },
    });
    const page = await app.firstWindow();
    const size = streamedReasoning ? [740, 520] : [800, 640];
    await page.waitForLoadState('domcontentloaded');
    const readViewport = () => page.evaluate(() => [innerWidth, innerHeight]);
    assert.equal(await page.evaluate(() => devicePixelRatio), deviceScaleFactor);
    const rendererPid = await app.evaluate(({ BrowserWindow }, size) => {
      const window = BrowserWindow.getAllWindows()[0];
      window.setContentSize(...size);
      return window.webContents.getOSProcessId();
    }, size);
    // At Windows 125%, resizing to the native minimum can yield a 742 × 522 CSS viewport.
    const tolerance = deviceScaleFactor === 1 ? 0 : 2;
    try {
      await page.waitForFunction(({ size: [width, height], tolerance }) =>
        Math.abs(innerWidth - width) <= tolerance && Math.abs(innerHeight - height) <= tolerance, { size, tolerance });
    } catch (error) {
      const contentSize = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getContentSize());
      throw new Error(`Expected a ${size.join(' × ')} CSS viewport at ${deviceScaleFactor}×, observed ` +
        `${(await readViewport()).join(' × ')}. Native content: ${contentSize.join(' × ')}.`, { cause: error });
    }
    const composer = page.getByRole('textbox', { name: '消息' });
    const transcript = page.getByTestId('transcript');
    await transcript.getByText('第 160 项', { exact: false }).waitFor();
    if (grouped || reasoningIndex) assert.equal(await transcript.getAttribute('data-items'), '2901');
    if (toolOutput) return await checkToolOutput(app, page, composer, profile, rendererPid, label, trial);
    if (streamedReasoning) {
      const viewport = await readViewport();
      return { viewport, ...await checkReasoning(app, page, composer, transcript, profile, rendererPid, label, trial) };
    }
    if (grouped) {
      const group = transcript.getByRole('button', { name: '6 条命令', exact: true }).last();
      const titleOffset = () => group.evaluate(button =>
        button.getBoundingClientRect().top - button.closest('.timeline').getBoundingClientRect().top);
      const closedTop = label === 'candidate' ? await titleOffset() : undefined;
      const lastCommand = transcript.getByText('workspace verify --record 160-143', { exact: true });
      await group.press('Enter');
      await lastCommand.waitFor();
      if (label === 'candidate') {
        // Deliver a height change between the viewport's top and the open group.
        const { before, resized, restored } = await group.evaluate(async button => {
          const viewport = button.closest('.timeline');
          const row = button.closest('.message').previousElementSibling;
          const titleOffset = () => button.getBoundingClientRect().top - viewport.getBoundingClientRect().top;
          const frame = async () => {
            await new Promise(requestAnimationFrame);
            await new Promise(requestAnimationFrame);
          };
          await frame();
          if (row.getBoundingClientRect().top < viewport.getBoundingClientRect().top) {
            throw new Error('The row being resized must be inside the viewport.');
          }
          const before = titleOffset();
          const padding = row.style.paddingBottom;
          row.style.paddingBottom = `${Number.parseFloat(getComputedStyle(row).paddingBottom) + 96}px`;
          await frame();
          const resized = titleOffset();
          row.style.paddingBottom = padding;
          await frame();
          return { before, resized, restored: titleOffset() };
        });
        assert.ok(Math.abs(resized - before) <= 2 && Math.abs(restored - before) <= 2,
          `The group moved during a late resize: ${before}, ${resized}, ${restored}.`);
        assert.ok(await group.evaluate(button => button === document.activeElement));
        if (screenshot && trial === 0) await page.screenshot({ path: `${screenshot}-candidate-anchor.png` });
        await group.press('Enter');
        await lastCommand.waitFor({ state: 'detached' });
        await settleFrame(page);
        assert.equal(await group.getAttribute('aria-expanded'), 'false');
        assert.ok(Math.abs(await titleOffset() - closedTop) <= 2);
        await group.press('Enter');
        await lastCommand.waitFor();
      }
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
      await placeInTimeline(heading, 28);
      await latest.waitFor();
      position = await headingOffset();
      assert.ok(Math.abs(position - 28) <= 2, `Expected to start reading the reply at 28 pixels, observed ${position}.`);
    }
    const firstLink = following ? await transcript.getByRole('link', { name: '复核链接' }).elementHandle() : undefined;
    if (following) await transcript.getByText('查看[后补引用][later]的链接。', { exact: true }).waitFor();

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
      assert.ok(await firstLink.evaluate(element => element.isConnected));
      await firstLink.dispose();
    }
    let windowResize;
    if (!following && !grouped && label === 'candidate' && trial === 0) {
      windowResize = await checkWindowReflow(app, page, transcript, latest, tailInView);
      await checkSidebarReflow(app, page, transcript, latest, tailInView);
    }
    const link = transcript.getByRole('link', { name: '复核链接' });
    assert.equal(await link.getAttribute('href'), 'https://example.com/span');
    assert.equal(await link.evaluate(element => {
      const selection = element.ownerDocument.getSelection();
      selection.selectAllChildren(element);
      return selection.toString();
    }), '复核链接');
    return { label, following, grouped, mutationBatches, maxBatchGapMs, startPssKiB, endPssKiB, typing, windowResize,
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
const alternate = following || grouped || toolOutput || streamedReasoning;
for (let trial = 0; trial < (baseline ? 2 : 1); trial++) {
  if (baseline && (!alternate || trial === 0)) trials.push(await check(baseline, 'baseline', trial));
  trials.push(await check(candidate, 'candidate', trial));
  if (baseline && alternate && trial === 1) trials.push(await check(baseline, 'baseline', trial));
}
const scenario = toolOutput ? 'tool-output' : reasoningFollowing ? 'reasoning-following' :
  reasoningIndex ? 'reasoning-index' : reasoningDetails ? 'reasoning-details' : streamedReasoning ? 'reasoning' : undefined;
console.log(JSON.stringify({ platform: process.platform, scenario, deviceScaleFactor, trials }, null, 2));
