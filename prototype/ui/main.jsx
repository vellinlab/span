import { lazy, memo, Suspense, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import {
  ArrowUp, ChevronDown, FileText, Folder, FolderOpen,
  Image, PanelLeftClose, PanelLeftOpen, Paperclip, Search, Square, SquarePen, SquareTerminal, X,
} from 'lucide-react';
import { agentBackends, sessionKey, sessionTitle } from './agent.js';
import { agentCommands, commandSuggestions, commonAgentCommands, AgentMenu, AgentPanel, GoalStrip } from './agent-controls.jsx';
import { memberName } from './agent-members.jsx';
import { FileReferenceName, ImageReference } from './file-reference-name.jsx';
import { imageFileName, maxFileReferences } from './file-references.js';
import { Interactions } from './interactions.jsx';
import { FileMarkdown, prepareMarkdown } from './markdown.jsx';
import { ReasoningStrip } from './reasoning.jsx';
import { startupWorkspace } from './recent-workspaces.js';
import { SessionActions } from './session-actions.jsx';
import { SessionCatalog } from './session-catalog.jsx';
import { useCatalogSearch } from './use-catalog-search.js';
import { Sidebar } from './sidebar.jsx';
import { DeferredTranscript, LatestMessageButton, prepareTranscript, transcriptIsAtEnd } from './transcript-navigation.jsx';
import { turnReasoning, turnReasoningRows } from './timeline.js';
import { useAgent } from './use-agent.js';
import { draftKey, useDrafts } from './use-drafts.js';
import { WorkspaceFiles } from './workspace-files.jsx';
import { directoryName, windowsPath } from './workspace-path.js';
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

function workspaceRelativePath(cwd, filename) {
  const windows = windowsPath.test(cwd);
  const slashes = value => windows ? value.replaceAll('\\', '/') : value;
  const path = slashes(filename);
  if (!/^(?:\/|[a-z]:\/)/i.test(path)) return path;
  const root = slashes(cwd).replace(/\/$/, '') + '/';
  const compare = value => windows ? value.toLowerCase() : value;
  return compare(path).startsWith(compare(root)) ? path.slice(root.length) : null;
}

const ComposerInput = memo(function ComposerInput({ input, value, placeholder, suggest, change, keyDown, paste, commandsId, activeCommandId }) {
  return <textarea ref={input} rows={1} placeholder={placeholder} aria-label="消息" value={value}
    aria-autocomplete="list" aria-controls={commandsId} aria-activedescendant={activeCommandId}
    onFocus={() => suggest(true)} onBlur={() => suggest(false)} onChange={change} onKeyDown={keyDown} onPaste={paste} />;
});

function PreviewImage({ blob, name, onError }) {
  const attach = useCallback(image => {
    if (!image) return;
    const url = URL.createObjectURL(blob);
    image.src = url;
    return () => URL.revokeObjectURL(url);
  }, [blob]);
  return <img ref={attach} alt={name} onError={onError} />;
}

function previewPosition(reader) {
  const { scrollTop: top, scrollLeft: left } = reader;
  const position = { top, left };
  const blocks = reader.querySelector(':scope > .prose')?.children;
  if (!top || !blocks?.length) return position;
  const viewportTop = reader.getBoundingClientRect().top;
  let start = 0;
  let end = blocks.length;
  while (start < end) {
    const middle = Math.floor((start + end) / 2);
    if (blocks[middle].getBoundingClientRect().bottom <= viewportTop) start = middle + 1;
    else end = middle;
  }
  const block = blocks[start];
  if (block) position.anchor = { index: start, offset: block.getBoundingClientRect().top - viewportTop, width: reader.clientWidth };
  return position;
}

function restorePreviewPosition(reader, { top, left, anchor }) {
  if (anchor && reader.clientWidth !== anchor.width) {
    const block = reader.querySelector(':scope > .prose')?.children[anchor.index];
    if (block) top = reader.scrollTop + block.getBoundingClientRect().top - reader.getBoundingClientRect().top - anchor.offset;
  }
  reader.scrollTo({ top, left });
}

function App() {
  const [config, setConfig] = useState(null);
  const [workspaceIdentity, setWorkspaceIdentity] = useState(null);
  const [backend, setBackend] = useState('codex');
  const [target, setTarget] = useState('');
  const [connectionCwd, setConnectionCwd] = useState('');
  const [tab, setTab] = useState('sessions');
  const [error, setError] = useState('');
  const [composerFeedback, setComposerFeedback] = useState(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [showLatest, setShowLatest] = useState(false);
  const { drafts, edit, move, clearSent } = useDrafts();
  const [dispatchedDraft, setDispatchedDraft] = useState();
  const [pasting, setPasting] = useState(null);
  const [suggesting, setSuggesting] = useState(false);
  const [commandIndex, setCommandIndex] = useState(0);
  const commandListId = useId();
  const [panel, setPanel] = useState(null);
  const [terminal, setTerminal] = useState('closed');
  const [directory, setDirectory] = useState('');
  const [entries, setEntries] = useState([]);
  const [preview, setPreview] = useState(null);
  const previewOverlay = useSyncExternalStore(subscribePreviewOverlay, isPreviewOverlay);
  const jumpToLatest = useRef(true);
  const input = useRef(null);
  const choosingFiles = useRef(false);
  const search = useRef(null);
  const searchTrigger = useRef(null);
  const archiveTrigger = useRef(null);
  const backendControl = useRef(null);
  const scroll = useRef(null);
  const catalogScroll = useRef({ scope: '', top: 0 });
  const searchScroll = useRef({ scope: '', top: 0 });
  const readingViews = useRef(new Map());
  const previewScope = useRef(0);
  const previewRegion = useRef(null);
  const previewReader = useRef(null);
  const previewTrigger = useRef(null);
  const previewFocus = useRef(null);
  const conversationFocus = useRef(null);
  const directoryLabel = useRef(null);
  const directoryFocus = useRef(false);
  const interactionRegion = useRef(null);
  const reasoningHadFocus = useRef(false);
  const panelScope = useRef(0);
  const panelTrigger = useRef(null);
  const reasoningReturnFocus = useRef(null);
  const composerActions = useRef(null);
  const commandSelection = useRef(null);
  const terminalToggle = useRef(null);
  const terminalFocusRequest = useRef(null);
  const terminalReturnFocus = useRef(null);
  const closeTerminal = useCallback(() => {
    terminalFocusRequest.current = null;
    terminalReturnFocus.current = null;
    setTerminal('closed');
    terminalToggle.current?.focus({ preventScroll: true });
  }, []);
  const report = useCallback(error => setError(error.message), []);
  const clearError = useCallback(() => setError(''), []);
  const returnComposerFocus = useCallback(button => {
    if (!button) return;
    return () => {
      if (button === document.activeElement) input.current?.focus({ preventScroll: true });
    };
  }, []);
  const rememberReadingView = useCallback((key, view) => {
    const recent = readingViews.current;
    recent.delete(key);
    if (view.anchor || view.expansion.length || view.openGroups.length || view.outputPositions.size) recent.set(key, view);
    if (recent.size > 24) recent.delete(recent.keys().next().value);
  }, []);
  const previewCoversConversation = previewOverlay && Boolean(preview && !preview.parked);
  const adoptDraft = useCallback((connection, ref) => move(draftKey(connection), draftKey(connection, ref)), [move]);
  const work = useAgent(config, { report, clearError, adoptDraft, jumpToLatest, suspendTimeline: previewCoversConversation });
  const { api, connection, route, sessions, session, rows, loading, run, goal } = work;
  const hasSession = Boolean(session);
  useEffect(() => {
    if (hasSession) prepareMarkdown().catch(() => {});
  }, [hasSession]);
  const catalogQuery = sidebarOpen && tab === 'sessions' && searchOpen ? query.trim() : '';
  const catalogSearch = useCatalogSearch(api, catalogQuery, work.archived, connection === 'ready', work.catalogRevision);
  const refKey = sessionKey(session?.ref);
  const composerKey = draftKey(config, session?.ref);
  const activeDraft = drafts.get(composerKey);
  const visibleDraft = activeDraft === dispatchedDraft ? undefined : activeDraft;
  const draft = visibleDraft?.text ?? '';
  const files = visibleDraft?.files ?? [];
  const setDraft = text => edit(composerKey, text, files);
  const rememberedReading = readingViews.current.get(refKey);
  const running = run?.status === 'running';
  const interaction = work.requests[0];
  const liveReasoning = turnReasoning(rows, running ? run.id : undefined);
  const showReasoning = Boolean(liveReasoning?.preview && !interaction);
  const reasoningOpen = panel?.kind === 'reasoning';
  const reasoningInSession = reasoningOpen && panel.sessionKey === refKey;
  const keepReasoning = reasoningInSession && connection === 'ready' && !interaction &&
    (!running || run.id === panel.turnId);
  const reasoningArchived = keepReasoning && !running;
  // Keep links mounted until the layout effect can move focus out of the closing panel.
  const reasoningDetails = reasoningInSession ? turnReasoningRows(rows, panel.turnId) : undefined;
  const reasoningExpanded = keepReasoning && panel.turnId === liveReasoning?.turnId;
  const previewBlocked = previewOverlay && Boolean(interaction);
  const readingOverlay = previewCoversConversation && !interaction;
  const terminalVisible = terminal === 'visible' && !readingOverlay;
  const interactionItem = interaction?.itemId && rows.findLast(row => row.id === interaction.itemId && row.turnId === interaction.turnId);
  const canSteer = Boolean(api?.turns.steer && run?.id);
  const canQueue = Boolean(api?.turns.followUp && run?.id);
  const localFiles = Boolean(api?.localFileReferences && window.span.chooseFiles);
  const canSendImages = Boolean(localFiles && api.localImageInputs && !running && selectedModel()?.inputs.includes('image'));
  const canAttach = localFiles && connection === 'ready' && !loading && !interaction && (!running || canSteer || canQueue);
  const pastingScreenshot = pasting === composerKey;
  const canSendDraft = Boolean(draft.trim() || files.length);
  const commands = useMemo(() => agentCommands(api, work.models, work.options), [api, work.models, work.options]);
  const { contextUsed, contextLimit } = work.usage.tokens ?? {};
  const contextPercent = Number.isFinite(contextUsed) && Number.isFinite(contextLimit) && contextLimit > 0
    ? Math.round(100 * contextUsed / contextLimit) : undefined;
  const model = selectedModel();
  const suggestions = suggesting && !files.length && !panel && !interaction && draft.startsWith('/') && !draft.includes('\n')
    ? commandSuggestions(commands, draft, {
      '/model': model?.label,
      '/reasoning': model?.efforts.find(effort => effort.id === (work.options.effort ?? model.defaultEffort))?.label,
      '/fast': work.options.tier === 'priority' || work.options.tier === 'fast' ? '已开启' : undefined,
      '/plan': work.options.mode === 'plan' ? '已开启' : undefined,
      '/compact': contextPercent === undefined ? undefined : `上下文 ${contextPercent}%`,
      '/pin': session?.pinned ? '取消置顶' : undefined,
    }) : [];
  const activeCommand = suggestions.length ? commandIndex % suggestions.length : -1;
  const windowsWorkspace = config?.windows && !config.ssh && !config.demo ? config.cwd : undefined;

  useEffect(() => {
    if (!windowsWorkspace) return;
    let current = true;
    window.span.workspaceIdentity(windowsWorkspace).then(identity => {
      if (current) setWorkspaceIdentity({ cwd: windowsWorkspace, identity });
    }).catch(() => {});
    return () => { current = false; };
  }, [windowsWorkspace]);

  useEffect(() => {
    if (!composerFeedback) return;
    const timer = setTimeout(() => setComposerFeedback(null), 3000);
    return () => clearTimeout(timer);
  }, [composerFeedback]);

  useEffect(() => {
    window.span.workspace(false).then(settings => {
      const initial = startupWorkspace(settings);
      move(draftKey(null), draftKey(initial));
      setConfig(initial);
    }).catch(report);
    return window.span.onEvent(packet => {
      if (packet.event === 'core-error') setError(packet.data);
    }, { events: ['core-error'] });
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

  useLayoutEffect(() => {
    if (!directoryFocus.current) return;
    directoryFocus.current = false;
    directoryLabel.current?.focus({ preventScroll: true });
  }, [directory]);

  useEffect(() => {
    setShowLatest(false);
    setCommandIndex(0);
  }, [refKey]);

  useLayoutEffect(() => {
    const button = commandSelection.current;
    if (!button) return;
    const list = button.parentElement;
    const top = button.offsetTop;
    const bottom = top + button.offsetHeight;
    if (top < list.scrollTop) list.scrollTop = top;
    else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight;
  }, [commandIndex, suggestions.length]);

  useLayoutEffect(() => {
    if (showReasoning && (!reasoningOpen || keepReasoning)) return;
    const region = reasoningOpen ? document.getElementById('reasoning-panel') : null;
    const stripHadFocus = reasoningHadFocus.current;
    reasoningHadFocus.current = false;
    if (keepReasoning) {
      if (stripHadFocus) region?.querySelector('.agent-panel-content')?.focus({ preventScroll: true });
      return;
    }
    const focused = stripHadFocus || region?.contains(document.activeElement);
    if (reasoningOpen) {
      panelScope.current++;
      panelTrigger.current = null;
      setPanel(null);
    }
    if (focused) (interactionRegion.current ?? input.current)?.focus({ preventScroll: true });
  }, [keepReasoning, reasoningOpen, showReasoning]);

  useLayoutEffect(() => {
    const trigger = reasoningReturnFocus.current;
    reasoningReturnFocus.current = null;
    if (!panel && trigger) (trigger.isConnected ? trigger : input.current)?.focus({ preventScroll: true });
  }, [panel]);

  const parkPreview = useCallback(value => {
    const reader = previewReader.current;
    const position = reader && previewPosition(reader);
    const selection = reader?.ownerDocument.getSelection();
    const preserveSelection = selection?.type === 'Range' && selection.containsNode(reader, true);
    setPreview({ ...value, parked: true, position, preserveSelection });
  }, []);

  const restoreMarkdownPosition = useCallback(body => {
    if (body && !preview?.parked && preview?.position) restorePreviewPosition(body.parentElement, preview.position);
  }, [preview?.parked, preview?.position]);

  useLayoutEffect(() => {
    const focus = previewFocus.current;
    previewFocus.current = null;
    if (focus === 'trigger') {
      const trigger = previewTrigger.current;
      previewTrigger.current = null;
      (trigger?.isConnected ? trigger : input.current)?.focus({ preventScroll: true });
    } else if (focus === 'composer') {
      input.current?.focus({ preventScroll: true });
    } else if (focus === 'conversation') {
      const previous = conversationFocus.current?.deref();
      if (previous?.isConnected) previous.focus({ preventScroll: true });
      if (!previous || document.activeElement !== previous) {
        (hasSession ? scroll.current : input.current)?.focus({ preventScroll: true });
      }
    }
    if (!preview || preview.parked) return;
    if (previewBlocked) {
      parkPreview(preview);
      if (previewRegion.current?.contains(document.activeElement)) {
        interactionRegion.current?.focus({ preventScroll: true });
      }
    } else if (focus === 'content' || (readingOverlay && !previewRegion.current?.contains(document.activeElement))) {
      if (focus === 'content' && preview.kind !== 'markdown' && preview.position && previewReader.current) {
        restorePreviewPosition(previewReader.current, preview.position);
      }
      const target = preview.attachment ? '.preview-close' : '.preview-content';
      previewRegion.current?.querySelector(target)?.focus({ preventScroll: true });
    }
  }, [hasSession, parkPreview, preview, previewBlocked, readingOverlay]);

  const loadPreview = useCallback(async (read, path, { attachment = false, root, focus = false } = {}) => {
    const scope = ++previewScope.current;
    const trigger = document.activeElement === document.body ? null : document.activeElement;
    try {
      const result = await read();
      if (result && scope === previewScope.current) {
        const { kind, data, mime } = result;
        const content = kind === 'image' ? { blob: new Blob([Uint8Array.fromBase64(data)], { type: mime }) } : { data };
        previewTrigger.current = trigger;
        if (attachment || (focus && document.activeElement === trigger)) previewFocus.current = 'content';
        setPreview({ kind, ...content, path, scope, attachment, root });
      }
    } catch (error) {
      if (scope === previewScope.current) report(error);
    }
  }, [report]);

  const readPreview = useCallback((cwd, path, focus = false) =>
    loadPreview(() => window.span.request('files.preview', { cwd, path }), path, { root: cwd, focus }), [loadPreview]);

  const previewCwd = session?.cwd || config?.cwd;
  const localArtifactCwd = config?.ssh ? undefined : previewCwd;
  const canPreviewArtifact = useCallback(file => {
    if (!localArtifactCwd || !file.path) return false;
    const path = workspaceRelativePath(localArtifactCwd, file.path);
    if (!path || path.split('/').includes('..')) return false;
    if (imageFileName(path)) return true;
    if (file.kind === 'image') return false;
    const mime = file.mime?.split(';', 1)[0].trim().toLowerCase();
    if (mime && mime !== 'application/octet-stream') {
      return mime.startsWith('text/') || /^application\/(?:[\w.-]+\+)?(?:json|xml)$/.test(mime);
    }
    return !/\.(?:avif|heic|ico|bmp|tiff?|svg|pdf|epub|docx?|xlsx?|pptx?|od[stp]|zip|gz|7z|rar|tar|exe|dll|rpm|deb|mp[34]|mov|avi|mkv|wav|webm|woff2?)$/i.test(path);
  }, [localArtifactCwd]);
  const openImage = useCallback(file => {
    const path = previewCwd && workspaceRelativePath(previewCwd, file.path);
    const read = path
      ? () => window.span.request('files.preview', { cwd: previewCwd, path, imageOnly: true })
      : () => window.span.previewImage(file.path);
    return loadPreview(read, file.name, { attachment: true });
  }, [previewCwd, loadPreview]);
  const previewImage = config?.ssh || !window.span.previewImage ? undefined : openImage;

  const openDirectory = useCallback(path => {
    previewScope.current++;
    directoryFocus.current = true;
    setEntries([]);
    setDirectory(path);
  }, []);

  function selectSidebarTab(next) {
    if (next === tab) return;
    previewScope.current++;
    setTab(next);
  }

  const openArtifact = useCallback(artifact => {
    if (!localArtifactCwd || !artifact.path) {
      report(new Error(`产物位置 · ${artifact.path ?? artifact.name}`));
      return;
    }
    const path = workspaceRelativePath(localArtifactCwd, artifact.path);
    if (path === null) {
      report(new Error(`产物位于工作区之外 · ${artifact.path}`));
      return;
    }
    readPreview(localArtifactCwd, path, true);
  }, [localArtifactCwd, report, readPreview]);

  function closePanel({ restoreFocus = true } = {}) {
    const id = ++panelScope.current;
    const returnTo = panel?.returnTo;
    if (restoreFocus && returnTo && connection === 'ready' && sessionKey(panel.session) === refKey) {
      const { trigger, ...rosterPosition } = returnTo;
      panelTrigger.current = trigger;
      setPanel({ kind: 'agents', id, focus: true, rosterPosition });
      return;
    }
    const trigger = panelTrigger.current;
    panelTrigger.current = null;
    setPanel(null);
    if (restoreFocus && (trigger || document.activeElement?.closest('.agent-panel'))) {
      if (trigger?.matches('.reasoning-strip')) reasoningReturnFocus.current = trigger;
      else (trigger?.isConnected ? trigger : input.current)?.focus({ preventScroll: true });
    }
  }

  function applyConfig(next) {
    if (tab === 'hosts') setTab('sessions');
    if (connection !== 'offline' && next.backend === config?.backend && next.ssh === config.ssh && next.cwd === config.cwd) {
      input.current?.focus();
      return;
    }
    dismissPreview();
    setEntries([]);
    setDirectory('');
    closePanel({ restoreFocus: false });
    if (terminal === 'collapsed' && (next.ssh !== config?.ssh || next.cwd !== config?.cwd)) setTerminal('closed');
    work.prepareConnection();
    setConfig(next);
  }

  function openSearch() {
    setSidebarOpen(true);
    selectSidebarTab('sessions');
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
    closePanel({ restoreFocus: false });
    setTab('sessions');
    if (readingOverlay || preview?.attachment) dismissPreview('composer');
    else {
      previewScope.current++;
      input.current?.focus();
    }
    return true;
  }

  function openSession(entry) {
    const key = sessionKey(entry.ref);
    if (loading || running || connection !== 'ready' || key === refKey) return;
    closePanel({ restoreFocus: false });
    if (readingOverlay || preview?.attachment) dismissPreview();
    else previewScope.current++;
    work.open(entry, readingViews.current.get(key));
  }

  function openMemberTrace(member, trigger) {
    if (!session || loading || connection !== 'ready' || !api?.delegation?.watchTranscript) return;
    const roster = trigger?.closest('.agent-panel[data-kind="agents"] .agent-panel-content');
    const returnTo = roster && { trigger: panelTrigger.current,
      memberId: member.id, scrollTop: roster.scrollTop,
      offset: trigger.getBoundingClientRect().top - roster.getBoundingClientRect().top };
    showPanel('subagent', trigger, { member, session: session.ref, title: memberName(member), returnTo });
  }

  async function forkConversation() {
    if (!await work.fork()) return false;
    closePanel({ restoreFocus: false });
    if (readingOverlay || preview?.attachment) dismissPreview('composer');
    else {
      previewScope.current++;
      input.current?.focus({ preventScroll: true });
    }
    return true;
  }

  const latestWork = useRef();
  latestWork.current = { newSession, openSearch, openSession, openMemberTrace, list: work.list, archived: work.archived, catalogSearch,
    composerKey, draft, visibleDraft, files, canAttach, canSendImages };
  // Keep memoized controls bound to the conversation represented by the committed DOM.
  useLayoutEffect(() => {
    composerActions.current = { setDraft, textareaKey, pasteScreenshot, toggleReasoningPanel, toggleGoalPanel,
      insertTerminalSelection, toggleTerminal, goalAction: work.goalAction, showPanel, showExtensions };
  });
  const openRef = useCallback(ref => latestWork.current.openSession({ ref }), []);
  const openTrace = useCallback((member, trigger) => latestWork.current.openMemberTrace(member, trigger), []);
  const openCatalogSession = useCallback(entry => latestWork.current.openSession(entry), []);
  const changeDraft = useCallback(event => {
    const text = event.target.value;
    const content = text.trimStart();
    if (content && !content.startsWith('/')) prepareTranscript();
    composerActions.current.setDraft(text);
    setSuggesting(true);
    setCommandIndex(0);
  }, []);
  const onDraftKey = useCallback(event => composerActions.current.textareaKey(event), []);
  const onDraftPaste = useCallback(event => composerActions.current.pasteScreenshot(event), []);
  const onTerminalSelection = useCallback(text => composerActions.current.insertTerminalSelection(text), []);
  const onReasoningToggle = useCallback(event => composerActions.current.toggleReasoningPanel(event.currentTarget), []);
  const onGoalToggle = useCallback(event => composerActions.current.toggleGoalPanel(event.currentTarget), []);
  const onGoalAction = useCallback(action => composerActions.current.goalAction(action), []);
  const onAgentMenuSelect = useCallback((kind, trigger) => {
    const { showPanel, showExtensions } = composerActions.current;
    if (kind === 'skill') showExtensions('skill', trigger);
    else showPanel(kind, trigger);
  }, []);
  const loadCatalogPage = useCallback(() => {
    const { list, archived, catalogSearch } = latestWork.current;
    if (catalogSearch) catalogSearch.load?.();
    else list(archived, true).catch(report);
  }, [report]);

  useEffect(() => {
    function onTerminalShortcut(event) {
      if (event.isComposing || event.defaultPrevented || !event.ctrlKey || !event.shiftKey ||
        event.altKey || event.metaKey || event.code !== 'KeyJ') return;
      // Intercept before xterm can treat Ctrl+J as a line feed.
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) composerActions.current.toggleTerminal(true);
    }
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
    window.addEventListener('keydown', onTerminalShortcut, true);
    window.addEventListener('keydown', onShortcut);
    return () => {
      window.removeEventListener('keydown', onTerminalShortcut, true);
      window.removeEventListener('keydown', onShortcut);
    };
  }, []);

  function showPanel(kind, trigger = input.current, options = {}) {
    const id = ++panelScope.current;
    panelTrigger.current = trigger;
    setPanel({ kind, id, focus: Boolean(trigger), ...options });
    setSuggesting(false);
    if (kind === 'usage') work.refreshUsage().catch(report);
  }

  function toggleReasoningPanel(trigger) {
    if (reasoningExpanded) closePanel();
    else showPanel('reasoning', trigger, { sessionKey: refKey, turnId: liveReasoning.turnId });
  }

  function toggleGoalPanel(trigger) {
    if (panel?.kind === 'goal') closePanel();
    else showPanel('goal', trigger);
  }

  function showExtensions(kind, trigger, options = {}) {
    showPanel('extensions', trigger, { extension: kind, title: extensionTitles[kind], ...options,
      load: cursor => work.withSession((client, ref) => client.extensions.list(kind, ref, { cursor, cwd: session?.cwd }),
        { allowEmpty: kind === 'skill' }) });
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

  function togglePreview() {
    previewFocus.current = preview.parked ? 'content' : 'conversation';
    if (preview.parked) setPreview({ ...preview, parked: false });
    else parkPreview(preview);
  }

  function toggleTerminal(moveFocus = false) {
    if (!config) return;
    if (!terminalVisible) {
      const origin = moveFocus ? new WeakRef(document.activeElement ?? document.body) : null;
      terminalReturnFocus.current = origin;
      terminalFocusRequest.current = origin;
      if (readingOverlay) parkPreview(preview);
      setTerminal('visible');
      return;
    }
    terminalFocusRequest.current = null;
    if (moveFocus && document.activeElement?.closest('#workbench-terminal')) {
      const origin = terminalReturnFocus.current?.deref();
      origin?.focus({ preventScroll: true });
      if (document.activeElement !== origin) input.current?.focus({ preventScroll: true });
    }
    terminalReturnFocus.current = null;
    setTerminal('collapsed');
  }

  function showConnection() {
    setBackend(config?.backend ?? 'codex');
    setTarget(config?.ssh ?? '');
    setConnectionCwd(config?.cwd ?? '');
    setSidebarOpen(true);
    selectSidebarTab('hosts');
    requestAnimationFrame(() => backendControl.current?.focus());
  }

  function selectedModel() {
    return work.models.find(model => model.id === work.options.model) ?? work.models.find(model => model.isDefault);
  }

  function effectiveOptions(overrides = {}) {
    const options = { ...work.options, ...overrides };
    if (options.mode && !options.model) options.model = selectedModel()?.id;
    return options;
  }

  async function runCommand(command, args, submitted) {
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
      case '/status': {
        const state = interaction ? (interaction.kind === 'approval' ? '等待审批' : '等待回答') : running ? '运行中' : connectionLabel;
        const context = contextPercent === undefined ? undefined
          : `${contextUsed.toLocaleString('zh-CN')} / ${contextLimit.toLocaleString('zh-CN')}（${contextPercent}%）`;
        const limits = work.usage.limits?.map(limit => `${limit.label} 已用 ${limit.used}%`).join(' · ');
        showPanel('output', input.current, {
          title: '会话状态',
          text: [['会话', sessionTitle(session)], ['会话 ID', session?.ref.id], ['Agent', backendName], ['主机', host],
            ['状态', state], ['传输', routeLabels[route]], ['工作目录', session?.cwd], ['模型', model?.label ?? work.options.model],
            ['运行 ID', run?.id], ['上下文', context], ['账号额度', limits]]
            .filter(([, value]) => value).map(([label, value]) => `${label}  ${value}`).join('\n'),
        });
        return true;
      }
      case '/pwd':
        showPanel('output', input.current, { title: '工作目录', text: session?.cwd ?? (config.ssh ? host : config.cwd) });
        return true;
      case '/copy': {
        if (args && args !== 'markdown' && args !== 'rich') throw new Error('用法 /copy、/copy markdown 或 /copy rich');
        const final = rows.findLast(row => row.kind === 'message' && row.final && (!row.phase || row.phase === 'final'));
        if (!final) throw new Error('当前会话没有可复制的完整回复。');
        const parts = rows.filter(row => row.turnId === final.turnId && row.id === final.id && row.kind === 'message');
        const text = parts.map(row => row.text).join('');
        const scope = work.timelineScope();
        const rich = args === 'rich';
        const copied = rich ? await window.span.copyRich(text) : await window.span.copyText(text);
        if (copied !== false && scope === work.timelineScope()) {
          setComposerFeedback({ scope, text: rich ? '已复制富文本' : '已复制 Markdown' });
        }
        return true;
      }
      case '/goal': {
        if (!args || args === 'status' || args === 'edit') {
          showPanel('goal', input.current, { editGoal: args === 'edit' });
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
        const modes = work.api?.modes ?? [];
        if (!modes.some(mode => mode.id === 'plan')) throw new Error('当前后端没有提供规划模式。');
        const executionMode = modes.find(mode => mode.id === 'default') ?? modes.find(mode => mode.id !== 'plan');
        const mode = !args && work.options.mode === 'plan' && executionMode ? executionMode.id : 'plan';
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
        return forkConversation();
      case '/rename':
        if (!args) { setDraft('/rename '); return false; }
        await work.rename(args);
        return true;
      case '/archive':
        await work.archive();
        return true;
      case '/pin': {
        if (args) throw new Error('用法 /pin');
        const scope = work.timelineScope();
        const pinned = await work.pin();
        if (pinned !== undefined && work.timelineScope() === scope) {
          setComposerFeedback({ scope, text: pinned ? '已置顶会话' : '已取消置顶' });
        }
        return true;
      }
      case '/delete':
        if (args) throw new Error('用法 /delete');
        if (!session) throw new Error('请先打开一个会话。');
        if (running || interaction) throw new Error('请先结束当前任务。');
        if (window.confirm(`永久删除「${sessionTitle(session)}」及其子会话？此操作无法撤销。`)) {
          if (!await work.delete()) return false;
          closePanel({ restoreFocus: false });
          if (readingOverlay || preview?.attachment) dismissPreview('composer');
          else input.current?.focus({ preventScroll: true });
        }
        return true;
      case '/feedback': {
        if (args) throw new Error('用法 /feedback');
        if (!session) throw new Error('请先打开一个会话。');
        const scope = work.timelineScope();
        const id = panelScope.current + 1;
        showPanel('feedback', input.current, { title: '反馈', send: async reason => {
          if (scope !== work.timelineScope() || id !== panelScope.current) return;
          await work.withSession((client, ref) => client.sessions.feedback(ref, reason));
          if (scope !== work.timelineScope() || id !== panelScope.current) return;
          closePanel();
          setComposerFeedback({ scope, text: '反馈已发送' });
        } });
        return true;
      }
      case '/diff': {
        if (args === 'turn' || (!args && !api.repository)) {
          const change = rows.findLast(row => row.kind === 'patch' && (row.text || row.files?.length));
          if (!change) throw new Error('当前会话没有可显示的差异。');
          showPanel('diff', input.current, { title: '最近一次会话补丁', change });
          return true;
        }
        if (args) throw new Error('用法 /diff 或 /diff turn');
        const directory = session?.cwd;
        if (!directory) throw new Error('请先打开一个有工作目录的会话。');
        showPanel('diff', input.current, { directory, loading: true });
        const id = panelScope.current;
        try {
          const result = await work.withSession(client => client.repository.diff(directory));
          if (result && id === panelScope.current) setPanel(panel => ({ ...panel, result, loading: false }));
        } catch (error) {
          if (id === panelScope.current) setPanel(panel => ({ ...panel, error: error.message, loading: false }));
        }
        return true;
      }
      default: {
        const resultTrigger = () => input.current === document.activeElement && latestWork.current.visibleDraft === submitted
          ? input.current : null;
        const kind = extensionCommands[command];
        if (kind && api.extensions?.kinds.includes(kind)) {
          const verbose = kind === 'mcp' && args === 'verbose';
          if (kind === 'mcp' && args && !verbose) throw new Error('用法 /mcp 或 /mcp verbose');
          if (!session && kind !== 'skill') throw new Error('请先打开一个会话。');
          showExtensions(kind, resultTrigger(), { verbose, query: kind === 'skill' ? args.trim() : '' });
          return true;
        }
        if (api.execute && api.commands?.some(item => '/' + item.id === command)) {
          const scope = ++panelScope.current;
          const result = await api.execute(command.slice(1), session?.ref ?? null, args);
          if (result && scope === panelScope.current) showPanel('output', resultTrigger(), { title: result.title, text: result.text });
          return true;
        }
        return false;
      }
    }
  }

  async function submit(raw = draft, delivery = running && !canSteer && canQueue ? 'followUp' : 'steer') {
    const text = raw.trim();
    if ((!text && !files.length) || connection !== 'ready' || loading || pastingScreenshot) return;
    const submitted = raw === draft ? visibleDraft : setDraft(raw);
    const scope = work.timelineScope();
    const followLatest = !running || transcriptIsAtEnd(scroll.current);
    setSuggesting(false);
    const command = text.startsWith('/') && text.match(/^([^\s]+)(?:\s+([\s\S]+))?$/);
    const known = command && (commands.some(([name]) => name === command[1]) ||
      (command[1] === '/diff' && rows.some(row => row.kind === 'patch')));
    let dispatched = false;
    try {
      if (known && files.length) throw new Error('请先移除附件，再运行会话命令。');
      if (!canSendImages && files.some(file => file.kind === 'image')) {
        throw new Error(running ? '请等当前任务结束，再发送图片。' : '当前模型不支持图片。请选择支持图片的模型，或移除图片。');
      }
      const nativePrompt = known && !api.execute && api.commands?.some(item => '/' + item.id === command[1])
        && !commonAgentCommands(api, work.models, work.options).some(([name]) => name === command[1]);
      if (!known || nativePrompt) {
        prepareTranscript();
        prepareMarkdown().catch(() => {});
      }
      const sent = known && !nativePrompt ? await runCommand(command[1], command[2] ?? '', submitted)
        : await work.send(text, effectiveOptions(), delivery, {
          files, followLatest,
          onDispatch() {
            const screenshots = files.filter(file => file.screenshot).map(file => file.path);
            if (screenshots.length) window.span.retainScreenshots(screenshots);
            dispatched = true;
            setComposerFeedback(null);
            setDispatchedDraft(submitted);
          },
        });
      if (sent) {
        clearSent(submitted);
        if (dispatched && running && !followLatest && work.timelineScope() === scope) {
          setComposerFeedback({ scope, text: delivery === 'followUp' ? '已排队' : '已追加' });
        }
      }
    } catch (error) {
      if (work.timelineScope() === scope) report(error);
    } finally {
      if (dispatched) setDispatchedDraft(current => current === submitted ? undefined : current);
    }
  }

  function appendFiles(current, picked) {
    const selected = new Map(current.files.map(file => [file.path, file]));
    for (const file of picked) {
      if (!selected.has(file.path)) selected.set(file.path, {
        ...file, kind: current.canSendImages && imageFileName(file.name) ? 'image' : 'file',
      });
      if (selected.size > maxFileReferences) throw new Error(`最多附加 ${maxFileReferences} 个文件。`);
    }
    const attachments = [...selected.values()];
    edit(current.composerKey, current.draft, [
      ...attachments.filter(file => file.kind !== 'image'),
      ...attachments.filter(file => file.kind === 'image'),
    ]);
  }

  async function addFiles() {
    if (!canAttach || choosingFiles.current) return;
    const scope = work.timelineScope();
    choosingFiles.current = true;
    try {
      const picked = await window.span.chooseFiles();
      const current = latestWork.current;
      if (!picked.length || !current.canAttach || current.composerKey !== composerKey || scope !== work.timelineScope()) return;
      appendFiles(current, picked);
      input.current?.focus();
    } catch (error) {
      if (scope === work.timelineScope()) report(error);
    } finally {
      choosingFiles.current = false;
    }
  }

  async function pasteScreenshot(event) {
    const clipboard = event.clipboardData;
    if (!canAttach || !canSendImages || !window.span.stageScreenshot || clipboard.getData('text/plain')) return;
    const image = [...clipboard.files].find(file => file.type === 'image/png');
    if (!image) return;
    event.preventDefault();
    if (choosingFiles.current) return;
    if (files.length >= maxFileReferences || image.size > 4 * 1024 * 1024) {
      report(new Error(files.length >= maxFileReferences
        ? `最多附加 ${maxFileReferences} 个文件。` : '截图不能超过 4 MiB。'));
      return;
    }
    const scope = work.timelineScope();
    choosingFiles.current = true;
    setPasting(composerKey);
    let staged;
    try {
      staged = await window.span.stageScreenshot(await image.arrayBuffer());
      const current = latestWork.current;
      if (!staged || !current.canAttach || !current.canSendImages ||
        current.composerKey !== composerKey || scope !== work.timelineScope()) return;
      appendFiles(current, [{ ...staged, screenshot: true }]);
      staged = null;
      clearError();
    } catch (error) {
      if (scope === work.timelineScope()) report(error);
    } finally {
      if (staged) window.span.discardScreenshot(staged.path).catch(() => {});
      choosingFiles.current = false;
      setPasting(null);
    }
  }

  function insertTerminalSelection(selection) {
    const field = input.current;
    if (!field) return;
    const text = selection.replace(/\r\n?/g, '\n').replaceAll('\0', '�');
    const { read } = new TextEncoder().encodeInto(text, new Uint8Array(64 * 1024));
    const truncated = read < text.length;
    const cursor = field.selectionEnd;
    const before = cursor ? '\n\n' : '';
    field.setRangeText(before + '[终端选区]\n' + text.slice(0, read) +
      (truncated ? '\n…' : '') + '\n[/终端选区]\n', cursor, cursor, 'end');
    setDraft(field.value);
    field.focus({ preventScroll: true });
    setComposerFeedback({ scope: work.timelineScope(), text: truncated ? '已加入部分终端选区' : '已加入终端选区' });
  }

  function textareaKey(event) {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Escape') {
      setSuggesting(false);
      closePanel({ restoreFocus: false });
      return;
    }
    if (suggestions.length && ['ArrowDown', 'ArrowUp', 'Tab'].includes(event.key)) {
      if (event.key === 'Tab' && event.shiftKey) return;
      event.preventDefault();
      if (event.key === 'Tab') {
        setDraft(suggestions[activeCommand].name + ' ');
        setCommandIndex(0);
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
      if (activeCommand >= 0 && (activeCommand || !suggestions.some(({ name }) => name === draft))) {
        submit(suggestions[activeCommand].name);
      } else {
        submit();
      }
    }
  }

  const cwd = config?.cwd;
  const directorySeparator = directory.lastIndexOf('/');
  const directoryTitle = directory ? directory.slice(directorySeparator + 1) : directoryName(cwd);
  const directoryPath = directory && cwd ? windowsPath.test(cwd)
    ? `${cwd.replace(/[/\\]$/, '')}\\${directory.replaceAll('/', '\\')}`
    : `${cwd.replace(/\/$/, '')}/${directory}` : cwd;
  const parentDirectory = directory.slice(0, Math.max(0, directorySeparator));
  const previewSeparator = preview?.path.lastIndexOf('/') ?? -1;
  const previewName = preview?.path.slice(previewSeparator + 1);
  const previewDirectory = previewSeparator >= 0 ? preview.path.slice(0, previewSeparator) : null;
  const host = config?.ssh || '本机';
  const backendName = agentBackends.find(item => item.id === config?.backend)?.label ?? 'Codex';
  const workspace = directoryName(session?.cwd) || (config?.ssh ? host : directoryName(cwd)) || '工作区';
  const name = sessionTitle(session);
  const branch = session?.branch;
  const workspaceHint = [session?.cwd || cwd, branch && `Git 分支 · ${branch}`].filter(Boolean).join('\n');
  const connectionLabel = connectionLabels[connection];
  const connectionError = connection === 'offline' && error;
  const sessionActions = refKey && (api?.sessions.rename || api?.sessions.fork || api?.sessions.archive);

  async function archiveFromTitle() {
    if (!await work.archive()) return;
    closePanel({ restoreFocus: false });
    if (readingOverlay || preview?.attachment) dismissPreview(archiveTrigger.current ? null : 'composer');
    if (archiveTrigger.current) archiveTrigger.current.focus();
    else if (!readingOverlay && !preview?.attachment) input.current?.focus();
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
        <div className="titlebar-location">
          <div className="breadcrumb">
            <span className="breadcrumb-workspace" title={workspaceHint}>
              <Folder size={15} aria-hidden="true" /><span>{workspace}</span>
            </span>
            <span aria-hidden="true" className="breadcrumb-separator">/</span>
            {sessionActions ? <SessionActions key={refKey} title={name} archived={session.archived}
              disabled={loading || running || Boolean(interaction) || connection !== 'ready'}
              rename={api.sessions.rename && work.rename} fork={api.sessions.fork && forkConversation}
              archive={api.sessions.archive && archiveFromTitle} />
              : <strong title={name}>{name}</strong>}
          </div>
          {branch && <span className="branch" dir="auto" title={branch}>{branch}</span>}
        </div>
        {preview && (preview.parked || readingOverlay) && <button type="button" className="preview-toggle"
          aria-controls="file-preview" title={previewBlocked ? '处理请求后可继续预览' : undefined}
          disabled={previewBlocked} onClick={togglePreview}>{preview.parked ? '继续预览' : '返回会话'}</button>}
        <button ref={terminalToggle} className="icon-button terminal-toggle" aria-label="切换终端" aria-keyshortcuts="Control+Shift+J"
          title={`${terminalVisible ? '收起终端' : terminal === 'closed' ? '打开终端' : '展开终端'} (Ctrl+Shift+J)`}
          aria-controls={terminal === 'closed' ? undefined : 'workbench-terminal'}
          aria-pressed={terminalVisible} onClick={() => toggleTerminal()}><SquareTerminal size={16} /></button>
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
          {tab === 'sessions' && api?.sessions.archive && <button ref={archiveTrigger} className="archive-toggle" type="button"
            disabled={connection !== 'ready'} onClick={() => work.list(!work.archived).catch(report)}>{work.archived ? '查看会话' : '已归档'}</button>}
          <button className="icon-button" aria-label="选择本地工作区" title="选择本地工作区"
            disabled={running || !config} onClick={chooseWorkspace}><FolderOpen size={16} /></button>
        </div>}
        {tab === 'sessions' && <SessionCatalog sessions={sessions} project={config && (config.ssh || cwd || '工作区')}
          projectIdentity={windowsWorkspace && workspaceIdentity?.cwd === cwd ? workspaceIdentity.identity : undefined}
          remote={Boolean(config?.ssh)} scope={JSON.stringify([config?.backend, config?.ssh || cwd])}
          archived={work.archived} pending={work.catalogLoading} query={catalogQuery} selected={refKey}
          disabled={running || loading || connection !== 'ready'} more={Boolean(catalogSearch ? catalogSearch.cursor : work.sessionCursor)}
          searchResult={catalogSearch} open={openCatalogSession} loadMore={loadCatalogPage}
          scrollPosition={catalogQuery ? searchScroll : catalogScroll} />}
        {tab === 'hosts' && <form className="host-form" onSubmit={event => {
          event.preventDefault();
          if (config) applyConfig({ ...config, backend, ssh: target.trim(), cwd: connectionCwd || config.cwd });
        }}>
          <label>Agent 后端<select ref={backendControl} value={backend} onChange={event => setBackend(event.target.value)}>
            {agentBackends.filter(item => item.locations.includes(target.trim() ? 'ssh' : 'local')).map(item =>
              <option key={item.id} value={item.id}>{item.label}</option>)}
          </select></label>
          <label>SSH 目标<input value={target} placeholder="别名或 user@host" onChange={event => setTarget(event.target.value)} /></label>
          {!target.trim() && connectionCwd && <div className="host-workspace">
            <span>本地工作区</span>
            <button type="button" aria-label="选择本地工作区" title={connectionCwd} disabled={running}
              onClick={() => window.span.workspace(true).then(cwd => {
                if (cwd) setConnectionCwd(cwd);
              }).catch(report)}><FolderOpen size={15} /><span>{directoryName(connectionCwd)}</span></button>
          </div>}
          <button className="primary" disabled={running || !config}>连接{target.trim() ? ' SSH' : '本机'}</button>
        </form>}
        {tab === 'files' && <>
          <div className="file-directory" ref={directoryLabel} tabIndex={-1} title={config?.ssh ? undefined : directoryPath}>
            {config?.ssh ? '仅支持预览本地文件' : directoryTitle}
          </div>
          {!config?.ssh && <WorkspaceFiles key={directoryPath} entries={entries} cwd={cwd} directory={directory} parent={parentDirectory}
            preview={preview} openDirectory={openDirectory} openFile={readPreview} />}
        </>}
        <nav className="sidebar-tools" aria-label="工作台面板">
          <button aria-pressed={tab === 'sessions'} onClick={() => selectSidebarTab('sessions')}><SquarePen size={16} />会话</button>
          <button aria-pressed={tab === 'files'} onClick={() => selectSidebarTab('files')}><Folder size={16} />文件</button>
        </nav>
      </Sidebar>}
      <div className="workspace-area" data-preview-overlay={previewOverlay || undefined}>
        <main className="main" inert={readingOverlay}
          onFocusCapture={event => { conversationFocus.current = new WeakRef(event.target); }}>
          <div className={`conversation${rows.length || session || loading ? '' : ' conversation-empty'}`}>
            <div className="transcript-viewport">
              {hasSession || loading || rows.length > 0 ?
                <DeferredTranscript key={refKey} fallback={<div className="timeline" aria-busy="true" />}
                  viewKey={refKey} remembered={rememberedReading} remember={rememberReadingView}
                  rows={rows} cursor={work.cursor} historyCursors={work.historyCursors} loadOlder={work.loadOlder} loading={loading}
                  liveReasoningItem={showReasoning ? liveReasoning.key : undefined} activeTurnId={run?.id} requests={work.requests}
                  jumpToLatest={jumpToLatest} scroll={scroll} showLatest={showLatest} onScrollPosition={setShowLatest} openSession={openRef}
                  openArtifact={openArtifact} canPreviewArtifact={canPreviewArtifact} openImage={previewImage} openTrace={openTrace}
                  canOpenSession={!running && !loading && connection === 'ready'} />
                : <div className="timeline" role="log" aria-label="会话记录" aria-live="off" data-testid="transcript" data-items={0} />}
            </div>
            <div className="composer-wrap reading-column">
              {!rows.length && !session && !loading && !error && <div className="welcome"><h1>开始新会话</h1></div>}
              {error && <div className="error">
                <div className="error-message" role="alert">
                  {connectionError ? <>
                    <strong>无法连接到 {backendName}</strong><details><summary>技术详情</summary><p>{error}</p></details>
                  </> : error}
                </div>
                {connectionError && <>
                  <button type="button" className="retry" onClick={() => {
                    if (config) applyConfig({ ...config });
                  }}>重新连接</button>
                  <button type="button" className="retry" onClick={showConnection}>切换连接</button>
                </>}
                <button className="icon-button" type="button" aria-label="关闭错误提示" onClick={clearError}><X size={16} /></button>
              </div>}
              {loading && !rows.length && <div className="live" role="status"><i />{rememberedReading?.anchor ? '正在恢复阅读位置' : '正在加载会话'}</div>}
              <div className="composer-overlay-anchor" aria-hidden="true" />
              <div className="composer-overlay">
                <AgentPanel panel={panel} work={work} reasoning={reasoningDetails} reasoningArchived={reasoningArchived}
                  reasoningProgress={reasoningExpanded ? liveReasoning : undefined}
                  onClose={closePanel} onGoalAction={onGoalAction} report={report} openSession={openRef} openTrace={openTrace}
                  openArtifact={openArtifact} canPreviewArtifact={canPreviewArtifact} openImage={previewImage} />
                {suggestions.length > 0 && <div className="command-list popup-surface" id={commandListId} role="listbox" aria-label="会话命令">
                  {suggestions.map(({ name, title, Icon, description, detail }, index) => <button type="button" role="option" tabIndex={-1}
                    key={name} id={`${commandListId}-${index}`} ref={index === activeCommand ? commandSelection : undefined}
                    aria-selected={index === activeCommand} onMouseDown={event => event.preventDefault()}
                    onClick={() => submit(name)}>
                    {Icon ? <Icon size={15} aria-hidden="true" /> : <span className="command-icon" aria-hidden="true" />}
                    <span className="command-description"><strong>{title ?? name}</strong><small>{detail ?? description}</small></span>
                    {title && <code>{name}</code>}
                  </button>)}
                </div>}
              </div>
              <Interactions requests={work.requests} respond={work.respond} item={interactionItem} host={host}
                focusTarget={interactionRegion} returnFocus={input} />
              {showReasoning && <ReasoningStrip turnId={liveReasoning.turnId} itemKey={liveReasoning.key}
                preview={liveReasoning.preview} completed={liveReasoning.final}
                expanded={reasoningExpanded} hadFocus={reasoningHadFocus} toggle={onReasoningToggle} />}
              {goal && <GoalStrip ref={returnComposerFocus} objective={goal.objective} status={goal.status}
                activeWithoutTurn={api?.goal?.activeWithoutTurn}
                expanded={panel?.kind === 'goal'} toggle={onGoalToggle} />}
              <form className="composer" onSubmit={event => { event.preventDefault(); submit(); }}>
                {files.length > 0 && <ul className="composer-files" aria-label="待发送的附件">
                  {files.map(file => <li className="file-reference" key={file.path}>
                    {file.kind === 'image' ? <ImageReference file={file} onPreview={previewImage} /> : <>
                      <FileText size={14} aria-hidden="true" /><FileReferenceName name={file.name} path={file.path} />
                    </>}
                    <button type="button" className="attachment-remove" aria-label={'移除附件 · ' + file.name} onClick={() => {
                      edit(composerKey, draft, files.filter(other => other.path !== file.path));
                      if (file.screenshot) window.span.discardScreenshot(file.path).catch(report);
                      input.current?.focus();
                    }}><X size={13} /></button>
                  </li>)}
                </ul>}
                <ComposerInput input={input} value={draft}
                  placeholder={canSteer ? '追加指令…' : canQueue ? '排队跟进…' : session ? '继续这个会话…' : '描述要完成的任务…'}
                  commandsId={activeCommand >= 0 ? commandListId : undefined}
                  activeCommandId={activeCommand >= 0 ? `${commandListId}-${activeCommand}` : undefined}
                  suggest={setSuggesting} change={changeDraft} keyDown={onDraftKey} paste={onDraftPaste} />
                <div className="composer-bar">
                  {localFiles && <button type="button" className="icon-button composer-attach" aria-label="添加本机文件"
                    title={canSendImages ? '添加本机文件，也可在输入框粘贴截图' : '添加本机文件'}
                    disabled={!canAttach || pastingScreenshot} onClick={addFiles}><Paperclip size={16} /></button>}
                  <button type="button" className="composer-control connection" aria-label="主机" data-route={route || undefined}
                    aria-description="切换 Agent 与主机"
                    title={[backendName, host, connectionLabel, routeLabels[route], '切换 Agent 与主机'].filter(Boolean).join(' · ')}
                    onClick={showConnection}>
                    <i className={connection} /><span>{backendName} · {host}</span><ChevronDown size={12} />
                  </button>
                  <span className="composer-status" role="status">{connection !== 'ready' ? connectionLabel :
                    interaction ? interaction.kind === 'approval' ? '等待审批' : '等待回答' :
                      work.stopping ? '正在停止…' : pastingScreenshot ? '正在添加截图' :
                        composerFeedback?.scope === work.timelineScope() ? composerFeedback.text :
                        running && !showReasoning ? '正在处理' : ''}</span>
                  {showLatest && rows.length > 0 && <LatestMessageButton scroll={scroll} className="composer-control"
                    onJump={() => {
                      jumpToLatest.current = true;
                      setShowLatest(false);
                      if (reasoningArchived) closePanel({ restoreFocus: false });
                    }} />}
                  {connection === 'ready' && <AgentMenu api={api} hasGoal={Boolean(goal)} models={work.models}
                    modelId={work.options.model} modeId={work.options.mode} onSelect={onAgentMenuSelect} />}
                  {running && api?.turns.stop && <button ref={returnComposerFocus} type="button" className="send stop" aria-label="停止"
                    aria-disabled={work.stopping || undefined} disabled={!run.id} title={work.stopping ? '正在停止…' : undefined}
                    onClick={() => work.stop().catch(report)}><Square size={13} fill="currentColor" /></button>}
                  {(!running || ((canSteer || canQueue) && canSendDraft)) && <button className="send" type="submit" aria-label={running ? canSteer ? '追加' : '排队' : '发送'}
                    title={canSteer && canQueue ? 'Enter 追加，Alt+Enter 排队' : undefined}
                    disabled={!canSendDraft || connection !== 'ready' || loading || pastingScreenshot}><ArrowUp size={16} /></button>}
                </div>
              </form>
            </div>
          </div>
          {terminal !== 'closed' && config && <Suspense fallback={<div id="workbench-terminal" className="terminal-panel"
            hidden={terminal === 'collapsed'}>正在打开终端…</div>}>
            <TerminalPanel workspace={config.cwd} ssh={config.ssh} renderer={config.terminalRenderer}
              collapsed={terminal === 'collapsed'} covered={readingOverlay} focusRequest={terminalFocusRequest}
              onInsertSelection={onTerminalSelection} onClose={closeTerminal} />
          </Suspense>}
        </main>
        {preview && <aside className="preview" id="file-preview" aria-label="文件预览" hidden={preview.parked} ref={previewRegion}
          onKeyDown={event => {
            if (event.key === 'Escape' && !event.nativeEvent.isComposing) {
              event.preventDefault();
              closePreview();
            }
          }}>
          <header>
            {preview.kind === 'image' ? <Image size={16} aria-hidden="true" /> : <FileText size={16} aria-hidden="true" />}
            <div className="preview-location">
              <strong><FileReferenceName name={previewName} path={preview.path} /></strong>
              {previewDirectory && <span className="preview-directory" title={previewDirectory}>{previewDirectory}</span>}
            </div>
            <button className="icon-button right preview-close" aria-label="关闭预览" title="关闭预览" onClick={closePreview}><X size={16} /></button>
          </header>
          <div className="preview-content" key={preview.scope} ref={previewReader} data-kind={preview.kind} tabIndex={0}>
            {preview.kind === 'image' ? preview.imageError ? <p role="status">无法显示这张图片。</p>
              : !preview.parked && <PreviewImage name={preview.path} blob={preview.blob} onError={() => {
                setPreview(current => current?.scope === preview.scope ? { ...current, blob: undefined, imageError: true } : current);
              }} />
              : preview.kind === 'markdown' ? <FileMarkdown text={preview.data} parked={Boolean(preview.parked)}
                preserveSelection={preview.preserveSelection} onBodyReady={restoreMarkdownPosition} /> : <pre>{preview.data}</pre>}
          </div>
        </aside>}
      </div>
    </div>
  </div>;
}

createRoot(document.getElementById('root')).render(<App />);
