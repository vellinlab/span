const { acpRequest, validSessionId } = require('./acp-http.cjs');

async function kiloGoal(connection, params) {
  const probe = params.probe === true;
  const { sessionId, cwd, action, objective, options } = params;
  if (typeof cwd !== 'string' || !cwd || cwd.length > 32768
    || (!probe && !validSessionId(sessionId))) {
    throw new Error('无效的 Kilo 会话。');
  }
  if (probe) {
    const response = await acpRequest(connection, '/command', { cwd, timeout: 2500 });
    if (!response.ok) {
      await response.body?.cancel();
      return false;
    }
    const commands = await response.json();
    return Array.isArray(commands) && commands.some(command => command.name === 'goal' && command.source === 'command');
  }
  const update = action !== undefined;
  const starts = action === 'set' || action === 'edit';
  if (starts && (typeof objective !== 'string' || !objective.trim() || objective.length > 10000)) {
    throw new Error('请输入不超过 10,000 字符的目标。');
  }
  if (update && !starts && !['pause', 'resume', 'clear'].includes(action)) throw new Error('无效的目标操作。');
  const route = `/session/${sessionId}${update ? '/command' : ''}`;
  let body;
  if (update) {
    const selected = action === 'resume' || starts ? options : null;
    body = JSON.stringify({ command: 'goal', arguments: starts ? '-- ' + objective.trim() : action,
      model: typeof selected?.model === 'string' ? selected.model : undefined,
      agent: typeof selected?.mode === 'string' ? selected.mode : undefined,
      variant: typeof selected?.effort === 'string' ? selected.effort : undefined });
  }
  const response = await acpRequest(connection, route, { cwd, method: update ? 'POST' : 'GET',
    headers: update ? { 'Content-Type': 'application/json' } : undefined, body });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Kilo 目标请求失败（HTTP ${response.status}）。`);
  }
  if (update) {
    await response.body?.cancel();
    return null;
  }
  return (await response.json()).metadata?.['kilo.goal'] ?? null;
}

module.exports = { kiloGoal };
