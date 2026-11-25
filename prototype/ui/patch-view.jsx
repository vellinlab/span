import { memo, useRef, useState } from 'react';
import { PathText } from './file-reference-name.jsx';
import { CopyTextButton, TextReader } from './text-reader.jsx';

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

export const PatchView = memo(function PatchView({ files, text, label = '本轮差异', directory }) {
  const [selection, setSelection] = useState('');
  const positions = useRef(new Map());
  const scroll = useRef(null);
  const sources = files.map((file, index) => ({ label: file.path, diff: file.diff, key: JSON.stringify([file.path, index]) }));
  if (text) sources.push({ label, diff: text, key: 'turn' });
  const active = sources.find(source => source.key === selection) ?? sources[0];
  if (!active) return null;
  function select(key) {
    const viewport = scroll.current;
    if (viewport) positions.current.set(active.key, { page: Number(viewport.dataset.page),
      top: viewport.scrollTop, left: viewport.scrollLeft });
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
