import { memo, useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react';
import { defaultRangeExtractor, useVirtualizer } from '@tanstack/react-virtual';
import {
  ArrowDown, ArrowUpRight, Brain, Check, ChevronRight, Circle, CircleAlert, CircleDot, CodeXml, FileCode2, FileText, GitBranch,
  Folder, Image, ListChecks, Search, Terminal, Users, Wrench,
} from 'lucide-react';
import { AgentMemberList, agentStatusLabels as statusLabels, memberName } from './agent-members.jsx';
import { transientAgentStatus } from './delegation.js';
import { FileReferenceName, ImageReference, PathText } from './file-reference-name.jsx';
import { attachmentName } from './file-references.js';
import { Markdown, StreamingMarkdown } from './markdown.jsx';
import { PatchView } from './patch-view.jsx';
import { ReasoningText } from './reasoning.jsx';
import { CopyTextButton, readTextPosition, rememberReaderPosition, TextReader } from './text-reader.jsx';
import { activityFailurePreview, activityStatus, delegatedMembers, groupedTimelineLayout, sameTranscriptRows, timelineLayout, visibleRow } from './timeline.js';

const stepIcons = { completed: Check, running: CircleDot, pending: Circle };

function SourceLink({ url, children }) {
  return <a href={url} onClick={event => {
    event.preventDefault();
    if (/^https?:\/\//i.test(url)) window.span.openLink(url).catch(() => {});
  }}>{children}<ArrowUpRight size={12} /></a>;
}

function ArtifactList({ artifacts, openArtifact, openImage, label }) {
  return <ul className="artifact-list" aria-label={label}>{artifacts.map(file => <li key={file.id}
    className={file.reference ? 'file-reference' : undefined}>
    {file.reference && file.kind === 'image' ? <ImageReference file={file} onPreview={openImage} /> : <>
      {file.kind === 'image' ? <Image size={14} role="img" aria-label="图片" /> : <FileText size={14} aria-hidden="true" />}
      {file.reference ? <FileReferenceName name={file.name} path={file.path} />
        : file.url && /^https?:\/\//i.test(file.url) ? <SourceLink url={file.url}>{file.name}</SourceLink>
        : file.path ? <button type="button" title={file.path} onClick={() => openArtifact(file)}>{file.name}</button>
          : <span title={file.path}>{file.name}</span>}
    </>}
  </li>)}</ul>;
}

const largeOutputSize = 16 * 1024;
const streamedOutputRefreshMs = 64;
const snapshotOutputRefreshMs = 125;

function ToolOutput({ row, positions }) {
  const scroll = useRef(null);
  const streaming = !row.final && row.status === 'running';
  const deferred = useDeferredValue(row);
  const latest = streaming ? deferred : row;
  const committed = useRef({ row: latest, time: -Infinity });
  const [released, setReleased] = useState(-Infinity);
  const previous = committed.current;
  const previousText = previous.row.text;
  const refreshMs = latest.outputChunks ? streamedOutputRefreshMs : snapshotOutputRefreshMs;
  const pending = streaming && previousText?.length > largeOutputSize &&
    latest.text?.length >= previousText.length && latest.text !== previousText &&
    released !== previous.time && performance.now() - previous.time < refreshMs;
  const visible = pending ? previous.row : latest;
  useLayoutEffect(() => {
    if (committed.current.row !== visible) committed.current = { row: visible, time: performance.now() };
  }, [visible]);
  useLayoutEffect(() => () => {
    const position = readTextPosition(scroll.current);
    if (!position) return;
    rememberReaderPosition(positions, row.key, position.page || position.top || position.left ? position : undefined);
  }, [positions, row.key]);
  useEffect(() => {
    if (!pending) return;
    const { time } = previous;
    const timer = setTimeout(() => setReleased(time), Math.max(0, time + refreshMs - performance.now()));
    return () => clearTimeout(timer);
  }, [pending, previous, refreshMs]);
  const text = visible.text || visible.errorMessage;
  const long = text && (text.length > largeOutputSize || text.split('\n', 32).length === 32);
  if (!text) return row.cwd && <PathText className="card-path" path={row.cwd} />;
  const error = Boolean(visible.errorMessage);
  const heading = error ? '错误详情' : '输出';
  return <div className="tool-output" data-error={error || undefined}>
    <div className="tool-output-heading">
      {row.cwd ? <span className="output-directory"><Folder size={13} role="img" aria-label="工作目录" />
        <PathText path={row.cwd} /></span> : <span>{heading}</span>}
      <CopyTextButton text={row.text || row.errorMessage} label={`复制${heading}`} copiedLabel={`已复制${heading}`} />
    </div>
    <TextReader text={text} output={visible.outputChunks} plain={!long} kind="output"
      label={error ? '工具错误' : '工具输出'} pagesLabel="输出分页" position={positions.get(row.key)} scroll={scroll} />
  </div>;
}

function CommandText({ command, titleRef, force }) {
  // Keep the command available until collapse so a resize cannot remove focused text.
  const [truncated, setTruncated] = useState(false);
  const show = force || truncated || /[\r\n\t]| {2}/.test(command);

  useLayoutEffect(() => {
    if (show) return;
    const title = titleRef.current;
    if (!title) return;
    function measure() {
      if (title.scrollWidth <= title.clientWidth) return false;
      setTruncated(true);
      return true;
    }
    if (measure()) return;
    const observer = new ResizeObserver(measure);
    observer.observe(title);
    return () => observer.disconnect();
  }, [command, show, titleRef]);

  return show && <div className="command-source">
    <div className="tool-output-heading"><span>命令</span>
      <CopyTextButton text={command} label="复制命令" copiedLabel="已复制命令" />
    </div>
    <pre className="command-text" tabIndex={0} aria-label="完整命令">{command}</pre>
  </div>;
}

function Card({ icon: Icon, type, title, status, recordedStatus, statusText, statusNote, hint, path, failurePreview,
  revealDiagnostic, expanded, toggle, scroll, reasoningTurn, children }) {
  const titleRef = useRef(null);
  const reveal = useRef(null);
  const trackReasoningFocus = useCallback(element => {
    const timeline = element?.closest('.timeline');
    const viewport = timeline?.parentElement;
    if (!viewport?.matches('.transcript-viewport')) return;
    return () => {
      const document = element.ownerDocument;
      if (!element.contains(document.activeElement)) return;
      // The fixed strip is mounted later in the same commit when an approval ends.
      queueMicrotask(() => {
        if (!timeline.isConnected || document.activeElement !== document.body) return;
        const strip = viewport.parentElement.querySelector('[data-card="live-reasoning"]');
        if (strip?.dataset.turnId === reasoningTurn) strip.focus({ preventScroll: true });
      });
    };
  }, [reasoningTurn]);
  useLayoutEffect(() => {
    const details = reveal.current;
    if (!details) return;
    reveal.current = null;
    const viewport = scroll.current;
    const view = viewport.getBoundingClientRect();
    const heading = details.firstElementChild.getBoundingClientRect();
    if (!expanded) {
      // The focused title can be offscreen when the reader closes a long card with Enter.
      if (heading.top < view.top) viewport.scrollTop += heading.top - view.top - 4;
      else if (heading.bottom > view.bottom) viewport.scrollTop += heading.bottom - view.bottom + 4;
      return;
    }
    const body = details.lastElementChild.getBoundingClientRect();
    // Show a compact diagnostic in full when the viewport has room for its heading and body.
    const fits = revealDiagnostic && body.bottom - heading.top + 4 <= view.height;
    const end = fits ? body.bottom : Math.min(body.bottom, body.top + 44);
    const delta = Math.min(heading.top - view.top, end + 4 - view.bottom);
    if (delta > 1) viewport.scrollTop += delta;
  }, [expanded, revealDiagnostic, scroll]);
  const failed = status === 'failed' && !recordedStatus;
  const CardIcon = failed ? CircleAlert : Icon;
  const statusLabel = statusText ?? (status !== 'completed' ? statusLabels[status] : undefined);
  const name = path && (attachmentName(path.replace(path.startsWith('/') ? /\/+$/ : /[\\/]+$/, '')) || path);
  const head = <><CardIcon size={15} className="card-icon" aria-hidden="true" />
    <span className="card-title" ref={titleRef} title={title}>{title}</span>
    {name ? <FileReferenceName name={name} path={path} /> : hint && <span className="card-hint" title={hint}>{hint}</span>}
    {(statusLabel || statusNote) && <span className="card-status" data-status={status} data-recorded={recordedStatus || undefined}>
      {statusLabel && <span>{statusLabel}</span>}
      {statusLabel && statusNote && <span aria-hidden="true">·</span>}
      {statusNote && <span>{statusNote}</span>}
    </span>}</>;
  return <div className="activity" ref={reasoningTurn ? trackReasoningFocus : undefined} data-card={type} data-failed={failed || undefined}>
    {children ? <details open={expanded} onToggle={event => {
      const details = event.currentTarget;
      if (details.open === expanded) return;
      const focused = details.firstElementChild === details.ownerDocument.activeElement;
      reveal.current = details.open || focused ? details : null;
      toggle(details.open);
    }}>
      <summary><ChevronRight size={13} className="card-chevron" />{head}
        {failurePreview && <bdi className="card-failure-preview" title={failurePreview}>{failurePreview}</bdi>}
      </summary>
      {expanded && <div className="card-body">{children(titleRef)}</div>}
    </details> : <div className="card-heading"><span className="card-placeholder" />{head}</div>}
  </div>;
}

const cardIcons = {
  reasoning: Brain, plan: ListChecks, command: Terminal, patch: FileCode2, tool: Wrench,
  search: Search, delegation: Users, artifact: Image, notice: GitBranch,
};

function delegationStatus(members) {
  for (const status of ['failed', 'running', 'pending', 'cancelled', 'completed', 'unknown']) {
    const matching = members.filter(member => member.status === status);
    if (!matching.length) continue;
    const current = transientAgentStatus(status) ? matching.filter(member => !member.recorded) : matching;
    const recorded = current.length === 0;
    const label = statusLabels[status];
    const text = members.length === 1 ? label : `${(recorded ? matching : current).length} 个${label}`;
    return { status, text: recorded ? `当时${members.length > 1 ? ' ' : ''}${text}` : text, recorded };
  }
  return {};
}

const TranscriptRow = memo(function TranscriptRow({
  row, activePlan, liveDelegation, roster, currentKey, expanded, toggle, openSession, openTrace, openArtifact, openImage, canOpenSession,
  streaming, following, scroll, outputPositions,
}) {
  if (row.kind === 'user') return <div className="user-message" data-attachment-only={(!row.text && !row.queued) || undefined}>
    {row.attachments?.length && row.text ? <span>{row.text}</span> : row.text}
    {row.queued && row.queued !== 'delivered' && <small className="queued-input">
      {row.queued === 'cancelled' ? '已取消排队' : '等待当前任务结束'}
    </small>}{Boolean(row.attachments?.length) && <ArtifactList artifacts={row.attachments} openArtifact={openArtifact}
      openImage={openImage} label="已发送的附件" />}
  </div>;
  if (row.kind === 'message') return <div className={row.phase === 'commentary' ? 'agent-commentary' : 'agent-reply'}>
    <StreamingMarkdown text={row.text} streaming={streaming} following={following} scroll={scroll} />
  </div>;

  let title, hint, path, detail, recordedStatus, statusText, statusNote;
  let status = activityStatus(row);
  switch (row.kind) {
    case 'reasoning':
      title = '推理摘要';
      if (!expanded) hint = row.preview;
      detail = () => <ReasoningText rows={[row]} />;
      break;
    case 'plan':
      title = row.steps?.length ? '任务计划' : '规划草案';
      if (row.steps?.length) {
        statusNote = `已完成 ${row.steps.filter(step => step.status === 'completed').length}/${row.steps.length}`;
        if (activePlan && !expanded) hint = row.steps.find(step => step.status === 'running')?.text;
      }
      detail = () => <>
        {row.text && <Markdown text={row.text} />}
        {Boolean(row.steps?.length) && <ol className="plan-list" aria-label="计划步骤" tabIndex={0}>
          {row.steps.map((step, index) => {
            const state = activePlan || step.status === 'completed' ? step.status : 'pending';
            const label = !activePlan && state === 'pending' ? '未完成' : statusLabels[state] ?? statusLabels.unknown;
            const StepIcon = stepIcons[state] ?? Circle;
            return <li key={index} data-status={state}>
              <span className="plan-step-icon" role="img" aria-label={label}><StepIcon size={14} aria-hidden="true" /></span>
              <Markdown text={step.text} />
            </li>;
          })}
        </ol>}
      </>;
      break;
    case 'command': {
      const command = row.command;
      const hasContext = Boolean(row.text || row.cwd);
      const firstBreak = command?.search(/[\r\n]/) ?? -1;
      title = firstBreak < 0 ? command || '执行命令' : `${command.slice(0, firstBreak).trimEnd() || '执行命令'} …`;
      if (row.exitCode != null && row.exitCode !== 0) {
        statusNote = `退出码 ${row.exitCode}`;
      }
      if (command || hasContext) detail = titleRef => <>
        {command && <CommandText command={command} titleRef={titleRef} force={!hasContext} />}
        {hasContext && <ToolOutput row={row} positions={outputPositions} />}
      </>;
      break;
    }
    case 'patch':
      title = row.files?.length ? '文件变更' : '本轮差异';
      if (!expanded && row.files?.length === 1) path = row.files[0].path;
      else if (row.files?.length > 1) hint = `${row.files.length} 个文件`;
      detail = () => <PatchView files={row.files ?? []} text={row.text} viewKey={row.key} viewPositions={outputPositions} />;
      break;
    case 'tool': {
      title = row.name || '调用工具';
      hint = row.query ? (expanded ? undefined : row.query) : row.source;
      const targetPath = row.target?.kind === 'path' ? row.target.path : undefined;
      if (!row.query) path = targetPath;
      if (targetPath || row.query || row.text || row.errorMessage) detail = () => <>
        {(targetPath || row.query) && <dl className="tool-context">
          {row.query && <><dt>匹配规则</dt><dd><PathText path={row.query} /></dd></>}
          {targetPath && <><dt>{row.query ? '搜索目录' : '路径'}</dt><dd><PathText path={targetPath} /></dd></>}
          {row.source && <><dt>来源</dt><dd>{row.source}</dd></>}
        </dl>}
        {(row.text || row.errorMessage) && <ToolOutput row={row} positions={outputPositions} />}
      </>;
      break;
    }
    case 'search':
      title = row.query;
      if (row.url || row.text) detail = () => <>{row.url && <SourceLink url={row.url}>{row.url}</SourceLink>}
        {row.text && <ToolOutput row={row} positions={outputPositions} />}</>;
      break;
    case 'delegation': {
      title = row.action;
      const members = (row.members ?? []).map(member => {
        const known = roster.get(member.id);
        return { ...member, name: member.name || known?.name, role: member.role || known?.role,
          model: member.model || known?.model, session: member.session ?? known?.session,
          recorded: !liveDelegation || Boolean(known?.status && known.status !== member.status) };
      });
      if (!expanded && members.length) hint = members.length === 1 ? memberName(members[0]) : `${members.length} 个代理`;
      const aggregate = delegationStatus(members);
      if (!status || status === 'completed' || (status === 'running' && aggregate.status === 'failed')) {
        status = aggregate.status ?? status;
        statusText = aggregate.text;
        recordedStatus = aggregate.recorded;
      } else if (!liveDelegation && transientAgentStatus(status)) {
        recordedStatus = true;
        statusText = `当时${statusLabels[status]}`;
      }
      if (expanded && members.length === 1 && status === aggregate.status &&
        Boolean(recordedStatus) === Boolean(aggregate.recorded)) statusText = '';
      if (members.length || row.text) detail = () => <>
        {row.text && <Markdown text={row.text} />}
        {members.length > 0 && <AgentMemberList members={members} currentKey={currentKey}
          openSession={openSession} canOpenSession={canOpenSession} openTrace={openTrace} showDetail />}
      </>;
      break;
    }
    case 'artifact':
      title = '产物';
      detail = () => <ArtifactList artifacts={row.artifacts} openArtifact={openArtifact} />;
      break;
    case 'notice':
      title = row.title;
      if (row.text) {
        if (!expanded) hint = row.text;
        detail = () => <Markdown text={row.text} />;
      }
      break;
  }

  const icon = row.kind === 'tool' && row.query ? Search : cardIcons[row.kind] ?? CodeXml;
  return <Card type={row.kind} icon={icon} status={status} recordedStatus={recordedStatus}
    statusText={statusText} statusNote={statusNote} failurePreview={expanded ? undefined : activityFailurePreview(row, status)}
    revealDiagnostic={row.kind === 'tool' && status === 'failed' && Boolean(row.errorMessage)}
    title={title} hint={hint} path={path} expanded={expanded} scroll={scroll}
    reasoningTurn={row.kind === 'reasoning' ? row.turnId : undefined} toggle={open => toggle(row.key, open)}>{detail}</Card>;
});

const ActivityGroup = memo(function ActivityGroup({ group, open, toggle, releaseAnchor }) {
  const count = group.end - group.start;
  const tools = count - group.commands;
  const Icon = tools ? Wrench : Terminal;
  const label = tools ? `${group.commands ? `${group.commands} 条命令 · ` : ''}${tools} 次工具调用`
    : `${count} 条命令`;
  return <div className="activity" data-card="activity-group">
    <button type="button" className="card-heading" aria-expanded={open}
      onClick={event => toggle(group.key, !open, event.currentTarget)} onBlur={releaseAnchor}>
      <ChevronRight size={13} className="card-chevron" /><Icon size={15} className="card-icon" />
      <span className="card-title">{label}</span>
    </button>
  </div>;
});

function firstVisibleMessage(element, viewport) {
  for (const item of element.querySelectorAll('.message[data-empty="false"]')) {
    const content = item.firstElementChild?.getBoundingClientRect();
    if (content && content.bottom > viewport.top && content.top < viewport.bottom) return item;
  }
}

export function transcriptIsAtEnd(element) {
  return element.scrollHeight - element.clientHeight - element.scrollTop < 40;
}

export function LatestMessageButton({ scroll, className, label = '滚到最新消息', onJump }) {
  return <button type="button" className={`jump-latest ${className}`} title={label} aria-label={label} onClick={() => {
    onJump?.();
    const timeline = scroll.current;
    timeline.scrollTop = timeline.scrollHeight;
    timeline.focus({ preventScroll: true });
  }}><ArrowDown size={15} aria-hidden="true" /><span>最新消息</span></button>;
}

function readAnchor(element, rows, layout) {
  if (transcriptIsAtEnd(element)) return;
  const viewport = element.getBoundingClientRect();
  const item = firstVisibleMessage(element, viewport);
  if (item) {
    const { key, itemKey, turnId } = layout.rowAt(rows, Number(item.dataset.index));
    return { key, itemKey, turnId, top: item.getBoundingClientRect().top - viewport.top };
  }
}

function readTextAnchor(element) {
  const viewport = element.getBoundingClientRect();
  const prose = firstVisibleMessage(element, viewport)?.querySelector('.prose');
  const bounds = prose?.getBoundingClientRect();
  if (!bounds || bounds.top >= viewport.top || bounds.bottom <= viewport.top) return;
  for (const offset of [1, 13, 25]) {
    const range = element.ownerDocument.caretRangeFromPoint(bounds.left + 2, viewport.top + offset);
    if (range?.startContainer.nodeType !== Node.TEXT_NODE || !prose.contains(range.startContainer)) continue;
    const line = range.getBoundingClientRect();
    if (line.height && line.bottom > viewport.top && line.top < viewport.bottom) {
      return { range, top: line.top - viewport.top, scrollTop: element.scrollTop };
    }
  }
}

function anchorIndex(rows, layout, anchor, reasoningTurn) {
  let fallback = -1;
  for (let index = 0; index < layout.count; index++) {
    const row = layout.rowAt(rows, index);
    if (row.turnId !== anchor.turnId || (row.kind === 'reasoning' && row.turnId === reasoningTurn) || !visibleRow(row)) continue;
    if (row.key === anchor.key || row.key === anchor.itemKey) return index;
    if (fallback === -1) fallback = index;
  }
  return fallback;
}

function sameTranscriptProps(previous, next) {
  const keys = Object.keys(next);
  return keys.length === Object.keys(previous).length && keys.every(key => Object.hasOwn(previous, key) && (
    Object.is(previous[key], next[key]) || (key === 'rows' && !next.jumpToLatest.current &&
      sameTranscriptRows(previous.rows, next.rows, next.liveReasoningTurn))));
}

export const Transcript = memo(function Transcript({
  rows, liveReasoningTurn, activeTurnId, viewKey, remembered, remember, historyPages, cursor, loadOlder, loading, jumpToLatest, scroll,
  onScrollPosition, openSession, openTrace, openArtifact, openImage, canOpenSession, showLatest,
  label = '会话记录', testId = 'transcript',
}) {
  const expanded = useRef(null);
  if (!expanded.current) expanded.current = new Map(remembered?.expansion);
  const outputPositions = useRef(null);
  if (!outputPositions.current) outputPositions.current = new Map(remembered?.outputPositions);
  const ungroupedTurns = useRef(null);
  if (!ungroupedTurns.current) ungroupedTurns.current = new Set(remembered?.ungroupedTurns);
  const [openGroups, setOpenGroups] = useState(() => new Set(remembered?.openGroups));
  const [restore, setRestore] = useState(remembered?.anchor);
  const [liveTurnId, setLiveTurnId] = useState(activeTurnId);
  const [inspectedCard, setInspectedCard] = useState(null);
  const latest = useRef(null);
  const following = useRef(true);
  const followAfterFold = useRef(false);
  const viewportSize = useRef(null);
  const [, updateExpansion] = useReducer(version => version + 1, 0);
  const inspect = useCallback((key, open) => {
    if (open) {
      following.current = false;
      setInspectedCard(key);
    } else if (!open && inspectedCard === key) {
      following.current = transcriptIsAtEnd(scroll.current);
      setInspectedCard(null);
    }
  }, [inspectedCard, scroll]);
  const toggle = useCallback((key, open) => {
    inspect(key, open);
    expanded.current.delete(key);
    expanded.current.set(key, open);
    updateExpansion();
  }, [inspect]);
  const rawLayout = timelineLayout(rows);
  const layout = useMemo(() => groupedTimelineLayout(rawLayout, liveTurnId, ungroupedTurns.current, openGroups),
    [rawLayout, liveTurnId, openGroups]);
  const target = restore && !loading ? anchorIndex(rows, layout, restore, liveReasoningTurn) : -1;
  const estimate = useCallback(index => layout.estimateSize(index, liveReasoningTurn), [layout, liveReasoningTurn]);
  const rangeExtractor = useCallback(range => {
    const indexes = defaultRangeExtractor(range);
    if (target < indexes[0]) return [target, ...indexes];
    if (target > indexes.at(-1)) return [...indexes, target];
    return indexes;
  }, [target]);
  const virtual = useVirtualizer({
    count: layout.count, getScrollElement: () => scroll.current,
    getItemKey: layout.getItemKey, estimateSize: liveReasoningTurn ? estimate : layout.estimateSize,
    rangeExtractor: target >= 0 ? rangeExtractor : defaultRangeExtractor,
    overscan: 6, paddingStart: 20, paddingEnd: 14,
    anchorTo: 'end', followOnAppend: true,
    // Keep prepend anchoring when the reader has paused following to inspect a card.
    scrollEndThreshold: inspectedCard ? -1 : 40,
  });
  const virtualRows = virtual.getVirtualItems();
  const height = virtual.getTotalSize();

  const releaseGroupAnchor = useCallback(() => {
    virtual.shouldAdjustScrollPositionOnItemSizeChange = undefined;
  }, [virtual]);
  const toggleGroup = useCallback((key, open, button) => {
    const groupRow = button.closest('.message');
    // Resizes between the viewport's top and the selected group also move its title.
    virtual.shouldAdjustScrollPositionOnItemSizeChange = item => item.index < Number(groupRow.dataset.index);
    inspect(key, open);
    setOpenGroups(previous => {
      const next = new Set(previous);
      if (open) next.add(key);
      else next.delete(key);
      return next;
    });
  }, [inspect, virtual]);

  useLayoutEffect(() => {
    if (inspectedCard) onScrollPosition(virtual.getDistanceFromEnd() >= 40);
  }, [inspectedCard, height, onScrollPosition, virtual]);

  useLayoutEffect(() => {
    latest.current = { rows, layout, historyPages, restore, openGroups };
  }, [rows, layout, historyPages, restore, openGroups]);

  useLayoutEffect(() => {
    if (restore || !jumpToLatest.current || !rows.length) return;
    jumpToLatest.current = false;
    following.current = true;
    releaseGroupAnchor();
    setInspectedCard(null);
    virtual.scrollToEnd();
    onScrollPosition(false);
  }, [rows, virtual, jumpToLatest, onScrollPosition, restore, releaseGroupAnchor]);

  useLayoutEffect(() => {
    if (liveTurnId === activeTurnId) {
      if (followAfterFold.current) {
        followAfterFold.current = false;
        virtual.scrollToEnd();
      }
      return;
    }
    if (liveTurnId) {
      const { layout, rows } = latest.current;
      const element = scroll.current;
      const viewport = following.current ? null : element.getBoundingClientRect();
      const focus = element.ownerDocument.activeElement;
      const selection = element.ownerDocument.getSelection();
      const selecting = selection?.type === 'Range';
      const groups = rawLayout.groups.filter(group => group.turnId === liveTurnId);
      // Leave an inspected turn intact. Reflowing cards can move the point the user is reading.
      const focusedActivity = focus?.closest('.message:is([data-kind="command"], [data-kind="tool"])');
      const openActivity = expanded.current.size && rows.some(row => row.turnId === liveTurnId &&
        (row.kind === 'command' || row.kind === 'tool') && expanded.current.get(row.key));
      if (viewport || element.contains(focusedActivity) || (selecting && selection.containsNode(element, true)) || openActivity) {
        ungroupedTurns.current.add(liveTurnId);
      } else if (groups.length) {
        followAfterFold.current = true;
      }

      // Inspect the existing body before applying the collapsed default for an inactive turn.
      for (const body of element.querySelectorAll('.message[data-kind="plan"] .card-body')) {
        const row = layout.rowAt(rows, Number(body.closest('.message').dataset.index));
        if (row?.turnId !== liveTurnId || expanded.current.has(row.key)) continue;
        const rect = viewport && body.getBoundingClientRect();
        if ((rect && rect.bottom > viewport.top && rect.top < viewport.bottom) || body.contains(focus) ||
          (selecting && selection.containsNode(body, true))) {
          expanded.current.set(row.key, true);
        } else if (following.current && row.steps?.length) {
          followAfterFold.current = true;
        }
      }
    }
    setLiveTurnId(activeTurnId);
  }, [activeTurnId, liveTurnId, rawLayout, scroll, virtual]);

  useLayoutEffect(() => {
    if (!remember) return;
    const element = scroll.current;
    return () => {
      const current = latest.current;
      if (!viewKey || current?.restore || !current?.rows.length) return;
      const anchor = readAnchor(element, current.rows, current.layout);
      // Open outputs record their position during child layout cleanup.
      remember(viewKey, { anchor, pages: current.historyPages, expansion: Array.from(expanded.current).slice(-64),
        openGroups: Array.from(current.openGroups).slice(-64), outputPositions: outputPositions.current,
        ungroupedTurns: anchor && ungroupedTurns.current.has(anchor.turnId) ? [anchor.turnId] : [] });
    };
  }, [viewKey, remember, scroll]);

  useLayoutEffect(() => {
    if (!restore || loading || !rows.length) return;
    const element = scroll.current;
    const item = target >= 0 && element.querySelector(`.message[data-index="${target}"]`);
    if (!item) {
      setRestore(undefined);
      return;
    }
    let frame;
    following.current = false;
    function align(attempts) {
      const rect = item.getBoundingClientRect();
      const top = Math.max(restore.top, 1 - rect.height);
      const delta = rect.top - element.getBoundingClientRect().top - top;
      if (Math.abs(delta) > 1) virtual.scrollToOffset(element.scrollTop + delta);
      // Nearby rows can be measured for the first time after the initial scroll.
      if (attempts) frame = requestAnimationFrame(() => align(attempts - 1));
      else {
        jumpToLatest.current = false;
        following.current = transcriptIsAtEnd(element);
        onScrollPosition(!following.current);
        setRestore(undefined);
      }
    }
    align(2);
    return () => cancelAnimationFrame(frame);
  }, [layout.count, virtual, jumpToLatest, scroll, onScrollPosition, restore, loading, target]);

  useLayoutEffect(() => {
    const element = scroll.current;
    const columnWidth = () => element.firstElementChild?.getBoundingClientRect().width;
    viewportSize.current = { height: element.clientHeight, width: element.clientWidth };
    let readingWidth = columnWidth();
    let anchor;
    const rememberPosition = () => {
      anchor = following.current || latest.current?.restore ? undefined : readTextAnchor(element);
    };
    element.addEventListener('scrollend', rememberPosition);
    const observer = new ResizeObserver(() => {
      const previous = viewportSize.current;
      const height = element.clientHeight;
      viewportSize.current = { height, width: element.clientWidth };
      const width = columnWidth();
      const rewrap = width !== readingWidth;
      readingWidth = width;
      if (following.current && virtual.options.count && (height !== previous.height || rewrap)) virtual.scrollToEnd();
      if (!rewrap || following.current || latest.current?.restore || !anchor ||
        element.scrollTop !== anchor.scrollTop || anchor.range.startContainer.nodeType !== Node.TEXT_NODE ||
        !element.contains(anchor.range.startContainer)) return;
      // The virtualizer can preserve the row, while the first visible line moves inside it.
      const line = anchor.range.getBoundingClientRect();
      if (!line.height) return;
      const delta = line.top - element.getBoundingClientRect().top - anchor.top;
      if (Math.abs(delta) > 1) {
        element.scrollTop += delta;
        anchor.scrollTop = element.scrollTop;
      }
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
      element.removeEventListener('scrollend', rememberPosition);
    };
  }, [scroll, virtual]);

  function onScroll(event) {
    if (restore) return;
    const element = scroll.current;
    // A resize can scroll the list before its observer has restored the viewport.
    const size = viewportSize.current;
    if (element.clientHeight !== size?.height || element.clientWidth !== size.width) return;
    const atBottom = transcriptIsAtEnd(element);
    following.current = atBottom;
    if (atBottom && inspectedCard) setInspectedCard(null);
    onScrollPosition(!atBottom);
    if ((!atBottom || event.type === 'wheel') && element.scrollTop < 160 && cursor && !loading) loadOlder();
  }

  return <div className="timeline" ref={scroll} role="log" aria-label={label} aria-live="off" tabIndex={-1} data-testid={testId}
    data-items={rows.length} data-reading-history={showLatest && !restore ? 'true' : undefined} onScroll={onScroll}
    onPointerDownCapture={releaseGroupAnchor} onKeyDownCapture={releaseGroupAnchor}
    onWheel={event => {
      releaseGroupAnchor();
      if (event.deltaY >= 0 || scroll.current.scrollTop >= 160) return;
      const reader = event.target.closest('.diff-scroll, .output-scroll, .command-text, .plan-list');
      if (!reader || reader.scrollHeight <= reader.clientHeight) onScroll(event);
    }}>
    {rows.length ? <div className="reading-column rail" style={{ height, visibility: restore ? 'hidden' : undefined }}>
      {virtualRows.map(item => {
        const row = layout.rowAt(rows, item.index);
        const depth = Math.max(0, Math.min(3, row.depth ?? 0)) + Number(Boolean(layout.nested?.has(item.index)));
        const show = !(row.kind === 'reasoning' && row.turnId === liveReasoningTurn) && Boolean(visibleRow(row));
        const activePlan = row.kind === 'plan' && Boolean(liveTurnId && row.turnId === liveTurnId);
        const streaming = row.kind === 'message' && !row.final && row.turnId === activeTurnId && Boolean(activeTurnId);
        return <div className="message" key={item.key} data-index={item.index} data-kind={row.kind} data-empty={!show}
          ref={virtual.measureElement} style={{ transform: `translateY(${item.start}px)`, '--depth': depth }}>
          {show && (row.kind === 'activity-group' ? <ActivityGroup group={row} open={openGroups.has(row.key)}
            toggle={toggleGroup} releaseAnchor={releaseGroupAnchor} />
            : <TranscriptRow row={row} activePlan={activePlan}
              liveDelegation={row.kind === 'delegation' && Boolean(liveTurnId && row.turnId === liveTurnId)}
              roster={row.kind === 'delegation' ? delegatedMembers(rows) : undefined} currentKey={viewKey}
              streaming={streaming} following={streaming && !showLatest && !inspectedCard} scroll={scroll} outputPositions={outputPositions.current}
              expanded={expanded.current.get(row.key) ?? (activePlan && Boolean(row.steps?.length))}
              toggle={toggle} openSession={openSession} openTrace={openTrace} openArtifact={openArtifact} openImage={openImage}
              canOpenSession={canOpenSession} />)}
        </div>;
      })}
    </div> : null}
  </div>;
}, sameTranscriptProps);
