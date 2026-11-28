import { createContext, lazy, memo, Suspense, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';

let markdownModule;
let markdownViews;
export function prepareMarkdown() {
  return markdownModule ??= import('./markdown-content.jsx').then(module => (markdownViews = module));
}

const FileMarkdownContent = lazy(() => prepareMarkdown().then(module => ({ default: module.FileMarkdownContent })));
export const MarkdownCache = createContext(null);

const parkedPreviewDelayMs = 5000;
const largePreviewText = 16 * 1024;

export const FileMarkdown = memo(function FileMarkdown({ text, parked, preserveSelection, onBodyReady }) {
  const [released, setReleased] = useState(false);
  useEffect(() => {
    if (!parked) {
      if (!released) return;
      // Let the preview shell paint and take focus before mounting a large document.
      let frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(() => setReleased(false));
      });
      return () => cancelAnimationFrame(frame);
    }
    if (released || preserveSelection || text.length < largePreviewText) return;
    // Brief trips back to the conversation keep the already mounted reader.
    const timer = setTimeout(() => setReleased(true), parkedPreviewDelayMs);
    return () => clearTimeout(timer);
  }, [parked, preserveSelection, released, text]);
  return <Suspense fallback={parked ? null : <div className="prose markdown-pending" aria-busy="true" />}>
    {released && !parked && <p className="preview-resuming" role="status">正在恢复预览…</p>}
    <FileMarkdownContent text={text} parked={parked} released={released} onBodyReady={onBodyReady} />
  </Suspense>;
});

function UnformattedMarkdown({ text }) {
  return <div className="prose" style={{ whiteSpace: 'pre-wrap' }}>{text}</div>;
}

export const Markdown = memo(function Markdown({ text, streaming = false }) {
  const cache = useContext(MarkdownCache);
  const [Content, setContent] = useState(() => markdownViews?.MarkdownContent);
  useEffect(() => {
    if (Content) return;
    let mounted = true;
    // Publish the renderer when the module arrives, even if a short placeholder already painted.
    prepareMarkdown().then(module => module.MarkdownContent, () => UnformattedMarkdown)
      .then(View => { if (mounted) setContent(() => View); });
    return () => { mounted = false; };
  }, [Content]);
  return Content ? <Content text={text} streaming={streaming} cache={streaming ? null : cache} />
    : <div className="prose markdown-pending" aria-busy="true" />;
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
