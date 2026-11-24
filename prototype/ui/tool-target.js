/** @returns {import('./agent-protocol').ToolTarget | undefined} */
export function toolPathTarget(path) {
  if (typeof path === 'string' && path.length > 0 && path.length <= 8192 && !path.includes('\0')) {
    return { kind: 'path', path };
  }
}
