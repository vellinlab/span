import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { _electron as electron } from 'playwright';

const [candidate, baseline] = process.argv.slice(2);
const linux = process.platform === 'linux';
const lastFragment = '追加记录 040。继续核对正在生成的结果。';

const settleFrame = page => page.evaluate(async () => {
  await new Promise(requestAnimationFrame);
  await new Promise(requestAnimationFrame);
});

async function waitForMarker(file) {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (existsSync(file)) return;
    await delay(25);
  }
  throw Error('The long-reply fixture did not publish all fragments.');
}

async function prepareInputSampling(app, page, composer) {
  const box = await composer.boundingBox();
  const area = { x: Math.ceil(box.x), y: Math.ceil(box.y), width: 56, height: 24 };
  await composer.evaluate(element => { element.style.caretColor = 'transparent'; });
  const pixels = async value => {
    await composer.fill(value);
    await settleFrame(page);
    return app.evaluate(async ({ BrowserWindow }, rect) => {
      const capture = await BrowserWindow.getAllWindows()[0].webContents.capturePage(rect);
      return capture.toBitmap().toString('hex');
    }, area);
  };
  const inserted = await pixels('MMW');
  const removed = await pixels('MM');
  assert.ok(inserted.length && removed.length && inserted !== removed, 'Composer pixels must reflect the input.');
  await composer.press('End');
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
    state.pending = {
      pixels: Buffer.from(expected, 'hex'),
      start: performance.now(),
      resolve(latency) {
        clearTimeout(timer);
        state.pending = null;
        resolve(latency);
      },
    };
    if (append) contents.sendInputEvent({ type: 'char', keyCode: 'W' });
    else {
      contents.sendInputEvent({ type: 'keyDown', keyCode: 'Backspace' });
      contents.sendInputEvent({ type: 'keyUp', keyCode: 'Backspace' });
    }
  }), { append, expected: append ? inserted : removed });
  // Verify both paint events and exact pixels before recording timed inputs.
  await input(true);
  await input(false);
  return async () => {
    const startFrames = await app.evaluate(() => globalThis.spanLongReplyInput.frames);
    const samples = [];
    for (let index = 0; index < 14; index++) {
      await delay(index % 2 ? 139 : 73);
      samples.push(await input(index % 2 === 0));
    }
    const frames = await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].webContents.endFrameSubscription();
      return globalThis.spanLongReplyInput.frames;
    });
    const sorted = [...samples].sort((a, b) => a - b);
    return { samples, p95Ms: sorted[Math.ceil(sorted.length * .95) - 1], observedFrames: frames - startFrames };
  };
}

async function check(binary, label) {
  const profile = await mkdtemp(join(tmpdir(), 'span-long-reply-'));
  let app;
  try {
    app = await electron.launch({
      executablePath: binary,
      args: ['--demo', '--force-device-scale-factor=1',
        ...(linux ? ['--no-sandbox', '--disable-gpu', '--disable-webgl'] : [])],
      env: { ...process.env, SPAN_PREVIEW_PROFILE: profile, SPAN_PREVIEW_STREAM_GATE: profile },
    });
    const page = await app.firstWindow();
    const rendererPid = await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      window.setContentSize(800, 640);
      return window.webContents.getOSProcessId();
    });
    await page.waitForFunction(() => innerWidth === 800 && innerHeight === 640);
    const composer = page.getByRole('textbox', { name: '消息' });
    const transcript = page.getByTestId('transcript');
    await transcript.getByText('第 160 项', { exact: false }).waitFor();
    await composer.fill('验证长回复末尾。');
    await composer.press('Enter');
    const heading = transcript.getByRole('heading', { name: '长回复的开头', exact: true });
    const initialTail = transcript.getByRole('heading', { name: '预置正文末尾', exact: true });
    const latest = page.getByRole('button', { name: '滚到最新消息' });
    await initialTail.waitFor();
    await heading.evaluate(element => {
      const timeline = element.closest('.timeline');
      timeline.scrollTop += element.getBoundingClientRect().top - timeline.getBoundingClientRect().top - 28;
    });
    await latest.waitFor();
    const sampleInput = linux && baseline ? await prepareInputSampling(app, page, composer) : undefined;
    await settleFrame(page);
    const headingOffset = () => heading.evaluate(element =>
      element.getBoundingClientRect().top - element.closest('.timeline').getBoundingClientRect().top);
    const position = await headingOffset();

    const observation = await heading.evaluateHandle(element => {
      const parent = element.closest('.prose');
      let mutationBatches = 0;
      const observer = new MutationObserver(() => { mutationBatches++; });
      observer.observe(parent, { childList: true, subtree: true, characterData: true });
      return () => { observer.disconnect(); return mutationBatches; };
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
    await settleFrame(page);
    const end = await metrics();
    const endPssKiB = await pss();
    const mutationBatches = await observation.evaluate(read => read());
    await observation.dispose();
    const offset = await headingOffset();
    assert.ok(Math.abs(offset - position) <= 2, `Reading anchor moved from ${position} to ${offset}.`);
    if (typing) assert.equal(await composer.inputValue(), 'MM');
    const fragment = transcript.getByText(lastFragment, { exact: true });
    if (label === 'baseline') assert.ok(mutationBatches > 0);
    else {
      assert.equal(mutationBatches, 0);
      assert.equal(await fragment.count(), 0);
    }

    await initialTail.evaluate(element => {
      const timeline = element.closest('.timeline');
      timeline.scrollTop += element.getBoundingClientRect().bottom - timeline.getBoundingClientRect().bottom - 74;
    });
    await fragment.waitFor();
    await latest.click();
    await page.waitForFunction(() => {
      const timeline = document.querySelector('.timeline');
      return timeline.scrollHeight - timeline.clientHeight - timeline.scrollTop <= 2;
    });
    assert.ok(await fragment.evaluate(element =>
      element.getBoundingClientRect().bottom <= element.closest('.timeline').getBoundingClientRect().bottom));
    await writeFile(join(profile, 'finish'), '');
    await transcript.getByText('长回复已全部生成。', { exact: true }).waitFor();
    const link = transcript.getByRole('link', { name: '复核链接' });
    assert.equal(await link.getAttribute('href'), 'https://example.com/span');
    assert.equal(await link.evaluate(element => {
      const selection = element.ownerDocument.getSelection();
      selection.selectAllChildren(element);
      return selection.toString();
    }), '复核链接');
    return { label, mutationBatches, startPssKiB, endPssKiB, typing,
      rendererCpuMs: (end.ProcessTime - start.ProcessTime) * 1000,
      mainThreadCpuMs: (end.ThreadTime - start.ThreadTime) * 1000,
      scriptMs: (end.ScriptDuration - start.ScriptDuration) * 1000,
      layouts: end.LayoutCount - start.LayoutCount };
  } finally {
    await app?.close();
    await rm(profile, { recursive: true, force: true, maxRetries: 3 });
  }
}

const trials = [];
for (let trial = 0; trial < (baseline ? 2 : 1); trial++) {
  if (baseline) trials.push(await check(baseline, 'baseline'));
  trials.push(await check(candidate, 'candidate'));
}
console.log(JSON.stringify({ platform: process.platform, trials }, null, 2));
