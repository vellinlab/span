import { Fragment, memo, useLayoutEffect, useRef } from 'react';
import { jsx, jsxs } from 'react/jsx-runtime';
import { toJsxRuntime } from 'hast-util-to-jsx-runtime';
import { urlAttributes } from 'html-url-attributes';
import { Copy, Terminal } from 'lucide-react';
import { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import { unified } from 'unified';
import { visit } from 'unist-util-visit';

const components = {
  a: ({ href, children }) => <a href={href} onClick={event => {
    event.preventDefault();
    if (/^https?:\/\//i.test(href ?? '')) window.span.openLink(href).catch(() => {});
  }}>{children}</a>,
  pre: ({ children }) => {
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
  table: ({ children }) => <div className="table-scroll"><table>{children}</table></div>,
  img: ({ alt }) => <span>{alt || '图片'}</span>,
};

const markdown = unified().use(remarkParse).use(remarkGfm)
  .use(remarkRehype, { allowDangerousHtml: true }).freeze();
const urls = Object.entries(urlAttributes);
const runtime = { Fragment, jsx, jsxs, components, ignoreInvalidStyle: true, passKeys: true };
const references = new Set(['definition', 'footnoteDefinition', 'linkReference', 'imageReference', 'footnoteReference']);
const cacheEntries = 32;
const cacheTextLimit = 2048;

function prepareElement(node, index, parent) {
  if (node.type === 'raw' && parent) {
    // Preserve literal HTML as visible text and leave parsing to Markdown.
    parent.children[index] = { type: 'text', value: node.value };
  } else if (node.type === 'element') {
    for (const [property, tags] of urls) {
      if (Object.hasOwn(node.properties, property) && (!tags || tags.includes(node.tagName))) {
        node.properties[property] = defaultUrlTransform(String(node.properties[property] || ''));
      }
    }
  }
}

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

function renderMarkdown(text, inspect) {
  const tree = markdown.parse(text);
  inspect?.(tree);
  const result = markdown.runSync(tree, text);
  visit(result, prepareElement);
  return toJsxRuntime(result, runtime);
}

const MarkdownPart = memo(function MarkdownPart({ text, inspect, cache }) {
  const reusable = cache && !inspect && text.length <= cacheTextLimit;
  const content = (reusable ? cache.get(text) : undefined) ?? renderMarkdown(text, inspect);
  useLayoutEffect(() => {
    if (!reusable) return;
    cache.delete(text);
    cache.set(text, content);
    if (cache.size > cacheEntries) cache.delete(cache.keys().next().value);
  }, [cache, content, reusable, text]);
  return content;
});

const emptyParts = [];

export const MarkdownContent = memo(function MarkdownContent({ text, streaming, cache }) {
  const prepared = useRef(null);
  const retained = prepared.current && text.startsWith(prepared.current.prefix) ? prepared.current : null;
  const parts = retained?.parts ?? emptyParts;
  const offset = retained?.prefix.length ?? 0;
  const suffix = text.slice(offset);
  // Freeze each stable batch as the reply grows, then inspect only the unfinished suffix.
  const reading = streaming && suffix.length >= 4096 ? {} : null;
  const inspect = reading ? tree => { reading.end = stablePrefixEnd(tree, suffix); } : undefined;
  useLayoutEffect(() => {
    const end = reading?.end;
    prepared.current = end ? {
      prefix: text.slice(0, offset + end),
      parts: [...parts, suffix.slice(0, end)],
    } : retained;
  }, [text, offset, parts, suffix, retained, reading]);
  return <div className="prose">
    {[...parts, suffix].map((part, index) => <Fragment key={index}>
      {index > 0 && '\n'}<MarkdownPart text={part} inspect={index === parts.length ? inspect : undefined} cache={cache} />
    </Fragment>)}
  </div>;
});
