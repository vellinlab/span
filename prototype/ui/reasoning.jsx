import { memo, useLayoutEffect, useRef } from 'react';
import { Brain, ChevronDown } from 'lucide-react';
import { Markdown } from './markdown.jsx';

export const ReasoningText = memo(function ReasoningText({ row }) {
  return row && <div className="reasoning-text">{Array.from(row.sources, ([source, { sections }]) => sections.map((section, index) =>
    section?.trim() && <Markdown key={JSON.stringify([source, index])} text={section} />))}</div>;
});

export const ReasoningStrip = memo(function ReasoningStrip({ preview, expanded, toggle, hadFocus }) {
  const trigger = useRef(null);
  useLayoutEffect(() => {
    const button = trigger.current;
    return () => {
      hadFocus.current = document.activeElement === button;
    };
  }, [hadFocus]);
  return <button type="button" ref={trigger} className="reasoning-strip" data-card="live-reasoning"
    aria-label="实时推理摘要" aria-describedby="live-reasoning-preview" aria-expanded={expanded}
    aria-controls={expanded ? 'reasoning-panel' : undefined} onClick={toggle}>
    <Brain size={15} aria-hidden="true" /><span className="reasoning-label">推理摘要</span>
    <span id="live-reasoning-preview" className="reasoning-preview" title={preview}><bdi>{preview}</bdi></span>
    <ChevronDown size={13} className="reasoning-chevron" aria-hidden="true" />
  </button>;
});
