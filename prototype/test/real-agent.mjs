import { _electron as electron } from 'playwright';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const [binary, route = 'stdio', ssh] = process.argv.slice(2);
const profile = await mkdtemp(join(tmpdir(), 'span-real-'));
const app = await electron.launch({
  executablePath: binary,
  args: ['--no-sandbox', '--disable-gpu'],
  env: { ...process.env, SPAN_PREVIEW_PROFILE: profile },
});
try {
  const page = await app.firstWindow();
  const ready = page.locator(`.connection[data-route="${route}"]`).filter({ has: page.locator('i.ready') });
  if (ssh) {
    await page.locator('.connection').filter({ hasText: '本机' }).filter({ has: page.locator('i.ready') })
      .waitFor({ timeout: 30_000 });
    await page.getByRole('button', { name: '主机', exact: true }).click();
    await page.getByLabel('SSH 目标').fill(ssh);
    await page.getByRole('button', { name: '连接 SSH' }).click();
  }
  await (ssh ? ready.filter({ hasText: ssh }) : ready).waitFor({ timeout: 30_000 });
  await page.getByRole('textbox', { name: '消息' }).fill('Check the preview connection.');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  const reply = page.getByText('Span preview is connected.', { exact: true });
  const alert = page.getByRole('alert');
  await reply.or(alert).first().waitFor({ timeout: 20_000 });
  if (await alert.isVisible()) throw new Error(await alert.innerText());
  await page.getByRole('button', { name: '发送', exact: true }).waitFor();
  assert.equal(await alert.count(), 0);
  const title = `Span CI Search ${process.pid}`;
  const composer = page.getByRole('textbox', { name: '消息' });
  await composer.fill(`/rename ${title}`);
  await composer.press('Enter');
  await page.locator('.breadcrumb strong').filter({ hasText: title }).waitFor();
  await page.getByRole('button', { name: '搜索' }).click();
  const search = page.getByRole('textbox', { name: '搜索会话' });
  const catalog = page.getByTestId('session-catalog');
  await search.fill(title);
  await catalog.getByRole('treeitem', { name: title }).waitFor();
  await page.waitForFunction(() => document.querySelector('[data-testid="session-catalog"]')?.getAttribute('aria-busy') !== 'true');
  assert.equal(await catalog.getByText('搜索失败', { exact: true }).count(), 0);
  await search.fill(`${title} absent`);
  await catalog.getByRole('status').filter({ hasText: '没有匹配的会话' }).waitFor();
  console.log(`Verified real Codex on ${ssh ? 'SSH' : 'the local host'} using ${route} transport.`);
} finally {
  await app.close();
  await rm(profile, { recursive: true, force: true, maxRetries: 3 });
}
