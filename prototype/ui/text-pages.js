export const LINES_PER_PAGE = 8192;

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
  for (const char of line) {
    width += char === '\t' ? 4 - (width % 4) : char.codePointAt(0) >= 0x2e80 ? 2 : 1;
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
