import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import {
  ArrowDown, ArrowUp, ChevronDown, ChevronLeft, FileText, Folder, FolderOpen,
  GitBranch, PanelLeftClose, PanelLeftOpen, Search, Square, SquarePen, SquareTerminal, X,
} from 'lucide-react';
import { agentBackends, sessionKey, sessionTitle } from './agent.js';
import { agentCommands, AgentMenu, AgentPanel, GoalStrip } from './agent-controls.jsx';
import { Interactions } from './interactions.jsx';
import { Markdown } from './markdown.jsx';
import { ReasoningStrip } from './reasoning.jsx';
import { directoryName, SessionCatalog } from './session-catalog.jsx';
import { useCatalogSearch } from './use-catalog-search.js';
import { Sidebar } from './sidebar.jsx';
import { Transcript } from './transcript.jsx';
import { turnReasoning } from './timeline.js';
import { useAgent } from './use-agent.js';
import { draftKey, useDrafts } from './use-drafts.js';
import './workbench.css';

const TerminalPanel = lazy(() => import('./terminal.jsx').then(module => ({ default: module.TerminalPanel })));
const connectionLabels = { ready: '已连接', connecting: '正在连接', offline: '连接断开' };
const routeLabels = { shared: '共享后台', stdio: '独立进程', fixture: '演示数据', remote: '远程服务' };
const extensionCommands = { '/mcp': 'mcp', '/skills': 'skill', '/plugins': 'plugin', '/apps': 'connector', '/tools': 'tool' };
const extensionTitles = { mcp: 'MCP 服务器', skill: '技能', plugin: '插件', connector: '连接器', tool: '工具' };
const previewOverlayQuery = window.matchMedia('(max-width: 1020px)');

function subscribePreviewOverlay(onChange) {
  previewOverlayQuery.addEventListener('change', onChange);
  return () => previewOverlayQuery.removeEventListener('change', onChange);
}

const isPreviewOverlay = () => previewOverlayQuery.matches;

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
  const { drafts, edit, move, clearSent } = useDrafts();
  const [suggesting, setSuggesting] = useState(false);
  const [commandIndex, setCommandIndex] = useState(0);
  const [panel, setPanel] = useState(null);
  const [terminal, setTerminal] = useState(false);
  const [directory, setDirectory] = useState('');
  const [entries, setEntries] = useState([]);
  const [preview, setPreview] = useState(null);
  const previewOverlay = useSyncExternalStore(subscribePreviewOverlay, isPreviewOverlay);
  const jumpToLatest = useRef(true);
  const input = useRef(null);
  const search = useRef(null);
  const searchTrigger = useRef(null);
  const scroll = useRef(null);
  const catalogScroll = useRef({ scope: '', top: 0 });
  const searchScroll = useRef({ scope: '', top: 0 });
  const readingViews = useRef(new Map());
  const previewScope = useRef(0);
  const previewRegion = useRef(null);
  const previewTrigger = useRef(null);
  const previewFocus = useRef(null);
  const interactionRegion = useRef(null);
  const reasoningHadFocus = useRef(false);
  const panelScope = useRef(0);
  const panelTrigger = useRef(null);
  const closeTerminal = useCallback(() => setTerminal(false), []);
  const report = useCallback(error => setError(error.message), []);
  const clearError = useCallback(() => setError(''), []);
  const rememberReadingView = useCallback((key, view) => {
    const recent = readingViews.current;
    recent.delete(key);
    if (view.anchor || view.expansion.length || view.openGroups.length) recent.set(key, view);
    if (recent.size > 24) recent.delete(recent.keys().next().value);
  }, []);
  const previewCoversConversation = previewOverlay && Boolean(preview && !preview.parked);
  const adoptDraft = useCallback((connection, ref) => move(draftKey(connection), draftKey(connection, ref)), [move]);
  const work = useAgent(config, { report, clearError, adoptDraft, jumpToLatest, suspendTimeline: previewCoversConversation });
  const { api, connection, route, sessions, session, rows, loading, run, goal } = work;
  const catalogQuery = sidebarOpen && tab === 'sessions' && searchOpen ? query.trim() : '';
  const catalogSearch = useCatalogSearch(api, catalogQuery, work.archived, connection === 'ready', work.catalogRevision);
  const refKey = sessionKey(session?.ref);
  const composerKey = draftKey(config, session?.ref);
  const activeDraft = drafts.get(composerKey);
  const draft = activeDraft?.text ?? '';
  const setDraft = text => edit(composerKey, text);
  const rememberedReading = readingViews.current.get(refKey);
  const running = run?.status === 'running';
  const interaction = work.requests[0];
  const liveReasoning = turnReasoning(rows, running ? run.id : undefined);
  const showReasoning = Boolean(liveReasoning?.preview && !interaction);
  const reasoningOpen = panel?.kind === 'reasoning';
  const previewBlocked = previewOverlay && Boolean(interaction);
  const readingOverlay = previewCoversConversation && !interaction;
  const interactionItem = interaction?.itemId && rows.findLast(row => row.id === interaction.itemId && row.turnId === interaction.turnId);
  const canSteer = Boolean(api?.turns.steer && run?.id);
  const canQueue = Boolean(api?.turns.followUp && run?.id);
  const commands = agentCommands(api, work.models, work.options);
  const suggestions = suggesting && !panel && !interaction && draft.startsWith('/') && !draft.includes('\n')
    ? commands.filter(([command]) => command.startsWith(draft)).slice(0, 8) : [];

  useEffect(() => {
    window.span.workspace(false).then(settings => {
      const initial = { ...settings, backend: 'codex', ssh: '' };
      move(draftKey(null), draftKey(initial));
      setConfig(initial);
    }).catch(report);
    return window.span.onEvent(packet => {
      if (packet.event === 'core-error') setError(packet.data);
    });
  }, [move, report]);

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

  useLayoutEffect(() => {
    if (showReasoning) return;
    const focused = reasoningHadFocus.current || (reasoningOpen &&
      document.getElementById('reasoning-panel')?.contains(document.activeElement));
    reasoningHadFocus.current = false;
    if (reasoningOpen) {
      panelScope.current++;
      panelTrigger.current = null;
      setPanel(null);
    }
    if (focused) (interactionRegion.current ?? input.current)?.focus({ preventScroll: true });
  }, [reasoningOpen, showReasoning]);

  useLayoutEffect(() => {
    const focus = previewFocus.current;
    previewFocus.current = null;
    if (focus === 'trigger') {
      const trigger = previewTrigger.current;
      previewTrigger.current = null;
      (trigger?.isConnected ? trigger : input.current)?.focus({ preventScroll: true });
    } else if (focus === 'composer') {
      input.current?.focus({ preventScroll: true });
    }
    if (!preview || preview.parked) return;
    if (previewBlocked) {
      setPreview({ ...preview, parked: true });
      if (previewRegion.current?.contains(document.activeElement)) {
        interactionRegion.current?.focus({ preventScroll: true });
      }
    } else if (focus === 'content' || (readingOverlay && !previewRegion.current?.contains(document.activeElement))) {
      previewRegion.current?.querySelector('.preview-content')?.focus({ preventScroll: true });
    }
  }, [preview, previewBlocked, readingOverlay]);

  async function readPreview(cwd, path) {
    const scope = ++previewScope.current;
    const trigger = document.activeElement === document.body ? null : document.activeElement;
    try {
      const result = await window.span.request('files.preview', { cwd, path });
      if (scope === previewScope.current) {
        previewTrigger.current = trigger;
        setPreview({ ...result, path });
      }
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
    dismissPreview();
    setEntries([]);
    setDirectory('');
    closePanel();
    work.prepareConnection();
    setConfig(next);
    if (tab === 'hosts') setTab('sessions');
  }

  function openSearch() {
    setSidebarOpen(true);
    setTab('sessions');
    setSearchOpen(true);
    requestAnimationFrame(() => search.current?.focus());
  }

  function closeSearch() {
    setSearchOpen(false);
    setQuery('');
    searchTrigger.current?.focus();
  }

  function newSession() {
    if (!work.reset()) return false;
    closePanel();
    setTab('sessions');
    if (readingOverlay) dismissPreview('composer');
    else {
      previewScope.current++;
      input.current?.focus();
    }
    return true;
  }

  function openSession(entry) {
    const key = sessionKey(entry.ref);
    if (loading || running || connection !== 'ready' || key === refKey) return;
    closePanel();
    if (readingOverlay) dismissPreview();
    else previewScope.current++;
    work.open(entry, readingViews.current.get(key));
  }

  const latestWork = useRef();
  latestWork.current = { newSession, openSearch, openSession, list: work.list, archived: work.archived, catalogSearch };
  const openRef = useCallback(ref => latestWork.current.openSession({ ref }), []);
  const openCatalogSession = useCallback(entry => latestWork.current.openSession(entry), []);
  const loadCatalogPage = useCallback(() => {
    const { list, archived, catalogSearch } = latestWork.current;
    if (catalogSearch) catalogSearch.load?.();
    else list(archived, true).catch(report);
  }, [report]);

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

  function dismissPreview(focus = null) {
    previewScope.current++;
    previewFocus.current = focus;
    if (focus !== 'trigger') previewTrigger.current = null;
    setPreview(null);
  }

  function closePreview() {
    dismissPreview('trigger');
  }

  function restorePreview() {
    previewFocus.current = 'content';
    setPreview({ ...preview, parked: false });
  }

  function toggleTerminal() {
    if (readingOverlay) {
      setPreview({ ...preview, parked: true });
      setTerminal(true);
    } else setTerminal(value => !value);
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
        await window.span.copyText(parts.map(row => row.text).join(''));
        return true;
      }
      case '/goal': {
        if (!args || args === 'status' || args === 'edit') {
          showPanel('goal');
          if (session) await work.goalAction();
          return true;
        }
        const action = ['pause', 'resume', 'clear'].includes(args) ? { kind: args } : { kind: 'set', objective: args };
        return (await work.goalAction(action)) !== undefined;
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
    const submitted = raw === draft ? activeDraft : setDraft(raw);
    const scope = work.timelineScope();
    setSuggesting(false);
    const command = text.match(/^([^\s]+)(?:\s+([\s\S]+))?$/);
    const known = command && (commands.some(([name]) => name === command[1]) ||
      (command[1] === '/diff' && rows.some(row => row.kind === 'patch')));
    try {
      const sent = known ? await runCommand(command[1], command[2] ?? '')
        : await work.send(text, effectiveOptions(), delivery);
      if (sent) clearSent(submitted);
    } catch (error) {
      if (work.timelineScope() === scope) report(error);
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
        <div className="titlebar-location">
          <div className="breadcrumb"><Folder size={15} /><span title={session?.cwd || cwd}>{workspace}</span>
            <span aria-hidden="true" className="breadcrumb-separator">/</span><strong title={name}>{name}</strong></div>
          {branch && <div className="branch" title={branch}><GitBranch size={13} /><span>{branch}</span></div>}
        </div>
        {preview?.parked && <button className="icon-button" aria-label="恢复文件预览" aria-controls="file-preview"
          title={previewBlocked ? '处理请求后可恢复文件预览' : `恢复文件预览 · ${preview.path}`}
          disabled={previewBlocked} onClick={restorePreview}><FileText size={16} /></button>}
        <button className="icon-button terminal-toggle" aria-label="切换终端" title="切换终端"
          aria-pressed={terminal && !readingOverlay} onClick={toggleTerminal}><SquareTerminal size={16} /></button>
      </div>
    </header>
    <div className="layout">
      {sidebarOpen && <Sidebar>
        <nav className="sidebar-actions" aria-label="会话操作">
          <button disabled={running || loading} onClick={newSession}><SquarePen size={16} />新会话<kbd>Ctrl+N</kbd></button>
          <button ref={searchTrigger} onClick={openSearch}><Search size={16} />搜索<kbd>Ctrl+K</kbd></button>
        </nav>
        {tab === 'sessions' && searchOpen && <div className="session-search">
          <input ref={search} aria-label="搜索会话" placeholder="搜索会话…" defaultValue={query}
            onChange={event => { if (!event.nativeEvent.isComposing) setQuery(event.target.value); }}
            onCompositionEnd={event => setQuery(event.currentTarget.value)} onKeyDown={event => {
              if (event.key === 'Escape' && !event.nativeEvent.isComposing) closeSearch();
            }} />
          <button className="icon-button" aria-label="关闭搜索" onClick={closeSearch}><X size={16} /></button>
        </div>}
        {tab !== 'hosts' && <div className="section-heading"><strong>{tab === 'files' ? '文件' : work.archived ? '已归档' : '工作区'}</strong>
          {tab === 'sessions' && api?.sessions.archive && <button className="archive-toggle" type="button"
            disabled={connection !== 'ready'} onClick={() => work.list(!work.archived).catch(report)}>{work.archived ? '查看会话' : '归档'}</button>}
          <button className="icon-button" aria-label="选择本地工作区" title="选择本地工作区"
            disabled={running || !config} onClick={chooseWorkspace}><FolderOpen size={16} /></button>
        </div>}
        {tab === 'sessions' && <SessionCatalog sessions={sessions} project={config && (config.ssh || cwd || '工作区')}
          scope={JSON.stringify([config?.backend, config?.ssh || cwd])} archived={work.archived} query={catalogQuery} selected={refKey}
          disabled={running || loading || connection !== 'ready'} more={Boolean(catalogSearch ? catalogSearch.cursor : work.sessionCursor)}
          searchResult={catalogSearch} open={openCatalogSession} loadMore={loadCatalogPage}
          scrollPosition={catalogQuery ? searchScroll : catalogScroll} />}
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
      <div className="workspace-area" data-preview-overlay={previewOverlay || undefined}>
        <main className="main" inert={readingOverlay}>
          <div className={`conversation${rows.length || session || loading ? '' : ' conversation-empty'}`}>
            <Transcript key={refKey} viewKey={refKey} remembered={rememberedReading} remember={rememberReadingView}
              rows={rows} cursor={work.cursor} historyPages={work.historyPages} loadOlder={work.loadOlder} loading={loading}
              liveReasoningKey={liveReasoning?.key} activeTurnId={run?.id}
              jumpToLatest={jumpToLatest} scroll={scroll} showLatest={showLatest} onScrollPosition={setShowLatest} openSession={openRef}
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
              {loading && !rows.length && <div className="live" role="status"><i />{rememberedReading?.anchor ? '正在恢复阅读位置' : '正在加载会话'}</div>}
              <div className="composer-overlay">
                <AgentPanel panel={panel} work={work} reasoning={reasoningOpen ? liveReasoning : undefined}
                  setPanel={value => value ? setPanel(value) : closePanel()} report={report} openSession={openRef} />
                {suggestions.length > 0 && <div className="command-list popup-surface" aria-label="会话命令">
                  {suggestions.map(([command, label], index) => <button type="button" key={command}
                    data-active={index === commandIndex % suggestions.length} onMouseDown={event => event.preventDefault()}
                    onClick={() => submit(command)}>
                    <code>{command}</code><span>{label}</span>
                  </button>)}
                </div>}
              </div>
              <Interactions requests={work.requests} respond={work.respond} item={interactionItem} host={host}
                focusTarget={interactionRegion} returnFocus={input} />
              {showReasoning && <ReasoningStrip preview={liveReasoning.preview} expanded={reasoningOpen} hadFocus={reasoningHadFocus}
                toggle={event => reasoningOpen ? closePanel() : showPanel('reasoning', event.currentTarget)} />}
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
                  <span className="composer-status" role="status">{connection !== 'ready' ? connectionLabel :
                    interaction ? interaction.kind === 'approval' ? '等待审批' : '等待回答' : running && !showReasoning ? '正在处理' : ''}</span>
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
            </div>
          </div>
          {terminal && config && <Suspense fallback={<div className="terminal-panel">正在打开终端…</div>}>
            <TerminalPanel workspace={config.cwd} ssh={config.ssh} renderer={config.terminalRenderer} onClose={closeTerminal} />
          </Suspense>}
        </main>
        {preview && <aside className="preview" id="file-preview" aria-label="文件预览" hidden={preview.parked} ref={previewRegion}
          onKeyDown={event => {
            if (event.key === 'Escape' && !event.nativeEvent.isComposing) {
              event.preventDefault();
              closePreview();
            }
          }}>
          <header><FileText size={16} /><strong title={preview.path}>{preview.path}</strong>
            <button className="icon-button right" aria-label="关闭预览" title="关闭预览" onClick={closePreview}><X size={16} /></button>
          </header>
          <div className="preview-content" tabIndex={0}>{preview.kind === 'image' ? <img alt={preview.path} src={`data:${preview.mime};base64,${preview.data}`} />
            : preview.kind === 'markdown' ? <Markdown text={preview.data} /> : <pre>{preview.data}</pre>}</div>
        </aside>}
      </div>
    </div>
  </div>;
}

createRoot(document.getElementById('root')).render(<App />);
