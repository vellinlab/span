import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { burstMarker, terminalBurst } from './terminal-fixture.mjs';

const [candidate, baseline] = process.argv.slice(2);
const maxPending = 256 * 1024;
const nearlyFull = maxPending - 16 * 1024;
const windows = process.platform === 'win32';
const burst = terminalBurst(windows) + '\r';

async function until(condition, message) {
  const deadline = performance.now() + 30_000;
  while (!condition()) {
    if (performance.now() >= deadline) throw new Error(message());
    await delay(15);
  }
}

async function measure(binary, controlled) {
  const core = spawn(binary, [], { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
  const output = createInterface({ input: core.stdout });
  const pending = new Map();
  const exited = new Promise(resolve => core.once('close', resolve));
  let sequence = 0;
  let generation = 1;
  let count = 0;
  let consumed = 0;
  let ack = false;
  let tail = '';
  let complete = false;
  let failure;
  let cursorReply;
  function send(method, params = {}) {
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const timer = globalThis.setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method} did not complete`));
      }, 8000);
      pending.set(id, packet => {
        clearTimeout(timer);
        if (packet.error) reject(new Error(packet.error));
        else resolve();
      });
      core.stdin.write(JSON.stringify({ id, method, params: { generation, ...params } }) + '\n');
    });
  }
  core.on('error', error => { failure = error; });
  core.stdin.on('error', error => { failure = error; });
  output.on('line', text => {
    const packet = JSON.parse(text);
    if (packet.id != null) {
      pending.get(packet.id)?.(packet);
      pending.delete(packet.id);
    }
    if (packet.generation !== generation) return;
    if (packet.event === 'terminal-error') failure = new Error(packet.data);
    if (packet.event !== 'terminal') return;
    const bytes = Buffer.from(packet.data, 'base64');
    count += bytes.length;
    tail = (tail + bytes.toString()).slice(-512);
    if (windows && !cursorReply && tail.includes('\x1b[6n')) {
      // ConPTY asks the emulator for its cursor position before it starts the Windows shell.
      cursorReply = send('terminal.write', { data: '\x1b[1;1R' }).catch(error => { failure = error; });
    }
    complete ||= tail.includes(burstMarker);
    if (ack) {
      consumed += bytes.length;
      if (consumed >= 64 * 1024) {
        send('terminal.ack', { bytes: consumed }).catch(error => { failure = error; });
        consumed = 0;
      }
    }
  });
  const diagnostic = message => () => `${message} Received ${count} bytes. Output tail ${JSON.stringify(tail)}`;
  async function start() {
    cursorReply = null;
    await send('terminal.start', { cwd: process.cwd(), cols: 180, rows: 25 });
    if (windows) {
      await until(() => failure || cursorReply, diagnostic('ConPTY did not request the cursor position.'));
      await cursorReply;
      await until(() => failure || count > 4, diagnostic('The shell did not respond after supplying the cursor position.'));
      if (failure) throw failure;
    }
  }
  try {
    await start();
    await send('terminal.write', { data: burst });
    await until(() => failure || count >= nearlyFull, diagnostic('The terminal burst did not reach the start of the final output chunk.'));
    await delay(600);
    if (failure) throw failure;
    const withheld = count;
    if (controlled) assert.ok(withheld <= maxPending, `Exported ${withheld} unacknowledged bytes`);
    const startClose = performance.now();
    await send('terminal.close');
    const closeMs = Math.round(performance.now() - startClose);
    if (!controlled) return { withheld, closeMs };

    generation++;
    count = 0;
    tail = '';
    complete = false;
    await start();
    await send('terminal.write', { data: burst });
    await until(() => failure || count >= nearlyFull, diagnostic('The reopened terminal did not fill its first window.'));
    await send('terminal.ack', { generation: generation - 1, bytes: maxPending });
    await delay(1000);
    assert.ok(count <= maxPending, `A stale acknowledgment released the reopened stream: ${count} bytes.`);

    ack = true;
    await send('terminal.ack', { bytes: count });
    await until(() => failure || complete, diagnostic('The burst did not reach its final line after acknowledgments.'));
    if (failure) throw failure;
    assert.ok(count > maxPending * 2);
    await send('terminal.close');
    return { withheld, closeMs, drained: count };
  } finally {
    core.stdin.end();
    const timer = globalThis.setTimeout(() => core.kill(), 2000);
    await exited;
    clearTimeout(timer);
  }
}

const runs = [];
for (const [label, binary] of baseline
  ? [['baseline', baseline], ['candidate', candidate], ['candidate', candidate], ['baseline', baseline]]
  : [['candidate', candidate]]) {
  runs.push({ label, ...await measure(binary, label === 'candidate') });
}
console.log(JSON.stringify(runs));
