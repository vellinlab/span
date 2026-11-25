import { acpTurn, acpTurnId } from './acp-items.js';
import { applyTimeline } from './timeline.js';

const terminalStatuses = new Map([
  ['completed', 'completed'], ['failed', 'failed'], ['cancelled', 'cancelled'], ['disconnected', 'unknown'],
]);

export function createAcpSubagents(root, { ref, notify }) {
  const children = new Map();

  function flush(child) {
    if (!child.events.length) return;
    child.rows = applyTimeline(child.rows, child.events);
    child.events = [];
    child.characters = 0;
  }

  function publish(child) {
    clearTimeout(child.timer);
    child.timer = undefined;
    flush(child);
    for (const listener of child.listeners) listener({ rows: child.rows, run: child.run });
  }

  function enqueue(child, event) {
    child.events.push(event);
    if (event.kind === 'delta') child.characters += event.delta.text.length;
    if (event.final || child.events.length >= 128 || child.characters >= 256 * 1024) flush(child);
    if (child.listeners.size && child.timer === undefined) child.timer = setTimeout(() => publish(child), 32);
  }

  function delegationItem(child) {
    return { kind: 'delegation', id: 'child:' + child.member.id, turnId: child.parentTurn,
      action: '子代理', members: [child.member] };
  }

  function announce(child, spawn) {
    const parent = children.get(child.parentId);
    const item = delegationItem(child);
    if (parent) {
      enqueue(parent, { kind: 'item', item, final: true });
    } else if (root.replay) {
      if (spawn) root.replay.append(item);
    } else if (child.parentTurn) {
      notify(root.id, { kind: 'item', item, final: true });
    }
    if (!root.replay) notify(root.id, { kind: 'member', member: child.member });
  }

  function spawn(parentId, update) {
    const id = update.subagentSessionId;
    if (!id || id === root.id || children.has(id)) return;
    const parentTurn = children.get(parentId)?.run.id ?? root.turn?.run.id;
    const run = { id: acpTurnId(0), status: 'running' };
    const member = { id, name: update.name || '子代理', detail: update.task, status: 'running',
      session: ref(id), parent: ref(parentId), attachedTranscript: true };
    const child = { member, parentId, parentTurn, run, rows: [], events: [], characters: 0, listeners: new Set() };
    child.projection = acpTurn(run.id, event => enqueue(child, event), () => undefined);
    children.set(id, child);
    if (typeof update.prompt === 'string' && update.prompt) {
      enqueue(child, { kind: 'item', final: true, item: { kind: 'user', id: 'delegated-prompt', turnId: run.id, text: update.prompt } });
    }
    announce(child, true);
  }

  function settle(parentId, update) {
    const child = children.get(update.subagentSessionId);
    const status = terminalStatuses.get(update.state);
    if (!child || child.parentId !== parentId || !status || !child.projection) return;
    child.projection.finish(status !== 'completed');
    child.projection = undefined;
    child.run = { ...child.run, status: status === 'unknown' ? 'cancelled' : status };
    child.member = { ...child.member, status };
    publish(child);
    announce(child, false);
  }

  return {
    has: id => children.has(id),
    member: id => children.get(id)?.member,
    members: () => [...children.values()].map(child => child.member),
    update(id, update) {
      if (update.sessionUpdate === 'subagent_spawned') spawn(id, update);
      else if (update.sessionUpdate === 'subagent_state_update') settle(id, update);
      else if (id !== root.id) children.get(id)?.projection?.update(update);
      else return false;
      return true;
    },
    restore(history) {
      if (!children.size) return history;
      for (const turn of history) {
        for (let index = 0; index < turn.rows.length; index++) {
          const row = turn.rows[index];
          if (row.kind !== 'delegation' || !row.members?.[0]?.attachedTranscript) continue;
          const child = children.get(row.members[0].id);
          if (!child) continue;
          child.parentTurn = turn.id;
          turn.rows[index] = { ...row, members: [child.member] };
        }
      }
      return history;
    },
    watch(id, listener) {
      const child = children.get(id);
      if (!child) throw new Error('当前会话没有这个子代理。');
      child.listeners.add(listener);
      publish(child);
      return () => {
        child.listeners.delete(listener);
        if (!child.listeners.size) {
          clearTimeout(child.timer);
          child.timer = undefined;
        }
      };
    },
    close() {
      for (const child of children.values()) {
        clearTimeout(child.timer);
        child.listeners.clear();
      }
      children.clear();
    },
  };
}
