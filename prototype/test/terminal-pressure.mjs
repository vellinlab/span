import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';

const [candidate, baseline] = process.argv.slice(2);
const maxPending = 256 * 1024;
const windows = process.platform === 'win32';
const line = 'span-pressure '.repeat(6);
const burst = windows
  ? `(for /l %i in (1,1,50000) do @echo ${line.trimEnd()}) & echo span_pressure_%SPAN_CI_EMPTY%done\r`
  : `yes '${line}' | head -c 4194304; printf '\\n%s_%s\\n' span_pressure done\r`;

async function until(condition, message) {
  const deadline = performance.now() + 20_000;
  while (!condition()) {
    if (performance.now() >= deadline) throw new Error(message);
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
    if (packet.event !== 'terminal' || packet.generation !== generation) return;
    const bytes = Buffer.from(packet.data, 'base64');
    count += bytes.length;
    tail = (tail + bytes.toString()).slice(-512);
    complete ||= tail.includes('span_pressure_done');
    if (ack) {
      consumed += bytes.length;
      if (consumed >= 64 * 1024) {
        send('terminal.ack', { bytes: consumed }).catch(error => { failure = error; });
        consumed = 0;
      }
    }
  });
  try {
    await send('terminal.start', { cwd: process.cwd(), cols: 180, rows: 25 });
    await send('terminal.write', { data: burst });
    await until(() => failure || count >= 192 * 1024, 'The terminal burst did not reach 192 KiB.');
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
    ack = true;
    tail = '';
    complete = false;
    await send('terminal.start', { cwd: process.cwd(), cols: 180, rows: 25 });
    await send('terminal.ack', { generation: generation - 1, bytes: maxPending });
    await send('terminal.write', { data: burst });
    await until(() => failure || complete, 'The burst did not reach its final line after acknowledgments.');
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
