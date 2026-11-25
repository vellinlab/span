export function observeWindowHidden(listener) {
  const span = globalThis.window?.span;
  if (span?.onWindowHidden) return span.onWindowHidden(listener);

  const document = globalThis.document;
  const onVisibilityChange = () => listener(Boolean(document?.hidden));
  onVisibilityChange();
  document?.addEventListener('visibilitychange', onVisibilityChange);
  return () => document?.removeEventListener('visibilitychange', onVisibilityChange);
}
