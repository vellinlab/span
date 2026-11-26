import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron } from 'playwright';

const [candidate, screenshot, baseline] = process.argv.slice(2);
const mainFile = 'prototype/ui/workbench.css';
const lastLine = '+    include(record_5000, "new workbench rule");';
const reply = '已记录文件变更。\n\n```text\npatch preview ready\n```';

async function checkReview(page, composer, profile, legacy, screenshot) {
  await composer.fill('/review');
  await composer.press('Enter');
  const userEcho = page.locator('.user-message').getByText('current changes', { exact: true });
  const raw = page.getByText('{"findings":[]}', { exact: true });
  const reasoning = page.locator('.reasoning-strip');
  if (legacy) {
    await userEcho.waitFor();
    await raw.waitFor();
  } else {
    await page.locator('[data-card="notice"]').getByText('当前工作区改动', { exact: true }).waitFor();
    await reasoning.getByText('核对改动和对应的会话状态。', { exact: true }).waitFor();
    assert.equal(await userEcho.count(), 0);
    assert.equal(await raw.count(), 0);
  }
  if (screenshot && !legacy) await page.screenshot({ path: screenshot.replace(/\.png$/, '-running.png') });
  await writeFile(join(profile, 'finish-inline-review'), '');
  const findingSelector = '[data-kind="message"] li';
  const finding = page.locator(findingSelector).filter({ hasText: '[P2] 保留阅读位置' });
  await finding.waitFor();
  await reasoning.waitFor({ state: 'detached' });
  const completion = page.getByText('代码审查完成', { exact: true });
  assert.equal(await completion.count(), Number(legacy));
  assert.equal(await finding.count(), 1);
  await page.waitForFunction(selector => {
    const finding = [...document.querySelectorAll(selector)]
      .find(item => item.textContent.includes('[P2] 保留阅读位置'))?.getBoundingClientRect();
    const viewport = document.querySelector('.timeline').getBoundingClientRect();
    return finding && finding.top >= viewport.top && finding.bottom <= viewport.bottom;
  }, findingSelector);
  if (screenshot) await page.screenshot({ path: screenshot });
}

async function check(binary, legacy, screenshot) {
  const profile = await mkdtemp(join(tmpdir(), 'span-patch-'));
  let app;
  try {
    app = await electron.launch({
      executablePath: binary,
      args: ['--demo', ...(process.platform === 'linux' ? ['--no-sandbox', '--disable-webgl'] : [])],
      env: { ...process.env, SPAN_PREVIEW_PROFILE: profile, SPAN_PREVIEW_STREAM_GATE: profile },
    });
    const page = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(740, 520));
    await page.waitForFunction(() => innerWidth <= 760 && innerHeight <= 540);
    await page.getByText('第 160 项', { exact: false }).waitFor();
    const composer = page.getByRole('textbox', { name: '消息' });
    const readClipboard = async () => (await app.evaluate(({ clipboard }) => clipboard.readText())).replaceAll('\r\n', '\n');
    const reviewShot = legacy ? screenshot?.replace(/-before\.png$/, '-review-before.png')
      : screenshot?.replace(/\.png$/, '-review.png');
    await checkReview(page, composer, profile, legacy, reviewShot);
    if (!legacy) {
      await composer.fill('/copy');
      await composer.press('Enter');
      await page.waitForFunction(() => document.querySelector('.composer textarea').value === '');
      assert.ok((await readClipboard()).includes('[P2] 保留阅读位置'));
    }
    await composer.fill('验证长差异与文件切换。');
    await composer.press('Enter');
    const patch = page.locator('[data-card="patch"]');
    const summary = patch.locator('summary');
    await summary.getByText('文件变更', { exact: true }).waitFor();
    assert.equal(await patch.locator('pre').count(), 0);
    await summary.click();
    const viewport = patch.locator(legacy ? '.diff' : '.diff-scroll').first();
    await viewport.locator(legacy ? 'span' : '.diff-line').first().waitFor();
    const reveal = () => patch.evaluate(element => {
      const timeline = element.closest('.timeline');
      timeline.scrollTop += element.getBoundingClientRect().top - timeline.getBoundingClientRect().top - 10;
    });
    await reveal();
    if (screenshot) await page.screenshot({ path: screenshot });
    const mountedAtStart = await patch.locator(legacy ? '.diff span' : '.diff-line').count();
    if (legacy) {
      assert.ok(mountedAtStart > 3000 && !await viewport.getByText(lastLine, { exact: true }).count());
      return { mountedAtStart };
    }

    assert.ok(mountedAtStart <= 40);
    const timeline = page.getByTestId('transcript');
    const wheelUpFromDiff = async () => {
      await viewport.hover();
      const before = await timeline.evaluate(element => element.scrollTop);
      assert.ok(before > 160, 'The transcript must have room to scroll up.');
      await viewport.evaluate(element => {
        element.receivedDiffWheel = false;
        element.addEventListener('wheel', event => {
          element.receivedDiffWheel = event.isTrusted && event.deltaY < 0;
        }, { once: true, passive: true });
      });
      await page.mouse.wheel(0, -144);
      await page.waitForFunction(() => document.querySelector('.diff-scroll')?.receivedDiffWheel);
      // On Windows a wheel burst can continue moving the viewport after input dispatch.
      await page.evaluate(async () => {
        for (let frame = 0; frame < 16; frame++) await new Promise(requestAnimationFrame);
      });
      return before - await timeline.evaluate(element => element.scrollTop);
    };
    assert.ok(Math.abs(await wheelUpFromDiff()) <= 2, 'The first line of a long diff must hold the transcript position.');
    const pages = patch.getByRole('navigation', { name: '差异分页' });
    assert.ok(await pages.evaluate(element => {
      const timeline = element.closest('.timeline').getBoundingClientRect();
      const controls = element.getBoundingClientRect();
      return controls.top >= timeline.top && controls.bottom <= timeline.bottom;
    }));
    await viewport.locator('[data-tone="meta"]').getByText('+++ b/' + mainFile, { exact: true }).waitFor();
    await viewport.locator('[data-tone="add"]').getByText('+++ new source prefix', { exact: true }).waitFor();
    const firstAddition = viewport.getByText('+ include(record_0001, "new workbench rule");', { exact: false });
    const selection = await firstAddition.evaluate(element => {
      const range = document.createRange();
      range.selectNodeContents(element);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      const text = selection.toString();
      selection.removeAllRanges();
      return text;
    });
    assert.ok(selection.startsWith('+    ') && selection.includes('\t// '));
    const scroll = async (top, left) => viewport.evaluate((element, [top, left]) => {
      element.scrollTo({ top, left });
    }, [top, left]);
    const position = () => viewport.evaluate(element => [element.scrollTop, element.scrollLeft]);
    await scroll(0, 120);
    await scroll(14000, 120);
    const before = await position();
    assert.deepEqual(before, [14000, 120]);
    const files = patch.getByRole('combobox', { name: '变更文件' });
    const reopenPatch = async () => {
      await summary.press('Enter');
      await viewport.waitFor({ state: 'detached' });
      await summary.press('Enter');
      await viewport.waitFor();
      assert.ok(await summary.evaluate(element => element === document.activeElement));
    };
    await files.selectOption({ label: 'prototype/REVIEW.md' });
    await viewport.getByText('保留原文和缩进。', { exact: false }).waitFor();
    assert.deepEqual(await position(), [0, 0]);
    await reopenPatch();
    await viewport.getByText('保留原文和缩进。', { exact: false }).waitFor();
    assert.equal(await files.evaluate(field => field.selectedOptions[0].label), 'prototype/REVIEW.md');
    assert.ok(await viewport.evaluate(element => element.scrollHeight === element.clientHeight));
    assert.ok(await wheelUpFromDiff() > 40, 'A diff that fits should allow the transcript to scroll.');
    await reveal();
    await files.selectOption({ label: 'prototype/sample/README.md' });
    await patch.getByText('没有可显示的差异。', { exact: true }).waitFor();
    assert.equal(await viewport.count(), 0);
    await files.selectOption({ label: mainFile });
    await viewport.waitFor();
    assert.deepEqual(await position(), before);

    await scroll(1e8, 0);
    await viewport.getByText('- include(record_4094, "old workbench rule");', { exact: true }).waitFor();
    await pages.getByRole('button', { name: '下一段' }).click();
    await viewport.getByText('+ include(record_4094, "new workbench rule");', { exact: true }).waitFor();
    await scroll(1e8, 0);
    await viewport.getByText(lastLine, { exact: true }).waitFor();
    const mountedAtEnd = await patch.locator('.diff-line').count();
    assert.ok(mountedAtEnd <= 40);

    const copy = patch.getByRole('button', { name: '复制差异' });
    await copy.click();
    await patch.locator('[title="已复制差异"]').waitFor({ timeout: 5000 });
    const raw = await readClipboard();
    assert.ok(raw.startsWith('--- a/' + mainFile) && raw.endsWith(lastLine + '\n'));
    assert.equal(raw.split('\n').length, 10006);
    const endPosition = await position();
    const checkRestoredPage = async () => {
      await viewport.getByText(lastLine, { exact: true }).waitFor();
      assert.equal(await viewport.getAttribute('data-page'), '1');
      assert.deepEqual(await position(), endPosition);
      assert.ok(await patch.locator('.diff-line').count() <= 40);
    };
    await reopenPatch();
    await checkRestoredPage();
    const beforeLeaving = await timeline.evaluate(element => element.scrollTop);
    await timeline.evaluate(element => { element.scrollTop = Math.max(200, element.scrollTop - 2400); });
    await patch.waitFor({ state: 'detached' });
    await timeline.evaluate((element, top) => { element.scrollTop = top; }, beforeLeaving);
    await checkRestoredPage();
    await summary.click();
    await patch.locator('.diff-scroll').waitFor({ state: 'detached' });
    await page.locator('.code-card').filter({ hasText: 'patch preview ready' }).getByRole('button', { name: '复制代码' }).click();
    for (let retry = 0; retry < 80 && (await readClipboard()).trim() !== 'patch preview ready'; retry++) {
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.equal((await readClipboard()).trim(), 'patch preview ready');
    await composer.fill('/copy');
    await composer.press('Enter');
    await page.waitForFunction(() => document.querySelector('.composer textarea').value === '');
    assert.equal(await readClipboard(), reply);
    await assert.rejects(page.evaluate(() => window.span.copyText({ text: '无效测试文本' })), /无效的剪贴板文本/);
    assert.equal(await readClipboard(), reply);
    await composer.fill('/d');
    await page.getByRole('button', { name: /\/diff 查看工作区 Git 改动/ }).waitFor();
    await composer.fill('/diff');
    await composer.press('Enter');
    const workspaceDiff = page.getByRole('region', { name: '工作区 Git 改动' });
    await workspaceDiff.locator('[data-tone="add"]').getByText('+新的工作区说明', { exact: true }).waitFor();
    const lastPath = workspaceDiff.getByRole('region', { name: '未跟踪文件' }).getByText('docs/空间 目录.md', { exact: true });
    await lastPath.waitFor();
    const closeDiff = workspaceDiff.getByRole('button', { name: '关闭面板' });
    assert.ok(await closeDiff.evaluate(button => button === document.activeElement));
    if (screenshot) await page.screenshot({ path: screenshot.replace(/\.png$/, '-workspace.png') });
    assert.ok(await lastPath.evaluate(element => element.getBoundingClientRect().bottom <=
      element.closest('.agent-panel-content').getBoundingClientRect().bottom + 1), 'Both untracked paths fit in the narrow panel');
    await closeDiff.press('Escape');
    assert.ok(await composer.evaluate(element => element === document.activeElement));
    await composer.fill('/diff turn');
    await composer.press('Enter');
    const turnDiff = page.getByRole('region', { name: '最近一次会话补丁' });
    await turnDiff.getByRole('combobox', { name: '变更文件' }).waitFor();
    await turnDiff.getByRole('button', { name: '关闭面板' }).press('Escape');
    return { mountedAtStart, mountedAtEnd, rawLines: 10005 };
  } finally {
    await app?.close();
    await rm(profile, { recursive: true, force: true, maxRetries: 3 });
  }
}

const prior = baseline ? await check(baseline, true, screenshot?.replace(/\.png$/, '-before.png')) : undefined;
const current = await check(candidate, false, screenshot);
console.log(JSON.stringify({ platform: process.platform, prior, current }, null, 2));
