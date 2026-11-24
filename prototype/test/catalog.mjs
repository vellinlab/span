import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron } from 'playwright';

const [binary, screenshot] = process.argv.slice(2);
const profile = await mkdtemp(join(tmpdir(), 'span-catalog-'));
const app = await electron.launch({
  executablePath: binary, args: ['--demo', ...(process.platform === 'linux' ? ['--no-sandbox'] : [])],
  env: { ...process.env, SPAN_PREVIEW_PROFILE: profile, SPAN_PREVIEW_CATALOG_FIXTURE: 'paged' },
});

try {
  const page = await app.firstWindow();
  const catalog = page.getByTestId('session-catalog');
  const tree = catalog.getByRole('tree');
  const items = tree.getByRole('treeitem');
  const loadMore = catalog.getByRole('button', { name: '加载更多会话' });
  const current = () => tree.evaluate(element => document.getElementById(element.getAttribute('aria-activedescendant'))?.textContent);
  const waitForCount = count => page.waitForFunction(count =>
    Number(document.querySelector('[data-testid="session-catalog"]')?.dataset.items) === count, count);
  function visibleAnchor(element) {
    const top = element.getBoundingClientRect().top;
    const row = [...element.querySelectorAll('[role="treeitem"]')].find(row => row.getBoundingClientRect().bottom > top);
    return row && { text: row.textContent, top: row.getBoundingClientRect().top - top };
  }
  const firstVisible = () => catalog.evaluate(visibleAnchor);

  await page.getByText('第 160 项', { exact: false }).waitFor();
  await waitForCount(42);
  assert.ok(await items.count() < 33);
  const hierarchy = await items.first().evaluate(parent => {
    const textX = row => row.querySelector('span').getBoundingClientRect().left;
    const child = parent.nextElementSibling;
    return { indent: textX(child) - textX(parent), selected: child.getAttribute('aria-current') };
  });
  assert.ok(hierarchy.indent >= 6 && hierarchy.selected === 'true', JSON.stringify(hierarchy));
  if (screenshot) await page.screenshot({ path: screenshot });
  const blankJumps = await catalog.evaluate(async element => {
    const bounds = element.getBoundingClientRect();
    const max = element.scrollHeight - element.clientHeight;
    const blank = [];
    for (const fraction of [.98, .19, .68, 0]) {
      element.scrollTop = max * fraction;
      await new Promise(resolve => requestAnimationFrame(resolve));
      const points = [bounds.top + 40, bounds.bottom - 40];
      if (points.some(y => !document.elementFromPoint(bounds.left + 100, y)?.closest('[role="treeitem"]'))) blank.push(fraction);
    }
    return blank;
  });
  assert.deepEqual(blankJumps, [], 'Fast scrollbar jumps leave rendered rows on screen');
  await tree.focus();
  await tree.press('Home');
  const project = items.first();
  assert.equal(await project.getAttribute('aria-expanded'), 'true');
  await tree.press('ArrowLeft');
  assert.equal(await project.getAttribute('aria-expanded'), 'false');
  await tree.press('ArrowRight');
  await tree.press('ArrowRight');
  assert.equal(await current(), '工作台架构评审');
  await tree.press('End');
  await tree.getByRole('treeitem', { name: '目录会话 0039' }).waitFor();
  assert.equal(await current(), '目录会话 0039');

  await loadMore.focus();
  const beforeAppend = await firstVisible();
  await page.keyboard.press('Enter');
  await waitForCount(82);
  const afterAppend = await firstVisible();
  assert.equal(afterAppend.text, beforeAppend.text);
  assert.ok(Math.abs(afterAppend.top - beforeAppend.top) <= 2, JSON.stringify({ beforeAppend, afterAppend }));

  await tree.focus();
  await tree.press('End');
  await tree.press('Enter');
  await page.locator('.breadcrumb strong').filter({ hasText: /^目录会话 0079$/ }).waitFor();
  const selected = tree.getByRole('treeitem', { name: '目录会话 0079' });
  assert.equal(await selected.getAttribute('aria-current'), 'true');
  assert.equal(await selected.getAttribute('aria-level'), '2');
  const beforeSwitch = await firstVisible();
  await page.getByRole('button', { name: '文件', exact: true }).click();
  await page.getByRole('button', { name: '会话', exact: true }).click();
  await selected.waitFor();
  const afterSwitch = await firstVisible();
  assert.equal(afterSwitch.text, beforeSwitch.text);
  assert.ok(Math.abs(afterSwitch.top - beforeSwitch.top) <= 2);
  if (screenshot) await page.screenshot({ path: screenshot.replace(/\.png$/, '-paged.png') });

  await page.getByRole('button', { name: '搜索' }).click();
  const search = page.getByRole('textbox', { name: '搜索会话' });
  await search.fill('目录会话 0002');
  await waitForCount(2);
  await tree.getByRole('treeitem', { name: '目录会话 0002' }).click();
  await page.locator('.breadcrumb strong').filter({ hasText: /^目录会话 0002$/ }).waitFor();
  await search.press('Escape');
  await page.getByRole('button', { name: '归档', exact: true }).click();
  await page.getByRole('tree', { name: '已归档会话' }).getByRole('treeitem', { name: '归档会话示例' }).waitFor();
  assert.equal(await loadMore.count(), 0);
  console.log('Verified viewport mounting, keyboard navigation, search, append anchoring, tab restoration and archive.');
} finally {
  await app.close();
  await rm(profile, { recursive: true, force: true, maxRetries: 3 });
}
