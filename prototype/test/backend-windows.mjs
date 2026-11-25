import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const binary = resolve(process.argv[2]);
const fixture = await mkdtemp(join(process.env.RUNNER_TEMP || tmpdir(), 'sw-'));
const codexHome = join(fixture, 'c');
const installDir = join(codexHome, 'packages', 'standalone', 'current', 'bin');
const codex = join(installDir, 'codex.exe');
const socket = join(codexHome, 'app-server-control', 'app-server-control.sock');
const portFile = join(fixture, 'port');
const env = { ...process.env, CODEX_HOME: codexHome };
delete env.SPAN_CODEX_PATH;
delete env.CODEX_CLI_PATH;

function start(executable, args, environment = env) {
  const child = spawn(executable, args, { env: environment, stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true });
  const finished = new Promise(resolve => {
    child.once('error', error => resolve({ error }));
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  return { child, finished };
}

async function run(executable, args, environment) {
  const { finished } = start(executable, args, environment);
  const { code, signal, error } = await finished;
  if (error) throw error;
  assert.equal(code, 0, `${executable} ${args.join(' ')} exited with ${signal || code}`);
}

async function directoryEntries(path) {
  return readdir(path).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
}

async function hasEntry(path) {
  return (await directoryEntries(dirname(path))).includes(basename(path));
}

async function ready(path, process) {
  for (let attempt = 0; attempt < 150; attempt++) {
    if (!process.child.pid || process.child.exitCode !== null || process.child.signalCode !== null) {
      const { error } = await process.finished;
      throw error ?? new Error(`Process exited before creating ${path}`);
    }
    if (await hasEntry(path)) return;
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${path}; directory entries: ${JSON.stringify(await directoryEntries(dirname(path)))}`);
}

async function stop(process) {
  if (!process) return;
  process.child.kill();
  await process.finished;
}

const check = (route, environment, ...flags) => run(process.execPath, ['prototype/test/real-agent.mjs', binary, route, ...flags], environment);
let gateway, shared;
try {
  await mkdir(installDir, { recursive: true });
  const [tag] = (await readFile('packaging/app-server-baseline', 'utf8')).trim().split(/\s+/);
  const asset = 'codex-x86_64-pc-windows-msvc.exe.tar.gz';
  const archive = join(fixture, asset);
  await run('curl.exe', ['-fLsS', '--retry', '3', `https://github.com/openai/codex/releases/download/${tag}/${asset}`, '-o', archive]);
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(archive)) hash.update(chunk);
  assert.equal(hash.digest('hex'), '4cfd8acd6dd74ccba36393c33b460907e907a8c19051e16a0d0a9783ae0246c5');
  const nativeTar = join(process.env.SystemRoot, 'System32', 'tar.exe');
  await run(nativeTar, ['-xzf', archive, '-C', fixture]);
  const executable = (await readdir(fixture)).find(name => name.endsWith('.exe'));
  assert.ok(executable, 'The pinned Codex archive must contain a Windows executable.');
  await rename(join(fixture, executable), codex);

  gateway = start('python', ['packaging/test-responses-gateway.py', portFile]);
  await ready(portFile, gateway);
  const port = (await readFile(portFile, 'utf8')).trim();
  assert.match(port, /^\d+$/);
  await writeFile(join(codexHome, 'config.toml'), `model = "span-ci-model"
model_provider = "span_ci"
[features]
shell_snapshot = false
[model_providers.span_ci]
name = "Span CI Responses Gateway"
base_url = "http://127.0.0.1:${port}/v1"
wire_api = "responses"
request_max_retries = 0
stream_max_retries = 0
`);
  await check('stdio');

  shared = start(codex, ['app-server', '--listen', 'unix://']);
  await ready(socket, shared);
  await check('shared', { ...env, SPAN_CODEX_PATH: codex }, '--skills', '--agents');
  assert.equal(shared.child.exitCode, null, 'Closing Span must keep the shared backend alive.');
  await stop(shared);
  shared = undefined;
  if (!await hasEntry(socket)) await writeFile(socket, '');
  await check('stdio');
  console.log('Verified Windows standalone discovery, shared Codex reuse, and fallback from an unavailable endpoint.');
} finally {
  await stop(shared);
  await stop(gateway);
  await rm(fixture, { recursive: true, force: true, maxRetries: 3 });
}
