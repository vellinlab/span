function mergeFields(previous, fields) {
  const merged = { ...previous };
  for (const [key, value] of Object.entries(fields)) {
    if (value != null) merged[key] = value;
  }
  return merged;
}

export function mergeAgentMember(members, member) {
  members.set(member.id, mergeFields(members.get(member.id), member));
}

export function updateRoster(previous, id, entry) {
  const index = previous.findIndex(item => item.id === id);
  if (entry == null) return index < 0 ? previous : previous.filter(item => item.id !== id);
  if (index < 0) return [...previous, entry];
  const next = [...previous];
  next[index] = mergeFields(previous[index], entry);
  return next;
}

export function recordRosterUpdate(updates, id, entry) {
  const previous = updates.get(id);
  const removed = entry == null;
  updates.set(id, {
    replaced: Boolean(previous?.replaced || removed),
    entry: removed ? null : mergeFields(previous?.entry, entry),
  });
}

export function reconcileRoster(previous, snapshot, updates) {
  const known = new Map(previous.map(entry => [entry.id, entry]));
  const next = new Map(snapshot.map(entry => [entry.id, mergeFields(known.get(entry.id), entry)]));
  for (const [id, { entry, replaced }] of updates) {
    if (entry == null) next.delete(id);
    else next.set(id, mergeFields(replaced ? undefined : next.get(id) ?? known.get(id), entry));
  }
  return [...next.values()];
}

export const transientAgentStatus = status => status === 'running' || status === 'pending';
