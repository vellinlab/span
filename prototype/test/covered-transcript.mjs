import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron } from 'playwright';

const [candidate, baseline] = process.argv.slice(2);
const linux = process.platform === 'linux';
const tail = '·'.repeat(145);

async function rendererPss(pid) {
  if (!linux) return undefined;
  const sample = await readFile(`/proc/${pid}/smaps_rollup`, 'utf8');
  return Number(sample.match(/^Pss:\s+(\d+) kB$/m)[1]);
}

async function check(binary, label, following) {
  const profile = await mkdtemp(join(tmpdir(), 'span-covered-'));
  let app;
  try {
    app = await electron.launch({
      executablePath: binary,
      args: ['--demo', '--disable-webgl', ...(linux ? ['--no-sandbox'] : [])],
      env: { ...process.env, SPAN_PREVIEW_PROFILE: profile },
    });
    const page = await app.firstWindow();
    const rendererPid = await app.evaluate(({ BrowserWindow }) => {
      const workbench = BrowserWindow.getAllWindows()[0];
      workbench.setContentSize(800, 640);
      return workbench.webContents.getOSProcessId();
    });
    await page.waitForFunction(() => innerWidth <= 820 && innerHeight <= 660);
    const transcript = page.getByTestId('transcript');
    await transcript.getByText('第 160 项', { exact: false }).waitFor();
    const composer = page.getByRole('textbox', { name: '消息' });
    await composer.fill('验证预览期间的流式会话。');
    await composer.press('Enter');
    const reply = transcript.locator('[data-kind="message"]').filter({ hasText: '流式输出已接通。' });
    await reply.waitFor();
    const latest = page.getByRole('button', { name: '滚到最新消息' });
    if (!following) {
      await transcript.evaluate(element => { element.scrollTop = 300; });
      await latest.waitFor();
    }
    const readPosition = () => transcript.evaluate(element => {
      const top = element.getBoundingClientRect().top;
      const first = [...element.querySelectorAll('.message[data-empty="false"]')]
        .find(row => row.getBoundingClientRect().bottom > top);
      return { text: first?.textContent, offset: first?.getBoundingClientRect().top - top };
    });
    const position = following ? null : await readPosition();
    await page.getByRole('button', { name: '文件', exact: true }).click();
    await page.getByRole('button', { name: 'README.md' }).click();
    const preview = page.getByRole('complementary', { name: '文件预览' });
    await preview.getByText('Span 工作台预览', { exact: true }).waitFor();
    assert.equal(await page.locator('main[inert]').count(), 1);
    const stop = page.locator('.send.stop:enabled');
    await stop.waitFor();

    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Performance.enable');
    const measure = async () => {
      const { metrics } = await cdp.send('Performance.getMetrics');
      return Object.fromEntries(metrics.map(({ name, value }) => [name, value]));
    };
    const observation = following ? await reply.evaluateHandle(element => {
      let mutationBatches = 0;
      const observer = new MutationObserver(() => { mutationBatches++; });
      observer.observe(element, { childList: true, subtree: true, characterData: true });
      const firstText = element.textContent;
      return () => {
        observer.disconnect();
        return { mutationBatches, changed: firstText !== element.textContent, mounted: element.isConnected };
      };
    }) : null;
    const start = await measure();
    const startPssKiB = await rendererPss(rendererPid);
    await stop.waitFor({ state: 'detached', timeout: 15_000 });
    const end = await measure();
    const endPssKiB = await rendererPss(rendererPid);
    const dom = await observation?.evaluate(read => read());
    await observation?.dispose();
    if (label === 'baseline') assert.ok(dom.changed && dom.mutationBatches > 0, 'The baseline must exercise hidden Markdown updates');
    else if (following) assert.deepEqual(dom, { mutationBatches: 0, changed: false, mounted: true });

    await preview.getByRole('button', { name: '关闭预览' }).click();
    if (!following) {
      await latest.waitFor();
      const restored = await readPosition();
      assert.equal(restored.text, position.text);
      assert.ok(Math.abs(restored.offset - position.offset) <= 2);
      await latest.click();
    }
    await page.waitForFunction(tail => {
      const timeline = document.querySelector('[data-testid="transcript"]');
      return timeline.textContent.includes(tail) && timeline.scrollHeight - timeline.clientHeight - timeline.scrollTop < 40;
    }, tail);

    return { label, following, dom, startPssKiB, endPssKiB,
      wallMs: (end.Timestamp - start.Timestamp) * 1000,
      taskMs: (end.TaskDuration - start.TaskDuration) * 1000,
      scriptMs: (end.ScriptDuration - start.ScriptDuration) * 1000,
      layouts: end.LayoutCount - start.LayoutCount };
  } finally {
    await app?.close();
    await rm(profile, { recursive: true, force: true, maxRetries: 3 });
  }
}

const trials = [];
for (let trial = 0; trial < (baseline ? 2 : 1); trial++) {
  if (baseline) trials.push(await check(baseline, 'baseline', true));
  trials.push(await check(candidate, 'candidate', true));
}
trials.push(await check(candidate, 'candidate', false));
console.log(JSON.stringify({ platform: process.platform, trials }, null, 2));
