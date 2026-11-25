import { piTurns } from './pi-items.js';
import { historyRows } from './timeline.js';

const memberStatuses = new Map([
  ['running', 'running'], ['completed', 'completed'], ['failed', 'failed'],
  ['timed_out', 'failed'], ['stopped', 'cancelled'],
]);
const boardStatuses = new Map([['active', 'active'], ['shutdown', 'closed'], ['orphaned', 'orphaned']]);

export function isPiTeamsCommand(command) {
  return command.source === 'extension' && command.name === 'team' &&
    command.description?.includes('/team [team-name] [--detail <teammate>]');
}

export function piTeamSnapshot(records, hasSessionFile) {
  return records.flatMap(({ config, board }) => {
    if (!config?.name || !Array.isArray(config.members)) return [];
    const members = config.members.filter(member => member?.agentId && member.name).map(member => ({
      id: member.agentId,
      name: member.name,
      role: member.agentType === 'worker' ? undefined : member.agentType,
      status: member.status === 'running' && member.isActive === false ? 'idle'
        : memberStatuses.get(member.status) ?? 'unknown',
      model: member.model,
      detail: member.lastSummary,
      attachedTranscript: hasSessionFile && /^[0-9a-f]{8}$/i.test(member.agentId),
    }));
    const owners = new Map(members.map(member => [member.name.toLowerCase(), member.id]));
    const boardTasks = board?.schemaVersion === 1 && Array.isArray(board.tasks) ? board.tasks : [];
    const completed = new Set(boardTasks.filter(task => task?.status === 'completed').map(task => task.id));
    const tasks = boardTasks.filter(task => task?.id && task.subject && task.status !== 'deleted').map(task => {
      const dependsOn = Array.isArray(task.dependsOn) ? task.dependsOn.filter(id => typeof id === 'string') : [];
      const blockedBy = task.status === 'completed' ? [] : dependsOn.filter(id => !completed.has(id));
      const status = task.status === 'completed' ? 'completed' : blockedBy.length ? 'blocked'
        : task.status === 'in_progress' ? 'running' : 'pending';
      return { id: task.id, title: task.subject, detail: task.description, status, dependsOn, blockedBy,
        assigneeId: typeof task.owner === 'string' ? owners.get(task.owner.toLowerCase()) ?? task.owner : undefined };
    });
    return [{ id: config.name, name: config.name, description: config.description,
      status: boardStatuses.get(config.state), members, tasks }];
  }).sort((first, second) => first.name.localeCompare(second.name));
}

export function watchPiTeamTranscript(read, listener) {
  const pageSize = 20;
  let subscribed = true;
  let turns = [];
  let view = { rows: [], cursor: null, loading: true, loadOlder };
  function publish(changes) {
    view = { ...view, ...changes };
    listener(view);
  }
  function loadOlder() {
    if (!subscribed) return;
    const page = turns.splice(Math.max(0, turns.length - pageSize));
    publish({ cursor: turns.at(-1)?.id ?? null, rows: [...historyRows(page), ...view.rows], loading: false });
  }
  listener(view);
  read().then(text => {
    if (!subscribed) return;
    if (text) {
      const lines = text.trimEnd().split('\n');
      if (JSON.parse(lines.shift())?.type !== 'session') throw new Error('Pi 子代理会话记录格式无效。');
      const entries = [];
      for (const line of lines) {
        let entry;
        try { entry = JSON.parse(line); } catch { continue; }
        if (entry?.id) entries.push(entry);
      }
      turns = piTurns(entries, entries.at(-1)?.id);
    }
    loadOlder();
  }).catch(error => {
    if (subscribed) publish({ error: error.message, loading: false });
  });
  return () => {
    subscribed = false;
    turns = [];
    view = { rows: [], cursor: null, loading: false };
  };
}
