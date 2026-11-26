import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { runInNewContext } from 'node:vm';
import { acpReplay } from '../ui/acp-items.js';
import { createAcpTaskTraces } from '../ui/acp-task-traces.js';
import acpHttp from '../desktop/acp-http.cjs';
import { agentBackends, createAgent, sessionKey } from '../ui/agent.js';
import { reconcileRoster, recordRosterUpdate, updateRoster } from '../ui/delegation.js';
import { attachmentArtifacts, fileReferencePreview, fileReferenceText, parseFileReferences } from '../ui/file-references.js';
import { watchPiTeamTranscript } from '../ui/pi-teams.js';
import { rememberWorkspace, savedSession, startupWorkspace } from '../ui/recent-workspaces.js';
import { indexOutput, indexText, LINES_PER_PAGE, readTextPage } from '../ui/text-pages.js';
import { activityFailurePreview, applyTimeline, delegatedMembers, groupedTimelineLayout, hasReasoningSection, historyRows, mergeHistory, sameTranscriptRows, timelineLayout, turnReasoning, turnReasoningRows, visibleRow } from '../ui/timeline.js';
import { workspacePathKey } from '../ui/workspace-path.js';

const local = { kind: 'local' };
const remote = { kind: 'ssh', host: 'dev' };
const session = (backend, location) => ({ backend, location, id: 'thread' });

test('desktop event subscriptions cross into the workbench only for their kind and generation', async () => {
  const preload = await readFile(new URL('../desktop/preload.cjs', import.meta.url), 'utf8');
  let receive, span;
  runInNewContext(preload, {
    require(name) {
      assert.equal(name, 'electron');
      return {
        contextBridge: { exposeInMainWorld: (key, api) => { if (key === 'span') span = api; } },
        ipcRenderer: { on: (channel, listener) => { if (channel === 'span:event') receive = listener; } },
      };
    },
  });
  const agent = [], terminal = [], errors = [], all = [];
  const disconnect = span.onEvent(packet => agent.push(packet), { events: ['agent', 'agent-closed'], generation: 7 });
  span.onEvent(packet => terminal.push(packet), { events: ['terminal', 'terminal-closed'], generation: 8 });
  span.onEvent(packet => errors.push(packet), { events: ['core-error'] });
  span.onEvent(packet => all.push(packet));
  const packets = [
    { event: 'agent', generation: 7, data: { result: ['history'] } },
    { event: 'terminal', generation: 8, data: 'b3V0cHV0' },
    { event: 'agent', generation: 3, data: { result: ['old history'] } },
    { event: 'terminal', generation: 5, data: 'b2xk' },
    { event: 'core-error', data: 'Service error' },
    { event: 'agent-closed', generation: 7 },
    { event: 'terminal-closed', generation: 8 },
  ];
  for (const packet of packets) receive(null, packet);
  disconnect();
  receive(null, packets[0]);
  assert.deepEqual(agent, [packets[0], packets[5]]);
  assert.deepEqual(terminal, [packets[1], packets[6]]);
  assert.deepEqual(errors, [packets[4]]);
  assert.deepEqual(all, [...packets, packets[0]]);
});

test('workspace grouping recognizes Windows path spelling while retaining case-sensitive directory names', () => {
  assert.equal(workspacePathKey('D:\\Span\\Case\\'), workspacePathKey('d:/Span/Case'));
  assert.equal(workspacePathKey('D:\\'), workspacePathKey('d:/'));
  assert.equal(workspacePathKey('\\\\host\\share\\Case'), workspacePathKey('//host/share/Case'));
  assert.notEqual(workspacePathKey('d:/Span/Case'), workspacePathKey('d:/Span/case'));
  assert.notEqual(workspacePathKey('d:/Span/Case'), workspacePathKey('e:/Span/Case'));
  assert.notEqual(workspacePathKey('/mnt/work\\tree'), workspacePathKey('/mnt/work/tree'));
});

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

test('log and patch columns account for tab stops and wide characters', () => {
  for (const [line, columns] of [
    ['abcd\t', 8], ['é\t中😀', 8], ['𠀀\tabc', 7], ['\uD800a\uDC00\tZ', 9],
  ]) {
    const data = readTextPage(`a\r\n${line}\r\n`);
    assert.equal(data.columns, columns);
    assert.deepEqual(data.rows.map(row => row.text), ['a', line]);
  }
});

test('ACP history preserves user-visible content and turn boundaries while hiding assistant-only context', () => {
  const replay = acpReplay();
  const chunk = (sessionUpdate, messageId, text, audience) => replay.update({ sessionUpdate, messageId,
    content: { type: 'text', text, annotations: audience && { audience } } });
  chunk('user_message_chunk', 'user', 'A visible request.', ['user']);
  chunk('agent_message_chunk', 'reply', 'First response.');
  chunk('user_message_chunk', 'native-goal', 'Private instructions for the model.', ['assistant']);
  chunk('agent_thought_chunk', 'goal-reasoning', 'A visible summary.');
  chunk('agent_message_chunk', 'internal', 'Hidden response metadata.', ['assistant']);
  chunk('agent_message_chunk', 'goal-reply', 'The goal is complete.');
  const turns = replay.finish();
  assert.deepEqual(turns.map(turn => turn.rows.map(row => row.text ?? row.sections?.join('\n'))), [
    ['A visible request.', 'First response.'],
    ['A visible summary.', 'The goal is complete.'],
  ]);
});

test('Claude commands remove only the bridge’s console wrapper from saved output', () => {
  const raw = '  Check the archive\n```\nKeep the embedded backticks';
  const fenced = '```console\n' + raw + '\n```';
  const tool = { kind: 'execute', rawInput: { command: 'echo fixture' } };
  function read(options, result) {
    const replay = acpReplay(options);
    replay.update({ sessionUpdate: 'tool_call', toolCallId: 'shell', status: 'in_progress', ...tool });
    replay.update({ sessionUpdate: 'tool_call_update', toolCallId: 'shell', status: 'completed', ...result });
    return replay.finish()[0].rows[0].text;
  }
  const content = [{ type: 'content', content: { type: 'text', text: fenced } }];
  assert.equal(read({ consoleFences: true }, { content }), raw);
  assert.equal(read({ consoleFences: true }, { rawOutput: { output: fenced } }), fenced);
  assert.equal(read(undefined, { content }), fenced);
});

test('native Task records use structured child IDs, prepend older pages and ignore late results', async () => {
  const root = { id: 'ses_root', entry: { cwd: '/workspace' } };
  const ref = id => ({ id, backend: 'opencode', location: remote });
  const pages = [];
  const traces = createAcpTaskTraces(root, { ref, readHistory: (...args) => new Promise(resolve => pages.push({ args, resolve })) });
  const tool = { kind: 'think', toolCallId: 'task-call', rawInput: { description: 'Verify the marker', subagent_type: 'explore', prompt: 'Verify' } };
  assert.equal(traces.project(tool, 'running').members[0].attachedTranscript, undefined);
  const finished = parentSessionId => ({ ...tool, rawOutput: { metadata: { sessionId: 'ses_child', parentSessionId } } });
  assert.equal(traces.project(finished('ses_unrelated'), 'completed', 'ses_child').members[0].attachedTranscript, undefined);
  const member = traces.project(finished(root.id), 'completed').members[0];
  assert.deepEqual(member.parent, ref(root.id));
  assert.deepEqual(member.session, ref('ses_child'));
  assert.equal(member.attachedTranscript, true);
  assert.equal(member.status, 'completed');
  const views = [];
  traces.watch(member.id, view => views.push(view));
  const message = (role, id, parts, parentID) => ({ info: { role, id, parentID }, parts });
  const part = (type, id, text, synthetic) => ({ type, id, text, synthetic });
  assert.deepEqual(pages[0].args, ['ses_child', 'ses_root', '/workspace', undefined]);
  pages[0].resolve({ cursor: 'older', items: [message('assistant', 'response', [
    part('reasoning', 'summary', 'Check provenance'),
    { type: 'tool', id: 'search', tool: 'glob', state: { status: 'completed',
      title: 'Users\\operator\\Workspace', input: { pattern: '**/marker.txt', path: 'C:\\Users\\operator\\Workspace' } } },
    part('text', 'result', 'Verified')], 'prompt')] });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(views.at(-1).rows.map(row => row.kind), ['reasoning', 'tool', 'message']);
  const search = views.at(-1).rows[1];
  assert.equal(search.name, '搜索文件');
  assert.equal(search.query, '**/marker.txt');
  assert.deepEqual(search.target, { kind: 'path', path: 'C:\\Users\\operator\\Workspace' });
  const saved = views.at(-1).rows.at(-1);
  views.at(-1).loadOlder();
  views.at(-1).loadOlder();
  assert.equal(pages.length, 2);
  assert.deepEqual(pages[1].args, ['ses_child', 'ses_root', '/workspace', 'older']);
  pages[1].resolve({ cursor: 'more', items: [message('user', 'prompt', [
    part('text', 'private', 'Synthetic context', true), part('text', 'request', 'Check the marker')])] });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(views.at(-1).rows[0].text, 'Check the marker');
  assert.equal(views.at(-1).rows[0].turnId, saved.turnId);
  assert.equal(views.at(-1).rows.at(-1), saved);
  views.at(-1).loadOlder();
  traces.close();
  const received = views.length;
  pages[2].resolve({ cursor: null, items: [] });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(views.length, received);
  assert.throws(() => traces.watch(member.id, () => {}), /没有这个子代理/);
});

test('the native history reader verifies the parent and passes the opaque page cursor', async t => {
  const { acpChildHistory } = acpHttp;
  const urls = [];
  let parentID = 'ses_foreign';
  const fetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = fetch; });
  globalThis.fetch = async (url, options) => {
    urls.push(url);
    assert.equal(options.redirect, 'error');
    assert.equal(url.hostname, '127.0.0.1');
    assert.equal(options.headers.Authorization, 'Basic ' + Buffer.from('span:fixture').toString('base64'));
    if (url.pathname.endsWith('/message')) return Response.json([], { headers: { 'X-Next-Cursor': 'opaque' } });
    return Response.json({ parentID });
  };
  const connection = { localPort: 49153, password: 'fixture', signal: new AbortController().signal };
  const params = { sessionId: 'ses_child', parentId: 'ses_parent', cwd: '/the workspace', cursor: 'A+/' };
  await assert.rejects(acpChildHistory(connection, params), /不属于/);
  assert.equal(urls.length, 1);
  parentID = params.parentId;
  assert.deepEqual(await acpChildHistory(connection, params), { items: [], cursor: 'opaque' });
  assert.equal(urls[2].pathname, '/session/ses_child/message');
  assert.equal(urls[2].searchParams.get('directory'), params.cwd);
  assert.equal(urls[2].searchParams.get('before'), params.cursor);
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

  const completion = { ...item, status: 'completed', text: undefined };
  const [completed] = applyTimeline([log], [{ kind: 'item', item: completion, final: true }]);
  assert.equal(completed.outputChunks, undefined);
  assert.equal(completed.text, log.text);
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

test('appended reasoning uses the loaded history metrics and preserves the previous layout', () => {
  const history = { kind: 'message', id: 'saved', turnId: 'history', text: 'Earlier answer.' };
  const summary = { kind: 'reasoning', id: 'summary', turnId: 'live', sections: ['Checking…'] };
  const rows = applyTimeline([], [{ kind: 'item', item: history, final: true }]);
  const historyKey = rows[0].key;
  let keyReads = 0;
  Object.defineProperty(rows[0], 'key', { get() { keyReads++; return historyKey; } });
  const previous = timelineLayout(rows);
  keyReads = 0;

  const current = applyTimeline(rows, [{ kind: 'item', item: summary, final: false }]);
  const layout = timelineLayout(current);
  assert.equal(keyReads, 0);
  assert.equal(previous.count, 1);
  assert.equal(previous.getItemKey(1), undefined);
  assert.equal(layout.count, 2);
  assert.equal(layout.getItemKey(0), historyKey);
  assert.equal(layout.getItemKey(1), current[1].key);
  assert.equal(layout.estimateSize(0, 'live'), 92);
  assert.equal(layout.estimateSize(1), 34);
  assert.equal(layout.estimateSize(1, 'live'), 0);
});

test('only finished failures with short plain-text output add a diagnostic line', () => {
  const item = { id: 'check', turnId: 'turn', kind: 'command', text: '  检查文件失败。\r\n' };
  const running = applyTimeline([], [{ kind: 'item', item: { ...item, status: 'running' }, final: false }]);
  const layout = timelineLayout(running);
  assert.equal(activityFailurePreview(running[0]), undefined);
  assert.equal(layout.estimateSize(0), 34);
  const failed = applyTimeline(running, [{ kind: 'item', item: { ...item, status: 'completed', exitCode: 1 }, final: true }]);
  assert.equal(activityFailurePreview(failed[0]), '检查文件失败。');
  assert.equal(timelineLayout(failed).estimateSize(0), 52);
  for (const text of ['x'.repeat(241), '准备\n检查文件失败。', '\x1b[31mError']) {
    assert.equal(activityFailurePreview({ ...failed[0], text }), undefined);
  }
  const tool = { ...failed[0], kind: 'tool', status: 'failed' };
  assert.equal(activityFailurePreview({ ...tool, errorMessage: '\n文件无法读取。\r\n检查工作目录。' }), '文件无法读取。');
  for (const errorMessage of ['x'.repeat(241) + '\n剩余内容', '\x1b[31mError\n剩余内容']) {
    assert.equal(activityFailurePreview({ ...tool, errorMessage }), undefined);
  }
  assert.equal(activityFailurePreview({ ...failed[0], exitCode: 0 }), undefined);
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

test('finishing an already visible command reuses measurements until the live group folds', () => {
  const command = (turnId, id, final = true, exitCode = 0) => ({ kind: 'item', final,
    item: { kind: 'command', turnId, id, status: final ? 'completed' : 'running', exitCode, text: 'Checked.' } });
  const ids = ['a', 'b', 'c', 'd'];
  const running = applyTimeline([], [
    ...ids.map(id => command('history', id)),
    ...ids.map(id => command('live', id, false)),
  ]);
  const previous = timelineLayout(running);
  const open = new Set();
  const plain = new Set();
  const view = groupedTimelineLayout(previous, 'live', plain, open);
  const finished = applyTimeline(running, ids.map(id => command('live', id)));
  const updated = timelineLayout(finished);
  assert.equal(previous.groups.length, 1);
  assert.equal(updated.groups.length, 2);
  assert.equal(updated.getItemKey, previous.getItemKey);
  assert.equal(updated.estimateSize, previous.estimateSize);
  assert.equal(groupedTimelineLayout(updated, 'live', plain, open), view);
  assert.equal(view.rowAt(finished, 4).status, 'completed');

  const folded = groupedTimelineLayout(updated, undefined, plain, open);
  assert.equal(folded.count, 2);
  assert.equal(folded.rowAt(finished, 1), updated.groups[1]);
  const failed = applyTimeline(finished, [command('live', 'd', true, 1)]);
  const nextView = groupedTimelineLayout(timelineLayout(failed), 'live', plain, open);
  assert.notEqual(nextView, view);
  assert.equal(nextView.estimateSize(4), 52);
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
  assert.deepEqual(agentBackends.map(item => item.id), ['codex', 'clue', 'pi', 'opencode', 'kilo', 'claude']);
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
        const response = responses[packet.method];
        publish('agent', { id: packet.id, result: (typeof response === 'function' ? response(packet.params) : response) ?? {} });
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
    assert.deepEqual(requests.at(-1)[1].packet.params, {
      threadId: ref.id, origin: 'user', status: 'active', objective: 'Ship', tokenBudget: 100,
    });
    responses['thread/goal/set'] = {
      goal: { objective: 'Ship the fix', status: 'paused', tokenBudget: null, tokensUsed: 40 },
    };
    assert.deepEqual(await agent.goal.update(ref, { kind: 'edit', objective: 'Ship the fix', budget: null }), {
      objective: 'Ship the fix', status: 'paused', budget: undefined, seconds: undefined, tokens: 40,
    });
    assert.deepEqual(requests.at(-1)[1].packet.params, {
      threadId: ref.id, origin: 'user', objective: 'Ship the fix', tokenBudget: null,
    });
    await agent.goal.update(ref, { kind: 'resume' });
    assert.deepEqual(requests.at(-1)[1].packet.params, { threadId: ref.id, origin: 'user', status: 'active' });
    assert.equal((await agent.usage()).limits[0].used, 22);
    responses['mcpServerStatus/list'] = params => {
      assert.equal(params.threadId, ref.id);
      assert.equal(params.limit, 20);
      assert.equal(params.detail, 'toolsAndAuthOnly');
      if (params.cursor === 'tools-page') return { data: [{ name: 'empty', tools: {} }], nextCursor: null };
      assert.equal(params.cursor, undefined);
      return { data: [
        { name: 'docs', authStatus: 'oAuth', runtimeStatus: 'connected', tools: { write: {}, read: {} } },
        { name: 'issues', authStatus: 'notLoggedIn', tools: {}, toolsError: 'Expired login' },
      ], nextCursor: 'tools-page' };
    };
    const extensions = await agent.extensions.list('mcp', ref);
    assert.equal(extensions.cursor, 'tools-page');
    assert.deepEqual(extensions.items.map(({ id, authentication, connection, tools, toolError }) =>
      [id, authentication, connection, tools, toolError]), [
      ['docs', 'oauth', 'ready', ['read', 'write'], undefined],
      ['issues', 'required', undefined, undefined, 'Expired login'],
    ]);
    const emptyTools = await agent.extensions.list('mcp', ref, { cursor: extensions.cursor });
    assert.equal(emptyTools.cursor, null);
    assert.deepEqual(emptyTools.items[0].tools, []);
    responses['skills/list'] = params => {
      assert.deepEqual(params, { cwds: ['/remote workspace'] });
      const item = { name: 'review', path: '/remote workspace/skills/review/SKILL.md', scope: 'repo', enabled: false,
        description: 'Original description', interface: { displayName: '复核', shortDescription: '界面说明' } };
      return { data: [{ cwd: '/remote workspace', skills: [item, item], errors: [] }] };
    };
    assert.deepEqual(await agent.extensions.list('skill', ref, { cwd: '/remote workspace' }), { items: [{
      kind: 'skill', id: '/remote workspace/skills/review/SKILL.md', path: '/remote workspace/skills/review/SKILL.md',
      name: 'review', label: '复核', description: '界面说明', scope: 'workspace', enabled: false,
    }], cursor: null });
    const diffReplies = [
      { exitCode: 128, stdout: '', stderr: 'no commits yet' },
      { exitCode: 1, stdout: '', stderr: '' },
      { exitCode: 0, stdout: '+已暂存\n', stderr: '' },
      { exitCode: 0, stdout: 'docs/工作 记录.md\0docs/a\nb.md\0cut-off', stderr: '' },
    ];
    responses['command/exec'] = params => {
      assert.equal(params.cwd, '/remote workspace');
      assert.deepEqual(params.env, { GIT_OPTIONAL_LOCKS: '0' });
      assert.equal(params.outputBytesCap, 262144);
      return diffReplies.shift();
    };
    assert.deepEqual(await agent.repository.diff('/remote workspace'), {
      patch: '+已暂存\n', untracked: ['docs/工作 记录.md', 'docs/a\nb.md'], mayBeTruncated: true,
    });
    assert.deepEqual(requests.slice(-4).map(([, { packet }]) => packet.params.command.slice(6)), [
      ['diff', '--no-color', '--no-ext-diff', '--no-textconv', 'HEAD', '--'],
      ['rev-parse', '--verify', '--quiet', 'HEAD'],
      ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--cached', '--'],
      ['ls-files', '--others', '--exclude-standard', '-z'],
    ]);
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
      ...tool, status: 'completed', error: { message: 'Missing file\nCheck workspace access.', code: 'NOT_FOUND', retryable: false },
    } } });
    const [card] = applyTimeline([], events.slice(start));
    assert.deepEqual(card.target, { kind: 'path', path });
    assert.equal(card.name, 'read_file');
    assert.equal(card.source, 'workspace');
    assert.equal(card.status, 'failed');
    assert.equal(activityFailurePreview(card), 'Missing file');
    assert.equal(card.text, 'Missing file\nCheck workspace access.\n\n错误码 NOT_FOUND\n\n{\n  "retryable": false\n}');
    assert.ok(!JSON.stringify(card).includes('unrelated argument'));

    publish('agent', { method: 'item/completed', params: { ...scope, item: {
      type: 'collabAgentToolCall', id: 'spawn', tool: 'spawnAgent', senderThreadId: ref.id,
      receiverThreadIds: ['child'], status: 'completed', agentsStates: { child: { status: 'completed' } },
    } } });
    const [child] = events.at(-1).item.members;
    assert.deepEqual(child.session, { ...ref, id: 'child' });
    assert.equal(child.attachedTranscript, true);
    assert.equal(agent.delegation.resumeMemberSession, true);
    assert.throws(() => agent.delegation.watchTranscript(copy.session.ref, child.id, () => {}), /没有这个 Codex 子代理/);
    assert.throws(() => agent.delegation.watchTranscript({ ...ref, location: { kind: 'local' } }, child.id, () => {}), /没有这个 Codex 子代理/);
    responses['thread/turns/list'] = params => {
      assert.equal(params.threadId, child.id);
      assert.equal(params.limit, 20);
      assert.equal(params.sortDirection, 'desc');
      assert.equal(params.itemsView, 'full');
      const older = params.cursor === 'older-child';
      return { data: [{ id: older ? 'early' : 'late', status: 'completed', items: [
        { type: 'agentMessage', id: older ? 'first-result' : 'last-result', text: older ? 'First result' : 'Latest result' },
      ] }], nextCursor: 'older-child' };
    };
    const views = [];
    const reading = requests.length;
    const closeChild = agent.delegation.watchTranscript(ref, child.id, view => views.push(view));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(views[0].loading, true);
    assert.deepEqual(views.at(-1).rows.map(row => row.text), ['Latest result']);
    views.at(-1).loadOlder();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(views.at(-1).rows.map(row => row.text), ['First result', 'Latest result']);
    assert.equal(views.at(-1).cursor, null);
    assert.deepEqual(requests.slice(reading).map(([, { packet }]) => packet.method), ['thread/turns/list', 'thread/turns/list']);
    closeChild();
    const closed = [];
    agent.delegation.watchTranscript(ref, child.id, view => closed.push(view))();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(closed.length, 1);

    const mark = { type: 'enteredReviewMode', id: 'mark', review: 'current changes' };
    const prompt = { type: 'userMessage', id: 'prompt', content: [{ type: 'text', text: 'Review all changes' }] };
    const raw = { type: 'agentMessage', id: 'raw', text: '{"findings":[]}' };
    const fallback = { type: 'exitedReviewMode', id: 'exit', review: 'No response from reviewer' };
    const reply = { type: 'agentMessage', id: 'result', text: 'The review was interrupted.' };
    const root = { id: 'review', rootTurnId: 'review', status: 'interrupted', items: [reply] };
    const nested = { id: 'worker', rootTurnId: 'review', status: 'inProgress', items: [] };
    const reviewStart = events.length;
    const publishReview = (method, fields) => publish('agent', { method, params: { threadId: 'thread', ...fields } });
    responses['review/start'] = { turn: { id: 'review', status: 'inProgress' } };
    assert.equal((await agent.turns.review(ref, { kind: 'worktree' })).id, 'review');
    assert.deepEqual(requests.at(-1)[1].packet.params, {
      threadId: 'thread', target: { type: 'uncommittedChanges' }, delivery: 'inline',
    });
    const publishItem = (item, turnId = 'review', method = 'item/completed') => publishReview(method, { turnId, item });
    publishItem(mark);
    publishReview('turn/started', { turn: nested });
    publishItem(prompt, 'worker');
    publishItem(raw, 'worker', 'item/started');
    publishReview('item/agentMessage/delta', { turnId: 'worker', itemId: raw.id, delta: raw.text });
    publishReview('item/reasoning/summaryTextDelta', { turnId: 'worker', itemId: 'summary', summaryIndex: 0, delta: 'Check the changes' });
    assert.deepEqual(events.slice(reviewStart).map(event => event.run?.id ?? event.item?.id ?? event.delta?.turnId),
      ['mark', 'review', 'review']);
    await agent.turns.stop(ref, 'review');
    assert.deepEqual(requests.at(-1)[1].packet.params, { threadId: 'thread', turnId: 'worker' });
    publishItem(fallback);
    publishItem(reply);
    publishReview('turn/completed', { turn: root });
    assert.deepEqual(applyTimeline([], events.slice(reviewStart)).map(row => [row.kind, row.text, row.phase]), [
      ['notice', '当前工作区改动', undefined], ['reasoning', undefined, undefined],
      ['message', reply.text, 'final'],
    ]);
    responses['thread/turns/list'] = { data: [
      { ...root, items: [mark, fallback, reply] },
      { ...nested, status: 'interrupted', items: [prompt] },
      { id: 'older-review', status: 'completed', items: [mark, fallback] },
    ] };
    const savedReview = await agent.sessions.history(ref, { limit: 20 });
    assert.deepEqual(historyRows(savedReview.items).filter(row => row.kind === 'message').map(row => row.text),
      [fallback.review, reply.text]);
    assert.ok(!historyRows(savedReview.items).some(row => row.kind === 'user'));
    responses['thread/turns/list'] = params => params.cursor === 'review-worker'
      ? { data: [{ ...nested, status: 'interrupted', items: [prompt] }] }
      : { data: [{ ...root, items: [mark, fallback, reply] }], nextCursor: 'review-worker' };
    const head = await agent.sessions.history(ref, { limit: 1 });
    const older = await agent.sessions.history(ref, { limit: 1, cursor: head.cursor });
    assert.deepEqual(historyRows(older.items), []);
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

test('reasoning detail reads only its turn and retains the same view for unrelated output', () => {
  const delta = (kind, id, text, turnId = 'live') => ({ kind: 'delta', delta: { kind, id, text, turnId, section: 0 } });
  const earlier = applyTimeline([], [delta('reasoning', 'old', 'History', 'older')]);
  const initial = applyTimeline([], [
    delta('reasoning', 'first', '\n\n'),
    delta('message', 'message', 'First part. '),
    delta('reasoning', 'last', 'Last reason.'),
  ]);
  const detail = turnReasoningRows(initial, 'live');
  assert.deepEqual(detail.map(row => row.id), ['last']);
  const unrelated = applyTimeline(initial, [delta('message', 'message', 'Next part.')]);
  assert.equal(turnReasoningRows(unrelated, 'live'), detail);
  const otherTurn = applyTimeline(unrelated, [delta('reasoning', 'older', 'Other reason.', 'older')]);
  assert.equal(turnReasoningRows(otherTurn, 'live'), detail);

  const completed = applyTimeline(initial, [delta('reasoning', 'first', 'Earlier reason.')]);
  assert.deepEqual(turnReasoningRows(completed, 'live').map(row => row.id), ['first', 'last']);
  assert.equal(turnReasoning(completed, 'live').id, 'last');
  assert.equal(turnReasoningRows(initial, 'live'), detail);
  const updated = applyTimeline(completed, [delta('reasoning', 'first', ' Updated.')]);
  assert.equal(turnReasoningRows(updated, 'live')[0].preview, 'Earlier reason. Updated.');
  assert.equal(turnReasoningRows(updated, 'live')[1], turnReasoningRows(completed, 'live')[1]);
  const reloaded = mergeHistory(updated, earlier);
  assert.deepEqual(turnReasoningRows(reloaded, 'older'), [earlier[0]]);
  const fromHistory = turnReasoningRows(reloaded, 'live');
  assert.deepEqual(fromHistory, turnReasoningRows(updated, 'live'));
  assert.equal(turnReasoningRows(applyTimeline(reloaded, [delta('message', 'message', 'Last part.')]), 'live'), fromHistory);
  assert.equal(mergeHistory([], updated), updated);
  assert.equal(mergeHistory(updated, []), updated);
  assert.equal(turnReasoningRows(mergeHistory([], updated), 'live'), turnReasoningRows(updated, 'live'));
});

test('streamed reasoning keeps a bounded preview and preserves the full summary', () => {
  const delta = (section, text) => ({ kind: 'delta', delta: { kind: 'reasoning', id: 'r', turnId: 't', section, text } });
  const summary = '# 验证路径\r\n' + '内容。'.repeat(100_000) + '最终检查';
  const whitespace = ' '.repeat(300) + '\r\n';
  const initial = applyTimeline([], [delta(0, summary)]);
  const initialPreview = turnReasoning(initial, 't').preview;
  assert.ok(initialPreview.endsWith('最终检查'));
  const emptyLine = applyTimeline(initial, [delta(0, '\r\n1. ')]);
  assert.equal(turnReasoning(emptyLine, 't').preview, initialPreview);
  const rows = applyTimeline(initial, [delta(1, '## 覆核'), delta(0, whitespace)]);
  assert.equal(turnReasoning(rows, 't').preview, '覆核');

  const unicodeBoundary = '😀' + '新'.repeat(239);
  const marker = applyTimeline(rows, [delta(0, '- ')]);
  assert.equal(turnReasoning(marker, 't').preview, turnReasoning(rows, 't').preview);
  const updated = applyTimeline(marker, [delta(0, unicodeBoundary)]);
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

test('a live reasoning preview waits for text in the next Markdown block', () => {
  const delta = text => ({ kind: 'delta', delta: { kind: 'reasoning', id: 'r', turnId: 't', text } });
  const preview = rows => turnReasoning(rows, 't')?.preview;
  const start = applyTimeline([], [delta('## 检查会话\r\n')]);
  const markers = ['- ', '1. ', '9) ', '> ', '> ### ', '```text', '~~~', '---'];
  for (const marker of markers) {
    assert.equal(preview(applyTimeline([], [delta(marker)])), undefined);
    assert.equal(preview(applyTimeline(start, [delta(marker)])), '检查会话');
    assert.equal(preview(applyTimeline([], [delta('## 检查会话\r\n' + marker)])), '检查会话');
  }
  const next = applyTimeline(start, [delta('> 1. '), delta('读取最新状态')]);
  assert.equal(preview(next), '读取最新状态');
  assert.equal(next[0].sections[0], '## 检查会话\r\n> 1. 读取最新状态');
  assert.equal(preview(applyTimeline(start, [delta('2.0 已加载')])), '2.0 已加载');
});

test('restored reasoning keeps readable sections before trailing Markdown markers', () => {
  const saved = sections => historyRows([{ run: { id: 't', status: 'completed' }, rows: [
    { kind: 'reasoning', id: 'r', turnId: 't', sections },
  ] }]);
  const separators = '---\n'.repeat(70);
  const summary = '> 1. 核对前文\n' + separators;
  const sections = [summary, '   ', '---\n~~~'];
  const restored = saved(sections);
  assert.equal(restored.length, 1);
  assert.equal(turnReasoning(restored, 't').preview, '核对前文');
  assert.deepEqual(turnReasoningRows(restored, 't'), restored);
  assert.deepEqual(restored[0].sections, sections);
  assert.deepEqual(sections.map((_, index) => hasReasoningSection(restored[0], index)), [true, false, false]);
  assert.equal(turnReasoning(saved([...sections, '## 最新正文', '# ']), 't').preview, '最新正文');
  assert.deepEqual(saved(['## ', separators]), []);

  const source = '[旧段链接](https://example.test/earlier)\n'.repeat(100) +
    '- 核对 [最新链接](https://example.test/' + 'long/'.repeat(100) + ')\n' + separators;
  const linked = turnReasoning(saved([source]), 't');
  assert.equal(linked.preview, '核对 最新链接');
  assert.deepEqual(linked.sections, [source]);
});

test('reasoning strips keep link labels while destinations stream or load from history', () => {
  const delta = (section, text) => ({ kind: 'delta', delta: { kind: 'reasoning', id: 'r', turnId: 't', section, text } });
  const length = 'reference/'.repeat(60);
  const prefix = '    - 对照 [工作台验收]';
  const open = applyTimeline([], [delta(0, prefix), delta(0, '(https:'), delta(0, '//example.test/')]);
  assert.equal(turnReasoning(open, 't').preview, '对照 工作台验收');
  const reading = applyTimeline(open, [delta(1, '按原定顺序复核')]);
  const path = applyTimeline(reading, [delta(0, length + '(v2)\\'), delta(0, ')/index)')]);
  assert.equal(turnReasoning(path, 't').preview, '按原定顺序复核');
  const ending = '，然后检查 [结果](http://example.test/a(b)c) 和 `git status`。';
  const completed = applyTimeline(path, [delta(0, ending)]);
  assert.equal(turnReasoning(completed, 't').preview, '对照 工作台验收，然后检查 结果 和 `git status`。');
  assert.equal(completed[0].sections[0], prefix + '(https://example.test/' + length + '(v2)\\)/index)' + ending);

  const snapshot = applyTimeline([], [{ kind: 'item', final: true, item: {
    kind: 'reasoning', id: 'r', turnId: 't', sections: [completed[0].sections[0]],
  } }]);
  assert.equal(turnReasoning(snapshot, 't').preview, turnReasoning(completed, 't').preview);
  assert.equal(snapshot[0].sections[0], completed[0].sections[0]);
  const interrupted = applyTimeline(open, [delta(0, length), delta(0, '\n  - 进入下一项')]);
  assert.equal(turnReasoning(interrupted, 't').preview, '进入下一项');
  assert.equal(turnReasoning(applyTimeline([], [delta(0, '`config[key](options)`')]), 't').preview, '`config[key](options)`');
});

test('the visible transcript can reuse rows across consecutive updates to a hidden summary', () => {
  const reasoning = (turnId, text, id = 'summary') => ({ kind: 'delta', delta: { kind: 'reasoning', id, turnId, text } });
  const reply = text => ({ kind: 'delta', delta: { kind: 'message', id: 'reply', turnId: 'live', text } });
  const original = applyTimeline([], [reasoning('past', 'Earlier details'), reasoning('live', 'Current progress'), reply('Answer: ')]);
  const layout = timelineLayout(original);
  const first = applyTimeline(original, [reasoning('live', '. Step one')]);
  const second = applyTimeline(first, [reasoning('live', '. Step two')]);
  const otherBranch = applyTimeline(original, [reasoning('live', '. Alternative')]);

  assert.equal(timelineLayout(second), layout);
  assert.equal(turnReasoning(second, 'live').preview, 'Current progress. Step one. Step two');
  assert.ok(sameTranscriptRows(original, second, 'live'));
  assert.ok(sameTranscriptRows(otherBranch, second, 'live'));
  assert.equal(sameTranscriptRows(original, second, undefined), false);
  assert.equal(sameTranscriptRows(original, second, 'past'), false);

  const olderUpdate = applyTimeline(second, [reasoning('past', '. New detail')]);
  const newerUpdate = applyTimeline(olderUpdate, [reasoning('live', '. Step three')]);
  assert.equal(sameTranscriptRows(second, newerUpdate, 'live'), false);
  assert.ok(sameTranscriptRows(olderUpdate, newerUpdate, 'live'));

  const withNewRow = applyTimeline(second, [reasoning('live', 'Another summary', 'extra')]);
  assert.equal(sameTranscriptRows(second, withNewRow, 'live'), false);
  const withMessage = applyTimeline(second, [reasoning('live', '. Step three'), reply('the answer is visible.')]);
  assert.equal(timelineLayout(withMessage), layout);
  assert.equal(sameTranscriptRows(second, withMessage, 'live'), false);
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

test('late fragments leave the completed transcript and its layout unchanged', () => {
  const message = { kind: 'message', id: 'message', turnId: 't', text: 'Answer' };
  const reasoning = { kind: 'reasoning', id: 'summary', turnId: 't', sections: ['Summary'] };
  const rows = applyTimeline([], [message, reasoning].map(item => ({ kind: 'item', final: true, item })));
  const layout = timelineLayout(rows);
  const late = [
    { kind: 'delta', delta: { ...message, text: 'late message' } },
    { kind: 'delta', delta: { ...reasoning, section: 0, text: 'late summary' } },
  ];
  assert.equal(applyTimeline(rows, late), rows);
  assert.equal(applyTimeline(rows, []), rows);
  const updated = applyTimeline(rows, [...late, { kind: 'delta', delta: { ...message, id: 'next', turnId: 'other' } }]);
  assert.equal(updated.length, 3);
  assert.equal(updated[0], rows[0]);
  assert.equal(updated[1], rows[1]);
  assert.equal(timelineLayout(rows), layout);
});

test('Claude ACP separates the native Goal snapshot from the lifetime of its turns', async t => {
  const generation = 47;
  const events = [];
  const packets = [];
  let receive;
  const emit = data => receive({ event: 'agent', generation, data });
  const update = (update, sessionId = 'claude-session') => emit({ method: 'session/update', params: { sessionId, update } });
  const snapshot = (goal, id) => update({ sessionUpdate: 'session_info_update', _meta: { jetbrains: { air: { goal } } } }, id);
  const reply = (packet, result) => emit({ id: packet.id, result });
  globalThis.window = { span: {
    onEvent(callback) { receive = callback; return () => {}; },
    async request(method, { packet } = {}) {
      if (method === 'agent.start') receive({ event: 'agent-route', generation, data: 'stdio' });
      if (method !== 'agent.send') return;
      packets.push(packet);
      if (packet.method === 'initialize') {
        assert.deepEqual(packet.params.clientCapabilities._meta.jetbrains.air.capabilities, ['asyncTasks', 'nativeSubagentSessions']);
        reply(packet, { protocolVersion: 1, agentCapabilities: {}, _meta: { jetbrains: { air: {
          goal: { version: 1, actions: ['set', 'clear'], controlMethod: '_session/goal' },
        } } } });
      } else if (packet.method === 'session/new') {
        assert.equal(packet.params._meta.claudeCode.options.promptSuggestions, false);
        reply(packet, { sessionId: 'claude-session' });
      } else if (packet.method === '_session/goal') {
        snapshot(packet.params.action === 'clear' ? null : { objective: packet.params.objective, status: 'active' });
        reply(packet, {});
      } else if (packet.method === '_session/async_task/stop') {
        update({ sessionUpdate: 'async_task_state_update', asyncTaskId: packet.params.asyncTaskId, state: 'stopped' });
        reply(packet, { stopped: true });
      }
    },
  } };
  const agent = await createAgent('claude', { generation, location: { kind: 'local' }, cwd: '/work',
    onEvent: event => events.push(event) });
  t.after(() => { agent.close(); delete globalThis.window; });
  await agent.open();
  const { session: { ref } } = await agent.sessions.start();
  assert.deepEqual(agent.goal.actions, ['set', 'edit', 'clear']);
  assert.equal(await agent.goal.read(ref), null);
  await assert.rejects(agent.goal.update(ref, { kind: 'pause' }), /不支持/);
  const goal = await agent.goal.update(ref, { kind: 'set', objective: 'Check the worktree' });
  assert.equal(goal.status, 'active');
  assert.deepEqual(events.filter(event => event.kind === 'run').map(event => event.run.status), ['running', 'completed']);
  snapshot({ objective: 'Unrelated session', status: 'complete' }, 'another-session');
  assert.deepEqual(await agent.goal.read(ref), goal);

  const task = 'autonomous-turn-test';
  update({ sessionUpdate: 'async_task_spawned', asyncTaskId: task, taskType: 'turn' });
  const run = events.at(-1).run;
  update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Checking again.' } });
  assert.equal(events.at(-1).delta.turnId, run.id);
  await agent.turns.stop(ref, run.id);
  assert.equal(packets.at(-1).params.asyncTaskId, task);
  assert.equal(events.at(-1).run.status, 'cancelled');
  assert.equal((await agent.goal.read(ref)).status, 'active');
  await agent.goal.update(ref, { kind: 'edit', objective: 'Check a second time' });
  assert.deepEqual(packets.at(-1).params, { sessionId: ref.id, action: 'set', objective: 'Check a second time' });
  assert.equal(await agent.goal.update(ref, { kind: 'clear' }), null);
  assert.equal(events.filter(event => event.kind === 'goal').at(-1).goal, null);
});

test('Claude ACP isolates child output and approval and restores the final child state in history', async t => {
  const generation = 48;
  const events = [];
  const packets = [];
  let receive, prompt;
  const emit = data => receive({ event: 'agent', generation, data });
  const update = (sessionId, update) => emit({ method: 'session/update', params: { sessionId, update } });
  const chunk = (id, kind, text) => update(id, { sessionUpdate: kind, content: { type: 'text', text } });
  const spawn = id => update('root', { sessionUpdate: 'subagent_spawned', subagentSessionId: id,
    name: 'Inspector', task: 'Read the result', prompt: 'Look at the fixture.' });
  const settle = id => update('root', { sessionUpdate: 'subagent_state_update', subagentSessionId: id, state: 'completed' });
  const reply = (packet, result) => emit({ id: packet.id, result });
  globalThis.window = { span: {
    onEvent(callback) { receive = callback; return () => {}; },
    async request(method, { packet } = {}) {
      if (method === 'agent.start') receive({ event: 'agent-route', generation, data: 'stdio' });
      if (method !== 'agent.send') return;
      packets.push(packet);
      if (packet.method === 'initialize') reply(packet, { protocolVersion: 1,
        agentCapabilities: { loadSession: true, sessionCapabilities: { subagents: {}, close: {} } } });
      if (packet.method === 'session/new') reply(packet, { sessionId: 'root' });
      if (packet.method === 'session/close') reply(packet, {});
      if (packet.method === 'session/prompt') prompt = packet;
      if (packet.method === 'session/load') {
        chunk('root', 'user_message_chunk', 'Delegate');
        update('root', { sessionUpdate: 'subagent_spawned', subagentSessionId: 'saved-child',
          name: 'Inspector', task: 'Look at the saved fixture.' });
        chunk('saved-child', 'agent_message_chunk', 'Saved child result.');
        chunk('root', 'agent_message_chunk', 'Root result.');
        chunk('root', 'user_message_chunk', 'Later request');
        settle('saved-child');
        reply(packet, {});
      }
    },
  } };
  const agent = await createAgent('claude', { generation, location: { kind: 'local' }, cwd: '/work',
    onEvent: event => events.push(event) });
  t.after(() => { agent.close(); delete globalThis.window; });
  await agent.open();
  const { session: { ref } } = await agent.sessions.start();
  await agent.turns.start(ref, [{ kind: 'text', text: 'Delegate' }], {}, 'delegate');
  spawn('child');
  let view;
  const close = agent.delegation.watchTranscript(ref, 'child', snapshot => { view = snapshot; });
  chunk('child', 'agent_message_chunk', 'Child result.');
  const ask = (id, sessionId) => emit({ id, method: 'session/request_permission', params: {
    sessionId, toolCall: { toolCallId: 'shell', kind: 'execute', rawInput: { command: 'echo fixture' } },
    options: [{ optionId: 'once', kind: 'allow_once' }],
  } });
  ask('foreign', 'child-from-another-root');
  assert.equal(packets.at(-1).result.outcome.outcome, 'cancelled');
  ask('cancelled', 'child');
  assert.equal(events.at(-1).request.actor.id, 'child');
  emit({ method: '$/cancel_request', params: { requestId: 'cancelled' } });
  assert.equal(events.at(-1).kind, 'interactionResolved');
  ask('approval', 'child');
  await agent.interactions.respond(events.at(-1).request.id, { choice: 'once' });
  assert.equal(packets.at(-1).id, 'approval');
  assert.equal(packets.at(-1).result.outcome.optionId, 'once');
  settle('child');
  assert.equal(view.run.status, 'completed');
  assert.deepEqual(view.rows.map(row => row.text), ['Look at the fixture.', 'Child result.']);
  assert.ok(events.every(event => event.delta?.text !== 'Child result.'));
  close();
  reply(prompt, { stopReason: 'end_turn' });
  await new Promise(resolve => setImmediate(resolve));

  await agent.sessions.release(ref);
  const reopened = await agent.sessions.resume(ref, 4);
  const [first] = reopened.history.items;
  assert.deepEqual(first.rows.map(row => row.kind), ['user', 'delegation', 'message']);
  assert.equal(first.rows[1].members[0].status, 'completed');
  const cleanup = agent.delegation.watchTranscript(ref, 'saved-child', snapshot => { view = snapshot; });
  assert.deepEqual(view.rows.map(row => [row.kind, row.text]),
    [['notice', 'Look at the saved fixture.'], ['message', 'Saved child result.']]);
  cleanup();
});

test('a hidden Pi member viewer pauses requests, retains an in-flight result, and refreshes on restore', async t => {
  let hidden = true;
  const listeners = new Set();
  const setHidden = value => {
    hidden = value;
    for (const listener of listeners) listener(value);
  };
  globalThis.window = { span: { onWindowHidden(listener) {
    listeners.add(listener);
    listener(hidden);
    return () => listeners.delete(listener);
  } } };
  t.after(() => { delete globalThis.window; });
  const requests = [];
  const updates = [];
  const entry = (id, text) => ({ type: 'message', id, message: { role: 'user', content: text } });
  let refreshStarted;
  const firstRefresh = new Promise(resolve => { refreshStarted = resolve; });
  const stop = watchPiTeamTranscript(({ cursor, refresh }) => {
    requests.push(cursor ?? (refresh ? 'refresh' : 'latest'));
    if (cursor) return { entries: [entry('earlier', 'Earlier task')], cursor: null };
    if (!refresh) return { entries: [entry('current', 'Current task')], cursor: 'older' };
    if (requests.length === 2) return new Promise(resolve => { refreshStarted(resolve); });
    return null;
  }, view => updates.push(view), 10);
  t.after(stop);
  assert.deepEqual(requests, []);
  setHidden(false);
  const finishRefresh = await firstRefresh;
  assert.equal(updates.at(-1).rows.at(-1).text, 'Current task');
  setHidden(true);
  finishRefresh({ append: true, entries: [entry('new', 'Next task')] });
  await delay(40);
  assert.deepEqual(requests, ['latest', 'refresh']);
  assert.equal(updates.at(-1).rows.at(-1).text, 'Current task');
  setHidden(false);
  assert.deepEqual(requests, ['latest', 'refresh', 'refresh']);
  assert.equal(updates.at(-1).rows.at(-1).text, 'Next task');
  updates.at(-1).loadOlder();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(requests, ['latest', 'refresh', 'refresh', 'older']);
  assert.deepEqual(updates.at(-1).rows.map(row => row.text), ['Earlier task', 'Current task', 'Next task']);
  stop();
  assert.equal(listeners.size, 0);
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
  let cancelTeamRead = false;
  let disconnectDuringHistory = false;
  let switching;
  let olderReplyReads = 0;
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
        if (packet.id === 'open-prompt' || packet.id === 'released-prompt') {
          assert.equal(packet.cancelled, true);
          return;
        }
        assert.equal(packet.id, 'switch');
        assert.equal(packet.confirmed, true);
        branch = true;
        respond(switching, { cancelled: false });
      } else if (packet.type === 'get_entries') {
        respond(packet, { leafId: 'answer', entries: [
          entry('one', null, 'user', 'First'),
          entry('two', 'one', 'assistant', [{ type: 'text', get text() {
            olderReplyReads++;
            return 'Stored response';
          } }]),
          entry('discarded', 'one', 'assistant', text('Abandoned branch')),
          entry('question', 'two', 'user', 'Second'),
          entry('answer', 'question', 'assistant', text('Current branch')),
        ] });
        if (disconnectDuringHistory) receive({ event: 'agent-closed', generation: source, data: 'Pi connection closed' });
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
        respond(packet, { tokens: { total: 17, input: 8, output: 2, cacheRead: 3, cacheWrite: 4 },
          contextUsage: { tokens: 10, contextWindow: 100 } });
      } else if (packet.type === 'span_pi_teams') {
        assert.equal(packet.sessionId, 'saved');
        if (cancelTeamRead) return respond(packet, null);
        respond(packet, [{ config: { name: 'shipping', state: 'active', members: [
          { agentId: '32a5c9ed', name: 'Reviewer', status: 'running', isActive: false },
        ] }, board: { schemaVersion: 1, tasks: [
          { id: 'first', subject: 'Prepare', status: 'pending' },
          { id: 'second', subject: 'Review', status: 'pending', owner: 'reviewer', dependsOn: ['first'] },
          { id: 'deleted', subject: 'Discarded', status: 'deleted' },
        ] } }]);
      } else if (packet.type === 'span_pi_team_transcript') {
        assert.equal(packet.sessionId, 'saved');
        assert.equal(packet.memberId, '32a5c9ed');
        if (cancelTeamRead) return respond(packet, null);
        const older = packet.cursor === '12345';
        const records = [];
        for (let index = older ? 0 : 4; index < (older ? 4 : 24); index++) {
          records.push(entry('q' + index, index ? 'r' + (index - 1) : null, 'user', 'Task ' + index));
          records.push(entry('r' + index, 'q' + index, 'assistant', text('Result ' + index)));
        }
        respond(packet, { entries: records, cursor: older ? null : '12345' });
      } else if (packet.type === 'get_commands') {
        respond(packet, { commands: [
          { name: 'skill:review', source: 'skill', description: 'Project review',
            sourceInfo: { path: '/remote/work/.agents/skills/review/SKILL.md', scope: 'project' } },
          { name: 'span-form', source: 'extension', description: 'Open the form' },
          { name: 'team', source: 'extension',
            description: 'Show team roster or teammate detail: /team [team-name] [--detail <teammate>] [--full-prompt]' },
        ] });
      } else {
        respond(packet, { commands: [] });
      }
    },
  } };
  const agent = await createAgent('pi', { location: remote, cwd: '/local/work', generation: source, onEvent: event => events.push(event) });
  t.after(() => { agent.close(); delete globalThis.window; });
  await agent.open();
  assert.equal(events[0].route, 'stdio');
  assert.deepEqual(await agent.extensions.list('skill', null), { items: [{
    kind: 'skill', id: 'skill:review', name: 'review', label: 'review', description: 'Project review',
    path: '/remote/work/.agents/skills/review/SKILL.md', scope: 'workspace',
  }], cursor: null });
  assert.deepEqual(agent.commands.map(command => command.id), ['skill:review', 'span-form', 'team']);
  const catalog = await agent.sessions.list({});
  const ref = catalog.items[0].ref;
  assert.equal(sessionKey(ref), sessionKey({ backend: 'pi', location: remote, id: 'saved' }));
  const loading = agent.sessions.resume(ref, 1);
  await Promise.resolve();
  assert.equal(events.at(-1).kind, 'connectionInteraction');
  await agent.interactions.respond('switch', { choice: 'yes' });
  const opened = await loading;
  assert.equal(opened.history.items[0].rows.at(-1).text, 'Current branch');
  assert.equal(opened.history.items[0].id, 'turn:1');
  assert.equal(olderReplyReads, 0);
  assert.deepEqual((await agent.usage(ref)).tokens,
    { total: 17, input: 8, output: 2, cached: 3, cacheWrite: 4, contextUsed: 10, contextLimit: 100 });
  const [team] = await agent.delegation.teams(ref);
  assert.equal(team.status, 'active');
  assert.equal(team.members[0].status, 'idle');
  assert.equal(team.members[0].attachedTranscript, true);
  assert.deepEqual(team.tasks.map(({ id, status, assigneeId, blockedBy }) => ({ id, status, assigneeId, blockedBy })), [
    { id: 'first', status: 'pending', assigneeId: undefined, blockedBy: [] },
    { id: 'second', status: 'blocked', assigneeId: '32a5c9ed', blockedBy: ['first'] },
  ]);
  await assert.rejects(agent.delegation.teams({ ...ref, location: { kind: 'ssh', host: 'other' } }), /会话已切换/);
  assert.throws(() => agent.delegation.watchTranscript(ref, 'cafebabe', () => {}), /没有这个 Pi 子代理/);
  const trace = [];
  const closeTrace = agent.delegation.watchTranscript(ref, '32a5c9ed', view => trace.push(view));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(trace[0].loading, true);
  assert.equal(trace.at(-1).rows[0].text, 'Task 4');
  assert.equal(trace.at(-1).rows.at(-1).text, 'Result 23');
  assert.equal(sent.filter(packet => packet.type === 'span_pi_team_transcript').length, 1);
  const lastKey = trace.at(-1).rows.at(-1).key;
  trace.at(-1).loadOlder();
  trace.at(-1).loadOlder();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sent.filter(packet => packet.type === 'span_pi_team_transcript').length, 2);
  assert.equal(sent.at(-1).cursor, '12345');
  assert.equal(trace.at(-1).rows[0].text, 'Task 0');
  assert.equal(trace.at(-1).rows.at(-1).key, lastKey);
  assert.equal(trace.at(-1).cursor, null);
  closeTrace();
  cancelTeamRead = true;
  assert.equal(await agent.delegation.teams(ref), undefined);
  const closeCancelledTrace = agent.delegation.watchTranscript(ref, '32a5c9ed', view => trace.push(view));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(trace.at(-1).error, undefined);
  assert.equal(trace.at(-1).loading, false);
  assert.deepEqual(trace.at(-1).rows, []);
  closeCancelledTrace();
  await agent.delegation.releaseTeamView(ref);
  assert.deepEqual(sent.at(-1), { type: 'span_pi_release_team_view', sessionId: 'saved' });
  const older = await agent.sessions.history(ref, { cursor: opened.history.cursor, limit: 1 });
  assert.equal(older.items[0].rows.at(-1).text, 'Stored response');
  assert.equal(older.items[0].id, 'turn:0');
  assert.equal(olderReplyReads, 1);
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
  assert.ok(sent.filter(packet => !['extension_ui_response', 'span_pi_release_team_view'].includes(packet.type))
    .every(packet => typeof packet.id === 'string'));

  await agent.sessions.release({ ...ref, location: { kind: 'ssh', host: 'elsewhere' } });
  assert.equal((await agent.usage(ref)).tokens.total, 17);
  emit({ type: 'extension_ui_request', method: 'confirm', id: 'open-prompt' });
  assert.equal(events.at(-1).request.id, 'open-prompt');
  await agent.sessions.release(ref);
  assert.equal(events.at(-1).id, 'open-prompt');
  assert.deepEqual(sent.at(-1), { type: 'extension_ui_response', id: 'open-prompt', cancelled: true });
  const releasedAt = events.length;
  emit({ type: 'agent_start' });
  emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'late answer' } });
  emit({ type: 'extension_ui_request', method: 'confirm', id: 'released-prompt' });
  assert.equal(events.length, releasedAt);
  assert.deepEqual(sent.at(-1), { type: 'extension_ui_response', id: 'released-prompt', cancelled: true });
  await assert.rejects(agent.sessions.history(ref, { limit: 1 }), /会话已切换/);

  const reopening = agent.sessions.resume(ref, 1);
  await Promise.resolve();
  await agent.interactions.respond('switch', { choice: 'yes' });
  const { history } = await reopening;
  assert.ok(history.cursor);
  assert.equal(olderReplyReads, 1);
  disconnectDuringHistory = true;
  const interrupted = agent.sessions.resume(ref, 1);
  await Promise.resolve();
  await agent.interactions.respond('switch', { choice: 'yes' });
  await assert.rejects(interrupted, /会话已切换/);
  assert.equal(events.at(-1).kind, 'disconnected');
  await assert.rejects(agent.sessions.history(ref, { cursor: history.cursor, limit: 1 }), /会话已切换/);
});

['opencode', 'kilo'].forEach(backend => test(`${backend} ACP scopes history, prompts and approvals to the active session`, async t => {
  const events = [];
  const packets = [];
  const source = 214;
  const listeners = new Set();
  const catalogEntry = { sessionId: 'saved', cwd: '/remote/work', title: 'Saved session' };
  const configOptions = [
    { id: 'provider-model', category: 'model', type: 'select', currentValue: 'span/test',
      options: [{ name: 'Span', options: [{ value: 'span/test', name: 'Test/Test' }] }] },
    { id: 'reasoning-level', category: 'thought_level', type: 'select', currentValue: 'low',
      options: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }] },
    { id: 'mode', currentValue: 'build', options: [{ value: 'build', name: 'Build' }, { value: 'plan', name: 'Plan' }] },
    { id: 'irrelevant', category: 'thought_level', type: 'boolean', currentValue: false, options: [] },
  ];
  const emit = (event, data) => listeners.forEach(listener => listener({ event, generation: source, data }));
  const packet = data => emit('agent', { jsonrpc: '2.0', ...data });
  const update = (sessionId, update) => packet({ method: 'session/update', params: { sessionId, update } });
  const chunk = (sessionId, sessionUpdate, messageId, text) =>
    update(sessionId, { sessionUpdate, messageId, content: { type: 'text', text } });
  let ongoing;
  let sessionConfig = configOptions;
  let kiloGoal;
  let finishSavedGoalRead;
  globalThis.window = { span: {
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async request(method, args) {
      if (method === 'agent.start') {
        assert.equal(args.ssh, 'dev');
        assert.equal(args.backend, backend);
        emit('agent', { method: 'span/backendWorkspace', params: { cwd: '/remote home' } });
        emit('agent-route', 'stdio');
        return;
      }
      if (method === 'agent.kiloGoal') {
        assert.equal(backend, 'kilo');
        assert.equal(args.generation, source);
        if (args.probe) {
          assert.equal(args.cwd, '/remote home');
          return true;
        }
        if (args.sessionId === 'saved') return new Promise(resolve => { finishSavedGoalRead = resolve; });
        assert.equal(args.sessionId, 'new');
        assert.equal(args.cwd, '/remote home');
        if (args.action === 'set') {
          assert.equal(args.options.mode, 'plan');
          kiloGoal = { text: args.objective, status: 'active' };
          chunk('new', 'agent_thought_chunk', 'goal-thought', 'Verify the objective.');
        } else if (args.action === 'pause') {
          kiloGoal = { ...kiloGoal, status: 'paused' };
        }
        return kiloGoal;
      }
      if (method !== 'agent.send') return;
      const sent = args.packet;
      packets.push(sent);
      assert.equal(sent.jsonrpc, '2.0');
      const answer = result => packet({ id: sent.id, result });
      switch (sent.method) {
        case 'initialize':
          answer({ protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { list: {}, close: {} } } });
          break;
        case 'session/list':
          answer({ sessions: [catalogEntry] });
          break;
        case 'session/load':
          assert.equal(sent.params.cwd, '/remote/work');
          chunk('saved', 'user_message_chunk', 'one', 'First question');
          chunk('saved', 'agent_message_chunk', 'reply-one', 'Before the tool.');
          update('saved', { sessionUpdate: 'tool_call', toolCallId: 'cmd', kind: 'execute', rawInput: { command: 'echo test' } });
          update('saved', { sessionUpdate: 'tool_call_update', toolCallId: 'cmd', status: 'completed' });
          chunk('saved', 'agent_message_chunk', 'reply-one', 'After the tool.');
          chunk('saved', 'user_message_chunk', 'two', 'Second question');
          chunk('saved', 'agent_message_chunk', 'reply-two', 'Second answer');
          answer({ configOptions });
          break;
        case 'session/new':
          assert.equal(sent.params.cwd, '/remote home');
          update('new', { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'compact' }] });
          update('saved', { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'other-project' }] });
          answer({ sessionId: 'new', configOptions });
          break;
        case 'session/prompt':
          ongoing = sent;
          break;
        case 'session/cancel':
          assert.equal(sent.params.sessionId, ongoing.params.sessionId);
          packet({ id: ongoing.id, result: { stopReason: 'cancelled' } });
          break;
        case 'session/set_config_option':
          assert.ok((sent.params.configId === 'reasoning-level' && sent.params.value === 'high')
            || (sent.params.configId === 'mode' && sent.params.value === 'plan'));
          sessionConfig = sessionConfig.map(option => option.id === sent.params.configId
            ? { ...option, currentValue: sent.params.value } : option);
          answer({ configOptions: sessionConfig });
          break;
        case 'session/close':
          answer({});
          break;
      }
    },
  } };
  const agent = await createAgent(backend, { location: remote, cwd: 'C:\\irrelevant', generation: source,
    onEvent: event => events.push(event) });
  t.after(() => { agent.close(); delete globalThis.window; });
  await agent.open();
  const catalog = await agent.sessions.list({});
  assert.equal(catalog.items[0].cwd, '/remote/work');
  const saved = await agent.sessions.resume(catalog.items[0].ref, 1);
  assert.equal(saved.models[0].label, 'Test');
  assert.deepEqual(historyRows(saved.history.items).map(row => row.text), ['Second question', 'Second answer']);
  const older = await agent.sessions.history(saved.session.ref, { cursor: saved.history.cursor, limit: 1 });
  assert.deepEqual(historyRows(older.items).map(row => row.text ?? row.command),
    ['First question', 'Before the tool.', 'echo test', 'After the tool.']);
  const savedGoalRead = agent.goal?.read(saved.session.ref);
  await agent.sessions.release(saved.session.ref);
  const fresh = await agent.sessions.start({});
  const session = fresh.session.ref;
  if (savedGoalRead) {
    finishSavedGoalRead({ text: 'Previous goal', status: 'active' });
    assert.equal(await savedGoalRead, undefined);
    assert.ok(!events.some(event => event.kind === 'goal'));
  }
  const otherBackend = backend === 'opencode' ? 'kilo' : 'opencode';
  await assert.rejects(agent.usage({ ...session, backend: otherBackend }), /切换/);
  assert.deepEqual(agent.commands.map(command => command.id), ['compact']);
  assert.deepEqual(agent.modes.map(mode => mode.id), ['build', 'plan']);
  const run = await agent.turns.start(session, [{ kind: 'text', text: 'New request' }], { effort: 'high', mode: 'plan' }, 'draft');
  assert.deepEqual(packets.filter(packet => packet.method === 'session/set_config_option').map(packet => packet.params.configId),
    ['reasoning-level', 'mode']);
  assert.equal(run.status, 'running');
  assert.equal(agent.turns.steer, undefined);
  assert.equal(events.findLast(event => event.kind === 'item').item.clientId, 'draft');
  const permission = (id, sessionId) => packet({ id, method: 'session/request_permission', params: {
    sessionId, toolCall: { toolCallId: 'active-tool', kind: 'execute', title: 'echo open', rawInput: { command: 'echo open' } },
    options: [{ optionId: 'once', kind: 'allow_once' }, { optionId: 'deny', kind: 'reject_once' }],
  } });
  permission('stale', 'saved');
  assert.equal(packets.at(-1).result.outcome.outcome, 'cancelled');
  chunk('new', 'agent_thought_chunk', 'thought', 'Check result.');
  permission('approval', 'new');
  const approval = events.findLast(event => event.kind === 'interaction').request;
  assert.equal(approval.title, '执行命令');
  assert.equal(approval.operation.cwd, '/remote home');
  assert.equal(approval.operation.command, 'echo open');
  await agent.interactions.respond(approval.id, { choice: 'deny' });
  assert.deepEqual(packets.at(-1).result.outcome, { outcome: 'selected', optionId: 'deny' });
  await agent.turns.stop(session, run.id);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(events.findLast(event => event.kind === 'run').run.status, 'cancelled');
  await agent.turns.start(session, [{ kind: 'text', text: 'Second request' }], {}, 'second');
  const report = { sessionUpdate: 'usage_update', used: 900, size: 32768, cost: { amount: 0.001, currency: 'USD' } };
  update('new', report);
  const count = events.length;
  update('new', { ...report, cost: { ...report.cost } });
  assert.equal(events.length, count);
  packet({ id: ongoing.id, result: { stopReason: 'end_turn', usage: {
    totalTokens: 40, inputTokens: 30, cachedReadTokens: 2, cachedWriteTokens: 3, outputTokens: 5,
  } } });
  await new Promise(resolve => setImmediate(resolve));
  const usage = await agent.usage(session);
  assert.deepEqual(usage.tokens, { contextUsed: 900, contextLimit: 32768 });
  assert.equal(usage.recentTokens.total, 40);
  assert.equal(usage.recentTokens.cacheWrite, 3);
  assert.equal(usage.cost.amount, 0.001);
  assert.deepEqual(events.findLast(event => event.kind === 'usage').usage, { recentTokens: usage.recentTokens });
  if (backend === 'kilo') {
    const goal = await agent.goal.update(session, { kind: 'set', objective: 'Review the state' }, { mode: 'plan' });
    assert.equal(goal.status, 'active');
    assert.equal(events.findLast(event => event.kind === 'delta').delta.text, 'Verify the objective.');
    const activeGoalRun = events.findLast(event => event.kind === 'run').run;
    assert.equal(activeGoalRun.status, 'running');
    const sendDuringGoal = agent.turns.steer;
    const response = sendDuringGoal(session, activeGoalRun.id, [{ kind: 'text', text: 'Check the card first.' }], 'goal-input');
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(ongoing.params.prompt, [{ type: 'text', text: 'Check the card first.' }]);
    chunk('new', 'agent_message_chunk', 'goal-input-reply', 'The card is above the composer.');
    packet({ id: ongoing.id, result: { stopReason: 'end_turn' } });
    await response;
    assert.equal(events.findLast(event => event.kind === 'item').item.clientId, 'goal-input');
    assert.equal(events.findLast(event => event.kind === 'run').run.status, 'running');
    await agent.turns.stop(session, activeGoalRun.id);
    assert.equal(events.findLast(event => event.kind === 'goal').goal.status, 'paused');
    assert.equal(events.findLast(event => event.kind === 'run').run.status, 'cancelled');
    assert.equal(agent.turns.steer, undefined);
    await assert.rejects(sendDuringGoal(session, activeGoalRun.id, [{ kind: 'text', text: 'Late request.' }], 'late'), /目标已结束/);
  } else {
    assert.equal(agent.goal, undefined);
  }
}));
