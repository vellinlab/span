import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

const [candidate, baseline, screenshot] = process.argv.slice(2);
const linux = process.platform === 'linux';
const clockTicks = linux ? Number(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8' })) : undefined;

function largestFileMappings(smaps) {
  // Rank named mappings, which can also contain private copy-on-write pages.
  const files = new Map();
  let file;
  for (const line of smaps.split('\n')) {
    const mapping = line.match(/^[\da-f]+-[\da-f]+\s+\S+\s+[\da-f]+\s+[\da-f]+:[\da-f]+\s+\d+\s*(.*)$/);
    if (mapping) {
      file = mapping[1].startsWith('/') ? basename(mapping[1]) : undefined;
    } else if (file && line.startsWith('Pss:')) {
      const pssKiB = Number.parseInt(line.slice(4), 10);
      if (pssKiB > 0) files.set(file, (files.get(file) ?? 0) + pssKiB);
    }
  }
  return [...files].sort((left, right) => right[1] - left[1]).slice(0, 8)
    .map(([file, pssKiB]) => ({ file, pssKiB }));
}

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

async function chromiumFileMappings(processes) {
  if (!linux) return undefined;
  return Promise.all(processes.filter(process => !process.exitedDuringSampling).map(async ({ pid, type }) => {
    try {
      return { pid, type, files: largestFileMappings(await readFile(`/proc/${pid}/smaps`, 'utf8')) };
    } catch (error) {
      if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error;
      return { pid, type, exitedDuringSampling: true };
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

async function sendFirstMessage(page, composer) {
  const prompt = '整理检查结果，给出可复查的步骤。';
  await composer.fill(prompt);
  const frame = await composer.evaluateHandle((element, text) => ({
    seen: new Promise(resolve => {
      let start;
      element.addEventListener('keydown', event => {
        if (event.key === 'Enter') start = performance.now();
      }, { capture: true, once: true });
      const viewport = document.querySelector('.transcript-viewport');
      const observer = new MutationObserver(() => {
        if (start === undefined || viewport.querySelector('.user-message')?.textContent !== text) return;
        observer.disconnect();
        requestAnimationFrame(() => resolve(performance.now() - start));
      });
      observer.observe(viewport, { subtree: true, childList: true });
    }),
  }), prompt);
  try {
    await composer.press('Enter');
    await page.getByTestId('transcript').getByText(prompt, { exact: true }).waitFor();
    return await frame.evaluate(result => result.seen);
  } finally {
    await frame.dispose();
  }
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
    const fileMappings = await chromiumFileMappings(chromiumProcesses);
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
    const transcriptChunk = /(?:^|\/)transcript-(?!navigation-)[^/]+\.js$/;
    if (label === 'candidate') {
      assert.equal(scripts.some(script => /^(?:pi|markdown-content|agent-inspector)-/.test(script.name) || transcriptChunk.test(script.name)), false);
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
    const transcriptLoaded = () => [...modules].some(url => transcriptChunk.test(url));
    if (label === 'candidate') assert.equal(transcriptLoaded(), false, 'Usage can open without loading the transcript');
    const firstMessageFrameMs = await sendFirstMessage(page, composer);
    if (label === 'candidate') assert.ok(transcriptLoaded(), 'The first message loads the transcript');

    if (exercise) {
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
    return { label, firstOnDisplay, ...paint, renderer, rendererReady, chromiumProcesses, fileMappings, scripts, fonts,
      firstPanelMs, reopenPanelMs, firstMessageFrameMs, inspectorLoaded,
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
