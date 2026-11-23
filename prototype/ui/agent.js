export function connectAgent(generation, onPacket, onClosed) {
  const calls = new Map();
  let next = 0;
  let closed = false;
  const stop = window.span.onEvent(({ event, generation: source, data }) => {
    if (source !== generation) return;
    if (event === 'agent-closed') {
      close();
      onClosed();
    }
    if (event !== 'agent') return;
    const call = data.method ? null : calls.get(data.id);
    if (call) {
      calls.delete(data.id);
      clearTimeout(call.timer);
      if (data.error) call.reject(new Error(data.error.message));
      else call.resolve(data.result);
    } else if (data.method) {
      onPacket(data);
    }
  });

  function send(packet) {
    if (closed) return Promise.reject(new Error('Agent 连接已关闭。'));
    return window.span.request('agent.send', { generation, packet });
  }

  function request(method, params = {}) {
    const id = ++next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        calls.delete(id);
        reject(new Error('Agent 响应超时。'));
      }, 20000);
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
    stop();
    for (const call of calls.values()) {
      clearTimeout(call.timer);
      call.reject(new Error('Agent 连接已关闭。'));
    }
    calls.clear();
  }

  return { request, send, close };
}

export function historyRows(turns) {
  return turns.flatMap(turn => (turn.items ?? []).map(toRow).filter(Boolean));
}

export function toRow(item) {
  switch (item.type) {
    case 'userMessage': {
      const text = item.content?.filter(part => part.type === 'text').map(part => part.text).join('\n') ?? '';
      return { id: item.id, kind: 'user', text };
    }
    case 'agentMessage':
      return { id: item.id, kind: 'agent', text: item.text ?? '' };
    case 'commandExecution':
      return { id: item.id, kind: 'activity', title: item.command, text: item.aggregatedOutput ?? '' };
    case 'fileChange':
      return { id: item.id, kind: 'activity', title: '文件变更',
        text: item.changes?.map(change => change.diff).join('\n') ?? '' };
    case 'contextCompaction':
      return { id: item.id, kind: 'activity', title: '已压缩上下文', text: '' };
    default:
      return null;
  }
}
