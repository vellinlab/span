import { applyTimeline } from './timeline.js';
import { parseFileReferences } from './file-references.js';

export const acpTurnId = index => 'acp-turn:' + index;
const status = { pending: 'pending', in_progress: 'running', completed: 'completed', failed: 'failed' };
const planStatus = { pending: 'pending', in_progress: 'running', completed: 'completed' };
const textOf = block => block?.type === 'text' && typeof block.text === 'string' ? block.text : '';

export function acpOperation(tool = {}, cwd) {
  const input = tool.rawInput;
  const path = tool.locations?.[0]?.path ?? input?.filePath ?? input?.filepath;
  if (tool.kind === 'execute' || typeof input?.command === 'string') {
    return { kind: 'command', command: input?.command, cwd: input?.workdir ?? path ?? cwd };
  }
  if (tool.kind === 'fetch') return { kind: 'network', target: input?.url ?? tool.title };
  if (path) return { kind: 'files', target: path, cwd };
  return { kind: 'permissions', cwd };
}

export function acpTurn(id, notify, childSession) {
  const reply = new Map();
  const tools = new Map();
  const members = new Map();
  const thoughtIds = new Map();
  const artifacts = new Map();
  const item = (value, final = false) => notify({ kind: 'item', item: { turnId: id, ...value }, final });

  function tool(update) {
    if (!update.toolCallId) return;
    const key = 'tool:' + update.toolCallId;
    const current = { ...tools.get(key), ...update };
    tools.set(key, current);
    const text = current.content?.map(part => textOf(part.content)).filter(Boolean).join('\n')
      || current.rawOutput?.output || current.rawOutput?.error;
    const toolStatus = status[current.status] ?? 'unknown';
    const final = toolStatus === 'completed' || toolStatus === 'failed';
    const command = current.rawInput?.command;
    const path = current.locations?.[0]?.path;
    const child = childSession(current);
    const actor = child?.id ? { id: child.id, name: child.title } : undefined;
    if (actor && !members.has(actor.id)) {
      members.set(actor.id, actor);
      item({ kind: 'delegation', id: 'member:' + actor.id, action: '子代理', members: [actor] }, true);
    }
    const owner = actor ? { actor, depth: child.depth } : {};
    const diff = current.rawInput?.diff ?? current.rawOutput?.metadata?.diff;
    if (current.kind === 'execute' && typeof command === 'string') {
      const exit = current.rawOutput?.metadata?.exit;
      item({ kind: 'command', id: key, command, cwd: path ?? current.rawInput?.workdir,
        text, exitCode: Number.isInteger(exit) ? exit : undefined, status: toolStatus, ...owner }, final);
    } else if (current.kind === 'edit' && typeof diff === 'string') {
      item({ kind: 'patch', id: key, files: path ? [{ path, diff }] : [], text: path ? undefined : diff,
        status: toolStatus, ...owner }, final);
    } else {
      item({ kind: 'tool', id: key, name: current.title, text, status: toolStatus,
        target: path ? { kind: 'path', path } : undefined, ...owner }, final);
    }
    if (final) tools.delete(key);
  }

  function update(update) {
    const key = update.messageId ?? 'current';
    const text = textOf(update.content);
    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
        if (text) {
          const messageId = 'message:' + key;
          if (!reply.has(messageId)) reply.set(messageId, []);
          reply.get(messageId).push(text);
          notify({ kind: 'delta', delta: { id: messageId, turnId: id, kind: 'message', text } });
        } else if (update.content?.type === 'resource_link') {
          const { uri, name } = update.content;
          if (!uri || artifacts.has(uri)) return;
          artifacts.set(uri, true);
          const artifact = uri.startsWith('file:') ? { kind: 'file', path: filePath(uri) }
            : /^https?:\/\//i.test(uri) ? { kind: 'link', url: uri } : null;
          if (artifact) item({ kind: 'artifact', id: 'artifact:' + uri,
            artifacts: [{ ...artifact, id: uri, name: name || uri }] }, true);
        }
        break;
      case 'agent_thought_chunk':
        if (!text) return;
        if (!thoughtIds.has(key)) thoughtIds.set(key, Math.min(thoughtIds.size, 23));
        notify({ kind: 'delta', delta: { id: 'reasoning', turnId: id, kind: 'reasoning', section: thoughtIds.get(key), text } });
        break;
      case 'tool_call':
      case 'tool_call_update':
        tool(update);
        break;
      case 'plan':
        item({ kind: 'plan', id: 'plan', steps: (update.entries ?? []).map(entry => ({
          text: entry.content, status: planStatus[entry.status] ?? 'pending',
        })) });
        break;
    }
  }

  function finish(cancelled = false) {
    const final = [...reply.keys()].at(-1);
    for (const [messageId, chunks] of reply) {
      item({ kind: 'message', id: messageId, text: chunks.join(''), phase: messageId === final ? 'final' : 'commentary' }, true);
    }
    for (const current of tools.values()) {
      const interrupted = cancelled && (current.status === 'pending' || current.status === 'in_progress');
      tool({ ...current, status: interrupted ? 'failed' : current.status });
    }
  }

  return { update, finish };
}

function filePath(uri) {
  try {
    const url = new URL(uri);
    const path = decodeURIComponent(url.pathname);
    if (url.host) return '//' + url.host + path;
    return /^\/[a-z]:\//i.test(path) ? path.slice(1) : path;
  } catch {
    return uri;
  }
}

export function acpReplay(childSession) {
  const turns = [];
  let events = [];
  let projection;
  let user;
  let id;
  function publishUser() {
    if (!user) return;
    const parsed = parseFileReferences(user.chunks.join(''));
    const attachments = [...(parsed.attachments ?? []), ...user.attachments];
    events.push({ kind: 'item', final: true, item: {
      kind: 'user', id: 'user', turnId: id, text: parsed.text, attachments,
    } });
    user = undefined;
  }
  function saveTurn() {
    if (!projection) return;
    publishUser();
    projection.finish();
    const rows = applyTimeline([], events).map(row => row.itemKey ? { ...row, id: row.key } : row);
    turns.push({ id, run: { id, status: 'completed' }, rows });
    events = [];
  }
  function beginTurn() {
    saveTurn();
    id = acpTurnId(turns.length);
    projection = acpTurn(id, event => events.push(event), childSession);
  }
  return {
    update(update) {
      if (update.sessionUpdate === 'user_message_chunk') {
        if (!projection || !user || user.id !== update.messageId) beginTurn();
        user ??= { id: update.messageId, chunks: [], attachments: [] };
        const block = update.content;
        if (block?.type === 'resource_link' && block.uri?.startsWith('file:')) {
          user.attachments.push({ kind: 'file', id: block.uri, name: block.name, path: filePath(block.uri), reference: true });
        } else if (block?.type === 'image') {
          user.attachments.push({ kind: 'image', id: 'image:' + user.attachments.length, name: '图片' });
        } else user.chunks.push(textOf(block));
        return;
      }
      if (!['agent_message_chunk', 'agent_thought_chunk', 'tool_call', 'tool_call_update', 'plan'].includes(update.sessionUpdate)) return;
      if (!projection) beginTurn();
      publishUser();
      projection.update(update);
    },
    finish() {
      saveTurn();
      return turns;
    },
  };
}
