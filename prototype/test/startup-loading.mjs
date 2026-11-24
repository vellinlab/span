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

async function rendererStats(pid) {
  if (!linux) return {};
  const memory = await readFile(`/proc/${pid}/smaps_rollup`, 'utf8');
  const get = name => Number(memory.match(new RegExp('^' + name + ':\\s+(\\d+)', 'm'))[1]);
  const processStat = await readFile(`/proc/${pid}/stat`, 'utf8');
  const columns = processStat.slice(processStat.lastIndexOf(')') + 2).split(' ');
  return { pssKiB: get('Pss'), rssKiB: get('Rss'), privateDirtyKiB: get('Private_Dirty'),
    cpuMs: (Number(columns[11]) + Number(columns[12])) * 1000 / clockTicks };
}

async function check(binary, label, display, firstOnDisplay, exercise) {
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
    const renderer = await rendererStats(rendererPid);

    // Enabling Debugger reports previously parsed scripts without needing instrumentation in either renderer.
    const cdp = await page.context().newCDPSession(page);
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
      assert.equal(scripts.some(script => /^(?:pi|markdown-content)-/.test(script.name)), false);
    }
    if (screenshot && firstOnDisplay && label === 'baseline') {
      await page.screenshot({ path: screenshot.replace(/\.png$/, '-baseline.png') });
    }

    if (exercise) {
      if (screenshot) await page.screenshot({ path: screenshot });
      const composer = page.getByRole('textbox', { name: '消息' });
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
    return { label, firstOnDisplay, ...paint, renderer, scripts,
      scriptBytes: scripts.reduce((sum, script) => sum + script.bytes, 0) };
  } finally {
    await app?.close();
    await rm(profile, { recursive: true, force: true, maxRetries: 3 });
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
    for (const [index, label] of order.entries()) {
      const exercise = label === 'candidate' && !trials.some(trial => trial.label === 'candidate');
      trials.push(await check(label === 'candidate' ? candidate : baseline, label, target, index === 0, exercise));
    }
  } finally {
    server.kill();
    await exited;
  }
}

const trials = [];
if (baseline) {
  await measureFreshDisplay(['baseline', 'candidate', 'candidate', 'baseline'], trials);
  await measureFreshDisplay(['candidate', 'baseline', 'baseline', 'candidate'], trials);
} else {
  trials.push(await check(candidate, 'candidate', process.env.DISPLAY, undefined, true));
}
console.log(JSON.stringify({ platform: process.platform, trials }, null, 2));
