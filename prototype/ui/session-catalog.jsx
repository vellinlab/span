import { memo, useId, useMemo, useRef, useState } from 'react';
import { ChevronRight, Folder } from 'lucide-react';
import { mergeSessions, sessionKey, sessionTitle } from './agent.js';
import { catalogRowHeight, useCatalogViewport } from './catalog-viewport.js';
import { directoryName, workspacePathKey } from './workspace-path.js';

function catalogRows(sessions, project, projectIdentity, remote, archived, filter, collapsed, matches) {
  const groups = new Map();
  const projectKey = projectIdentity && workspacePathKey(project);
  const identityKey = projectIdentity && workspacePathKey(projectIdentity);
  function groupFor(workspace) {
    const spelling = workspacePathKey(workspace);
    const key = spelling === projectKey ? identityKey : spelling;
    if (!groups.has(key)) groups.set(key, { workspace: key === identityKey ? projectIdentity : workspace, entries: [] });
    return groups.get(key);
  }
  if (project && !archived && !filter && (!remote || !sessions.length)) groupFor(project);
  const local = filter ? sessions.filter(entry => [sessionTitle(entry), entry.ref.id, entry.cwd]
    .some(value => value?.toLocaleLowerCase().includes(filter))) : sessions;
  const entries = matches?.length ? mergeSessions(local, matches) : local;
  for (const entry of entries) groupFor(entry.cwd || project || '工作区').entries.push({
    key: sessionKey(entry.ref), title: sessionTitle(entry), entry,
  });

  const rows = [];
  let position = 0;
  for (const [identity, { workspace, entries }] of groups) {
    const parent = rows.length;
    const key = JSON.stringify(['workspace', identity]);
    const expanded = entries.length ? !collapsed?.has(key) : undefined;
    rows.push({ key, title: directoryName(workspace), workspace, expanded, position: ++position, siblings: groups.size,
      end: parent + 1 + (expanded ? entries.length : 0) });
    if (expanded) entries.forEach((entry, index) => rows.push({
      ...entry, parent, position: index + 1, siblings: entries.length,
    }));
  }
  return rows;
}

const CatalogRow = memo(function CatalogRow({ row, id, index, top, active, selected, disabled, owns }) {
  return <div id={id} role="treeitem" aria-level={row.entry ? 2 : 1}
    aria-label={row.title} aria-owns={owns} aria-posinset={row.position} aria-setsize={row.siblings} aria-expanded={row.expanded}
    aria-current={selected ? 'true' : undefined} aria-disabled={row.entry && disabled ? true : undefined}
    className={row.entry ? 'catalog-session' : 'catalog-workspace'} data-active={active} data-catalog-index={index}
    title={row.workspace ?? row.title} style={top === undefined ? undefined : { transform: `translateY(${top}px)` }}>
    {!row.entry && <>
      <ChevronRight className="group-chevron" size={12} aria-hidden="true" />
      <Folder size={15} aria-hidden="true" />
    </>}
    <span>{row.title}</span>
  </div>;
});

export const SessionCatalog = memo(function SessionCatalog({
  sessions, project, projectIdentity, remote, scope, archived, query, selected, disabled, more, searchResult, open, loadMore, scrollPosition,
}) {
  const filter = query.toLocaleLowerCase();
  const scrollScope = JSON.stringify([scope, archived, query]);
  const view = filter ? 'search' : archived ? 'archive' : 'browse';
  const prefix = useId();
  const typeahead = useRef({ text: '', time: 0 });
  const [collapsed, setCollapsed] = useState({});
  const [activeKey, setActiveKey] = useState(null);
  const keys = collapsed[view]?.scope === scrollScope ? collapsed[view].keys : undefined;
  const matches = searchResult?.items;
  const rows = useMemo(() => catalogRows(sessions, project, projectIdentity, remote, archived, filter, keys, matches),
    [sessions, project, projectIdentity, remote, archived, filter, keys, matches]);
  const indexes = useMemo(() => new Map(rows.map((row, index) => [row.key, index])), [rows]);
  const active = indexes.get(activeKey);
  const { scroll, band, offsets, ensureVisible, visibleRange } = useCatalogViewport(rows, indexes, scrollScope, scrollPosition);

  function move(index) {
    const target = Math.max(0, Math.min(rows.length - 1, index));
    setActiveKey(rows[target].key);
    ensureVisible(target);
  }

  function setExpanded(row, expanded) {
    setCollapsed(previous => {
      const next = new Set(previous[view]?.scope === scrollScope ? previous[view].keys : undefined);
      if (expanded) next.delete(row.key);
      else next.add(row.key);
      return { ...previous, [view]: { scope: scrollScope, keys: next } };
    });
  }

  function activate(row) {
    if (row.expanded !== undefined) setExpanded(row, !row.expanded);
    else if (row.entry && !disabled) open(row.entry);
  }

  function onKeyDown(event) {
    if (event.isComposing || event.altKey || event.metaKey || event.ctrlKey) return;
    const index = active ?? visibleRange().start;
    const row = rows[index];
    if (!row) return;
    const page = Math.max(1, Math.floor(scroll.current.clientHeight / catalogRowHeight));
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

  const end = Math.min(band.end, rows.length);
  const mounted = Array.from({ length: Math.max(0, end - band.start) }, (_, offset) => band.start + offset);
  if (active !== undefined && !mounted.includes(active)) {
    if (active < band.start) mounted.unshift(active);
    else mounted.push(active);
  }
  const mountedGroups = new Map();
  for (const index of mounted) {
    const parent = rows[index].parent;
    const group = parent ?? index;
    if (!mountedGroups.has(group)) mountedGroups.set(group, []);
    if (parent !== undefined) mountedGroups.get(group).push(index);
  }
  let empty = archived && !filter ? '没有归档会话' : '';
  if (filter) {
    if (searchResult?.pending) empty = '正在搜索会话…';
    else if (searchResult?.unavailable) empty = '请连接 Agent 后搜索历史会话';
    else empty = more && !searchResult ? '已加载的会话中没有匹配项' : '没有匹配的会话';
  }
  return <div className="side-list workspaces" data-testid="session-catalog" ref={scroll} data-items={rows.length}
    aria-busy={searchResult?.pending || undefined}>
    {rows.length > 0 && <div className="catalog-tree" role="tree" aria-label={archived ? '已归档会话' : '工作区会话'} tabIndex={0}
      aria-activedescendant={active === undefined ? undefined : `${prefix}-${active}`}
      onFocus={() => {
        const { start, end } = visibleRange();
        if (active >= start && active <= end) return;
        const current = indexes.get(selected);
        setActiveKey(rows[current >= start && current <= end ? current : start]?.key ?? null);
      }} onClick={event => {
        const item = event.target.closest('[data-catalog-index]');
        if (!item) return;
        const row = rows[Number(item.dataset.catalogIndex)];
        event.currentTarget.focus({ preventScroll: true });
        setActiveKey(row.key);
        activate(row);
      }} onKeyDown={onKeyDown} style={{ height: offsets.at(-1), '--catalog-row-height': `${catalogRowHeight}px` }}>
      {Array.from(mountedGroups, ([group, children]) => {
        const row = rows[group];
        const top = offsets[group];
        const groupId = `${prefix}-${group}`;
        const childrenId = children.length ? `${groupId}-children` : undefined;
        return <div className="catalog-group" key={row.key} style={{ top, height: offsets[row.end] - top }}>
          <div className="catalog-heading">
            <CatalogRow row={row} id={groupId} index={group} active={group === active} owns={childrenId} />
          </div>
          {childrenId && <div role="group" id={childrenId}>
            {children.map(index => <CatalogRow key={rows[index].key} row={rows[index]} id={`${prefix}-${index}`} index={index}
              top={offsets[index] - top} active={index === active} selected={rows[index].key === selected} disabled={disabled} />)}
          </div>}
        </div>;
      })}
    </div>}
    {searchResult?.error ? <div className="search-feedback">
      <p role="status" title={searchResult.error}>搜索失败</p>
      <button type="button" onClick={loadMore}>重试</button>
    </div> : <>
      {!rows.length && empty && <p className="search-empty" role="status">{empty}</p>}
      {more && <button className="load-more" type="button" disabled={searchResult?.pending} onClick={loadMore}>
        {searchResult ? '加载更多结果' : '加载更多会话'}
      </button>}
    </>}
  </div>;
});
