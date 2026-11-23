import { _electron as electron } from 'playwright';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const profile = await mkdtemp(join(tmpdir(), 'span-real-'));
const app = await electron.launch({
  executablePath: process.argv[2],
  args: ['--no-sandbox', '--disable-gpu'],
  env: { ...process.env, SPAN_PREVIEW_PROFILE: profile },
});
try {
  const page = await app.firstWindow();
  await page.locator('.connection i.ready').waitFor({ timeout: 20_000 });
  await page.getByRole('textbox', { name: '消息' }).fill('Check the preview connection.');
  await page.getByRole('textbox', { name: '消息' }).press('Enter');
  await page.getByText('Span preview is connected.', { exact: true }).waitFor({ timeout: 20_000 });
  await page.getByRole('button', { name: '发送', exact: true }).waitFor();
  assert.equal(await page.getByRole('alert').count(), 0);
  console.log('Verified an actual Codex App Server turn against the local fixture gateway.');
} finally {
  await app.close();
  await rm(profile, { recursive: true, force: true, maxRetries: 3 });
}
