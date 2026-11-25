import { chromium } from 'playwright';

const [port, command] = process.argv.slice(2);
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, {
  noDefaults: true,
  timeout: 12000,
});
try {
  const page = browser.contexts()[0].pages()[0];
  const terminalLine = () => page.locator('.xterm-rows').evaluate(element =>
    Number([...element.textContent.matchAll(/span-bench-(\d+)/g)].at(-1)?.[1]));
  if (command === '--trace-scroll-start') {
    const top = await page.getByTestId('transcript').evaluate(async timeline => {
      timeline.scrollTop = timeline.scrollHeight;
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
      const now = () => performance.timeOrigin + performance.now();
      if (!timeline.spanScrollTrace) {
        timeline.addEventListener('wheel', event => {
          const entry = { direction: Math.sign(event.deltaY), dispatchedAt: performance.timeOrigin + event.timeStamp,
            receivedAt: now() };
          timeline.spanScrollTrace.push(entry);
          requestAnimationFrame(() => { entry.frameAt = now(); });
        }, { passive: true, capture: true });
        timeline.addEventListener('scroll', () => {
          const entry = timeline.spanScrollTrace.at(-1);
          if (!entry) return;
          entry.scrolledAt ??= now();
          entry.top = timeline.scrollTop;
        }, { passive: true });
      }
      timeline.spanScrollTrace = [];
      return timeline.scrollTop;
    });
    console.log(JSON.stringify({ top, terminalLine: await terminalLine() }));
  } else if (command === '--trace-scroll-finish') {
    const events = await page.getByTestId('transcript').evaluate(timeline => timeline.spanScrollTrace);
    console.log(JSON.stringify({ events, terminalLine: await terminalLine() }));
  } else if (command === '--close-terminal') {
    await page.getByRole('button', { name: '关闭终端' }).click();
    await page.getByRole('region', { name: '终端' }).waitFor({ state: 'detached' });
  } else if (command === '--wait-for-history') {
    await page.getByText('第 160 项', { exact: false }).waitFor({ timeout: 12000 });
  } else if (command === '--catalog-top' || command === '--catalog-bottom') {
    const catalog = page.locator('.workspaces');
    const name = command === '--catalog-top' ? '工作台架构评审' : '目录会话 1199';
    await page.getByText('第 160 项', { exact: false }).waitFor({ timeout: 12000 });
    await catalog.evaluate((node, bottom) => { node.scrollTop = bottom ? node.scrollHeight : 0; }, command === '--catalog-bottom');
    const endpoint = catalog.getByText(name, { exact: true });
    await page.waitForFunction(name => {
      const list = document.querySelector('.workspaces');
      const bounds = list.getBoundingClientRect();
      return [...list.querySelectorAll('span')].some(node => {
        const row = node.getBoundingClientRect();
        return node.textContent === name && row.top >= bounds.top && row.bottom <= bounds.bottom;
      });
    }, name);
    if (await endpoint.count() !== 1) throw new Error(`Expected one visible catalog endpoint: ${name}`);
  } else if (command === '--open-terminal') {
    await page.getByRole('button', { name: '切换终端' }).click();
    await page.locator('.xterm-helper-textarea').waitFor();
    await page.locator('.xterm-rows > div').first().waitFor();
  } else if (!command.startsWith('--')) {
    await page.locator('.xterm-helper-textarea').focus();
    await page.keyboard.type(command);
    await page.keyboard.press('Enter');
  }
  if (command.startsWith('--') && !command.startsWith('--trace-scroll-')) {
    const system = await browser.newBrowserCDPSession();
    const renderer = await page.context().newCDPSession(page);
    if (command === '--collect-heap') await renderer.send('HeapProfiler.collectGarbage');
    const [processes, heap, dom] = await Promise.all([
      system.send('SystemInfo.getProcessInfo'),
      renderer.send('Runtime.getHeapUsage'),
      renderer.send('Memory.getDOMCounters'),
    ]);
    const mounted = command.startsWith('--catalog-') ?
      await page.locator('.workspaces .session-list button, .workspaces [role="treeitem"][aria-level="2"]').count() : undefined;
    console.log(JSON.stringify({ processes: processes.processInfo.map(({ id, type }) => ({ id, type })), heap, dom, mounted }));
  }
} finally {
  await browser.close();
}
