import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';

export const catalogRowHeight = 32;
const buffer = 7;
const reserve = 2 * catalogRowHeight;

function rowOffsets(rows) {
  const offsets = [0];
  for (const row of rows) {
    const groupGap = row.entry && row.position === row.siblings ? 5 : 0;
    offsets.push(offsets.at(-1) + catalogRowHeight + groupGap);
  }
  return offsets;
}

function rowAt(offsets, top) {
  let low = 0;
  let high = offsets.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (offsets[middle + 1] <= top) low = middle + 1;
    else high = middle;
  }
  return Math.min(low, offsets.length - 2);
}

function covers(range, offsets, top, bottom, margin) {
  return range && (range.start === 0 || top >= offsets[range.start] + margin) &&
    (range.end === offsets.length - 1 || bottom <= offsets[range.end] - margin);
}

export function useCatalogViewport(rows, indexes, scope, scrollPosition) {
  const scroll = useRef(null);
  const committed = useRef(null);
  const updateScroll = useRef(null);
  const renderedBand = useRef(null);
  const [band, setBand] = useState({ start: 0, end: 0 });
  const offsets = useMemo(() => rowOffsets(rows), [rows]);

  useLayoutEffect(() => { renderedBand.current = band; }, [band]);

  useLayoutEffect(() => {
    const element = scroll.current;
    const previous = committed.current;
    const saved = scrollPosition.current;
    let top = saved.scope === scope ? saved.top : 0;
    // Keep the same row at the same screen position if another group grows above it.
    if (previous?.scope === scope && previous.rows.length && previous.rows !== rows) {
      const old = rowAt(previous.offsets, top);
      const next = indexes.get(previous.rows[old].key);
      if (next !== undefined) top += offsets[next] - previous.offsets[old];
    }
    if (element.scrollTop !== top) element.scrollTop = top;
    const position = { scope, top: element.scrollTop };
    scrollPosition.current = position;
    committed.current = { rows, offsets, scope };

    let height = element.clientHeight;
    let requestedBand;
    function update(allowSync = false) {
      position.top = element.scrollTop;
      const end = position.top + height;
      const buffered = covers(requestedBand, offsets, position.top, end, reserve);
      const uncovered = allowSync && !covers(renderedBand.current, offsets, position.top, end, 0);
      if (buffered && !uncovered) return;

      const next = buffered ? requestedBand : {
        start: Math.max(0, rowAt(offsets, position.top) - buffer),
        end: Math.min(rows.length, rowAt(offsets, end) + buffer + 1),
      };
      requestedBand = next;
      // A scrollbar jump can expose an unmounted area immediately, unlike buffered wheel motion.
      if (uncovered) flushSync(() => setBand(next));
      else setBand(next);
    }

    const onScroll = () => update(true);
    const resize = new ResizeObserver(() => {
      const next = element.clientHeight;
      if (next === height) return;
      height = next;
      update(true);
    });
    updateScroll.current = update;
    update();
    element.addEventListener('scroll', onScroll, { passive: true });
    resize.observe(element);
    return () => {
      element.removeEventListener('scroll', onScroll);
      resize.disconnect();
    };
  }, [indexes, offsets, rows, scope, scrollPosition]);

  function ensureVisible(index) {
    const element = scroll.current;
    const top = offsets[index];
    const bottom = offsets[index + 1];
    if (top < element.scrollTop) element.scrollTop = top;
    else if (bottom > element.scrollTop + element.clientHeight) element.scrollTop = bottom - element.clientHeight;
    updateScroll.current();
  }

  function visibleRange() {
    const element = scroll.current;
    return {
      start: rowAt(offsets, element.scrollTop),
      end: rowAt(offsets, element.scrollTop + element.clientHeight - 1),
    };
  }

  return { scroll, band, offsets, ensureVisible, visibleRange };
}
