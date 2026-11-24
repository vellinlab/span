import { memo } from 'react';
import { Image } from 'lucide-react';

export const PathText = memo(function PathText({ path, className }) {
  // POSIX absolute paths can contain literal backslashes in a filename.
  const segments = path.match(path.startsWith('/') ? /\/*[^/]+\/*|\/+/g : /[\\/]*[^\\/]+[\\/]*|[\\/]+/g);
  return <code className={className}>{segments?.map((segment, index) =>
    <span className="path-segment" key={index}>{segment}</span>)}</code>;
});

export function FileReferenceName({ name, path }) {
  if (name.length <= 16) return <span className="file-reference-name" title={path}>{name}</span>;
  const end = Array.from(name).slice(-9).join('');
  const start = name.slice(0, -end.length);
  return <span className="file-reference-name" title={path}><span>{start}</span>{end}</span>;
}

export function ImageReference({ file, onPreview }) {
  const label = <><Image size={14} role="img" aria-label="图片" /><FileReferenceName name={file.name} path={file.path} /></>;
  return onPreview && file.path
    ? <button type="button" className="attachment-preview" title={file.path} aria-label={'预览图片 · ' + file.name}
        onClick={() => onPreview(file)}>{label}</button>
    : label;
}
