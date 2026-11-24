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
  } else if (command === '--wait-for-history') {
    await page.getByText('第 160 项', { exact: false }).waitFor({ timeout: 12000 });
  } else if (command === '--open-terminal') {
    await page.getByRole('button', { name: '切换终端' }).click();
    await page.locator('.xterm-helper-textarea').waitFor();
    await page.locator('.xterm-rows > div').first().waitFor();
  } else if (!command.startsWith('--')) {
    await page.locator('.xterm-helper-textarea').focus();
    await page.keyboard.type(command);
    await page.keyboard.press('Enter');
  }
  if (command.startsWith('--')) {
    const system = await browser.newBrowserCDPSession();
    const renderer = await page.context().newCDPSession(page);
    if (command === '--collect-heap') await renderer.send('HeapProfiler.collectGarbage');
    const [processes, heap, dom] = await Promise.all([
      system.send('SystemInfo.getProcessInfo'),
      renderer.send('Runtime.getHeapUsage'),
      renderer.send('Memory.getDOMCounters'),
    ]);
    console.log(JSON.stringify({ processes: processes.processInfo.map(({ id, type }) => ({ id, type })), heap, dom }));
  }
} finally {
  await browser.close();
}
