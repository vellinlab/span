import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { _electron as electron } from 'playwright';

const [candidate, baseline, frameBaseline, screenshot] = process.argv.slice(2);
const linux = process.platform === 'linux';
const tail = '·'.repeat(145);

async function rendererPss(pid) {
  if (!linux) return undefined;
  const sample = await readFile(`/proc/${pid}/smaps_rollup`, 'utf8');
  return Number(sample.match(/^Pss:\s+(\d+) kB$/m)[1]);
}

function readPosition(transcript) {
  return transcript.evaluate(element => {
    const view = element.getBoundingClientRect();
    const first = [...element.querySelectorAll('.message[data-empty="false"]')].find(row => {
      const bounds = row.getBoundingClientRect();
      return bounds.bottom > view.top && bounds.top < view.bottom;
    });
    return { text: first?.textContent, offset: first?.getBoundingClientRect().top - view.top };
  });
}

async function assertReadingPosition(transcript, expected) {
  const actual = await readPosition(transcript);
  assert.equal(actual.text, expected.text);
  assert.ok(Math.abs(actual.offset - expected.offset) <= 2, `Reading offset changed from ${expected.offset} to ${actual.offset}`);
}

async function check(binary, label, following, cover = 'preview') {
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
    const position = following ? null : await readPosition(transcript);
    const preview = page.getByRole('complementary', { name: '文件预览' });
    if (cover === 'minimized') {
      await page.evaluate(() => {
        window.span.onWindowHidden(hidden => { window.testWindowHidden = hidden; });
      });
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].minimize());
      await page.waitForFunction(() => window.testWindowHidden === true, null, { polling: 50 });
      assert.ok(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMinimized()));
    } else {
      await page.getByRole('button', { name: '文件', exact: true }).click();
      await page.getByRole('button', { name: 'README.md' }).click();
      await preview.getByText('Span 工作台预览', { exact: true }).waitFor();
      assert.equal(await page.locator('main[inert]').count(), 1);
    }
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

    if (cover === 'minimized') {
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].restore());
      await page.waitForFunction(() => window.testWindowHidden === false, null, { polling: 50 });
      assert.ok(await app.evaluate(({ BrowserWindow }) => !BrowserWindow.getAllWindows()[0].isMinimized()));
    } else {
      await preview.getByRole('button', { name: '关闭预览' }).click();
    }
    if (!following) {
      await latest.waitFor();
      await assertReadingPosition(transcript, position);
      await latest.click();
    }
    await page.waitForFunction(tail => {
      const timeline = document.querySelector('[data-testid="transcript"]');
      return timeline.textContent.includes(tail) && timeline.scrollHeight - timeline.clientHeight - timeline.scrollTop < 40;
    }, tail);

    return { label, cover, following, dom, startPssKiB, endPssKiB,
      wallMs: (end.Timestamp - start.Timestamp) * 1000,
      rendererCpuMs: (end.ProcessTime - start.ProcessTime) * 1000,
      mainThreadCpuMs: (end.ThreadTime - start.ThreadTime) * 1000,
      taskMs: (end.TaskDuration - start.TaskDuration) * 1000,
      scriptMs: (end.ScriptDuration - start.ScriptDuration) * 1000,
      layouts: end.LayoutCount - start.LayoutCount };
  } finally {
    await app?.close();
    await rm(profile, { recursive: true, force: true, maxRetries: 3 });
  }
}

async function checkPreviewSwitch(binary) {
  const profile = await mkdtemp(join(tmpdir(), 'span-preview-switch-'));
  let app;
  let filename;
  try {
    await writeFile(join(profile, 'reasoning-details'), '');
    await writeFile(join(profile, 'reasoning-observers'), '');
    app = await electron.launch({
      executablePath: binary,
      args: ['--demo', '--disable-webgl', ...(linux ? ['--no-sandbox'] : [])],
      env: { ...process.env, SPAN_PREVIEW_PROFILE: profile, SPAN_PREVIEW_STREAM_GATE: profile },
    });
    const page = await app.firstWindow();
    await page.evaluate(() => {
      const observers = new Map();
      window.IntersectionObserver = class extends IntersectionObserver {
        constructor(callback, options) {
          super(callback, options);
          if (options?.root?.matches('#reasoning-panel .agent-panel-content')) observers.set(this, new Set());
        }

        observe(target) {
          super.observe(target);
          observers.get(this)?.add(target);
        }

        unobserve(target) {
          super.unobserve(target);
          observers.get(this)?.delete(target);
        }

        disconnect() {
          super.disconnect();
          observers.delete(this);
        }
      };
      window.readReasoningObservers = () => ({
        active: observers.size,
        targets: [...observers.values()].reduce((count, targets) => count + targets.size, 0),
      });
    });
    const readObservers = async (active, targets) => {
      await page.waitForFunction(targets => window.readReasoningObservers().targets === targets, targets);
      const observed = await page.evaluate(() => window.readReasoningObservers());
      assert.deepEqual(observed, { active, targets });
      return observed;
    };
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(800, 640));
    await page.waitForFunction(() => innerWidth <= 820 && innerHeight <= 660);
    const { cwd } = await page.evaluate(() => window.span.workspace(false));
    filename = join(cwd, `${basename(profile)}.md`);
    const paragraphs = Array.from({ length: 64 }, (_, index) => `${index + 1}. 核对工作区里的配置与命令输出。`);
    await writeFile(filename, `# 工作区复核记录\n\n${paragraphs.join('\n')}`);

    const transcript = page.getByTestId('transcript');
    const composer = page.getByRole('textbox', { name: '消息' });
    const goal = page.locator('.goal-strip');
    const strip = page.getByRole('button', { name: '实时推理摘要' });
    const detail = page.locator('#reasoning-panel .agent-panel-content');
    await transcript.getByText('第 160 项', { exact: false }).waitFor();
    await composer.fill('/goal 核对工作区的配置与命令输出');
    await composer.press('Enter');
    await goal.getByText('核对工作区的配置与命令输出').waitFor();
    await composer.fill('验证高频推理摘要。');
    await composer.press('Enter');
    await strip.getByText('开始复核长会话。').waitFor();
    await composer.fill('根据复核记录继续检查配置。');
    await composer.evaluate(element => element.setSelectionRange(2, 8));
    await strip.press('Enter');
    await detail.getByText('保留两级缩进', { exact: true }).waitFor();
    const openedObservers = await readObservers(1, 3);
    await detail.focus();
    const detailTop = await detail.evaluate(element => { element.scrollTop = 180; return element.scrollTop; });
    await transcript.evaluate(element => { element.scrollTop = 300; });
    await page.getByRole('button', { name: '滚到最新消息' }).waitFor();
    const transcriptTop = await transcript.evaluate(element => new Promise(resolve => {
      let previous = -1;
      let stableFrames = 0;
      let frames = 0;
      function sample() {
        const top = element.scrollTop;
        stableFrames = top === previous ? stableFrames + 1 : 0;
        previous = top;
        if (stableFrames >= 3) resolve(top);
        else if (++frames >= 30) resolve(0);
        else requestAnimationFrame(sample);
      }
      requestAnimationFrame(sample);
    }));
    assert.ok(detailTop > 0 && transcriptTop > 0);
    const reading = await readPosition(transcript);
    assert.ok(reading.text);
    const stripBounds = await strip.boundingBox();
    const readSummary = await strip.elementHandle();
    const initialSummary = await readSummary.textContent();

    await page.getByRole('button', { name: '文件', exact: true }).click();
    const file = page.getByRole('button', { name: basename(filename), exact: true });
    await file.press('Enter');
    const preview = page.getByRole('complementary', { name: '文件预览' });
    const content = preview.locator('.preview-content');
    await content.getByText('工作区复核记录').waitFor();
    const previewContent = await content.elementHandle();
    const fileTop = await content.evaluate(element => { element.scrollTop = 300; return element.scrollTop; });
    assert.equal(fileTop, 300);
    assert.ok(await page.locator('main[inert]').count());
    if (screenshot) await page.screenshot({ path: `${screenshot}-file.png` });
    await writeFile(join(profile, 'append'), '');
    const marker = join(profile, 'appended');
    for (let attempt = 0; attempt < 300 && !existsSync(marker); attempt++) await delay(25);
    assert.ok(existsSync(marker), 'The fixture must finish sending all 72 updates while the file covers the summary.');
    assert.equal(await readSummary.textContent(), initialSummary);

    await page.getByRole('button', { name: '返回会话', exact: true }).press('Enter');
    await strip.getByText('步骤 072', { exact: false }).waitFor();
    assert.deepEqual(await strip.boundingBox(), stripBounds);
    assert.ok(await readSummary.evaluate(element => element.isConnected));
    await assertReadingPosition(transcript, reading);
    assert.equal(await detail.evaluate(element => element.scrollTop), detailTop);
    assert.ok(await detail.evaluate(element => element === document.activeElement));
    assert.deepEqual(await composer.evaluate(({ value, selectionStart, selectionEnd }) =>
      [value, selectionStart, selectionEnd]), ['根据复核记录继续检查配置。', 2, 8]);
    assert.ok(await goal.evaluate(element => element.nextElementSibling.matches('form.composer') &&
      element.getBoundingClientRect().bottom < element.nextElementSibling.getBoundingClientRect().top));
    if (screenshot) await page.screenshot({ path: `${screenshot}-conversation.png` });
    await page.keyboard.press('PageDown');
    await page.waitForFunction(top => document.querySelector('#reasoning-panel .agent-panel-content').scrollTop > top, detailTop);
    await assertReadingPosition(transcript, reading);

    await page.getByRole('button', { name: '继续预览', exact: true }).press('Enter');
    await content.waitFor();
    assert.ok(await previewContent.evaluate(element => element.isConnected && element === document.activeElement));
    assert.equal(await content.evaluate(element => element.scrollTop), fileTop);
    await content.press('Escape');
    await preview.waitFor({ state: 'detached' });
    assert.ok(await file.evaluate(element => element === document.activeElement));
    await writeFile(join(profile, 'follow-detail'), '');
    await strip.getByText('步骤 073', { exact: false }).waitFor();
    await detail.press('Escape');
    await detail.waitFor({ state: 'detached' });
    const closedObservers = await readObservers(0, 0);
    await strip.press('Enter');
    await detail.getByText('步骤 073', { exact: false }).waitFor();
    const reopenedObservers = await readObservers(1, 3);
    await detail.evaluate(element => {
      element.focus({ preventScroll: true });
      element.scrollTop = 180;
      const top = element.getBoundingClientRect().top;
      const line = [...element.querySelectorAll('p strong')].find(node => node.getBoundingClientRect().top >= top);
      const text = line.firstChild;
      window.getSelection().setBaseAndExtent(text, 0, text, text.length);
    });
    const readSelection = () => detail.evaluate(element => {
      const selection = window.getSelection();
      const top = selection.rangeCount ? selection.getRangeAt(0).getBoundingClientRect().top : null;
      return { scrollTop: element.scrollTop, text: selection.toString(),
        offset: top === null ? null : top - element.getBoundingClientRect().top };
    });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const selection = await readSelection();
    assert.match(selection.text, /^复核记录 \d+$/);
    await writeFile(join(profile, 'finish'), '');
    await strip.waitFor({ state: 'detached' });
    const panel = page.getByRole('region', { name: '推理摘要' });
    await panel.getByText('已归档', { exact: true }).waitFor();
    const archivedObservers = await readObservers(0, 0);
    assert.deepEqual(await readSelection(), selection);
    assert.ok(await detail.evaluate(element => element === document.activeElement));
    await assertReadingPosition(transcript, reading);
    if (screenshot) await page.screenshot({ path: `${screenshot}-completed.png` });
    await detail.press('Escape');
    await panel.waitFor({ state: 'detached' });
    assert.ok(await composer.evaluate(element => element === document.activeElement));
    return { fileTop, transcriptTop, detailTop,
      reasoningObservers: { opened: openedObservers, closed: closedObservers, reopened: reopenedObservers, archived: archivedObservers } };
  } finally {
    await app?.close();
    if (filename) await rm(filename, { force: true });
    await rm(profile, { recursive: true, force: true, maxRetries: 3 });
  }
}

const previewSwitch = await checkPreviewSwitch(candidate);
const trials = [];
for (let trial = 0; trial < (baseline ? 2 : 1); trial++) {
  if (baseline) trials.push(await check(baseline, 'baseline', true));
  if (frameBaseline && trial === 0) trials.push(await check(frameBaseline, 'frame-baseline', true));
  trials.push(await check(candidate, 'candidate', true));
  if (frameBaseline && trial === 1) trials.push(await check(frameBaseline, 'frame-baseline', true));
}
trials.push(await check(candidate, 'candidate', false));
trials.push(await check(candidate, 'candidate', true, 'minimized'));
trials.push(await check(candidate, 'candidate', false, 'minimized'));
console.log(JSON.stringify({ platform: process.platform, previewSwitch, trials }, null, 2));
