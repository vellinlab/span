import { acpTurn } from './acp-items.js';
import { applyTimeline, mergeHistory } from './timeline.js';

const nativeId = value => typeof value === 'string' && /^ses_[a-z0-9]{1,100}$/i.test(value);
const toolStatuses = { pending: 'pending', running: 'in_progress', completed: 'completed', error: 'failed' };
const toolKinds = {
  bash: 'execute', shell: 'execute', task: 'think', edit: 'edit', patch: 'edit', apply_patch: 'edit', write: 'edit',
  glob: 'search', grep: 'search',
};

function traceRows(messages, projectTask) {
  const events = [];
  for (const { info, parts } of messages) {
    if (!info?.id || !Array.isArray(parts)) continue;
    const user = info.role === 'user';
    if (!user && info.role !== 'assistant') continue;
    const turnId = user ? info.id : info.parentID ?? info.id;
    const item = value => events.push({ kind: 'item', final: true, item: { turnId, ...value } });
    let tools;
    for (const part of parts) {
      if (!part.id || part.ignored || part.synthetic) continue;
      if (part.type === 'text' && part.text) {
        if (user) item({ kind: 'user', id: part.id, text: part.text });
        else item({ kind: 'message', id: part.id, text: part.text, phase: info.finish === 'tool-calls' ? 'commentary' : 'final' });
      } else if (!user && part.type === 'reasoning' && part.text) {
        item({ kind: 'reasoning', id: part.id, sections: [part.text] });
      } else if (!user && part.type === 'tool' && part.state) {
        const { state, tool } = part;
        const kind = toolKinds[tool] ?? 'other';
        const directory = kind === 'search' ? state.input?.path ?? info.path?.cwd : undefined;
        tools ??= acpTurn(turnId, event => events.push(event), { projectTask });
        tools.update({ sessionUpdate: 'tool_call', toolCallId: part.id, title: state.title || tool,
          kind, status: toolStatuses[state.status], rawInput: state.input,
          locations: directory ? [{ path: directory }] : undefined,
          rawOutput: { output: state.output, error: state.error, metadata: state.metadata } });
      }
    }
  }
  return applyTimeline([], events);
}

export function createAcpTaskTraces(root, { ref, readHistory }) {
  const members = new Map();
  const subscriptions = new Set();

  function project(parentId, tool, status, text) {
    const input = tool.rawInput;
    if (tool.kind !== 'think' || typeof input?.subagent_type !== 'string' || typeof input.prompt !== 'string') return;
    const metadata = tool.rawOutput?.metadata;
    const sessionId = metadata?.sessionId;
    const attached = nativeId(sessionId) && sessionId !== parentId && metadata.parentSessionId === parentId;
    const name = typeof input.description === 'string' && input.description.trim() || input.subagent_type;
    const member = { id: attached ? sessionId : 'task:' + tool.toolCallId, name, role: input.subagent_type,
      status: attached && metadata.background === true && status === 'completed' ? 'unknown' : status };
    if (attached) {
      Object.assign(member, { session: ref(sessionId), parent: ref(parentId), attachedTranscript: true });
      members.set(sessionId, member);
    }
    return { kind: 'delegation', action: '子代理', members: [member],
      text: status === 'failed' || !attached && status === 'completed' ? text : undefined };
  }

  return {
    project: (tool, status, text) => project(root.id, tool, status, text),
    members: () => [...members.values()],
    watch(id, listener) {
      const member = members.get(id);
      if (!member) throw new Error('当前会话没有这个子代理。');
      let subscribed = true;
      let view = { rows: [], cursor: null, loading: false, loadOlder: () => { if (view.cursor) void load(view.cursor); } };
      function publish(changes) {
        view = { ...view, ...changes };
        listener(view);
      }
      async function load(cursor) {
        if (!subscribed || view.loading) return;
        publish({ loading: true, error: undefined });
        try {
          const seen = new Set();
          do {
            seen.add(cursor);
            const page = await readHistory(id, member.parent.id, root.entry.cwd, cursor);
            if (!subscribed) return;
            const rows = traceRows(page.items, (tool, status, text) => project(id, tool, status, text));
            cursor = seen.has(page.cursor) ? null : page.cursor;
            if (rows.length || !cursor) {
              publish({ rows: mergeHistory(view.rows, rows), cursor, loading: false });
              return;
            }
          } while (subscribed);
        } catch (error) {
          if (subscribed) publish({ loading: false, error: error.message });
        }
      }
      function unsubscribe() {
        subscribed = false;
        subscriptions.delete(unsubscribe);
      }
      subscriptions.add(unsubscribe);
      void load();
      return unsubscribe;
    },
    close() {
      for (const unsubscribe of subscriptions) unsubscribe();
      members.clear();
    },
  };
}
