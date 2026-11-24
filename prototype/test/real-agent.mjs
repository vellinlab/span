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
  if (ssh) {
    await page.getByRole('button', { name: '主机', exact: true }).click();
    await page.getByLabel('SSH 目标').fill(ssh);
    await page.getByRole('button', { name: '连接 SSH' }).click();
  }
  await page.locator(`.connection[data-route="${route}"]`).filter({
    has: page.locator('i.ready'),
  }).waitFor({ timeout: 30_000 });
  if (ssh) assert.match(await page.getByRole('button', { name: '主机', exact: true }).getAttribute('title'), new RegExp(ssh));
  await page.getByRole('textbox', { name: '消息' }).fill('Check the preview connection.');
  await page.getByRole('textbox', { name: '消息' }).press('Enter');
  await page.getByText('Span preview is connected.', { exact: true }).waitFor({ timeout: 20_000 });
  await page.getByRole('button', { name: '发送', exact: true }).waitFor();
  assert.equal(await page.getByRole('alert').count(), 0);
  console.log(`Verified real Codex on ${ssh ? 'SSH' : 'the local host'} using ${route} transport.`);
} finally {
  await app.close();
  await rm(profile, { recursive: true, force: true, maxRetries: 3 });
}
