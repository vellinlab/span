import { mergeAgentMember } from './delegation.js';
import { appendOutput } from './text-pages.js';

export const itemKey = ({ turnId, id }) => JSON.stringify([turnId, id]);

const reasoningPositionsKey = turnId => JSON.stringify([turnId, 'reasoning', null]);
const positionsByRows = new WeakMap();
const reasoningViewByRows = new WeakMap();
const layoutByRows = new WeakMap();
const membersByRows = new WeakMap();
const groupsByRows = new WeakMap();
const processesByRows = new WeakMap();
const groupedPrefixByExpansion = new WeakMap();
const summaryTailsByRow = new WeakMap();
const summaryRevisionsByRows = new WeakMap();
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

export function sameTranscriptRows(previous, next, hiddenItem) {
  if (previous === next) return true;
  const revision = summaryRevisionsByRows.get(next);
  if (!hiddenItem || revision?.item !== hiddenItem) return false;
  const earlier = summaryRevisionsByRows.get(previous);
  return revision.base === (earlier?.item === hiddenItem ? earlier.base : earlier?.id);
}

export function hasReasoningSection(row, index) {
  const text = row.sections[index];
  if (!text) return false;
  const tails = summaryTailsByRow.get(row) ?? [];
  if (!tails[index]) {
    tails[index] = snapshotSummary(text);
    summaryTailsByRow.set(row, tails);
  }
  return Boolean(tails[index].preview);
}

function estimateRow(row) {
  if (!visibleRow(row)) return 0;
  if (row.kind === 'message' || row.kind === 'user') return 92;
  if (isDeliveredArtifact(row)) return 62 * row.artifacts.length;
  return activityFailurePreview(row) ? 52 : 34;
}

export function activityStatus(row) {
  const status = row.final && row.status === 'running' ? undefined : row.status;
  if (row.kind === 'command' && row.exitCode != null && row.exitCode !== 0 && (!status || status === 'completed')) {
    return 'failed';
  }
  return status;
}

export function isDeliveredArtifact(row) {
  return row.kind === 'artifact' && row.purpose !== 'viewed' && row.final && row.artifacts.length > 0 &&
    (!activityStatus(row) || row.status === 'completed');
}

export function activityFailurePreview(row, status = activityStatus(row)) {
  if (!row.final || status !== 'failed' || (row.kind !== 'command' && row.kind !== 'tool')) return;
  // A backend diagnostic can supply a useful first line before its detail.
  const text = row.errorMessage ? row.errorMessage.trimStart().slice(0, 241).split(/[\r\n\u2028\u2029]/, 1)[0] : row.text;
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
  updates.forEach((group, index) => {
    const previous = groups[keep + index];
    if (previous?.key === group.key && previous.turnId === group.turnId && previous.depth === group.depth &&
      previous.start === group.start && previous.end === group.end && previous.commands === group.commands) {
      updates[index] = previous;
    }
  });
  return keep === groups.length && !updates.length ? groups : [...groups.slice(0, keep), ...updates];
}

function canFoldProcess(row) {
  if (!row || !visibleRow(row)) return false;
  const status = activityStatus(row);
  if (status === 'failed' || status === 'cancelled' || status === 'blocked') return false;
  switch (row.kind) {
    case 'message': return row.phase === 'commentary' || row.phase === 'partial';
    case 'reasoning': return true;
    case 'command':
    case 'tool':
    case 'search': return row.final;
    case 'artifact': return row.final && row.purpose === 'viewed';
    default: return false;
  }
}

function completedProcess(rows, answerIndex) {
  const answer = rows[answerIndex];
  if (!answer?.completedRun || !visibleRow(answer)) return;
  let start = answerIndex;
  while (start > 0 && rows[start - 1].turnId === answer.turnId) start--;
  const ranges = [];
  let identified = answer.phase === 'final';
  for (let index = start; index < rows.length && rows[index].turnId === answer.turnId; index++) {
    const row = rows[index];
    if (!canFoldProcess(row)) continue;
    identified ||= row.kind === 'message' || row.kind === 'reasoning' || row.purpose === 'viewed';
    const range = ranges.at(-1);
    if (range?.end === index) range.end++;
    else ranges.push({ start: index, end: index + 1 });
  }
  // Older backends can omit phases and present commands as standalone results.
  if (!identified) ranges.length = 0;
  // Even when a tool lands between two answer fragments, keep the disclosure above the answer.
  return { kind: 'turn-process', key: JSON.stringify(['process', answer.turnId]),
    turnId: answer.turnId, answerIndex, start: Math.min(ranges[0]?.start ?? answerIndex, answerIndex),
    end: ranges.at(-1)?.end ?? answerIndex, ranges, durationMs: answer.completedRun.durationMs };
}

function completedProcesses(rows) {
  const processes = new Map();
  for (const [end, row] of rows.entries()) {
    if (!row.completedRun) continue;
    const process = completedProcess(rows, end);
    if (process) processes.set(row.turnId, process);
  }
  return processes;
}

function createTimelineLayout(keys, sizes, groups, processes) {
  return { count: keys.length, keys, sizes, groups, processes, getItemKey: index => keys[index],
    estimateSize: (index, hiddenItem) => hiddenItem && keys[index] === hiddenItem ? 0 : sizes[index],
    sourceIndex: index => index,
    rowAt: (items, index) => items[index] };
}

export function timelineLayout(rows) {
  let layout = layoutByRows.get(rows);
  if (!layout) {
    const keys = new Array(rows.length);
    const sizes = rows.map((row, index) => {
      keys[index] = row.key;
      return estimateRow(row);
    });
    let groups = groupsByRows.get(rows);
    if (!groups) {
      groups = activityGroups(rows);
      groupsByRows.set(rows, groups);
    }
    const processes = processesByRows.get(rows) ?? completedProcesses(rows);
    processesByRows.set(rows, processes);
    layout = createTimelineLayout(keys, sizes, groups, processes);
    layoutByRows.set(rows, layout);
  }
  return layout;
}

function updateTimelineLayout(layout, changes, groups, processes) {
  if (!changes?.size) {
    return groups === layout.groups && processes === layout.processes ? layout : { ...layout, groups, processes };
  }
  const keys = layout.keys.slice();
  const sizes = layout.sizes.slice();
  for (const [position, { key, size }] of changes) {
    keys[position] = key;
    sizes[position] = size;
  }
  return createTimelineLayout(keys, sizes, groups, processes);
}

function visibleGroups(activity, processes, liveTurnId, ungroupedTurns, openGroups) {
  const groups = activity.filter(group => {
    if (group.turnId === liveTurnId || ungroupedTurns.has(group.turnId)) return false;
    const process = processes.get(group.turnId);
    return !process || group.end <= process.start || group.start >= process.end || openGroups.has(process.key);
  });
  for (const process of processes.values()) {
    if (process.turnId !== liveTurnId && process.ranges.length) groups.push(process);
  }
  groups.sort((a, b) => a.start - b.start || Number(b.kind === 'turn-process') - Number(a.kind === 'turn-process'));
  return groups;
}

function groupPrefix(groups, openGroups) {
  const entries = [];
  const depthByIndex = new Map();
  let nextRow = 0;

  function append(entry, depth) {
    if (depth) depthByIndex.set(entries.length, depth);
    entries.push(entry);
  }

  function appendRows(end, depth = 0) {
    for (; nextRow < end; nextRow++) append(nextRow, depth);
  }

  function appendActivity(group, depth) {
    appendRows(group.start, depth);
    append(group, depth);
    if (openGroups.has(group.key)) appendRows(group.end, depth + 1);
    else nextRow = group.end;
  }

  for (let index = 0; index < groups.length; index++) {
    const group = groups[index];
    if (group.kind === 'activity-group') {
      appendActivity(group, 0);
      continue;
    }
    appendRows(group.start);
    append(group, 0);
    const open = openGroups.has(group.key);
    for (const range of group.ranges) {
      // A failure or result remains in the outer timeline between process ranges.
      appendRows(range.start);
      for (let child = groups[index + 1]; child?.kind === 'activity-group' && child.start >= range.start && child.end <= range.end;
        child = groups[index + 1]) {
        index++;
        if (open) appendActivity(child, 1);
      }
      if (open) appendRows(range.end, 1);
      else nextRow = range.end;
    }
  }
  return { groups, entries, depthByIndex, offset: entries.length - nextRow };
}

export function groupedTimelineLayout(layout, liveTurnId, ungroupedTurns, openGroups) {
  let prefix = groupedPrefixByExpansion.get(openGroups);
  const { groups: activity, processes } = layout;
  if (!prefix || prefix.activity !== activity || prefix.processes !== processes ||
    prefix.liveTurnId !== liveTurnId || prefix.ungroupedTurns !== ungroupedTurns) {
    const groups = visibleGroups(activity, processes, liveTurnId, ungroupedTurns, openGroups);
    if (prefix?.groups.length !== groups.length || groups.some((group, index) => prefix.groups[index] !== group)) {
      prefix = groupPrefix(groups, openGroups);
    }
    Object.assign(prefix, { activity, processes, liveTurnId, ungroupedTurns });
    groupedPrefixByExpansion.set(openGroups, prefix);
  }
  if (!prefix.groups.length) return layout;
  // A command finishing in the live turn can change its future group without
  // changing the rows currently used by the virtualizer.
  if (prefix.source?.getItemKey === layout.getItemKey && prefix.source.estimateSize === layout.estimateSize) return prefix.view;
  // The ungrouped tail maps directly to source rows. Appending to a live
  // turn keeps the existing history map and does not allocate tail entries.
  const { entries, offset, depthByIndex } = prefix;
  const entryAt = index => index < entries.length ? entries[index] : index - offset;
  prefix.source = layout;
  prefix.view = {
    count: layout.count + offset, depthByIndex,
    sourceIndex: index => entryAt(index),
    getItemKey(index) {
      const entry = entryAt(index);
      return typeof entry === 'number' ? layout.getItemKey(entry) : entry?.key;
    },
    estimateSize(index, hiddenItem) {
      const entry = entryAt(index);
      return typeof entry === 'number' ? layout.estimateSize(entry, hiddenItem) : entry.kind === 'turn-process' ? 32 : 34;
    },
    rowAt(rows, index) {
      const entry = entryAt(index);
      return typeof entry === 'number' ? rows[entry] : entry;
    },
  };
  return prefix.view;
}

export function historyRows(turns, previous = []) {
  const rows = turns.length ? reduceTimeline(previous, state => {
    // Replay the saved turns without building a second array of per-item events.
    for (const turn of turns) {
      const final = turn.run.status !== 'running';
      for (const item of turn.rows) addItem(state, item, final);
      completeAnswer(state, turn.run);
    }
  }) : previous;
  const emptyReasoning = row => row.kind === 'reasoning' && !visibleRow(row);
  return rows.some(emptyReasoning) ? rows.filter(row => !emptyReasoning(row)) : rows;
}

export function mergeHistory(previous, history) {
  // The first history page already has an item index. Preserve it for later deltas.
  if (!previous.length) return history;
  if (!history.length) return previous;
  // Index the arriving page. The retained transcript can be much larger.
  const savedRows = new Map();
  for (const row of history) savedRows.set(row.key, row);
  let replacements;
  const duplicates = new Set();
  const sent = new Set();
  for (let index = 0; index < previous.length; index++) {
    const row = previous[index];
    if (row.optimistic && row.clientId) sent.add(row.clientId);
    const key = row.itemKey ?? row.key;
    const saved = savedRows.get(key);
    if (!saved) continue;
    duplicates.add(key);
    let replacement;
    if (saved.completedRun && !row.completedRun && !row.itemKey && row.final) {
      replacement = { ...row, completedRun: saved.completedRun };
    } else if (saved.kind === 'reasoning' && !row.final && row.key === key) {
      replacement = { ...row, sections: mergeSections(row.sections, saved.sections), preview: row.preview || saved.preview };
    }
    if (replacement) (replacements ??= new Map()).set(index, replacement);
  }
  // Backfill older history without moving the live fragments around intervening tool cards.
  const older = history.filter(row => !duplicates.has(row.key) && !sent.has(row.clientId));
  if (!older.length && !replacements) return previous;
  const merged = older.concat(previous);
  if (replacements) for (const [index, row] of replacements) merged[older.length + index] = row;
  return merged;
}

function mergeSections(live, snapshot) {
  const sections = [...live];
  snapshot.forEach((text, index) => {
    if (text && (!sections[index] || text.startsWith(sections[index]))) sections[index] = text;
  });
  return sections;
}

function summarySuffix(prefix, text, hasCode) {
  const source = text.length >= summaryPreviewLength ? text : (prefix ?? '') + text;
  let start = Math.max(0, source.length - summaryPreviewLength);
  // The preview must not begin in the middle of a UTF-16 surrogate pair.
  const first = source.charCodeAt(start);
  if (first >= 0xdc00 && first <= 0xdfff) start++;
  if (hasCode && source[start - 1] === '`') while (source[start] === '`') start++;
  return source.slice(start);
}

function skipSummaryDestination(source, offset, { depth, escaped } = { depth: 1 }) {
  const punctuation = /[\\()\r\n]/g;
  if (escaped && offset < source.length && !/[\r\n]/.test(source[offset])) offset++;
  punctuation.lastIndex = offset;
  for (let match; (match = punctuation.exec(source));) {
    const character = match[0];
    if (character === '\r' || character === '\n') return { offset: match.index };
    if (character === '(') depth++;
    if (character === ')' && --depth === 0) return { offset: punctuation.lastIndex };
    if (character === '\\') {
      const next = source[punctuation.lastIndex];
      if (!next) return { offset: source.length, destination: { depth, escaped: true } };
      if (next !== '\r' && next !== '\n') punctuation.lastIndex++;
    }
  }
  return { offset: source.length, destination: { depth } };
}

function summaryCodeAt(source, start, end, backticks = 0) {
  const markers = /[\r\n]|`+/g;
  markers.lastIndex = start;
  for (let mark; (mark = markers.exec(source)) && mark.index < end;) {
    if (mark[0][0] !== '`') backticks = 0;
    else if (backticks === mark[0].length) backticks = 0;
    else if (!backticks && source[mark.index - 1] !== '\\') backticks = mark[0].length;
  }
  return backticks;
}

function codeBeforeSummaryTail(prefix, fragment, tail, backticks) {
  // Keep track of a code span if its opening backticks were clipped from the preview.
  const omitted = prefix.length + fragment.length - tail.length;
  return omitted ? summaryCodeAt(prefix + fragment, 0, omitted, backticks) : backticks;
}

function projectSummaryFragment(previous, fragment) {
  const prefix = previous?.tail ?? '';
  const carried = previous?.destination;
  if (carried) {
    const { offset, destination } = skipSummaryDestination(fragment, 0, carried);
    if (destination) return { prefix, fragment: '', destination };
    fragment = fragment.slice(offset);
    if (!fragment.includes('](')) return { prefix, fragment };
  } else if (!fragment.includes('](') && !prefix.includes('](') && !prefix.endsWith(']')) return;

  // The fixed line keeps a link's label. The separate detail still renders the full Markdown.
  const source = prefix + fragment;
  const links = /(?<!\\)\[([^\[\]\r\n]{1,240})\]\(https?:\/\//gi;
  const first = links.exec(source);
  if (!first) return carried ? { prefix, fragment } : undefined;
  let code = previous?.codePrefix ?? 0;
  const hasCode = code > 0 || source.includes('`');
  let start, offset;
  let scanned = 0;
  let visible = '';
  let destination;
  for (let match = first; match; match = links.exec(source)) {
    if (hasCode) {
      code = summaryCodeAt(source, scanned, match.index, code);
      scanned = match.index;
      if (code) continue;
    }
    if (start === undefined) {
      start = Math.min(prefix.length, match.index);
      offset = start;
    }
    visible += source.slice(offset, match.index) + match[1];
    ({ offset, destination } = skipSummaryDestination(source, links.lastIndex));
    if (destination) break;
    if (hasCode) {
      code = summaryCodeAt(source, match.index, links.lastIndex);
      scanned = offset;
    }
    links.lastIndex = offset;
  }
  if (start === undefined) return carried ? { prefix, fragment } : undefined;
  return { prefix: source.slice(0, start), fragment: visible + source.slice(offset), destination };
}

function summaryLineText(text, codePrefix) {
  if (!text.includes('**')) return text;
  let start = 0;
  if (codePrefix) {
    for (const mark of text.matchAll(/`+/g)) {
      if (mark[0].length !== codePrefix) continue;
      start = mark.index + mark[0].length;
      break;
    }
    if (!start) return text;
  }
  // The line is bounded. Remove paired emphasis markers while keeping inline code literal.
  const codeOrStrong = /(?<![\\`])(`+)(?!`).*?(?:(?<!`)\1(?!`)|$)|(?<![\\*])\*\*([^*\s](?:[^*]*[^*\s])?)\*\*(?!\*)/g;
  return text.slice(0, start) + text.slice(start).replace(codeOrStrong, (source, _backticks, emphasized) => emphasized ?? source);
}

function summaryTail(previous, fragment) {
  const projected = projectSummaryFragment(previous, fragment);
  const prefix = projected?.prefix ?? previous?.tail ?? '';
  const earlierCode = previous?.codePrefix ?? 0;
  const destination = projected?.destination;
  fragment = projected?.fragment ?? fragment;
  const hasCode = earlierCode > 0 || previous?.hasBackticks || fragment.includes('`');
  const tail = summarySuffix(prefix, fragment, hasCode);
  const summary = { tail, preview: previous?.preview, destination };
  if (hasCode) {
    summary.codePrefix = codeBeforeSummaryTail(prefix, fragment, tail, earlierCode);
    summary.hasBackticks = tail.includes('`');
  }
  const trimmed = fragment.trimEnd();
  if (!trimmed) return summary;
  const content = trimmed === fragment ? tail : summarySuffix(prefix, trimmed, hasCode);
  const fragmentStart = Math.max(0, content.length - trimmed.length);
  const lines = content.split('\n');
  let end = content.length;
  for (let index = lines.length - 1; index >= 0 && end > fragmentStart; index--) {
    const raw = lines[index];
    const start = end - raw.length;
    const newText = raw.slice(Math.max(0, fragmentStart - start)).trim();
    end = start - 1;
    if (!newText) continue;
    const openCode = hasCode && start === 0 && (trimmed === fragment
      ? summary.codePrefix : codeBeforeSummaryTail(prefix, trimmed, content, earlierCode));
    let text = raw.trim();
    if (!openCode) {
      text = text.replace(/^(?:>[ \t]*)+/, '');
      if (text === '**' || /^([-*_])(?:[ \t]*\1){2,}$|^(?:`{3,}[^`]*|~{3,}[^~]*)$/.test(text)) continue;
      text = text.replace(/^(?:[-*+]|#{1,6}|\d{1,9}[.)])(?:[ \t]+|$)/, '');
    }
    if (text) {
      summary.preview = summaryLineText(text, openCode);
      summary.advanced = true;
      return summary;
    }
  }
  // A chunk can end at an empty Markdown block before its words arrive.
  return summary;
}

function snapshotSummary(text) {
  if (text.length <= summaryPreviewLength) return summaryTail(undefined, text);
  // Start at a complete line near the end so links in earlier lines need no projection.
  const cutoff = text.length - summaryPreviewLength;
  let end = text.indexOf('\n', cutoff);
  const latest = summaryTail(undefined, end < 0 ? text : text.slice(end + 1));
  if (latest.preview) return latest;
  // A saved section can end with enough empty Markdown blocks to fill the preview window.
  if (end < 0) end = text.indexOf('\n', Math.max(0, text.trimEnd().length - summaryPreviewLength));
  while (end > 0) {
    const start = text.lastIndexOf('\n', end - 1) + 1;
    const { preview } = summaryTail(undefined, text.slice(start, end));
    if (preview) return { ...latest, preview };
    end = start - 1;
  }
  return latest;
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
    const current = cached?.[section] ?? snapshotSummary(text);
    sections[section] = text + data.text;
    tails = cached?.slice() ?? [];
    summary = tails[section] = summaryTail(current, data.text);
  } else {
    if (!final) tails = [];
    for (let index = sections.length - 1; index >= 0; index--) {
      const text = sections[index];
      if (!text) continue;
      const prior = text === previous?.sections[index] ? cached?.[index] : undefined;
      const sectionSummary = prior ?? snapshotSummary(text);
      if (tails) tails[index] = sectionSummary;
      if (sectionSummary.preview) {
        summary = sectionSummary;
        break;
      }
    }
  }
  const preview = (delta && !summary.advanced ? undefined : summary?.preview) || previous?.preview;
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
  const indexes = positions.get(key);
  const first = indexes?.[0];
  if (item.kind === 'user' && first === undefined && state.hasOptimisticInput) {
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
  if (item.kind === 'command') {
    if (final) updated.outputChunks = undefined;
    else if (item.text) updated.outputChunks = appendOutput(undefined, '', item.text);
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

function completeAnswer({ rows, positions, write }, run) {
  if (run.status !== 'completed') return;
  let fallback;
  let answer;
  let foundTurn = false;
  for (let index = rows.length - 1; index >= 0; index--) {
    const row = rows[index];
    if (row.turnId !== run.id) {
      if (foundTurn && row.turnId) break;
      continue;
    }
    foundTurn = true;
    if (row.kind !== 'message' || !row.final || !visibleRow(row)) continue;
    if (row.phase === 'final') answer = row;
    if (!row.phase) fallback ??= row;
  }
  answer ??= fallback;
  if (!answer) return;
  const key = answer.itemKey ?? answer.key;
  const firstVisible = positions.get(key)?.find(index => visibleRow(rows[index]));
  if (firstVisible === undefined) return;
  const row = rows[firstVisible];
  const durationMs = Number.isFinite(run.durationMs) && run.durationMs >= 0 ? run.durationMs : undefined;
  if (row.completedRun && (durationMs === undefined || row.completedRun.durationMs === durationMs)) return;
  write(firstVisible, { ...row, completedRun: { durationMs } });
}

export function applyTimeline(previous, events) {
  if (!events.length) return previous;
  return reduceTimeline(previous, state => {
    for (const event of events) {
      if (event.kind === 'item') addItem(state, event.item, event.final);
      else if (event.kind === 'delta') addDelta(state, event.delta);
      else if (event.kind === 'run') completeAnswer(state, event.run);
    }
  }, events);
}

function reduceTimeline(previous, apply, events) {
  let rows = previous;
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
  const layout = layoutByRows.get(previous);
  let layoutChanges;
  let members = membersByRows.get(previous);
  let reasoningView = reasoningViewByRows.get(previous);
  const groups = groupsByRows.get(previous);
  const processes = processesByRows.get(previous);
  let groupingChangedAt = Infinity;
  let processChanges;
  let hasOptimisticInput;
  const state = {
    get rows() { return rows; },
    get hasOptimisticInput() { return hasOptimisticInput ??= previous.some(row => row.optimistic); },
    positions,
    write(position, row) {
      const earlier = rows[position];
      const process = processes?.get(row.turnId);
      if (processes && row.completedRun !== earlier?.completedRun) {
        (processChanges ??= new Map()).set(row.turnId, position);
      } else if (process && !processChanges?.has(row.turnId) &&
        (position === process.answerIndex ? visibleRow(row) !== visibleRow(earlier) : canFoldProcess(row) !== canFoldProcess(earlier))) {
        (processChanges ??= new Map()).set(row.turnId, process.answerIndex);
      }
      if (row.kind === 'delegation' || earlier?.kind === 'delegation') members = undefined;
      if (row.kind === 'reasoning' && row.turnId === reasoningView?.turnId && (row.preview || earlier?.preview)) {
        reasoningView = undefined;
      }
      if (groups) {
        const activity = routineActivity(row);
        const groupingChanged = activity !== routineActivity(earlier) ||
          (activity && (row.key !== earlier.key || !sameActivityScope(row, earlier)));
        if (groupingChanged) groupingChangedAt = Math.min(groupingChangedAt, position);
      }
      if (layout) {
        const size = estimateRow(row);
        if (layout.keys[position] !== row.key || layout.sizes[position] !== size) {
          (layoutChanges ??= new Map()).set(position, { key: row.key, size });
        } else layoutChanges?.delete(position);
      }
      // A batch of late fragments can be discarded without publishing a new
      // transcript or copying the loaded history.
      if (rows === previous) rows = previous.slice();
      rows[position] = row;
    },
  };
  apply(state);
  positionsByRows.set(rows, index);
  if (rows === previous) return previous;
  if (reasoningView) reasoningViewByRows.set(rows, reasoningView);
  const mergedGroups = groupingChangedAt === Infinity ? groups : refreshActivityGroups(groups, rows, groupingChangedAt);
  if (mergedGroups) groupsByRows.set(rows, mergedGroups);
  let nextProcesses = processes;
  if (processChanges) {
    // Existing row indexes stay valid across a live batch. Only reloads and prepends rebuild the index.
    nextProcesses = new Map(processes);
    for (const [turnId, end] of processChanges) {
      const process = completedProcess(rows, end);
      if (process) nextProcesses.set(turnId, process);
      else nextProcesses.delete(turnId);
    }
  }
  if (nextProcesses) processesByRows.set(rows, nextProcesses);
  // Reuse unchanged measurements and derive only new or changed row metadata.
  if (layout) {
    const nextLayout = updateTimelineLayout(layout, layoutChanges, mergedGroups, nextProcesses);
    layoutByRows.set(rows, nextLayout);
    const delta = events?.[0]?.delta;
    const item = delta?.kind === 'reasoning' && itemKey(delta);
    if (layout === nextLayout && item && events.every(event =>
      event.kind === 'delta' && event.delta.kind === 'reasoning' && event.delta.id === delta.id && event.delta.turnId === delta.turnId)) {
      // Matching revisions differ only in the reasoning item shown in the fixed strip.
      // Symbols preserve the relationship without retaining earlier row arrays.
      let earlier = summaryRevisionsByRows.get(previous);
      if (!earlier) {
        earlier = { id: Symbol() };
        summaryRevisionsByRows.set(previous, earlier);
      }
      summaryRevisionsByRows.set(rows, { id: Symbol(), item, base: earlier.item === item ? earlier.base : earlier.id });
    }
  }
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
