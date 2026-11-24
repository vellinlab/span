import { useCallback, useState } from 'react';
import { sessionKey } from './agent.js';

export function draftKey(config, session) {
  if (session) return sessionKey(session);
  return `new:${JSON.stringify([config?.backend, config?.ssh ?? '', config?.cwd])}`;
}

export function useDrafts() {
  const [drafts, setDrafts] = useState(() => new Map());

  function edit(key, text, files) {
    const entry = text || files?.length ? { text, files } : undefined;
    setDrafts(previous => {
      if (!entry && !previous.has(key)) return previous;
      const next = new Map(previous);
      if (entry) next.set(key, entry);
      else next.delete(key);
      return next;
    });
    return entry;
  }

  const move = useCallback((from, to) => {
    setDrafts(previous => {
      const entry = previous.get(from);
      if (!entry || from === to || previous.has(to)) return previous;
      const next = new Map(previous);
      next.delete(from);
      next.set(to, entry);
      return next;
    });
  }, []);

  function clearSent(entry) {
    setDrafts(previous => {
      // A new session may already have adopted this draft. Edits replace its identity.
      for (const [key, current] of previous) {
        if (current !== entry) continue;
        const next = new Map(previous);
        next.delete(key);
        return next;
      }
      return previous;
    });
  }

  return { drafts, edit, move, clearSent };
}
