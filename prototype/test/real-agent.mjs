import { _electron as electron } from 'playwright';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { pasteNativeImage, samplePng } from './clipboard-image.mjs';

const args = process.argv.slice(2);
const [binary, route = 'stdio', ssh] = args.filter(arg => arg !== '--image');
const imageTest = args.includes('--image');
const expected = imageTest ? 'Span preview sent two images.' : 'Span preview is connected.';
const imageName = '会话验收.png';
const profile = await mkdtemp(join(tmpdir(), 'span-real-'));
const image = join(profile, imageName);
const open = () => electron.launch({
  executablePath: binary,
  args: ['--no-sandbox', '--disable-gpu'],
  env: { ...process.env, SPAN_PREVIEW_PROFILE: profile },
});
let app;
try {
  app = await open();
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
  if (imageTest) {
    await page.getByRole('button', { name: 'Agent 控件', exact: true }).click();
    await page.getByRole('button', { name: '运行设置', exact: true }).click();
    const vision = page.locator('option[value="gpt-6.2-sol"]');
    const model = page.getByRole('combobox').filter({ has: vision });
    await vision.waitFor({ state: 'attached' });
    await model.selectOption('gpt-6.2-sol');
    await page.getByRole('button', { name: '关闭面板' }).click();
    await writeFile(image, samplePng);
    await app.evaluate(({ dialog }, image) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [image] });
    }, image);
    await page.getByRole('button', { name: '添加本机文件' }).click();
    const draft = page.getByRole('list', { name: '待发送的附件' });
    await draft.getByRole('button', { name: '预览图片 · ' + imageName }).waitFor();
    await pasteNativeImage(app, page.getByRole('textbox', { name: '消息' }));
    await draft.getByRole('button', { name: '预览图片 · 截图 1.png', exact: true }).waitFor();
  }
  await page.getByRole('textbox', { name: '消息' }).fill(imageTest ? 'Check the preview image.' : 'Check the preview connection.');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  const reply = page.getByText(expected, { exact: true });
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
  if (imageTest) {
    await pasteNativeImage(app, composer);
    await page.getByRole('list', { name: '待发送的附件' })
      .getByRole('button', { name: '预览图片 · 截图 2.png', exact: true }).waitFor();
  }
  await app.close();
  if (imageTest) assert.equal((await readdir(join(profile, 'screenshots'))).length, 1);
  app = await open();
  const resumed = await app.firstWindow();
  await resumed.locator(`.connection[data-route="${route}"]`).filter({ has: resumed.locator('i.ready') })
    .filter({ hasText: ssh ?? '本机' }).waitFor({ timeout: 30_000 });
  await resumed.locator('.breadcrumb strong').getByText(title, { exact: true }).waitFor();
  await resumed.getByTestId('transcript').getByText(expected, { exact: true }).waitFor();
  if (imageTest) {
    const attachments = resumed.getByRole('list', { name: '已发送的附件' });
    const attachment = attachments.getByRole('button', { name: '预览图片 · ' + imageName });
    const pasted = attachments.getByRole('button', { name: '预览图片 · 截图 1.png', exact: true });
    const closePreview = resumed.locator('#file-preview').getByRole('button', { name: '关闭预览' });
    await app.evaluate(({ dialog }, { file, name }) => {
      let choices = 0;
      dialog.showOpenDialog = async (_window, options) => {
        if (options.defaultPath !== name || !options.properties.includes('openFile')) throw Error('Expected a native image chooser.');
        return ++choices === 1 ? { canceled: true, filePaths: [] } : { canceled: false, filePaths: [file] };
      };
    }, { file: image, name: imageName });
    await pasted.press('Enter');
    await resumed.waitForFunction(() => document.querySelector('#file-preview img')?.naturalWidth > 0);
    await closePreview.press('Escape');
    assert.ok(await pasted.evaluate(element => document.activeElement === element));
    await attachment.press('Enter');
    assert.equal(await resumed.getByRole('complementary', { name: '文件预览' }).count(), 0);
    await attachment.press('Enter');
    await resumed.waitForFunction(() => document.querySelector('#file-preview img')?.naturalWidth > 0);
    await closePreview.press('Escape');
    assert.ok(await attachment.evaluate(element => document.activeElement === element));

    const activeSessionId = () => JSON.parse(localStorage.getItem('span.workbench.recent.v1'))[0].sessionId;
    const source = await resumed.evaluate(activeSessionId);
    assert.ok(source);
    await resumed.getByRole('button', { name: /^会话操作 · / }).click();
    await resumed.getByRole('button', { name: '复制会话', exact: true }).click();
    const copy = await resumed.waitForFunction(previous => {
      const current = JSON.parse(localStorage.getItem('span.workbench.recent.v1'))[0].sessionId;
      return current !== previous && current;
    }, source).then(handle => handle.jsonValue());
    await resumed.getByTestId('transcript').getByText(expected, { exact: true }).waitFor();
    await app.close();
    app = await open();
    const restoredCopy = await app.firstWindow();
    await restoredCopy.getByTestId('transcript').getByText(expected, { exact: true }).waitFor();
    assert.equal(await restoredCopy.evaluate(activeSessionId), copy);
    console.log('Verified a real Codex fork has a distinct ID, copies the conversation, and reopens after restart.');
  }
  console.log(`Verified real Codex on ${ssh ? 'SSH' : 'the local host'} using ${route} transport, including automatic session restore${imageTest ? ' with selected and pasted images' : ''}.`);
} finally {
  await app?.close();
  await rm(profile, { recursive: true, force: true, maxRetries: 3 });
}
