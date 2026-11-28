import { useEffect, useRef, useState } from 'react';

const key = 'span.sidebar.width';
const minimum = 190;

export function Sidebar({ children }) {
  const [preferred, setPreferred] = useState(() => {
    const value = Number(localStorage.getItem(key));
    return Number.isFinite(value) && value >= minimum ? Math.round(value) : null;
  });
  const [viewport, setViewport] = useState(window.innerWidth);
  const [dragWidth, setDragWidth] = useState(null);
  const grabOffset = useRef(0);
  useEffect(() => {
    const resize = () => setViewport(window.innerWidth);
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);
  const maximum = Math.max(minimum, Math.min(600, Math.floor(viewport * 0.42)));
  const clamp = value => Math.round(Math.max(minimum, Math.min(maximum, value)));
  const defaultWidth = Math.max(205, Math.min(270, viewport * 0.2));
  const width = clamp(dragWidth ?? preferred ?? defaultWidth);

  function save(value) {
    setPreferred(value);
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, String(value));
  }

  return <aside className="sidebar" id="workbench-sidebar" style={{ width: dragWidth ?? preferred ?? undefined }}>
    {children}
    <div className="sidebar-grip" role="separator" tabIndex={0} aria-label="调整侧栏宽度"
      aria-controls="workbench-sidebar" aria-orientation="vertical" aria-valuemin={minimum}
      aria-valuemax={maximum} aria-valuenow={width} aria-valuetext={width + ' 像素'}
      data-dragging={dragWidth !== null} title="拖动调整宽度，双击恢复默认"
      onPointerDown={event => {
        if (!event.isPrimary || event.button !== 0) return;
        grabOffset.current = event.clientX - width;
        event.currentTarget.setPointerCapture(event.pointerId);
        setDragWidth(width);
      }}
      onPointerMove={event => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          setDragWidth(clamp(event.clientX - grabOffset.current));
        }
      }}
      onPointerUp={event => {
        if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
        save(clamp(event.clientX - grabOffset.current));
        event.currentTarget.releasePointerCapture(event.pointerId);
        setDragWidth(null);
      }}
      onLostPointerCapture={() => setDragWidth(null)}
      onDoubleClick={() => save(null)}
      onKeyDown={event => {
        const widths = { ArrowLeft: width - 16, ArrowRight: width + 16, Home: minimum, End: maximum };
        if (!Object.hasOwn(widths, event.key)) return;
        event.preventDefault();
        save(clamp(widths[event.key]));
      }} />
  </aside>;
}
