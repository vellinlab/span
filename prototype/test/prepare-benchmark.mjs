import { chromium } from 'playwright';

const [port, command] = process.argv.slice(2);
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, {
  noDefaults: true,
  timeout: 12000,
});
try {
  const page = browser.contexts()[0].pages()[0];
  if (command === '--close-terminal') {
    await page.getByRole('button', { name: '关闭终端' }).click();
    await page.getByRole('region', { name: '终端' }).waitFor({ state: 'detached' });
  } else {
    await page.getByText('第 160 项', { exact: false }).waitFor({ timeout: 12000 });
    if (command !== '--wait-for-history') {
      await page.getByRole('button', { name: '切换终端' }).click();
      const input = page.locator('.xterm-helper-textarea');
      await input.focus();
      await page.keyboard.type(command);
      await page.keyboard.press('Enter');
    }
  }
  if (command === '--wait-for-history' || command === '--close-terminal') {
    const session = await browser.newBrowserCDPSession();
    const { processInfo } = await session.send('SystemInfo.getProcessInfo');
    console.log(JSON.stringify(processInfo.map(({ id, type }) => ({ id, type }))));
  }
} finally {
  await browser.close();
}
