import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

const [candidate, baseline, screenshot] = process.argv.slice(2);
const linux = process.platform === 'linux';
const clockTicks = linux ? Number(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8' })) : undefined;

async function processStats(pid) {
  const memory = await readFile(`/proc/${pid}/smaps_rollup`, 'utf8');
  const get = name => {
    const value = memory.match(new RegExp(`^${name}:\\s+(\\d+)`, 'm'))?.[1];
    return value === undefined ? undefined : Number(value);
  };
  const processStat = await readFile(`/proc/${pid}/stat`, 'utf8');
  const columns = processStat.slice(processStat.lastIndexOf(')') + 2).split(' ');
  const pssKiB = get('Pss');
  assert.ok(pssKiB > 0, `No proportional memory sample for Chromium process ${pid}`);
  return { pssKiB, rssKiB: get('Rss'), privateDirtyKiB: get('Private_Dirty'),
    anonymousPssKiB: get('Pss_Anon'), filePssKiB: get('Pss_File'), sharedPssKiB: get('Pss_Shmem'),
    cpuMs: (Number(columns[11]) + Number(columns[12])) * 1000 / clockTicks };
}

async function chromiumStartupStats(app, rendererPid) {
  const processes = await app.evaluate(({ app }) => app.getAppMetrics().map(({ pid, type, serviceName, memory }) =>
    ({ pid, type, serviceName, workingSetKiB: memory?.workingSetSize, privateKiB: memory?.privateBytes })));
  assert.ok(processes.some(({ pid }) => pid === rendererPid), 'Capture the renderer for the first ready window');
  if (!linux) return processes;
  return Promise.all(processes.map(async ({ pid, type, serviceName }) => {
    const process = { pid, type, serviceName };
    try {
      return { ...process, ...await processStats(process.pid) };
    } catch (error) {
      if (process.pid === rendererPid || !['ENOENT', 'ESRCH'].includes(error.code)) throw error;
      return { ...process, exitedDuringSampling: true };
    }
  }));
}

async function openUsagePanel(page, composer) {
  await composer.fill('/usage');
  const frame = await composer.evaluateHandle(element => {
    return {
      seen: new Promise(resolve => {
        let start;
        element.addEventListener('keydown', () => { start = performance.now(); }, { capture: true, once: true });
        const observer = new MutationObserver(() => {
          if (start === undefined || !document.querySelector('.agent-panel[data-kind="usage"] .usage-panel')) return;
          observer.disconnect();
          requestAnimationFrame(() => resolve(performance.now() - start));
        });
        observer.observe(document.querySelector('.composer-overlay'), { subtree: true, childList: true });
      }),
    };
  });
  await composer.press('Enter');
  const panel = page.getByRole('region', { name: '用量', exact: true });
  await panel.locator('.usage-panel').waitFor();
  const pressToPanelFrameMs = await frame.evaluate(result => result.seen);
  await frame.dispose();
  const close = panel.getByRole('button', { name: '关闭面板' });
  assert.ok(await close.evaluate(button => button === document.activeElement), 'Focus the inspector close button on open');
  await close.press('Escape');
  await panel.waitFor({ state: 'detached' });
  assert.ok(await composer.evaluate(element => element === document.activeElement), 'Restore the draft focus after opening the inspector');
  return pressToPanelFrameMs;
}

async function check(binary, label, display, firstOnDisplay, exercise, captureBaseline) {
  const profile = await mkdtemp(join(tmpdir(), 'span-startup-'));
  let app;
  try {
    app = await electron.launch({
      executablePath: binary,
      args: ['--demo', '--disable-gpu', ...(linux ? ['--no-sandbox'] : [])],
      env: { ...process.env, ...(display && { DISPLAY: display }),
        SPAN_PREVIEW_PROFILE: profile, SPAN_PREVIEW_CATALOG_FIXTURE: 'empty' },
    });
    const page = await app.firstWindow();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const connected = page.locator('.connection').filter({ has: page.locator('i.ready') });
    await connected.getByText('Codex · 本机', { exact: true }).waitFor();
    await page.getByRole('heading', { name: '开始新会话' }).waitFor();
    await page.waitForFunction(() => performance.getEntriesByName('first-contentful-paint').length > 0);
    const paint = await page.evaluate(() => ({
      firstContentfulPaintMs: performance.getEntriesByName('first-contentful-paint')[0].startTime,
      readyObservedMs: performance.now(),
      viewport: [innerWidth, innerHeight],
    }));
    const rendererPid = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getOSProcessId());
    const chromiumProcesses = await chromiumStartupStats(app, rendererPid);
    const renderer = chromiumProcesses.find(({ pid }) => pid === rendererPid);
    if (!linux) assert.ok(renderer.workingSetKiB > 0 && renderer.privateKiB > 0, 'Sample native Windows renderer memory');

    // Enabling Debugger reports previously parsed scripts without needing instrumentation in either renderer.
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Performance.enable');
    const readyMetrics = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(({ name, value }) => [name, value]));
    const rendererReady = { usedHeapBytes: readyMetrics.JSHeapUsedSize, totalHeapBytes: readyMetrics.JSHeapTotalSize,
      cpuMs: readyMetrics.ProcessTime * 1000 };
    assert.ok(rendererReady.usedHeapBytes > 0);
    const modules = new Set();
    cdp.on('Debugger.scriptParsed', ({ url }) => {
      if (/^file:.*\/dist\/assets\/[^/]+\.js$/.test(url)) modules.add(url);
    });
    await cdp.send('Debugger.enable');
    const scripts = await Promise.all([...modules].sort().map(async url => {
      const path = fileURLToPath(url);
      return { name: path.split(/[/\\]/).at(-1), bytes: (await stat(path)).size };
    }));
    assert.ok(scripts.length > 0, 'Observe the packaged entry script before checking optional modules.');
    if (label === 'candidate') {
      assert.equal(scripts.some(script => /^(?:pi|markdown-content|agent-inspector)-/.test(script.name)), false);
    }
    await cdp.send('DOM.enable');
    await cdp.send('CSS.enable');
    const { root } = await cdp.send('DOM.getDocument');
    const fonts = Object.fromEntries(await Promise.all(Object.entries({ brand: '.brand strong', heading: '.welcome h1' })
      .map(async ([name, selector]) => {
        const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector });
        const result = await cdp.send('CSS.getPlatformFontsForNode', { nodeId });
        assert.ok(result.fonts.length, `Observe the actual fonts in ${selector}`);
        return [name, result.fonts];
      })));
    if (screenshot && captureBaseline) {
      await page.screenshot({ path: screenshot.replace(/\.png$/, '-baseline.png') });
    }

    const composer = page.getByRole('textbox', { name: '消息' });
    if (screenshot && exercise) await page.screenshot({ path: screenshot });
    const firstPanelMs = await openUsagePanel(page, composer);
    const inspectorLoaded = [...modules].some(url => /\/agent-inspector-/.test(url));
    if (label === 'candidate') assert.ok(inspectorLoaded, 'Load the inspector only after the user opens it');
    const reopenPanelMs = await openUsagePanel(page, composer);

    if (exercise) {
      await composer.fill('整理检查结果，给出可复查的步骤。');
      await composer.press('Enter');
      const reply = page.getByTestId('transcript').locator('.agent-reply');
      await reply.getByRole('table').waitFor();
      assert.ok([...modules].some(url => /\/markdown-content-/.test(url)));
      assert.equal([...modules].some(url => /\/pi-/.test(url)), false);
      assert.equal(await reply.locator('.markdown-pending').count(), 0);
      await page.getByRole('button', { name: '发送', exact: true }).waitFor();

      await page.getByRole('button', { name: '主机', exact: true }).click();
      await page.getByLabel('Agent 后端').selectOption('pi');
      await page.getByRole('button', { name: '连接本机', exact: true }).click();
      await connected.getByText('Pi · 本机', { exact: true }).waitFor();
      assert.ok([...modules].some(url => /\/pi-/.test(url)));
    }
    assert.deepEqual(errors, []);
    return { label, firstOnDisplay, ...paint, renderer, rendererReady, chromiumProcesses, scripts, fonts,
      firstPanelMs, reopenPanelMs, inspectorLoaded,
      scriptBytes: scripts.reduce((sum, script) => sum + script.bytes, 0) };
  } finally {
    await app?.close();
    await rm(profile, { recursive: true, force: true, maxRetries: 3 });
  }
}

async function measureTrials(order, trials, display, freshDisplay = false) {
  for (const [index, label] of order.entries()) {
    const first = !trials.some(trial => trial.label === label);
    const exercise = label === 'candidate' && first;
    trials.push(await check(label === 'candidate' ? candidate : baseline, label, display,
      freshDisplay ? index === 0 : undefined, exercise, label === 'baseline' && first));
  }
}

async function measureFreshDisplay(order, trials) {
  const server = spawn('Xvfb', ['-displayfd', '1', '-screen', '0', '1440x960x24', '-nolisten', 'tcp'],
    { stdio: ['ignore', 'pipe', 'inherit'] });
  const exited = once(server, 'exit');
  try {
    const [display] = await Promise.race([
      once(server.stdout, 'data'),
      exited.then(() => { throw new Error('Xvfb exited before publishing its display.'); }),
    ]);
    const target = ':' + display.toString().trim();
    await measureTrials(order, trials, target, true);
  } finally {
    server.kill();
    await exited;
  }
}

const trials = [];
if (baseline && linux) {
  await measureFreshDisplay(['baseline', 'candidate', 'candidate', 'baseline'], trials);
  await measureFreshDisplay(['candidate', 'baseline', 'baseline', 'candidate'], trials);
} else if (baseline) await measureTrials(['baseline', 'candidate', 'candidate', 'baseline'], trials);
else await measureTrials(['candidate'], trials, process.env.DISPLAY);
console.log(JSON.stringify({ platform: process.platform, trials }, null, 2));
