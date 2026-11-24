import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron } from 'playwright';

const [candidate, screenshot, baseline] = process.argv.slice(2);
const lastLine = 'warning: 已核对全部命令输出。';
const shortResult = '  发现一项配置异常。\n' + '  保留后续检查记录。\n'.repeat(18);
const fullCommand = [
  'workspace inspect --profile desktop --path prototype/resources/workbench/verification/candidate \\',
  '\t--check output-and-history --keep-annotations \\',
  '    --include-summary',
].join('\n');

async function check(binary, legacy, screenshot) {
  const profile = await mkdtemp(join(tmpdir(), 'span-output-'));
  let app;
  try {
    app = await electron.launch({
      executablePath: binary,
      args: ['--demo', ...(process.platform === 'linux' ? ['--no-sandbox', '--disable-webgl'] : ['--terminal-renderer=dom'])],
      env: { ...process.env, SPAN_PREVIEW_PROFILE: profile },
    });
    const page = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(740, 520));
    await page.waitForFunction(() => innerWidth <= 760 && innerHeight <= 540);
    const timeline = page.getByTestId('transcript');
    await timeline.getByText('第 160 项', { exact: false }).waitFor();
    await page.getByRole('button', { name: '切换终端' }).click();
    await page.locator('.xterm-helper-textarea').waitFor();
    const composer = page.getByRole('textbox', { name: '消息' });
    await composer.fill('验证完整命令输出。');
    await composer.press('Enter');
    const command = timeline.locator('[data-card="command"]').filter({ hasText: 'workspace verify --all' });
    const summary = command.locator('summary');
    await summary.getByText('退出码 3', { exact: true }).waitFor();
    await summary.getByText('失败', { exact: true }).waitFor();
    await timeline.getByText('检查已结束。', { exact: true }).waitFor();
    assert.equal(await command.locator('pre').count(), 0);
    await summary.click();
    const viewport = command.locator('pre');
    await viewport.waitFor();
    await command.evaluate(async element => {
      const timeline = element.closest('.timeline');
      let stableFrames = 0;
      for (let frame = 0; frame < 30; frame++) {
        const delta = element.getBoundingClientRect().top - timeline.getBoundingClientRect().top - 6;
        if (Math.abs(delta) <= 1) {
          if (++stableFrames === 3) return;
        } else {
          stableFrames = 0;
          timeline.scrollTop += delta;
        }
        await new Promise(requestAnimationFrame);
      }
    });
    if (screenshot) await page.screenshot({ path: screenshot });
    if (legacy) {
      const displayed = await viewport.textContent();
      assert.equal(displayed.length, 256 * 1024 + 2);
      assert.ok(displayed.endsWith('\n…') && !displayed.includes(lastLine));
      return { mountedCharacters: displayed.length };
    }
    assert.equal(await command.locator('.command-text').count(), 0);

    const lines = viewport.locator('.output-line');
    await lines.getByText('prepare', { exact: false }).waitFor();
    const mountedAtStart = await lines.count();
    assert.ok(mountedAtStart > 0 && mountedAtStart <= 40);
    const navigation = command.getByRole('navigation', { name: '输出分页' });
    await navigation.getByText('1–8192 行', { exact: true }).waitFor();
    assert.ok(await navigation.evaluate(element => {
      const view = element.closest('.timeline').getBoundingClientRect();
      const controls = element.getBoundingClientRect();
      return controls.top >= view.top && controls.bottom <= view.bottom;
    }), 'Output controls fit above the composer and terminal');
    const selected = await lines.first().evaluate(element => {
      const selection = window.getSelection();
      selection.selectAllChildren(element);
      const text = selection.toString();
      selection.removeAllRanges();
      return text;
    });
    assert.ok(selected.startsWith('    prepare\t'));
    const outerPosition = await timeline.evaluate(element => element.scrollTop);
    await viewport.evaluate(element => element.scrollTo({ top: 1e8, left: 0 }));
    await lines.getByText('feature_08191.rs', { exact: false }).waitFor();
    assert.equal(await timeline.evaluate(element => element.scrollTop), outerPosition);
    const next = navigation.getByRole('button', { name: '下一段' });
    await next.click();
    await lines.getByText('feature_08192.rs', { exact: false }).waitFor();
    await navigation.getByText('8193–16384 行', { exact: true }).waitFor();
    await next.press('Enter');
    await lines.getByText('feature_16384.rs', { exact: false }).waitFor();
    await navigation.getByText('16385–20001 行', { exact: true }).waitFor();
    assert.equal(await next.getAttribute('aria-disabled'), 'true');
    assert.ok(await next.evaluate(element => element === document.activeElement));
    await viewport.evaluate(element => element.scrollTo({ top: 1e8, left: 0 }));
    await lines.getByText(lastLine, { exact: true }).waitFor();
    const mountedAtEnd = await lines.count();
    assert.ok(mountedAtEnd > 0 && mountedAtEnd <= 40);
    if (screenshot) await page.screenshot({ path: screenshot.replace(/\.png$/, '-end.png') });
    await command.getByRole('button', { name: '复制输出' }).click();
    await command.locator('[title="已复制输出"]').waitFor();
    const readClipboard = async () => (await app.evaluate(({ clipboard }) => clipboard.readText())).replaceAll('\r\n', '\n');
    const raw = await readClipboard();
    assert.ok(raw.length > 256 * 1024 && raw.startsWith('    prepare\t') && raw.endsWith(lastLine + '\n'));
    assert.equal(raw.split('\n').length, 20_002);
    await summary.click();
    await viewport.waitFor({ state: 'detached' });
    const shortTool = timeline.locator('[data-card="tool"]').filter({ hasText: '核对异常项' });
    await shortTool.locator('summary').click();
    const shortOutput = shortTool.locator('pre');
    assert.equal(await shortOutput.textContent(), shortResult);
    assert.ok(await shortOutput.evaluate(element => {
      const available = Math.max(72, element.closest('.timeline').clientHeight - 145);
      return element.scrollHeight > element.clientHeight && element.clientHeight <= available + 1;
    }));
    assert.equal(await shortTool.locator('.output-line').count(), 0);
    assert.equal(await shortTool.getByRole('navigation').count(), 0);
    await shortTool.getByRole('button', { name: '复制输出' }).click();
    await shortTool.locator('[title="已复制输出"]').waitFor();
    assert.equal(await readClipboard(), shortResult);

    const longCard = timeline.locator('[data-card="command"]').filter({ hasText: 'workspace inspect --profile desktop' });
    const longSummary = longCard.locator('summary');
    const outcome = longSummary.locator('.card-status[data-status="failed"]');
    await outcome.getByText('退出码 17', { exact: true }).waitFor();
    await outcome.getByText('失败', { exact: true }).waitFor();
    assert.ok(await longSummary.evaluate(element => {
      const label = element.querySelector('.card-title');
      const status = element.querySelector('.card-status');
      return label.scrollWidth > label.clientWidth && status.scrollWidth === status.clientWidth &&
        status.getBoundingClientRect().right <= element.getBoundingClientRect().right;
    }));
    const original = longCard.getByLabel('完整命令');
    assert.equal(await original.count(), 0);
    await longSummary.press('Enter');
    await original.waitFor();
    assert.equal(await original.textContent(), fullCommand);
    await original.focus();
    assert.ok(await original.evaluate(element => element === document.activeElement));
    if (screenshot) {
      await longCard.evaluate(async element => {
        const frame = () => new Promise(requestAnimationFrame);
        await frame();
        await frame();
        const view = element.closest('.timeline');
        view.scrollTop += element.getBoundingClientRect().top - view.getBoundingClientRect().top - 6;
        await frame();
      });
      await page.screenshot({ path: screenshot.replace(/\.png$/, '-command.png') });
    }
    await longCard.getByRole('button', { name: '复制命令' }).click();
    await longCard.locator('[title="已复制命令"]').waitFor();
    assert.equal(await readClipboard(), fullCommand);
    await longSummary.press('Enter');
    await original.waitFor({ state: 'detached' });
    return { mountedAtStart, mountedAtEnd, rawLines: 20_001, rawCharacters: raw.length };
  } finally {
    await app?.close();
    await rm(profile, { recursive: true, force: true, maxRetries: 3 });
  }
}

const prior = baseline ? await check(baseline, true, screenshot?.replace(/\.png$/, '-before.png')) : undefined;
const current = await check(candidate, false, screenshot);
console.log(JSON.stringify({ platform: process.platform, prior, current }, null, 2));
