import { connectRpc } from './agent-rpc.js';
import { sessionKey } from './agent.js';
import { fileReferencePreview, fileReferenceText, parseFileReferences } from './file-references.js';
import { piBranchTurns, piDelta, piMessage, piRunStatus, piText, piTool, piTurnEntries, piTurnId } from './pi-items.js';
import { isPiTeamsCommand, piTeamSnapshot, watchPiTeamTranscript } from './pi-teams.js';

const wire = {
  request: (id, type, params) => ({ ...params, id: String(id), type }),
  response: packet => packet.type === 'response' ? {
    id: packet.id, value: packet.data,
    error: packet.success ? undefined : new Error(packet.error || 'Pi 请求失败。'),
  } : undefined,
  event: packet => Boolean(packet.type),
};

const modelId = model => model ? model.provider + '/' + model.id : undefined;
const thinkingLevels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const modelLevels = model => thinkingLevels.filter((level, index) => {
  const mapped = model.thinkingLevelMap?.[level];
  return mapped !== null && (index < 5 || mapped !== undefined);
});
export function createPi({ generation, cwd, location, onEvent }) {
  const searchPaths = new Map();
  const pending = [];
  const dialogs = new Map();
  const commands = [];
  const tools = new Map();
  let current;
  let snapshot;
  let run;
  let turnCount = 0;
  let messageIndex = 0;
  let finalStatus;
  let hasUser = false;
  let models = [];
  let state;
  let reserved = false;
  let replacingSession = false;
  let teamCapability;
  let teamMembers = new Set();
  let closeTeamTrace;

  const notify = event => { if (current) onEvent({ ...event, session: current.ref }); };
  const item = (value, final) => notify({ kind: 'item', item: value, final });
  const ref = id => ({ backend: 'pi', location, id });
  const rpc = connectRpc(generation, packet, route => onEvent({ kind: 'connection', route }),
    error => {
      clearSessionView();
      onEvent({ kind: 'disconnected', error });
    }, wire);
  const request = rpc.request;

  function closeDialogs(cancel = false) {
    for (const [id, dialog] of dialogs) {
      clearTimeout(dialog.timer);
      if (cancel) rpc.send({ type: 'extension_ui_response', id, cancelled: true }).catch(() => {});
      resolveDialog(id, dialog);
    }
    dialogs.clear();
  }

  function clearTurnOutput() {
    tools.clear();
    finalStatus = undefined;
  }

  function clearSessionView(cancelDialogs = false) {
    closeTeamTrace?.();
    closeDialogs(cancelDialogs);
    current = undefined;
    snapshot = null;
    run = undefined;
    pending.length = 0;
    teamMembers.clear();
    clearTurnOutput();
  }

  function resolveDialog(id, dialog) {
    if (dialog.connection) onEvent({ kind: 'connectionInteractionResolved', id });
    else notify({ kind: 'interactionResolved', id });
  }

  function setRun(value) {
    run = value;
    notify({ kind: 'run', run });
  }

  function updateUsage() {
    const session = current;
    usage().then(value => {
      if (session === current) notify({ kind: 'usage', usage: value });
    }).catch(() => {});
  }

  function beginTurn(announce = true) {
    const id = piTurnId(turnCount++);
    messageIndex = 0;
    clearTurnOutput();
    hasUser = false;
    const turn = { id, status: 'running' };
    if (announce) setRun(turn);
    else run = turn;
  }

  function inputStatus(input, state) {
    if (input && input.delivery !== 'prompt') {
      notify({ kind: 'queuedInput', clientId: input.clientId, delivery: input.delivery, state });
    }
  }

  function settle(aborted) {
    if (!run) return;
    closeDialogs();
    pending.splice(0).forEach(input => inputStatus(input, 'cancelled'));
    const status = aborted ? { status: 'cancelled' } : finalStatus ?? piRunStatus();
    clearTurnOutput();
    setRun({ id: run.id, ...status });
    updateUsage();
  }

  function dialogRequest(record) {
    const { id, method, title } = record;
    if (method === 'notify') {
      const text = record.message?.trim();
      if (run && text) {
        const heading = text.split('\n', 1)[0].slice(0, 96);
        item({ kind: 'notice', id: 'notice:' + id, turnId: run.id,
          title: heading, text: heading === text ? undefined : text }, true);
      }
      return;
    }
    if (!['confirm', 'select', 'input', 'editor'].includes(method)) return;
    if (!current && !replacingSession) {
      rpc.send({ type: 'extension_ui_response', id, cancelled: true }).catch(() => {});
      return;
    }
    const connection = replacingSession;
    const base = { id, title: title || 'Pi 请求输入', turnId: connection ? undefined : run?.id,
      scope: connection ? 'connection' : undefined, cancel: true };
    const options = (record.options ?? []).map((label, index) => ({ id: String(index), label }));
    const prompt = method === 'confirm'
      ? { ...base, kind: 'approval', detail: record.message, choices: [
        { id: 'yes', label: '确认', effect: 'allow' }, { id: 'no', label: '拒绝', effect: 'deny' }] }
      : { ...base, kind: 'input', fields: [{
        id: 'value', label: options.length ? '选项' : '回答', description: record.placeholder, options,
        required: method === 'select', multiline: method === 'editor', prefill: record.prefill,
      }] };
    const dialog = { method, options, connection };
    dialog.timer = Number.isFinite(record.timeout) ? setTimeout(() => {
      dialogs.delete(id);
      resolveDialog(id, dialog);
    }, record.timeout) : undefined;
    dialogs.set(id, dialog);
    if (connection) onEvent({ kind: 'connectionInteraction', request: prompt });
    else notify({ kind: 'interaction', request: prompt });
  }

  function packet(record) {
    if (record.type === 'extension_ui_request') {
      dialogRequest(record);
      return;
    }
    if (!current) return;
    if (record.type === 'session_info_changed') {
      notify({ kind: 'session', info: { title: record.name } });
      return;
    }
    if (record.type === 'agent_start') {
      if (run?.status !== 'running') beginTurn();
      else setRun(run);
      return;
    }
    if (run?.status !== 'running') return;
    if (record.type === 'agent_settled') {
      settle(record.aborted);
      return;
    }
    if (record.type === 'message_update') {
      const delta = piDelta(run.id, messageIndex, record.assistantMessageEvent);
      if (delta) notify({ kind: 'delta', delta });
      return;
    }
    if (record.type === 'message_end') {
      const message = record.message;
      let submitted;
      if (message.role === 'user') {
        if (hasUser) beginTurn();
        hasUser = true;
        const text = piText(message.content);
        let index = pending.findIndex(input => input.text === text);
        if (index < 0) index = pending.findIndex(input => input.delivery === 'prompt');
        if (index >= 0) [submitted] = pending.splice(index, 1);
        inputStatus(submitted, 'delivered');
      }
      if (message.role === 'assistant') finalStatus = piRunStatus(message);
      for (const value of piMessage(run.id, messageIndex++, message, tools, submitted?.clientId)) {
        item(value, value.status !== 'running');
      }
      return;
    }
    if (['tool_execution_start', 'tool_execution_update', 'tool_execution_end'].includes(record.type)) {
      const finished = record.type === 'tool_execution_end';
      item(piTool(run.id, record.toolCallId, record.toolName,
        record.args ?? tools.get(record.toolCallId)?.args,
        record.result ?? record.partialResult, finished ? Boolean(record.isError) : undefined), finished);
    }
  }

  function requireSession(session) {
    if (!current || sessionKey(session) !== sessionKey(current.ref)) throw new Error('Pi 会话已切换。');
  }

  async function list({ cursor, archived } = {}) {
    if (archived) return { items: [], cursor: null };
    const page = await request('span_list_sessions', { cursor });
    return {
      cursor: page.cursor,
      items: page.items.map(entry => {
        searchPaths.set(entry.id, entry.path);
        return { ref: ref(entry.id), cwd: entry.cwd, title: entry.title, preview: fileReferencePreview(entry.preview),
          updatedAt: Date.parse(entry.created) };
      }),
    };
  }

  async function pathFor(id) {
    if (searchPaths.has(id)) return searchPaths.get(id);
    let cursor;
    do {
      ({ cursor } = await list({ cursor }));
      if (searchPaths.has(id)) return searchPaths.get(id);
    } while (cursor);
    throw new Error('当前工作区的 Pi 会话目录中找不到该 ID。');
  }

  async function replace(type, params) {
    replacingSession = true;
    try {
      const result = await request(type, params);
      if (result.cancelled) throw new Error('Pi 扩展取消了会话切换。');
      clearSessionView();
    } finally {
      replacingSession = false;
      closeDialogs();
    }
  }

  async function opened(limit, sessionCwd) {
    state = await request('get_state');
    const id = state.sessionId;
    if (typeof id !== 'string' || !id) throw new Error('Pi 未提供会话 ID。');
    if (state.sessionFile) searchPaths.set(id, state.sessionFile);
    current = { ref: ref(id), title: state.sessionName, cwd: sessionCwd };
    turnCount = 0;
    const result = { session: current, options: { model: modelId(state.model), effort: state.thinkingLevel } };
    if (limit !== undefined) {
      const response = await request('get_entries');
      const turns = piTurnEntries(response.entries ?? [], response.leafId);
      turnCount = turns.length;
      snapshot = { turns };
      result.history = historyPage(limit);
    }
    return result;
  }

  function historyPage(limit, cursor) {
    if (cursor !== snapshot?.cursor) return { items: [], cursor: null };
    const records = snapshot?.turns ?? [];
    const start = Math.max(0, records.length - limit);
    // Keep unread records in Pi's representation and only format the requested page.
    const items = piBranchTurns(records.splice(start).flat(), (_, index) => piTurnId(start + index));
    const next = records.length ? items[0]?.id : undefined;
    snapshot = next ? { turns: records, cursor: next } : null;
    return { items, cursor: next ?? null };
  }

  async function ask(type, input, clientId, delivery) {
    if (input.some(part => part.kind !== 'text' && part.kind !== 'file')) {
      throw new Error('当前 Pi 输入入口支持文本和本机附件路径。');
    }
    const ticket = { clientId, text: fileReferenceText(input, location.kind === 'local'), delivery };
    pending.push(ticket);
    try {
      const result = await request(type, { message: ticket.text });
      if (result?.disposition === 'handled' && pending.includes(ticket)) {
        pending.splice(pending.indexOf(ticket), 1);
        inputStatus(ticket, 'delivered');
        item({ kind: 'user', id: 'handled:' + clientId, turnId: run.id, ...parseFileReferences(ticket.text), clientId }, true);
        if (delivery === 'prompt') {
          turnCount--;
          settle(false);
        }
      } else if (result?.disposition === 'queued' && pending.includes(ticket)) {
        inputStatus(ticket, 'queued');
      }
    } catch (error) {
      const index = pending.indexOf(ticket);
      if (index >= 0) pending.splice(index, 1);
      throw error;
    }
  }

  async function usage(session) {
    if (session) requireSession(session);
    const stats = await request('get_session_stats');
    return {
      tokens: { total: stats.tokens?.total, input: stats.tokens?.input, output: stats.tokens?.output,
        cached: stats.tokens?.cacheRead, ...(stats.tokens?.cacheWrite > 0 && { cacheWrite: stats.tokens.cacheWrite }),
        contextUsed: stats.contextUsage?.tokens ?? undefined,
        contextLimit: stats.contextUsage?.contextWindow },
      cost: typeof stats.cost === 'number' ? { amount: stats.cost, currency: 'USD' } : undefined,
    };
  }

  async function configure(options) {
    const chosen = models.find(model => modelId(model) === options.model);
    if (chosen && modelId(chosen) !== modelId(state?.model)) {
      const result = await request('set_model', { provider: chosen.provider, modelId: chosen.id });
      state = { ...state, model: result.model ?? result };
    }
    if (options.effort && options.effort !== state?.thinkingLevel) {
      await request('set_thinking_level', { level: options.effort });
      state = { ...state, thinkingLevel: options.effort };
    }
  }

  return {
    commands,
    get delegation() { return teamCapability; },
    extensions: {
      kinds: ['skill'],
      async list(kind, session) {
        if (session) requireSession(session);
        if (kind !== 'skill') return { items: [], cursor: null };
        const { commands } = await request('get_commands');
        const items = commands.filter(command => command.source === 'skill' && command.name?.startsWith('skill:'))
          .map(command => {
            const name = command.name.slice('skill:'.length);
            return {
              kind, id: command.name, name, label: name, description: command.description,
              path: command.sourceInfo?.path,
              scope: { project: 'workspace', user: 'user', temporary: 'temporary' }[command.sourceInfo?.scope],
            };
          });
        return { items, cursor: null };
      },
    },
    localFileReferences: location.kind === 'local',
    async open() {
      await window.span.request('agent.start', { generation, cwd, backend: 'pi', ssh: location.host });
      await rpc.ready();
      state = await request('get_state');
      const result = await request('get_commands');
      if (result.commands.some(isPiTeamsCommand)) teamCapability = {
        observe: true,
        teamRefreshMs: location.kind === 'ssh' ? 5000 : 2200,
        releaseTeamView: session => rpc.send({ type: 'span_pi_release_team_view', sessionId: session.id }).catch(() => {}),
        async teams(session) {
          requireSession(session);
          const scope = current;
          const records = await request('span_pi_teams', { sessionId: session.id });
          if (records === null) return;
          const teams = piTeamSnapshot(records, Boolean(state?.sessionFile));
          if (scope === current) teamMembers = new Set(teams.flatMap(team =>
            team.members.filter(member => member.attachedTranscript).map(member => member.id)));
          return teams;
        },
        watchTranscript(session, memberId, listener) {
          requireSession(session);
          if (!teamMembers.has(memberId)) throw new Error('当前会话没有这个 Pi 子代理。');
          closeTeamTrace?.();
          const stop = watchPiTeamTranscript(({ cursor, refresh }) => request('span_pi_team_transcript', {
            sessionId: session.id, memberId, cursor, refresh,
          }), listener, teamCapability.teamRefreshMs);
          const close = () => {
            if (closeTeamTrace !== close) return;
            closeTeamTrace = undefined;
            stop();
            teamCapability.releaseTeamView?.(session);
          };
          closeTeamTrace = close;
          return close;
        },
      };
      commands.push(...result.commands.filter(command => command.name)
        .map(command => ({ id: command.name, label: command.name, description: command.description })));
    },
    close() {
      clearSessionView();
      rpc.close();
      window.span.request('agent.close', { generation }).catch(() => {});
    },
    sessions: {
      list,
      async start() {
        // The process initially owns a new, empty Pi session.
        if (reserved) await replace('new_session');
        reserved = true;
        return opened(undefined, location.kind === 'local' ? cwd : undefined);
      },
      async resume(session, limit) {
        const path = await pathFor(session.id);
        await replace('switch_session', { sessionPath: path });
        reserved = true;
        return opened(limit);
      },
      async history(session, { cursor, limit = 40 }) {
        requireSession(session);
        return historyPage(limit, cursor);
      },
      async release(session) {
        if (current && sessionKey(current.ref) === sessionKey(session)) clearSessionView(true);
      },
      async rename(session, title) {
        requireSession(session);
        await request('set_session_name', { name: title });
      },
    },
    turns: {
      async start(session, input, options, clientId) {
        requireSession(session);
        await configure(options);
        beginTurn(false);
        const turn = run;
        try {
          await ask('prompt', input, clientId, 'prompt');
          return run;
        } catch (error) {
          if (run === turn) {
            turnCount--;
            setRun({ id: turn.id, status: 'failed' });
          }
          throw error;
        }
      },
      async steer(session, runId, input, clientId) {
        requireSession(session);
        await ask('steer', input, clientId, 'steer');
      },
      async followUp(session, input, clientId) {
        requireSession(session);
        await ask('follow_up', input, clientId, 'followUp');
      },
      async stop(session) {
        requireSession(session);
        await request('clear_queue');
        await request('abort');
      },
      async compact(session) {
        requireSession(session);
        await request('compact');
        updateUsage();
      },
    },
    async models() {
      const result = await request('get_available_models');
      models = result.models ?? [];
      const { levels } = state?.model ? await request('get_available_thinking_levels') : { levels: [] };
      return models.map(model => {
        const id = modelId(model);
        const isDefault = id === modelId(state?.model);
        const efforts = model.reasoning
          ? (isDefault ? levels ?? [] : modelLevels(model)).map(id => ({ id, label: id })) : [];
        return { id, label: model.name ?? model.id, isDefault, inputs: ['text'], efforts, tiers: [] };
      });
    },
    usage,
    interactions: {
      async respond(id, reply) {
        const dialog = dialogs.get(id);
        if (!dialog) throw new Error('Pi 请求已结束。');
        const value = dialog.method === 'select' ? dialog.options.find(option => option.id === reply.values?.value)?.label
          : reply.values?.value;
        const answer = reply.cancelled ? { cancelled: true }
          : dialog.method === 'confirm' ? { confirmed: reply.choice === 'yes' } : { value };
        await rpc.send({ type: 'extension_ui_response', id, ...answer });
        clearTimeout(dialog.timer);
        dialogs.delete(id);
        resolveDialog(id, dialog);
      },
    },
  };
}
