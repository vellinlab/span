import { memo } from 'react';
import { ArrowUpRight, Check, Circle, CircleAlert, CircleDot, CircleSlash } from 'lucide-react';
import { sessionKey } from './agent.js';

export const agentStatusLabels = {
  pending: '等待中', running: '进行中', completed: '已完成', failed: '失败', cancelled: '已停止', unknown: '状态未知',
};
const statusIcons = { pending: Circle, running: CircleDot, completed: Check, failed: CircleAlert, cancelled: CircleSlash };

export const memberName = member => member.name || member.role || member.id;

export function AgentStatus({ status }) {
  if (!agentStatusLabels[status]) return null;
  const Icon = statusIcons[status] ?? Circle;
  return <span className="agent-state" data-status={status}>
    <Icon size={13} aria-hidden="true" />{agentStatusLabels[status]}
  </span>;
}

export const AgentMemberList = memo(function AgentMemberList({ members, parentName, currentKey, openSession, canOpenSession, showDetail }) {
  return <ul className="agent-member-list" aria-label="代理成员">{members.map(member => {
    const name = memberName(member);
    const parent = parentName?.(member.parent);
    const role = member.role && member.role !== name ? member.role : undefined;
    const metadata = [role, member.model, parent && `父代理 ${parent}`].filter(Boolean).join(' · ');
    const label = <span className="agent-member-label" title={name}>{name}</span>;
    return <li key={member.id} className="agent-member-row">
      {member.session && sessionKey(member.session) !== currentKey ? <button className="agent-member-name" type="button"
        aria-label={`打开 ${name} 的会话`}
        disabled={!canOpenSession} onClick={() => openSession(member.session)}>
        {label}<ArrowUpRight size={13} aria-hidden="true" />
      </button> : label}
      <AgentStatus status={member.status} />
      {metadata && <small className="agent-member-meta" title={metadata}>{metadata}</small>}
      {showDetail && member.detail && <p className="agent-member-detail">{member.detail}</p>}
    </li>;
  })}</ul>;
});
