import { connectRpc, jsonRpc } from './agent-rpc.js';
import { acpOperation, acpReplay, acpTurn, acpTurnId } from './acp-items.js';
import { attachmentArtifacts, attachmentName, fileReferenceText } from './file-references.js';

const wire = { ...jsonRpc, request: (id, method, params) => ({ jsonrpc: '2.0', id, method, params }) };
const approvalOptions = new Map([
  ['allow_once', { label: '仅允许这次', effect: 'allow' }],
  ['allow_always', { label: '始终允许', effect: 'allow' }],
  ['reject_once', { label: '拒绝', effect: 'deny' }],
  ['reject_always', { label: '始终拒绝', effect: 'deny' }],
]);
const choice = ({ value, name, description }) => ({ id: value, label: name || value, description });
const configChoices = item => (item?.options ?? []).flatMap(option => option.options ?? [option])
  .filter(option => typeof option.value === 'string').map(choice);
const pageSize = 40;

export function createOpenCode({ generation, cwd, location, onEvent }) {
  const sessions = new Map();
  const dialogs = new Map();
  const commands = [];
  const modes = [];
  const local = location.kind === 'local';
  let workspace = local ? cwd : undefined;
  let capabilities;
  let active;
  let loading;

  const ref = id => ({ backend: 'opencode', location, id });
  const notify = (id, event) => onEvent({ ...event, session: ref(id) });
  const rpc = connectRpc(generation, packet, route => onEvent({ kind: 'connection', route }), error => {
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
    if (!entry) throw new Error('找不到这个 OpenCode 会话或它的工作目录。');
    return entry;
  }

  function useConfig(state, config) {
    if (!config) return;
    state.config = config;
    const byId = Object.fromEntries(config.map(item => [item.id, item]));
    state.options = Object.fromEntries(['model', 'effort', 'mode']
      .filter(id => typeof byId[id]?.currentValue === 'string').map(id => [id, byId[id].currentValue]));
    state.models = configChoices(byId.model).map(model => ({
      ...model, isDefault: model.id === state.options.model,
      inputs: capabilities?.promptCapabilities?.image ? ['text', 'image'] : ['text'],
      efforts: model.id === state.options.model ? configChoices(byId.effort) : [],
      defaultEffort: model.id === state.options.model ? state.options.effort : undefined, tiers: [],
    }));
    if (state === active) {
      modes.splice(0, modes.length, ...configChoices(byId.mode));
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
    active = state;
    state.id = entry.sessionId;
    state.entry = entry;
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
    if (!session || session.id !== active?.id || session.backend !== 'opencode'
      || session.location.kind !== location.kind || session.location.host !== location.host) {
      throw new Error('OpenCode 会话已切换，请在当前会话重试。');
    }
    return active;
  }

  function updateUsage(state, update) {
    const tokens = { ...state.usage.tokens };
    if (Number.isFinite(update.used)) tokens.contextUsed = update.used;
    if (Number.isFinite(update.size)) tokens.contextLimit = update.size;
    state.usage = { ...state.usage, tokens, ...(update.cost && { cost: update.cost }) };
    notify(state.id, { kind: 'usage', usage: state.usage });
  }

  function promptUsage(state, report) {
    const { totalTokens, inputTokens, outputTokens, cachedReadTokens, thoughtTokens } = report;
    state.usage = { ...state.usage, recentTokens: {
      total: totalTokens, input: inputTokens, output: outputTokens, cached: cachedReadTokens, reasoning: thoughtTokens,
    } };
    notify(state.id, { kind: 'usage', usage: state.usage });
  }

  function updateSession(id, update) {
    const state = id === active?.id ? active : id === loading?.id ? loading : undefined;
    if (!state && id && loading?.unconfirmed) {
      if (update.sessionUpdate === 'available_commands_update' || update.sessionUpdate === 'config_option_update') {
        const staged = loading.unconfirmed.get(id) ?? {};
        if (update.sessionUpdate === 'available_commands_update') useCommands(staged, update.availableCommands);
        else useConfig(staged, update.configOptions);
        loading.unconfirmed.set(id, staged);
      }
      return;
    }
    if (!state) return;
    switch (update.sessionUpdate) {
      case 'available_commands_update':
        useCommands(state, update.availableCommands);
        return;
      case 'config_option_update':
        useConfig(state, update.configOptions);
        return;
      case 'session_info_update': {
        if (state !== active || typeof update.title !== 'string') return;
        state.entry = { ...state.entry, title: update.title };
        sessions.set(id, state.entry);
        notify(id, { kind: 'session', info: { title: update.title } });
        return;
      }
      case 'usage_update':
        if (state === active) updateUsage(state, update);
        return;
    }
    if (state.replay) state.replay.update(update);
    else state.turn?.projection.update(update);
  }

  function result(id, value) {
    return rpc.send({ jsonrpc: '2.0', id, result: value });
  }

  function permission(id, params) {
    const state = active;
    const tool = params.toolCall ?? {};
    const parent = tool._meta?.['opencode/child-session']?.parentID;
    const choices = (params.options ?? []).flatMap(option => {
      const normalized = approvalOptions.get(option.kind);
      return normalized && typeof option.optionId === 'string' ? [{ id: option.optionId, ...normalized }] : [];
    });
    if (!state?.turn || (params.sessionId !== state.id && parent !== state.id) || !choices.length) {
      result(id, { outcome: { outcome: 'cancelled' } }).catch(() => {});
      return;
    }
    const key = JSON.stringify(id);
    dialogs.set(key, { id, state, choices });
    const operation = acpOperation(tool, state.entry.cwd);
    const title = operation.command && tool.title?.trim() === operation.command.trim()
      ? '执行命令' : tool.title || 'OpenCode 请求权限';
    notify(state.id, { kind: 'interaction', request: {
      kind: 'approval', id: key, title,
      choices, operation, cancel: true, turnId: state.turn.run.id,
      itemId: tool.toolCallId ? 'tool:' + tool.toolCallId : undefined,
    } });
  }

  function packet({ method, id, params = {} }) {
    if (method === 'span/backendWorkspace') {
      if (!local && !workspace) workspace = params.cwd;
    } else if (method === 'session/update' && params.update) {
      updateSession(params.sessionId, params.update);
    } else if (method === 'session/request_permission' && id != null) {
      permission(id, params);
    } else if (id != null) {
      rpc.send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not supported' } }).catch(() => {});
    }
  }

  function finish(state, turn, status, error) {
    if (state !== active || state.turn !== turn) return;
    turn.projection.finish(status !== 'completed');
    for (const [id, dialog] of dialogs) {
      if (dialog.state !== state) continue;
      dialogs.delete(id);
      notify(state.id, { kind: 'interactionResolved', id });
    }
    state.turn = undefined;
    notify(state.id, { kind: 'run', run: { id: turn.run.id, status, error } });
  }

  async function configure(state, options) {
    for (const id of ['model', 'effort', 'mode']) {
      const selected = options[id];
      if (!selected || selected === state.options[id]) continue;
      const config = state.config.find(item => item.id === id);
      if (!configChoices(config).some(option => option.id === selected)) continue;
      const response = await request('session/set_config_option', { sessionId: state.id, configId: id, value: selected });
      useConfig(state, response.configOptions);
    }
  }

  async function promptInput(input) {
    const images = input.filter(part => part.kind === 'image');
    const text = fileReferenceText(input, local);
    const blocks = text ? [{ type: 'text', text }] : [];
    for (const image of images) {
      if (!local || !capabilities?.promptCapabilities?.image || !image.path) {
        throw new Error('当前 OpenCode 会话无法发送图片。');
      }
      const content = await window.span.previewImage(image.path);
      if (!content?.data) throw new Error('无法读取图片附件。');
      blocks.push({ type: 'image', data: content.data, mimeType: content.mime });
    }
    return blocks;
  }

  function sessionParams(entry) {
    return { sessionId: entry.sessionId, cwd: entry.cwd, mcpServers: [],
      ...(Array.isArray(entry.additionalDirectories) && { additionalDirectories: entry.additionalDirectories }) };
  }

  async function replay(entry, limit) {
    const state = { id: entry.sessionId, usage: {}, replay: acpReplay() };
    loading = state;
    try {
      const response = await request('session/load', sessionParams(entry));
      state.history = state.replay.finish();
      state.nextTurn = state.history.length;
      state.replay = undefined;
      const opened = activate(state, entry, response.configOptions);
      return { ...opened, history: historyPage(state, limit) };
    } finally {
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
      await window.span.request('agent.start', { generation, cwd, backend: 'opencode', ssh: location.host });
      await rpc.ready();
      const initialized = await request('initialize', { protocolVersion: 1, clientCapabilities: {},
        clientInfo: { name: 'span', version: '0.1.0' } });
      if (initialized.protocolVersion !== 1) throw new Error('当前 OpenCode 使用了不兼容的 ACP 版本。');
      if (!workspace) throw new Error('无法确认 OpenCode 的工作目录。');
      capabilities = initialized.agentCapabilities;
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
          const response = await request('session/new', { cwd: workingDirectory, mcpServers: [] });
          const state = { ...pending.unconfirmed.get(response.sessionId), usage: {}, nextTurn: 0 };
          return activate(state, { sessionId: response.sessionId, cwd: workingDirectory }, response.configOptions);
        } finally {
          if (loading === pending) loading = undefined;
        }
      },
      async resume(session, limit) {
        if (!capabilities?.loadSession) throw new Error('当前 OpenCode 不支持恢复会话。');
        return replay(await lookup(session.id), limit);
      },
      async history(session, { cursor, limit = pageSize }) {
        return historyPage(requireActive(session), limit, cursor);
      },
      async release(session) {
        if (session.id !== active?.id) return;
        active = undefined;
        commands.length = 0;
        modes.length = 0;
        await detach(session.id);
      },
    },
    turns: {
      async start(session, input, options = {}, clientId) {
        const state = requireActive(session);
        if (state.turn) throw new Error('请等当前 OpenCode 回合结束。');
        const prompt = await promptInput(input);
        await configure(state, options);
        const run = { id: acpTurnId(state.nextTurn++), status: 'running' };
        const turn = { run, projection: acpTurn(run.id, event => notify(state.id, event)) };
        state.turn = turn;
        const { sent, response } = rpc.beginRequest('session/prompt', { sessionId: state.id, prompt }, null);
        const dispatched = sent.then(() => {
          const text = input.filter(part => part.kind === 'text').map(part => part.text).join('\n');
          const files = input.filter(part => part.kind === 'file' || part.kind === 'image')
            .map(part => ({ ...part, name: part.name ?? attachmentName(part.path) }));
          notify(state.id, { kind: 'item', final: true,
            item: { kind: 'user', id: 'user', turnId: run.id, text, attachments: attachmentArtifacts(files), clientId } });
        });
        dispatched.then(() => response.then(reply => {
          if (state !== active || state.turn !== turn) return;
          if (reply.usage) promptUsage(state, reply.usage);
          if (reply.stopReason === 'cancelled') finish(state, turn, 'cancelled');
          else if (reply.stopReason === 'max_tokens') finish(state, turn, 'failed', 'OpenCode 达到本轮输出上限。');
          else if (reply.stopReason === 'refusal') finish(state, turn, 'failed', 'OpenCode 拒绝了本轮请求。');
          else finish(state, turn, 'completed');
        }, error => finish(state, turn, 'failed', error.message)), () => {});
        // Observe response failures even if transport dispatch itself rejects.
        response.catch(() => {});
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
          throw new Error('OpenCode 未提供这个审批选项。');
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
