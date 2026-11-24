import { memo, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { AlertCircle, Check, Copy } from 'lucide-react';

const LINES_PER_PAGE = 8192;
const LINE_HEIGHT = 18;
const estimateLine = () => LINE_HEIGHT;

function diffPages(text) {
  const pages = [{ start: 0, inHunk: false }];
  let lines = 0;
  let inHunk = false;
  for (let start = 0, end; (end = text.indexOf('\n', start)) !== -1 && end < text.length - 1; start = end + 1) {
    if (text.startsWith('diff --', start)) inHunk = false;
    else if (text.startsWith('@@', start)) inHunk = true;
    if (++lines % LINES_PER_PAGE === 0) pages.push({ start: end + 1, inHunk });
  }
  return pages;
}

function readLines(text, inHunk) {
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  let columns = 0;
  const rows = lines.map(line => {
    if (line.startsWith('diff --')) inHunk = false;
    else if (line.startsWith('@@')) inHunk = true;
    let width = 0;
    for (const char of line) {
      width += char === '\t' ? 4 - (width % 4) : char.codePointAt(0) >= 0x2e80 ? 2 : 1;
    }
    columns = Math.max(columns, width);
    return { text: line, tone: toneFor(line, inHunk) };
  });
  return { rows, columns };
}

function toneFor(line, inHunk) {
  if (/^(?:@@|diff --|index |\\ No newline)/.test(line)) return 'meta';
  if (!inHunk && /^(?:--- |\+\+\+ )/.test(line)) return 'meta';
  if (line.startsWith('+')) return 'add';
  if (line.startsWith('-')) return 'remove';
}

function DiffViewport({ text, label, inHunk, position, page, scroll }) {
  const initialPosition = useRef(position);
  const { rows, columns } = useMemo(() => readLines(text, inHunk), [text, inHunk]);
  const virtual = useVirtualizer({ count: rows.length, getScrollElement: () => scroll.current,
    estimateSize: estimateLine, overscan: 8, initialOffset: () => initialPosition.current?.top ?? 0 });

  useLayoutEffect(() => {
    if (initialPosition.current) scroll.current.scrollTo(initialPosition.current);
  }, [scroll]);

  return <pre ref={scroll} className="diff-scroll" tabIndex={0} aria-label={label} data-page={page}
    style={{ '--diff-line-height': `${LINE_HEIGHT}px` }}>
    <code className="diff-rail" style={{ height: virtual.getTotalSize(), minWidth: `max(100%, ${columns}ch)` }}>
      {virtual.getVirtualItems().map(({ key, index, start }) => <span key={key} className="diff-line" data-tone={rows[index].tone}
        style={{ top: start }}>{rows[index].text}{'\n'}</span>)}
    </code>
  </pre>;
}

function DiffReader({ text, label, position, scroll }) {
  const [view, setView] = useState(position ?? { page: 0 });
  const pages = useMemo(() => diffPages(text), [text]);
  const current = Math.min(view.page, pages.length - 1);
  const { start, inHunk } = pages[current];
  return <>
    <DiffViewport key={current} label={label} inHunk={inHunk} text={text.slice(start, pages[current + 1]?.start)}
      position={view.page === current ? view : null} page={current} scroll={scroll} />
    {pages.length > 1 && <nav className="diff-pages" aria-label="差异分页">
      <button type="button" disabled={!current} onClick={() => setView({ page: current - 1 })}>上一段</button>
      <span aria-live="polite">{current + 1} / {pages.length}</span>
      <button type="button" disabled={current === pages.length - 1} onClick={() => setView({ page: current + 1 })}>下一段</button>
    </nav>}
  </>;
}

function CopyPatch({ text }) {
  const [copy, setCopy] = useState('');
  const Icon = copy === '已复制差异' ? Check : copy ? AlertCircle : Copy;
  return <button className="icon-button" type="button" aria-label="复制差异" title={copy || '复制差异'} onClick={async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopy('已复制差异');
    } catch {
      setCopy('复制失败');
    }
  }}><Icon size={14} /></button>;
}

export const PatchView = memo(function PatchView({ files, text }) {
  const [selection, setSelection] = useState('');
  const positions = useRef(new Map());
  const scroll = useRef(null);
  const sources = files.map((file, index) => ({ label: file.path, diff: file.diff, key: JSON.stringify([file.path, index]) }));
  if (text) sources.push({ label: '本轮差异', diff: text, key: 'turn' });
  const active = sources.find(source => source.key === selection) ?? sources[0];
  if (!active) return null;
  function select(key) {
    const viewport = scroll.current;
    if (viewport) positions.current.set(active.key, { page: Number(viewport.dataset.page),
      top: viewport.scrollTop, left: viewport.scrollLeft });
    setSelection(key);
  }
  return <>
    <header className="diff-toolbar">
      {sources.length > 1 ? <select aria-label="变更文件" title={active.label} value={active.key}
        onChange={event => select(event.target.value)}>
        {sources.map(source => <option key={source.key} value={source.key}>{source.label}</option>)}
      </select> : files.length > 0 && <code className="card-path">{active.label}</code>}
      {active.diff && <CopyPatch key={active.key} text={active.diff} />}
    </header>
    {active.diff ? <DiffReader key={active.key} text={active.diff} label={`${active.label}的差异`}
      position={positions.current.get(active.key)} scroll={scroll} />
      : <p className="diff-empty">没有可显示的差异。</p>}
  </>;
});
