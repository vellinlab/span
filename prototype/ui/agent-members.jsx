import { memo } from 'react';
import { ArrowUpRight, Check, Circle, CircleAlert, CircleDot, CircleSlash } from 'lucide-react';
import { sessionKey } from './agent.js';
import { transientAgentStatus } from './delegation.js';

export const agentStatusLabels = {
  pending: '等待中', running: '进行中', completed: '已完成', failed: '失败', cancelled: '已停止', unknown: '状态未知',
};
const statusIcons = { pending: Circle, running: CircleDot, completed: Check, failed: CircleAlert, cancelled: CircleSlash };

export const memberName = member => member.name || member.role || member.id;

export function AgentStatus({ status, recorded }) {
  if (!agentStatusLabels[status]) return null;
  const Icon = statusIcons[status] ?? Circle;
  const historical = recorded && transientAgentStatus(status);
  return <span className="agent-state" data-status={status} data-recorded={historical || undefined}>
    <Icon size={13} aria-hidden="true" />{historical && '当时'}{agentStatusLabels[status]}
  </span>;
}

export const AgentMemberList = memo(function AgentMemberList({ members, parentName, currentKey, openSession, canOpenSession, openTrace, showDetail }) {
  return <ul className="agent-member-list" aria-label="代理成员">{members.map(member => {
    const name = memberName(member);
    const parent = parentName?.(member.parent);
    const role = member.role && member.role !== name ? member.role : undefined;
    const metadata = [role, member.model, parent && `父代理 ${parent}`].filter(Boolean).join(' · ');
    const label = <span className="agent-member-label">{name}</span>;
    return <li key={member.id} className="agent-member-row">
      {member.attachedTranscript && openTrace ? <button className="agent-member-name" type="button"
        aria-label={`查看 ${name} 的会话记录`} onClick={event => openTrace(member, event.currentTarget)}>
        {label}<ArrowUpRight size={13} aria-hidden="true" />
      </button> : member.session && sessionKey(member.session) !== currentKey ? <button className="agent-member-name" type="button"
        aria-label={`打开 ${name} 的会话`}
        disabled={!canOpenSession} onClick={() => openSession(member.session)}>
        {label}<ArrowUpRight size={13} aria-hidden="true" />
      </button> : label}
      <AgentStatus status={member.status} recorded={member.recorded} />
      {metadata && <small className="agent-member-meta">{metadata}</small>}
      {(showDetail || member.status === 'failed') && member.detail && <p className="agent-member-detail">{member.detail}</p>}
    </li>;
  })}</ul>;
});
