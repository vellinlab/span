export const itemKey = ({ turnId, id }) => JSON.stringify([turnId, id]);

const reasoningKey = turnId => JSON.stringify([turnId, 'reasoning', null]);
const positionsByRows = new WeakMap();

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

function addReasoning(rows, positions, data, final, delta) {
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
  rows[index] = { ...row, sources, ...(preview && { preview, previewSource: id }) };
}

function addItem(rows, item, final, positions) {
  if (item.kind === 'reasoning') return addReasoning(rows, positions, item, final, false);
  const key = itemKey(item);
  const indexes = positions.get(key) ?? [];
  const first = indexes[0];
  if (item.kind === 'user' && first === undefined) {
    const index = rows.findIndex(row => row.optimistic && (item.clientId
      ? row.clientId === item.clientId
      : row.text === item.text && (!row.turnId || row.turnId === item.turnId)));
    if (index !== -1) {
      rows[index] = { ...item, key: rows[index].key, itemKey: key, final };
      positions.set(key, [index]);
      return;
    }
  }

  if (first === undefined) {
    // Empty placeholders reserve their position but mount no content.
    positions.set(key, [rows.length]);
    rows.push({ ...item, key, final });
    return;
  }

  if (item.kind === 'message' && final) {
    let offset = 0;
    for (const [ordinal, index] of indexes.entries()) {
      const row = rows[index];
      const end = ordinal === indexes.length - 1 ? undefined : offset + row.text.length;
      rows[index] = { ...row, ...item, text: item.text.slice(offset, end), final };
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
  rows[first] = updated;
}

function addDelta(rows, delta, positions) {
  if (!delta.id || typeof delta.text !== 'string' || !delta.text) return;
  if (delta.kind === 'reasoning') return addReasoning(rows, positions, delta, false, true);
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
    rows.push(row);
  } else {
    rows[index] = row;
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
  for (const event of events) {
    if (event.kind === 'item') addItem(rows, event.item, event.final, positions);
    else if (event.kind === 'delta') addDelta(rows, event.delta, positions);
  }
  positionsByRows.set(rows, index);
  return rows;
}

export function visibleRow(row) {
  if (row.kind === 'reasoning') return Boolean(row.preview);
  if (row.kind === 'message') return Boolean(row.text);
  if (row.kind === 'plan') return Boolean(row.text || row.steps?.length);
  if (row.kind === 'patch') return Boolean(row.text || row.files?.length);
  return true;
}
