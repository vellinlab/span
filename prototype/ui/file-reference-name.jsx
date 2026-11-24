export function FileReferenceName({ name, path }) {
  if (name.length <= 16) return <span className="file-reference-name" title={path}>{name}</span>;
  const end = Array.from(name).slice(-9).join('');
  const start = name.slice(0, -end.length);
  return <span className="file-reference-name" title={path}><span>{start}</span>{end}</span>;
}
