import { lazy, memo, Suspense, useEffect, useLayoutEffect, useRef, useState } from 'react';

let markdownModule;
export function prepareMarkdown() {
  return markdownModule ??= import('./markdown-content.jsx').then(module => ({ default: module.MarkdownContent }));
}

const MarkdownContent = lazy(prepareMarkdown);

export const Markdown = memo(function Markdown({ text, reusePrefix = false }) {
  return <Suspense fallback={<div className="prose markdown-pending" aria-busy="true" />}>
    <MarkdownContent text={text} reusePrefix={reusePrefix} />
  </Suspense>;
});

const longReplyRefreshMs = 80;

export function StreamingMarkdown({ text, streaming, following, scroll, reusePrefix }) {
  const tail = useRef(null);
  const committed = useRef({ text, time: -Infinity });
  const wasVisible = useRef(true);
  const [tailNear, setTailNear] = useState(true);
  const [released, setReleased] = useState(-Infinity);
  const observeTail = streaming && text.length >= 4096;
  const visible = following || tailNear;
  const previous = committed.current;
  const appended = observeTail && text !== previous.text && text.startsWith(previous.text);
  const delayAppend = appended && visible && wasVisible.current && released !== previous.time &&
    performance.now() - previous.time < longReplyRefreshMs;
  // Corrections, newly visible tails and completed replies bypass the timer.
  const displayed = appended && (!visible || delayAppend) ? previous.text : text;

  useLayoutEffect(() => {
    if (committed.current.text !== displayed) {
      committed.current = { text: displayed, time: performance.now() };
    }
    wasVisible.current = visible;
  }, [displayed, visible]);
  useEffect(() => {
    if (!delayAppend) return;
    const { time } = previous;
    const timer = setTimeout(() => setReleased(time), Math.max(0, time + longReplyRefreshMs - performance.now()));
    return () => clearTimeout(timer);
  }, [delayAppend, previous]);
  useEffect(() => {
    if (!observeTail || !scroll.current) return;
    const observer = new IntersectionObserver(([entry]) => setTailNear(entry.isIntersecting),
      { root: scroll.current, rootMargin: '0px 0px 192px 0px' });
    observer.observe(tail.current);
    return () => observer.disconnect();
  }, [observeTail, scroll]);

  return <>
    <Markdown text={displayed} reusePrefix={reusePrefix} />
    {observeTail && <span aria-hidden="true" className="message-tail" ref={tail} />}
  </>;
}
