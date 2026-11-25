import { connectRpc, jsonRpc } from './agent-rpc.js';
import { acpOperation, acpReplay, acpTurn, acpTurnId } from './acp-items.js';
import { createAcpSubagents } from './acp-subagents.js';
import { attachmentArtifacts, attachmentName, fileReferenceText } from './file-references.js';
import { createKiloGoals } from './kilo-goals.js';

const wire = { ...jsonRpc, request: (id, method, params) => ({ jsonrpc: '2.0', id, method, params }) };
const approvalOptions = new Map([
  ['allow_once', { label: '仅允许这次', effect: 'allow' }],
  ['allow_always', { label: '始终允许', effect: 'allow', remember: true }],
  ['reject_once', { label: '拒绝', effect: 'deny' }],
  ['reject_always', { label: '始终拒绝', effect: 'deny', remember: true }],
]);
const choice = ({ value, name, description }) => ({ id: value, label: name || value, description });
const configChoices = item => (item?.options ?? []).flatMap(option => option.options ?? [option])
  .filter(option => typeof option.value === 'string').map(choice);
const configCategories = { model: 'model', effort: 'thought_level', mode: 'mode' };
const pageSize = 40;
const goalStatuses = new Set(['active', 'paused', 'blocked', 'limited', 'complete']);
const asyncStopStatuses = new Map([['completed', 'completed'], ['failed', 'failed'], ['stopped', 'cancelled']]);
const air = value => value?._meta?.jetbrains?.air;

export function createAcp({ id: backend, label, childSessionKey }, { generation, cwd, location, onEvent }) {
  const sessions = new Map();
  const dialogs = new Map();
  const commands = [];
  const modes = [];
  const local = location.kind === 'local';
  const claude = backend === 'claude';
  const sessionSettings = claude ? { _meta: { claudeCode: { options: { promptSuggestions: false } } } } : {};
  let workspace = local ? cwd : undefined;
  let capabilities;
  let active;
  let loading;
  let goals;
  let nativeSubagents;

  const ref = id => ({ backend, location, id });
  const childSession = tool => childSessionKey ? tool._meta?.[childSessionKey] : undefined;
  const notify = (id, event) => onEvent({ ...event, session: ref(id) });
  const rpc = connectRpc(generation, packet, route => onEvent({ kind: 'connection', route }), error => {
    goals?.close();
    active?.subagents?.close();
    loading?.subagents?.close();
    active = loading = undefined;
    dialogs.clear();
    onEvent({ kind: 'disconnected', error });
  }, wire);
  const request = rpc.request;

  function sessionInfo(entry) {
    return { ref: ref(entry.sessionId), cwd: entry.cwd, title: entry.title,
      updatedAt: entry.updatedAt ? Date.parse(entry.updatedAt) : undefined };
  }

  async function list({ cursor, archived } = {}) {
    if (archived || !capabilities?.sessionCapabilities?.list) return { items: [], cursor: null };
    const page = await request('session/list', { cursor });
    const entries = (page.sessions ?? []).filter(entry => entry.sessionId && entry.cwd);
    for (const entry of entries) sessions.set(entry.sessionId, entry);
    return { items: entries.map(sessionInfo), cursor: page.nextCursor ?? null };
  }

  async function lookup(id) {
    let cursor;
    const visited = new Set();
    while (!sessions.has(id) && !visited.has(cursor)) {
      visited.add(cursor);
      const page = await list({ cursor });
      if (!page.cursor) break;
      cursor = page.cursor;
    }
    const entry = sessions.get(id);
    if (!entry) throw new Error(`找不到这个 ${label} 会话或它的工作目录。`);
    return entry;
  }

  function useConfig(state, config) {
    if (!config) return;
    state.config = config;
    const selectors = config.filter(item => (item.type === 'select' || !item.type) && typeof item.currentValue === 'string');
    state.controls = Object.fromEntries(Object.entries(configCategories).map(([key, category]) => [key,
      selectors.find(item => item.category === category) ?? selectors.find(item => item.id === key && !item.category),
    ]));
    state.options = Object.fromEntries(Object.entries(state.controls)
      .filter(([, item]) => item).map(([key, item]) => [key, item.currentValue]));
    const { model: modelControl, effort, mode } = state.controls;
    state.models = configChoices(modelControl).map(model => {
      const separator = model.label.indexOf('/');
      const provider = model.label.slice(0, separator);
      const label = separator > 0 && provider === model.label.slice(separator + 1) ? provider : model.label;
      const selected = model.id === state.options.model;
      return { ...model, label, isDefault: selected,
        inputs: capabilities?.promptCapabilities?.image ? ['text', 'image'] : ['text'],
        efforts: selected ? configChoices(effort) : [],
        defaultEffort: selected ? state.options.effort : undefined, tiers: [] };
    });
    if (state === active) {
      modes.splice(0, modes.length, ...configChoices(mode));
      notify(state.id, { kind: 'models', models: state.models });
    }
  }

  function useCommands(state, entries) {
    state.commands = (entries ?? []).filter(command => typeof command.name === 'string')
      .map(command => ({ id: command.name, label: command.name, description: command.description }));
    if (state === active) {
      commands.splice(0, commands.length, ...state.commands);
      // Model state also invalidates the composer controls for the active session.
      notify(state.id, { kind: 'models', models: [...(state.models ?? [])] });
    }
  }

  function activate(state, entry, config) {
    loading = undefined;
    if (active !== state) active?.subagents?.close();
    active = state;
    state.id = entry.sessionId;
    state.entry = entry;
    if (nativeSubagents && !state.subagents) state.subagents = createAcpSubagents(state, { ref, notify });
    goals?.attach(state);
    sessions.set(state.id, entry);
    commands.splice(0, commands.length, ...(state.commands ?? []));
    useConfig(state, config ?? state.config ?? []);
    return { session: sessionInfo(entry), options: state.options, models: state.models };
  }

  function historyPage(state, limit, cursor) {
    if (!state.history || cursor !== state.historyCursor) return { items: [], cursor: null };
    const items = state.history.splice(Math.max(0, state.history.length - limit));
    state.historyCursor = state.history.length ? items[0]?.id : undefined;
    if (!state.historyCursor) state.history = undefined;
    return { items, cursor: state.historyCursor ?? null };
  }

  function requireActive(session) {
    if (!session || session.id !== active?.id || session.backend !== backend
      || session.location.kind !== location.kind || session.location.host !== location.host) {
      throw new Error(`${label} 会话已切换，请在当前会话重试。`);
    }
    return active;
  }

  function updateUsage(state, update) {
    const previous = state.usage;
    const usedChanged = Number.isFinite(update.used) && update.used !== previous.tokens?.contextUsed;
    const limitChanged = Number.isFinite(update.size) && update.size !== previous.tokens?.contextLimit;
    const cost = update.cost && (update.cost.amount !== previous.cost?.amount || update.cost.currency !== previous.cost?.currency)
      ? update.cost : undefined;
    if (!usedChanged && !limitChanged && !cost) return;
    const usage = {
      ...((usedChanged || limitChanged) && { tokens: { ...previous.tokens,
        ...(usedChanged && { contextUsed: update.used }), ...(limitChanged && { contextLimit: update.size }) } }),
      ...(cost && { cost }),
    };
    state.usage = { ...previous, ...usage };
    notify(state.id, { kind: 'usage', usage });
  }

  function promptUsage(state, report) {
    const { totalTokens, inputTokens, outputTokens, cachedReadTokens, cachedWriteTokens, thoughtTokens } = report;
    const recentTokens = {
      total: totalTokens, input: inputTokens, output: outputTokens, cached: cachedReadTokens, reasoning: thoughtTokens,
      ...(cachedWriteTokens > 0 && { cacheWrite: cachedWriteTokens }),
    };
    state.usage = { ...state.usage, recentTokens };
    notify(state.id, { kind: 'usage', usage: { recentTokens } });
  }

  function updateGoalSnapshot(state, snapshot) {
    if (snapshot === undefined || !adapter.goal || !claude) return;
    const goal = typeof snapshot?.objective === 'string' && snapshot.objective.trim() ? {
      objective: snapshot.objective, status: goalStatuses.has(snapshot.status) ? snapshot.status : 'unknown',
      reason: typeof snapshot.lastReason === 'string' ? snapshot.lastReason : undefined,
    } : null;
    state.goal = goal;
    if (state === active) notify(state.id, { kind: 'goal', goal });
  }

  function updateSession(id, update) {
    const owns = state => state && (state.id === id || state.subagents?.has(id));
    const state = owns(loading) ? loading : owns(active) ? active : undefined;
    if (!state && id && loading?.unconfirmed) {
      if (['available_commands_update', 'config_option_update', 'session_info_update'].includes(update.sessionUpdate)) {
        const staged = loading.unconfirmed.get(id) ?? {};
        if (update.sessionUpdate === 'available_commands_update') useCommands(staged, update.availableCommands);
        if (update.sessionUpdate === 'config_option_update') useConfig(staged, update.configOptions);
        if (update.sessionUpdate === 'session_info_update') updateGoalSnapshot(staged, air(update)?.goal);
        loading.unconfirmed.set(id, staged);
      }
      return;
    }
    if (!state) return;
    if (state.subagents?.update(id, update)) return;
    switch (update.sessionUpdate) {
      case 'available_commands_update':
        useCommands(state, update.availableCommands);
        return;
      case 'config_option_update':
        useConfig(state, update.configOptions);
        return;
      case 'session_info_update': {
        updateGoalSnapshot(state, air(update)?.goal);
        if (state !== active || typeof update.title !== 'string') return;
        state.entry = { ...state.entry, title: update.title };
        sessions.set(id, state.entry);
        notify(id, { kind: 'session', info: { title: update.title } });
        return;
      }
      case 'usage_update':
        if (state === active) updateUsage(state, update);
        return;
      case 'async_task_spawned':
        if (claude && state === active && !state.turn && update.taskType === 'turn' && typeof update.asyncTaskId === 'string') {
          startTurn(state, false, true).asyncTask = update.asyncTaskId;
        }
        return;
      case 'async_task_state_update': {
        const turn = state.turn;
        const status = asyncStopStatuses.get(update.state);
        if (turn?.asyncTask && turn.asyncTask === update.asyncTaskId && status) finish(state, turn, status);
        return;
      }
    }
    if (state.replay) state.replay.update(update);
    else {
      if (state === active && ['agent_message_chunk', 'agent_thought_chunk', 'tool_call'].includes(update.sessionUpdate)) goals?.activity(state);
      state.turn?.projection.update(update);
    }
  }

  function result(id, value) {
    return rpc.send({ jsonrpc: '2.0', id, result: value });
  }

  function permission(id, params) {
    const state = active;
    const tool = params.toolCall ?? {};
    const member = state?.subagents?.member(params.sessionId);
    const parent = childSession(tool)?.parentID;
    const choices = (params.options ?? []).flatMap(option => {
      const normalized = approvalOptions.get(option.kind);
      return normalized && typeof option.optionId === 'string' ? [{ id: option.optionId, ...normalized }] : [];
    });
    if (params.sessionId === state?.id) goals?.activity(state);
    const owns = state && (member?.status === 'running' || (state.turn && (params.sessionId === state.id || parent === state.id)));
    if (!owns || !choices.length) {
      result(id, { outcome: { outcome: 'cancelled' } }).catch(() => {});
      return;
    }
    const key = JSON.stringify(id);
    dialogs.set(key, { id, state, choices, member });
    const operation = acpOperation(tool, member ? undefined : state.entry.cwd);
    const title = operation.command && tool.title?.trim() === operation.command.trim()
      ? '执行命令' : tool.title || `${label} 请求权限`;
    notify(state.id, { kind: 'interaction', request: {
      kind: 'approval', id: key, title,
      choices, operation, cancel: true, actor: member, turnId: state.turn?.run.id,
      itemId: !member && tool.toolCallId ? 'tool:' + tool.toolCallId : undefined,
    } });
  }

  function packet({ method, id, params = {} }) {
    if (method === 'span/backendWorkspace') {
      if (!local && !workspace) workspace = params.cwd;
    } else if (method === 'session/update' && params.update) {
      updateSession(params.sessionId, params.update);
    } else if (method === 'session/request_permission' && id != null) {
      permission(id, params);
    } else if (method === '$/cancel_request' && params.requestId != null) {
      const key = JSON.stringify(params.requestId);
      const dialog = dialogs.get(key);
      if (dialog) {
        dialogs.delete(key);
        notify(dialog.state.id, { kind: 'interactionResolved', id: key });
      }
    } else if (id != null) {
      rpc.send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not supported' } }).catch(() => {});
    }
  }

  function finish(state, turn, status, error) {
    if (state !== active || state.turn !== turn) return;
    turn.projection.finish(status !== 'completed');
    for (const [id, dialog] of dialogs) {
      if (dialog.state !== state || dialog.member) continue;
      dialogs.delete(id);
      notify(state.id, { kind: 'interactionResolved', id });
    }
    state.turn = undefined;
    notify(state.id, { kind: 'run', run: { id: turn.run.id, status, error } });
    if (!turn.goal) goals?.watch(state, 0);
  }

  function startTurn(state, goal = false, announce = goal) {
    const run = { id: acpTurnId(state.nextTurn++), status: 'running' };
    const turn = { run, goal, projection: acpTurn(run.id, event => notify(state.id, event), childSession) };
    state.turn = turn;
    if (announce) notify(state.id, { kind: 'run', run });
    return turn;
  }

  function synchronizeGoal(state, goal) {
    if (goal?.status === 'active') {
      if (!state.turn) startTurn(state, true);
    } else if (state.turn?.goal && !state.turn.foreground) {
      const status = goal?.status === 'blocked' ? 'failed' : ['complete', 'waiting'].includes(goal?.status) ? 'completed' : 'cancelled';
      finish(state, state.turn, status);
    }
  }

  function createClaudeGoal(support) {
    if (support?.version !== 1 || support.controlMethod !== '_session/goal'
      || !Array.isArray(support.actions) || !support.actions.includes('set')) return;
    const actions = ['set', 'edit', ...(support.actions.includes('clear') ? ['clear'] : [])];
    return {
      actions, activeWithoutTurn: true, budget: false, startsOnSave: true,
      async read(session) { return requireActive(session).goal ?? null; },
      async update(session, { kind, objective }, options = {}) {
        const state = requireActive(session);
        if (!actions.includes(kind)) throw new Error('Claude Code 不支持这个目标操作。');
        if (state.goalChanging) throw new Error('正在更新当前目标。');
        state.goalChanging = true;
        let turn;
        try {
          if (!state.turn && kind !== 'clear') await configure(state, options);
          if (state !== active) return;
          if (!state.turn) turn = startTurn(state, false, true);
          const params = kind === 'clear' ? { action: 'clear' } : { action: 'set', objective };
          await rpc.beginRequest(support.controlMethod, { sessionId: state.id, ...params }, null).response;
          if (turn) finish(state, turn, 'completed');
          if (state === active) return state.goal ?? null;
        } catch (error) {
          if (turn) finish(state, turn, 'cancelled');
          throw error;
        } finally {
          state.goalChanging = false;
        }
      },
    };
  }

  async function configure(state, options) {
    for (const key of Object.keys(configCategories)) {
      const selected = options[key];
      if (!selected || selected === state.options[key]) continue;
      const config = state.controls[key];
      if (!configChoices(config).some(option => option.id === selected)) continue;
      const response = await request('session/set_config_option', { sessionId: state.id, configId: config.id, value: selected });
      useConfig(state, response.configOptions);
    }
  }

  async function promptInput(input) {
    const images = input.filter(part => part.kind === 'image');
    const text = fileReferenceText(input, local);
    const blocks = text ? [{ type: 'text', text }] : [];
    for (const image of images) {
      if (!local || !capabilities?.promptCapabilities?.image || !image.path) {
        throw new Error(`当前 ${label} 会话无法发送图片。`);
      }
      const content = await window.span.previewImage(image.path);
      if (!content?.data) throw new Error('无法读取图片附件。');
      blocks.push({ type: 'image', data: content.data, mimeType: content.mime });
    }
    return blocks;
  }

  function dispatchPrompt(state, turn, input, prompt, clientId, id = 'user') {
    const { sent, response } = rpc.beginRequest('session/prompt', { sessionId: state.id, prompt }, null);
    const dispatched = sent.then(() => {
      const text = input.filter(part => part.kind === 'text').map(part => part.text).join('\n');
      const files = input.filter(part => part.kind === 'file' || part.kind === 'image')
        .map(part => ({ ...part, name: part.name ?? attachmentName(part.path) }));
      notify(state.id, { kind: 'item', final: true,
        item: { kind: 'user', id, turnId: turn.run.id, text, attachments: attachmentArtifacts(files), clientId } });
    });
    // The response can reject before transport dispatch has settled.
    response.catch(() => {});
    return { dispatched, response };
  }

  async function steerGoal(session, runId, input, clientId) {
    const state = requireActive(session);
    const turn = state.turn;
    const prompt = await promptInput(input);
    if (state !== active || state.turn !== turn || !turn?.goal || turn.run.id !== runId) {
      throw new Error('当前目标已结束或切换，请重新发送。');
    }
    turn.foreground = (turn.foreground ?? 0) + 1;
    try {
      const { dispatched, response } = dispatchPrompt(state, turn, input, prompt, clientId, 'user:' + clientId);
      await dispatched;
      const reply = await response;
      if (state === active && reply.usage) promptUsage(state, reply.usage);
      if (reply.stopReason === 'max_tokens') throw new Error(`${label} 达到本轮输出上限。`);
      if (reply.stopReason === 'refusal') throw new Error(`${label} 拒绝了本轮请求。`);
    } finally {
      turn.foreground--;
      goals?.watch(state, 0);
    }
  }

  function sessionParams(entry) {
    return { sessionId: entry.sessionId, cwd: entry.cwd, mcpServers: [], ...sessionSettings,
      ...(Array.isArray(entry.additionalDirectories) && { additionalDirectories: entry.additionalDirectories }) };
  }

  async function replay(entry, limit) {
    const state = { id: entry.sessionId, usage: {}, replay: acpReplay(childSession) };
    if (nativeSubagents) state.subagents = createAcpSubagents(state, { ref, notify });
    loading = state;
    try {
      const response = await request('session/load', sessionParams(entry));
      state.history = state.replay.finish();
      state.subagents?.restore(state.history);
      state.nextTurn = state.history.length;
      state.replay = undefined;
      const opened = activate(state, entry, response.configOptions);
      return { ...opened, history: historyPage(state, limit) };
    } finally {
      if (state !== active) state.subagents?.close();
      if (loading === state) loading = undefined;
    }
  }

  function detach(id) {
    if (capabilities?.sessionCapabilities?.close) return request('session/close', { sessionId: id });
    return Promise.resolve();
  }

  const adapter = {
    commands, modes, localFileReferences: local, sessionModels: true,
    get localImageInputs() { return Boolean(local && capabilities?.promptCapabilities?.image); },
    async open() {
      await window.span.request('agent.start', { generation, cwd, backend, ssh: location.host });
      await rpc.ready();
      const clientCapabilities = claude ? { _meta: { jetbrains: { air: {
        version: 1, capabilities: ['asyncTasks', 'nativeSubagentSessions'],
      } } } } : {};
      const initialized = await request('initialize', { protocolVersion: 1, clientCapabilities,
        clientInfo: { name: 'span', version: '0.1.0' } });
      if (initialized.protocolVersion !== 1) throw new Error(`当前 ${label} 使用了不兼容的 ACP 版本。`);
      if (!workspace) throw new Error(`无法确认 ${label} 的工作目录。`);
      capabilities = initialized.agentCapabilities;
      if (claude) adapter.goal = createClaudeGoal(air(initialized)?.goal);
      nativeSubagents = claude && Boolean(capabilities?.sessionCapabilities?.subagents);
      if (nativeSubagents) adapter.delegation = {
        observe: true,
        async members(session) { return requireActive(session).subagents.members(); },
        watchTranscript(session, memberId, listener) { return requireActive(session).subagents.watch(memberId, listener); },
      };
      if (backend === 'kilo' && await window.span.request('agent.kiloGoal', { generation, probe: true, cwd: workspace }).catch(() => false)) {
        goals = createKiloGoals({ generation, requireActive, synchronize: synchronizeGoal,
          begin: state => startTurn(state, true), end: finish, notify });
        adapter.goal = goals.capability;
      }
      if (capabilities?.sessionCapabilities?.fork && capabilities.loadSession) {
        adapter.sessions.fork = async session => {
          const { entry, id } = requireActive(session);
          const copied = await request('session/fork', sessionParams(entry));
          const opened = await replay({ ...entry, sessionId: copied.sessionId, title: undefined }, pageSize);
          detach(id).catch(() => {});
          return opened;
        };
      }
    },
    close() {
      goals?.close();
      active?.subagents?.close();
      loading?.subagents?.close();
      active = loading = undefined;
      dialogs.clear();
      sessions.clear();
      rpc.close();
      window.span.request('agent.close', { generation }).catch(() => {});
    },
    sessions: {
      list,
      async start({ cwd: directory } = {}) {
        const pending = { unconfirmed: new Map() };
        const workingDirectory = local && directory ? directory : workspace;
        loading = pending;
        try {
          const response = await request('session/new', { cwd: workingDirectory, mcpServers: [], ...sessionSettings });
          const state = { ...pending.unconfirmed.get(response.sessionId), usage: {}, nextTurn: 0 };
          return activate(state, { sessionId: response.sessionId, cwd: workingDirectory }, response.configOptions);
        } finally {
          if (loading === pending) loading = undefined;
        }
      },
      async resume(session, limit) {
        if (!capabilities?.loadSession) throw new Error(`当前 ${label} 不支持恢复会话。`);
        return replay(await lookup(session.id), limit);
      },
      async history(session, { cursor, limit = pageSize }) {
        return historyPage(requireActive(session), limit, cursor);
      },
      async release(session) {
        if (session.id !== active?.id) return;
        goals?.close();
        active.subagents?.close();
        for (const [key, dialog] of dialogs) if (dialog.state === active) dialogs.delete(key);
        active = undefined;
        commands.length = 0;
        modes.length = 0;
        await detach(session.id);
      },
    },
    turns: {
      get steer() { return active?.turn?.goal ? steerGoal : undefined; },
      async start(session, input, options = {}, clientId) {
        const state = requireActive(session);
        if (state.turn) throw new Error(`请等当前 ${label} 回合结束。`);
        const prompt = await promptInput(input);
        await configure(state, options);
        const turn = startTurn(state);
        const { run } = turn;
        goals?.watch(state);
        const { dispatched, response } = dispatchPrompt(state, turn, input, prompt, clientId);
        dispatched.then(() => response.then(reply => {
          if (state !== active || state.turn !== turn) return;
          if (reply.usage) promptUsage(state, reply.usage);
          if (reply.stopReason === 'cancelled') finish(state, turn, 'cancelled');
          else if (reply.stopReason === 'max_tokens') finish(state, turn, 'failed', `${label} 达到本轮输出上限。`);
          else if (reply.stopReason === 'refusal') finish(state, turn, 'failed', `${label} 拒绝了本轮请求。`);
          else finish(state, turn, 'completed');
        }, error => finish(state, turn, 'failed', error.message)), () => {});
        try {
          await dispatched;
        } catch (error) {
          if (state.turn === turn) {
            state.turn = undefined;
            state.nextTurn--;
          }
          throw error;
        }
        return run;
      },
      async stop(session, id) {
        const state = requireActive(session);
        if (state.turn?.run.id !== id) return;
        if (state.turn.goal && !state.turn.foreground && goals) {
          await goals.capability.update(session, { kind: 'pause' });
          return;
        }
        if (state.turn.asyncTask) {
          const { stopped } = await request('_session/async_task/stop', { sessionId: state.id, asyncTaskId: state.turn.asyncTask });
          if (!stopped && state.turn?.run.id === id) throw new Error('Claude Code 无法停止当前任务。');
          return;
        }
        await rpc.send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: state.id } });
      },
    },
    async usage(session) {
      return session ? requireActive(session).usage : {};
    },
    interactions: {
      async respond(id, reply) {
        const dialog = dialogs.get(id);
        if (!dialog || dialog.state !== active) return;
        if (!reply.cancelled && !dialog.choices.some(option => option.id === reply.choice)) {
          throw new Error(`${label} 未提供这个审批选项。`);
        }
        await result(dialog.id, { outcome: reply.cancelled ? { outcome: 'cancelled' }
          : { outcome: 'selected', optionId: reply.choice } });
        dialogs.delete(id);
        notify(dialog.state.id, { kind: 'interactionResolved', id });
      },
    },
  };
  return adapter;
}
