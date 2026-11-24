import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agentBackends, createAgent, sessionKey } from '../ui/agent.js';
import { applyTimeline, historyRows, mergeHistory, visibleRow } from '../ui/timeline.js';

const local = { kind: 'local' };
const remote = { kind: 'ssh', host: 'dev' };
const session = (backend, location) => ({ backend, location, id: 'thread' });

test('session identities are scoped by backend and host, and the factory rejects unknown backends', () => {
  const refs = [session('codex', local), session('codex', remote), session('clue', remote)];
  assert.equal(new Set(refs.map(sessionKey)).size, refs.length);
  assert.deepEqual(agentBackends.map(item => item.id), ['codex', 'clue']);
  assert.throws(() => createAgent('missing', { location: local }), /不支持/);
});

test('Codex adapter translates RPC, streams summaries, and routes different interaction replies', async () => {
  const handlers = new Set();
  const requests = [];
  const events = [];
  const publish = (event, data, generation = 9) => {
    for (const handler of handlers) handler({ event, generation, data });
  };
  const responses = {
    initialize: {},
    'thread/list': { data: [{ id: 'thread', cwd: '/work', name: 'Review' }], nextCursor: 'opaque' },
    'thread/resume': { thread: { id: 'thread' }, initialTurnsPage: { data: [], nextCursor: 'old' } },
    'thread/goal/set': { goal: { objective: 'Ship', status: 'active', tokenBudget: 100 } },
    'account/rateLimits/read': { rateLimits: { primary: { usedPercent: 22, windowDurationMins: 60 } } },
  };
  globalThis.window = { span: {
    onEvent(callback) {
      handlers.add(callback);
      return () => handlers.delete(callback);
    },
    async request(method, params) {
      requests.push([method, params]);
      const { packet } = params;
      if (method === 'agent.start') publish('agent-route', 'shared');
      if (packet?.method && packet.id != null) {
        publish('agent', { id: packet.id, result: responses[packet.method] ?? {} });
      }
    },
  } };

  const agent = createAgent('codex', { generation: 9, cwd: '/work', location: remote, onEvent: event => events.push(event) });
  try {
    await agent.open();
    assert.deepEqual(events.shift(), { kind: 'connection', route: 'shared' });
    assert.deepEqual(requests[0], ['agent.start', { backend: 'codex', generation: 9, cwd: '/work', ssh: 'dev' }]);
    const list = await agent.sessions.list({});
    const ref = list.items[0].ref;
    assert.deepEqual(ref, session('codex', remote));
    assert.equal(list.cursor, 'opaque');
    const opened = await agent.sessions.resume(ref, 20);
    assert.equal(opened.history.cursor, 'old');
    assert.deepEqual(await agent.goal.update(ref, { kind: 'set', objective: 'Ship', budget: 100 }), {
      objective: 'Ship', status: 'active', budget: 100, seconds: undefined, tokens: undefined,
    });
    assert.equal(requests.at(-1)[1].packet.params.origin, 'user');
    assert.equal((await agent.usage()).limits[0].used, 22);
    const scope = { threadId: 'thread', turnId: 't' };
    publish('agent', { method: 'item/reasoning/textDelta', params: { ...scope, itemId: 'r', delta: 'raw' } });
    publish('agent', { method: 'item/reasoning/summaryTextDelta',
      params: { ...scope, itemId: 'r', summaryIndex: 1, delta: 'summary' } });
    publish('agent', { method: 'item/reasoning/summaryTextDelta',
      params: { ...scope, itemId: 'r', summaryIndex: 1, delta: 'stale' } }, 8);
    publish('agent', { id: 56, method: 'item/permissions/requestApproval',
      params: { ...scope, permissions: { network: { enabled: true } } } });
    publish('agent', { id: 'second', method: 'item/tool/requestUserInput',
      params: { ...scope, questions: [{ id: 'token', isSecret: true, question: 'Token?' }] } });
    assert.deepEqual(events.map(event => event.kind), ['delta', 'interaction', 'interaction']);
    assert.equal(events[0].delta.text, 'summary');
    assert.equal(events[0].delta.section, 1);
    assert.equal(events[2].request.fields[0].secret, true);
    await agent.interactions.respond('56', { choice: 'decline' });
    assert.deepEqual(requests.at(-1)[1].packet, { id: 56, result: { scope: 'turn', permissions: {} } });
    await agent.interactions.respond('second', { values: { token: 'fixture' } });
    assert.deepEqual(requests.at(-1)[1].packet.result, { answers: { token: { answers: ['fixture'] } } });
  } finally {
    agent.close();
  }
  assert.equal(handlers.size, 0);

  const clue = createAgent('clue', { generation: 10, cwd: '/work', location: local, onEvent() {} });
  assert.equal(typeof clue.sessions.resume, 'function');
  assert.equal(clue.goal, undefined);
  assert.equal(clue.delegation, undefined);
  clue.close();
  delete globalThis.window;
});

test('transport startup surfaces the backend diagnostic before sending initialize', async () => {
  let listener;
  const requested = [];
  globalThis.window = { span: {
    onEvent(callback) { listener = callback; return () => {}; },
    async request(method) {
      requested.push(method);
      if (method === 'agent.start') {
        listener({ event: 'agent-closed', generation: 1, data: 'Codex executable unavailable' });
      }
    },
  } };
  const agent = createAgent('codex', { generation: 1, cwd: '/work', location: local, onEvent() {} });
  try {
    await assert.rejects(agent.open(), /Codex executable unavailable/);
    assert.deepEqual(requested, ['agent.start']);
  } finally {
    agent.close();
    delete globalThis.window;
  }
});

test('timeline preserves interleaved tools, reconciles message chunks, and keeps section boundaries', () => {
  const delta = (kind, id, text, section) => ({ kind: 'delta', delta: { turnId: 't', id, kind, text, section } });
  const item = (kind, id, fields, final = true) => ({ kind: 'item', final, item: { turnId: 't', id, kind, ...fields } });
  const rows = applyTimeline([], [
    delta('reasoning', 'r', 'First', 0),
    delta('reasoning', 'r', 'Second', 1),
    item('reasoning', 'r', { sections: [] }),
    delta('message', 'm', 'Start. '),
    item('command', 'c', { command: 'git status', text: 'working tree clean' }),
    delta('reasoning', 'second', 'Next\nChecking'),
    delta('reasoning', 'second', ' alignment'),
    item('reasoning', 'r', { sections: ['First', 'Second'] }),
    delta('message', 'm', 'Finish.'),
    item('message', 'm', { text: 'Start. Finish.' }),
    delta('message', 'm', 'late delta'),
  ]);
  assert.deepEqual(rows.map(row => row.kind), ['reasoning', 'message', 'command', 'message']);
  assert.deepEqual(rows[0].sources.get('r').sections, ['First', 'Second']);
  assert.deepEqual(rows[0].sources.get('second').sections, ['Next\nChecking alignment']);
  assert.equal(rows[0].preview, 'Checking alignment');
  assert.equal(rows[1].text + rows[3].text, 'Start. Finish.');
  assert.equal(visibleRow({ kind: 'reasoning' }), false);
  const history = historyRows([
    { id: 'earlier', run: { status: 'completed' }, rows: [{ turnId: 'earlier', id: 'm', kind: 'message', text: 'History' }] },
    { id: 't', run: { status: 'completed' }, rows: [
      { turnId: 't', id: 'r', kind: 'reasoning', sections: ['First', 'Second'] },
      { turnId: 't', id: 'm', kind: 'message', text: 'Start. Finish.' },
      { turnId: 't', id: 'second', kind: 'reasoning', sections: ['Next\nChecking alignment'] },
    ] },
  ]);
  const reopened = mergeHistory(rows, history);
  assert.equal(history.filter(row => row.kind === 'reasoning').length, 1);
  assert.deepEqual(reopened.map(row => row.kind), ['message', 'reasoning', 'message', 'command', 'message']);
  assert.equal(reopened[1].key, rows[0].key);
  assert.equal(reopened[1].sources.size, 2);
});

test('the server user echo merges into the optimistic row without moving it', () => {
  const optimistic = { kind: 'user', text: 'Run', key: 'client', clientId: 'client', optimistic: true };
  const event = { kind: 'item', final: true, item: {
    kind: 'user', turnId: 't', id: 'server', text: 'Run', clientId: 'client',
  } };
  const rows = applyTimeline([optimistic], [event, event]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].key, 'client');
  assert.equal(rows[0].id, 'server');
});

test('timeline updates can branch from the same rows without sharing new positions', () => {
  const update = (id, text) => ({ kind: 'delta', delta: { turnId: 't', kind: 'message', id, text } });
  const original = applyTimeline([], [update('m', 'Start')]);
  const first = applyTimeline(original, [update('first', 'A')]);
  const second = applyTimeline(original, [update('second', 'B')]);
  const continued = applyTimeline(second, [update('first', 'C'), update('m', '?')]);
  assert.deepEqual(original.map(row => row.text), ['Start']);
  assert.deepEqual(first.map(row => row.text), ['Start', 'A']);
  assert.deepEqual(second.map(row => row.text), ['Start', 'B']);
  assert.deepEqual(continued.map(row => row.text), ['Start', 'B', 'C', '?']);
});
