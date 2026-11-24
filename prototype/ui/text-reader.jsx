import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { AlertCircle, Check, Copy } from 'lucide-react';

const LINES_PER_PAGE = 8192;
const LINE_HEIGHT = 18;
const estimateLine = () => LINE_HEIGHT;
const FIRST_PAGE = [{ start: 0 }];

function pageStarts(text, updateContext) {
  const pages = [{ start: 0 }];
  let lines = 0;
  let context;
  for (let start = 0, end; (end = text.indexOf('\n', start)) !== -1 && end < text.length - 1; start = end + 1) {
    if (updateContext) context = updateContext(context, text, start);
    if (++lines % LINES_PER_PAGE === 0) pages.push({ start: end + 1, context });
  }
  return pages;
}

function readLines(text, context, updateContext, classify) {
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  let columns = 0;
  const rows = lines.map(line => {
    if (updateContext) context = updateContext(context, line, 0);
    let width = 0;
    for (const char of line) {
      width += char === '\t' ? 4 - (width % 4) : char.codePointAt(0) >= 0x2e80 ? 2 : 1;
    }
    columns = Math.max(columns, width);
    return { text: line, tone: classify?.(line, context) };
  });
  return { rows, columns };
}

function TextViewport({ data, text, kind, label, position, page, scroll }) {
  const initialPosition = useRef(position);
  const mounted = useRef(false);
  const virtual = useVirtualizer({ count: data?.rows.length ?? 0, getScrollElement: () => scroll.current,
    enabled: Boolean(data), estimateSize: estimateLine, overscan: 8,
    // During a page change the shared ref can still point to the previous viewport.
    initialOffset: () => initialPosition.current?.top ?? (mounted.current ? scroll.current?.scrollTop ?? 0 : 0) });

  useLayoutEffect(() => {
    mounted.current = true;
    if (initialPosition.current) scroll.current.scrollTo(initialPosition.current);
  }, [scroll]);

  return <pre ref={scroll} className={`${data ? 'text-scroll ' : ''}${kind}-scroll`} tabIndex={0} aria-label={label} data-page={page}
    style={{ '--text-line-height': `${LINE_HEIGHT}px` }}>
    {data ? <code className="text-rail" style={{ height: virtual.getTotalSize(), minWidth: `max(100%, ${data.columns}ch)` }}>
      {virtual.getVirtualItems().map(({ key, index, start }) => <span key={key} className={`text-line ${kind}-line`}
        data-tone={data.rows[index].tone} style={{ top: start }}>{data.rows[index].text}{'\n'}</span>)}
    </code> : text}
  </pre>;
}

export function TextReader({ text, plain = false, kind, label, pagesLabel, position, scroll, updateContext, classify }) {
  const [view, setView] = useState(position ?? { page: 0 });
  const pages = useMemo(() => plain ? FIRST_PAGE : pageStarts(text, updateContext), [plain, text, updateContext]);
  const current = Math.min(view.page, pages.length - 1);
  const { start, context } = pages[current];
  const pageText = text.slice(start, pages[current + 1]?.start);
  const data = useMemo(() => plain ? null : readLines(pageText, context, updateContext, classify),
    [plain, pageText, context, updateContext, classify]);
  return <>
    <TextViewport key={current} data={data} text={pageText} kind={kind} label={label} position={view.page === current ? view : null}
      page={current} scroll={scroll} />
    {pages.length > 1 && <nav className="text-pages" aria-label={pagesLabel}>
      <button type="button" disabled={!current} onClick={() => setView({ page: current - 1 })}>上一段</button>
      <span aria-live="polite">{current + 1} / {pages.length}</span>
      <button type="button" disabled={current === pages.length - 1} onClick={() => setView({ page: current + 1 })}>下一段</button>
    </nav>}
  </>;
}

export function CopyTextButton({ text, label, copiedLabel }) {
  const [copy, setCopy] = useState('');
  const Icon = copy === copiedLabel ? Check : copy ? AlertCircle : Copy;
  return <button className="icon-button" type="button" aria-label={label} title={copy || label} onClick={async () => {
    try {
      await window.span.copyText(text);
      setCopy(copiedLabel);
    } catch {
      setCopy('复制失败');
    }
  }}><Icon size={14} /></button>;
}
