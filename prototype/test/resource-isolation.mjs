import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { availableParallelism, release, tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

const [binary, reportPath, baselineBinary, baselineCommit] = process.argv.slice(2);
const linux = process.platform === 'linux';
const initialSize = [880, 640];
const activeWindowMs = 7500;
const interactionTimeoutMs = 10_000;
const settle = page => page.evaluate(async () => {
  await new Promise(requestAnimationFrame);
  await new Promise(requestAnimationFrame);
});

async function resize(app, page, [width, height]) {
  await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(...size), [width, height]);
  await page.waitForFunction(([width, height]) => Math.abs(innerWidth - width) <= 2 && Math.abs(innerHeight - height) <= 2,
    [width, height]);
}

async function terminalLine(page, command, result) {
  await page.locator('.xterm-helper-textarea').focus();
  await page.keyboard.type(command);
  await page.keyboard.press('Enter');
  await page.waitForFunction(line => [...document.querySelectorAll('.xterm-rows > div')]
    .some(row => row.textContent.trim() === line), result, { timeout: 20_000 });
}

async function echoSample(app, page, key) {
  await app.evaluate((_, key) => {
    const state = globalThis.spanTerminalEcho;
    const pixels = state.pixels[key];
    if (!pixels) throw Error(`No reference pixels for terminal key ${key}`);
    state.result = new Promise(resolve => {
      const started = performance.now();
      const firstFrame = state.frames;
      const timer = setTimeout(() => {
        const bestMatch = state.pending.bestMatch;
        state.pending = undefined;
        resolve({ frames: state.frames - firstFrame, bestMatch });
      }, 2000);
      state.pending = { pixels, started, bestMatch: 0, finish: ms => {
        clearTimeout(timer);
        state.pending = undefined;
        resolve({ ms });
      } };
    });
  }, key);
  await page.keyboard.press(key);
  const result = await app.evaluate(() => globalThis.spanTerminalEcho.result);
  assert.ok(Number.isFinite(result.ms), `No matching echo for ${key} after ${result.frames} frames (best match ${result.bestMatch})`);
  return result.ms;
}

async function prepareEchoFrames(app, page) {
  const area = await page.evaluate(() => {
    const row = [...document.querySelectorAll('.xterm-rows > div')].find(row => row.textContent.trim() === 'span_echo_ready');
    if (!row) throw Error('The ready line disappeared before measuring its bounds');
    const rect = row.getBoundingClientRect();
    return { x: Math.ceil(rect.left), y: Math.ceil(rect.top), width: 128, height: Math.floor(rect.height) - 1 };
  });
  await page.locator('.xterm-helper-textarea').focus();
  const references = {};
  for (const key of 'ab') {
    await page.keyboard.press(key);
    await page.waitForFunction(key => [...document.querySelectorAll('.xterm-rows > div')]
      .some(row => row.textContent.trim() === `span_echo_${key}`), key, { timeout: interactionTimeoutMs });
    await settle(page);
    references[key] = await app.evaluate(async ({ BrowserWindow }, area) => {
      const contents = BrowserWindow.getAllWindows()[0].webContents;
      const image = await Promise.race([contents.capturePage(), new Promise(resolve => setTimeout(resolve, 4000))]);
      if (!image) throw Error('The terminal reference frame was not captured');
      return image.crop(area).toBitmap().toString('hex');
    }, area);
  }
  assert.ok(references.a && references.b && references.a !== references.b, 'The two terminal keys must paint different pixels');
  console.log('Captured different reference pixels for both keys. Verifying frame notifications.');
  await app.evaluate(({ BrowserWindow }, { area, references }) => {
    const a = Buffer.from(references.a, 'hex');
    const b = Buffer.from(references.b, 'hex');
    const pixels = { a: [], b: [] };
    // Match the pixels that distinguish the two glyphs. Ignore the rest of the row and the spaces around the text.
    for (let index = 0; index < a.length; index += 4) {
      if (Math.abs(a[index] - b[index]) < 100) continue;
      const midpoint = (a[index] + b[index]) / 2;
      pixels.a.push({ index, midpoint, light: a[index] > midpoint });
      pixels.b.push({ index, midpoint, light: b[index] > midpoint });
    }
    if (pixels.a.length < 8) throw Error('The terminal reference glyphs do not differ enough for a paint probe');
    const state = { frames: 0, pixels };
    globalThis.spanTerminalEcho = state;
    BrowserWindow.getAllWindows()[0].webContents.beginFrameSubscription(false, image => {
      state.frames++;
      const pending = state.pending;
      if (!pending) return;
      const bitmap = image.crop(area).toBitmap();
      const matching = pending.pixels.filter(({ index, midpoint, light }) => (bitmap[index] > midpoint) === light).length;
      pending.bestMatch = Math.max(pending.bestMatch, matching / pending.pixels.length);
      if (matching === pending.pixels.length) pending.finish(performance.now() - pending.started);
    });
  }, { area, references });
  await delay(165);
  await echoSample(app, page, 'a');
  await delay(165);
  await echoSample(app, page, 'b');
}

async function terminalInteraction(app, page, screenshot, recordEcho) {
  const script = fileURLToPath(new URL('./terminal-echo.cjs', import.meta.url));
  await terminalLine(page, `"${process.execPath}" "${script}"`, 'span_echo_ready');
  console.log('The raw terminal fixture is ready. Capturing reference pixels.');
  await prepareEchoFrames(app, page);
  console.log('The frame observer matched both reference keys. Measuring idle and streaming echo.');
  const idleMs = [];
  for (const key of 'abababab') {
    await delay(165);
    idleMs.push(await echoSample(app, page, key));
  }
  await page.keyboard.press('g');
  await page.waitForFunction(() => document.querySelector('.xterm-rows').innerText.includes('span_interaction_3'),
    null, { timeout: interactionTimeoutMs });
  const streamingMs = [];
  for (const key of 'abababababab') {
    await delay(165 + streamingMs.length % 3 * 16);
    streamingMs.push(await echoSample(app, page, key));
  }
  const frames = await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].webContents.endFrameSubscription();
    return globalThis.spanTerminalEcho.frames;
  });
  assert.ok(frames >= idleMs.length + streamingMs.length + 2);
  await recordEcho({ idleMs, streamingMs, frames });
  assert.match(await page.locator('.xterm-rows').innerText(), /span_interaction_\d+/);
  await page.keyboard.press(linux ? 'q' : 'f');
  console.log('The echo samples reached matching frames. Checking the final terminal output and reopening.');
  await page.waitForFunction(() => [...document.querySelectorAll('.xterm-rows > div')].some(row => {
    if (row.textContent.trim() !== '绘_echo_final') return false;
    return [...row.querySelectorAll('.xterm-fg-2')].map(span => span.textContent).join('').trim() === '绘_echo_final';
  }), null, { timeout: interactionTimeoutMs });
  if (linux) {
    await terminalLine(page, 'exit', '[终端已退出]');
    assert.match(await page.locator('.xterm-rows').innerText(), /绘_echo_final[\s\S]*\[终端已退出\]/);
  }
  await page.screenshot({ path: screenshot, timeout: interactionTimeoutMs });
  if (!linux) await page.keyboard.press('q');
  await page.getByRole('button', { name: '关闭终端' }).click();
  await page.locator('.terminal-canvas').waitFor({ state: 'detached' });
  await page.getByRole('button', { name: '切换终端' }).click();
  await terminalLine(page, linux ? `printf '%s_%s\\n' span_echo reopened` : 'echo span_echo_reopened', 'span_echo_reopened');
  assert.doesNotMatch(await page.locator('.xterm-rows').innerText(), /绘_echo_final/);
}

async function output(page) {
  const command = linux
    ? `n=1; while [ "$n" -le 120 ]; do printf 'span-resource-%03d\\n' "$n"; n=$((n+1)); sleep .045; done; printf '%s_%s\\n' resources done`
    : `powershell -NoLogo -NoProfile -Command "for ($i=1; $i -le 120; $i++) { [Console]::WriteLine(('span-resource-' + $i)); Start-Sleep -Milliseconds 45 }; [Console]::WriteLine(('resources_'+'done'))"`;
  await terminalLine(page, command, 'resources_done');
  assert.match(await page.locator('.xterm-rows').innerText(), /span-resource-120/);
  return { outputLines: 120 };
}

async function scroll(page) {
  const timeline = page.getByTestId('transcript');
  await timeline.hover({ position: { x: 24, y: 80 } });
  const offsets = [];
  for (let index = 0; index < 36; index++) {
    await page.mouse.wheel(0, index % 12 < 6 ? -176 : 176);
    await delay(60);
    if (index % 6 === 5) offsets.push(await timeline.evaluate(element => element.scrollTop));
  }
  assert.ok(Math.max(...offsets) - Math.min(...offsets) >= 500, `The transcript did not scroll through history: ${offsets}`);
  return { wheelSteps: 36, offsets };
}

async function reflow(page, app) {
  const column = page.locator('.timeline .reading-column');
  const start = await column.evaluate(element => element.clientWidth);
  for (let index = 0; index < 24; index++) {
    await resize(app, page, index % 2 === 0 ? [740, initialSize[1]] : initialSize);
    if (index === 0) assert.ok(start - await column.evaluate(element => element.clientWidth) >= 80);
  }
  assert.ok(Math.abs(start - await column.evaluate(element => element.clientWidth)) <= 2);
  return { widthChanges: 24 };
}

const exercise = { output, scroll, reflow };

async function snapshot(app, page, cdp, pid) {
  const [dom, heap, performance, scene, native] = await Promise.all([
    cdp.send('Memory.getDOMCounters'), cdp.send('Runtime.getHeapUsage'), cdp.send('Performance.getMetrics'),
    page.evaluate(() => {
      const timeline = document.querySelector('.timeline');
      const terminal = document.querySelector('.terminal-canvas');
      return { historyElements: timeline.querySelectorAll('*').length, terminalElements: terminal?.querySelectorAll('*').length ?? 0 };
    }),
    app.evaluate(({ app }, pid) => {
      const memory = process.platform === 'win32' ? app.getAppMetrics().find(metric => metric.pid === pid)?.memory : undefined;
      return { mainCpuMs: process.getCPUUsage().cumulativeCPUUsage * 1000, memory };
    }, pid),
  ]);
  const metrics = Object.fromEntries(performance.metrics.map(({ name, value }) => [name, value]));
  const renderer = { cpuMs: metrics.ProcessTime * 1000, mainThreadCpuMs: metrics.ThreadTime * 1000 };
  if (linux) {
    const map = await readFile(`/proc/${pid}/smaps_rollup`, 'utf8');
    const kib = name => Number(map.match(new RegExp(`^${name}:\\s+(\\d+)`, 'm'))[1]);
    Object.assign(renderer, { pssKiB: kib('Pss'), rssKiB: kib('Rss'), privateDirtyKiB: kib('Private_Dirty') });
  } else {
    assert.ok(native.memory?.workingSetSize > 0 && native.memory.privateBytes > 0);
    Object.assign(renderer, { workingSetKiB: native.memory.workingSetSize, privateKiB: native.memory.privateBytes });
  }
  return { renderer, mainCpuMs: native.mainCpuMs, dom, usedHeapBytes: heap.usedSize, ...scene };
}

async function trial(workload, variant, executable, recordEcho) {
  const profile = await mkdtemp(join(tmpdir(), 'span-resource-'));
  let app;
  let interactionWatchdog;
  try {
    app = await electron.launch({ executablePath: executable,
      args: ['--demo', '--force-device-scale-factor=1', '--disable-gpu', '--terminal-renderer=dom',
        ...(linux ? ['--no-sandbox', '--disable-webgl'] : [])],
      env: { ...process.env, SPAN_PREVIEW_PROFILE: profile },
    });
    if (workload === 'interaction') {
      interactionWatchdog = setTimeout(() => {
        console.error(`${variant} terminal interaction did not finish within 45s`);
        app.process().kill();
        process.exit(1);
      }, 45_000);
    }
    const page = await app.firstWindow();
    if (workload === 'interaction') page.setDefaultTimeout(interactionTimeoutMs);
    await resize(app, page, initialSize);
    const tail = page.getByTestId('transcript').getByText('第 160 项', { exact: false });
    await tail.waitFor();
    const openTerminal = () => page.getByRole('button', { name: '切换终端' }).click();
    if (workload === 'interaction') {
      await openTerminal();
      const screenshot = reportPath.replace(/\.json$/, `-${variant}-terminal-end.png`);
      try {
        await terminalInteraction(app, page, screenshot, recordEcho);
        return;
      } catch (error) {
        console.error(`${variant} terminal interaction failed`, error);
        await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.webContents.endFrameSubscription())
          .catch(() => {});
        await page.screenshot({ path: screenshot, timeout: interactionTimeoutMs }).catch(() => {});
        throw error;
      }
    }
    const [pid, cdp] = await Promise.all([
      app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getOSProcessId()),
      page.context().newCDPSession(page),
    ]);
    await cdp.send('Performance.enable');
    const capture = () => snapshot(app, page, cdp, pid);
    const beforeOpen = await capture();
    await openTerminal();
    await terminalLine(page, linux ? `printf '%s_%s\\n' resources ready` : 'echo resources_ready', 'resources_ready');
    await settle(page);
    const beforeWorkload = await capture();
    assert.ok(beforeWorkload.terminalElements > 0);
    const startedAt = performance.now();
    const events = await exercise[workload]?.(page, app) ?? {};
    await delay(Math.max(0, activeWindowMs - (performance.now() - startedAt)));
    await settle(page);
    const activeMs = Math.round(performance.now() - startedAt);
    const active = await capture();
    await page.getByRole('button', { name: '关闭终端' }).click();
    await page.locator('.terminal-canvas').waitFor({ state: 'detached' });
    await settle(page);
    const closed = await capture();
    assert.equal(closed.terminalElements, 0);
    await delay(2000);
    const settled = await capture();
    await cdp.send('HeapProfiler.collectGarbage');
    const diagnosticGc = await capture();
    return { workload, variant, events, activeMs, beforeOpen, beforeWorkload, active, closed, settled, diagnosticGc };
  } finally {
    try {
      await app?.close();
    } finally {
      clearTimeout(interactionWatchdog);
      await rm(profile, { recursive: true, force: true, maxRetries: 3 });
    }
  }
}

const report = {
  platform: process.platform, osRelease: release(), availableCpus: availableParallelism(), terminalRenderer: 'dom',
  window: initialSize, activeWindowMs, baselineCommit, trials: [], interaction: [],
};
const run = (workload, variant) => trial(workload, variant, variant === 'baseline' ? baselineBinary : binary);
const publish = () => writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
let outputPair = 0;
for (const workload of ['idle', 'output', 'scroll', 'reflow', 'reflow', 'scroll', 'output', 'idle']) {
  const variants = workload === 'output' && baselineBinary
    ? (outputPair++ === 0 ? ['baseline', 'candidate'] : ['candidate', 'baseline']) : ['candidate'];
  for (const variant of variants) {
    const sample = await run(workload, variant);
    report.trials.push(sample);
    await publish();
    console.log(`${variant} ${workload} ${sample.activeMs}ms, DOM nodes ${sample.beforeWorkload.dom.nodes}` +
      ` → ${sample.active.dom.nodes} → ${sample.settled.dom.nodes} → ${sample.diagnosticGc.dom.nodes}`);
  }
}
if (baselineBinary) {
  for (const variant of ['candidate', 'baseline']) {
    const executable = variant === 'baseline' ? baselineBinary : binary;
    await trial('interaction', variant, executable, async sample => {
      report.interaction.push({ workload: 'interaction', variant, ...sample });
      await publish();
      console.log(`${variant} terminal echo in ms: ${JSON.stringify({ idle: sample.idleMs, streaming: sample.streamingMs })}`);
    });
  }
}
