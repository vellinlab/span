import { useId, useLayoutEffect, useRef, useState } from 'react';
import { Archive, ArchiveRestore, ChevronDown, Pencil } from 'lucide-react';

export function SessionActions({ title, archived, disabled, rename, archive }) {
  const id = useId();
  const trigger = useRef(null);
  const popover = useRef(null);
  const field = useRef(null);
  const [editing, setEditing] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');

  useLayoutEffect(() => {
    const panel = popover.current;
    if (!panel.matches(':popover-open')) return;
    if (disabled) panel.hidePopover();
    else if (editing) {
      field.current.focus();
      field.current.select();
    }
    else panel.querySelector('button')?.focus();
  }, [disabled, editing]);

  async function perform(action) {
    if (pending || disabled) return;
    setPending(true);
    setError('');
    try {
      await action();
      const panel = popover.current;
      if (panel?.matches(':popover-open')) {
        const focused = document.activeElement;
        panel.hidePopover();
        if (editing && (panel.contains(focused) || focused === document.body)) trigger.current?.focus();
      }
    } catch (error) {
      setError(error.message);
    } finally {
      setPending(false);
    }
  }

  const ArchiveIcon = archived ? ArchiveRestore : Archive;
  return <>
    <button type="button" className="session-title" popoverTarget={id} disabled={disabled} ref={trigger}
      aria-label={`会话操作 · ${title}`}>
      <strong title={title}>{title}</strong><ChevronDown size={12} aria-hidden="true" />
    </button>
    <div id={id} className="session-actions popup-surface" popover="auto" ref={popover} role="region"
      aria-label="会话操作" onToggle={event => {
        if (event.nativeEvent.newState === 'open') event.currentTarget.querySelector('button')?.focus();
        else {
          setEditing(false);
          setError('');
        }
      }}>
      {editing ? <form className="session-rename" onSubmit={event => {
        event.preventDefault();
        const next = field.current.value.trim();
        if (next) perform(() => rename(next));
      }}>
        <label>会话名称<input ref={field} defaultValue={title} required readOnly={pending}
          onKeyDown={event => {
            if (event.nativeEvent.isComposing && ['Enter', 'Escape'].includes(event.key)) event.preventDefault();
          }} /></label>
        <div className="panel-actions">
          <button type="button" onClick={() => { setEditing(false); setError(''); }} disabled={pending}>取消</button>
          <button type="submit" className="primary" disabled={pending}>保存</button>
        </div>
      </form> : <div className="session-action-list">
        {rename && <button type="button" onClick={() => setEditing(true)} disabled={pending}><Pencil size={15} />重命名</button>}
        {archive && <button type="button" onClick={() => perform(archive)} disabled={pending}>
          <ArchiveIcon size={15} />{archived ? '恢复会话' : '归档会话'}
        </button>}
      </div>}
      {error && <p className="session-action-error" role="alert">{error}</p>}
    </div>
  </>;
}
