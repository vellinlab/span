const { randomBytes, randomInt } = require('node:crypto');
const { createServer } = require('node:net');

async function prepareAcpHttp(ssh) {
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

function validSessionId(value) {
  return typeof value === 'string' && /^ses_[a-z0-9]{1,100}$/i.test(value);
}

function acpRequest(connection, route, { cwd, query = {}, timeout = 10000, headers, ...request }) {
  const url = new URL(route, `http://127.0.0.1:${connection.localPort}`);
  url.searchParams.set('directory', cwd);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  const authorization = 'Basic ' + Buffer.from(`span:${connection.password}`).toString('base64');
  const signal = AbortSignal.any([connection.signal, AbortSignal.timeout(timeout)]);
  return fetch(url, { ...request, headers: { ...headers, Authorization: authorization }, signal, redirect: 'error' });
}

async function requireOk(response) {
  if (response.ok) return response;
  await response.body?.cancel();
  throw new Error(`读取子代理记录失败（HTTP ${response.status}）。`);
}

async function acpChildHistory(connection, { sessionId, parentId, cwd, cursor }) {
  if (!validSessionId(sessionId) || !validSessionId(parentId) || sessionId === parentId ||
    typeof cwd !== 'string' || !cwd || cwd.length > 32768 ||
    (cursor != null && (typeof cursor !== 'string' || cursor.length > 1024))) {
    throw new Error('无效的子代理会话。');
  }
  const route = `/session/${sessionId}`;
  const session = await requireOk(await acpRequest(connection, route, { cwd }));
  if ((await session.json()).parentID !== parentId) throw new Error('该子代理不属于此父会话。');
  const query = { limit: 40, ...(cursor && { before: cursor }) };
  const response = await requireOk(await acpRequest(connection, route + '/message', { cwd, query }));
  return { items: await response.json(), cursor: response.headers.get('x-next-cursor') };
}

module.exports = { prepareAcpHttp, acpRequest, validSessionId, acpChildHistory };
