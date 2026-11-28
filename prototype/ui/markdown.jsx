import { createContext, lazy, memo, Suspense, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';

let markdownModule;
export function prepareMarkdown() {
  return markdownModule ??= import('./markdown-content.jsx').then(module => ({ default: module.MarkdownContent }));
}

const MarkdownContent = lazy(prepareMarkdown);
export const MarkdownCache = createContext(null);

export const Markdown = memo(function Markdown({ text, streaming = false }) {
  const cache = useContext(MarkdownCache);
  return <Suspense fallback={<div className="prose markdown-pending" aria-busy="true" />}>
    <MarkdownContent text={text} streaming={streaming} cache={streaming ? null : cache} />
  </Suspense>;
});

const longReplyRefreshMs = 80;
const tailObservers = new WeakMap();

function observeTailInViewport(root, tail, setNear) {
  let observation = tailObservers.get(root);
  if (!observation) {
    const listeners = new Map();
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) listeners.get(entry.target)?.(entry.isIntersecting);
    }, { root, rootMargin: '0px 0px 192px 0px' });
    observation = { observer, listeners };
    tailObservers.set(root, observation);
  }

  const { observer, listeners } = observation;
  listeners.set(tail, setNear);
  observer.observe(tail);
  return () => {
    observer.unobserve(tail);
    listeners.delete(tail);
    if (!listeners.size) {
      observer.disconnect();
      tailObservers.delete(root);
    }
  };
}

export const StreamingMarkdown = memo(function StreamingMarkdown({ text, streaming, following, scroll }) {
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
    if (observeTail && scroll.current && tail.current) {
      return observeTailInViewport(scroll.current, tail.current, setTailNear);
    }
  }, [observeTail, scroll]);

  return <>
    <Markdown text={displayed} streaming={streaming} />
    {observeTail && <span aria-hidden="true" className="message-tail" ref={tail} />}
  </>;
});
