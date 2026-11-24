import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  ArrowDown, ArrowUp, ChevronDown, ChevronLeft, ChevronRight, FileText, Folder, FolderOpen,
  GitBranch, PanelLeftClose, PanelLeftOpen, Search, Square, SquarePen, SquareTerminal, X,
} from 'lucide-react';
import { agentBackends, sessionKey, sessionTitle } from './agent.js';
import { agentCommands, AgentMenu, AgentPanel, GoalStrip, Interactions } from './agent-controls.jsx';
import { Markdown } from './markdown.jsx';
import { Sidebar } from './sidebar.jsx';
import { Transcript } from './transcript.jsx';
import { useAgent } from './use-agent.js';
import './workbench.css';

const TerminalPanel = lazy(() => import('./terminal.jsx').then(module => ({ default: module.TerminalPanel })));
const connectionLabels = { ready: '已连接', connecting: '正在连接', offline: '连接断开' };
const routeLabels = { shared: '共享后台', stdio: '独立进程', fixture: '演示数据', remote: '远程服务' };
const extensionCommands = { '/mcp': 'mcp', '/skills': 'skill', '/plugins': 'plugin', '/apps': 'connector', '/tools': 'tool' };
const extensionTitles = { mcp: 'MCP 服务器', skill: '技能', plugin: '插件', connector: '连接器', tool: '工具' };

function directoryName(path) {
  return path?.split(/[\\/]/).filter(Boolean).at(-1) || path;
}

function App() {
  const [config, setConfig] = useState(null);
  const [backend, setBackend] = useState('codex');
  const [target, setTarget] = useState('');
  const [tab, setTab] = useState('sessions');
  const [error, setError] = useState('');
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [showLatest, setShowLatest] = useState(false);
  const [draft, setDraft] = useState('');
  const [suggesting, setSuggesting] = useState(false);
  const [commandIndex, setCommandIndex] = useState(0);
  const [panel, setPanel] = useState(null);
  const [terminal, setTerminal] = useState(false);
  const [directory, setDirectory] = useState('');
  const [entries, setEntries] = useState([]);
  const [preview, setPreview] = useState(null);
  const jumpToLatest = useRef(true);
  const input = useRef(null);
  const search = useRef(null);
  const scroll = useRef(null);
  const previewScope = useRef(0);
  const panelScope = useRef(0);
  const panelTrigger = useRef(null);
  const closeTerminal = useCallback(() => setTerminal(false), []);
  const report = useCallback(error => setError(error.message), []);
  const clearError = useCallback(() => setError(''), []);
  const work = useAgent(config, { report, clearError, jumpToLatest });
  const { api, connection, route, sessions, session, rows, loading, run, goal } = work;
  const refKey = sessionKey(session?.ref);
  const running = run?.status === 'running';
  const canSteer = Boolean(api?.turns.steer && run?.id);
  const canQueue = Boolean(api?.turns.followUp && run?.id);
  const commands = agentCommands(api, work.models, work.options);
  const suggestions = suggesting && !panel && draft.startsWith('/') && !draft.includes('\n')
    ? commands.filter(([command]) => command.startsWith(draft)).slice(0, 8) : [];

  useEffect(() => {
    window.span.workspace(false).then(settings => setConfig({ ...settings, backend: 'codex', ssh: '' })).catch(report);
    return window.span.onEvent(packet => {
      if (packet.event === 'core-error') setError(packet.data);
    });
  }, [report]);

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

  useEffect(() => {
    setShowLatest(false);
    setCommandIndex(0);
  }, [refKey]);

  async function readPreview(cwd, path) {
    const scope = ++previewScope.current;
    try {
      const result = await window.span.request('files.preview', { cwd, path });
      if (scope === previewScope.current) setPreview({ ...result, path });
    } catch (error) {
      if (scope === previewScope.current) report(error);
    }
  }

  function selectFile(entry) {
    const path = [directory, entry.name].filter(Boolean).join('/');
    if (entry.directory) {
      setEntries([]);
      setDirectory(path);
    } else {
      readPreview(config.cwd, path);
    }
  }

  const openArtifact = useCallback(artifact => {
    const path = artifact.path?.replaceAll('\\', '/');
    const cwd = session?.cwd || config?.cwd;
    if (!cwd || !path || config?.ssh) {
      report(new Error(`产物位置 · ${artifact.path ?? artifact.name}`));
      return;
    }
    const root = cwd.replaceAll('\\', '/').replace(/\/$/, '') + '/';
    const absolute = /^(?:\/|[a-z]:\/)/i.test(path);
    const normalize = value => /^[a-z]:\//i.test(root) ? value.toLowerCase() : value;
    if (absolute && !normalize(path).startsWith(normalize(root))) {
      report(new Error(`产物位于工作区之外 · ${artifact.path}`));
      return;
    }
    readPreview(cwd, absolute ? path.slice(root.length) : path);
  }, [session?.cwd, config, report]);

  function closePanel() {
    panelScope.current++;
    setPanel(null);
    if (panelTrigger.current) {
      (panelTrigger.current.isConnected ? panelTrigger.current : input.current)?.focus();
      panelTrigger.current = null;
    }
  }

  function applyConfig(next) {
    previewScope.current++;
    setPreview(null);
    setEntries([]);
    setDirectory('');
    closePanel();
    setConfig(next);
    if (tab === 'hosts') setTab('sessions');
  }

  function openSearch() {
    setSidebarOpen(true);
    setTab('sessions');
    setSearchOpen(true);
    requestAnimationFrame(() => search.current?.focus());
  }

  function newSession() {
    if (!work.reset()) return false;
    closePanel();
    setTab('sessions');
    input.current?.focus();
    return true;
  }

  function openSession(entry) {
    if (loading || running || connection !== 'ready' || sessionKey(entry.ref) === refKey) return;
    closePanel();
    work.open(entry);
  }

  const latestWork = useRef();
  latestWork.current = { newSession, openSearch, openSession };
  const openRef = useCallback(ref => latestWork.current.openSession({ ref }), []);

  useEffect(() => {
    function onShortcut(event) {
      if (event.isComposing || !(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
      if (event.code === 'KeyN') {
        event.preventDefault();
        latestWork.current.newSession();
      } else if (event.code === 'KeyK') {
        event.preventDefault();
        latestWork.current.openSearch();
      }
    }
    window.addEventListener('keydown', onShortcut);
    return () => window.removeEventListener('keydown', onShortcut);
  }, []);

  function showPanel(kind, trigger = null) {
    panelScope.current++;
    panelTrigger.current = trigger;
    setPanel({ kind, focus: Boolean(trigger) });
    setSuggesting(false);
    if (kind === 'usage') work.refreshUsage().catch(report);
    if (kind === 'agents') work.refreshDelegation().catch(report);
  }

  function output(title, text) {
    panelScope.current++;
    panelTrigger.current = null;
    setPanel({ kind: 'output', title, text });
  }

  function chooseWorkspace() {
    window.span.workspace(true).then(cwd => {
      if (cwd) applyConfig({ ...config, cwd, ssh: '' });
    }).catch(report);
  }

  function closePreview() {
    previewScope.current++;
    setPreview(null);
  }

  function showConnection() {
    setBackend(config?.backend ?? 'codex');
    setTarget(config?.ssh ?? '');
    setSidebarOpen(true);
    setTab('hosts');
  }

  function selectedModel() {
    return work.models.find(model => model.id === work.options.model) ?? work.models.find(model => model.isDefault);
  }

  function effectiveOptions(overrides = {}) {
    const options = { ...work.options, ...overrides };
    if (options.mode && !options.model) options.model = selectedModel()?.id;
    return options;
  }

  async function runCommand(command, args) {
    switch (command) {
      case '/new':
        if (!newSession()) throw new Error('请先结束当前任务。');
        return true;
      case '/resume':
        if (args) {
          if (running) throw new Error('请先结束当前任务。');
          if (/\s/.test(args)) throw new Error('用法 /resume <会话 ID>');
          openSession({ ref: { backend: config.backend, location: config.ssh ? { kind: 'ssh', host: config.ssh } : { kind: 'local' }, id: args } });
        } else {
          openSearch();
        }
        return true;
      case '/status':
        output('会话状态', [sessionTitle(session), host, backendName, connectionLabel, routeLabels[route],
          session?.cwd, work.options.model, run?.id].filter(Boolean).join('\n'));
        return true;
      case '/pwd':
        output('工作目录', session?.cwd ?? (config.ssh ? host : config.cwd));
        return true;
      case '/copy': {
        const final = rows.findLast(row => row.kind === 'message' && row.final && (!row.phase || row.phase === 'final'));
        if (!final) throw new Error('当前会话没有可复制的完整回复。');
        const parts = rows.filter(row => row.turnId === final.turnId && row.id === final.id && row.kind === 'message');
        await navigator.clipboard.writeText(parts.map(row => row.text).join(''));
        return true;
      }
      case '/goal': {
        if (!args || args === 'status' || args === 'edit') {
          showPanel('goal');
          if (session) await work.goalAction();
        } else if (['pause', 'resume', 'clear'].includes(args)) {
          await work.goalAction({ kind: args });
        } else {
          await work.goalAction({ kind: 'set', objective: args });
        }
        return true;
      }
      case '/usage':
        showPanel('usage');
        return true;
      case '/agents':
        showPanel('agents');
        return true;
      case '/model': {
        if (!args) { showPanel('settings'); return true; }
        const model = work.models.find(item => item.id === args || item.label.toLowerCase() === args.toLowerCase());
        if (!model) throw new Error('当前后端没有这个模型。');
        work.setOptions(options => ({ ...options, model: model.id, tier: undefined, effort: undefined }));
        return true;
      }
      case '/reasoning':
        if (!args) { showPanel('settings'); return true; }
        if (!selectedModel()?.efforts.some(item => item.id === args)) throw new Error('这个模型不支持该思考强度。');
        work.setOptions(options => ({ ...options, effort: args }));
        return true;
      case '/fast': {
        const tier = selectedModel()?.tiers.find(item => item.id === 'priority' || item.id === 'fast');
        if (!tier) { showPanel('settings'); return true; }
        work.setOptions(options => ({ ...options, tier: options.tier === tier.id ? 'default' : tier.id }));
        return true;
      }
      case '/plan': {
        if (args && running) throw new Error('请先结束当前任务，再用规划模式发送。');
        const mode = !args && work.options.mode === 'plan' ? 'default' : 'plan';
        work.setOptions(options => ({ ...options, mode }));
        return args ? work.send(args, effectiveOptions({ mode })) : true;
      }
      case '/permissions':
        showPanel('settings');
        return true;
      case '/compact':
        await work.special((client, ref) => client.turns.compact(ref));
        return true;
      case '/review': {
        const [flag, ...value] = args.split(/\s+/);
        const kind = { '--base': 'branch', '--commit': 'commit', '--prompt': 'custom' }[flag];
        if (kind && !value.length) throw new Error(`请为 ${flag} 指定参数。`);
        const target = args ? { kind: kind ?? 'custom', value: kind ? value.join(' ') : args } : { kind: 'worktree' };
        await work.special((client, ref) => client.turns.review(ref, target));
        return true;
      }
      case '/fork':
        if (running) throw new Error('请先结束当前任务。');
        if (!session) throw new Error('请先打开一个会话。');
        await work.fork();
        return true;
      case '/rename':
        if (!args) { setDraft('/rename '); return false; }
        await work.rename(args);
        return true;
      case '/archive':
        await work.archive();
        return true;
      case '/diff': {
        const change = rows.findLast(row => row.kind === 'patch' && (row.text || row.files?.length));
        if (!change) throw new Error('当前会话没有可显示的差异。');
        output('本轮差异', change.text || change.files.map(file => file.diff || file.path).join('\n'));
        return true;
      }
      default: {
        const kind = extensionCommands[command];
        if (kind && api.extensions?.kinds.includes(kind)) {
          const scope = ++panelScope.current;
          const items = await work.withSession((client, ref) => client.extensions.list(kind, ref));
          if (items && scope === panelScope.current) setPanel({ kind: 'extensions', extension: kind, title: extensionTitles[kind], items });
          return true;
        }
        if (api.execute && api.commands?.some(item => '/' + item.id === command)) {
          const scope = ++panelScope.current;
          const result = await api.execute(command.slice(1), session?.ref ?? null, args);
          if (result && scope === panelScope.current) output(result.title, result.text);
          return true;
        }
        return false;
      }
    }
  }

  async function submit(raw = draft, delivery = running && !canSteer && canQueue ? 'followUp' : 'steer') {
    const text = raw.trim();
    if (!text || connection !== 'ready' || loading) return;
    setSuggesting(false);
    const command = text.match(/^([^\s]+)(?:\s+([\s\S]+))?$/);
    const known = command && (commands.some(([name]) => name === command[1]) ||
      (command[1] === '/diff' && rows.some(row => row.kind === 'patch')));
    try {
      const sent = known ? await runCommand(command[1], command[2] ?? '')
        : await work.send(text, effectiveOptions(), delivery);
      if (sent) setDraft(current => current === raw ? '' : current);
    } catch (error) {
      report(error);
    }
  }

  function textareaKey(event) {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Escape') {
      setSuggesting(false);
      closePanel();
      return;
    }
    if (suggestions.length && ['ArrowDown', 'ArrowUp', 'Tab'].includes(event.key)) {
      if (event.key === 'Tab' && event.shiftKey) return;
      event.preventDefault();
      if (event.key === 'Tab') {
        setDraft(suggestions[commandIndex % suggestions.length][0] + ' ');
      } else {
        const step = event.key === 'ArrowDown' ? 1 : -1;
        setCommandIndex(index => (index + step + suggestions.length) % suggestions.length);
      }
      return;
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      if (event.altKey && canQueue) {
        submit(draft, 'followUp');
        return;
      }
      if (suggestions.length && !suggestions.some(([name]) => name === draft)) {
        const name = suggestions[commandIndex % suggestions.length][0];
        setDraft(name);
        submit(name);
      } else {
        submit();
      }
    }
  }

  const cwd = config?.cwd;
  const host = config?.ssh || '本机';
  const backendName = agentBackends.find(item => item.id === config?.backend)?.label ?? 'Codex';
  const workspace = directoryName(session?.cwd) || (config?.ssh ? host : directoryName(cwd)) || '工作区';
  const name = sessionTitle(session);
  const branch = session?.branch;
  const connectionLabel = connectionLabels[connection];
  const connectionError = connection === 'offline' && error;
  const groups = new Map();
  const filter = query.trim().toLocaleLowerCase();
  if (!filter && config && !work.archived) groups.set(config.ssh || cwd || '工作区', []);
  for (const entry of sessions) {
    if (filter && ![sessionTitle(entry), entry.ref.id, entry.cwd].some(value => value?.toLocaleLowerCase().includes(filter))) continue;
    const project = entry.cwd || (config?.ssh ? host : cwd) || '工作区';
    if (!groups.has(project)) groups.set(project, []);
    groups.get(project).push(entry);
  }

  return <div className={`workbench${sidebarOpen ? '' : ' sidebar-collapsed'}`}>
    <header className="topbar">
      <div className="brand">
        <img src="./span.svg" alt="" /><strong>Span</strong>
        <button className="icon-button sidebar-toggle" aria-label={sidebarOpen ? '收起侧栏' : '展开侧栏'}
          aria-expanded={sidebarOpen} aria-controls="workbench-sidebar" onClick={() => setSidebarOpen(value => !value)}>
          {sidebarOpen ? <PanelLeftClose size={16} /> : <PanelLeftOpen size={16} />}
        </button>
      </div>
      <div className="titlebar-content">
        <div className="breadcrumb"><Folder size={15} /><span title={session?.cwd || cwd}>{workspace}</span>
          <span aria-hidden="true" className="breadcrumb-separator">/</span><strong title={name}>{name}</strong></div>
        <button className="icon-button terminal-toggle" aria-label="切换终端" title="切换终端"
          aria-pressed={terminal} onClick={() => setTerminal(value => !value)}><SquareTerminal size={16} /></button>
      </div>
    </header>
    <div className="layout">
      {sidebarOpen && <Sidebar>
        <nav className="sidebar-actions" aria-label="会话操作">
          <button disabled={running || loading} onClick={newSession}><SquarePen size={16} />新会话<kbd>Ctrl+N</kbd></button>
          <button onClick={openSearch}><Search size={16} />搜索<kbd>Ctrl+K</kbd></button>
        </nav>
        {tab === 'sessions' && searchOpen && <div className="session-search">
          <input ref={search} aria-label="搜索会话" placeholder="搜索会话…" value={query}
            onChange={event => setQuery(event.target.value)} onKeyDown={event => {
              if (event.key === 'Escape') { setSearchOpen(false); setQuery(''); }
            }} />
          <button className="icon-button" aria-label="关闭搜索" onClick={() => { setSearchOpen(false); setQuery(''); }}><X size={16} /></button>
        </div>}
        {tab !== 'hosts' && <div className="section-heading"><strong>{tab === 'files' ? '文件' : work.archived ? '已归档' : '工作区'}</strong>
          {tab === 'sessions' && api?.sessions.archive && <button className="archive-toggle" type="button"
            disabled={connection !== 'ready'} onClick={() => work.list(!work.archived).catch(report)}>{work.archived ? '查看会话' : '归档'}</button>}
          <button className="icon-button" aria-label="选择本地工作区" title="选择本地工作区"
            disabled={running || !config} onClick={chooseWorkspace}><FolderOpen size={16} /></button>
        </div>}
        {tab === 'sessions' && <div className="side-list workspaces">{Array.from(groups, ([project, entries]) =>
          <details key={project} className="workspace-group" open>
            <summary title={project}><ChevronRight size={12} className="group-chevron" /><Folder size={15} />
              <span>{directoryName(project)}</span></summary>
            {entries.length > 0 && <div className="session-list">{entries.map(entry =>
              <button key={sessionKey(entry.ref)} aria-current={refKey === sessionKey(entry.ref) ? 'true' : undefined}
                disabled={running || loading || connection !== 'ready'} title={sessionTitle(entry)}
                onClick={() => openSession(entry)}><span>{sessionTitle(entry)}</span></button>
            )}</div>}
          </details>
        )}{!groups.size && (filter || work.archived) && <p className="search-empty">{filter ? '没有匹配的会话' : '没有归档会话'}</p>}
          {work.sessionCursor && <button className="load-more" type="button" onClick={() => work.list(work.archived, true).catch(report)}>加载更多会话</button>}
        </div>}
        {tab === 'hosts' && <form className="host-form" onSubmit={event => {
          event.preventDefault();
          if (config) applyConfig({ ...config, backend, ssh: target.trim() });
        }}>
          <label>Agent 后端<select value={backend} onChange={event => setBackend(event.target.value)}>
            {agentBackends.filter(item => item.locations.includes(target.trim() ? 'ssh' : 'local')).map(item =>
              <option key={item.id} value={item.id}>{item.label}</option>)}
          </select></label>
          <label>SSH 目标<input value={target} placeholder="别名或 user@host" onChange={event => setTarget(event.target.value)} /></label>
          <button className="primary" disabled={running || !config}>连接{target.trim() ? ' SSH' : '本机'}</button>
        </form>}
        {tab === 'files' && <>
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
        <nav className="sidebar-tools" aria-label="工作台面板">
          <button aria-pressed={tab === 'sessions'} onClick={() => setTab('sessions')}><SquarePen size={16} />会话</button>
          <button aria-pressed={tab === 'files'} onClick={() => setTab('files')}><Folder size={16} />文件</button>
        </nav>
      </Sidebar>}
      <div className="workspace-area">
        <main className="main">
          <div className={`conversation${rows.length || session || loading ? '' : ' conversation-empty'}`}>
            <Transcript key={refKey} rows={rows} cursor={work.cursor} loadOlder={work.loadOlder} loading={loading}
              activeTurnId={running ? run.id : undefined}
              jumpToLatest={jumpToLatest} scroll={scroll} onScrollPosition={setShowLatest} openSession={openRef}
              openArtifact={openArtifact} canOpenSession={!running && !loading && connection === 'ready'} />
            <div className="composer-wrap reading-column">
              {!rows.length && !session && !loading && !error && <div className="welcome"><h1>开始新会话</h1></div>}
              {error && <div className="error">
                <div className="error-message" role="alert">
                  {connectionError ? <>
                    <strong>无法连接到 {backendName}</strong><details><summary>技术详情</summary><p>{error}</p></details>
                  </> : error}
                </div>
                {connectionError && <button type="button" className="retry" onClick={() => {
                  if (config) applyConfig({ ...config });
                }}>重新连接</button>}
                <button className="icon-button" type="button" aria-label="关闭错误提示" onClick={clearError}><X size={16} /></button>
              </div>}
              {loading && !rows.length && <div className="live" role="status"><i />正在加载会话</div>}
              <Interactions requests={work.requests} respond={work.respond} report={report} />
              <div className="composer-overlay">
                <AgentPanel panel={panel} work={work} setPanel={value => value ? setPanel(value) : closePanel()} report={report} openSession={openRef} />
                {suggestions.length > 0 && <div className="command-list popup-surface" aria-label="会话命令">
                  {suggestions.map(([command, label], index) => <button type="button" key={command}
                    data-active={index === commandIndex % suggestions.length} onMouseDown={event => event.preventDefault()}
                    onClick={() => { setDraft(command); submit(command); }}>
                    <code>{command}</code><span>{label}</span>
                  </button>)}
                </div>}
              </div>
              <GoalStrip goal={goal} expanded={panel?.kind === 'goal'}
                toggle={event => panel?.kind === 'goal' ? closePanel() : showPanel('goal', event.currentTarget)} />
              <form className="composer" onSubmit={event => { event.preventDefault(); submit(); }}>
                <textarea ref={input} rows={2} placeholder={canSteer ? '追加指令…' : canQueue ? '排队跟进…' : session ? '继续这个会话…' : '向工作台发送消息…'}
                  aria-label="消息" value={draft} onFocus={() => setSuggesting(true)} onBlur={() => setSuggesting(false)}
                  onChange={event => {
                    setDraft(event.target.value);
                    setSuggesting(true);
                    setCommandIndex(0);
                  }} onKeyDown={textareaKey} />
                <div className="composer-bar">
                  <button type="button" className="composer-control connection" aria-label="主机" data-route={route || undefined}
                    title={[backendName, host, connectionLabel, routeLabels[route]].filter(Boolean).join(' · ')}
                    onClick={showConnection}>
                    <i className={connection} /><span>{backendName} · {host}</span><ChevronDown size={12} />
                  </button>
                  <span className="composer-status" role="status">{connection !== 'ready' ? connectionLabel : running ? '正在处理' : ''}</span>
                  {showLatest && rows.length > 0 && <button type="button" className="icon-button jump-latest" title="滚到最新消息" aria-label="滚到最新消息" onClick={() => {
                    scroll.current.scrollTop = scroll.current.scrollHeight;
                  }}><ArrowDown size={16} /></button>}
                  {connection === 'ready' && <AgentMenu work={work} onSelect={showPanel} />}
                  {running && api?.turns.stop && <button type="button" className="send stop" aria-label="停止" disabled={!run.id}
                    onClick={() => work.stop().catch(report)}><Square size={13} fill="currentColor" /></button>}
                  {(!running || ((canSteer || canQueue) && draft.trim())) && <button className="send" type="submit" aria-label={running ? canSteer ? '追加' : '排队' : '发送'}
                    title={canSteer && canQueue ? 'Enter 追加，Alt+Enter 排队' : undefined}
                    disabled={!draft.trim() || connection !== 'ready' || loading}><ArrowUp size={16} /></button>}
                </div>
              </form>
              {branch && <div className="branch" title={branch}><GitBranch size={13} /><span>{branch}</span></div>}
            </div>
          </div>
          {terminal && config && <Suspense fallback={<div className="terminal-panel">正在打开终端…</div>}>
            <TerminalPanel workspace={config.cwd} ssh={config.ssh} renderer={config.terminalRenderer} onClose={closeTerminal} />
          </Suspense>}
        </main>
        {preview && <aside className="preview">
          <header><FileText size={16} /><strong title={preview.path}>{preview.path}</strong>
            <button className="icon-button right" aria-label="关闭预览" title="关闭预览" onClick={closePreview}><X size={16} /></button>
          </header>
          <div className="preview-content">{preview.kind === 'image' ? <img alt={preview.path} src={`data:${preview.mime};base64,${preview.data}`} />
            : preview.kind === 'markdown' ? <Markdown text={preview.data} /> : <pre>{preview.data}</pre>}</div>
        </aside>}
      </div>
    </div>
  </div>;
}

createRoot(document.getElementById('root')).render(<App />);
