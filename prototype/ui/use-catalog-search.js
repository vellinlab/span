import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { mergeSessions } from './agent.js';

const empty = { items: [], cursor: null, pending: false, error: null };

export function useCatalogSearch(api, query, archived, enabled, revision) {
  const supported = Boolean(api?.sessions.search && query);
  const key = useMemo(() => supported && enabled ? { api, query, archived, revision } : null,
    [api, query, archived, enabled, revision, supported]);
  const [result, setResult] = useState(null);
  const pending = useRef(null);

  const fetchPage = useCallback(async (scope, cursor) => {
    if (pending.current?.scope === scope) return;
    const request = { scope };
    pending.current = request;
    setResult(previous => ({ ...(cursor && previous?.scope === scope ? previous : empty), scope, pending: true, error: null }));
    try {
      const { api, query, archived } = scope;
      const page = await api.sessions.search({ query, archived, cursor: cursor ?? undefined });
      if (pending.current !== request) return;
      setResult(previous => ({ scope, items: cursor ? mergeSessions(previous.items, page.items) : page.items,
        cursor: page.cursor, pending: false, error: null }));
    } catch (error) {
      if (pending.current !== request) return;
      setResult(previous => ({ ...previous, pending: false, error: error.message || String(error) }));
    } finally {
      if (pending.current === request) pending.current = null;
    }
  }, []);

  useEffect(() => {
    if (!key) {
      setResult(null);
      return;
    }
    const timer = setTimeout(() => fetchPage(key, null), 180);
    return () => {
      clearTimeout(timer);
      if (pending.current?.scope === key) pending.current = null;
    };
  }, [key, fetchPage]);

  return useMemo(() => {
    if (!supported) return null;
    if (!key) return { ...empty, unavailable: true };
    const page = result?.scope === key ? result : { ...empty, pending: true };
    return { ...page, load: () => fetchPage(key, page.cursor) };
  }, [key, result, supported, fetchPage]);
}
