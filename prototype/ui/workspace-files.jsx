import { memo, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, FileText, Folder } from 'lucide-react';
import { catalogRowHeight, useCatalogViewport } from './catalog-viewport.js';
import { FileReferenceName } from './file-reference-name.jsx';

export const WorkspaceFiles = memo(function WorkspaceFiles({ entries, cwd, directory, parent, preview, openDirectory, openFile }) {
  const rows = useMemo(() => {
    const listed = entries.map(({ name, directory: folder }) => ({
      key: name, name, folder, path: directory ? `${directory}/${name}` : name,
    }));
    if (directory) listed.unshift({ key: '', name: '上一级', path: parent, up: true, folder: true });
    return listed;
  }, [entries, directory, parent]);
  const indexes = useMemo(() => new Map(rows.map((row, index) => [row.key, index])), [rows]);
  const position = useRef({ scope: undefined, top: 0 });
  const focusTarget = useRef(null);
  const [focusedKey, setFocusedKey] = useState(null);
  const active = indexes.get(focusedKey);
  const { scroll, band, offsets, ensureVisible } = useCatalogViewport(rows, indexes, directory, position);
  const end = Math.min(band.end, rows.length);
  const visible = Array.from({ length: Math.max(0, end - band.start) }, (_, offset) => band.start + offset);
  // The file preview returns focus to its opener. Keep that native button in the list.
  if (active < band.start) visible.unshift(active);
  else if (active >= end) visible.push(active);

  useLayoutEffect(() => {
    const index = indexes.get(focusTarget.current);
    if (index === undefined) return;
    const button = scroll.current.querySelector(`[data-file-index="${index}"]`);
    if (button) {
      focusTarget.current = null;
      button.focus({ preventScroll: true });
    }
  }, [band, focusedKey, indexes, scroll]);

  function onKeyDown(event) {
    if (event.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
    const index = Number(event.target.dataset.fileIndex);
    if (!Number.isInteger(index)) return;
    const page = Math.max(1, Math.floor(scroll.current.clientHeight / catalogRowHeight));
    let next;
    switch (event.key) {
      case 'ArrowDown': next = index + 1; break;
      case 'ArrowUp': next = index - 1; break;
      case 'PageDown': next = Math.min(rows.length - 1, index + page); break;
      case 'PageUp': next = Math.max(0, index - page); break;
      case 'Home': next = 0; break;
      case 'End': next = rows.length - 1; break;
      case 'Tab':
        next = index + (event.shiftKey ? -1 : 1);
        if (next >= band.start && next < end) return;
        break;
      default: return;
    }
    if (!rows[next]) return;
    event.preventDefault();
    if (index === next) return;
    focusTarget.current = rows[next].key;
    setFocusedKey(rows[next].key);
    ensureVisible(next);
  }

  return <div className="side-list file-list" ref={scroll} data-items={rows.length} onKeyDown={onKeyDown}>
    <div className="file-list-rows" style={{ height: offsets.at(-1), '--file-row-height': `${catalogRowHeight}px` }}>
      {visible.map(index => {
        const { key, name, path, folder, up } = rows[index];
        const current = !folder && !preview?.parked && preview?.root === cwd && preview?.path === path;
        return <button key={key} className={up ? 'file-up' : undefined} data-file-index={index}
          aria-label={name} aria-current={current || undefined} title={up ? undefined : name}
          tabIndex={index >= band.start && index < end ? undefined : -1}
          style={{ top: offsets[index] }} onFocus={() => setFocusedKey(key)}
          onClick={() => folder ? openDirectory(path) : openFile(cwd, path)}>
          {up ? <><ChevronLeft size={15} aria-hidden="true" /><span>{name}</span></>
            : folder ? <><Folder size={15} aria-hidden="true" /><span>{name}</span></>
              : <><FileText size={15} aria-hidden="true" /><FileReferenceName name={name} path={name} /></>}
        </button>;
      })}
    </div>
  </div>;
});
