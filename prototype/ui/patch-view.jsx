import { memo, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { PathText } from './file-reference-name.jsx';
import { CopyTextButton, readTextPosition, rememberReaderPosition, TextReader } from './text-reader.jsx';

function updateHunk(inHunk, text, start) {
  if (text.startsWith('diff --', start)) return false;
  if (text.startsWith('@@', start)) return true;
  return inHunk;
}

function toneFor(line, inHunk) {
  if (/^(?:@@|diff --|index |\\ No newline)/.test(line)) return 'meta';
  if (!inHunk && /^(?:--- |\+\+\+ )/.test(line)) return 'meta';
  if (line.startsWith('+')) return 'add';
  if (line.startsWith('-')) return 'remove';
}

function rememberFilePosition(positions, key, viewport) {
  const position = readTextPosition(viewport);
  if (!position) return;
  rememberReaderPosition(positions, key, position.page || position.top || position.left ? position : undefined, Infinity);
}

export const PatchView = memo(function PatchView({ files, text, label = '本轮差异', directory, viewKey, viewPositions }) {
  const saved = viewPositions?.get(viewKey);
  const positions = useRef(null);
  if (!positions.current) positions.current = new Map(saved?.files);
  const scroll = useRef(null);
  const currentFile = useRef(null);
  const sources = useMemo(() => {
    const occurrences = new Map();
    const sources = files.map(file => {
      const occurrence = occurrences.get(file.path) ?? 0;
      occurrences.set(file.path, occurrence + 1);
      return { label: file.path, diff: file.diff, key: JSON.stringify([file.path, occurrence]) };
    });
    if (text) sources.push({ label, diff: text, key: 'turn' });
    return sources;
  }, [files, label, text]);
  const firstKey = sources[0]?.key;
  const [selection, setSelection] = useState(saved?.selection ?? firstKey);
  const active = sources.find(source => source.key === selection) ?? sources[0];
  const activeKey = active?.key;
  useLayoutEffect(() => {
    currentFile.current = activeKey ? { key: activeKey, first: activeKey === firstKey } : null;
    if (activeKey !== selection) setSelection(activeKey);
  }, [activeKey, firstKey, selection]);
  useLayoutEffect(() => () => {
    if (!viewPositions || !currentFile.current) return;
    const { key, first } = currentFile.current;
    rememberFilePosition(positions.current, key, scroll.current);
    const files = new Map(Array.from(positions.current).slice(-8));
    rememberReaderPosition(viewPositions, viewKey, !first || files.size ? { selection: key, files } : undefined);
  }, [viewKey, viewPositions]);
  if (!active) return null;
  function select(key) {
    rememberFilePosition(positions.current, activeKey, scroll.current);
    setSelection(key);
  }
  return <>
    <header className="diff-toolbar">
      {sources.length > 1 ? <select aria-label="变更文件" title={active.label} value={active.key}
        onChange={event => select(event.target.value)}>
        {sources.map(source => <option key={source.key} value={source.key}>{source.label}</option>)}
      </select> : (directory || files.length > 0) && <PathText className="card-path" path={directory || active.label} />}
      {active.diff && <CopyTextButton key={active.key} text={active.diff} label="复制差异" copiedLabel="已复制差异" />}
    </header>
    {active.diff ? <TextReader key={active.key} kind="diff" pagesLabel="差异分页" text={active.diff} label={active.key === 'turn' ? active.label : `${active.label}的差异`}
      position={positions.current.get(active.key)} scroll={scroll} updateContext={updateHunk} classify={toneFor} />
      : <p className="diff-empty">没有可显示的差异。</p>}
  </>;
});
