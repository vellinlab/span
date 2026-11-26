import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { availableParallelism, release, tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

const [binary, reportPath, baselineBinary, baselineCommit, coveredBaseline, coveredBaselineCommit,
  minimizedBaseline, minimizedBaselineCommit] = process.argv.slice(2);
const linux = process.platform === 'linux';
const initialSize = [880, 640];
const activeWindowMs = 7500;
const interactionTimeoutMs = 10_000;
const settle = page => page.evaluate(async () => {
  await new Promise(requestAnimationFrame);
  await new Promise(requestAnimationFrame);
});

async function resize(app, page, [width, height]) {
  await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(...size), [width, height]);
  await page.waitForFunction(([width, height]) => Math.abs(innerWidth - width) <= 2 && Math.abs(innerHeight - height) <= 2,
    [width, height]);
}

async function terminalLine(page, command, result) {
  await page.locator('.xterm-helper-textarea').focus();
  await page.keyboard.type(command);
  await page.keyboard.press('Enter');
  await page.waitForFunction(line => [...document.querySelectorAll('.xterm-rows > div')]
    .some(row => row.textContent.trim() === line), result, { timeout: 20_000 });
}

async function echoSample(app, page, key) {
  await app.evaluate((_, key) => {
    const state = globalThis.spanTerminalEcho;
    const pixels = state.pixels[key];
    if (!pixels) throw Error(`No reference pixels for terminal key ${key}`);
    state.result = new Promise(resolve => {
      const started = performance.now();
      const firstFrame = state.frames;
      const timer = setTimeout(() => {
        const bestMatch = state.pending.bestMatch;
        state.pending = undefined;
        resolve({ frames: state.frames - firstFrame, bestMatch });
      }, 2000);
      state.pending = { pixels, started, bestMatch: 0, finish: ms => {
        clearTimeout(timer);
        state.pending = undefined;
        resolve({ ms });
      } };
    });
  }, key);
  await page.keyboard.press(key);
  const result = await app.evaluate(() => globalThis.spanTerminalEcho.result);
  assert.ok(Number.isFinite(result.ms), `No matching echo for ${key} after ${result.frames} frames (best match ${result.bestMatch})`);
  const stages = await page.evaluate(() => {
    const probe = window.spanTerminalStages;
    return probe ? probe.sample() ?? {} : null;
  });
  if (stages) {
    assert.equal(stages.key, key);
    assert.ok(Number.isFinite(stages.keyToDomMs), `No DOM update for ${key}`);
    if (linux) {
      assert.ok(Number.isFinite(stages.keyToPacketMs), `No PTY echo packet for ${key}`);
      assert.ok(stages.keyToDomMs >= stages.keyToPacketMs);
    }
  }
  return { paintedMs: result.ms, ...stages };
}

async function prepareEchoFrames(app, page) {
  const area = await page.evaluate(() => {
    const row = [...document.querySelectorAll('.xterm-rows > div')].find(row => row.textContent.trim() === 'span_echo_ready');
    if (!row) throw Error('The ready line disappeared before measuring its bounds');
    const rect = row.getBoundingClientRect();
    return { x: Math.ceil(rect.left), y: Math.ceil(rect.top), width: 128, height: Math.floor(rect.height) - 1 };
  });
  await page.locator('.xterm-helper-textarea').focus();
  const references = {};
  for (const key of 'ab') {
    await page.keyboard.press(key);
    await page.waitForFunction(key => [...document.querySelectorAll('.xterm-rows > div')]
      .some(row => row.textContent.trim() === `span_echo_${key}`), key, { timeout: interactionTimeoutMs });
    await settle(page);
    references[key] = await app.evaluate(async ({ BrowserWindow }, area) => {
      const contents = BrowserWindow.getAllWindows()[0].webContents;
      const image = await Promise.race([contents.capturePage(), new Promise(resolve => setTimeout(resolve, 4000))]);
      if (!image) throw Error('The terminal reference frame was not captured');
      return image.crop(area).toBitmap().toString('hex');
    }, area);
  }
  assert.ok(references.a && references.b && references.a !== references.b, 'The two terminal keys must paint different pixels');
  console.log('Captured different reference pixels for both keys. Verifying frame notifications.');
  await app.evaluate(({ BrowserWindow }, { area, references }) => {
    const a = Buffer.from(references.a, 'hex');
    const b = Buffer.from(references.b, 'hex');
    const pixels = { a: [], b: [] };
    // Match the pixels that distinguish the two glyphs. Ignore the rest of the row and the spaces around the text.
    for (let index = 0; index < a.length; index += 4) {
      if (Math.abs(a[index] - b[index]) < 100) continue;
      const midpoint = (a[index] + b[index]) / 2;
      pixels.a.push({ index, midpoint, light: a[index] > midpoint });
      pixels.b.push({ index, midpoint, light: b[index] > midpoint });
    }
    if (pixels.a.length < 8) throw Error('The terminal reference glyphs do not differ enough for a paint probe');
    const state = { frames: 0, pixels };
    globalThis.spanTerminalEcho = state;
    BrowserWindow.getAllWindows()[0].webContents.beginFrameSubscription(false, image => {
      state.frames++;
      const pending = state.pending;
      if (!pending) return;
      const bitmap = image.crop(area).toBitmap();
      const matching = pending.pixels.filter(({ index, midpoint, light }) => (bitmap[index] > midpoint) === light).length;
      pending.bestMatch = Math.max(pending.bestMatch, matching / pending.pixels.length);
      if (matching === pending.pixels.length) pending.finish(performance.now() - pending.started);
    });
  }, { area, references });
  await delay(165);
  await echoSample(app, page, 'a');
  await delay(165);
  await echoSample(app, page, 'b');
}

async function observeEchoStages(page) {
  await page.evaluate(trackPackets => {
    const row = document.querySelector('.xterm-rows > div');
    const listeners = new AbortController();
    let sample;
    let startedAt;
    let tail;
    document.addEventListener('keydown', event => {
      if (event.key !== 'a' && event.key !== 'b') return;
      startedAt = performance.now();
      sample = { key: event.key };
      tail = '';
    }, { capture: true, signal: listeners.signal });
    const observer = new MutationObserver(() => {
      if (sample && sample.keyToDomMs === undefined && row.textContent.trim() === `span_echo_${sample.key}`) {
        sample.keyToDomMs = performance.now() - startedAt;
      }
    });
    observer.observe(row, { childList: true });
    // Linux PTYs preserve the fixture's bytes. ConPTY can emit screen diffs instead of the complete text.
    const unsubscribe = trackPackets ? window.span.onEvent(packet => {
      if (!sample || sample.keyToPacketMs !== undefined || packet.event !== 'terminal') return;
      const marker = `span_echo_${sample.key}`;
      const text = tail + atob(packet.data);
      if (text.includes(marker)) sample.keyToPacketMs = performance.now() - startedAt;
      tail = text.slice(-(marker.length - 1));
    }) : undefined;
    window.spanTerminalStages = {
      sample: () => sample,
      stop() {
        observer.disconnect();
        unsubscribe?.();
        listeners.abort();
      },
    };
  }, linux);
}

async function terminalPalette(page, screenshot, variant) {
  await page.keyboard.press('p');
  await page.locator('.xterm-rows').getByText('REVERSE', { exact: true }).waitFor();
  await page.screenshot({ path: screenshot.replace(/-end\.png$/, '-palette.png'), timeout: interactionTimeoutMs });
  const samples = await page.locator('.xterm-rows').evaluate((rows, labels) => {
    const defaultBackground = getComputedStyle(rows.closest('.xterm-scrollable-element')).backgroundColor;
    const spans = [...rows.querySelectorAll('div > span')];
    return labels.map(label => {
      const span = spans.find(item => item.textContent.trim() === label);
      if (!span) throw Error(`No terminal color sample for ${label}`);
      const style = getComputedStyle(span);
      const background = style.backgroundColor === 'rgba(0, 0, 0, 0)' ? defaultBackground : style.backgroundColor;
      return { label, foreground: style.color, background };
    });
  }, ['ERROR', 'WARN', 'READY', 'INFO', 'NOTE', 'TRACE', 'RGB', 'REVERSE']);
  const luminance = color => color.match(/\d+/g).slice(0, 3).map(value => {
    const srgb = Number(value) / 255;
    return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  }).reduce((total, value, channel) => total + value * [0.2126, 0.7152, 0.0722][channel], 0);
  for (const sample of samples) {
    const [dark, light] = [luminance(sample.foreground), luminance(sample.background)].sort((a, b) => a - b);
    sample.contrast = (light + 0.05) / (dark + 0.05);
    if (variant === 'candidate') assert.ok(sample.contrast >= 4.5, `${sample.label}: ${JSON.stringify(sample)}`);
  }
  assert.notEqual(samples.at(-1).background, samples[0].background, 'Reverse video must paint a distinct background');
  return samples;
}

async function terminalInteraction(app, page, screenshot, variant, recordEcho) {
  const script = fileURLToPath(new URL('./terminal-echo.cjs', import.meta.url));
  await terminalLine(page, `"${process.execPath}" "${script}"`, 'span_echo_ready');
  const rows = page.locator('.xterm-rows');
  const ready = await rows.locator(':scope > div').filter({ hasText: /^\s*span_echo_ready\s*$/ }).boundingBox();
  assert.ok(ready, 'The terminal text must be visible before selecting it');
  const x = ready.x + 12;
  const y = ready.y + ready.height / 2;
  const selection = page.locator('.xterm-selection > div').first();
  await page.mouse.dblclick(x, y);
  await selection.waitFor({ state: 'visible' });
  await page.mouse.click(x, y);
  await selection.waitFor({ state: 'detached' });
  await settle(page);
  const emptyClickUpdates = await countTerminalRowUpdates(rows, async () => {
    await page.mouse.click(x, y);
    await settle(page);
  });
  const selectionMessage = `${variant} repeated empty terminal selection updated ${emptyClickUpdates} rows`;
  if (variant === 'candidate') assert.equal(emptyClickUpdates, 0, selectionMessage);
  else assert.ok(emptyClickUpdates > 0, selectionMessage);
  console.log(selectionMessage);
  console.log('The raw terminal fixture is ready. Capturing reference pixels.');
  await prepareEchoFrames(app, page);
  await observeEchoStages(page);
  console.log('The frame observer matched both reference keys. Measuring idle and streaming echo.');
  const idle = [];
  for (const key of 'abababab') {
    await delay(165);
    idle.push(await echoSample(app, page, key));
  }
  await page.keyboard.press('g');
  await page.waitForFunction(() => document.querySelector('.xterm-rows').innerText.includes('span_interaction_3'),
    null, { timeout: interactionTimeoutMs });
  const streaming = [];
  for (const key of 'ab'.repeat(12)) {
    await delay(150 + streaming.length % 5 * 19);
    streaming.push(await echoSample(app, page, key));
  }
  await page.evaluate(() => window.spanTerminalStages.stop());
  const frames = await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].webContents.endFrameSubscription();
    return globalThis.spanTerminalEcho.frames;
  });
  assert.ok(frames >= idle.length + streaming.length + 2);
  await recordEcho({ idle, streaming, frames });
  assert.match(await page.locator('.xterm-rows').innerText(), /span_interaction_\d+/);
  const palette = await terminalPalette(page, screenshot, variant);
  await page.keyboard.press(linux ? 'q' : 'f');
  console.log('The echo samples reached matching frames. Checking the final terminal output and reopening.');
  await page.waitForFunction(() => [...document.querySelectorAll('.xterm-rows > div')].some(row => {
    if (row.textContent.trim() !== '绘_echo_final') return false;
    return [...row.querySelectorAll('.xterm-fg-2')].map(span => span.textContent).join('').trim() === '绘_echo_final';
  }), null, { timeout: interactionTimeoutMs });
  if (linux) {
    await terminalLine(page, 'exit', '[终端已退出]');
    assert.match(await page.locator('.xterm-rows').innerText(), /绘_echo_final[\s\S]*\[终端已退出\]/);
  }
  await page.screenshot({ path: screenshot, timeout: interactionTimeoutMs });
  if (!linux) await page.keyboard.press('q');
  await page.getByRole('button', { name: '关闭终端' }).click();
  await page.locator('.terminal-canvas').waitFor({ state: 'detached' });
  await page.getByRole('button', { name: '切换终端' }).click();
  await terminalLine(page, linux ? `printf '%s_%s\\n' span_echo reopened` : 'echo span_echo_reopened', 'span_echo_reopened');
  assert.doesNotMatch(await page.locator('.xterm-rows').innerText(), /绘_echo_final/);
  return palette;
}

async function countTerminalRowUpdates(rows, action) {
  const stop = await rows.evaluateHandle(container => {
    let rowUpdates = 0;
    const observe = records => {
      for (const record of records) if (record.target.parentElement === container) rowUpdates++;
    };
    const observer = new MutationObserver(observe);
    observer.observe(container, { childList: true, subtree: true });
    return () => {
      observe(observer.takeRecords());
      observer.disconnect();
      return rowUpdates;
    };
  });
  let rowUpdates;
  try {
    await action();
  } finally {
    rowUpdates = await stop.evaluate(finish => finish());
    await stop.dispose();
  }
  return rowUpdates;
}

async function output(page) {
  const command = linux
    ? `n=1; while [ "$n" -le 120 ]; do printf 'span-resource-%03d\\n' "$n"; n=$((n+1)); sleep .045; done; printf '%s_%s\\n' resources done`
    : `powershell -NoLogo -NoProfile -Command "for ($i=1; $i -le 120; $i++) { [Console]::WriteLine(('span-resource-' + $i)); Start-Sleep -Milliseconds 45 }; [Console]::WriteLine(('resources_'+'done'))"`;
  const rows = page.locator('.xterm-rows');
  // xterm's visual rows ignore pointer events. The screen handles selection.
  await page.locator('.xterm-screen').click({ position: { x: 12, y: 5 } });
  await settle(page);
  const rowUpdates = await countTerminalRowUpdates(rows, async () => {
    await terminalLine(page, command, 'resources_done');
    assert.match(await rows.innerText(), /span-resource-120/);
  });
  assert.ok(rowUpdates > 0, 'The terminal row observer must see the streamed output');
  console.log(`Terminal row updates across 120 output lines: ${rowUpdates}`);
  return { outputLines: 120, rowUpdates };
}

async function observeTerminalReveal(app, area) {
  await app.evaluate(async ({ BrowserWindow }, area) => {
    const contents = BrowserWindow.getAllWindows()[0].webContents;
    const image = await Promise.race([contents.capturePage(), new Promise(resolve => setTimeout(resolve, 4000))]);
    if (!image) throw Error('The covered terminal reference frame was not captured');
    const covered = image.crop(area);
    const state = { covered, frames: [], notifications: 0 };
    globalThis.spanTerminalReveal = state;
    contents.beginFrameSubscription(false, image => {
      const at = performance.timeOrigin + performance.now();
      state.notifications++;
      state.frames.push({ at, image: image.crop(area) });
      if (state.frames.length > 24) state.frames.shift();
    });
  }, area);
  return async ({ clickAt, closedAt, outputAt, marker }) => app.evaluate(async ({ BrowserWindow }, stage) => {
    const contents = BrowserWindow.getAllWindows()[0].webContents;
    contents.endFrameSubscription();
    const { covered, frames, notifications } = globalThis.spanTerminalReveal;
    delete globalThis.spanTerminalReveal;
    const image = await Promise.race([contents.capturePage(), new Promise(resolve => setTimeout(resolve, 4000))]);
    if (!image) throw Error('The revealed terminal reference frame was not captured');
    const revealed = image.crop(stage.area).toBitmap();
    const rowPixels = image => image.crop(stage.marker).toBitmap();
    if (!revealed.length || revealed.equals(rowPixels(covered))) throw Error('The output row must change when the preview closes');
    const visible = frames.find(frame => frame.at >= stage.clickAt && rowPixels(frame.image).equals(revealed));
    return { clickToCloseMs: stage.closedAt - stage.clickAt, clickToDomMs: stage.outputAt - stage.clickAt,
      clickToFrameMs: visible ? visible.at - stage.clickAt : null, notifications, retainedFrames: frames.length };
  }, { area: { ...marker, x: area.x + marker.x, y: area.y + marker.y }, marker, clickAt, closedAt, outputAt });
}

async function hiddenOutput(app, page, { profile, capture, variant, saveImage, minimized }) {
  const script = fileURLToPath(new URL('./terminal-covered-output.cjs', import.meta.url));
  const gate = join(profile, 'begin-terminal-output');
  await terminalLine(page, `"${process.execPath}" "${script}" "${gate}"`, 'span_covered_ready');
  const screen = page.locator('.terminal-canvas .xterm-screen');
  const readyRow = page.locator('.xterm-rows > div', { hasText: 'span_covered_ready' });
  const dimensions = () => screen.evaluate(element => [element.offsetWidth, element.offsetHeight]);
  const beforeCover = await dimensions();
  const area = !minimized && await screen.evaluate(element => {
    const bounds = element.getBoundingClientRect();
    return { x: Math.ceil(bounds.left), y: Math.ceil(bounds.top), width: 146, height: Math.floor(bounds.height) - 1 };
  });
  const readme = page.getByRole('button', { name: 'README.md' });
  const preview = page.getByRole('complementary', { name: '文件预览' });
  const waitForPreview = () => preview.getByText('Span 工作台预览', { exact: true }).waitFor();
  const closePreview = () => preview.getByRole('button', { name: '关闭预览' }).click();
  const waitForOutput = () => page.waitForFunction(() => {
    const rows = [...document.querySelectorAll('.xterm-rows > div')];
    const last = rows.findIndex(row => row.textContent.trim() === 'span_hidden_080');
    const done = rows.findIndex(row => row.querySelector('.xterm-fg-2')?.textContent.trim() === 'span_covered_done');
    return last >= 0 && done > last;
  });
  const observation = await screen.evaluateHandle(element => {
    let intersecting;
    let windowHidden;
    let batches = 0;
    let tail = '';
    let packets = 0;
    let received = false;
    const generations = new Set();
    const visibility = new IntersectionObserver(entries => { intersecting = entries.at(-1).isIntersecting; });
    visibility.observe(element);
    const stopWindow = window.span.onWindowHidden(hidden => { windowHidden = hidden; });
    const observer = new MutationObserver(() => { batches++; });
    const rows = element.querySelector('.xterm-rows');
    let reveal;
    let revealObserver;
    const input = new AbortController();
    const finishedRow = () => [...rows.children].find(row =>
      row.querySelector('.xterm-fg-2')?.textContent.trim() === 'span_covered_done');
    const unsubscribe = window.span.onEvent(packet => {
      if (packet.event !== 'terminal') return;
      generations.add(packet.generation);
      packets++;
      const text = tail + atob(packet.data);
      received ||= text.includes('span_covered_done');
      tail = text.slice(-32);
    });
    return {
      get intersecting() { return intersecting; },
      get windowHidden() { return windowHidden; },
      get received() { return received; },
      begin() { observer.observe(rows, { childList: true, subtree: true, characterData: true }); },
      finish() { observer.disconnect(); return { batches, packets, generations: generations.size }; },
      armReveal() {
        const preview = document.getElementById('file-preview');
        const button = preview.querySelector('.preview-close');
        const record = () => {
          if (!reveal) return;
          const at = performance.timeOrigin + performance.now();
          if (!preview.isConnected) reveal.closedAt ??= at;
          if (finishedRow()) reveal.outputAt ??= at;
        };
        revealObserver = new MutationObserver(record);
        revealObserver.observe(preview.parentElement, { childList: true });
        revealObserver.observe(rows, { childList: true, subtree: true, characterData: true });
        button.addEventListener('click', event => {
          if (!event.isTrusted) return;
          reveal = { clickAt: performance.timeOrigin + event.timeStamp };
          record();
        }, { once: true, signal: input.signal });
      },
      readReveal(area) {
        const rect = finishedRow().getBoundingClientRect();
        return { ...reveal, marker: { x: Math.ceil(rect.left) - area.x, y: Math.ceil(rect.top) - area.y,
          width: 130, height: Math.floor(rect.height) - 1 } };
      },
      stop() {
        visibility.disconnect();
        stopWindow();
        unsubscribe();
        revealObserver?.disconnect();
        input.abort();
      },
    };
  });
  try {
    if (minimized) {
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].minimize());
      await page.waitForFunction(state => state.windowHidden === true, observation, { polling: 50 });
      assert.ok(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMinimized()));
    } else {
      await page.getByRole('button', { name: '文件', exact: true }).click();
      await readme.click();
      await waitForPreview();
      await page.waitForFunction(state => state.intersecting === (document.querySelector('.xterm').getBoundingClientRect().left < innerWidth), observation);
      assert.equal(await observation.evaluate(state => state.intersecting), variant === 'baseline');
    }
    assert.deepEqual(await dimensions(), beforeCover);
    await observation.evaluate(state => state.begin());
    const before = await capture();
    await writeFile(gate, '');
    await page.waitForFunction(state => state.received, observation, { polling: 50, timeout: 12_000 });
    await delay(250);
    const covered = await capture();
    const events = await observation.evaluate(state => state.finish());
    assert.ok(events.packets > 0);
    assert.equal(events.generations, 1);
    if (variant === 'candidate') {
      assert.equal(events.batches, 0);
      assert.equal(await readyRow.count(), 1, 'The hidden terminal keeps its previous DOM until reveal');
    } else if (!minimized) {
      assert.ok(events.batches >= 10, `Expected baseline terminal updates, saw ${events.batches}`);
    }
    let readReveal;
    if (!minimized) {
      readReveal = await observeTerminalReveal(app, area);
      await observation.evaluate(state => state.armReveal());
    }
    const revealStarted = performance.timeOrigin + performance.now();
    if (minimized) {
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].restore());
      await page.waitForFunction(state => state.windowHidden === false, observation, { polling: 50 });
    } else await closePreview();
    await waitForOutput();
    const assertionAt = performance.timeOrigin + performance.now();
    const revealDomMs = assertionAt - revealStarted;
    assert.deepEqual(await dimensions(), beforeCover);
    let revealStages;
    if (readReveal) {
      const stage = await observation.evaluate((state, area) => state.readReveal(area), area);
      assert.ok(stage.clickAt <= stage.closedAt && stage.clickAt <= stage.outputAt, JSON.stringify(stage));
      assert.ok(stage.marker.x >= 0 && stage.marker.x + stage.marker.width <= area.width &&
        stage.marker.y >= 0 && stage.marker.y + stage.marker.height <= area.height, JSON.stringify({ area, stage }));
      await settle(page);
      revealStages = { dispatchToClickMs: stage.clickAt - revealStarted, ...await readReveal(stage),
        domToAssertionMs: assertionAt - stage.outputAt };
      assert.ok(revealStages.notifications > 0, 'The frame observer must receive a notification as the preview closes');
      console.log(`${variant} terminal reveal: ${JSON.stringify(revealStages)}`);
    }
    const restored = minimized ? 'restored' : 'revealed';
    if (saveImage) await page.screenshot({ path: reportPath.replace(/\.json$/, `-${variant}-terminal-${restored}.png`) });
    let resizeWhileCovered;
    if (!minimized && variant === 'candidate') {
      await readme.click();
      await waitForPreview();
      await page.waitForFunction(state => state.intersecting === false, observation);
      const windowWidths = [800, 740];
      for (const width of windowWidths) {
        await resize(app, page, [width, initialSize[1]]);
        await settle(page);
        assert.ok(await preview.isVisible());
        assert.deepEqual(await dimensions(), beforeCover, 'Resizing under the preview must preserve the painted grid');
      }
      await closePreview();
      await page.waitForFunction(width => document.querySelector('.terminal-canvas .xterm-screen').offsetWidth <= width,
        beforeCover[0] - 80);
      await waitForOutput();
      resizeWhileCovered = { windowWidths, originalGrid: beforeCover, revealedGrid: await dimensions() };
    }
    await terminalLine(page, linux ? `printf '%s_%s\\n' span_covered still_open` : 'echo span_covered_still_open', 'span_covered_still_open');
    assert.equal(await observation.evaluate(state => state.finish().generations), 1);
    return { variant, events, before, covered, revealDomMs, revealStages, resizeWhileCovered };
  } finally {
    await observation.evaluate(state => state.stop());
    await observation.dispose();
  }
}

async function scroll(page) {
  const timeline = page.getByTestId('transcript');
  await timeline.hover({ position: { x: 24, y: 80 } });
  const offsets = [];
  for (let index = 0; index < 36; index++) {
    await page.mouse.wheel(0, index % 12 < 6 ? -176 : 176);
    await delay(60);
    if (index % 6 === 5) offsets.push(await timeline.evaluate(element => element.scrollTop));
  }
  assert.ok(Math.max(...offsets) - Math.min(...offsets) >= 500, `The transcript did not scroll through history: ${offsets}`);
  return { wheelSteps: 36, offsets };
}

async function reflow(page, app) {
  const column = page.locator('.timeline .reading-column');
  const start = await column.evaluate(element => element.clientWidth);
  for (let index = 0; index < 24; index++) {
    await resize(app, page, index % 2 === 0 ? [740, initialSize[1]] : initialSize);
    if (index === 0) assert.ok(start - await column.evaluate(element => element.clientWidth) >= 80);
  }
  assert.ok(Math.abs(start - await column.evaluate(element => element.clientWidth)) <= 2);
  return { widthChanges: 24 };
}

const exercise = { output, scroll, reflow };

async function snapshot(app, page, cdp, pid) {
  const [dom, heap, performance, scene, native] = await Promise.all([
    cdp.send('Memory.getDOMCounters'), cdp.send('Runtime.getHeapUsage'), cdp.send('Performance.getMetrics'),
    page.evaluate(() => {
      const timeline = document.querySelector('.timeline');
      const terminal = document.querySelector('.terminal-canvas');
      return { historyElements: timeline.querySelectorAll('*').length, terminalElements: terminal?.querySelectorAll('*').length ?? 0 };
    }),
    app.evaluate(({ app }, pid) => {
      const memory = process.platform === 'win32' ? app.getAppMetrics().find(metric => metric.pid === pid)?.memory : undefined;
      return { mainCpuMs: process.getCPUUsage().cumulativeCPUUsage * 1000, memory };
    }, pid),
  ]);
  const metrics = Object.fromEntries(performance.metrics.map(({ name, value }) => [name, value]));
  const renderer = { cpuMs: metrics.ProcessTime * 1000, mainThreadCpuMs: metrics.ThreadTime * 1000 };
  if (linux) {
    const map = await readFile(`/proc/${pid}/smaps_rollup`, 'utf8');
    const kib = name => Number(map.match(new RegExp(`^${name}:\\s+(\\d+)`, 'm'))[1]);
    Object.assign(renderer, { pssKiB: kib('Pss'), rssKiB: kib('Rss'), privateDirtyKiB: kib('Private_Dirty') });
  } else {
    assert.ok(native.memory?.workingSetSize > 0 && native.memory.privateBytes > 0);
    Object.assign(renderer, { workingSetKiB: native.memory.workingSetSize, privateKiB: native.memory.privateBytes });
  }
  return { renderer, mainCpuMs: native.mainCpuMs, dom, usedHeapBytes: heap.usedSize, ...scene };
}

async function trial(workload, variant, executable, recordEcho, saveImage) {
  const profile = await mkdtemp(join(tmpdir(), 'span-resource-'));
  let app;
  let interactionWatchdog;
  try {
    app = await electron.launch({ executablePath: executable,
      args: ['--demo', '--force-device-scale-factor=1', '--disable-gpu', '--terminal-renderer=dom',
        ...(linux ? ['--no-sandbox', '--disable-webgl'] : [])],
      env: { ...process.env, SPAN_PREVIEW_PROFILE: profile },
    });
    if (workload === 'interaction') {
      interactionWatchdog = setTimeout(() => {
        console.error(`${variant} terminal interaction did not finish within 45s`);
        app.process().kill();
        process.exit(1);
      }, 45_000);
    }
    const page = await app.firstWindow();
    if (workload === 'interaction') page.setDefaultTimeout(interactionTimeoutMs);
    await resize(app, page, initialSize);
    const tail = page.getByTestId('transcript').getByText('第 160 项', { exact: false });
    await tail.waitFor();
    const openTerminal = () => page.getByRole('button', { name: '切换终端' }).click();
    if (workload === 'interaction') {
      await openTerminal();
      const screenshot = reportPath.replace(/\.json$/, `-${variant}-terminal-end.png`);
      try {
        return await terminalInteraction(app, page, screenshot, variant, recordEcho);
      } catch (error) {
        console.error(`${variant} terminal interaction failed`, error);
        await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.webContents.endFrameSubscription())
          .catch(() => {});
        await page.screenshot({ path: screenshot, timeout: interactionTimeoutMs }).catch(() => {});
        throw error;
      }
    }
    const [pid, cdp] = await Promise.all([
      app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getOSProcessId()),
      page.context().newCDPSession(page),
    ]);
    await cdp.send('Performance.enable');
    const capture = () => snapshot(app, page, cdp, pid);
    const beforeOpen = await capture();
    await openTerminal();
    if (workload === 'covered' || workload === 'minimized') {
      return await hiddenOutput(app, page, { profile, capture, variant, saveImage, minimized: workload === 'minimized' });
    }
    await terminalLine(page, linux ? `printf '%s_%s\\n' resources ready` : 'echo resources_ready', 'resources_ready');
    await settle(page);
    const beforeWorkload = await capture();
    assert.ok(beforeWorkload.terminalElements > 0);
    const startedAt = performance.now();
    const events = await exercise[workload]?.(page, app) ?? {};
    await delay(Math.max(0, activeWindowMs - (performance.now() - startedAt)));
    await settle(page);
    const activeMs = Math.round(performance.now() - startedAt);
    const active = await capture();
    await page.getByRole('button', { name: '关闭终端' }).click();
    await page.locator('.terminal-canvas').waitFor({ state: 'detached' });
    await settle(page);
    const closed = await capture();
    assert.equal(closed.terminalElements, 0);
    await delay(2000);
    const settled = await capture();
    await cdp.send('HeapProfiler.collectGarbage');
    const diagnosticGc = await capture();
    return { workload, variant, events, activeMs, beforeOpen, beforeWorkload, active, closed, settled, diagnosticGc };
  } finally {
    try {
      await app?.close();
    } finally {
      clearTimeout(interactionWatchdog);
      await rm(profile, { recursive: true, force: true, maxRetries: 3 });
    }
  }
}

const report = {
  platform: process.platform, osRelease: release(), availableCpus: availableParallelism(), terminalRenderer: 'dom',
  window: initialSize, activeWindowMs, baselineCommit, coveredBaselineCommit, minimizedBaselineCommit,
  trials: [], interaction: [], palettes: [], covered: [], minimized: [],
};
const run = (workload, variant) => trial(workload, variant, variant === 'baseline' ? baselineBinary : binary);
const publish = () => writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
for (const [workload, hiddenBaseline] of [['covered', coveredBaseline], ['minimized', minimizedBaseline]]) {
  if (!hiddenBaseline) continue;
  for (const [index, variant] of ['baseline', 'candidate', 'candidate', 'baseline'].entries()) {
    const executable = variant === 'baseline' ? hiddenBaseline : binary;
    const sample = await trial(workload, variant, executable, undefined, index < 2);
    report[workload].push(sample);
    await publish();
    console.log(`${variant} ${workload} terminal DOM batches: ${sample.events.batches}`);
  }
}
let outputPair = 0;
for (const workload of ['idle', 'output', 'scroll', 'reflow', 'reflow', 'scroll', 'output', 'idle']) {
  const variants = workload === 'output' && baselineBinary
    ? (outputPair++ === 0 ? ['baseline', 'candidate'] : ['candidate', 'baseline']) : ['candidate'];
  for (const variant of variants) {
    const sample = await run(workload, variant);
    report.trials.push(sample);
    await publish();
    console.log(`${variant} ${workload} ${sample.activeMs}ms, DOM nodes ${sample.beforeWorkload.dom.nodes}` +
      ` → ${sample.active.dom.nodes} → ${sample.settled.dom.nodes} → ${sample.diagnosticGc.dom.nodes}`);
  }
}
if (baselineBinary) {
  for (const [index, variant] of ['baseline', 'candidate', 'candidate', 'baseline'].entries()) {
    const pair = Math.floor(index / 2) + 1;
    const executable = variant === 'baseline' ? baselineBinary : binary;
    const samples = await trial('interaction', variant, executable, async sample => {
      report.interaction.push({ workload: 'interaction', variant, pair, ...sample });
      await publish();
      const painted = sample.streaming.map(key => key.paintedMs).sort((a, b) => a - b);
      const p95 = painted[Math.ceil(painted.length * 0.95) - 1];
      console.log(`${variant} terminal echo pair ${pair}: streaming P95 ${p95.toFixed(1)} ms across ${painted.length} keys`);
    });
    report.palettes.push({ variant, pair, samples });
    await publish();
  }
}
