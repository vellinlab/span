import { piBranchTurns } from './pi-items.js';
import { historyRows, mergeHistory } from './timeline.js';

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
      const page = await read(cursor);
      if (!subscribed) return;
      if (page === null) {
        publish({ loading: false });
        return;
      }
      const turns = piBranchTurns(page.entries, entry => entry.id);
      publish({ cursor: page.cursor, rows: mergeHistory(view.rows, historyRows(turns)), loading: false });
    } catch (error) {
      if (subscribed) publish({ error: error.message, loading: false });
    }
  }
  void load();
  return () => {
    subscribed = false;
    view = { rows: [], cursor: null, loading: false };
  };
}
