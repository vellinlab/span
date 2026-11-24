const jsonRpc = {
  request: (id, method, params) => ({ id, method, params }),
  response: packet => packet.method || packet.id == null ? undefined : {
    id: packet.id, value: packet.result,
    error: packet.error && Object.assign(new Error(packet.error.message), { code: packet.error.code }),
  },
  event: packet => Boolean(packet.method),
};

export function connectRpc(generation, onPacket, onRoute, onClosed, wire = jsonRpc) {
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
    const response = wire.response(data);
    if (response) {
      const call = calls.get(response.id);
      if (!call) return;
      calls.delete(response.id);
      clearTimeout(call.timer);
      if (response.error) call.reject(response.error);
      else call.resolve(response.value);
    } else if (wire.event(data)) {
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
    const packet = wire.request(++next, method, params);
    const { id } = packet;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        calls.delete(id);
        reject(new Error('Agent 响应超时。'));
      }, 30000);
      calls.set(id, { resolve, reject, timer });
      send(packet).catch(error => {
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
