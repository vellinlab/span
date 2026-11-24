export const itemKey = ({ turnId, id }) => JSON.stringify([turnId, id]);

const reasoningKey = turnId => JSON.stringify([turnId, 'reasoning', null]);
const positionsByRows = new WeakMap();
const layoutByRows = new WeakMap();

export function turnReasoning(rows, turnId) {
  if (!turnId) return;
  const key = reasoningKey(turnId);
  const positions = positionsByRows.get(rows);
  return positions ? rows[positions.get(key)?.[0]] : rows.findLast(row => row.key === key);
}

function estimateRow(row) {
  if (!visibleRow(row)) return 0;
  return row.kind === 'message' || row.kind === 'user' ? 92 : 34;
}

function routineActivity(row) {
  if (!row?.final || row.status !== 'completed') return;
  if (row.kind === 'tool' || (row.kind === 'command' && row.exitCode === 0)) return row.kind;
}

function sameActivityScope(a, b) {
  return a.turnId === b.turnId && a.depth === b.depth && a.actor?.id === b.actor?.id;
}

function activityGroups(rows) {
  const groups = [];
  for (let start = 0; start < rows.length;) {
    const first = rows[start];
    const kind = routineActivity(first);
    let end = start + 1;
    if (kind) {
      let commands = Number(kind === 'command');
      for (; end < rows.length && sameActivityScope(first, rows[end]); end++) {
        const next = routineActivity(rows[end]);
        if (!next) break;
        if (next === 'command') commands++;
      }
      if (end - start >= 4) {
        groups.push({ kind: 'activity-group', key: JSON.stringify(['activities', first.key]),
          turnId: first.turnId, depth: first.depth, start, end, commands });
      }
    }
    start = end;
  }
  return groups;
}

export function timelineLayout(rows) {
  let layout = layoutByRows.get(rows);
  if (!layout) {
    const keys = rows.map(row => row.key);
    const sizes = rows.map(estimateRow);
    layout = { count: rows.length, groups: activityGroups(rows), getItemKey: index => keys[index],
      estimateSize: index => sizes[index], rowAt: (items, index) => items[index] };
    layoutByRows.set(rows, layout);
  }
  return layout;
}

export function groupedTimelineLayout(layout, liveTurnId, ungroupedTurns, openGroups) {
  const groups = layout.groups.filter(group => group.turnId !== liveTurnId && !ungroupedTurns.has(group.turnId));
  if (!groups.length) return layout;
  const entries = [];
  const nested = new Set();
  let nextRow = 0;
  for (const group of groups) {
    for (; nextRow < group.start; nextRow++) entries.push(nextRow);
    entries.push(group);
    if (openGroups.has(group.key)) {
      for (; nextRow < group.end; nextRow++) {
        nested.add(entries.length);
        entries.push(nextRow);
      }
    }
    nextRow = group.end;
  }
  for (; nextRow < layout.count; nextRow++) entries.push(nextRow);
  return {
    count: entries.length, nested,
    getItemKey: index => typeof entries[index] === 'number' ? layout.getItemKey(entries[index]) : entries[index]?.key,
    estimateSize: index => typeof entries[index] === 'number' ? layout.estimateSize(entries[index]) : 34,
    rowAt: (rows, index) => typeof entries[index] === 'number' ? rows[entries[index]] : entries[index],
  };
}

export const historyRows = turns => applyTimeline([], turns.flatMap(turn => turn.rows.map(item => ({
  kind: 'item', item, final: turn.run.status !== 'running',
})))).filter(row => row.kind !== 'reasoning' || visibleRow(row));

export function mergeHistory(previous, history) {
  const liveKeys = new Set(previous.map(row => row.itemKey ?? row.key));
  const summaries = new Map(history.filter(row => row.kind === 'reasoning').map(row => [row.key, row]));
  const sent = new Set(previous.filter(row => row.optimistic).map(row => row.clientId));
  // Backfill older history without moving the live fragments around intervening tool cards.
  return [
    ...history.filter(row => !liveKeys.has(row.key) && !(row.clientId && sent.has(row.clientId))),
    ...previous.map(row => {
      const saved = summaries.get(row.key);
      if (!saved) return row;
      const sources = new Map(saved.sources);
      for (const [id, live] of row.sources) {
        const old = sources.get(id);
        if (!old || live.final) sources.set(id, live);
        else sources.set(id, { ...live, sections: mergeSections(live.sections, old.sections) });
      }
      return { ...row, sources, preview: row.preview || saved.preview, previewSource: row.previewSource ?? saved.previewSource };
    }),
  ];
}

function mergeSections(live, snapshot) {
  const sections = [...live];
  snapshot.forEach((text, index) => {
    if (text && (!sections[index] || text.startsWith(sections[index]))) sections[index] = text;
  });
  return sections;
}

function lastSummaryLine(text) {
  return text.trimEnd().slice(-240).split(/\r?\n/).at(-1).trim().replace(/^\s*(?:[-*+] |#{1,6} )/, '');
}

function addReasoning({ rows, positions, write }, data, final, delta) {
  const { turnId, id } = data;
  const section = data.section ?? 0;
  if (delta && (typeof data.text !== 'string' || !data.text || !Number.isInteger(section) || section < 0 || section >= 24)) return;
  const key = reasoningKey(turnId);
  const existing = positions.get(key)?.[0];
  const index = existing ?? rows.length;
  const row = rows[index] ?? { key, turnId, kind: 'reasoning' };
  const previous = row.sources?.get(id);
  if (previous?.final && !final) return;
  if (!delta && !data.sections.some(Boolean) && !previous) return;

  const sections = delta ? [...(previous?.sections ?? [])] : mergeSections(data.sections, previous?.sections ?? []);
  if (delta) sections[section] = (sections[section] ?? '') + data.text;
  const sources = new Map(row.sources);
  sources.set(id, { sections, final });
  const text = delta ? sections[section] : sections.findLast(part => part?.trim());
  const preview = (delta || !previous || row.previewSource === id) && text && lastSummaryLine(text);
  if (existing === undefined) positions.set(key, [index]);
  write(index, { ...row, sources, ...(preview && { preview, previewSource: id }) });
}

function addItem(state, item, final) {
  if (item.kind === 'reasoning') return addReasoning(state, item, final, false);
  const { rows, positions, write } = state;
  const key = itemKey(item);
  const indexes = positions.get(key) ?? [];
  const first = indexes[0];
  if (item.kind === 'user' && first === undefined) {
    const index = rows.findIndex(row => row.optimistic && (item.clientId
      ? row.clientId === item.clientId
      : row.text === item.text && (!row.turnId || row.turnId === item.turnId)));
    if (index !== -1) {
      write(index, { ...item, key: rows[index].key, itemKey: key, final });
      positions.set(key, [index]);
      return;
    }
  }

  if (first === undefined) {
    // Empty placeholders reserve their position but mount no content.
    positions.set(key, [rows.length]);
    write(rows.length, { ...item, key, final });
    return;
  }

  if (item.kind === 'message' && final) {
    let offset = 0;
    for (const [ordinal, index] of indexes.entries()) {
      const row = rows[index];
      const end = ordinal === indexes.length - 1 ? undefined : offset + row.text.length;
      write(index, { ...row, ...item, text: item.text.slice(offset, end), final });
      offset = end;
    }
    return;
  }

  const row = rows[first];
  if (row.final && !final) return;
  const updated = { ...row, ...item, final };
  if ((item.kind === 'command' || item.kind === 'tool') && !item.text && row.text) {
    updated.text = row.text;
  }
  write(first, updated);
}

function addDelta(state, delta) {
  if (!delta.id || typeof delta.text !== 'string' || !delta.text) return;
  if (delta.kind === 'reasoning') return addReasoning(state, delta, false, true);
  const { rows, positions, write } = state;
  const { id, turnId, kind, text } = delta;
  const key = itemKey(delta);
  const indexes = positions.get(key) ?? [];
  const index = indexes.at(-1);
  const previous = rows[index];
  if (previous?.final) return;
  const split = kind === 'message' && previous?.text && index < rows.length - 1
    && rows.slice(index + 1).some(visibleRow);
  const row = split || !previous ? {
    id, turnId, kind, key: split ? JSON.stringify([key, indexes.length]) : key,
    ...(split ? { itemKey: key, phase: previous.phase } : {}), status: 'running',
  } : { ...previous };

  row.text = (row.text ?? '') + text;
  if (kind === 'patch') row.files ??= [];

  if (split || !previous) {
    positions.set(key, [...indexes, rows.length]);
    write(rows.length, row);
  } else {
    write(index, row);
  }
}

export function applyTimeline(previous, events) {
  const rows = [...previous];
  let index = positionsByRows.get(previous);
  let ownsIndex = !index;
  if (!index) {
    index = new Map();
    previous.forEach((row, position) => {
      if (row.optimistic) return;
      const key = row.itemKey ?? row.key;
      const indexes = index.get(key);
      if (indexes) indexes.push(position);
      else index.set(key, [position]);
    });
  }
  // Existing rows retain their positions during streaming. Copy the index only
  // when adding a position so concurrent reductions can reuse the same input.
  const positions = {
    get: key => index.get(key),
    set(key, indexes) {
      if (!ownsIndex) {
        index = new Map(index);
        ownsIndex = true;
      }
      index.set(key, indexes);
    },
  };
  let layout = layoutByRows.get(previous);
  const state = {
    rows,
    positions,
    write(position, row) {
      if (layout) {
        const previous = rows[position];
        const activity = routineActivity(row);
        if (layout.getItemKey(position) !== row.key || layout.estimateSize(position) !== estimateRow(row) ||
          activity !== routineActivity(previous) || (activity && !sameActivityScope(row, previous))) {
          layout = undefined;
        }
      }
      rows[position] = row;
    },
  };
  for (const event of events) {
    if (event.kind === 'item') addItem(state, event.item, event.final);
    else if (event.kind === 'delta') addDelta(state, event.delta);
  }
  positionsByRows.set(rows, index);
  // Stable callbacks let the virtualizer retain measured offsets during text-only updates.
  if (layout) layoutByRows.set(rows, layout);
  return rows;
}

export function visibleRow(row) {
  if (row.kind === 'reasoning') return Boolean(row.preview);
  if (row.kind === 'message') return Boolean(row.text);
  if (row.kind === 'plan') return Boolean(row.text || row.steps?.length);
  if (row.kind === 'patch') return Boolean(row.text || row.files?.length);
  return true;
}
