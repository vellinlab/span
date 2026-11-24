/** @type {Record<string, import('./agent-protocol').AgentStatus>} */
const agentStates = {
  pendingInit: 'pending', pending: 'pending', inProgress: 'running', running: 'running',
  started: 'running', interacted: 'running', completed: 'completed', succeeded: 'completed',
  failed: 'failed', errored: 'failed', declined: 'cancelled', interrupted: 'cancelled',
  shutdown: 'cancelled', cancelled: 'cancelled', notFound: 'unknown',
};

const delegationLabels = {
  spawnAgent: '启动子代理', sendInput: '追加子代理指令', sendMessage: '发送代理消息',
  followupTask: '追加代理任务', resumeAgent: '恢复子代理', wait: '等待子代理',
  closeAgent: '关闭子代理', interruptAgent: '中断子代理', listAgents: '查看子代理',
  started: '启动子代理', interacted: '与子代理交互', completed: '子代理结束', interrupted: '中断子代理',
};

const nameOf = path => path?.split(/[\\/]/).filter(Boolean).at(-1);
const detailText = value => typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value, null, 2);
/** @returns {import('./agent-protocol').PlanStep[]} */
export const planSteps = entries => (entries ?? []).map(({ step, status }) => ({
  text: step, status: status === 'completed' ? 'completed' : status === 'inProgress' ? 'running' : 'pending',
}));
export const patches = changes => (changes ?? []).map(({ path, kind, diff }) => ({
  path, action: kind?.type ?? kind, diff,
}));

export function normalizeItem(item, turnId, ref) {
  if (!item?.id) return null;
  const base = { id: item.id, turnId, status: agentStates[item.status] };
  switch (item.type) {
    case 'userMessage': {
      const content = item.content ?? [];
      const text = content.filter(part => part.type === 'text').map(part => part.text).join('\n');
      const attachments = content.filter(part => part.type !== 'text').map((part, index) => ({
        id: String(index),
        kind: /image/i.test(part.type) ? 'image' : 'file',
        name: part.name ?? nameOf(part.path) ?? '图片',
        path: part.path,
      }));
      return { ...base, kind: 'user', clientId: item.clientId, text, attachments };
    }
    case 'agentMessage':
      return { ...base, kind: 'message', text: item.text ?? '',
        phase: { commentary: 'commentary', partial_answer: 'partial', final_answer: 'final' }[item.phase] };
    case 'reasoning':
      return { ...base, kind: 'reasoning', sections: (item.summary ?? []).slice(0, 24) };
    case 'plan':
      return { ...base, kind: 'plan', text: item.text ?? '' };
    case 'commandExecution':
      return { ...base, kind: 'command', command: item.command, cwd: item.cwd,
        text: item.aggregatedOutput ?? undefined, exitCode: item.exitCode ?? undefined };
    case 'fileChange':
      return { ...base, kind: 'patch', files: patches(item.changes) };
    case 'mcpToolCall':
    case 'dynamicToolCall':
    case 'functionCallOutput':
      return { ...base, kind: 'tool', name: item.tool ?? item.name, source: item.server ?? item.namespace,
        text: detailText(item.error ?? item.result?.structuredContent ?? item.result?.content ?? item.contentItems ?? item.output) };
    case 'webSearch': {
      const action = item.action;
      return { ...base, kind: 'search', query: item.query || action?.query || action?.pattern || action?.url || '网页',
        url: /^https?:\/\//i.test(action?.url ?? '') ? action.url : undefined, text: action?.queries?.join('\n') };
    }
    case 'subAgentActivity':
      return { ...base, kind: 'delegation', action: delegationLabels[item.kind] ?? '子代理活动', members: [{
        id: item.agentThreadId, name: nameOf(item.agentPath), model: item.model,
        status: agentStates[item.kind], session: ref(item.agentThreadId),
      }] };
    case 'collabAgentToolCall':
      return { ...base, kind: 'delegation', action: delegationLabels[item.tool] ?? '代理协作', text: item.prompt,
        members: [...new Set([...(item.receiverThreadIds ?? []), ...Object.keys(item.agentsStates ?? {})])].map(id => ({
          id, status: agentStates[item.agentsStates?.[id]?.status], model: item.model,
          detail: item.agentsStates?.[id]?.message, session: ref(id),
          parent: item.senderThreadId ? ref(item.senderThreadId) : undefined,
        })) };
    case 'imageView':
    case 'imageGeneration': {
      const path = item.savedPath ?? item.path;
      return path ? { ...base, kind: 'artifact', artifacts: [{ id: item.id, kind: 'image', path, name: nameOf(path) }] } : null;
    }
    case 'contextCompaction':
      return { ...base, kind: 'notice', title: '已压缩上下文' };
    case 'enteredReviewMode':
    case 'exitedReviewMode':
      return { ...base, kind: 'notice', title: item.type === 'enteredReviewMode' ? '开始代码审查' : '代码审查完成',
        text: item.review };
    default:
      return null;
  }
}

/** @returns {import('./agent-protocol').Run} */
export function normalizeRun(turn) {
  const status = agentStates[turn.status];
  return { id: turn.id, status: status === 'running' || status === 'failed' || status === 'cancelled'
    ? status : 'completed', error: turn.error?.message };
}

export function normalizeUsage(usage) {
  if (!usage) return {};
  return { tokens: {
    total: usage.total?.totalTokens, input: usage.total?.inputTokens, output: usage.total?.outputTokens,
    cached: usage.total?.cachedInputTokens, reasoning: usage.total?.reasoningOutputTokens,
    contextUsed: usage.last?.totalTokens, contextLimit: usage.modelContextWindow,
  } };
}

export function normalizeLimits(params) {
  const buckets = Object.entries(params.rateLimitsByLimitId ?? {});
  const primary = params.rateLimits;
  if (primary && !buckets.some(([id, bucket]) => id === (primary.limitId ?? 'codex') ||
    (bucket.limitId && bucket.limitId === primary.limitId))) {
    buckets.unshift([primary.limitId ?? 'codex', primary]);
  }
  return buckets.flatMap(([id, bucket]) => ['primary', 'secondary'].flatMap(key => {
    const window = bucket[key];
    if (!Number.isFinite(window?.usedPercent)) return [];
    return [{ id: id + ':' + key, label: bucket.limitName ?? (id === 'codex' ? 'Codex' : id),
      used: window.usedPercent, windowMinutes: window.windowDurationMins, resetsAt: window.resetsAt }];
  }));
}
