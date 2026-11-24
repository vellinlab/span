import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

const [binary, reportPath, baselineBinary, baselineCommit] = process.argv.slice(2);
const linux = process.platform === 'linux';
const initialSize = [880, 640];
const activeWindowMs = 7500;
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

async function echoSample(page, key) {
  await page.evaluate(key => {
    const terminal = document.querySelector('.terminal-canvas');
    const rows = terminal.querySelector('.xterm-rows');
    const expected = `span_echo_${key}`;
    window.spanEchoSample = new Promise(resolve => {
      terminal.addEventListener('keydown', function start(event) {
        if (event.key !== key || !event.isTrusted) return;
        terminal.removeEventListener('keydown', start, true);
        const started = performance.now();
        const observer = new MutationObserver(() => {
          if (![...rows.children].some(row => row.textContent.trim() === expected)) return;
          observer.disconnect();
          requestAnimationFrame(() => resolve(performance.now() - started));
        });
        observer.observe(rows, { childList: true, subtree: true });
      }, true);
    });
  }, key);
  await page.keyboard.press(key);
  return page.evaluate(() => Promise.race([
    window.spanEchoSample,
    new Promise((_, reject) => setTimeout(() => reject(new Error('The terminal echo never reached the visible rows')), 2000)),
  ]));
}

async function terminalInteraction(page, screenshot) {
  const script = fileURLToPath(new URL('./terminal-echo.cjs', import.meta.url));
  await terminalLine(page, `"${process.execPath}" "${script}"`, 'span_echo_ready');
  const idleMs = [];
  for (const key of '123456') {
    await delay(165);
    idleMs.push(await echoSample(page, key));
  }
  await echoSample(page, 'g');
  await page.waitForFunction(() => document.querySelector('.xterm-rows').innerText.includes('span_interaction_3'));
  const streamingMs = [];
  for (const key of 'abcdefhijklm') {
    await delay(165 + streamingMs.length % 3 * 16);
    streamingMs.push(await echoSample(page, key));
  }
  assert.match(await page.locator('.xterm-rows').innerText(), /span_interaction_\d+/);
  await page.keyboard.press('q');
  await page.waitForFunction(() => [...document.querySelectorAll('.xterm-rows > div')].some(row => {
    if (row.textContent.trim() !== '绘_echo_final') return false;
    return [...row.querySelectorAll('.xterm-fg-2')].map(span => span.textContent).join('').trim() === '绘_echo_final';
  }));
  await terminalLine(page, 'exit', '[终端已退出]');
  const visible = await page.locator('.xterm-rows').innerText();
  assert.match(visible, /绘_echo_final[\s\S]*\[终端已退出\]/);
  await page.screenshot({ path: screenshot });
  return { idleMs, streamingMs };
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

async function trial(workload, variant, executable) {
  const profile = await mkdtemp(join(tmpdir(), 'span-resource-'));
  let app;
  try {
    app = await electron.launch({ executablePath: executable,
      args: ['--demo', '--force-device-scale-factor=1', '--disable-gpu', '--terminal-renderer=dom',
        ...(linux ? ['--no-sandbox', '--disable-webgl'] : [])],
      env: { ...process.env, SPAN_PREVIEW_PROFILE: profile },
    });
    const page = await app.firstWindow();
    await resize(app, page, initialSize);
    const tail = page.getByTestId('transcript').getByText('第 160 项', { exact: false });
    await tail.waitFor();
    const openTerminal = () => page.getByRole('button', { name: '切换终端' }).click();
    if (workload === 'interaction') {
      await openTerminal();
      const screenshot = reportPath.replace(/\.json$/, `-${variant}-terminal-end.png`);
      return { workload, variant, ...await terminalInteraction(page, screenshot) };
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
    await app?.close();
    await rm(profile, { recursive: true, force: true, maxRetries: 3 });
  }
}

const report = { platform: process.platform, window: initialSize, activeWindowMs, baselineCommit, trials: [], interaction: [] };
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
    const sample = await run('interaction', variant);
    report.interaction.push(sample);
    await publish();
    console.log(`${variant} terminal echo in ms: ${JSON.stringify({ idle: sample.idleMs, streaming: sample.streamingMs })}`);
  }
}
