import { parseFileReferences } from './file-references.js';
import { toolPathTarget } from './tool-target.js';

export const piText = content => typeof content === 'string' ? content
  : (content ?? []).filter(block => block.type === 'text').map(block => block.text).join('');

const blockId = (index, block) => 'message:' + index + ':' + block;
export const piTurnId = index => 'turn:' + index;

export function piTool(turnId, id, name, args, result, isError) {
  const status = isError === undefined ? 'running' : isError ? 'failed' : 'completed';
  const text = piText(result?.content);
  const key = { id: 'tool:' + id, turnId, status };
  if (name === 'bash') {
    const exitCode = result?.details?.exitCode;
    return { ...key, kind: 'command', command: args?.command, text, exitCode };
  }
  if (name === 'edit' && result?.details?.diff && typeof args?.path === 'string') {
    return { ...key, kind: 'patch', files: [{ path: args.path, diff: result.details.diff }] };
  }
  const target = toolPathTarget(args?.path);
  return { ...key, kind: 'tool', name: name ?? 'Pi 工具', ...(target && { target }), text };
}

export function piMessage(turnId, index, message, tools, clientId) {
  if (message.role === 'user') {
    return [{ id: 'user:' + index, turnId, kind: 'user', ...parseFileReferences(piText(message.content)), clientId }];
  }
  if (message.role === 'toolResult') {
    const { name = message.toolName, args } = tools.get(message.toolCallId) ?? {};
    return [piTool(turnId, message.toolCallId, name, args, message, Boolean(message.isError))];
  }
  if (message.role !== 'assistant') return [];
  const blocks = message.content ?? [];
  const phase = blocks.some(block => block.type === 'toolCall') ? 'commentary' : 'final';
  return blocks.flatMap((block, contentIndex) => {
    const id = blockId(index, contentIndex);
    switch (block.type) {
      case 'text': return [{ kind: 'message', id, turnId, text: block.text, phase }];
      case 'thinking': return [{ kind: 'reasoning', id, turnId, sections: [block.thinking] }];
      case 'toolCall':
        tools.set(block.id, { name: block.name, args: block.arguments });
        return [piTool(turnId, block.id, block.name, block.arguments)];
      default: return [];
    }
  });
}

export function piDelta(turnId, index, update) {
  const id = blockId(index, update.contentIndex);
  if (update.type === 'text_delta') return { kind: 'message', id, turnId, text: update.delta };
  if (update.type === 'thinking_delta') return { kind: 'reasoning', id, turnId, section: 0, text: update.delta };
}

export function piRunStatus(message) {
  return message?.stopReason === 'error' ? { status: 'failed', error: message.errorMessage || 'Pi 运行失败。' }
    : message?.stopReason === 'aborted' ? { status: 'cancelled' } : { status: 'completed' };
}

export function piTurns(entries, leafId) {
  const byId = new Map(entries.map(entry => [entry.id, entry]));
  const branch = [];
  while (leafId && byId.has(leafId)) {
    const entry = byId.get(leafId);
    byId.delete(leafId);
    branch.push(entry);
    leafId = entry.parentId;
  }
  return piBranchTurns(branch.reverse());
}

export function piBranchTurns(branch, identifyTurn = (_, index) => piTurnId(index)) {
  const turns = [];
  let turn;
  let index = 0;
  let tools;
  let positions;
  for (const entry of branch) {
    if (entry.type !== 'message') continue;
    const message = entry.message;
    if (!turn || message.role === 'user') {
      const id = identifyTurn(entry, turns.length);
      turn = { id, run: { id, status: 'completed' }, rows: [] };
      turns.push(turn);
      index = 0;
      tools = new Map();
      positions = new Map();
    }
    const items = piMessage(turn.id, index++, message, tools);
    for (const item of items) {
      const previous = positions.get(item.id);
      if (previous === undefined) {
        positions.set(item.id, turn.rows.length);
        turn.rows.push(item);
      }
      else turn.rows[previous] = item;
    }
    if (message.role === 'assistant') turn.run = { id: turn.id, ...piRunStatus(message) };
  }
  return turns;
}
