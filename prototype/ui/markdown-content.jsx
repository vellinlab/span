import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
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

function openMarkdownLink(event, href) {
  event.preventDefault();
  if (/^https?:\/\//i.test(href ?? '')) window.span.openLink(href).catch(() => {});
}

const components = {
  a: ({ href, children }) => <a href={href} onClick={event => openMarkdownLink(event, href)}>{children}</a>,
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
const cacheTextLimit = 12 * 1024;
const cacheBudget = 48 * 1024;
// Charge for retained React elements as well as the source text.
const cacheElementWeight = 32;
const parkedPreviewDelayMs = 5000;
const largePreviewText = 16 * 1024;

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
  let elements = 0;
  visit(result, (node, index, parent) => {
    if (node.type === 'raw' && parent) {
      // Preserve literal HTML as visible text and leave parsing to Markdown.
      parent.children[index] = { type: 'text', value: node.value };
    } else if (node.type === 'element') {
      elements++;
      for (const [property, tags] of urls) {
        if (Object.hasOwn(node.properties, property) && (!tags || tags.includes(node.tagName))) {
          node.properties[property] = defaultUrlTransform(String(node.properties[property] || ''));
        }
      }
    }
  });
  return { content: toJsxRuntime(result, runtime), weight: text.length + elements * cacheElementWeight };
}

function snapshotChildren(element, complete) {
  const result = [];
  const pending = [{ next: element.firstChild, children: result }];
  let idle;
  const capture = deadline => {
    // A very long list can be a single Markdown block. Yield between its individual nodes.
    const end = performance.now() + (deadline.didTimeout ? 4 : Math.min(4, deadline.timeRemaining()));
    while (pending.length && performance.now() < end) {
      const parent = pending.at(-1);
      const child = parent.next;
      if (!child) {
        pending.pop();
        continue;
      }
      parent.next = child.nextSibling;
      if (child.nodeType === Node.TEXT_NODE) parent.children.push(child.data);
      else if (child.nodeType === Node.ELEMENT_NODE) {
        const attributes = child.attributes.length
          ? Array.from(child.attributes, ({ name, value, namespaceURI }) => [name, value, namespaceURI]) : null;
        const content = [];
        parent.children.push([child.namespaceURI, child.localName, attributes, content]);
        if (child.firstChild) pending.push({ next: child.firstChild, children: content });
      }
    }
    if (pending.length) idle = requestIdleCallback(capture, { timeout: 120 });
    else complete(result);
  };
  idle = requestIdleCallback(capture, { timeout: 120 });
  return () => cancelIdleCallback(idle);
}

function appendSnapshot(element, children) {
  const document = element.ownerDocument;
  for (const child of children) {
    if (typeof child === 'string') element.append(document.createTextNode(child));
    else {
      const [namespace, tag, attributes, content] = child;
      const node = document.createElementNS(namespace, tag);
      if (attributes) for (const [name, value, attributeNamespace] of attributes) {
        if (attributeNamespace) node.setAttributeNS(attributeNamespace, name, value);
        else node.setAttribute(name, value);
      }
      appendSnapshot(node, content);
      element.append(node);
    }
  }
}

function handlePreviewClick(event) {
  const link = event.target.closest('a');
  if (link) openMarkdownLink(event, link.getAttribute('href'));
  else if (event.target.closest('.code-heading button')) {
    const code = event.target.closest('.code-card')?.querySelector('pre')?.textContent ?? '';
    window.span.copyText(code).catch(() => {});
  }
}

export const FileMarkdownContent = memo(function FileMarkdownContent({ text, parked, preserveSelection, onBodyReady }) {
  const [released, setReleased] = useState(false);
  const body = useRef(null);
  const previous = useRef(null);
  const rendered = previous.current?.text === text ? previous.current
    : parked ? undefined : { text, content: renderMarkdown(text).content };
  useLayoutEffect(() => { if (rendered) previous.current = rendered; }, [rendered]);
  useEffect(() => {
    if (!parked) {
      if (!released) return;
      // Let the preview shell paint and take focus before mounting a large document.
      let frame = requestAnimationFrame(() => { frame = requestAnimationFrame(() => setReleased(false)); });
      return () => cancelAnimationFrame(frame);
    }
    if (released || preserveSelection || text.length < largePreviewText) return;
    let cancelSnapshot;
    const timer = setTimeout(() => {
      if (!body.current || !rendered || rendered.nodes) {
        setReleased(true);
        return;
      }
      // Markdown has already rendered literal HTML as text. Save only the elements it created.
      cancelSnapshot = snapshotChildren(body.current, nodes => {
        rendered.nodes = nodes;
        rendered.content = null;
        setReleased(true);
      });
    }, parkedPreviewDelayMs);
    return () => {
      clearTimeout(timer);
      cancelSnapshot?.();
    };
  }, [parked, preserveSelection, released, rendered, text]);
  const attach = useCallback(element => {
    body.current = element;
    if (element && rendered?.nodes && !element.firstChild) {
      const fragment = element.ownerDocument.createDocumentFragment();
      appendSnapshot(fragment, rendered.nodes);
      element.append(fragment);
    }
    onBodyReady(element);
  }, [rendered, onBodyReady]);
  if (released) return parked ? null : <p className="preview-resuming" role="status">正在恢复预览…</p>;
  return rendered && <div className="prose" ref={attach}
    onClick={rendered.nodes ? handlePreviewClick : undefined}>{rendered.content}</div>;
});

const MarkdownPart = memo(function MarkdownPart({ text, inspect, cache }) {
  const reusable = cache && !inspect && text.length <= cacheTextLimit;
  const part = (reusable ? cache.entries.get(text) : undefined) ?? renderMarkdown(text, inspect);
  useLayoutEffect(() => {
    if (!reusable || part.weight > cacheBudget) return;
    const { entries } = cache;
    cache.weight -= entries.get(text)?.weight ?? 0;
    entries.delete(text);
    entries.set(text, part);
    cache.weight += part.weight;
    while (entries.size > cacheEntries || cache.weight > cacheBudget) {
      const oldest = entries.keys().next().value;
      cache.weight -= entries.get(oldest).weight;
      entries.delete(oldest);
    }
  }, [cache, part, reusable, text]);
  return part.content;
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
