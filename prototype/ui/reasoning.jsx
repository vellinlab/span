import { memo, useEffect, useLayoutEffect, useRef } from 'react';
import { Brain, ChevronDown } from 'lucide-react';
import { Markdown, StreamingMarkdown } from './markdown.jsx';
import { hasReasoningSection } from './timeline.js';

const ReasoningSections = memo(function ReasoningSections({ row, scroll }) {
  return <div className="reasoning-sections">{row.sections.map((text, index) => hasReasoningSection(row, index) &&
    <div key={index} className="reasoning-section">{scroll
      ? <StreamingMarkdown text={text} streaming={!row.final} following={false} scroll={scroll} />
      : <Markdown text={text} />}</div>)}</div>;
});

export const ReasoningText = memo(function ReasoningText({ rows, scroll, archived }) {
  const content = useRef(null);
  const hasContent = Boolean(rows?.length);
  useEffect(() => {
    const viewport = scroll?.current;
    const body = content.current;
    if (!viewport || !body || archived) return;
    let following = false;
    const rememberScroll = () => {
      following = viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop <= 24;
    };
    const rememberBoundaryKey = event => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      // A short summary fits in the panel and Home or End may produce no scroll event.
      if (event.key === 'Home' || event.key === 'End') following = event.key === 'End';
    };
    const observer = new ResizeObserver(() => {
      if (!following) return;
      const selection = viewport.ownerDocument.getSelection();
      if (selection?.type === 'Range' && selection.containsNode(body, true)) return;
      viewport.scrollTop = viewport.scrollHeight;
    });
    observer.observe(body);
    observer.observe(viewport);
    viewport.addEventListener('scroll', rememberScroll, { passive: true });
    viewport.addEventListener('keydown', rememberBoundaryKey);
    return () => {
      observer.disconnect();
      viewport.removeEventListener('scroll', rememberScroll);
      viewport.removeEventListener('keydown', rememberBoundaryKey);
    };
  }, [hasContent, scroll, archived]);
  return hasContent && <div ref={content} className="reasoning-text">{rows.map(row =>
    <ReasoningSections key={row.key} row={row} scroll={scroll} />)}</div>;
});

export const ReasoningStrip = memo(function ReasoningStrip({ turnId, preview, expanded, toggle, hadFocus }) {
  const trigger = useRef(null);
  useLayoutEffect(() => {
    const button = trigger.current;
    return () => {
      hadFocus.current = document.activeElement === button;
    };
  }, [hadFocus]);
  return <button type="button" ref={trigger} className="reasoning-strip" data-card="live-reasoning" data-turn-id={turnId}
    aria-label="实时推理摘要" aria-describedby="live-reasoning-preview" aria-expanded={expanded}
    aria-controls={expanded ? 'reasoning-panel' : undefined} onClick={toggle}>
    <Brain size={15} aria-hidden="true" /><span className="reasoning-label">推理摘要</span>
    <span id="live-reasoning-preview" className="reasoning-preview" title={preview}><bdi>{preview}</bdi></span>
    <ChevronDown size={13} className="reasoning-chevron" aria-hidden="true" />
  </button>;
});
