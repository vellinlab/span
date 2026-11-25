import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ChartNoAxesColumnIncreasing, ChevronDown, Ellipsis, Goal, SlidersHorizontal, Users, X } from 'lucide-react';
import { AgentMemberList, AgentStatus, memberName } from './agent-members.jsx';
import { sessionKey } from './agent.js';
import { mergeAgentMember } from './delegation.js';
import { ReasoningText } from './reasoning.jsx';
import { delegatedMembers } from './timeline.js';

const statuses = {
  active: '进行中', paused: '已暂停', complete: '已完成', blocked: '受阻', limited: '达到用量上限', unknown: '状态未知',
};
const number = new Intl.NumberFormat('zh-CN');
const titles = { settings: '运行设置', goal: '会话目标', reasoning: '推理摘要', usage: '用量', agents: '代理与团队', output: '会话信息' };
const extensionLabels = { mcp: 'MCP 服务器', skill: '技能', plugin: '插件', connector: '连接器', tool: '工具' };

export function commonAgentCommands(api, models, options) {
  if (!api) return [];
  const model = models.find(item => item.id === options.model) ?? models.find(item => item.isDefault);
  return [
    ['/new', '新建会话'], ['/resume', '打开会话或恢复指定 ID'], ['/status', '查看会话状态'],
    ['/pwd', '查看工作目录'], ['/copy', '复制最近的完整回复'],
    ...(api.goal ? [
      ['/goal', '查看或设置会话目标'], ['/goal status', '查看当前目标'], ['/goal edit', '编辑当前目标'],
      ['/goal pause', '暂停目标'], ['/goal resume', '继续目标'], ['/goal clear', '清除目标'],
    ] : []),
    ...(api.usage ? [['/usage', '查看 Agent 用量']] : []),
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
  ];
}

export function agentCommands(api, models, options) {
  const common = commonAgentCommands(api, models, options);
  const names = new Set(common.map(([name]) => name));
  const native = (api?.commands ?? []).filter(command => !names.has('/' + command.id));
  return [...common, ...native.map(command => ['/' + command.id, command.description ?? command.label])];
}

const effortNames = {
  none: '关闭', off: '关闭', minimal: '极低', low: '低', medium: '中', high: '高', xhigh: '很高', max: '最高', ultra: 'Ultra',
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

function GoalPanel({ goal, action, report, editOnOpen }) {
  const [editing, setEditing] = useState(() => editOnOpen || !goal);
  const [draft, setDraft] = useState(null);
  const [busy, setBusy] = useState(false);
  const version = useRef(0);
  const form = useRef(null);
  const content = useRef(null);
  const readingPosition = useRef(0);
  const objectiveInput = useRef(null);
  const editButton = useRef(null);
  const moveFocus = useRef(editOnOpen);
  const showEditor = editing || !goal;
  const toggleStatus = goal?.status === 'active' ? 'pause' : goal?.status === 'paused' ? 'resume' : null;
  const objective = draft?.objective ?? goal?.objective ?? '';
  const budget = draft?.budget ?? goal?.budget ?? '';
  const trimmed = useMemo(() => showEditor ? objective.trim() : '', [showEditor, objective]);

  useLayoutEffect(() => {
    if (!showEditor) content.current.scrollTop = readingPosition.current;
  }, [showEditor]);
  useLayoutEffect(() => {
    if (!moveFocus.current) return;
    moveFocus.current = false;
    (showEditor ? objectiveInput : editButton).current?.focus({ preventScroll: true });
  });

  function edit(field, value) {
    version.current++;
    setDraft(current => ({ objective, budget, ...current, [field]: value }));
  }

  function changeEditor(open, focus = true) {
    if (open && !showEditor) readingPosition.current = content.current.scrollTop;
    moveFocus.current = focus;
    setEditing(open);
  }

  async function update(value) {
    if (busy) return;
    const submitted = version.current;
    const wasFocused = form.current?.contains(form.current.ownerDocument.activeElement);
    setBusy(true);
    try {
      const updated = await action(value);
      const saved = (value.kind === 'set' || value.kind === 'edit') && updated;
      const cleared = value.kind === 'clear' && updated === null;
      if (submitted === version.current && (saved || cleared)) {
        setDraft(null);
        readingPosition.current = 0;
        const panel = form.current;
        const focused = panel?.ownerDocument.activeElement;
        const restore = panel && (panel.contains(focused) || (cleared && wasFocused && focused === panel.ownerDocument.body));
        changeEditor(Boolean(cleared), Boolean(restore));
      }
    } catch (error) {
      report(error);
    } finally {
      setBusy(false);
    }
  }
  return <form ref={form} className="goal-panel-main" onSubmit={event => {
    event.preventDefault();
    if (!trimmed) return;
    const tokenBudget = budget === '' ? null : Number(budget);
    update(goal
      ? { kind: 'edit', objective: trimmed, budget: tokenBudget }
      : { kind: 'set', objective: trimmed, budget: tokenBudget ?? undefined });
  }}>
    {showEditor ? <div className="goal-editor">
      <textarea ref={objectiveInput} aria-label="目标" rows={6} value={objective} required
        onChange={event => edit('objective', event.target.value)} />
    </div> : <div className="agent-panel-content" ref={content}>
      <p className="goal-objective" tabIndex={0}>{goal.objective}</p>
    </div>}
    <div className="panel-actions goal-actions">
      {showEditor ? <>
        <label className="goal-budget"><span>Token 预算</span>
          <input type="number" min={1} step={1} value={budget} placeholder="可选"
            onChange={event => edit('budget', event.target.value)} />
        </label>
        {goal && <button type="button" aria-disabled={busy} onClick={() => {
          if (busy) return;
          setDraft(null);
          changeEditor(false);
        }}>取消</button>}
        {/* The edit button must keep its original type when its click opens the editor. */}
        <button key="save-goal" type="submit" className="primary" disabled={!trimmed} aria-disabled={busy}>保存目标</button>
      </> : <>
        <button type="button" className="goal-clear" aria-disabled={busy}
          onClick={() => update({ kind: 'clear' })}>清除</button>
        {toggleStatus && <button type="button" aria-disabled={busy}
          onClick={() => update({ kind: toggleStatus })}>{toggleStatus === 'pause' ? '暂停' : '继续'}</button>}
        <button type="button" ref={editButton} aria-disabled={busy} onClick={() => { if (!busy) changeEditor(true); }}>编辑</button>
      </>}
    </div>
  </form>;
}

function UsageMeter({ label, amount, value, max, children }) {
  const showMeter = value !== undefined && max !== undefined;
  return <div className="quota" data-near-limit={showMeter && value >= max * 0.9}>
    <div className="quota-heading"><span>{label}</span><span className="usage-value">{amount}</span></div>
    {showMeter && <progress aria-label={label} value={value} max={max} />}
    {children}
  </div>;
}

function quotaWindow(minutes) {
  if (!Number.isFinite(minutes) || minutes <= 0) return '';
  if (minutes % 1440 === 0) return ` · ${minutes / 1440} 天`;
  if (minutes % 60 === 0) return ` · ${minutes / 60} 小时`;
  return ` · ${minutes} 分钟`;
}

function UsagePanel({ usage, refreshing, refresh, report }) {
  const { tokens, limits, cost } = usage;
  const contextUsed = Number.isFinite(tokens?.contextUsed) && tokens.contextUsed >= 0 ? tokens.contextUsed : undefined;
  const contextLimit = Number.isFinite(tokens?.contextLimit) && tokens.contextLimit > 0 ? tokens.contextLimit : undefined;
  const hasContext = contextUsed !== undefined || contextLimit !== undefined;
  const contextAmount = !hasContext ? '' : contextUsed === undefined ? `上限 ${number.format(contextLimit)}`
    : contextLimit === undefined ? `已用 ${number.format(contextUsed)}` : `${number.format(contextUsed)} / ${number.format(contextLimit)}`;
  const stats = [
    ['总计', tokens?.total], ['输入', tokens?.input], ['输出', tokens?.output],
    ['缓存输入', tokens?.cached], ['推理输出', tokens?.reasoning],
  ].filter(([, value]) => Number.isFinite(value)).map(([label, value]) => [label, number.format(value)]);
  if (Number.isFinite(cost?.amount) && cost.currency) {
    const amount = cost.amount > 0 && cost.amount < 0.000001 ? '<0.000001'
      : cost.amount.toLocaleString('zh-CN', { maximumFractionDigits: 6 });
    stats.push(['费用', `${amount} ${cost.currency}`]);
  }
  return <div className="usage-panel">
    {(hasContext || stats.length > 0) && <section className="usage-group" aria-label="会话用量">
      <h3>会话用量</h3>
      {hasContext && <UsageMeter label="上下文" amount={contextAmount} value={contextUsed} max={contextLimit} />}
      {stats.length > 0 && <dl>{stats.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>}
    </section>}
    {limits?.length > 0 && <section className="usage-group" aria-label="账号额度">
      <h3>账号额度</h3>
      {limits.map(limit => {
        const reset = Number.isFinite(limit.resetsAt) ? new Date(limit.resetsAt * 1000) : null;
        return <UsageMeter key={limit.id} label={limit.label + quotaWindow(limit.windowMinutes)}
          amount={`已用 ${number.format(limit.used)}%`} value={limit.used} max={100}>
          {reset && Number.isFinite(reset.valueOf()) && <time dateTime={reset.toISOString()} title={reset.toLocaleString('zh-CN')}>
            {reset.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })} 重置
          </time>}
        </UsageMeter>;
      })}
    </section>}
    {!hasContext && !stats.length && !limits?.length && <p role="status">
      {refreshing ? '正在读取用量…' : '当前没有可显示的用量。'}
    </p>}
    <button type="button" className="panel-link usage-refresh" aria-disabled={refreshing}
      onClick={() => { if (!refreshing) refresh().catch(report); }}>{refreshing ? '刷新中…' : '刷新用量'}</button>
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
    for (const team of teams) {
      for (const member of team.members) mergeAgentMember(members, { ...member, teamId: team.id });
    }
    for (const member of liveMembers) mergeAgentMember(members, member);
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
      {tasks?.length > 0 && <div className="agent-task-group">
        <h4>任务</h4>
        <AgentTaskList tasks={tasks} members={members} />
      </div>}
    </section>)}
    <DelegationControls key={activeKey} work={work} members={entries} report={report} />
  </div>;
}

export function AgentPanel({ panel, work, reasoning, setPanel, report, openSession }) {
  const close = useRef(null);
  const content = useRef(null);
  useLayoutEffect(() => {
    if (panel?.focus && !panel.editGoal) close.current?.focus({ preventScroll: true });
  }, [panel]);
  if (!panel) return null;
  const title = panel.title ?? titles[panel.kind];
  const reasoningPanel = panel.kind === 'reasoning';
  const id = panel.kind === 'goal' || reasoningPanel ? `${panel.kind}-panel` : undefined;
  const goal = panel.kind === 'goal' ? work.goal : undefined;
  const usage = goal?.tokens == null ? '' : [goal.tokens, goal.budget].filter(value => value != null)
    .map(value => number.format(value)).join(' / ') + ' tokens';
  return <section className="agent-panel popup-surface" id={id} data-kind={panel.kind}
    aria-label={title} onKeyDown={event => {
      if (event.key === 'Escape' && panel.focus) setPanel(null);
    }}>
    <header><strong>{title}</strong>
      {usage && <small className="goal-usage" title={usage}>{usage}</small>}
      <button ref={close} className="icon-button" type="button" aria-label="关闭面板" onClick={() => setPanel(null)}><X size={15} /></button>
    </header>
    {panel.kind === 'goal' ? <GoalPanel key={panel.id} goal={goal}
      action={work.goalAction} report={report} editOnOpen={panel.editGoal} /> : <div className="agent-panel-content" ref={content}
      tabIndex={reasoningPanel ? 0 : undefined} role={reasoningPanel ? 'group' : undefined}
      aria-label={reasoningPanel ? '推理摘要正文' : undefined}>
      {panel.kind === 'settings' && <RuntimeSettings api={work.api} models={work.models} options={work.options} setOptions={work.setOptions} />}
      {reasoningPanel && <ReasoningText rows={reasoning} scroll={content} />}
      {panel.kind === 'usage' && <UsagePanel usage={work.usage} refreshing={work.usageRefreshing}
        refresh={work.refreshUsage} report={report} />}
      {panel.kind === 'agents' && <AgentsPanel work={work} openSession={openSession} report={report} />}
      {panel.kind === 'output' && <pre className="panel-output">{panel.text}</pre>}
      {panel.kind === 'extensions' && (panel.items?.length
        ? <ul className="extensions">{panel.items.map(item => <li key={item.id}>
          <strong>{item.label}</strong><small>{item.status ?? (item.enabled == null ? item.source : item.enabled ? '已启用' : '已停用')}</small>
          {item.description && <p>{item.description}</p>}
        </li>)}</ul> : <p>没有可显示的{extensionLabels[panel.extension]}。</p>)}
    </div>}
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
