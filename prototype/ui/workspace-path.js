export const windowsPath = /^[a-z]:[\\/]|^\\\\/i;

export function directoryName(path) {
  return path?.split(/[\\/]/).filter(Boolean).at(-1) || path;
}

export function workspacePathKey(path) {
  if (!windowsPath.test(path)) return path;
  const slashes = path.replaceAll('\\', '/');
  const drive = /^[a-z]:\//i.exec(slashes)?.[0];
  return drive ? drive.toLowerCase() + slashes.slice(drive.length).replace(/\/+$/, '') : slashes.replace(/\/+$/, '');
}
