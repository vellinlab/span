import { mergeAgentMember } from './delegation.js';
import { appendOutput } from './text-pages.js';

export const itemKey = ({ turnId, id }) => JSON.stringify([turnId, id]);

const reasoningPositionsKey = turnId => JSON.stringify([turnId, 'reasoning', null]);
const positionsByRows = new WeakMap();
const reasoningViewByRows = new WeakMap();
const layoutByRows = new WeakMap();
const membersByRows = new WeakMap();
const groupsByRows = new WeakMap();
const groupedPrefixByExpansion = new WeakMap();
const summaryTailsByRow = new WeakMap();
const summaryPreviewLength = 240;

export function delegatedMembers(rows) {
  let members = membersByRows.get(rows);
  if (!members) {
    members = new Map();
    for (const row of rows) {
      if (row.kind !== 'delegation') continue;
      for (const member of row.members ?? []) mergeAgentMember(members, member);
    }
    membersByRows.set(rows, members);
  }
  return members;
}

export function turnReasoning(rows, turnId) {
  if (!turnId) return;
  const positions = positionsByRows.get(rows);
  return positions ? rows[positions.get(reasoningPositionsKey(turnId))?.at(-1)]
    : rows.findLast(row => row.turnId === turnId && row.kind === 'reasoning' && row.preview);
}

export function turnReasoningRows(rows, turnId) {
  const cached = reasoningViewByRows.get(rows);
  if (cached && cached.turnId === turnId) return cached.details;
  const positions = positionsByRows.get(rows);
  const details = positions
    ? (positions.get(reasoningPositionsKey(turnId)) ?? []).map(index => rows[index])
    : rows.filter(row => row.turnId === turnId && row.kind === 'reasoning' && row.preview);
  reasoningViewByRows.set(rows, { turnId, details });
  return details;
}

export function hasReasoningSection(row, index) {
  const cached = summaryTailsByRow.get(row)?.[index];
  return cached ? Boolean(cached.preview) : Boolean(row.sections[index]?.trim());
}

function estimateRow(row) {
  if (!visibleRow(row)) return 0;
  if (row.kind === 'message' || row.kind === 'user') return 92;
  return activityFailurePreview(row) ? 52 : 34;
}

export function activityStatus(row) {
  const status = row.final && row.status === 'running' ? undefined : row.status;
  if (row.kind === 'command' && row.exitCode != null && row.exitCode !== 0 && (!status || status === 'completed')) {
    return 'failed';
  }
  return status;
}

export function activityFailurePreview(row, status = activityStatus(row)) {
  if (!row.final || status !== 'failed' || (row.kind !== 'command' && row.kind !== 'tool')) return;
  const text = row.errorMessage || row.text;
  if (!text || text.length > 240) return;
  const line = text.trim();
  if (line && !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(line)) return line;
}

function routineActivity(row) {
  if (!row?.final || row.status !== 'completed') return;
  if (row.kind === 'tool' || (row.kind === 'command' && row.exitCode === 0)) return row.kind;
}

function sameActivityScope(a, b) {
  return a.turnId === b.turnId && a.depth === b.depth && a.actor?.id === b.actor?.id;
}

function activityGroups(rows, start = 0) {
  const groups = [];
  while (start < rows.length) {
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

function refreshActivityGroups(groups, rows, changed) {
  const preceding = rows[changed - 1];
  // Start at the beginning of the adjacent activity run. Any earlier group
  // is separated by another scope or a non-routine row.
  let start = changed;
  while (start > 0 && routineActivity(rows[start - 1]) && sameActivityScope(preceding, rows[start - 1])) start--;
  let keep = groups.length;
  while (keep > 0 && groups[keep - 1].end > start) keep--;
  const updates = activityGroups(rows, start);
  return keep === groups.length && !updates.length ? groups : [...groups.slice(0, keep), ...updates];
}

export function timelineLayout(rows) {
  let layout = layoutByRows.get(rows);
  if (!layout) {
    const keys = rows.map(row => row.key);
    const reasoningTurns = new Map();
    const sizes = rows.map((row, index) => {
      if (row.kind === 'reasoning') reasoningTurns.set(index, row.turnId);
      return estimateRow(row);
    });
    let groups = groupsByRows.get(rows);
    if (!groups) {
      groups = activityGroups(rows);
      groupsByRows.set(rows, groups);
    }
    layout = { count: rows.length, groups, getItemKey: index => keys[index],
      estimateSize: (index, hiddenTurn) => hiddenTurn && reasoningTurns.get(index) === hiddenTurn ? 0 : sizes[index],
      rowAt: (items, index) => items[index] };
    layoutByRows.set(rows, layout);
  }
  return layout;
}

export function groupedTimelineLayout(layout, liveTurnId, ungroupedTurns, openGroups) {
  const groups = layout.groups.filter(group => group.turnId !== liveTurnId && !ungroupedTurns.has(group.turnId));
  if (!groups.length) return layout;
  let prefix = groupedPrefixByExpansion.get(openGroups);
  if (prefix?.groups.length !== groups.length ||
    groups.some((group, index) => prefix.groups[index] !== group || prefix.open[index] !== openGroups.has(group.key))) {
    const entries = [];
    const nested = new Set();
    const open = groups.map(group => openGroups.has(group.key));
    let nextRow = 0;
    for (const [index, group] of groups.entries()) {
      for (; nextRow < group.start; nextRow++) entries.push(nextRow);
      entries.push(group);
      if (open[index]) {
        for (; nextRow < group.end; nextRow++) {
          nested.add(entries.length);
          entries.push(nextRow);
        }
      }
      nextRow = group.end;
    }
    prefix = { groups, open, entries, nested, offset: entries.length - nextRow };
    groupedPrefixByExpansion.set(openGroups, prefix);
  }
  // The ungrouped tail maps directly to source rows. Appending to a live
  // turn keeps the existing history map and does not allocate tail entries.
  const { entries, offset, nested } = prefix;
  const entryAt = index => index < entries.length ? entries[index] : index - offset;
  return {
    count: layout.count + offset, nested,
    getItemKey(index) {
      const entry = entryAt(index);
      return typeof entry === 'number' ? layout.getItemKey(entry) : entry?.key;
    },
    estimateSize(index, hiddenTurn) {
      const entry = entryAt(index);
      return typeof entry === 'number' ? layout.estimateSize(entry, hiddenTurn) : 34;
    },
    rowAt(rows, index) {
      const entry = entryAt(index);
      return typeof entry === 'number' ? rows[entry] : entry;
    },
  };
}

export function historyRows(turns, previous = []) {
  const rows = applyTimeline(previous, turns.flatMap(turn => turn.rows.map(item => ({
    kind: 'item', item, final: turn.run.status !== 'running',
  }))));
  const emptyReasoning = row => row.kind === 'reasoning' && !visibleRow(row);
  return rows.some(emptyReasoning) ? rows.filter(row => !emptyReasoning(row)) : rows;
}

export function mergeHistory(previous, history) {
  const liveKeys = new Set(previous.map(row => row.itemKey ?? row.key));
  const summaries = new Map(history.filter(row => row.kind === 'reasoning').map(row => [row.key, row]));
  const sent = new Set(previous.filter(row => row.optimistic).map(row => row.clientId));
  // Backfill older history without moving the live fragments around intervening tool cards.
  return [
    ...history.filter(row => !liveKeys.has(row.key) && !(row.clientId && sent.has(row.clientId))),
    ...previous.map(row => {
      const saved = summaries.get(row.key);
      if (!saved || row.final) return row;
      return { ...row, sections: mergeSections(row.sections, saved.sections), preview: row.preview || saved.preview };
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

function summarySuffix(prefix, text) {
  const source = text.length >= summaryPreviewLength ? text : (prefix ?? '') + text;
  let start = Math.max(0, source.length - summaryPreviewLength);
  // The preview must not begin in the middle of a UTF-16 surrogate pair.
  const first = source.charCodeAt(start);
  if (first >= 0xdc00 && first <= 0xdfff) start++;
  return source.slice(start);
}

function summaryTail(previous, fragment) {
  const tail = summarySuffix(previous?.tail, fragment);
  const trimmed = fragment.trimEnd();
  if (!trimmed) return { tail, preview: previous?.preview };
  const content = trimmed === fragment ? tail : summarySuffix(previous?.tail, trimmed);
  return { tail, preview: content.split(/\r?\n/).at(-1).trim().replace(/^(?:[-*+] |#{1,6} )/, '') };
}

function addReasoning({ rows, positions, write }, data, final, delta) {
  const { turnId, id } = data;
  const section = data.section ?? 0;
  if (delta && (typeof data.text !== 'string' || !data.text || !Number.isInteger(section) || section < 0 || section >= 24)) return;
  const key = itemKey(data);
  const existing = positions.get(key)?.[0];
  const index = existing ?? rows.length;
  const previous = rows[index];
  if (previous?.final && !final) return;
  if (!delta && !data.sections.some(Boolean) && !previous) return;

  const sections = delta ? [...(previous?.sections ?? [])] : mergeSections(data.sections, previous?.sections ?? []);
  const cached = summaryTailsByRow.get(previous);
  let tails, summary;
  if (delta) {
    const text = sections[section] ?? '';
    // Keep the complete text for expanded details and history. The fixed
    // strip only reads the next fragment and the bounded tail for its section.
    const current = cached?.[section] ?? summaryTail(undefined, text);
    sections[section] = text + data.text;
    tails = cached?.slice() ?? [];
    summary = tails[section] = summaryTail(current, data.text);
  } else {
    const index = sections.findLastIndex(part => part?.trim());
    if (index !== -1) {
      summary = sections[index] === previous?.sections[index] ? cached?.[index] : undefined;
      summary ??= summaryTail(undefined, sections[index]);
      tails = [];
      tails[index] = summary;
    }
  }
  const preview = summary?.preview || previous?.preview;
  if (existing === undefined) positions.set(key, [index]);
  if (preview && !previous?.preview) {
    const reasoning = reasoningPositionsKey(turnId);
    const indexes = [...(positions.get(reasoning) ?? []), index];
    if (index < indexes.at(-2)) indexes.sort((a, b) => a - b);
    positions.set(reasoning, indexes);
  }
  const row = { ...previous, ...(delta ? {} : data), key, id, turnId, kind: 'reasoning', sections, final, preview };
  if (!final && tails) summaryTailsByRow.set(row, tails);
  write(index, row);
}

function sameFileReferences(left, right) {
  if (!left?.[0]?.reference && !right?.[0]?.reference) return true;
  const a = left?.filter(file => file.reference) ?? [];
  const b = right?.filter(file => file.reference) ?? [];
  return a.length === b.length && a.every((file, index) => file.path === b[index].path);
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
      : row.text === item.text && (!row.turnId || row.turnId === item.turnId)
        && sameFileReferences(row.attachments, item.attachments)));
    if (index !== -1) {
      write(index, { ...item, key: rows[index].key, itemKey: key, final });
      positions.set(key, [index]);
      return;
    }
  }

  if (first === undefined) {
    // Empty placeholders reserve their position but mount no content.
    positions.set(key, [rows.length]);
    const row = { ...item, key, final };
    if (item.kind === 'command' && !final) row.outputChunks = appendOutput(undefined, '', item.text ?? '');
    write(rows.length, row);
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
  if (item.kind === 'command' && item.text) {
    updated.outputChunks = final ? undefined : appendOutput(undefined, '', item.text);
  }
  write(first, updated);
}

function hasInterveningContent(rows, index) {
  for (let position = rows.length - 1; position > index; position--) {
    const row = rows[position];
    // A reasoning update can arrive during an open Markdown paragraph.
    if (row.kind !== 'reasoning' && visibleRow(row)) return true;
  }
  return false;
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
  const split = kind === 'message' && previous?.text && hasInterveningContent(rows, index);
  const row = split || !previous ? {
    id, turnId, kind, key: split ? JSON.stringify([key, indexes.length]) : key,
    ...(split ? { itemKey: key, phase: previous.phase } : {}), status: 'running',
  } : { ...previous };

  row.text = (row.text ?? '') + text;
  if (kind === 'command') row.outputChunks = appendOutput(previous?.outputChunks, text, row.text);
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
      if (row.kind === 'reasoning' && row.preview) {
        const reasoning = reasoningPositionsKey(row.turnId);
        const indexes = index.get(reasoning);
        if (indexes) indexes.push(position);
        else index.set(reasoning, [position]);
      }
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
  let members = membersByRows.get(previous);
  let reasoningView = reasoningViewByRows.get(previous);
  const groups = groupsByRows.get(previous);
  let groupingChangedAt = Infinity;
  const state = {
    rows,
    positions,
    write(position, row) {
      const earlier = rows[position];
      if (row.kind === 'delegation' || earlier?.kind === 'delegation') members = undefined;
      if (row.kind === 'reasoning' && row.turnId === reasoningView?.turnId && (row.preview || earlier?.preview)) {
        reasoningView = undefined;
      }
      const activity = routineActivity(row);
      const groupingChanged = activity !== routineActivity(earlier) ||
        (activity && (row.key !== earlier.key || !sameActivityScope(row, earlier)));
      if (groups && groupingChanged) groupingChangedAt = Math.min(groupingChangedAt, position);
      if (layout) {
        if (layout.getItemKey(position) !== row.key || layout.estimateSize(position) !== estimateRow(row) ||
          groupingChanged) {
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
  if (reasoningView) reasoningViewByRows.set(rows, reasoningView);
  // Stable callbacks let the virtualizer retain measured offsets during text-only updates.
  if (layout) layoutByRows.set(rows, layout);
  if (groups) groupsByRows.set(rows, groupingChangedAt === Infinity ? groups : refreshActivityGroups(groups, rows, groupingChangedAt));
  if (members) membersByRows.set(rows, members);
  return rows;
}

export function visibleRow(row) {
  if (row.kind === 'reasoning') return Boolean(row.preview);
  if (row.kind === 'message') return Boolean(row.text);
  if (row.kind === 'plan') return Boolean(row.text || row.steps?.length);
  if (row.kind === 'patch') return Boolean(row.text || row.files?.length);
  return true;
}
