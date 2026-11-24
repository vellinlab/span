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

export function attachmentArtifacts(files) {
  return files.map(({ path, name, kind = 'file' }, index) => ({
    id: 'reference:' + index, kind, name, path, reference: true,
  }));
}

export const imageFileName = name => /\.(?:png|jpe?g|gif|webp)$/i.test(name);
export const attachmentName = path => (path.startsWith('/') ? path.split('/') : path.split(/[\\/]/)).at(-1);

function referenceStart(text) {
  const start = text.lastIndexOf(header);
  return start === 0 || (start >= 2 && text.slice(start - 2, start) === '\n\n') ? start : -1;
}

export function fileReferencePreview(text) {
  if (!text) return text;
  const start = referenceStart(text);
  if (start < 0 || !text.startsWith('- "', start + header.length)) return text;
  if (start) return text.slice(0, start - 2);
  const first = text.split('\n', 2).join('\n');
  return parseFileReferences(first).attachments?.[0]?.name ?? '文件附件';
}

export function parseFileReferences(text) {
  const start = referenceStart(text);
  if (start < 0) return { text };
  const lines = text.slice(start + header.length).split('\n', maxFileReferences + 1);
  if (lines.length > maxFileReferences || lines.some(line => !line.startsWith('- "'))) return { text };
  try {
    const files = lines.map(line => {
      const path = JSON.parse(line.slice(2));
      if (typeof path !== 'string' || !/^(?:\/|[a-z]:[\\/]|\\\\)/i.test(path) || path.includes('\0')) {
        throw new Error('Expected an absolute file path.');
      }
      const name = attachmentName(path);
      if (!name) throw new Error('Expected a filename.');
      return { path, name };
    });
    return { text: start ? text.slice(0, start - 2) : '', attachments: attachmentArtifacts(files) };
  } catch {
    return { text };
  }
}
