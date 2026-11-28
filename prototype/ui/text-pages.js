export const LINES_PER_PAGE = 8192;
const OUTPUT_CHECKPOINT_INTERVAL = 256;

export function appendOutput(previous, fragment, text) {
  if (!previous || previous.depth >= OUTPUT_CHECKPOINT_INTERVAL) return { fragment: text, depth: 0, length: text.length };
  return { previous, fragment, depth: previous.depth + 1, length: text.length };
}

// Only index chunks newer than the last committed view. A replaced or
// compacted chain starts again at its full-text checkpoint.
export function indexOutput(output, previous) {
  const fragments = [];
  let node = output;
  while (node && node !== previous?.output) {
    fragments.push(node.fragment);
    node = node.previous;
  }
  let pages = node ? previous.pages : [{ start: 0 }];
  let lines = node ? previous.lines : 0;
  let offset = node?.length ?? 0;
  for (const fragment of fragments.reverse()) {
    for (let start = 0; start < fragment.length;) {
      if (lines === LINES_PER_PAGE) {
        if (pages === previous?.pages) pages = pages.slice();
        pages.push({ start: offset + start });
        lines = 0;
      }
      let end = start;
      while (lines < LINES_PER_PAGE) {
        const newline = fragment.indexOf('\n', end);
        if (newline < 0) {
          end = fragment.length;
          break;
        }
        end = newline + 1;
        lines++;
      }
      start = end;
    }
    offset += fragment.length;
  }
  return { output, pages, lines, revision: node ? previous.revision : {} };
}

export function readOutputRange(output, start, end) {
  if (start >= end) return '';
  const fragments = [];
  for (let node = output; node && node.length > start; node = node.previous) {
    const offset = node.length - node.fragment.length;
    if (offset < end) fragments.push(node.fragment.slice(Math.max(0, start - offset), end - offset));
  }
  return fragments.length === 1 ? fragments[0] : fragments.reverse().join('');
}

export function indexText(text, updateContext, previous) {
  const append = previous && !updateContext && text.startsWith(previous.text);
  let start = append ? previous.nextLine : 0;
  let lines = append ? previous.lines : 0;
  let pages = append ? previous.pages : [{ start: 0 }];
  let context;
  for (let end; (end = text.indexOf('\n', start)) !== -1 && end < text.length - 1; start = end + 1) {
    if (updateContext) context = updateContext(context, text, start);
    if (++lines % LINES_PER_PAGE === 0) {
      if (pages === previous?.pages) pages = pages.slice();
      pages.push({ start: end + 1, context });
    }
  }
  return { text, pages, nextLine: start, lines };
}

function lineWidth(line) {
  let width = 0;
  for (let index = 0; index < line.length; index++) {
    const codePoint = line.codePointAt(index);
    width += codePoint === 0x09 ? 4 - (width % 4) : codePoint >= 0x2e80 ? 2 : 1;
    if (codePoint > 0xffff) index++;
  }
  return width;
}

export function readTextPage(text, context, updateContext, classify, previous) {
  const append = previous && !updateContext && !classify && text.startsWith(previous.text);
  const start = append ? previous.nextLine : 0;
  const rows = append ? previous.rows.slice(0, previous.completeRows) : [];
  let columns = append ? previous.completeColumns : 0;
  const lines = text.slice(start).split(/\r?\n/);
  const tail = lines.pop();
  for (const line of lines) {
    if (updateContext) context = updateContext(context, line, 0);
    columns = Math.max(columns, lineWidth(line));
    rows.push({ text: line, tone: classify?.(line, context) });
  }
  const completeRows = rows.length;
  const completeColumns = columns;
  if (tail) {
    if (updateContext) context = updateContext(context, tail, 0);
    columns = Math.max(columns, lineWidth(tail));
    rows.push({ text: tail, tone: classify?.(tail, context) });
  }
  return { text, rows, columns, completeRows, completeColumns, nextLine: text.lastIndexOf('\n') + 1 };
}
