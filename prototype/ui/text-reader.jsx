import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { observeElementRect, useVirtualizer } from '@tanstack/react-virtual';
import { AlertCircle, Check, Copy } from 'lucide-react';
import { indexOutput, indexText, LINES_PER_PAGE, readOutputRange, readTextPage } from './text-pages.js';

const LINE_HEIGHT = 18;
const estimateLine = () => LINE_HEIGHT;
const FIRST_PAGE = [{ start: 0 }];

export function readTextPosition(viewport) {
  if (viewport) return { page: Number(viewport.dataset.page), top: viewport.scrollTop, left: viewport.scrollLeft };
}

export function rememberReaderPosition(positions, key, position, limit = 64) {
  positions.delete(key);
  if (!position) return;
  positions.set(key, position);
  if (positions.size > limit) positions.delete(positions.keys().next().value);
}

function updateDiffScrollBoundary(viewport) {
  viewport.toggleAttribute('data-scrollable-y', viewport.scrollHeight > viewport.clientHeight);
}

function observeDiffRect(instance, notify) {
  const viewport = instance.scrollElement;
  return observeElementRect(instance, rect => {
    updateDiffScrollBoundary(viewport);
    notify(rect);
  });
}

function TextViewport({ data, text, kind, label, position, page, scroll }) {
  const initialPosition = useRef(position);
  const mounted = useRef(false);
  const virtual = useVirtualizer({ count: data?.rows.length ?? 0, getScrollElement: () => scroll.current,
    enabled: Boolean(data), estimateSize: estimateLine, overscan: 8,
    observeElementRect: kind === 'diff' ? observeDiffRect : observeElementRect,
    // During a page change the shared ref can still point to the previous viewport.
    initialOffset: () => initialPosition.current?.top ?? (mounted.current ? scroll.current?.scrollTop ?? 0 : 0) });
  const height = data ? virtual.getTotalSize() : 0;

  useLayoutEffect(() => {
    mounted.current = true;
    if (initialPosition.current) scroll.current.scrollTo(initialPosition.current);
  }, [scroll]);
  useLayoutEffect(() => {
    if (kind === 'diff') updateDiffScrollBoundary(scroll.current);
  }, [height, kind, scroll]);

  return <pre ref={scroll} className={`${data ? 'text-scroll ' : ''}${kind}-scroll`} tabIndex={0} aria-label={label} data-page={page}
    style={{ '--text-line-height': `${LINE_HEIGHT}px` }}>
    {data ? <code className="text-rail" style={{ height, minWidth: `max(100%, ${data.columns}ch)` }}>
      {virtual.getVirtualItems().map(({ key, index, start }) => <span key={key} className={`text-line ${kind}-line`}
        data-tone={data.rows[index].tone} style={{ top: start }}>{data.rows[index].text}{'\n'}</span>)}
    </code> : text}
  </pre>;
}

export function TextReader({ text, output, plain = false, kind, label, pagesLabel, position, scroll, updateContext, classify }) {
  const [view, setView] = useState(position ?? { page: 0 });
  const previous = useRef({});
  const index = useMemo(() => {
    if (plain) return;
    const last = previous.current.index;
    return output ? indexOutput(output, last) : indexText(text, updateContext, last?.output ? undefined : last);
  }, [plain, text, output, updateContext]);
  const pages = index?.pages ?? FIRST_PAGE;
  const current = Math.min(view.page, pages.length - 1);
  const page = pages[current];
  const context = page.context;
  const start = page.start;
  const end = pages[current + 1]?.start ?? text.length;
  const pageText = useMemo(() => {
    if (!index?.output) return text.slice(start, end);
    const last = previous.current;
    if (last.index?.revision === index.revision && last.start === start && last.end <= end && last.data) {
      // Earlier pages stay unchanged. On the live page only materialize the newly received range.
      return last.data.text + readOutputRange(output, last.end, end);
    }
    return readOutputRange(output, start, end);
  }, [text, start, end, index, output]);
  const data = useMemo(() => plain ? null : readTextPage(pageText, context, updateContext, classify, previous.current.data),
    [plain, pageText, context, updateContext, classify]);
  useLayoutEffect(() => {
    previous.current = { index, data, start, end };
    if (view.page !== current) setView({ page: current });
  }, [index, data, start, end, view.page, current]);
  return <>
    <TextViewport key={current} data={data} text={pageText} kind={kind} label={label} position={view.page === current ? view : null}
      page={current} scroll={scroll} />
    {pages.length > 1 && <nav className="text-pages" aria-label={pagesLabel}>
      <span className="text-page-lines">{current * LINES_PER_PAGE + 1}–{current * LINES_PER_PAGE + data.rows.length} 行</span>
      <button type="button" aria-disabled={!current} onClick={() => { if (current) setView({ page: current - 1 }); }}>上一段</button>
      <span aria-live="polite">{current + 1} / {pages.length}</span>
      <button type="button" aria-disabled={current === pages.length - 1}
        onClick={() => { if (current < pages.length - 1) setView({ page: current + 1 }); }}>下一段</button>
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
