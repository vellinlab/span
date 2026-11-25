const { randomBytes, randomInt } = require('node:crypto');
const { createServer } = require('node:net');

async function prepareKilo(ssh) {
  const listener = createServer();
  const localPort = await new Promise((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', () => {
      const { port } = listener.address();
      listener.close(error => error ? reject(error) : resolve(port));
    });
  });
  return { localPort, remotePort: ssh ? randomInt(49152, 65536) : localPort,
    password: randomBytes(32).toString('hex') };
}

async function kiloGoal(connection, params) {
  const probe = params.probe === true;
  const signal = AbortSignal.any([connection.signal, AbortSignal.timeout(probe ? 2500 : 10000)]);
  const headers = { Authorization: 'Basic ' + Buffer.from(`span:${connection.password}`).toString('base64') };
  const { sessionId, cwd, action, objective, options } = params;
  if (typeof cwd !== 'string' || !cwd || cwd.length > 32768
    || (!probe && (typeof sessionId !== 'string' || !/^ses_[a-z0-9]{1,100}$/i.test(sessionId)))) {
    throw new Error('无效的 Kilo 会话。');
  }
  const endpoint = `http://127.0.0.1:${connection.localPort}`;
  if (probe) {
    const url = new URL('/command', endpoint);
    url.searchParams.set('directory', cwd);
    const response = await fetch(url, { headers, signal, redirect: 'error' });
    if (!response.ok) {
      await response.body?.cancel();
      return false;
    }
    const commands = await response.json();
    return Array.isArray(commands) && commands.some(command => command.name === 'goal' && command.source === 'command');
  }
  const update = action !== undefined;
  const starts = action === 'set' || action === 'edit';
  if (starts && (typeof objective !== 'string' || !objective.trim() || objective.length > 10000)) {
    throw new Error('请输入不超过 10,000 字符的目标。');
  }
  if (update && !starts && !['pause', 'resume', 'clear'].includes(action)) throw new Error('无效的目标操作。');
  const url = new URL(`/session/${sessionId}${update ? '/command' : ''}`, endpoint);
  url.searchParams.set('directory', cwd);
  let body;
  if (update) {
    headers['Content-Type'] = 'application/json';
    const selected = action === 'resume' || starts ? options : null;
    body = JSON.stringify({ command: 'goal', arguments: starts ? '-- ' + objective.trim() : action,
      model: typeof selected?.model === 'string' ? selected.model : undefined,
      agent: typeof selected?.mode === 'string' ? selected.mode : undefined,
      variant: typeof selected?.effort === 'string' ? selected.effort : undefined });
  }
  const response = await fetch(url, { method: update ? 'POST' : 'GET', headers, body, redirect: 'error', signal });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Kilo 目标请求失败（HTTP ${response.status}）。`);
  }
  if (update) {
    await response.body?.cancel();
    return null;
  }
  return (await response.json()).metadata?.['kilo.goal'] ?? null;
}

module.exports = { prepareKilo, kiloGoal };
