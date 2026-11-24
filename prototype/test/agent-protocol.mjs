import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agentBackends, createAgent, sessionKey } from '../ui/agent.js';
import { reconcileRoster, recordRosterUpdate, updateRoster } from '../ui/delegation.js';
import { attachmentArtifacts, fileReferencePreview, fileReferenceText, parseFileReferences } from '../ui/file-references.js';
import { rememberWorkspace, savedSession, startupWorkspace } from '../ui/recent-workspaces.js';
import { indexOutput, indexText, LINES_PER_PAGE, readTextPage } from '../ui/text-pages.js';
import { applyTimeline, delegatedMembers, groupedTimelineLayout, historyRows, mergeHistory, timelineLayout, turnReasoning, visibleRow } from '../ui/timeline.js';

const local = { kind: 'local' };
const remote = { kind: 'ssh', host: 'dev' };
const session = (backend, location) => ({ backend, location, id: 'thread' });

test('append-only readers reuse completed log lines and rebuild when the backend replaces output', () => {
  const original = '\t检查\r\n'.repeat(LINES_PER_PAGE);
  const initial = indexText(original);
  assert.equal(initial.pages.length, 1);
  const continued = indexText(original + 'next', undefined, initial);
  assert.deepEqual(continued.pages.map(page => page.start), [0, original.length]);
  assert.equal(initial.pages.length, 1);
  assert.deepEqual(continued, indexText(original + 'next'));

  const first = readTextPage('首行\n\t下一行\r');
  const appendedText = first.text + '\n\n最后一行';
  const last = readTextPage(appendedText, undefined, undefined, undefined, first);
  assert.equal(last.rows[0], first.rows[0]);
  assert.deepEqual(last, readTextPage(appendedText));
  const replaced = '短输出\n';
  assert.deepEqual(indexText(replaced, undefined, continued), indexText(replaced));
  assert.deepEqual(readTextPage(replaced, undefined, undefined, undefined, last), readTextPage(replaced));
});

test('command output indexes only new chunks and can jump to a replaced or compacted log', () => {
  const item = { kind: 'command', id: 'log', turnId: 'turn', status: 'running',
    text: '检查\r\n'.repeat(LINES_PER_PAGE - 1) + '末行\r' };
  const add = text => ({ kind: 'delta', delta: { id: item.id, turnId: item.turnId, kind: 'command', text } });
  const first = applyTimeline([], [{ kind: 'item', item, final: false }]);
  const initial = indexOutput(first[0].outputChunks);
  for (const branch of ['一', '二']) {
    const [row] = applyTimeline(first, [add('\n'), add(branch)]);
    const index = indexOutput(row.outputChunks, initial);
    assert.equal(index.pages.join(''), row.text);
    assert.deepEqual(index.pages, [item.text + '\n', branch]);
    assert.deepEqual(initial.pages, [item.text]);
  }

  const comments = Array.from({ length: 300 }, (_, i) => add(`记录 ${i}\n`));
  const [log] = applyTimeline(first, comments);
  const rebuilt = indexOutput(log.outputChunks, initial);
  assert.equal(rebuilt.pages.join(''), log.text);
  assert.ok(log.outputChunks.depth < comments.length);
  const [final] = applyTimeline([log], [{ kind: 'item', item: { ...item, text: '最终输出' }, final: true }]);
  assert.equal(final.outputChunks, undefined);
  assert.equal(final.text, '最终输出');
});

test('file references round-trip with Windows and Linux paths and survive an echo without a client ID', () => {
  const files = [
    { kind: 'file', path: '/tmp/核对 "A"\\结果.txt', name: '核对 "A"\\结果.txt' },
    { kind: 'file', path: 'C:\\工作区\\结果.txt', name: '结果.txt' },
  ];
  const text = '检查文件。\n保留原文。';
  const attachments = attachmentArtifacts(files);
  const wire = fileReferenceText([{ kind: 'text', text }, ...files], true);
  assert.deepEqual(parseFileReferences(wire), { text, attachments });
  assert.deepEqual(parseFileReferences(fileReferenceText(files, true)), { text: '', attachments });
  assert.equal(fileReferencePreview(wire.slice(0, -5)), text);
  assert.equal(fileReferencePreview(fileReferenceText(files, true)), files[0].name);
  assert.throws(() => fileReferenceText(files, false), /本机 Agent/);
  const ordinaryText = text + '\n\n' + wire.slice(wire.indexOf('Span 附件路径')).replaceAll('/tmp/', '') + '\n其他文字';
  assert.deepEqual(parseFileReferences(ordinaryText), { text: ordinaryText });

  const first = { kind: 'user', text: '', key: 'first', optimistic: true, attachments: attachments.slice(0, 1) };
  const second = { ...first, key: 'second', attachments: attachments.slice(1) };
  const echo = { kind: 'user', text: '', id: 'echo', turnId: 'turn', attachments: second.attachments };
  const rows = applyTimeline([first, second], [{ kind: 'item', item: echo, final: true }]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0], first);
  assert.equal(rows[1].key, second.key);
  assert.equal(rows[1].id, echo.id);
});

test('timeline layout survives streaming text and changes when rows become visible', () => {
  const item = { kind: 'message', turnId: 'turn', id: 'reply', text: '' };
  const initial = applyTimeline([], [{ kind: 'item', item, final: false }]);
  const delta = text => ({ kind: 'delta', delta: { ...item, text } });
  const empty = timelineLayout(initial);
  assert.equal(empty.estimateSize(0), 0);

  const visible = applyTimeline(initial, [delta('First')]);
  const layout = timelineLayout(visible);
  assert.equal(layout.getItemKey(0), empty.getItemKey(0));
  assert.equal(layout.estimateSize(0), 92);
  assert.notEqual(layout, empty);
  const continued = applyTimeline(visible, [delta(' and second')]);
  assert.equal(timelineLayout(continued), layout);
  const command = { kind: 'item', final: true, item: { kind: 'command', turnId: 'turn', id: 'tool' } };
  const mixed = applyTimeline(continued, [command, delta(' after tool')]);
  assert.notEqual(timelineLayout(mixed), layout);
  assert.equal(timelineLayout(mixed).getItemKey(2), mixed[2].key);
  assert.equal(timelineLayout(mixed).estimateSize(1), 34);
});

test('completed activity groups preserve chronology and exclude failure, prose and other scopes', () => {
  const command = (id, fields = {}) => ({ kind: 'command', id, turnId: 'turn', status: 'completed', exitCode: 0, ...fields });
  const prose = { kind: 'message', id: 'prose', turnId: 'turn', text: 'Between activities' };
  const rows = applyTimeline([], [
    command('a'), command('b'), command('c', {kind: 'tool'}), command('d'),
    command('failure', { exitCode: 1 }), prose,
    command('e'), command('f'), command('g'), command('h', { depth: 1 }),
    command('i', { actor: { id: 'agent' } }), command('j', { turnId: 'next' }),
  ].map(item => ({ kind: 'item', final: true, item })));
  const layout = timelineLayout(rows);
  const empty = new Set();
  const collapsed = groupedTimelineLayout(layout, undefined, empty, empty);
  const group = collapsed.rowAt(rows, 0);
  assert.equal(group.kind, 'activity-group');
  assert.equal(group.commands, 3);
  assert.equal(collapsed.count, rows.length - 3);
  assert.equal(collapsed.rowAt(rows, 1).id, 'failure');
  assert.equal(collapsed.rowAt(rows, 2), rows[5]);
  assert.equal(groupedTimelineLayout(layout, 'turn', empty, empty), layout);
  assert.equal(groupedTimelineLayout(layout, undefined, new Set(['turn']), empty), layout);

  const expanded = groupedTimelineLayout(layout, undefined, empty, new Set([group.key]));
  assert.equal(expanded.count, rows.length + 1);
  assert.deepEqual(Array.from({ length: rows.length }, (_, index) => expanded.rowAt(rows, index + 1)), rows);
  assert.deepEqual([...expanded.nested], [1, 2, 3, 4]);

  const update = item => applyTimeline(rows, [{ kind: 'item', item, final: true }]);
  assert.equal(timelineLayout(update({ ...prose, text: 'Changed prose' })), layout);
  assert.notEqual(timelineLayout(update(command('d', { exitCode: 1 }))), layout);
});

test('live commands reuse earlier group mappings until a history change affects them', () => {
  const command = (turnId, id, exitCode = 0) => ({ kind: 'item', final: true,
    item: { kind: 'command', turnId, id, status: 'completed', exitCode } });
  const saved = applyTimeline([], [
    ...['a', 'b', 'c', 'd'].map(id => command('history', id)),
    { kind: 'item', final: true, item: { kind: 'message', turnId: 'history', id: 'reply', text: 'Filed.' } },
  ]);
  const initial = timelineLayout(saved);
  const open = new Set([initial.groups[0].key]);
  const plain = new Set();
  const opened = groupedTimelineLayout(initial, 'live', plain, open);
  const live = applyTimeline(saved, ['a', 'b', 'c', 'd'].map(id => command('live', id)));
  const next = timelineLayout(live);
  const view = groupedTimelineLayout(next, 'live', plain, open);
  assert.equal(next.groups.length, 2);
  assert.equal(next.groups[0], initial.groups[0]);
  assert.equal(view.nested, opened.nested);
  assert.deepEqual(Array.from({ length: live.length }, (_, i) => view.rowAt(live, i + 1)), live);
  assert.deepEqual(Array.from({ length: live.length }, (_, i) => view.getItemKey(i + 1)), live.map(row => row.key));

  const completed = groupedTimelineLayout(next, undefined, plain, open);
  assert.equal(completed.rowAt(live, 6), next.groups[1]);
  assert.equal(completed.count, 7);
  const revised = applyTimeline(live, [command('history', 'c', 1)]);
  const revisedLayout = timelineLayout(revised);
  assert.deepEqual(revisedLayout.groups.map(group => group.turnId), ['live']);
  assert.equal(groupedTimelineLayout(revisedLayout, 'live', plain, open), revisedLayout);
  assert.equal(opened.rowAt(saved, 0), initial.groups[0]);
});

test('delegation metadata survives sparse events and unrelated timeline updates reuse the roster', () => {
  const turnId = 'turn';
  const member = { id: 'child', name: 'Reviewer', role: 'review', status: 'running', session: { ...session('codex', remote), id: 'child' } };
  const event = (id, kind, fields) => ({ kind: 'item', final: true, item: { id, turnId, kind, ...fields } });
  const started = applyTimeline([], [event('spawn', 'delegation', { members: [member] })]);
  const recorded = delegatedMembers(started);
  const streaming = applyTimeline(started, [event('answer', 'message', { text: 'Work in progress.' })]);
  assert.equal(delegatedMembers(streaming), recorded);
  const finished = applyTimeline(streaming, [event('wait', 'delegation', {
    members: [{ id: 'child', role: undefined, status: 'completed', detail: 'Checked.' }],
  })]);
  assert.deepEqual(delegatedMembers(finished).get('child'), { ...member, status: 'completed', detail: 'Checked.' });
  assert.equal(recorded.get('child').status, 'running');
});

test('roster refresh applies the new snapshot and preserves only changes made during the request', () => {
  const before = [
    { id: 'idle', name: 'Previously known', status: 'running' },
    { id: 'updated', name: 'Reviewer', status: 'pending', model: 'old-model' },
    { id: 'evicted', name: 'Gone' },
  ];
  const updates = new Map();
  const partial = { id: 'updated', detail: 'Still checking.' };
  const finished = { id: 'updated', status: 'completed' };
  recordRosterUpdate(updates, partial.id, partial);
  recordRosterUpdate(updates, finished.id, finished);
  const previous = updateRoster(updateRoster(before, partial.id, partial), finished.id, finished);
  assert.deepEqual(reconcileRoster(previous, [
    { id: 'idle', status: 'cancelled' },
    { id: 'updated', model: 'new-model', status: 'running' },
    { id: 'new', status: 'pending' },
  ], updates), [
    { id: 'idle', name: 'Previously known', status: 'cancelled' },
    { id: 'updated', name: 'Reviewer', status: 'completed', model: 'new-model', detail: 'Still checking.' },
    { id: 'new', status: 'pending' },
  ]);
});

test('a delayed snapshot cannot recreate a closed team or bring back its old tasks', () => {
  const snapshot = [
    { id: 'closed', name: 'Closed', members: [], tasks: [{ id: 'old' }] },
    { id: 'restarted', name: 'Old team', members: [], tasks: [{ id: 'old-task' }] },
  ];
  const updates = new Map();
  recordRosterUpdate(updates, 'closed', null);
  recordRosterUpdate(updates, 'restarted', null);
  const replacement = { id: 'restarted', name: 'New team', members: [] };
  recordRosterUpdate(updates, replacement.id, replacement);
  assert.deepEqual(reconcileRoster([replacement], snapshot, updates), [replacement]);
});

test('session identities are scoped by backend and host, and the factory rejects unknown backends', async () => {
  const refs = [session('codex', local), session('codex', remote), session('clue', remote)];
  assert.equal(new Set(refs.map(sessionKey)).size, refs.length);
  assert.deepEqual(agentBackends.map(item => item.id), ['codex', 'clue', 'pi']);
  await assert.rejects(createAgent('missing', { location: local }), /不支持/);
});

test('workspace recovery keeps session IDs scoped to their Agent and location', () => {
  let saved = '{broken';
  let writes = 0;
  globalThis.window = { localStorage: {
    getItem: () => saved,
    setItem(_key, value) { saved = value; writes++; },
  } };
  const home = { cwd: 'C:\\Users\\Test', demo: false, terminalRenderer: 'dom' };
  const codex = { ...home, backend: 'codex', ssh: '' };
  const pi = { ...codex, backend: 'pi', cwd: 'C:\\actual-workspace' };
  const remotePi = { ...pi, ssh: 'dev' };
  try {
    assert.deepEqual(startupWorkspace(home), codex);
    rememberWorkspace(codex, 'codex-local');
    rememberWorkspace(pi, 'pi-local');
    rememberWorkspace(remotePi, 'pi-remote');
    rememberWorkspace(remotePi);
    assert.equal(writes, 3);
    assert.deepEqual(startupWorkspace(home), remotePi);
    assert.equal(savedSession(codex), 'codex-local');
    assert.equal(savedSession(pi), 'pi-local');
    assert.equal(savedSession({ ...pi, cwd: 'D:\\other-workspace' }), undefined);
    assert.equal(savedSession({ ...remotePi, ssh: 'other' }), undefined);
    rememberWorkspace(remotePi, null);
    assert.equal(savedSession(remotePi), undefined);
    assert.equal(savedSession(pi), 'pi-local');
    assert.deepEqual(startupWorkspace({ ...home, demo: true }), { ...codex, demo: true });
    rememberWorkspace({ ...codex, demo: true }, 'fixture');
    assert.equal(writes, 4);
    rememberWorkspace({ ...pi, ssh: '-Options' }, 'bad');
    assert.equal(writes, 4);
  } finally {
    delete globalThis.window;
  }
});

test('a cancelled optional adapter load never registers transport listeners', async () => {
  const controller = new AbortController();
  const loading = createAgent('pi', { location: local, generation: 1, onEvent() {} }, controller.signal);
  controller.abort();
  assert.equal(await loading, undefined);
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
    'thread/fork': { thread: { id: 'copy', cwd: '/work' } },
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

  const agent = await createAgent('codex', { generation: 9, cwd: '/work', location: remote, onEvent: event => events.push(event) });
  try {
    await agent.open();
    assert.deepEqual(events.shift(), { kind: 'connection', route: 'shared' });
    assert.deepEqual(requests[0], ['agent.start', { backend: 'codex', generation: 9, cwd: '/work', ssh: 'dev' }]);
    const list = await agent.sessions.list({});
    const ref = list.items[0].ref;
    assert.deepEqual(ref, session('codex', remote));
    assert.equal(list.cursor, 'opaque');
    const filtered = await agent.sessions.search({ query: 'Review', archived: true, cursor: 'filtered-page' });
    assert.deepEqual(requests.at(-1)[1].packet.params, {
      limit: 40, archived: true, cursor: 'filtered-page', searchTerm: 'Review',
    });
    assert.equal(filtered.cursor, 'opaque');
    assert.equal(filtered.items[0].archived, true);
    const opened = await agent.sessions.resume(ref, 20);
    assert.equal(opened.history.cursor, 'old');
    const copy = await agent.sessions.fork(ref);
    assert.equal(requests.at(-1)[1].packet.method, 'thread/fork');
    assert.equal(requests.at(-1)[1].packet.params.threadId, ref.id);
    assert.equal(requests.at(-1)[1].packet.params.excludeTurns, true);
    assert.deepEqual(copy.session.ref, { ...ref, id: 'copy' });
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
    publish('agent', { id: 57, method: 'item/commandExecution/requestApproval', params: {
      threadId: 'thread', turnId: 'next', itemId: 'network', command: 'shell preview', cwd: '/work',
      networkApprovalContext: { host: 'example.test', protocol: 'https' }, availableDecisions: ['decline'],
    } });
    const approval = events.at(-1).request;
    assert.deepEqual(approval.operation, { kind: 'network', target: 'example.test', protocol: 'https', cwd: '/work' });
    assert.deepEqual(approval.choices.map(choice => choice.id), ['decline']);
    publish('agent', { method: 'turn/completed', params: { threadId: 'thread', turn: { id: 't', status: 'completed', items: [] } } });
    assert.equal(events.at(-1).kind, 'run');
    const sent = requests.length;
    await Promise.all([agent.interactions.respond('57', { choice: 'decline' }), agent.interactions.respond('57', { choice: 'decline' })]);
    assert.equal(requests.length - sent, 1);
    assert.deepEqual(requests.at(-1)[1].packet, { id: 57, result: { decision: 'decline' } });

    const start = events.length;
    const tool = { type: 'mcpToolCall', id: 'inspect', server: 'workspace', tool: 'read_file' };
    const path = 'D:\\Work\\检查记录.txt';
    publish('agent', { method: 'item/started', params: { ...scope, item: {
      ...tool, status: 'inProgress', arguments: { path, other: 'unrelated argument' },
    } } });
    publish('agent', { method: 'item/mcpToolCall/progress', params: { ...scope, itemId: 'inspect', message: 'Reading' } });
    publish('agent', { method: 'item/completed', params: { ...scope, item: {
      ...tool, status: 'failed', error: { message: 'Missing file' },
    } } });
    const [card] = applyTimeline([], events.slice(start));
    assert.deepEqual(card.target, { kind: 'path', path });
    assert.equal(card.name, 'read_file');
    assert.equal(card.source, 'workspace');
    assert.equal(card.status, 'failed');
    assert.ok(!JSON.stringify(card).includes('unrelated argument'));
  } finally {
    agent.close();
  }
  assert.equal(handlers.size, 0);

  const clue = await createAgent('clue', { generation: 10, cwd: '/work', location: local, onEvent() {} });
  assert.equal(typeof clue.sessions.resume, 'function');
  assert.equal(clue.sessions.search, undefined);
  assert.equal(clue.sessions.fork, undefined);
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
  const agent = await createAgent('codex', { generation: 1, cwd: '/work', location: local, onEvent() {} });
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
    item('reasoning', 'r', { sections: ['First', 'Second.'] }),
    delta('message', 'm', 'Finish.'),
    item('message', 'm', { text: 'Start. Finish.' }),
    delta('message', 'm', 'late delta'),
  ]);
  assert.deepEqual(rows.map(row => row.kind), ['reasoning', 'message', 'command', 'reasoning', 'message']);
  assert.deepEqual(rows[0].sections, ['First', 'Second.']);
  assert.deepEqual(rows[3].sections, ['Next\nChecking alignment']);
  assert.equal(turnReasoning(rows, 't'), rows[3]);
  assert.equal(rows[3].preview, 'Checking alignment');
  assert.equal(rows[1].text + rows[4].text, 'Start. Finish.');
  const layout = timelineLayout(rows);
  assert.deepEqual([0, 2, 3].map(index => layout.estimateSize(index, 't')), [0, 34, 0]);
  const updated = applyTimeline(rows, [delta('reasoning', 'second', '.')]);
  assert.equal(timelineLayout(updated), layout);
  assert.equal(turnReasoning(updated, 't').preview, 'Checking alignment.');
  assert.equal(visibleRow({ kind: 'reasoning' }), false);
  const history = historyRows([
    { id: 'earlier', run: { status: 'completed' }, rows: [{ turnId: 'earlier', id: 'm', kind: 'message', text: 'History' }] },
    { id: 't', run: { status: 'completed' }, rows: [
      { turnId: 't', id: 'r', kind: 'reasoning', sections: ['First', 'Second.'] },
      { turnId: 't', id: 'm', kind: 'message', text: 'Start. Finish.' },
      { turnId: 't', id: 'c', kind: 'command', command: 'git status' },
      { turnId: 't', id: 'second', kind: 'reasoning', sections: ['Next\nChecking alignment', 'Saved addendum'] },
    ] },
  ]);
  const reopened = mergeHistory(rows, history);
  assert.deepEqual(history.map(row => row.kind), ['message', 'reasoning', 'message', 'command', 'reasoning']);
  assert.deepEqual(reopened.map(row => row.kind), ['message', 'reasoning', 'message', 'command', 'reasoning', 'message']);
  assert.equal(reopened[1].key, rows[0].key);
  assert.deepEqual(reopened[4].sections, ['Next\nChecking alignment', 'Saved addendum']);
  assert.equal(turnReasoning(reopened, 't'), reopened[4]);
});

test('reasoning received during an open Markdown reply does not break its formatting', () => {
  const delta = (kind, id, text) => ({ kind: 'delta', delta: { kind, id, text, turnId: 'turn' } });
  const rows = applyTimeline([], [
    delta('message', 'reply', '**First'),
    delta('reasoning', 'summary', 'Check the wording'),
    delta('message', 'reply', ' and last**'),
  ]);
  assert.deepEqual(rows.map(row => row.kind), ['message', 'reasoning']);
  assert.equal(rows[0].text, '**First and last**');
});

test('streamed reasoning keeps a bounded preview and preserves the full summary', () => {
  const delta = (section, text) => ({ kind: 'delta', delta: { kind: 'reasoning', id: 'r', turnId: 't', section, text } });
  const summary = '# 验证路径\r\n' + '内容。'.repeat(100_000) + '最终检查';
  const whitespace = ' '.repeat(300) + '\r\n';
  const rows = applyTimeline([], [delta(0, summary), delta(1, '## 覆核'), delta(0, whitespace)]);
  assert.ok(turnReasoning(rows, 't').preview.endsWith('最终检查'));

  const unicodeBoundary = '😀' + '新'.repeat(239);
  const updated = applyTimeline(rows, [delta(0, '- '), delta(0, unicodeBoundary)]);
  const preview = turnReasoning(updated, 't');
  assert.equal(preview.preview, '新'.repeat(239));
  assert.deepEqual(preview.sections, [summary + whitespace + '- ' + unicodeBoundary, '## 覆核']);

  const independent = applyTimeline(rows, [delta(1, '原文\n- 最新进度')]);
  assert.equal(turnReasoning(independent, 't').preview, '最新进度');
  assert.equal(turnReasoning(rows, 't').sections[0], summary + whitespace);
  const completed = applyTimeline(updated, [{ kind: 'item', final: true, item: {
    kind: 'reasoning', id: 'r', turnId: 't', sections: ['', '## 最终摘要'],
  } }]);
  assert.equal(turnReasoning(completed, 't').preview, '最终摘要');
  assert.equal(turnReasoning(completed, 't').sections[0], preview.sections[0]);
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

test('Pi reconnects to its stored branch and keeps queue, tool and dialog events on the active host', async t => {
  const events = [];
  const sent = [];
  const source = 38;
  let receive;
  const emit = data => receive({ event: 'agent', generation: source, data });
  const message = (role, content, rest = {}) => ({ role, content, ...rest });
  const text = value => [{ type: 'text', text: value }];
  const entry = (id, parentId, role, content) =>
    ({ id, parentId, type: 'message', message: message(role, content) });
  const respond = (packet, data) => emit({ id: packet.id, type: 'response', success: true, data });
  let branch = false;
  let rejectPrompt = false;
  let switching;
  globalThis.window = { span: {
    onEvent(callback) { receive = callback; return () => { receive = null; }; },
    async request(method, { packet } = {}) {
      if (method === 'agent.start') {
        receive({ event: 'agent-route', generation: source, data: 'stdio' });
        return;
      }
      if (method !== 'agent.send') return;
      sent.push(packet);
      if (packet.type === 'get_state') {
        respond(packet, { sessionId: branch ? 'saved' : 'fresh', sessionFile: '/remote/work/session.jsonl' });
      } else if (packet.type === 'span_list_sessions') {
        respond(packet, { items: [{ id: 'saved', path: '/remote/work/saved.jsonl', cwd: '/remote/work' }], cursor: null });
      } else if (packet.type === 'switch_session') {
        switching = packet;
        emit({ type: 'extension_ui_request', method: 'confirm', id: 'switch', title: '打开已保存会话' });
      } else if (packet.type === 'extension_ui_response') {
        assert.equal(packet.id, 'switch');
        assert.equal(packet.confirmed, true);
        branch = true;
        respond(switching, { cancelled: false });
      } else if (packet.type === 'get_entries') {
        respond(packet, { leafId: 'answer', entries: [
          entry('one', null, 'user', 'First'),
          entry('two', 'one', 'assistant', text('Stored response')),
          entry('discarded', 'one', 'assistant', text('Abandoned branch')),
          entry('question', 'two', 'user', 'Second'),
          entry('answer', 'question', 'assistant', text('Current branch')),
        ] });
      } else if (packet.type === 'prompt' && rejectPrompt) {
        emit({ id: packet.id, type: 'response', success: false, error: 'Pi refused the prompt' });
      } else if (packet.type === 'prompt') {
        emit({ type: 'agent_start' });
        emit({ type: 'message_end', message: message('user', packet.message) });
        respond(packet, { disposition: 'started' });
      } else if (packet.type === 'follow_up' || packet.type === 'steer') {
        respond(packet, { disposition: 'queued' });
      } else if (packet.type === 'clear_queue') {
        respond(packet, { steering: [], followUp: ['queued'] });
      } else if (packet.type === 'abort') {
        emit({ type: 'agent_settled', aborted: true });
        respond(packet);
      } else if (packet.type === 'get_session_stats') {
        respond(packet, { tokens: { total: 17 }, contextUsage: { tokens: 10, contextWindow: 100 } });
      } else {
        respond(packet, { commands: [] });
      }
    },
  } };
  const agent = await createAgent('pi', { location: remote, cwd: '/local/work', generation: source, onEvent: event => events.push(event) });
  t.after(() => { agent.close(); delete globalThis.window; });
  await agent.open();
  assert.equal(events[0].route, 'stdio');
  const catalog = await agent.sessions.list({});
  const ref = catalog.items[0].ref;
  assert.equal(sessionKey(ref), sessionKey({ backend: 'pi', location: remote, id: 'saved' }));
  const loading = agent.sessions.resume(ref, 1);
  await Promise.resolve();
  assert.equal(events.at(-1).kind, 'connectionInteraction');
  await agent.interactions.respond('switch', { choice: 'yes' });
  const opened = await loading;
  assert.equal(opened.history.items[0].rows.at(-1).text, 'Current branch');
  const older = await agent.sessions.history(ref, { cursor: opened.history.cursor, limit: 1 });
  assert.equal(older.items[0].rows.at(-1).text, 'Stored response');
  assert.equal(older.cursor, null);

  const input = value => [{ kind: 'text', text: value }];
  const run = await agent.turns.start(ref, input('created'), {}, 'sent');
  assert.equal(run.id, 'turn:2');
  await agent.turns.followUp(ref, input('queued'), 'queued');
  await agent.turns.steer(ref, run.id, input('steered'), 'steered');
  emit({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: 'provider summary' } });
  emit({ type: 'tool_execution_update', toolName: 'bash', toolCallId: 'tool', args: { command: 'echo span' },
    partialResult: { content: text('output') } });
  assert.equal(events.at(-1).item.status, 'running');
  emit({ type: 'tool_execution_end', toolName: 'bash', toolCallId: 'tool', args: { command: 'echo span' },
    result: { content: text('output'), details: { exitCode: 0 } }, isError: false });
  const path = 'notes/项目记录.txt';
  emit({ type: 'message_end', message: message('assistant', [{ type: 'toolCall', id: 'read-file',
    name: 'read', arguments: { path } }]) });
  emit({ type: 'tool_execution_end', toolName: 'read', toolCallId: 'read-file',
    result: { content: text('Missing file') }, isError: true });
  assert.deepEqual(events.at(-1).item.target, { kind: 'path', path });
  assert.equal(events.at(-1).item.status, 'failed');
  emit({ type: 'agent_end', willRetry: true });
  assert.equal(events.at(-1).kind, 'item');
  emit({ type: 'message_end', message: message('user', 'steered') });
  await agent.turns.stop(ref, run.id);
  assert.ok(sent.some(packet => packet.type === 'clear_queue'));
  await Promise.resolve();
  assert.ok(events.some(event => event.kind === 'delta' && event.delta.text === 'provider summary'));
  assert.ok(events.some(event => event.clientId === 'steered' && event.state === 'delivered'));
  assert.ok(events.some(event => event.clientId === 'queued' && event.state === 'cancelled'));
  assert.ok(events.some(event => event.run?.status === 'cancelled'));
  rejectPrompt = true;
  await assert.rejects(agent.turns.start(ref, input('rejected'), {}, 'retry'), /refused/);
  assert.equal(events.findLast(event => event.kind === 'run').run.status, 'failed');

  assert.equal(events.filter(event => event.session).every(event => sessionKey(event.session) === sessionKey(ref)), true);
  assert.ok(sent.filter(packet => packet.type !== 'extension_ui_response').every(packet => typeof packet.id === 'string'));
});
