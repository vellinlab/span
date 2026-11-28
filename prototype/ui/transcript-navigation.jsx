import { useEffect, useState } from 'react';
import { ArrowDown } from 'lucide-react';

let transcriptRequest;
let transcriptView;

function TranscriptLoadError() {
  return <p role="status">无法加载会话记录，请重新打开 Span。</p>;
}

export function prepareTranscript() {
  return transcriptRequest ??= import('./transcript.jsx')
    .then(module => module.Transcript, () => TranscriptLoadError)
    .then(view => (transcriptView = view));
}

export function DeferredTranscript({ fallback, ...props }) {
  const [View, setView] = useState(() => transcriptView);
  useEffect(() => {
    if (View) return;
    let mounted = true;
    prepareTranscript().then(ready => { if (mounted) setView(() => ready); });
    return () => { mounted = false; };
  }, [View]);
  return View ? <View {...props} /> : fallback;
}

export function transcriptIsAtEnd(element) {
  return !element || element.scrollHeight - element.clientHeight - element.scrollTop < 40;
}

export function LatestMessageButton({ scroll, className, label = '滚到最新消息', onJump }) {
  return <button type="button" className={`jump-latest ${className}`} title={label} aria-label={label} onClick={() => {
    onJump?.();
    const timeline = scroll.current;
    timeline.scrollTop = timeline.scrollHeight;
    timeline.focus({ preventScroll: true });
  }}><ArrowDown size={15} aria-hidden="true" /><span>最新消息</span></button>;
}
