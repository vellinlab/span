import { Fragment, memo, useLayoutEffect, useRef } from 'react';
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

const plugins = [remarkGfm];
const references = new Set(['definition', 'footnoteDefinition', 'linkReference', 'imageReference', 'footnoteReference']);

function hasReference(node) {
  if (references.has(node.type)) return true;
  // A text node can contain a reference that a later definition resolves.
  if (node.type === 'text' && node.value.includes('[')) return true;
  return node.children?.some(hasReference);
}

function stablePrefixEnd(tree, text) {
  let end;
  let preceding;
  // Keep two blocks in the suffix so a partial final line cannot join the prefix.
  for (const block of tree.children.slice(0, -1)) {
    if (block.type === 'paragraph' && preceding?.type === 'paragraph') {
      const start = block.position.start.offset;
      if (start >= 4096 && /^(?:\r?\n)[ \t\r\n]*\n[ \t]*$/.test(text.slice(preceding.position.end.offset, start))) end = start;
    }
    // Keep definitions and anything they may resolve in a single parse.
    if (hasReference(block)) break;
    preceding = block;
  }
  return end;
}

const MarkdownPart = memo(function MarkdownPart({ text, inspect }) {
  return <ReactMarkdown remarkPlugins={inspect ? [...plugins, inspect] : plugins} components={components}>{text}</ReactMarkdown>;
});

const emptyParts = [];

export const MarkdownContent = memo(function MarkdownContent({ text, streaming }) {
  const prepared = useRef(null);
  const retained = prepared.current && text.startsWith(prepared.current.prefix) ? prepared.current : null;
  const parts = retained?.parts ?? emptyParts;
  const offset = retained?.prefix.length ?? 0;
  const suffix = text.slice(offset);
  // Freeze each stable batch as the reply grows, then inspect only the unfinished suffix.
  const reading = streaming && suffix.length >= 4096 ? {} : null;
  const inspect = reading && (() => tree => { reading.end = stablePrefixEnd(tree, suffix); });
  useLayoutEffect(() => {
    const end = reading?.end;
    prepared.current = end ? {
      prefix: text.slice(0, offset + end),
      parts: [...parts, suffix.slice(0, end)],
    } : retained;
  }, [text, offset, parts, suffix, retained, reading]);
  return <div className="prose">
    {[...parts, suffix].map((part, index) => <Fragment key={index}>
      {index > 0 && '\n'}<MarkdownPart text={part} inspect={index === parts.length ? inspect : null} />
    </Fragment>)}
  </div>;
});
