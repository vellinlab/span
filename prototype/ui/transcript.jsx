import { memo, useCallback, useDeferredValue, useLayoutEffect, useReducer, useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  ArrowUpRight, Brain, Check, ChevronRight, Circle, CodeXml, FileCode2, FileText, GitBranch,
  Image, ListChecks, Search, Terminal, Users, Wrench,
} from 'lucide-react';
import { Markdown } from './markdown.jsx';
import { PatchView } from './patch-view.jsx';
import { ReasoningText } from './reasoning.jsx';
import { CopyTextButton, TextReader } from './text-reader.jsx';
import { timelineLayout, visibleRow } from './timeline.js';

const statusLabels = {
  pending: '等待中', running: '进行中', completed: '已完成', failed: '失败', cancelled: '已停止', unknown: '状态未知',
};

function SourceLink({ url, children }) {
  return <a href={url} onClick={event => {
    event.preventDefault();
    if (/^https?:\/\//i.test(url)) window.span.openLink(url).catch(() => {});
  }}>{children}<ArrowUpRight size={12} /></a>;
}

function MemberList({ members, openSession, canOpenSession }) {
  return <ul className="member-list">{members.map(member => <li key={member.id}>
    <span className="member-label">{member.name || member.role || member.id}</span>
    {member.model && <span>{member.model}</span>}
    {member.status && <span className="card-status" data-status={member.status}>{statusLabels[member.status]}</span>}
    {member.session && <button type="button" disabled={!canOpenSession} onClick={() => openSession(member.session)}>打开会话 <ArrowUpRight size={12} /></button>}
    {member.detail && <p>{member.detail}</p>}
  </li>)}</ul>;
}

function ArtifactList({ artifacts, openArtifact }) {
  return <ul className="artifact-list">{artifacts.map(file => <li key={file.id}>
    {file.kind === 'image' ? <Image size={14} /> : <FileText size={14} />}
    {file.url && /^https?:\/\//i.test(file.url) ? <SourceLink url={file.url}>{file.name}</SourceLink>
      : file.path ? <button type="button" title={file.path} onClick={() => openArtifact(file)}>{file.name}</button>
        : <span>{file.name}</span>}
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

function Card({ icon: Icon, type, title, status, hint, expanded, toggle, children }) {
  const head = <><Icon size={15} className="card-icon" /><span className="card-title" title={title}>{title}</span>
    {hint && <span className="card-hint" title={hint}>{hint}</span>}
    {status && status !== 'completed' && <span className="card-status" data-status={status}>{statusLabels[status]}</span>}</>;
  return <div className="activity" data-card={type}>
    {children ? <details open={expanded} onToggle={event => {
      if (event.currentTarget.open !== expanded) toggle(event.currentTarget.open);
    }}>
      <summary><ChevronRight size={13} className="card-chevron" />{head}</summary>
      {expanded && <div className="card-body">{children()}</div>}
    </details> : <div className="card-heading"><span className="card-placeholder" />{head}</div>}
  </div>;
}

const cardIcons = {
  reasoning: Brain, plan: ListChecks, command: Terminal, patch: FileCode2, tool: Wrench,
  search: Search, delegation: Users, artifact: Image, notice: GitBranch,
};

const TranscriptRow = memo(function TranscriptRow({ row, expanded, toggle, openSession, openArtifact, canOpenSession }) {
  if (row.kind === 'user') return <div className="user-message">
    {row.text}{row.queued && row.queued !== 'delivered' && <small className="queued-input">
      {row.queued === 'cancelled' ? '已取消排队' : '等待当前任务结束'}
    </small>}{Boolean(row.attachments?.length) && <ArtifactList artifacts={row.attachments} openArtifact={openArtifact} />}
  </div>;
  if (row.kind === 'message') return <div className={row.phase === 'commentary' ? 'agent-commentary' : undefined}>
    <Markdown text={row.text} />
  </div>;

  let title, hint, detail;
  switch (row.kind) {
    case 'reasoning':
      title = '推理摘要';
      detail = () => <ReasoningText row={row} />;
      break;
    case 'plan':
      title = row.steps?.length ? '任务计划' : '规划草案';
      if (row.steps?.length) hint = `${row.steps.filter(step => step.status === 'completed').length}/${row.steps.length}`;
      detail = () => <>
        {row.text && <Markdown text={row.text} />}
        {row.steps && <ul className="plan-list">{row.steps.map((step, index) => <li key={index} data-status={step.status}>
          {step.status === 'completed' ? <Check size={14} /> : <Circle size={12} />}
          <Markdown text={step.text} />
        </li>)}</ul>}
      </>;
      break;
    case 'command':
      title = row.command || '执行命令';
      hint = row.exitCode != null && row.exitCode !== 0 ? `退出码 ${row.exitCode}` : undefined;
      if (row.text || row.cwd) detail = () => <ToolOutput text={row.text} cwd={row.cwd} />;
      break;
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
    case 'delegation':
      title = row.action;
      if (row.members?.length) hint = `${row.members.length} 个代理`;
      if (row.members?.length || row.text) detail = () => <>
        {row.members?.length > 0 && <MemberList members={row.members} openSession={openSession} canOpenSession={canOpenSession} />}
        {row.text && <Markdown text={row.text} />}
      </>;
      break;
    case 'artifact':
      title = '产物';
      detail = () => <ArtifactList artifacts={row.artifacts} openArtifact={openArtifact} />;
      break;
    case 'notice':
      title = row.title;
      if (row.text) detail = () => <Markdown text={row.text} />;
      break;
  }

  return <Card type={row.kind} icon={cardIcons[row.kind] ?? CodeXml}
    status={row.final && row.status === 'running' ? undefined : row.status}
    title={title} hint={hint} expanded={expanded} toggle={open => toggle(row.key, open)}>{detail}</Card>;
});

export const Transcript = memo(function Transcript({
  rows, liveReasoningKey, cursor, loadOlder, loading, jumpToLatest, scroll, onScrollPosition, openSession, openArtifact, canOpenSession,
}) {
  const expanded = useRef(new Map());
  const following = useRef(true);
  const [, updateExpansion] = useReducer(version => version + 1, 0);
  const toggle = useCallback((key, open) => {
    expanded.current.set(key, open);
    updateExpansion();
  }, []);
  const layout = timelineLayout(rows);
  const estimate = useCallback(index => layout.getItemKey(index) === liveReasoningKey ? 0 : layout.estimateSize(index), [layout, liveReasoningKey]);
  const virtual = useVirtualizer({
    count: rows.length, getScrollElement: () => scroll.current,
    getItemKey: layout.getItemKey, estimateSize: liveReasoningKey ? estimate : layout.estimateSize,
    overscan: 6, paddingStart: 20, paddingEnd: 14,
    anchorTo: 'end', followOnAppend: true, scrollEndThreshold: 40,
  });
  const virtualRows = virtual.getVirtualItems();
  const height = virtual.getTotalSize();

  useLayoutEffect(() => {
    if (jumpToLatest.current && rows.length) {
      jumpToLatest.current = false;
      following.current = true;
      virtual.scrollToEnd();
    }
  }, [rows, virtual, jumpToLatest]);

  useLayoutEffect(() => {
    const element = scroll.current;
    let height = element.clientHeight;
    const observer = new ResizeObserver(() => {
      const nextHeight = element.clientHeight;
      if (nextHeight === height) return;
      height = nextHeight;
      if (following.current && virtual.options.count) virtual.scrollToEnd();
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [scroll, virtual]);

  function onScroll() {
    const element = scroll.current;
    const atBottom = element.scrollHeight - element.clientHeight - element.scrollTop < 40;
    following.current = atBottom;
    onScrollPosition(!atBottom);
    if (!atBottom && element.scrollTop < 160 && cursor && !loading) loadOlder();
  }

  return <div className="timeline" ref={scroll} role="log" aria-live="off" data-testid="transcript"
    data-items={rows.length} onScroll={onScroll}
    onWheel={event => {
      if (event.deltaY < 0 && scroll.current.scrollTop < 160 && !event.target.closest('.text-scroll, .output-scroll')) onScroll();
    }}>
    {rows.length ? <div className="reading-column rail" style={{ height }}>
      {virtualRows.map(item => {
        const row = rows[item.index];
        const depth = Math.max(0, Math.min(3, row.depth ?? 0));
        const show = row.key !== liveReasoningKey && Boolean(visibleRow(row));
        return <div className="message" key={item.key} data-index={item.index} data-kind={row.kind} data-empty={!show}
          ref={virtual.measureElement} style={{ transform: `translateY(${item.start}px)`, '--depth': depth }}>
          {show && <TranscriptRow row={row}
            expanded={expanded.current.get(row.key) ?? (row.kind === 'plan' && Boolean(row.steps?.length))}
            toggle={toggle} openSession={openSession} openArtifact={openArtifact} canOpenSession={canOpenSession} />}
        </div>;
      })}
    </div> : null}
  </div>;
});
