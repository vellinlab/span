import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

const [binary, reportPath] = process.argv.slice(2);
const wheelDriver = fileURLToPath(new URL('./scroll-win.ps1', import.meta.url));
const terminalFixture = fileURLToPath(new URL('./terminal-echo.cjs', import.meta.url));
const directions = [-1, -1, -1, 1, 1, 1];
const dispatchIntervalMs = 315;
const burstIntervalMs = 36;

function nativeWheel(handle, { x, y, width, height }) {
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', wheelDriver,
    '-Handle', handle, '-X', x, '-Y', y, '-Width', width, '-Height', height].map(String),
  { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
  const output = createInterface({ input: child.stdout, crlfDelay: Infinity })[Symbol.asyncIterator]();
  let fault;
  for (const emitter of [child, child.stdin]) emitter.on('error', error => { fault = error; });
  return {
    async request(command) {
      if (command) child.stdin.write(command + '\n');
      const line = await output.next();
      if (line.done) throw fault ?? new Error('The Windows desktop wheel driver exited.');
      return JSON.parse(line.value);
    },
    close: () => child.stdin.end(),
  };
}

function percentile(samples, key) {
  const sorted = samples.filter(item => item.expected != null).map(item => item[key]).sort((a, b) => a - b);
  return sorted.length ? Number(sorted[Math.ceil(sorted.length * .95) - 1].toFixed(2)) : null;
}

async function trial(disableAnimation) {
  const profile = await mkdtemp(join(tmpdir(), 'span-wheel-win-'));
  let app, driver;
  try {
    app = await electron.launch({ executablePath: binary,
      args: ['--demo', '--force-device-scale-factor=1', '--disable-gpu', '--terminal-renderer=dom',
        ...(disableAnimation ? ['--disable-smooth-scrolling'] : [])],
      env: { ...process.env, SPAN_PREVIEW_PROFILE: profile },
    });
    const page = await app.firstWindow();
    const handle = await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      window.setContentSize(920, 680);
      window.center();
      window.focus();
      return String(window.getNativeWindowHandle().readBigUInt64LE());
    });
    await page.waitForFunction(() => innerWidth === 920 && innerHeight === 680 && devicePixelRatio === 1);
    const timeline = page.getByTestId('transcript');
    await timeline.getByText('第 160 项', { exact: false }).waitFor();
    await page.getByRole('button', { name: '切换终端' }).click();
    await page.locator('.xterm-helper-textarea').focus();
    await page.keyboard.type(`"${process.execPath}" "${terminalFixture}"`);
    await page.keyboard.press('Enter');
    await page.locator('.xterm-rows').getByText('span_echo_ready', { exact: true }).waitFor();
    await page.keyboard.press('g');
    const terminalLine = () => page.locator('.xterm-rows').evaluate(rows =>
      Math.max(0, ...Array.from(rows.textContent.matchAll(/span_interaction_(\d+)/g), match => Number(match[1]))));

    const area = await timeline.evaluate(element => {
      const box = element.querySelector('.reading-column').getBoundingClientRect();
      const view = element.getBoundingClientRect();
      return { x: Math.ceil(box.left + 8), y: Math.ceil(view.top + 38),
        width: Math.min(360, Math.floor(box.width - 16)), height: Math.min(132, Math.floor(view.height - 76)) };
    });
    assert.ok(area.width > 240 && area.height > 80);
    driver = nativeWheel(handle, area);
    assert.equal(await driver.request(), 'ready');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].focus());
    await driver.request('position');
    const scrollTop = () => timeline.evaluate(element => element.scrollTop);
    await timeline.evaluate(element => {
      element.spanWheelTrace = [];
      element.addEventListener('wheel', event => {
        const mode = event.deltaMode;
        const delta = event.deltaY;
        element.spanWheelTrace.push({ mode, delta, direction: Math.sign(delta), time: performance.now() });
      }, { passive: true, capture: true });
    });
    const readTrace = () => timeline.evaluate(element => element.spanWheelTrace.splice(0));
    async function reset() {
      await timeline.evaluate(element => { element.scrollTop = element.scrollHeight - element.clientHeight - 540; });
      await delay(dispatchIntervalMs);
      return scrollTop();
    }
    async function calibration() {
      const top = await reset();
      const start = await driver.request('frame');
      let previous = { top, frame: start };
      const reference = [];
      for (const direction of directions) {
        await driver.request(`wheel ${direction}`);
        await delay(dispatchIntervalMs);
        const next = { top: await scrollTop(), frame: await driver.request('frame') };
        assert.notEqual(next.frame, previous.frame, 'Calibration must move the desktop pixels.');
        assert.ok((next.top - previous.top) * direction > 0, 'Calibration must move in the requested direction.');
        reference.push(next);
        previous = next;
      }
      return { top, start, reference };
    }
    await calibration(); // Let the virtual transcript measure all rows on the wheel path.
    const { top, start, reference } = await calibration();
    async function restoreReference() {
      assert.ok(Math.abs(await reset() - top) <= 1, 'The scrolling path must start at the calibrated offset.');
      assert.equal(await driver.request('frame'), start, 'The scrolling path must start on the same desktop pixels.');
    }
    const samples = [];
    const bursts = [];
    const offsets = reference.map(item => item.top - top);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Performance.enable');
    async function measure() {
      const [perf, mainCpu, desktop] = await Promise.all([
        cdp.send('Performance.getMetrics'), app.evaluate(() => process.getCPUUsage().cumulativeCPUUsage * 1000),
        driver.request('cpu'),
      ]);
      const metrics = Object.fromEntries(perf.metrics.map(({ name, value }) => [name, value]));
      return { metrics, mainCpu, desktop };
    }
    await restoreReference();
    await timeline.evaluate(element => { element.spanWheelTrace.length = 0; });
    const terminalStart = await terminalLine();
    const before = await measure();

    for (let index = 0; index < directions.length * 2; index++) {
      const step = index % directions.length;
      const target = reference[step];
      const sent = performance.now();
      const sample = await driver.request(`observe ${target.frame} ${directions[step]} 1 0`);
      await delay(Math.max(0, sent + dispatchIntervalMs - performance.now()));
      assert.ok(Math.abs(await scrollTop() - target.top) <= 1, 'An isolated wheel reached a different offset.');
      samples.push(sample);
    }
    const after = await measure();
    const isolatedTrace = await readTrace();
    const terminalLines = await terminalLine() - terminalStart;
    assert.ok(terminalStart > 0 && terminalLines > 0, 'PTY output must continue throughout the scrolling comparison.');
    async function measureBurst(direction, target, intervalMs) {
      const startingOffset = await scrollTop();
      const result = await driver.request(`observe ${target.frame} ${direction} 3 ${intervalMs}`);
      await delay(Math.max(0, dispatchIntervalMs - (result.expected ?? dispatchIntervalMs)));
      const offset = await scrollTop();
      const settledFrame = await driver.request('frame');
      assert.ok((offset - startingOffset) * direction > 0 && result.changed > 0, 'A wheel burst must move the transcript.');
      const exact = Math.abs(offset - target.top) <= 1 && settledFrame === target.frame;
      const events = await readTrace();
      const single = isolatedTrace.find(event => event.direction === direction);
      const delta = events.reduce((sum, event) => sum + event.delta, 0);
      // Chromium can combine native notches into one WheelEvent before dispatching it to JS.
      const expectedDelta = single ? single.delta * 3 : null;
      const received = single && events.every(event => event.direction === direction && event.mode === single.mode) &&
        Math.abs(delta - expectedDelta) < 0.01;
      return { direction, intervalMs, ...result, startingOffset, offset, expectedOffset: target.top,
        settledFrame, exact, delta, expectedDelta, received: Boolean(received), events };
    }
    async function resetBurst(position) {
      await timeline.evaluate((element, offset) => { element.scrollTop = offset; }, position.top);
      await delay(dispatchIntervalMs);
      assert.ok(Math.abs(await scrollTop() - position.top) <= 1, 'Restore the calibrated burst start.');
      assert.equal(await driver.request('frame'), position.frame, 'Restore the desktop pixels before repeating a burst.');
    }
    const inputRetries = [];
    for (let index = 0; index < 4; index++) {
      const direction = index % 2 === 0 ? -1 : 1;
      const position = direction < 0 ? { top, frame: start } : reference[2];
      const target = reference[direction < 0 ? 2 : 5];
      let burst = await measureBurst(direction, target, burstIntervalMs);
      if (!burst.received) {
        // Preserve the delivered deltas when Windows does not deliver the calibrated input.
        inputRetries.push(burst);
        await resetBurst(position);
        burst = await measureBurst(direction, target, burstIntervalMs + 12);
      }
      bursts.push(burst);
      if (!burst.exact && index < 3) await resetBurst(target);
    }
    const renderer = await app.evaluate(({ BrowserWindow, app }) => {
      const pid = BrowserWindow.getAllWindows()[0].webContents.getOSProcessId();
      return app.getAppMetrics().find(process => process.pid === pid)?.memory;
    });
    assert.ok(renderer?.workingSetSize > 0 && renderer.privateBytes > 0);
    return {
      mode: disableAnimation ? 'animation-disabled' : 'default', area, top, offsets, terminalLines,
      rendererCpuMs: (after.metrics.ProcessTime - before.metrics.ProcessTime) * 1000,
      elapsedMs: (after.metrics.Timestamp - before.metrics.Timestamp) * 1000,
      mainCpuMs: after.mainCpu - before.mainCpu,
      driverCpuMs: after.desktop.driver - before.desktop.driver,
      compositorCpuMs: after.desktop.compositor == null || before.desktop.compositor == null
        ? null : after.desktop.compositor - before.desktop.compositor,
      rendererWorkingSetKiB: renderer.workingSetSize, rendererPrivateKiB: renderer.privateBytes,
      firstPixelP95Ms: percentile(samples, 'first'), exactPixelP95Ms: percentile(samples, 'expected'),
      matched: samples.filter(item => item.expected != null).length,
      samples, bursts, inputRetries, trace: isolatedTrace,
    };
  } finally {
    driver?.close();
    await app?.close();
    await rm(profile, { recursive: true, force: true, maxRetries: 3 });
  }
}

const report = { comparison: 'Same Windows Electron package, default or --disable-smooth-scrolling',
  viewport: [920, 680], dispatchIntervalMs, burstIntervalMs, trials: [] };
// Alternate order so the comparison does not track time on the Windows runner.
for (const disabled of [false, true, true, false]) {
  const run = await trial(disabled);
  report.trials.push(run);
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  const { samples, bursts, trace, ...summary } = run;
  console.log(JSON.stringify({ ...summary, bursts }));
  assert.deepEqual(trace.map(item => item.direction), [...directions, ...directions], 'Check all isolated wheel events.');
  for (const burst of bursts) assert.ok(burst.received && burst.exact,
    `The wheel burst delta ${burst.delta}/${burst.expectedDelta} reached ${burst.offset}/${burst.expectedOffset}. ` +
    `The desktop frame matched: ${burst.exact}.`);
  assert.ok(run.matched >= 10, 'The desktop must paint at least ten of the twelve calibrated wheel targets.');
  assert.ok(run.offsets.every((offset, index) => Math.abs(offset - report.trials[0].offsets[index]) <= 1),
    'The isolated-wheel comparison must cover equivalent offsets.');
}
