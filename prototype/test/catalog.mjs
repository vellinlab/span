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
    const { top, bottom } = element.getBoundingClientRect();
    const pinned = element.ownerDocument.elementFromPoint(element.getBoundingClientRect().left + 100, top + 1)
      ?.closest('.catalog-heading');
    const cutoff = pinned?.getBoundingClientRect().bottom ?? top;
    const row = [...element.querySelectorAll('.catalog-session')].find(row => {
      const bounds = row.getBoundingClientRect();
      return bounds.bottom > cutoff && bounds.top < bottom;
    });
    return row && { text: row.textContent, top: row.getBoundingClientRect().top - top };
  }
  const firstVisible = () => catalog.evaluate(visibleAnchor);

  await page.getByText('第 160 项', { exact: false }).waitFor();
  await waitForCount(42);
  const timeline = page.getByTestId('transcript');
  const jumpToLatest = page.getByRole('button', { name: '滚到最新消息' });
  const historyCommand = timeline.locator('[data-card="command"]').filter({ hasText: 'workspace verify --history' });
  for (const count of [41, 61, 82]) {
    await timeline.evaluate(element => { element.scrollTop = 100; });
    await page.waitForFunction(count => Number(document.querySelector('[data-testid="transcript"]').dataset.items) === count, count);
  }
  await timeline.evaluate(async element => {
    element.scrollTop = 200;
    const nextFrame = () => new Promise(requestAnimationFrame);
    for (let step = 0; step < 12; step++) {
      await nextFrame();
      if (element.querySelector('[data-card="command"]')) return;
      element.scrollTop += element.clientHeight / 2;
    }
  });
  await historyCommand.locator('summary').click();
  await historyCommand.getByText('已核对第 90 项历史记录。', { exact: false }).waitFor();
  const readAnchor = () => timeline.evaluate(element => {
    const view = element.getBoundingClientRect();
    const row = [...element.querySelectorAll('.message[data-empty="false"]')].find(item => {
      const rect = item.firstElementChild.getBoundingClientRect();
      return rect.bottom > view.top && rect.top < view.bottom;
    });
    return row && { text: row.textContent, top: row.getBoundingClientRect().top - view.top };
  });
  await historyCommand.evaluate(async element => {
    const timeline = element.closest('.timeline');
    timeline.scrollTop += element.closest('.message').getBoundingClientRect().top - timeline.getBoundingClientRect().top + 17;
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
  });
  const beforeReadingSwitch = await readAnchor();
  assert.match(beforeReadingSwitch.text, /workspace verify --history/);
  if (screenshot) await page.screenshot({ path: screenshot.replace(/\.png$/, '-reading.png') });
  const openThread = async name => {
    await tree.getByRole('treeitem', { name, exact: true }).click();
    await page.locator('.breadcrumb strong').filter({ hasText: new RegExp(`^${name}$`) }).waitFor();
  };
  await openThread('目录会话 0002');
  await timeline.getByText('第 160 项', { exact: false }).waitFor();
  assert.equal(await historyCommand.count(), 0);
  await openThread('工作台架构评审');
  await historyCommand.getByText('已核对第 90 项历史记录。', { exact: false }).waitFor();
  const restoredReading = await readAnchor();
  assert.equal(restoredReading.text, beforeReadingSwitch.text);
  assert.ok(Math.abs(restoredReading.top - beforeReadingSwitch.top) <= 2, JSON.stringify({ beforeReadingSwitch, restoredReading }));
  assert.equal(await timeline.getAttribute('data-items'), '82');
  assert.ok(await timeline.locator('.message').count() < 30);
  if (screenshot) await page.screenshot({ path: screenshot.replace(/\.png$/, '-reading-restored.png') });
  await jumpToLatest.click();
  await jumpToLatest.waitFor({ state: 'detached' });
  await openThread('目录会话 0002');
  await timeline.getByText('第 160 项', { exact: false }).waitFor();
  await openThread('工作台架构评审');
  await timeline.getByText('第 160 项', { exact: false }).waitFor();
  assert.equal(Number(await timeline.getAttribute('data-items')), 21);
  assert.equal(await jumpToLatest.count(), 0);

  assert.ok(await items.count() < 33);
  const hierarchy = await items.first().evaluate(parent => {
    const textX = row => row.querySelector('span').getBoundingClientRect().left;
    const children = document.getElementById(parent.getAttribute('aria-owns'));
    const child = children.firstElementChild;
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

  const transition = await catalog.evaluate(async element => {
    const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
    const listTop = element.getBoundingClientRect().top;
    const first = element.querySelector('.catalog-group');
    const boundary = first.offsetHeight;
    const y = heading => heading.getBoundingClientRect().top - listTop;
    element.scrollTop = Math.floor(boundary / 2);
    await frame();
    const pinned = y(first.querySelector('.catalog-heading'));
    element.scrollTop = boundary - 16;
    await frame();
    const headings = element.querySelectorAll('.catalog-heading');
    const push = [y(headings[0]), y(headings[1])];
    element.scrollTop = boundary;
    await frame();
    const next = element.ownerDocument.elementFromPoint(element.getBoundingClientRect().left + 100, listTop + 1)
      ?.closest('.catalog-heading');
    return { pinned, push, next: next?.textContent, nextTop: next && y(next) };
  });
  assert.deepEqual(transition, { pinned: 0, push: [-16, 16], next: 'second-workspace', nextTop: 0 });
  await tree.getByRole('treeitem', { name: 'second-workspace' }).click();
  await waitForCount(22);
  assert.equal(await tree.getByRole('treeitem', { name: 'second-workspace' }).getAttribute('aria-expanded'), 'false');
  await tree.getByRole('treeitem', { name: 'second-workspace' }).click();
  await waitForCount(42);

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
  for (let index = 0; index < 18; index++) await tree.press('ArrowUp');
  const focusedVisible = await tree.evaluate(element => {
    const row = document.getElementById(element.getAttribute('aria-activedescendant'));
    const heading = row.closest('.catalog-group').querySelector('.catalog-heading');
    return row.getBoundingClientRect().top >= heading.getBoundingClientRect().bottom;
  });
  assert.ok(focusedVisible, 'Keyboard focus stays below the sticky heading');
  await tree.press('End');

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
  await search.fill('目录会话 0119');
  await catalog.getByRole('status').filter({ hasText: '搜索失败' }).waitFor();
  await catalog.getByRole('button', { name: '重试' }).click();
  await tree.getByRole('treeitem', { name: '目录会话 0119' }).click();
  await page.locator('.breadcrumb strong').filter({ hasText: /^目录会话 0119$/ }).waitFor();
  assert.equal(await loadMore.count(), 0);

  await search.fill('目录会话 01');
  await waitForCount(14);
  await tree.getByRole('treeitem', { name: '目录会话 0100' }).waitFor();
  await catalog.getByRole('button', { name: '加载更多结果' }).click();
  await waitForCount(22);
  assert.equal(await catalog.getByRole('button', { name: '加载更多结果' }).count(), 0);

  await search.fill('catalog-0002');
  await waitForCount(2);
  await tree.getByRole('treeitem', { name: '目录会话 0002' }).click();
  await page.locator('.breadcrumb strong').filter({ hasText: /^目录会话 0002$/ }).waitFor();
  await search.press('Escape');
  await waitForCount(82);
  assert.deepEqual(await firstVisible(), afterSwitch);
  assert.ok(await page.getByRole('button', { name: '搜索' }).evaluate(button => button === document.activeElement));

  await page.getByRole('button', { name: '搜索' }).click();
  await search.fill('归档会话');
  await catalog.getByRole('status').filter({ hasText: '没有匹配的会话' }).waitFor();
  await page.getByRole('button', { name: '归档', exact: true }).click();
  await page.getByRole('tree', { name: '已归档会话' }).getByRole('treeitem', { name: '归档会话示例' }).waitFor();
  if (screenshot) await page.screenshot({ path: screenshot.replace(/\.png$/, '-search.png') });
  assert.equal(await loadMore.count(), 0);
  console.log('Verified session reading position, expanded history cards, catalog navigation, append anchoring, and search.');
} finally {
  await app.close();
  await rm(profile, { recursive: true, force: true, maxRetries: 3 });
}
