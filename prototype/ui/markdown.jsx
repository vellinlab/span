import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Copy, Terminal } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

const components = {
  a: ({ node, href, children }) => <a href={href} onClick={event => {
    event.preventDefault();
    if (/^https?:\/\//i.test(href ?? '')) window.span.openLink(href).catch(() => {});
  }}>{children}</a>,
  pre: ({ node, children }) => {
    const { props } = children;
    const language = props?.className?.replace(/^language-/, '') || '代码';
    return <div className="code-card">
      <div className="code-heading"><Terminal size={14} />{language}
        <button className="icon-button right" title="复制代码"
          onClick={() => window.span.copyText(String(props?.children ?? '')).catch(() => {})}><Copy size={14} /></button>
      </div>
      <pre>{children}</pre>
    </div>;
  },
  table: ({ node, children }) => <div className="table-scroll"><table>{children}</table></div>,
  img: ({ alt }) => <span>{alt || '图片'}</span>,
};

export const Markdown = memo(function Markdown({ text }) {
  return <div className="prose">
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>{text}</ReactMarkdown>
  </div>;
});

export function StreamingMarkdown({ text, streaming, following, scroll }) {
  const tail = useRef(null);
  const committed = useRef(text);
  const [tailNear, setTailNear] = useState(true);
  const observeTail = streaming && text.length >= 4096;
  // Keep formatting visible corrections and the final reply, even when the
  // reader is far from the part receiving append-only updates.
  const canWait = observeTail && !following && !tailNear && text.startsWith(committed.current);
  const displayed = canWait ? committed.current : text;

  useLayoutEffect(() => {
    committed.current = displayed;
  }, [displayed]);
  useEffect(() => {
    if (!observeTail || !scroll.current) return;
    const observer = new IntersectionObserver(([entry]) => setTailNear(entry.isIntersecting),
      { root: scroll.current, rootMargin: '0px 0px 192px 0px' });
    observer.observe(tail.current);
    return () => observer.disconnect();
  }, [observeTail, scroll]);

  return <>
    <Markdown text={displayed} />
    {observeTail && <span aria-hidden="true" className="message-tail" ref={tail} />}
  </>;
}
