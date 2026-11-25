const statuses = new Set(['active', 'paused', 'complete', 'blocked', 'waiting']);

function normalizeGoal(value) {
  if (typeof value?.text !== 'string' || !value.text.trim()) return null;
  const status = statuses.has(value.status) ? value.status : value.active ? 'active' : 'paused';
  return { objective: value.text, status, reason: typeof value.reason === 'string' ? value.reason : undefined };
}

export function createKiloGoals({ generation, requireActive, synchronize, begin, end, notify }) {
  let current;
  const request = params => window.span.request('agent.kiloGoal', { generation, ...params });

  function close() {
    clearTimeout(current?.timer);
    current = undefined;
  }

  function attach(state) {
    close();
    current = { state, revision: 0 };
  }

  function schedule(scope, delay) {
    if (scope !== current || scope.changing) return;
    clearTimeout(scope.timer);
    scope.timer = setTimeout(() => {
      scope.timer = undefined;
      read(scope).catch(() => follow(scope));
    }, delay);
  }

  function follow(scope) {
    const status = scope.goal?.status;
    if (scope.state.turn || status === 'active' || status === 'waiting') {
      schedule(scope, status === 'waiting' ? 4000 : 1000);
    }
  }

  function read(scope) {
    if (scope.changing) return Promise.resolve(undefined);
    if (scope.pending?.revision === scope.revision) return scope.pending.promise;
    const pending = { revision: scope.revision };
    pending.promise = refresh(scope).finally(() => {
      if (scope.pending === pending) scope.pending = undefined;
    });
    scope.pending = pending;
    return pending.promise;
  }

  async function refresh(scope) {
    const { state, revision } = scope;
    const goal = normalizeGoal(await request({ sessionId: state.id, cwd: state.entry.cwd }));
    if (scope !== current || scope.revision !== revision) return;
    const previous = scope.goal;
    scope.goal = goal;
    if (goal?.status !== previous?.status || goal?.objective !== previous?.objective || goal?.reason !== previous?.reason) {
      notify(state.id, { kind: 'goal', goal });
    }
    synchronize(state, goal);
    follow(scope);
    return goal;
  }

  return {
    attach, close,
    watch(state, delay = 1000) {
      if (current?.state === state) schedule(current, delay);
    },
    activity(state) {
      if (current?.state === state && current.goal?.status === 'waiting' && !state.turn) begin(state);
    },
    capability: {
      budget: false, startsOnSave: true, canRestart: true, objectiveLimit: 10000,
      read(session) {
        requireActive(session);
        return read(current);
      },
      async update(session, { kind, objective }, options) {
        const state = requireActive(session);
        const scope = current;
        if (scope.changing) throw new Error('正在更新当前目标。');
        const starts = ['set', 'edit', 'resume'].includes(kind);
        if (starts && state.turn && !state.turn.goal) throw new Error('请等当前回复结束后再启动目标。');
        const turn = starts && !state.turn ? begin(state) : undefined;
        scope.changing = true;
        scope.revision++;
        clearTimeout(scope.timer);
        scope.timer = undefined;
        try {
          await request({ sessionId: state.id, cwd: state.entry.cwd, action: kind, objective, options });
        } catch (error) {
          if (turn) end(state, turn, 'cancelled');
          throw error;
        } finally {
          scope.changing = false;
          follow(scope);
        }
        if (scope === current) return read(scope);
      },
    },
  };
}
