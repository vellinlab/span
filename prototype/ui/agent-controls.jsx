import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ChartNoAxesColumnIncreasing, ChevronDown, Ellipsis, Goal, SlidersHorizontal, Users, X } from 'lucide-react';
import { AgentMemberList, AgentStatus, memberName } from './agent-members.jsx';
import { sessionKey } from './agent.js';
import { ReasoningText } from './reasoning.jsx';
import { delegatedMembers, mergeAgentMember } from './timeline.js';

const statuses = {
  active: '进行中', paused: '已暂停', complete: '已完成', blocked: '受阻', limited: '达到用量上限', unknown: '状态未知',
};
const number = new Intl.NumberFormat('zh-CN');
const titles = { settings: '运行设置', goal: '会话目标', reasoning: '推理摘要', usage: '用量', agents: '代理与团队', output: '会话信息' };
const extensionLabels = { mcp: 'MCP 服务器', skill: '技能', plugin: '插件', connector: '连接器', tool: '工具' };

export function agentCommands(api, models, options) {
  if (!api) return [];
  const model = models.find(item => item.id === options.model) ?? models.find(item => item.isDefault);
  return [
    ['/new', '新建会话'], ['/resume', '打开会话或恢复指定 ID'], ['/status', '查看会话状态'],
    ['/pwd', '查看工作目录'], ['/copy', '复制最近的完整回复'],
    ...(api.goal ? [
      ['/goal', '查看或设置会话目标'], ['/goal status', '查看当前目标'], ['/goal edit', '编辑当前目标'],
      ['/goal pause', '暂停目标'], ['/goal resume', '继续目标'], ['/goal clear', '清除目标'],
    ] : []),
    ...(api.usage ? [['/usage', '查看上下文与账号额度']] : []),
    ...(api.delegation ? [['/agents', '查看子代理与团队']] : []),
    ...(models.length ? [['/model', '选择下一轮的模型']] : []),
    ...(model?.efforts.length ? [['/reasoning', '选择思考强度']] : []),
    ...(model?.tiers.length ? [['/fast', '切换速度档位']] : []),
    ...(api.modes?.some(mode => mode.id === 'plan') && models.length ? [['/plan', '切换规划模式，可附带任务']] : []),
    ...(api.permissions?.length ? [['/permissions', '选择会话权限']] : []),
    ...(api.turns.compact ? [['/compact', '压缩上下文']] : []),
    ...(api.turns.review ? [['/review', '审查代码变更']] : []),
    ...(api.sessions.fork ? [['/fork', '复制当前会话']] : []),
    ...(api.sessions.rename ? [['/rename', '重命名当前会话']] : []),
    ...(api.sessions.archive ? [['/archive', '归档或恢复当前会话']] : []),
    ...(api.extensions?.kinds ?? []).map(kind => [
      { mcp: '/mcp', skill: '/skills', plugin: '/plugins', connector: '/apps', tool: '/tools' }[kind],
      `查看${extensionLabels[kind]}`,
    ]),
    ...(api.commands ?? []).map(command => [`/${command.id}`, command.description ?? command.label]),
  ];
}

const effortNames = {
  none: '关闭', minimal: '极低', low: '低', medium: '中', high: '高', xhigh: '很高', max: '最高', ultra: 'Ultra',
};

function Selector({ label, choices, value, blank, onChange }) {
  const current = choices.some(option => option.id === value) ? value : '';
  return <label className="agent-setting"><span>{label}</span><select value={current} onChange={event => onChange(event.target.value)}>
    <option value="">{blank}</option>
    {choices.map(option => <option key={option.id} value={option.id} title={option.description}>{option.label}</option>)}
  </select></label>;
}

function RuntimeSettings({ api, models, options, setOptions }) {
  const model = models.find(model => model.id === options.model) ?? models.find(model => model.isDefault);
  const select = (name, value) => setOptions(current => ({ ...current, [name]: value || undefined }));
  return <div className="settings-grid">
    {models.length > 0 && <Selector label="模型" choices={models} value={options.model} blank="后端默认" onChange={value =>
      setOptions(current => ({ ...current, model: value || undefined, effort: undefined, tier: undefined }))} />}
    {model?.efforts.length > 0 && <Selector label="思考强度"
      choices={model.efforts.map(option => ({ ...option, label: effortNames[option.id] ?? option.label }))}
      value={options.effort} blank="模型默认" onChange={value => select('effort', value)} />}
    {model?.tiers.length > 0 && <Selector label="速度" choices={[{ id: 'default', label: '标准' },
      ...model.tiers.filter(tier => tier.id !== 'default')]} value={options.tier} blank="模型默认"
      onChange={value => select('tier', value)} />}
    {api?.modes?.length > 0 && model && <Selector label="模式" choices={api.modes} value={options.mode}
      blank="跟随会话" onChange={value => select('mode', value)} />}
    {api?.permissions?.length > 0 && <Selector label="权限" choices={api.permissions} value={options.permissions}
      blank="跟随会话" onChange={value => select('permissions', value)} />}
  </div>;
}

function GoalPanel({ goal, action, report }) {
  const [objective, setObjective] = useState(goal?.objective ?? '');
  const [budget, setBudget] = useState(goal?.budget ?? '');
  const [busy, setBusy] = useState(false);
  const [edited, setEdited] = useState(false);
  useEffect(() => {
    if (!edited) {
      setObjective(goal?.objective ?? '');
      setBudget(goal?.budget ?? '');
    }
  }, [goal?.objective, goal?.budget, edited]);
  async function update(value) {
    if (busy) return;
    setBusy(true);
    try {
      const updated = await action(value);
      if (value.kind === 'set' || value.kind === 'clear') setEdited(false);
      if (value.kind === 'clear' && updated === null) {
        setObjective('');
        setBudget('');
      }
    } catch (error) {
      report(error);
    } finally {
      setBusy(false);
    }
  }
  return <form className="goal-form" onSubmit={event => {
    event.preventDefault();
    if (objective.trim()) update({ kind: 'set', objective: objective.trim(), budget: budget === '' ? undefined : Number(budget) });
  }}>
    {goal && <div className="panel-meta">
      <span>{statuses[goal.status]}</span>
      {goal.tokens != null && <span>{number.format(goal.tokens)} tokens{goal.budget != null && ` / ${number.format(goal.budget)}`}</span>}
    </div>}
    <label>目标<textarea rows={3} value={objective} required onChange={event => { setObjective(event.target.value); setEdited(true); }} /></label>
    <label>Token 预算<input type="number" min={1} step={1} value={budget} placeholder="可选" onChange={event => { setBudget(event.target.value); setEdited(true); }} /></label>
    <div className="panel-actions">
      <button type="submit" className="primary" disabled={busy || !objective.trim()}>保存目标</button>
      {goal?.status === 'active' && <button type="button" disabled={busy} onClick={() => update({ kind: 'pause' })}>暂停</button>}
      {goal?.status === 'paused' && <button type="button" disabled={busy} onClick={() => update({ kind: 'resume' })}>继续</button>}
      {goal && <button type="button" disabled={busy} onClick={() => update({ kind: 'clear' })}>清除</button>}
    </div>
  </form>;
}

function UsagePanel({ usage, refresh, report }) {
  const { tokens, limits, cost } = usage;
  const stats = [
    ['总计', tokens?.total], ['输入', tokens?.input], ['输出', tokens?.output],
    ['缓存输入', tokens?.cached], ['推理输出', tokens?.reasoning],
  ].filter(([, value]) => Number.isFinite(value));
  return <div className="usage-panel">
    {!stats.length && !limits?.length && !cost && <p>当前没有可显示的用量。</p>}
    {tokens?.contextLimit > 0 && <label className="quota">
      <span>上下文 <small>{number.format(tokens.contextUsed ?? 0)} / {number.format(tokens.contextLimit)}</small></span>
      <progress value={tokens.contextUsed ?? 0} max={tokens.contextLimit} />
    </label>}
    {stats.length > 0 && <dl>{stats.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{number.format(value)}</dd></div>)}</dl>}
    {limits?.map(limit => <label className="quota" key={limit.id}>
      <span>{limit.label}{limit.windowMinutes && ` · ${limit.windowMinutes >= 60 && limit.windowMinutes % 60 === 0
        ? `${limit.windowMinutes / 60} 小时` : `${limit.windowMinutes} 分钟`}`}<small>已用 {number.format(limit.used)}%</small></span>
      <progress value={limit.used} max={100} />
      {limit.resetsAt && <small>{new Date(limit.resetsAt * 1000).toLocaleString('zh-CN')} 重置</small>}
    </label>)}
    {cost && <p>费用 {number.format(cost.amount)} {cost.currency}</p>}
    <button type="button" className="panel-link" onClick={() => refresh().catch(report)}>刷新额度</button>
  </div>;
}

function DelegationControls({ work, members, report }) {
  const capability = work.api?.delegation;
  const actions = capability?.act ? capability.actions ?? [] : [];
  const teamActions = capability?.manageTeam ? capability.teamActions ?? [] : [];
  const [action, setAction] = useState('');
  const [busy, setBusy] = useState(false);
  const [teamId, setTeamId] = useState('');
  const team = work.teams.find(team => team.id === teamId);
  const choices = [
    ...actions.filter(kind => kind === 'start' || members.length).map(kind =>
      [kind, { start: '启动子代理', message: '发送代理消息', cancel: '停止子代理' }[kind]]),
    ...teamActions.filter(kind => kind === 'create' || work.teams.length).map(kind =>
      [kind, { create: '新建团队', assign: '指派任务', completeTask: '完成任务', close: '关闭团队' }[kind]]),
  ];
  const chooseTeam = ['assign', 'completeTask', 'close'].includes(action);
  const chooseTask = ['assign', 'completeTask'].includes(action);
  const chooseMember = ['message', 'cancel', 'assign'].includes(action);
  const textLabel = { start: '任务', message: '消息', create: '团队名称' }[action];
  if (!work.session || !choices.length) return null;
  return <form className="delegation-form" onSubmit={async event => {
    event.preventDefault();
    if (busy || !action) return;
    const data = new FormData(event.currentTarget);
    const text = String(data.get('text') ?? '').trim();
    const memberId = String(data.get('member') ?? '');
    const taskId = String(data.get('task') ?? '');
    if (textLabel && !text) return;
    setBusy(true);
    try {
      if (action === 'start') await work.delegate({ kind: action, prompt: text });
      else if (action === 'message') await work.delegate({ kind: action, memberId, text });
      else if (action === 'cancel') await work.delegate({ kind: action, memberId });
      else if (action === 'create') await work.manageTeam({ kind: action, name: text });
      else if (action === 'assign') await work.manageTeam({ kind: action, teamId, taskId, memberId });
      else if (action === 'completeTask') await work.manageTeam({ kind: action, teamId, taskId });
      else if (action === 'close') await work.manageTeam({ kind: action, teamId });
      setAction('');
    } catch (error) {
      report(error);
    } finally {
      setBusy(false);
    }
  }}>
    <select aria-label="代理操作" value={action} onChange={event => { setAction(event.target.value); setTeamId(''); }}>
      <option value="">管理代理与团队</option>
      {choices.map(([id, label]) => <option value={id} key={id}>{label}</option>)}
    </select>
    {chooseTeam && <select required aria-label="团队" value={teamId} onChange={event => setTeamId(event.target.value)}>
      <option value="">选择团队</option>{work.teams.map(team => <option key={team.id} value={team.id}>{team.name}</option>)}
    </select>}
    {chooseTask && <select required aria-label="任务" name="task">
      <option value="">选择任务</option>{team?.tasks?.map(task => <option key={task.id} value={task.id}>{task.title}</option>)}
    </select>}
    {chooseMember && <select required aria-label="代理" name="member">
      <option value="">选择代理</option>{(chooseTeam ? team?.members ?? [] : members).map(member =>
        <option key={member.id} value={member.id}>{memberName(member)}</option>)}
    </select>}
    {textLabel && <input aria-label={textLabel} name="text" placeholder={textLabel} required />}
    {action && <button className="primary" disabled={busy}>执行</button>}
  </form>;
}

function AgentTaskList({ tasks, members }) {
  const titles = new Map(tasks.map(task => [task.id, task.title]));
  return <ul className="agent-member-list" aria-label="团队任务">{tasks.map(task => {
    const assignee = task.assigneeId && members.get(task.assigneeId);
    const dependencies = task.blockedBy?.map(id => titles.get(id) || id).join('、');
    const metadata = [task.assigneeId && `负责人 ${assignee ? memberName(assignee) : task.assigneeId}`,
      dependencies && `依赖 ${dependencies}`].filter(Boolean).join(' · ');
    return <li key={task.id} className="agent-member-row">
      <span className="agent-member-label" title={task.title}>{task.title}</span>
      <AgentStatus status={task.status} />
      {metadata && <small className="agent-member-meta" title={metadata}>{metadata}</small>}
    </li>;
  })}</ul>;
}

function AgentsPanel({ work, openSession, report }) {
  const { teams, members: liveMembers } = work;
  const recordedMembers = delegatedMembers(work.rows);
  const { members, entries, groups, parents } = useMemo(() => {
    const members = new Map(recordedMembers);
    const groups = new Map(teams.map(team => [team.id, []]));
    const parents = new Map();
    for (const member of liveMembers) mergeAgentMember(members, member);
    for (const team of teams) {
      for (const member of team.members) mergeAgentMember(members, { ...member, teamId: team.id });
    }
    const entries = [...members.values()];
    const subagents = [];
    for (const member of entries) {
      (groups.get(member.teamId) ?? subagents).push(member);
      if (member.session) parents.set(sessionKey(member.session), memberName(member));
    }
    groups.set(null, subagents);
    return { members, entries, groups, parents };
  }, [recordedMembers, liveMembers, teams]);
  const activeKey = sessionKey(work.session?.ref);
  const parentName = useCallback(ref => {
    if (!ref) return;
    const key = sessionKey(ref);
    if (key !== activeKey) return parents.get(key) ?? ref.id;
  }, [activeKey, parents]);
  const canOpenSession = work.connection === 'ready' && !work.loading && !work.run;
  const sections = groups.get(null).length ? [...teams, { id: null, name: '子代理' }] : teams;
  return <div className="agent-groups">
    {!members.size && !teams.length && <p>当前会话还没有代理活动。</p>}
    {sections.map(({ id, name, tasks }) => <section key={id ?? 'subagents'} className="agent-group">
      <h3>{name}</h3>
      {groups.get(id).length > 0 && <AgentMemberList members={groups.get(id)} parentName={parentName}
        currentKey={activeKey} openSession={openSession} canOpenSession={canOpenSession} />}
      {tasks?.length > 0 && <AgentTaskList tasks={tasks} members={members} />}
    </section>)}
    <DelegationControls key={activeKey} work={work} members={entries} report={report} />
  </div>;
}

export function AgentPanel({ panel, work, reasoning, setPanel, report, openSession }) {
  const close = useRef(null);
  useLayoutEffect(() => {
    if (panel?.focus) close.current?.focus();
  }, [panel]);
  if (!panel) return null;
  const title = panel.title ?? titles[panel.kind];
  const id = panel.kind === 'goal' || panel.kind === 'reasoning' ? `${panel.kind}-panel` : undefined;
  return <section className="agent-panel popup-surface" id={id} data-kind={panel.kind}
    aria-label={title} onKeyDown={event => {
      if (event.key === 'Escape' && panel.focus) setPanel(null);
    }}>
    <header><strong>{title}</strong>
      <button ref={close} className="icon-button" type="button" aria-label="关闭面板" onClick={() => setPanel(null)}><X size={15} /></button>
    </header>
    <div className="agent-panel-content">
      {panel.kind === 'settings' && <RuntimeSettings api={work.api} models={work.models} options={work.options} setOptions={work.setOptions} />}
      {panel.kind === 'goal' && <GoalPanel key={work.session?.ref.id} goal={work.goal} action={work.goalAction} report={report} />}
      {panel.kind === 'reasoning' && <ReasoningText row={reasoning} />}
      {panel.kind === 'usage' && <UsagePanel usage={work.usage} refresh={work.refreshUsage} report={report} />}
      {panel.kind === 'agents' && <AgentsPanel work={work} openSession={openSession} report={report} />}
      {panel.kind === 'output' && <pre className="panel-output">{panel.text}</pre>}
      {panel.kind === 'extensions' && (panel.items?.length
        ? <ul className="extensions">{panel.items.map(item => <li key={item.id}>
          <strong>{item.label}</strong><small>{item.status ?? (item.enabled == null ? item.source : item.enabled ? '已启用' : '已停用')}</small>
          {item.description && <p>{item.description}</p>}
        </li>)}</ul> : <p>没有可显示的{extensionLabels[panel.extension]}。</p>)}
    </div>
  </section>;
}

export function AgentMenu({ work, onSelect }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const dismiss = event => {
      if (event.key === 'Escape' || (event.type === 'pointerdown' && !event.target.closest('.agent-menu'))) setOpen(false);
    };
    window.addEventListener('keydown', dismiss);
    window.addEventListener('pointerdown', dismiss);
    return () => {
      window.removeEventListener('keydown', dismiss);
      window.removeEventListener('pointerdown', dismiss);
    };
  }, [open]);
  const { api, goal, models, options } = work;
  const entries = [
    ...(models.length || api?.permissions?.length ? [['settings', SlidersHorizontal]] : []),
    ...(api?.goal && !goal ? [['goal', Goal]] : []),
    ...(api?.usage ? [['usage', ChartNoAxesColumnIncreasing]] : []),
    ...(api?.delegation ? [['agents', Users]] : []),
  ];
  if (!entries.length) return null;
  const selectedModel = models.find(model => model.id === options.model);
  const label = [selectedModel?.label, api?.modes?.find(mode => mode.id === options.mode && mode.id !== 'default')?.label].filter(Boolean).join(' · ');
  return <div className="agent-menu">
    <button className="composer-control" type="button" aria-label="Agent 控件" aria-expanded={open}
      onClick={() => setOpen(value => !value)}>
      {label ? <><span>{label}</span><ChevronDown size={12} /></> : <Ellipsis size={17} />}
    </button>
    {open && <div className="agent-menu-entries popup-surface" aria-label="Agent 控件">
      {entries.map(([kind, Icon]) => <button key={kind} type="button" onClick={() => {
        setOpen(false);
        onSelect(kind);
      }}><Icon size={15} />{titles[kind]}</button>)}
    </div>}
  </div>;
}

export function GoalStrip({ goal, expanded, toggle }) {
  if (!goal) return null;
  return <button type="button" className="goal-strip" title={goal.objective} aria-expanded={expanded}
    aria-controls={expanded ? 'goal-panel' : undefined} data-status={goal.status} onClick={toggle}>
    <Goal size={16} className="goal-icon" /><span>{goal.objective}</span><small>{statuses[goal.status]}</small>
    <ChevronDown size={13} className="goal-chevron" />
  </button>;
}
