import { codexAdapter, clueAdapter } from './codex.js';
import { piAdapter } from './pi.js';

/** @type {import('./agent-protocol').AdapterDefinition[]} */
const definitions = [codexAdapter, clueAdapter, piAdapter];

export const agentBackends = definitions.map(({ id, label, locations }) => ({ id, label, locations }));

/** @param {string} id @param {import('./agent-protocol').AdapterContext} context */
export function createAgent(id, context) {
  const definition = definitions.find(entry => entry.id === id);
  if (!definition?.locations.includes(context.location.kind)) {
    throw new Error('此主机不支持所选 Agent。');
  }
  return definition.create(context);
}

/** @param {import('./agent-protocol').SessionRef | undefined | null} ref */
export function sessionKey(ref) {
  if (!ref) return '';
  return JSON.stringify([ref.backend, ref.location.kind, ref.location.kind === 'ssh' ? ref.location.host : '', ref.id]);
}

/** @param {import('./agent-protocol').Session | undefined | null} entry */
export function sessionTitle(entry) {
  return entry?.title || entry?.preview || '新会话';
}

export function mergeSessions(previous, next) {
  return [...new Map([...previous, ...next].map(entry => [sessionKey(entry.ref), entry])).values()];
}
