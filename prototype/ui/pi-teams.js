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

export function watchPiTeamTranscript(read, listener, refreshMs) {
  let subscribed = true;
  let timer;
  let nextRefresh = refreshMs;
  let reading = false;
  let olderRequested = false;
  let continuation = {};
  let view = { rows: [], cursor: null, loading: false, loadOlder };

  function publish(changes) {
    view = { ...view, ...changes };
    listener(view);
  }

  function loadOlder() {
    if (!subscribed || !view.cursor || view.loading) return;
    if (reading) olderRequested = true;
    else void load({ cursor: view.cursor });
  }

  async function load({ cursor, refresh = false } = {}) {
    clearTimeout(timer);
    reading = true;
    if (!refresh) publish({ loading: true, error: undefined });
    try {
      const page = await read({ cursor, refresh });
      if (!subscribed) return;
      nextRefresh = refreshMs;
      if (page === null) {
        if (view.loading || view.error) publish({ loading: false, error: undefined });
        return;
      }
      if (!cursor && !page.append) continuation = {};
      const turns = piBranchTurns(page.entries, entry => entry.id, cursor ? undefined : continuation);
      const rows = cursor ? mergeHistory(view.rows, historyRows(turns)) : historyRows(turns, page.append ? view.rows : undefined);
      publish({ cursor: page.append ? view.cursor : page.cursor, rows, loading: false, error: undefined });
    } catch (error) {
      if (refresh) nextRefresh = Math.min(nextRefresh * 2, 30_000);
      if (subscribed && (view.loading || view.error !== error.message)) publish({ error: error.message, loading: false });
    } finally {
      reading = false;
      if (subscribed) {
        const loadQueuedPage = olderRequested && view.cursor;
        olderRequested = false;
        if (loadQueuedPage) loadOlder();
        else timer = setTimeout(() => void load({ refresh: true }), nextRefresh);
      }
    }
  }
  void load();
  return () => {
    subscribed = false;
    clearTimeout(timer);
    continuation = {};
    view = { rows: [], cursor: null, loading: false };
  };
}
