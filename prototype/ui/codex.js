import { connectRpc } from './agent-rpc.js';
import { normalizeItem, normalizeLimits, normalizeRun, normalizeUsage, patches, planSteps } from './codex-items.js';
import { fileReferencePreview, fileReferenceText } from './file-references.js';

const featureBackend = 'codex';
const permissions = [
  { id: 'workspace', label: '工作区', description: '在工作区内写入，额外权限需确认' },
  { id: 'readOnly', label: '只读', description: '只允许读取，不提升权限' },
];
const modes = [{ id: 'default', label: '执行' }, { id: 'plan', label: '规划' }];
const pageRequest = limit => ({ limit, sortDirection: 'desc', itemsView: 'full' });
/** @returns {import('./agent-protocol').Goal | null} */
const normalizeGoal = goal => goal ? {
  objective: goal.objective, status: {
    active: 'active', paused: 'paused', complete: 'complete', blocked: 'blocked',
    budgetLimited: 'limited', usageLimited: 'limited',
  }[goal.status] ?? 'unknown',
  budget: goal.tokenBudget, tokens: goal.tokensUsed, seconds: goal.timeUsedSeconds,
} : null;

/** @type {Record<string, import('./agent-protocol').ItemDelta['kind']>} */
const deltaKinds = {
  'item/agentMessage/delta': 'message',
  'item/reasoning/summaryTextDelta': 'reasoning',
  'item/plan/delta': 'plan',
  'item/commandExecution/outputDelta': 'command',
  'item/fileChange/outputDelta': 'patch',
};

/** @param {import('./agent-protocol').Input[]} parts */
function inputs(parts, local) {
  if (parts.some(part => part.kind === 'file')) {
    const text = fileReferenceText(parts, local);
    parts = [{ kind: 'text', text }, ...parts.filter(part => part.kind !== 'file' && part.kind !== 'text')];
  }
  return parts.map(part => {
    switch (part.kind) {
      case 'text': return { type: 'text', text: part.text, text_elements: [] };
      case 'image': return part.path ? { type: 'localImage', path: part.path } : { type: 'image', url: part.url };
      case 'skill': return { type: 'skill', name: part.name, path: part.path };
      case 'mention': return { type: 'mention', name: part.name, path: part.path };
      default: throw new Error('输入类型不受支持。');
    }
  });
}

/**
 * @returns {[import('./agent-protocol').Interaction, (reply: import('./agent-protocol').InteractionReply) => object] | null}
 */
function interaction(method, id, params) {
  const base = { id, turnId: params.turnId, itemId: params.itemId, detail: params.reason };
  const choices = [
    { id: 'decline', label: '拒绝', effect: 'deny' },
    { id: 'accept', label: '允许一次', effect: 'allow' },
  ];
  if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') {
    const network = params.networkApprovalContext;
    const isCommand = method === 'item/commandExecution/requestApproval';
    const operation = network ? { kind: 'network', target: network.host, protocol: network.protocol, cwd: params.cwd }
      : isCommand ? { kind: 'command', command: params.command, cwd: params.cwd, permissions: params.additionalPermissions }
        : { kind: 'files', root: params.grantRoot };
    const title = network ? '允许网络访问' : isCommand ? '确认命令操作' : '确认修改文件';
    const available = params.availableDecisions;
    const canAccept = !Array.isArray(available) || available.includes('accept');
    const decisions = canAccept ? choices : choices.slice(0, 1);
    return [{ ...base, kind: 'approval', title, operation, choices: decisions },
      reply => ({ decision: 'choice' in reply && reply.choice === 'accept' && canAccept ? 'accept' : 'decline' })];
  }
  if (method === 'item/permissions/requestApproval') {
    return [{ ...base, kind: 'approval', title: '授予额外权限', choices,
      operation: { kind: 'permissions', cwd: params.cwd, permissions: params.permissions ?? {} } },
      reply => ({ scope: 'turn', permissions: 'choice' in reply && reply.choice === 'accept' ? (params.permissions ?? {}) : {} })];
  }
  if (method === 'item/tool/requestUserInput') {
    return [{ ...base, kind: 'input', title: 'Agent 请求输入', fields: (params.questions ?? []).map(question => ({
      id: question.id, label: question.question, secret: question.isSecret, allowOther: question.isOther,
      required: true, options: question.options?.map(option => ({ id: option.label, ...option })),
    })) }, reply => ({ answers: Object.fromEntries(Object.entries('values' in reply ? reply.values : {}).map(([key, value]) =>
      [key, { answers: [value] }])) })];
  }
  return null;
}

function modelInfo(model) {
  const tiers = model.serviceTiers?.length ? model.serviceTiers
    : (model.additionalSpeedTiers ?? []).map(id => ({ id, name: id === 'fast' || id === 'priority' ? 'Fast' : id }));
  return { id: model.model ?? model.id, label: model.displayName ?? model.id, description: model.description,
    isDefault: model.isDefault, inputs: ['text', ...(model.inputModalities?.includes('image') ? ['image'] : [])],
    efforts: (model.supportedReasoningEfforts ?? []).map(({ reasoningEffort, description }) =>
      ({ id: reasoningEffort, label: reasoningEffort, description })), defaultEffort: model.defaultReasoningEffort,
    tiers: tiers.map(tier => ({ id: tier.id === 'fast' ? 'priority' : tier.id, label: tier.name, description: tier.description })),
    defaultTier: model.defaultServiceTier };
}

/**
 * @param {string} backend
 * @param {import('./agent-protocol').AdapterContext} context
 * @returns {import('./agent-protocol').AgentAdapter}
 */
function createCodex(backend, { generation, cwd, location, onEvent }) {
  const native = backend === featureBackend;
  const pending = new Map();
  const active = new Set();
  const ref = id => ({ backend, location, id });
  const session = (thread, overrides = { cwd: undefined }) => ({
    ref: ref(thread.id), cwd: thread.cwd ?? overrides.cwd, title: thread.name,
    preview: fileReferencePreview(thread.preview), branch: thread.gitInfo?.branch, updatedAt: thread.updatedAt,
  });
  const normalizeTurn = turn => ({
    id: turn.id, run: normalizeRun(turn),
    rows: (turn.items ?? []).map(item => normalizeItem(item, turn.id, ref)).filter(Boolean),
  });
  const normalizePage = page => ({
    items: [...(page.data ?? [])].reverse().map(normalizeTurn), cursor: page.nextCursor ?? null,
  });
  const opened = response => ({
    session: session(response.thread, response),
    options: { model: response.model, effort: response.reasoningEffort,
      tier: response.serviceTier, mode: response.collaborationMode?.mode },
    history: response.initialTurnsPage ? normalizePage(response.initialTurnsPage)
      : response.thread.turns?.length ? normalizePage({ data: [...response.thread.turns].reverse() }) : undefined,
  });

  const rpc = connectRpc(generation, packet, route => onEvent({ kind: 'connection', route }),
    error => onEvent({ kind: 'disconnected', error }));
  const request = rpc.request;
  const notify = (id, event) => onEvent({ ...event, session: ref(id) });

  function packet({ id, method, params: payload }) {
    const params = payload ?? {};
    const threadId = params.threadId ?? params.conversationId;
    if (id != null) {
      const entry = threadId && active.has(threadId) && interaction(method, String(id), params);
      if (!entry) {
        if (threadId && !active.has(threadId)) return;
        rpc.send({ id, error: { code: -32601, message: 'This client does not implement this request' } })
          .catch(() => {});
        return;
      }
      const [prompt, response] = entry;
      pending.set(prompt.id, { id, threadId, response, prompt, sending: false });
      notify(threadId, { kind: 'interaction', request: prompt });
      return;
    }

    if (method === 'account/rateLimits/updated') {
      onEvent({ kind: 'quota', limits: normalizeLimits(params) });
      return;
    }
    if (!threadId) return;
    const { turnId, itemId } = params;
    if (Object.hasOwn(deltaKinds, method)) {
      notify(threadId, { kind: 'delta', delta: {
        id: itemId, turnId, kind: deltaKinds[method], text: params.delta, section: params.summaryIndex,
      } });
      return;
    }
    switch (method) {
      case 'item/started':
      case 'item/completed': {
        const item = normalizeItem(params.item, turnId, ref);
        if (item) notify(threadId, { kind: 'item', item, final: method === 'item/completed' });
        break;
      }
      case 'item/fileChange/patchUpdated':
        notify(threadId, { kind: 'item', final: false, item: {
          id: itemId, turnId, kind: 'patch', files: patches(params.changes), status: 'running',
        } });
        break;
      case 'item/mcpToolCall/progress':
        notify(threadId, { kind: 'item', final: false, item: {
          id: itemId, turnId, kind: 'tool', text: params.message, status: 'running',
        } });
        break;
      case 'turn/diff/updated':
        notify(threadId, { kind: 'item', final: false, item: {
          id: '@turn-diff', turnId, kind: 'patch', files: [], text: params.diff,
        } });
        break;
      case 'turn/plan/updated':
        notify(threadId, { kind: 'item', final: false, item: {
          id: '@turn-plan', turnId, kind: 'plan', text: params.explanation, steps: planSteps(params.plan),
        } });
        break;
      case 'turn/started':
      case 'turn/completed':
        for (const item of normalizeTurn(params.turn).rows) {
          notify(threadId, { kind: 'item', item, final: method === 'turn/completed' });
        }
        notify(threadId, { kind: 'run', run: normalizeRun(params.turn) });
        if (method === 'turn/completed') {
          for (const [key, entry] of pending) {
            if (entry.threadId === threadId && (!entry.prompt.turnId || entry.prompt.turnId === params.turn.id)) {
              pending.delete(key);
              notify(threadId, { kind: 'interactionResolved', id: key });
            }
          }
        }
        break;
      case 'thread/name/updated':
        notify(threadId, { kind: 'session', info: { title: params.threadName } });
        break;
      case 'thread/goal/updated':
      case 'thread/goal/cleared':
        notify(threadId, { kind: 'goal', goal: normalizeGoal(params.goal) });
        break;
      case 'thread/tokenUsage/updated':
        notify(threadId, { kind: 'usage', usage: normalizeUsage(params.tokenUsage) });
        break;
      case 'serverRequest/resolved':
        if (pending.get(String(params.requestId))?.threadId === threadId) {
          pending.delete(String(params.requestId));
          notify(threadId, { kind: 'interactionResolved', id: String(params.requestId) });
        }
        break;
    }
  }

  /** @type {NonNullable<import('./agent-protocol').AgentAdapter['extensions']>} */
  const extensions = {
    kinds: ['mcp', 'skill', 'plugin', 'connector'],
    async list(kind, thread) {
      if (kind === 'mcp') {
        const { data } = await request('mcpServerStatus/list', { threadId: thread.id, limit: 50, detail: 'toolsAndAuthOnly' });
        return (data ?? []).map(item => ({ kind, id: item.name, label: item.name, status: item.authStatus }));
      }
      if (kind === 'skill') {
        const { data } = await request('skills/list', {});
        return (data ?? []).flatMap(group => (group.skills ?? []).map(item => ({
          kind, id: item.path, label: item.name, description: item.shortDescription ?? item.description,
          enabled: item.enabled, source: group.cwd,
        })));
      }
      if (kind === 'plugin') {
        const { marketplaces } = await request('plugin/list', {});
        return (marketplaces ?? []).flatMap(group => (group.plugins ?? []).map(item => ({
          kind, id: item.id, label: item.name, enabled: item.enabled, source: group.name,
        })));
      }
      if (kind === 'connector') {
        const { data } = await request('app/list', { threadId: thread.id, limit: 50 });
        return (data ?? []).map(item => ({ kind, id: item.id, label: item.name, description: item.description, enabled: item.isEnabled }));
      }
      return [];
    },
  };

  async function listSessions({ cursor, archived = false, query }) {
    const result = await request('thread/list', { limit: 40, archived, cursor, ...(query && { searchTerm: query }) });
    return { items: (result.data ?? []).map(item => ({ ...session(item), archived })), cursor: result.nextCursor ?? null };
  }

  return {
    localFileReferences: location.kind === 'local',
    localImageInputs: native && location.kind === 'local',
    async open() {
      await window.span.request('agent.start', { backend, cwd, ssh: location.kind === 'ssh' ? location.host : undefined, generation });
      await rpc.ready();
      await request('initialize', {
        clientInfo: { name: 'span_web_workbench', title: 'Span Workbench', version: '0.1.0' },
        capabilities: { experimentalApi: true },
      });
      await rpc.send({ method: 'initialized' });
    },
    close() {
      rpc.close();
      window.span.request('agent.close', { generation }).catch(() => {});
    },
    sessions: {
      list: listSessions,
      search: native ? listSessions : undefined,
      async start({ cwd }) {
        const response = await request('thread/start', { cwd, approvalPolicy: 'on-request', sandbox: 'workspace-write' });
        active.add(response.thread.id);
        return opened(response);
      },
      async resume(thread, limit) {
        active.add(thread.id);
        try {
          const response = await request('thread/resume', {
            threadId: thread.id, excludeTurns: true, ...(native ? { initialTurnsPage: pageRequest(limit) } : {}),
          });
          return opened(response);
        } catch (error) {
          active.delete(thread.id);
          throw error;
        }
      },
      async history(thread, { limit, cursor }) {
        return normalizePage(await request('thread/turns/list', { threadId: thread.id, ...pageRequest(limit), cursor }));
      },
      ...(native && {
        async release(thread) {
          active.delete(thread.id);
          for (const [key, entry] of pending) {
            if (entry.threadId === thread.id) pending.delete(key);
          }
          await request('thread/unsubscribe', { threadId: thread.id });
        },
        async fork(thread, from) {
          const response = await request('thread/fork', {
            threadId: thread.id, excludeTurns: true, lastTurnId: from?.turnId,
          });
          active.add(response.thread.id);
          return opened(response);
        },
        rename: (thread, title) => request('thread/name/set', { threadId: thread.id, name: title }),
        archive: (thread, archived) => request(archived ? 'thread/archive' : 'thread/unarchive', { threadId: thread.id }),
      }),
    },
    turns: {
      async start(thread, input, options, clientId) {
        /** @type {Record<string, unknown>} */
        const params = { threadId: thread.id, input: inputs(input, location.kind === 'local'), summary: 'auto' };
        if (native) params.clientUserMessageId = clientId;
        if (options.model) params.model = options.model;
        if (options.effort) params.effort = options.effort;
        if (options.tier) params.serviceTierForTurn = options.tier;
        if (options.mode && options.model) params.collaborationMode = {
          mode: options.mode, settings: { model: options.model, reasoning_effort: options.effort ?? null, developer_instructions: null },
        };
        if (options.permissions === 'readOnly') {
          params.approvalPolicy = 'never';
          params.sandboxPolicy = { type: 'readOnly', networkAccess: false };
        } else if (options.permissions === 'workspace') {
          params.approvalPolicy = 'on-request';
          params.sandboxPolicy = { type: 'workspaceWrite', writableRoots: [], networkAccess: false,
            excludeTmpdirEnvVar: false, excludeSlashTmp: false };
        }
        const result = await request('turn/start', params);
        return normalizeRun(result.turn);
      },
      stop: (thread, turnId) => request('turn/interrupt', { threadId: thread.id, turnId }),
      ...(native && {
        steer: (thread, expectedTurnId, input, clientId) => request('turn/steer', {
          threadId: thread.id, expectedTurnId, clientUserMessageId: clientId, input: inputs(input, location.kind === 'local'),
        }),
        compact: thread => request('thread/compact/start', { threadId: thread.id }),
        async review(thread, target) {
          const selected = target.kind === 'worktree' ? { type: 'uncommittedChanges' } : {
            branch: { type: 'baseBranch', branch: target.value }, commit: { type: 'commit', sha: target.value, title: null },
            custom: { type: 'custom', instructions: target.value },
          }[target.kind];
          const result = await request('review/start', { threadId: thread.id, target: selected, delivery: 'inline' });
          return normalizeRun(result.turn);
        },
      }),
    },
    interactions: {
      async respond(id, reply) {
        const entry = pending.get(id);
        if (!entry) throw new Error('此请求已经结束。');
        if (entry.sending) return;
        entry.sending = true;
        try {
          await rpc.send({ id: entry.id, result: entry.response(reply) });
          if (pending.get(id) === entry) {
            pending.delete(id);
            notify(entry.threadId, { kind: 'interactionResolved', id });
          }
        } finally {
          entry.sending = false;
        }
      },
    },
    ...(native && {
      async models() {
        const models = new Map();
        let cursor;
        for (let page = 0; page < 8; page++) {
          const result = await request('model/list', { cursor, limit: 50 });
          for (const item of result.data ?? []) {
            if (!item.hidden) {
              const model = modelInfo(item);
              models.set(model.id, model);
            }
          }
          if (!result.nextCursor || result.nextCursor === cursor) break;
          cursor = result.nextCursor;
        }
        return [...models.values()];
      },
      modes, permissions, extensions,
      goal: {
        async read(thread) {
          return normalizeGoal((await request('thread/goal/get', { threadId: thread.id })).goal);
        },
        async update(thread, action) {
          const threadId = thread.id;
          if (action.kind === 'clear') {
            await request('thread/goal/clear', { threadId });
            return null;
          }
          return normalizeGoal((await request('thread/goal/set', {
            threadId, origin: 'user', status: action.kind === 'pause' ? 'paused' : 'active',
            ...(action.kind === 'set' ? { objective: action.objective, tokenBudget: action.budget } : {}),
          })).goal);
        },
      },
      async usage() {
        return { limits: normalizeLimits(await request('account/rateLimits/read', null)) };
      },
      delegation: { observe: true },
    }),
  };
}

/** @type {import('./agent-protocol').AgentLocation['kind'][]} */
const locations = ['local', 'ssh'];
/** @type {import('./agent-protocol').AdapterDefinition} */
export const codexAdapter = { id: 'codex', label: 'Codex', locations, create: context => createCodex('codex', context) };
/** @type {import('./agent-protocol').AdapterDefinition} */
export const clueAdapter = { id: 'clue', label: 'Clue', locations, create: context => createCodex('clue', context) };
