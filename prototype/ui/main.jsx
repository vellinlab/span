import { lazy, memo, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  ArrowDown, ArrowUp, ChevronLeft, FileText, Folder, FolderOpen, MessageSquare,
  Monitor, PanelRightClose, Plus, Square, SquareTerminal,
} from 'lucide-react';
import { connectAgent, historyRows, toRow } from './agent.js';
import { Markdown } from './markdown.jsx';
import './workbench.css';

const TerminalPanel = lazy(() => import('./terminal.jsx').then(module => ({ default: module.TerminalPanel })));
const PAGE_SIZE = 20;
const tabs = [['hosts', '主机', Monitor], ['sessions', '会话', MessageSquare], ['files', '文件', Folder]];
let generation = 0;

const TranscriptRow = memo(function TranscriptRow({ row }) {
  if (row.kind === 'activity') {
    return <details className="activity">
      <summary><SquareTerminal size={15} /><span title={row.title}>{row.title}</span></summary>
      <pre>{row.text}</pre>
    </details>;
  }
  if (row.kind === 'user') return <div className="user-message">{row.text}</div>;
  return <Markdown text={row.text} />;
});

const Transcript = memo(function Transcript({ rows, cursor, loadOlder, loading, follow, prepend }) {
  const scroll = useRef(null);
  const getItemKey = useCallback(index => rows[index].id, [rows]);
  const virtual = useVirtualizer({
    count: rows.length, getScrollElement: () => scroll.current,
    estimateSize: () => 125, getItemKey, overscan: 6,
  });
  const virtualRows = virtual.getVirtualItems();
  useLayoutEffect(() => {
    if (prepend.current) {
      const { key, distance } = prepend.current;
      const index = rows.findIndex(row => row.id === key);
      const target = virtual.getOffsetForIndex(index, 'start');
      if (target) virtual.scrollToOffset(target[0] + distance);
      prepend.current = null;
      return;
    }
    if (follow.current && rows.length) virtual.scrollToIndex(rows.length - 1, { align: 'end' });
  }, [rows, virtual, follow, prepend]);

  function onScroll() {
    const element = scroll.current;
    const atBottom = element.scrollHeight - element.clientHeight - element.scrollTop < 40;
    if (!follow.current && element.scrollTop < 160 && cursor && !loading && !prepend.current) {
      const first = virtualRows.find(item => item.end > element.scrollTop);
      if (first) prepend.current = { key: first.key, distance: element.scrollTop - first.start };
      loadOlder();
    }
    if (atBottom) follow.current = true;
  }

  return <div className="timeline" ref={scroll} role="log" aria-live="off" data-testid="transcript"
    data-items={rows.length} onScroll={onScroll}
    onWheel={event => {
      if (event.deltaY < 0) {
        follow.current = false;
        if (scroll.current.scrollTop < 160) onScroll();
      }
    }}
    onPointerDown={event => {
      if (event.clientX >= event.currentTarget.getBoundingClientRect().right - 13) follow.current = false;
    }}>
    {rows.length ? <div className="reading-column rail" style={{ height: virtual.getTotalSize() }}>
      {virtualRows.map(item => <div className="message" key={item.key} data-index={item.index}
        ref={virtual.measureElement} style={{ transform: `translateY(${item.start}px)` }}>
        <TranscriptRow row={rows[item.index]} />
      </div>)}
    </div> : <div className="welcome"><MessageSquare size={24} /><p>打开会话，或从一条消息开始</p></div>}
  </div>;
});

function App() {
  const [config, setConfig] = useState(null);
  const [backend, setBackend] = useState('codex');
  const [target, setTarget] = useState('');
  const [tab, setTab] = useState('sessions');
  const [error, setError] = useState('');
  const [connection, setConnection] = useState('connecting');
  const [sessions, setSessions] = useState([]);
  const [session, setSession] = useState(null);
  const [rows, setRows] = useState([]);
  const [cursor, setCursor] = useState(null);
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const [interruptible, setInterruptible] = useState(false);
  const [status, setStatus] = useState('');
  const [question, setQuestion] = useState(null);
  const [draft, setDraft] = useState('');
  const [terminal, setTerminal] = useState(false);
  const [directory, setDirectory] = useState('');
  const [entries, setEntries] = useState([]);
  const [preview, setPreview] = useState(null);
  const follow = useRef(true);
  const prepend = useRef(null);
  const agent = useRef(null);
  const thread = useRef(null);
  const turn = useRef(null);
  const pagePending = useRef(null);
  const requestScope = useRef(0);
  const previewScope = useRef(0);
  const stream = useRef(new Map());
  const frame = useRef(0);
  const busy = useRef(false);
  const input = useRef(null);
  const closeTerminal = useCallback(() => setTerminal(false), []);

  const report = useCallback(error => setError(error.message), []);

  function resetThread() {
    requestScope.current++;
    thread.current = null;
    turn.current = null;
    pagePending.current = null;
    busy.current = false;
    follow.current = true;
    prepend.current = null;
    stream.current.clear();
    cancelAnimationFrame(frame.current);
    frame.current = 0;
    setRows([]);
    setCursor(null);
    setRunning(false);
    setInterruptible(false);
    setStatus('');
    setSession(null);
    setQuestion(null);
    setLoading(false);
  }

  function page(api, id, nextCursor, scope) {
    return api.request('thread/turns/list', { threadId: id, limit: PAGE_SIZE, cursor: nextCursor, sortDirection: 'desc', itemsView: 'full' })
      .then(result => {
        if (scope !== requestScope.current) return;
        const older = historyRows([...(result.data ?? [])].reverse());
        const olderIds = new Set(older.map(row => row.id));
        setRows(current => [...older, ...current.filter(row => !olderIds.has(row.id))]);
        setCursor(result.nextCursor ?? null);
      });
  }

  async function openSession(api, entry) {
    resetThread();
    setError('');
    const scope = requestScope.current;
    setLoading(true);
    try {
      const result = await api.request('thread/resume', { threadId: entry.id, excludeTurns: true });
      if (scope !== requestScope.current) return;
      thread.current = result.thread.id;
      setSession(entry);
      await page(api, result.thread.id, null, scope);
    } catch (error) {
      if (scope === requestScope.current) report(error);
    } finally {
      if (scope === requestScope.current) setLoading(false);
    }
  }

  const loadOlder = useCallback(() => {
    const api = agent.current;
    const id = thread.current;
    if (!cursor || !api || !id || pagePending.current) return;
    const scope = requestScope.current;
    const request = page(api, id, cursor, scope);
    pagePending.current = request;
    setLoading(true);
    request.catch(error => {
      if (scope === requestScope.current) {
        prepend.current = null;
        report(error);
      }
    }).finally(() => {
      if (pagePending.current === request) {
        pagePending.current = null;
        setLoading(false);
      }
    });
  }, [cursor, report]);

  function addRows(additions) {
    if (!additions.length) return;
    setRows(previous => {
      const updated = new Map(additions.map(row => [row.id, row]));
      const next = previous.map(row => {
        const value = updated.get(row.id);
        updated.delete(row.id);
        return value ?? row;
      });
      return [...next, ...updated.values()];
    });
  }

  function packetReceived({ id, method, params }) {
    if (params?.threadId !== thread.current || !thread.current) return;
    if (id != null) {
      setQuestion({ id, method, params });
    } else if (method === 'item/agentMessage/delta') {
      const previous = stream.current.get(params.itemId) ?? '';
      stream.current.set(params.itemId, previous + params.delta);
      if (!frame.current) {
        frame.current = requestAnimationFrame(() => {
          frame.current = 0;
          addRows([...stream.current].map(([key, text]) => ({ id: key, kind: 'agent', text })));
        });
      }
    } else if (method === 'item/completed') {
      const row = toRow(params.item);
      if (row && row.kind !== 'user') {
        stream.current.delete(row.id);
        addRows([row]);
      }
    } else if (method === 'item/reasoning/summaryTextDelta') {
      const key = `${params.itemId}:${params.summaryIndex}`;
      setStatus(previous => (previous.startsWith(key + '\n') ? previous : key + '\n') + params.delta);
    } else if (method === 'turn/started') {
      turn.current = params.turn.id;
      setInterruptible(true);
      busy.current = true;
      setRunning(true);
    } else if (method === 'turn/completed') {
      turn.current = null;
      busy.current = false;
      setRunning(false);
      setInterruptible(false);
      setStatus('');
      setQuestion(null);
      if (params.turn.error?.message) setError(params.turn.error.message);
    }
  }

  useEffect(() => {
    window.span.workspace(false).then(settings => setConfig({ ...settings, backend: 'codex', ssh: '' })).catch(report);
    return window.span.onEvent(packet => {
      if (packet.event === 'core-error') setError(packet.data);
    });
  }, [report]);

  useEffect(() => {
    if (!config) return;
    resetThread();
    setError('');
    setConnection('connecting');
    setSessions([]);
    let disposed = false;
    const scope = ++generation;
    const api = connectAgent(scope, packetReceived, () => {
      if (disposed) return;
      busy.current = false;
      turn.current = null;
      setRunning(false);
      setInterruptible(false);
      setStatus('');
      setQuestion(null);
      setConnection('offline');
    });
    agent.current = api;
    async function start() {
      await window.span.request('agent.start', { ...config, generation: scope });
      await api.request('initialize', {
        clientInfo: { name: 'span_web_workbench', title: 'Span Workbench', version: '0.1.0' },
        capabilities: { experimentalApi: true },
      });
      await api.send({ method: 'initialized' });
      const result = await api.request('thread/list', { limit: 40, archived: false });
      if (disposed) return;
      setConnection('ready');
      setSessions(result.data ?? []);
      if (config.demo && result.data?.length) await openSession(api, result.data[0]);
    }
    start().catch(error => {
      if (disposed) return;
      setConnection('offline');
      report(error);
    });
    return () => {
      disposed = true;
      api.close();
      window.span.request('agent.close', { generation: scope }).catch(() => {});
    };
  }, [config, report]);

  useEffect(() => {
    if (tab !== 'files' || !config || config.ssh) return;
    let active = true;
    window.span.request('files.list', { cwd: config.cwd, path: directory }).then(files => {
      if (active) setEntries(files);
    }).catch(error => {
      if (active) report(error);
    });
    return () => { active = false; };
  }, [tab, config, directory, report]);

  async function selectFile(entry) {
    const path = [directory, entry.name].filter(Boolean).join('/');
    if (entry.directory) {
      setEntries([]);
      setDirectory(path);
      return;
    }
    const scope = ++previewScope.current;
    try {
      const result = await window.span.request('files.preview', { cwd: config.cwd, path });
      if (scope === previewScope.current) setPreview({ ...result, path });
    } catch (error) {
      if (scope === previewScope.current) report(error);
    }
  }

  function applyConfig(config) {
    previewScope.current++;
    setPreview(null);
    setEntries([]);
    setDirectory('');
    setConfig(config);
  }

  async function send() {
    const api = agent.current;
    const text = draft.trim();
    if (!text || busy.current || connection !== 'ready' || loading || !api) return;
    setError('');
    busy.current = true;
    follow.current = true;
    setRunning(true);
    const scope = requestScope.current;
    try {
      if (!thread.current) {
        const result = await api.request('thread/start', {
          cwd: config.ssh ? null : config.cwd, approvalPolicy: 'on-request', sandbox: 'workspace-write',
        });
        if (scope !== requestScope.current) return;
        const entry = { id: result.thread.id, name: result.thread.name || text.slice(0, 48) };
        thread.current = entry.id;
        setSession(entry);
        setSessions(previous => [entry, ...previous.filter(item => item.id !== entry.id)]);
      }
      const userId = crypto.randomUUID();
      addRows([{ id: userId, kind: 'user', text }]);
      setDraft('');
      const result = await api.request('turn/start', {
        threadId: thread.current, input: [{ type: 'text', text, text_elements: [] }], summary: 'auto',
      });
      if (scope === requestScope.current && busy.current) {
        turn.current = result.turn.id;
        setInterruptible(true);
      }
    } catch (error) {
      if (scope !== requestScope.current) return;
      busy.current = false;
      turn.current = null;
      setRunning(false);
      setInterruptible(false);
      report(error);
    }
  }

  function answer(result) {
    agent.current.send({ id: question.id, result }).then(() => setQuestion(null)).catch(report);
  }

  return <div className="workbench">
    <header className="topbar">
      <div className="brand"><img src="./span.svg" alt="" /><strong>Span</strong></div>
      <span className="product">工作台预览</span>
      <span className="connection"><i className={connection} />{config?.ssh || '本机'}</span>
      <button className="icon-button terminal-toggle" aria-label="切换终端" title="切换终端"
        aria-pressed={terminal} onClick={() => setTerminal(value => !value)}><SquareTerminal size={19} /></button>
    </header>
    <div className="layout">
      <aside className="sidebar">
        <nav aria-label="工作台">
          {tabs.map(([id, label, Icon]) => <button key={id} aria-pressed={tab === id}
            onClick={() => setTab(id)}><Icon size={15} />{label}</button>)}
        </nav>
        {tab === 'sessions' && <>
          <div className="section-heading"><strong>会话</strong>
            <button className="icon-button" title="新建会话" disabled={running}
              onClick={() => { resetThread(); input.current?.focus(); }}><Plus size={17} /></button>
          </div>
          <div className="side-list">{sessions.map(entry => <button key={entry.id}
            className={session?.id === entry.id ? 'selected' : ''} disabled={running}
            onClick={() => openSession(agent.current, entry)}><MessageSquare size={15} />
            <span>{entry.name || entry.preview || entry.id}</span>
          </button>)}</div>
        </>}
        {tab === 'hosts' && <form className="host-form" onSubmit={event => {
          event.preventDefault();
          if (config) applyConfig({ ...config, backend, ssh: target.trim() });
        }}>
          <label>Agent 后端<select value={backend} onChange={event => setBackend(event.target.value)}>
            <option value="codex">Codex</option><option value="clue">Clue</option>
          </select></label>
          <label>SSH 目标<input value={target} placeholder="别名或 user@host" onChange={event => setTarget(event.target.value)} /></label>
          <button className="primary" disabled={running || !config}>连接{target.trim() ? ' SSH' : '本机'}</button>
        </form>}
        {tab === 'files' && <>
          <div className="section-heading"><strong>文件</strong>
            <button className="icon-button" title="选择本地工作区" disabled={running} onClick={() => {
              window.span.workspace(true).then(cwd => {
                if (cwd) applyConfig({ ...config, cwd, ssh: '' });
              }).catch(report);
            }}><FolderOpen size={17} /></button>
          </div>
          <div className="path" title={config?.cwd}>{config?.ssh ? '预览支持本地文件' : config?.cwd}</div>
          <div className="side-list">{directory && <button onClick={() => {
            setEntries([]);
            setDirectory(directory.split('/').slice(0, -1).join('/'));
          }}><ChevronLeft size={15} /><span>上一级</span></button>}
            {!config?.ssh && entries.map(entry => <button key={entry.name} onClick={() => selectFile(entry)}>
              {entry.directory ? <Folder size={15} /> : <FileText size={15} />}<span>{entry.name}</span>
            </button>)}
          </div>
        </>}
      </aside>
      <main className="main">
        <header className="session-header"><MessageSquare size={17} /><strong>{session?.name || session?.preview || '新会话'}</strong>
          <span>{config?.backend === 'clue' ? 'Clue' : 'Codex'}</span>
        </header>
        {error && <div className="error" role="alert">{error}<button className="icon-button right"
          aria-label="关闭错误提示" onClick={() => setError('')}>×</button></div>}
        <Transcript rows={rows} cursor={cursor} loadOlder={loadOlder} loading={loading} follow={follow} prepend={prepend} />
        <div className="composer-wrap reading-column">
          {running && <div className="live" role="status"><i />{status.split('\n').at(-1)?.replace(/\*\*/g, '') || '正在处理'}</div>}
          {question && <div className="approval">
            <strong>{question.method.endsWith('requestApproval') ? '需要你的确认' : 'Agent 请求输入'}</strong>
            <span>{question.params.command || question.params.reason}</span>
            {question.method.endsWith('requestApproval') ? <div>
              <button className="primary" onClick={() => answer({ decision: 'accept' })}>允许一次</button>
              <button onClick={() => answer({ decision: 'decline' })}>拒绝</button>
            </div> : question.method === 'item/tool/requestUserInput' ? <form onSubmit={event => {
              event.preventDefault();
              const data = new FormData(event.currentTarget);
              answer({ answers: Object.fromEntries(question.params.questions.map(({ id }) => [id, { answers: [data.get(id)] }])) });
            }}>
              {question.params.questions.map(item => <label key={item.id}>{item.question}
                {item.options?.length ? <select name={item.id}>{item.options.map(option =>
                  <option key={option.label}>{option.label}</option>)}</select> : <input required name={item.id} />}
              </label>)}<button className="primary">提交回答</button>
            </form> : <button onClick={() => agent.current.send({ id: question.id,
              error: { code: -32601, message: 'Unsupported request' } }).then(() => setQuestion(null)).catch(report)}>关闭请求</button>}
          </div>}
          <form className="composer" onSubmit={event => { event.preventDefault(); send(); }}>
            <textarea ref={input} rows={2} placeholder="向工作台发送消息…" aria-label="消息"
              value={draft} onChange={event => setDraft(event.target.value)} onKeyDown={event => {
                if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  send();
                }
              }} />
            <div className="composer-bar"><span>{config?.backend === 'clue' ? 'Clue' : 'Codex'} <span>·</span> {config?.ssh || '本机'}</span>
              <button type="button" className="icon-button right" title="滚到最新消息" aria-label="滚到最新消息" onClick={() => {
                follow.current = true;
                const element = document.querySelector('[data-testid=transcript]');
                element.scrollTop = element.scrollHeight;
              }}><ArrowDown size={16} /></button>
              {running ? <button type="button" className="send stop" aria-label="停止" disabled={!interruptible}
                onClick={() => agent.current.request('turn/interrupt', { threadId: thread.current, turnId: turn.current }).catch(report)}><Square size={15} fill="currentColor" /></button>
                : <button className="send" type="submit" aria-label="发送" disabled={!draft.trim() || connection !== 'ready' || loading}><ArrowUp size={19} /></button>}
            </div>
          </form>
        </div>
        {terminal && config && <Suspense fallback={<div className="terminal-panel">正在打开终端…</div>}>
          <TerminalPanel workspace={config.cwd} ssh={config.ssh} renderer={config.terminalRenderer} onClose={closeTerminal} />
        </Suspense>}
      </main>
      {preview && <aside className="preview">
        <header><FileText size={16} /><strong title={preview.path}>{preview.path}</strong>
          <button className="icon-button right" title="关闭预览" onClick={() => {
            previewScope.current++;
            setPreview(null);
          }}><PanelRightClose size={17} /></button>
        </header>
        <div className="preview-content">{preview.kind === 'image' ? <img alt={preview.path} src={`data:${preview.mime};base64,${preview.data}`} />
          : preview.kind === 'markdown' ? <Markdown text={preview.data} /> : <pre>{preview.data}</pre>}</div>
      </aside>}
    </div>
  </div>;
}

createRoot(document.getElementById('root')).render(<App />);
