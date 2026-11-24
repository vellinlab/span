import { memo, useCallback, useDeferredValue, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react';
import { defaultRangeExtractor, useVirtualizer } from '@tanstack/react-virtual';
import {
  ArrowUpRight, Brain, Check, ChevronRight, Circle, CircleAlert, CircleDot, CodeXml, FileCode2, FileText, GitBranch,
  Image, ListChecks, Search, Terminal, Users, Wrench,
} from 'lucide-react';
import { AgentMemberList, agentStatusLabels as statusLabels, memberName } from './agent-members.jsx';
import { transientAgentStatus } from './delegation.js';
import { FileReferenceName, ImageReference } from './file-reference-name.jsx';
import { Markdown, StreamingMarkdown } from './markdown.jsx';
import { PatchView } from './patch-view.jsx';
import { ReasoningText } from './reasoning.jsx';
import { CopyTextButton, TextReader } from './text-reader.jsx';
import { delegatedMembers, groupedTimelineLayout, timelineLayout, visibleRow } from './timeline.js';

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

function ToolOutput({ text, cwd }) {
  const scroll = useRef(null);
  const visible = useDeferredValue(text);
  const long = visible && (visible.length > 16 * 1024 || visible.split('\n', 32).length === 32);
  return <>
    {cwd && <code className="card-path">{cwd}</code>}
    {visible && <div className="tool-output">
      <div className="tool-output-heading"><span>输出</span>
        <CopyTextButton text={text} label="复制输出" copiedLabel="已复制输出" />
      </div>
      <TextReader text={visible} plain={!long} kind="output" label="工具输出" pagesLabel="输出分页" scroll={scroll} />
    </div>}
  </>;
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

function Card({ icon: Icon, type, title, status, recordedStatus, statusText, statusNote, hint, expanded, toggle, children }) {
  const titleRef = useRef(null);
  const failed = status === 'failed' && !recordedStatus;
  const CardIcon = failed ? CircleAlert : Icon;
  const statusLabel = statusText ?? (status !== 'completed' ? statusLabels[status] : undefined);
  const head = <><CardIcon size={15} className="card-icon" aria-hidden="true" />
    <span className="card-title" ref={titleRef} title={title}>{title}</span>
    {hint && <span className="card-hint" title={hint}>{hint}</span>}
    {(statusLabel || statusNote) && <span className="card-status" data-status={status} data-recorded={recordedStatus || undefined}>
      {statusLabel && <span>{statusLabel}</span>}
      {statusLabel && statusNote && <span aria-hidden="true">·</span>}
      {statusNote && <span>{statusNote}</span>}
    </span>}</>;
  return <div className="activity" data-card={type} data-failed={failed || undefined}>
    {children ? <details open={expanded} onToggle={event => {
      if (event.currentTarget.open !== expanded) toggle(event.currentTarget.open);
    }}>
      <summary><ChevronRight size={13} className="card-chevron" />{head}</summary>
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
  row, activePlan, liveDelegation, roster, currentKey, expanded, toggle, openSession, openArtifact, openImage, canOpenSession,
  streaming, following, scroll,
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

  let title, hint, detail, recordedStatus, statusText, statusNote;
  let status = row.final && row.status === 'running' ? undefined : row.status;
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
        if (!status || status === 'completed') status = 'failed';
      }
      if (command || hasContext) detail = titleRef => <>
        {command && <CommandText command={command} titleRef={titleRef} force={!hasContext} />}
        {hasContext && <ToolOutput text={row.text} cwd={row.cwd} />}
      </>;
      break;
    }
    case 'patch':
      title = row.files?.length ? '文件变更' : '本轮差异';
      hint = row.files?.length === 1 ? expanded ? undefined : row.files[0].path : row.files?.length ? `${row.files.length} 个文件` : undefined;
      detail = () => <PatchView files={row.files ?? []} text={row.text} />;
      break;
    case 'tool':
      title = row.name || '调用工具';
      hint = row.source;
      if (row.text) detail = () => <ToolOutput text={row.text} />;
      break;
    case 'search':
      title = row.query;
      if (row.url || row.text) detail = () => <>{row.url && <SourceLink url={row.url}>{row.url}</SourceLink>}
        {row.text && <ToolOutput text={row.text} />}</>;
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
      if (members.length || row.text) detail = () => <>
        {row.text && <Markdown text={row.text} />}
        {members.length > 0 && <AgentMemberList members={members} currentKey={currentKey}
          openSession={openSession} canOpenSession={canOpenSession} showDetail />}
      </>;
      break;
    }
    case 'artifact':
      title = '产物';
      detail = () => <ArtifactList artifacts={row.artifacts} openArtifact={openArtifact} />;
      break;
    case 'notice':
      title = row.title;
      if (row.text) detail = () => <Markdown text={row.text} />;
      break;
  }

  return <Card type={row.kind} icon={cardIcons[row.kind] ?? CodeXml} status={status} recordedStatus={recordedStatus}
    statusText={statusText} statusNote={statusNote}
    title={title} hint={hint} expanded={expanded} toggle={open => toggle(row.key, open)}>{detail}</Card>;
});

const ActivityGroup = memo(function ActivityGroup({ group, open, toggle }) {
  const count = group.end - group.start;
  const tools = count - group.commands;
  const Icon = tools ? Wrench : Terminal;
  const label = tools ? `${group.commands ? `${group.commands} 条命令 · ` : ''}${tools} 次工具调用`
    : `${count} 条命令`;
  return <div className="activity" data-card="activity-group">
    <button type="button" className="card-heading" aria-expanded={open} onClick={() => toggle(group.key)}>
      <ChevronRight size={13} className="card-chevron" /><Icon size={15} className="card-icon" />
      <span className="card-title">{label}</span>
    </button>
  </div>;
});

function readAnchor(element, rows, layout) {
  if (element.scrollHeight - element.clientHeight - element.scrollTop < 40) return;
  const viewport = element.getBoundingClientRect();
  for (const item of element.querySelectorAll('.message[data-empty="false"]')) {
    const content = item.firstElementChild?.getBoundingClientRect();
    if (content && content.bottom > viewport.top && content.top < viewport.bottom) {
      const { key, itemKey, turnId } = layout.rowAt(rows, Number(item.dataset.index));
      return { key, itemKey, turnId, top: item.getBoundingClientRect().top - viewport.top };
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

export const Transcript = memo(function Transcript({
  rows, liveReasoningTurn, activeTurnId, viewKey, remembered, remember, historyPages, cursor, loadOlder, loading, jumpToLatest, scroll,
  onScrollPosition, openSession, openArtifact, openImage, canOpenSession, showLatest,
}) {
  const expanded = useRef(null);
  if (!expanded.current) expanded.current = new Map(remembered?.expansion);
  const ungroupedTurns = useRef(null);
  if (!ungroupedTurns.current) ungroupedTurns.current = new Set(remembered?.ungroupedTurns);
  const [openGroups, setOpenGroups] = useState(() => new Set(remembered?.openGroups));
  const [restore, setRestore] = useState(remembered?.anchor);
  const [liveTurnId, setLiveTurnId] = useState(activeTurnId);
  const latest = useRef(null);
  const following = useRef(true);
  const followAfterFold = useRef(false);
  const viewportHeight = useRef(0);
  const [, updateExpansion] = useReducer(version => version + 1, 0);
  const toggle = useCallback((key, open) => {
    expanded.current.delete(key);
    expanded.current.set(key, open);
    updateExpansion();
  }, []);
  const toggleGroup = useCallback(key => setOpenGroups(previous => {
    const next = new Set(previous);
    if (!next.delete(key)) next.add(key);
    return next;
  }), []);
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
    anchorTo: 'end', followOnAppend: true, scrollEndThreshold: 40,
  });
  const virtualRows = virtual.getVirtualItems();
  const height = virtual.getTotalSize();

  useLayoutEffect(() => {
    latest.current = { rows, layout, historyPages, restore, openGroups };
  }, [rows, layout, historyPages, restore, openGroups]);

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
    const element = scroll.current;
    return () => {
      const current = latest.current;
      if (!viewKey || current?.restore || !current?.rows.length) return;
      const anchor = readAnchor(element, current.rows, current.layout);
      remember(viewKey, { anchor, pages: current.historyPages, expansion: Array.from(expanded.current).slice(-64),
        openGroups: Array.from(current.openGroups).slice(-64),
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
        following.current = element.scrollHeight - element.clientHeight - element.scrollTop < 40;
        onScrollPosition(!following.current);
        setRestore(undefined);
      }
    }
    align(2);
    return () => cancelAnimationFrame(frame);
  }, [layout.count, virtual, jumpToLatest, scroll, onScrollPosition, restore, loading, target]);

  useLayoutEffect(() => {
    if (restore || !jumpToLatest.current || !rows.length) return;
    jumpToLatest.current = false;
    following.current = true;
    virtual.scrollToEnd();
    onScrollPosition(false);
  }, [rows, virtual, jumpToLatest, onScrollPosition, restore]);

  useLayoutEffect(() => {
    const element = scroll.current;
    viewportHeight.current = element.clientHeight;
    const observer = new ResizeObserver(() => {
      const nextHeight = element.clientHeight;
      if (nextHeight === viewportHeight.current) return;
      viewportHeight.current = nextHeight;
      if (following.current && virtual.options.count) virtual.scrollToEnd();
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [scroll, virtual]);

  function onScroll() {
    if (restore) return;
    const element = scroll.current;
    const height = element.clientHeight;
    // A resize can scroll the list before its observer has restored the viewport.
    if (height !== viewportHeight.current) return;
    const atBottom = element.scrollHeight - height - element.scrollTop < 40;
    following.current = atBottom;
    onScrollPosition(!atBottom);
    if (!atBottom && element.scrollTop < 160 && cursor && !loading) loadOlder();
  }

  return <div className="timeline" ref={scroll} role="log" aria-live="off" data-testid="transcript"
    data-items={rows.length} onScroll={onScroll}
    onWheel={event => {
      if (event.deltaY < 0 && scroll.current.scrollTop < 160 &&
        !event.target.closest('.text-scroll, .output-scroll, .command-text, .plan-list')) onScroll();
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
          {show && (row.kind === 'activity-group' ? <ActivityGroup group={row} open={openGroups.has(row.key)} toggle={toggleGroup} />
            : <TranscriptRow row={row} activePlan={activePlan}
              liveDelegation={row.kind === 'delegation' && Boolean(liveTurnId && row.turnId === liveTurnId)}
              roster={row.kind === 'delegation' ? delegatedMembers(rows) : undefined} currentKey={viewKey}
              streaming={streaming} following={streaming && !showLatest} scroll={scroll}
              expanded={expanded.current.get(row.key) ?? (activePlan && Boolean(row.steps?.length))}
              toggle={toggle} openSession={openSession} openArtifact={openArtifact} openImage={openImage} canOpenSession={canOpenSession} />)}
        </div>;
      })}
    </div> : null}
  </div>;
});
