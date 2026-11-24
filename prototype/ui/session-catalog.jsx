import { memo, useCallback, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { defaultRangeExtractor, useVirtualizer } from '@tanstack/react-virtual';
import { ChevronRight, Folder } from 'lucide-react';
import { sessionKey, sessionTitle } from './agent.js';

export function directoryName(path) {
  return path?.split(/[\\/]/).filter(Boolean).at(-1) || path;
}

const rowHeight = 32;

function catalogRows(sessions, project, archived, filter, collapsed) {
  const groups = new Map();
  if (project && !archived && !filter) groups.set(project, []);
  for (const entry of sessions) {
    const title = sessionTitle(entry);
    if (filter && ![title, entry.ref.id, entry.cwd].some(value => value?.toLocaleLowerCase().includes(filter))) continue;
    const workspace = entry.cwd || project || '工作区';
    if (!groups.has(workspace)) groups.set(workspace, []);
    groups.get(workspace).push({ key: sessionKey(entry.ref), title, entry });
  }

  const rows = [];
  let position = 0;
  for (const [workspace, entries] of groups) {
    const parent = rows.length;
    const key = JSON.stringify(['workspace', workspace]);
    const expanded = entries.length ? !collapsed?.has(key) : undefined;
    rows.push({ key, title: directoryName(workspace), workspace, expanded, position: ++position, siblings: groups.size });
    if (expanded) entries.forEach((entry, index) => rows.push({
      ...entry, parent, position: index + 1, siblings: entries.length,
    }));
  }
  return rows;
}

export const SessionCatalog = memo(function SessionCatalog({
  sessions, project, scope, archived, query, selected, disabled, more, open, loadMore, scrollPosition,
}) {
  const filter = query.trim().toLocaleLowerCase();
  const scrollScope = JSON.stringify([scope, archived, filter]);
  const scroll = useRef(null);
  const prefix = useId();
  const typeahead = useRef({ text: '', time: 0 });
  const [collapsed, setCollapsed] = useState(null);
  const [activeKey, setActiveKey] = useState(null);
  const rows = useMemo(() => catalogRows(sessions, project, archived, filter,
    collapsed?.scope === scrollScope ? collapsed.keys : undefined), [sessions, project, archived, filter, collapsed, scrollScope]);
  const indexes = useMemo(() => new Map(rows.map((row, index) => [row.key, index])), [rows]);
  const active = indexes.get(activeKey);
  const rangeExtractor = useCallback(range => {
    const visible = defaultRangeExtractor(range);
    if (active === undefined || visible.includes(active)) return visible;
    return [...visible, active].sort((a, b) => a - b);
  }, [active]);
  const getItemKey = useCallback(index => rows[index].key, [rows]);
  const virtual = useVirtualizer({ count: rows.length, getScrollElement: () => scroll.current,
    getItemKey, estimateSize: index => rowHeight + (rows[index].entry && rows[index].position === rows[index].siblings ? 5 : 0),
    overscan: 4, rangeExtractor, anchorTo: 'end',
    initialOffset: () => scrollPosition.current.scope === scrollScope ? scrollPosition.current.top : 0,
  });

  useLayoutEffect(() => {
    if (scrollPosition.current.scope !== scrollScope) scrollPosition.current = { scope: scrollScope, top: 0 };
    virtual.scrollToOffset(scrollPosition.current.top);
  }, [scrollPosition, scrollScope, virtual]);

  function move(index) {
    const target = Math.max(0, Math.min(rows.length - 1, index));
    setActiveKey(rows[target].key);
    virtual.scrollToIndex(target, { align: 'auto' });
  }

  function setExpanded(row, expanded) {
    setCollapsed(previous => {
      const next = new Set(previous?.scope === scrollScope ? previous.keys : undefined);
      if (expanded) next.delete(row.key);
      else next.add(row.key);
      return { scope: scrollScope, keys: next };
    });
  }

  function activate(row) {
    if (row.expanded !== undefined) setExpanded(row, !row.expanded);
    else if (row.entry && !disabled) open(row.entry);
  }

  function onKeyDown(event) {
    if (event.isComposing || event.altKey || event.metaKey || event.ctrlKey) return;
    const index = active ?? virtual.range?.startIndex ?? 0;
    const row = rows[index];
    if (!row) return;
    const page = Math.max(1, Math.floor(scroll.current.clientHeight / rowHeight));
    switch (event.key) {
      case 'ArrowUp': move(index - 1); break;
      case 'ArrowDown': move(index + 1); break;
      case 'Home': move(0); break;
      case 'End': move(rows.length - 1); break;
      case 'PageUp': move(index - page); break;
      case 'PageDown': move(index + page); break;
      case 'ArrowLeft':
        if (row.expanded) setExpanded(row, false);
        else if (row.parent !== undefined) move(row.parent);
        break;
      case 'ArrowRight':
        if (row.expanded === false) setExpanded(row, true);
        else if (row.expanded) move(index + 1);
        break;
      case 'Enter':
      case ' ': activate(row); break;
      default: {
        if (event.key.length !== 1) return;
        const now = performance.now();
        const letter = event.key.toLocaleLowerCase();
        const text = now - typeahead.current.time < 600 ? typeahead.current.text + letter : letter;
        typeahead.current = { text, time: now };
        for (let offset = 1; offset <= rows.length; offset++) {
          const target = (index + offset) % rows.length;
          if (rows[target].title.toLocaleLowerCase().startsWith(text)) {
            move(target);
            break;
          }
        }
        break;
      }
    }
    event.preventDefault();
  }

  const mounted = virtual.getVirtualItems();
  return <div className="side-list workspaces" data-testid="session-catalog" ref={scroll}
    data-items={rows.length} onScroll={event => { scrollPosition.current = { scope: scrollScope, top: event.currentTarget.scrollTop }; }}>
    {rows.length > 0 && <div className="catalog-tree" role="tree" aria-label={archived ? '已归档会话' : '工作区会话'} tabIndex={0}
      aria-activedescendant={active !== undefined && mounted.some(item => item.index === active) ? `${prefix}-${active}` : undefined}
      onFocus={() => {
        const { startIndex, endIndex } = virtual.range ?? { startIndex: 0, endIndex: 0 };
        if (active >= startIndex && active <= endIndex) return;
        const current = indexes.get(selected);
        setActiveKey(rows[current >= startIndex && current <= endIndex ? current : startIndex]?.key ?? null);
      }} onKeyDown={onKeyDown} style={{ height: virtual.getTotalSize() }}>
      {mounted.map(item => {
        const row = rows[item.index];
        return <div key={row.key} id={`${prefix}-${item.index}`} role="treeitem" aria-level={row.entry ? 2 : 1}
          aria-posinset={row.position} aria-setsize={row.siblings} aria-expanded={row.expanded}
          aria-current={row.key === selected ? 'true' : undefined} aria-disabled={row.entry && disabled ? true : undefined}
          className={row.entry ? 'catalog-session' : 'catalog-workspace'} data-active={item.index === active}
          title={row.workspace ?? row.title} style={{ transform: `translateY(${item.start}px)` }}
          onClick={event => {
            event.currentTarget.parentElement.focus({ preventScroll: true });
            setActiveKey(row.key);
            activate(row);
          }}>
          {!row.entry && <>
            <ChevronRight className="group-chevron" size={12} aria-hidden="true" />
            <Folder size={15} aria-hidden="true" />
          </>}
          <span>{row.title}</span>
        </div>;
      })}
    </div>}
    {!rows.length && (filter || archived) && <p className="search-empty">{filter ? '没有匹配的会话' : '没有归档会话'}</p>}
    {more && <button className="load-more" type="button" onClick={loadMore}>加载更多会话</button>}
  </div>;
});
