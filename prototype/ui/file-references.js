export const maxFileReferences = 6;
const header = 'Span 附件路径（按需读取）：\n';

export function fileReferenceText(parts, local) {
  const text = parts.filter(part => part.kind === 'text').map(part => part.text).join('\n');
  const files = parts.filter(part => part.kind === 'file');
  if (!files.length) return text;
  if (!local) throw new Error('本机附件只能发送到本机 Agent。');
  if (files.length > maxFileReferences) throw new Error(`最多附加 ${maxFileReferences} 个文件。`);
  return (text ? text + '\n\n' : '') + header + files.map(file => '- ' + JSON.stringify(file.path)).join('\n');
}

export function fileReferenceArtifacts(files) {
  return files.map(({ path, name }, index) => ({
    id: 'reference:' + index, kind: 'file', name, path, reference: true,
  }));
}

export function parseFileReferences(text) {
  const start = text.lastIndexOf(header);
  if (start < 0 || (start > 0 && text.slice(start - 2, start) !== '\n\n')) return { text };
  const lines = text.slice(start + header.length).split('\n', maxFileReferences + 1);
  if (lines.length > maxFileReferences || lines.some(line => !line.startsWith('- "'))) return { text };
  try {
    const files = lines.map(line => {
      const path = JSON.parse(line.slice(2));
      if (typeof path !== 'string' || !/^(?:\/|[a-z]:[\\/]|\\\\)/i.test(path) || path.includes('\0')) {
        throw new Error('Expected an absolute file path.');
      }
      const name = (path.startsWith('/') ? path.split('/') : path.split(/[\\/]/)).at(-1);
      if (!name) throw new Error('Expected a filename.');
      return { path, name };
    });
    return { text: start ? text.slice(0, start - 2) : '', attachments: fileReferenceArtifacts(files) };
  } catch {
    return { text };
  }
}
