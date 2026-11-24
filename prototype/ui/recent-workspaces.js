import { agentBackends } from './agent.js';

const storageKey = 'span.workbench.recent.v1';
const maxProfiles = 12;
const profileKey = ({ backend, ssh, cwd }) => JSON.stringify([backend, ssh, ssh ? '' : cwd]);

function validProfile(profile) {
  if (!profile || typeof profile.cwd !== 'string' || profile.cwd.length > 8192 ||
    !/^(?:\/|[a-z]:[/\\]|\\\\)/i.test(profile.cwd) || profile.cwd.includes('\0')) return false;
  const { ssh } = profile;
  if (typeof ssh !== 'string' || ssh.length > 512 || ssh.startsWith('-') || /[^a-z0-9@.:_%\[\]-]/i.test(ssh)) return false;
  return agentBackends.some(backend => backend.id === profile.backend && backend.locations.includes(ssh ? 'ssh' : 'local'));
}

function readProfiles() {
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw || raw.length > 256 * 1024) return [];
    const profiles = JSON.parse(raw);
    return Array.isArray(profiles) ? profiles.filter(validProfile).slice(0, maxProfiles) : [];
  } catch {
    return [];
  }
}

export function startupWorkspace(settings) {
  const latest = !settings.demo && readProfiles()[0];
  return { ...settings, backend: latest?.backend ?? 'codex', ssh: latest?.ssh ?? '', cwd: latest?.cwd ?? settings.cwd };
}

export function savedSession(config) {
  if (config.demo) return;
  const id = readProfiles().find(profile => profileKey(profile) === profileKey(config))?.sessionId;
  if (typeof id === 'string' && id.length > 0 && id.length <= 2048) return id;
}

// An omitted session preserves the previous selection. Null records a new blank conversation.
export function rememberWorkspace(config, sessionId) {
  if (!config || config.demo || !validProfile(config)) return;
  const profiles = readProfiles();
  const key = profileKey(config);
  const current = profiles.find(profile => profileKey(profile) === key);
  const { backend, ssh, cwd } = config;
  const next = { backend, ssh, cwd, sessionId: sessionId === undefined ? current?.sessionId : sessionId };
  if (current === profiles[0] && current?.cwd === cwd && current?.sessionId === next.sessionId) return;
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(
      [next, ...profiles.filter(profile => profileKey(profile) !== key)].slice(0, maxProfiles),
    ));
  } catch {
    // A disabled or full profile should not interrupt the conversation.
  }
}
