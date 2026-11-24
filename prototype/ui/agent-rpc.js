export function connectRpc(generation, onPacket, onRoute, onClosed) {
  const calls = new Map();
  let next = 0;
  let closed = false;
  let failure;
  let setRoute;
  const started = new Promise(resolve => { setRoute = resolve; });
  const unsubscribe = window.span.onEvent(({ event, generation: source, data }) => {
    if (source !== generation || closed) return;
    if (event === 'agent-route') {
      setRoute(null);
      onRoute(data);
    }
    if (event === 'agent-closed') {
      failure = new Error(data || 'Agent 连接已关闭。');
      close();
      onClosed(failure.message);
    }
    if (event !== 'agent') return;
    const call = data.method ? null : calls.get(data.id);
    if (call) {
      calls.delete(data.id);
      clearTimeout(call.timer);
      if (data.error) call.reject(Object.assign(new Error(data.error.message), { code: data.error.code }));
      else call.resolve(data.result);
    } else if (data.method) {
      onPacket(data);
    }
  });

  async function ready() {
    let timer;
    const expiry = new Promise(resolve => {
      timer = setTimeout(() => resolve(new Error('Agent 连接超时。')), 28000);
    });
    try {
      const error = await Promise.race([started, expiry]);
      if (error) throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  function send(packet) {
    if (closed) return Promise.reject(failure ?? new Error('Agent 连接已关闭。'));
    return window.span.request('agent.send', { generation, packet });
  }

  // Response shapes belong to the wire protocol and are normalized by the adapter.
  /** @param {string} method @param {object | null} params @returns {Promise<any>} */
  function request(method, params = {}) {
    const id = ++next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        calls.delete(id);
        reject(new Error('Agent 响应超时。'));
      }, 30000);
      calls.set(id, { resolve, reject, timer });
      send({ id, method, params }).catch(error => {
        calls.delete(id);
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  function close() {
    if (closed) return;
    closed = true;
    unsubscribe();
    const error = failure ?? new Error('Agent 连接已关闭。');
    setRoute(error);
    for (const call of calls.values()) {
      clearTimeout(call.timer);
      call.reject(error);
    }
    calls.clear();
  }

  return { ready, request, send, close };
}
