import { useCallback, useEffect, useEffectEvent, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, BookOpen, ChartNoAxesColumnIncreasing, ChevronDown, Ellipsis, Goal, SlidersHorizontal, Users, X } from 'lucide-react';
import { AgentMemberList, AgentStatus, memberName } from './agent-members.jsx';
import { sessionKey } from './agent.js';
import { mergeAgentMember } from './delegation.js';
import { PathText } from './file-reference-name.jsx';
import { PatchView } from './patch-view.jsx';
import { ReasoningText } from './reasoning.jsx';
import { TextReader } from './text-reader.jsx';
import { delegatedMembers } from './timeline.js';
import { Transcript } from './transcript.jsx';

const statuses = {
  active: '进行中', paused: '已暂停', complete: '已完成', blocked: '受阻', waiting: '等待中', limited: '达到用量上限', unknown: '状态未知',
};
const number = new Intl.NumberFormat('zh-CN');
const titles = { settings: '运行设置', goal: '会话目标', reasoning: '推理摘要', usage: '用量', agents: '代理与团队', output: '会话信息', diff: '工作区 Git 改动' };
const extensionLabels = { mcp: 'MCP 服务器', skill: '技能', plugin: '插件', connector: '连接器', tool: '工具' };
const supportsGoalAction = (capability, action) => !capability?.actions || capability.actions.includes(action);

export function commonAgentCommands(api, models, options) {
  if (!api) return [];
  const model = models.find(item => item.id === options.model) ?? models.find(item => item.isDefault);
  const extensionKinds = api.extensions?.kinds ?? [];
  const nativeSkills = api.commands?.some(command => command.id === 'skills');
  return [
    ['/new', '新建会话'], ['/resume', '打开会话或恢复指定 ID'], ['/status', '查看会话状态'],
    ['/pwd', '查看工作目录'], ['/copy', '复制 Markdown'], ['/copy rich', '复制富文本'],
    ...(api.goal ? [
      ['/goal', '查看或设置会话目标'], ['/goal status', '查看当前目标'],
      ...[['edit', '编辑当前目标'], ['pause', '暂停目标'], ['resume', '继续目标'], ['clear', '清除目标']]
        .filter(([action]) => supportsGoalAction(api.goal, action)).map(([action, text]) => ['/goal ' + action, text]),
    ] : []),
    ...(api.usage ? [['/usage', '查看 Agent 用量']] : []),
    ...(api.delegation ? [['/agents', '查看子代理与团队']] : []),
    ...(models.length ? [['/model', '选择下一轮的模型']] : []),
    ...(model?.efforts.length ? [['/reasoning', '选择思考强度']] : []),
    ...(model?.tiers.length ? [['/fast', '切换速度档位']] : []),
    ...(api.modes?.some(mode => mode.id === 'plan') ? [['/plan', '切换规划模式，可附带任务']] : []),
    ...(api.permissions?.length ? [['/permissions', '选择会话权限']] : []),
    ...(api.turns.compact ? [['/compact', '压缩上下文']] : []),
    ...(api.turns.review ? [['/review', '审查代码变更']] : []),
    ...(api.repository ? [['/diff', '查看工作区 Git 改动'], ['/diff turn', '查看最近一次会话补丁']] : []),
    ...(api.sessions.fork ? [['/fork', '复制当前会话']] : []),
    ...(api.sessions.rename ? [['/rename', '重命名当前会话']] : []),
    ...(api.sessions.archive ? [['/archive', '归档或恢复当前会话']] : []),
    ...extensionKinds.filter(kind => kind !== 'skill' || !nativeSkills).map(kind => [
      { mcp: '/mcp', skill: '/skills', plugin: '/plugins', connector: '/apps', tool: '/tools' }[kind],
      `查看${extensionLabels[kind]}`,
    ]),
    ...(api.extensions?.kinds.includes('mcp') ? [['/mcp verbose', '展开 MCP 工具名称']] : []),
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
    {api?.modes?.length > 0 && <Selector label="模式" choices={api.modes} value={options.mode}
      blank="跟随会话" onChange={value => select('mode', value)} />}
    {api?.permissions?.length > 0 && <Selector label="权限" choices={api.permissions} value={options.permissions}
      blank="跟随会话" onChange={value => select('permissions', value)} />}
  </div>;
}

function GoalPanel({ goal, capability, action, report, editOnOpen }) {
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
  const toggleStatus = ['active', 'waiting'].includes(goal?.status) ? 'pause'
    : goal?.status === 'paused' || (capability?.canRestart && ['complete', 'blocked'].includes(goal?.status)) ? 'resume' : null;
  const supports = kind => supportsGoalAction(capability, kind);
  const saveLabel = capability?.startsOnSave ? goal ? '替换并启动' : '启动目标' : '保存目标';
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
        maxLength={capability?.objectiveLimit}
        onChange={event => edit('objective', event.target.value)} />
    </div> : <div className="agent-panel-content" ref={content}>
      <p className="goal-objective" tabIndex={0}>{goal.objective}</p>
      {goal.reason && <p className="goal-reason">{goal.reason}</p>}
    </div>}
    <div className="panel-actions goal-actions">
      {showEditor ? <>
        {capability?.budget !== false && <label className="goal-budget"><span>Token 预算</span>
          <input type="number" min={1} step={1} value={budget} placeholder="可选"
            onChange={event => edit('budget', event.target.value)} />
        </label>}
        {goal && <button type="button" aria-disabled={busy} onClick={() => {
          if (busy) return;
          setDraft(null);
          changeEditor(false);
        }}>取消</button>}
        {/* The edit button must keep its original type when its click opens the editor. */}
        <button key="save-goal" type="submit" className="primary" disabled={!trimmed} aria-disabled={busy}>{saveLabel}</button>
      </> : <>
        {supports('clear') && <button type="button" className="goal-clear" aria-disabled={busy}
          onClick={() => update({ kind: 'clear' })}>清除</button>}
        {toggleStatus && supports(toggleStatus) && <button type="button" aria-disabled={busy}
          onClick={() => update({ kind: toggleStatus })}>{toggleStatus === 'pause' ? '暂停' : goal.status === 'complete' ? '重新开始' : '继续'}</button>}
        {supports('edit') && <button type="button" ref={editButton} aria-disabled={busy}
          onClick={() => { if (!busy) changeEditor(true); }}>编辑</button>}
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

function tokenStats(tokens) {
  return [
    ['总计', tokens?.total], ['输入', tokens?.input], ['输出', tokens?.output],
    ['缓存输入', tokens?.cached], ['缓存写入', tokens?.cacheWrite], ['推理输出', tokens?.reasoning],
  ].filter(([, value]) => Number.isFinite(value)).map(([label, value]) => [label, number.format(value)]);
}

function UsageStats({ stats }) {
  return stats.length > 0 && <dl>{stats.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>;
}

function UsagePanel({ usage, refreshing }) {
  const { tokens, recentTokens, limits, cost } = usage;
  const contextUsed = Number.isFinite(tokens?.contextUsed) && tokens.contextUsed >= 0 ? tokens.contextUsed : undefined;
  const contextLimit = Number.isFinite(tokens?.contextLimit) && tokens.contextLimit > 0 ? tokens.contextLimit : undefined;
  const hasContext = contextUsed !== undefined || contextLimit !== undefined;
  const contextAmount = !hasContext ? '' : contextUsed === undefined ? `上限 ${number.format(contextLimit)}`
    : contextLimit === undefined ? `已用 ${number.format(contextUsed)}` : `${number.format(contextUsed)} / ${number.format(contextLimit)}`;
  const stats = tokenStats(tokens);
  const recent = tokenStats(recentTokens);
  if (Number.isFinite(cost?.amount) && cost.currency) {
    const amount = cost.amount > 0 && cost.amount < 0.000001 ? '<0.000001'
      : cost.amount.toLocaleString('zh-CN', { maximumFractionDigits: 6 });
    stats.push(['费用', `${amount} ${cost.currency}`]);
  }
  return <div className="usage-panel">
    {(hasContext || stats.length > 0) && <section className="usage-group" aria-label="会话用量">
      <h3>会话用量</h3>
      {hasContext && <UsageMeter label="上下文" amount={contextAmount} value={contextUsed} max={contextLimit} />}
      <UsageStats stats={stats} />
    </section>}
    {recent.length > 0 && <section className="usage-group" aria-label="最近一次用量">
      <h3>最近一次用量</h3>
      <UsageStats stats={recent} />
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
    {!hasContext && !stats.length && !recent.length && !limits?.length && <p role="status">
      {refreshing ? '正在读取用量…' : '当前没有可显示的用量。'}
    </p>}
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
    const dependencies = (task.dependsOn ?? task.blockedBy)?.map(id => titles.get(id) || id).join('、');
    const metadata = [task.assigneeId && `负责人 ${assignee ? memberName(assignee) : task.assigneeId}`,
      dependencies && `依赖 ${dependencies}`].filter(Boolean).join(' · ');
    return <li key={task.id} className="agent-member-row">
      <span className="agent-member-label">{task.title}</span>
      <AgentStatus status={task.status} />
      {metadata && <small className="agent-member-meta">{metadata}</small>}
      {task.detail && <p className="agent-member-detail">{task.detail}</p>}
    </li>;
  })}</ul>;
}

const teamStatuses = { active: '运行中', closed: '已关闭', orphaned: '主会话已断开' };

function AgentsPanel({ work, openSession, openTrace, report }) {
  const { teams, members: liveMembers } = work;
  const teamSession = work.session?.ref;
  const activeKey = sessionKey(teamSession);
  const delegation = work.api?.delegation;
  const cadence = delegation?.teamRefreshMs;
  const ready = Boolean(activeKey && work.connection === 'ready' && !work.loading);
  const running = Boolean(cadence && work.run);
  const observing = running || teams.some(team => team.status === 'active');
  const refresh = useEffectEvent(async reportError => {
    try { await work.refreshDelegation(); }
    catch (error) { if (reportError) report(error); }
  });
  useEffect(() => {
    if (ready && !document.hidden) refresh(true);
  }, [activeKey, ready, running]);
  useEffect(() => {
    if (!ready || !cadence) return;
    const release = () => delegation.releaseTeamView?.(teamSession);
    function changedVisibility() {
      if (document.hidden) release();
      else refresh(false);
    }
    document.addEventListener('visibilitychange', changedVisibility);
    return () => {
      document.removeEventListener('visibilitychange', changedVisibility);
      release();
    };
  }, [ready, cadence, delegation, teamSession]);
  useEffect(() => {
    if (!ready || !cadence || !observing) return;
    let disposed = false;
    let inFlight = false;
    let timer;
    function schedule() {
      clearTimeout(timer);
      if (disposed || document.hidden || inFlight) return;
      timer = setTimeout(async () => {
        inFlight = true;
        await refresh(false);
        inFlight = false;
        schedule();
      }, cadence);
    }
    schedule();
    document.addEventListener('visibilitychange', schedule);
    return () => {
      disposed = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', schedule);
    };
  }, [activeKey, ready, cadence, observing]);
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
  const parentName = useCallback(ref => {
    if (!ref) return;
    const key = sessionKey(ref);
    if (key !== activeKey) return parents.get(key) ?? ref.id;
  }, [activeKey, parents]);
  const canOpenSession = work.connection === 'ready' && !work.loading && !work.run;
  const sections = groups.get(null).length ? [...teams, { id: null, name: '子代理' }] : teams;
  return <div className="agent-groups">
    {!members.size && !teams.length && <p>当前会话还没有代理活动。</p>}
    {sections.map(({ id, name, description, status, tasks }) => <section key={id ?? 'subagents'} className="agent-group">
      <div className="agent-group-heading">
        <h3>{name}</h3>
        {teamStatuses[status] && <small>{teamStatuses[status]}</small>}
      </div>
      {description && <p className="agent-group-description">{description}</p>}
      {groups.get(id).length > 0 && <AgentMemberList members={groups.get(id)} parentName={parentName}
        currentKey={activeKey} openSession={openSession} canOpenSession={canOpenSession} openTrace={openTrace} />}
      {tasks?.length > 0 && <div className="agent-task-group">
        <h4>任务</h4>
        <AgentTaskList tasks={tasks} members={members} />
      </div>}
    </section>)}
    <DelegationControls key={activeKey} work={work} members={entries} report={report} />
  </div>;
}

function SubagentTranscript({ panel, delegation, openTrace, openArtifact, openImage }) {
  const [view, setView] = useState();
  const [error, setError] = useState('');
  const [readingHistory, setReadingHistory] = useState(false);
  const scroll = useRef(null);
  const jumpToLatest = useRef(true);
  const { member, session } = panel;
  useEffect(() => {
    try { return delegation.watchTranscript(session, member.id, setView); }
    catch (error) { setError(error.message); }
  }, [delegation, member.id, session]);
  if (error || !view?.rows.length) return <p className="subagent-empty" role="status">
    {error || view?.error || (!view || view.loading ? '正在读取子代理记录…' : '子代理还没有可显示的记录。')}
  </p>;
  return <>
    {view.error && <p className="subagent-empty" role="status">{view.error}</p>}
    <Transcript rows={view.rows} viewKey={sessionKey(member.session)} scroll={scroll} jumpToLatest={jumpToLatest}
      label="子代理会话记录" testId="subagent-transcript" activeTurnId={view.run?.status === 'running' ? view.run.id : undefined}
      cursor={view.cursor} loadOlder={view.loadOlder} loading={view.loading}
      showLatest={readingHistory} onScrollPosition={setReadingHistory} openTrace={openTrace}
      openArtifact={openArtifact} openImage={openImage} />
  </>;
}

function DiffPanel({ panel }) {
  const files = useRef(null);
  if (panel.change) return <PatchView files={panel.change.files ?? []} text={panel.change.text} />;
  const result = panel.result;
  const untracked = result?.untracked.map(path => /[\r\n]/.test(path) ? JSON.stringify(path) : path).join('\n');
  return <div className="workspace-diff">
    {!result?.patch && <PathText className="card-path" path={panel.directory} />}
    {panel.loading && <p role="status">正在读取 Git 改动…</p>}
    {panel.error && <p className="diff-error" role="status">{panel.error}</p>}
    {result?.mayBeTruncated && <p role="status">部分输出可能超过 256 KiB 显示上限。</p>}
    {result?.patch && <PatchView files={[]} text={result.patch} label="工作区差异" directory={panel.directory} />}
    {untracked && <section aria-label="未跟踪文件">
      <h3>未跟踪文件</h3>
      <TextReader kind="output" label="未跟踪文件路径" pagesLabel="路径分页" text={untracked} scroll={files} />
    </section>}
    {result && !result.patch && !untracked && !result.mayBeTruncated && <p>工作区没有 Git 改动。</p>}
  </div>;
}

export function AgentPanel({ panel, work, reasoning, reasoningArchived, onClose, report, openSession, openTrace, openArtifact, openImage }) {
  const close = useRef(null);
  const content = useRef(null);
  const extensionSearch = useRef(null);
  const { id: panelId, focus, editGoal, rosterPosition } = panel ?? {};
  useLayoutEffect(() => {
    if (!focus || editGoal) return;
    let trigger;
    const viewport = content.current;
    if (rosterPosition && viewport) {
      trigger = [...viewport.querySelectorAll('button[data-trace-member]')]
        .find(button => button.dataset.traceMember === rosterPosition.memberId);
      viewport.scrollTop = trigger ? viewport.scrollTop + trigger.getBoundingClientRect().top -
        viewport.getBoundingClientRect().top - rosterPosition.offset : rosterPosition.scrollTop;
    }
    (trigger ?? extensionSearch.current ?? close.current)?.focus({ preventScroll: true });
  }, [panelId, focus, editGoal, rosterPosition]);
  if (!panel) return null;
  const title = panel.title ?? titles[panel.kind];
  const reasoningPanel = panel.kind === 'reasoning';
  const usagePanel = panel.kind === 'usage';
  const agentsPanel = panel.kind === 'agents';
  const detailsLabel = reasoningPanel ? '推理摘要正文' : usagePanel ? '用量明细' : agentsPanel ? '代理与团队明细'
    : panel.kind === 'diff' ? '差异明细'
      : panel.kind === 'output' || panel.kind === 'extensions' ? `${title}正文` : undefined;
  const id = panel.kind === 'goal' || reasoningPanel ? `${panel.kind}-panel` : undefined;
  const goal = panel.kind === 'goal' ? work.goal : undefined;
  const usage = goal?.tokens == null ? '' : [goal.tokens, goal.budget].filter(value => value != null)
    .map(value => number.format(value)).join(' / ') + ' tokens';
  return <section className="agent-panel popup-surface" id={id} data-kind={panel.kind} data-archived={reasoningArchived || undefined}
    aria-label={title} onKeyDown={event => {
      if (event.key !== 'Escape' || event.nativeEvent.isComposing) return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    }}>
    <header>
      {panel.returnTo && <button ref={close} className="icon-button agent-panel-back" type="button" aria-label="返回代理与团队" onClick={() => onClose()}>
        <ArrowLeft size={15} />
      </button>}
      <strong>{title}</strong>
      {usage && <small className="panel-meta" title={usage}>{usage}</small>}
      {reasoningArchived && <small className="panel-meta">已归档</small>}
      {usagePanel && <button type="button" className="panel-link usage-refresh" aria-disabled={work.usageRefreshing}
        onClick={() => { if (!work.usageRefreshing) work.refreshUsage().catch(report); }}>
        {work.usageRefreshing ? '刷新中…' : '刷新用量'}
      </button>}
      {!panel.returnTo && <button ref={close} className="icon-button" type="button" aria-label="关闭面板" onClick={() => onClose()}>
        <X size={15} />
      </button>}
    </header>
    {panel.kind === 'goal' ? <GoalPanel key={panel.id} goal={goal} capability={work.api?.goal}
      action={work.goalAction} report={report} editOnOpen={panel.editGoal} /> : <div className="agent-panel-content" ref={content}
      tabIndex={detailsLabel ? 0 : undefined} role={detailsLabel ? 'group' : undefined} aria-label={detailsLabel}>
      {panel.kind === 'settings' && <RuntimeSettings api={work.api} models={work.models} options={work.options} setOptions={work.setOptions} />}
      {reasoningPanel && <ReasoningText rows={reasoning} scroll={content} />}
      {usagePanel && <UsagePanel usage={work.usage} refreshing={work.usageRefreshing} />}
      {agentsPanel && <AgentsPanel work={work} openSession={openSession} openTrace={openTrace} report={report} />}
      {panel.kind === 'subagent' && <SubagentTranscript key={panel.id} panel={panel} delegation={work.api?.delegation}
        openTrace={openTrace} openArtifact={openArtifact} openImage={openImage} />}
      {panel.kind === 'diff' && <DiffPanel key={panel.id} panel={panel} />}
      {panel.kind === 'output' && <pre className="panel-output">{panel.text}</pre>}
      {panel.kind === 'extensions' && <ExtensionList key={panel.id} panel={panel} search={extensionSearch} />}
    </div>}
  </section>;
}

const mcpAuthentication = {
  unknown: '登录状态未知', unsupported: '不支持登录', required: '未登录', token: 'Token 鉴权', oauth: 'OAuth 鉴权',
};
const mcpConnections = {
  idle: '尚未启动', connecting: '连接中', ready: '已连接', 'auth-required': '需要登录',
  failed: '连接失败', cancelled: '已取消', disabled: '已停用',
};
const mcpToolPageSize = 40;
const skillPageSize = 30;
const skillScopes = { workspace: '工作区', user: '用户', system: '系统', managed: '管理员', temporary: '当前进程' };

function McpServerRow({ item, verbose }) {
  const [expanded, setExpanded] = useState(verbose);
  const [toolLimit, setToolLimit] = useState(mcpToolPageSize);
  const authentication = mcpAuthentication[item.authentication];
  const connection = mcpConnections[item.connection];
  const showAuthentication = connection && authentication && !(item.connection === 'auth-required' && item.authentication === 'required');
  const catalog = item.toolError ? '工具读取失败' : item.tools ? `${number.format(item.tools.length)} 个工具` : '工具列表不可用';
  const hasDetails = Boolean(item.tools?.length || item.toolError || showAuthentication);
  const summary = <>
    <strong>{item.label}</strong><small>{[connection ?? authentication, catalog].filter(Boolean).join(' · ')}</small>
  </>;
  return <li className="extension-server">
    {hasDetails ? <details open={expanded} onToggle={event => setExpanded(event.currentTarget.open)}>
      <summary className="extension-heading"><ChevronDown size={13} aria-hidden="true" />{summary}</summary>
      {expanded && <div className="extension-details">
        {showAuthentication && <small>{authentication}</small>}
        {item.toolError && <p className="extension-error">{item.toolError}</p>}
        {item.tools?.length > 0 && <ul className="extension-tools" aria-label={`${item.label} 的工具`}>
          {item.tools.slice(0, toolLimit).map(name => <li key={name}><code>{name}</code></li>)}
        </ul>}
        {item.tools?.length > toolLimit && <button type="button" className="panel-link" onClick={event => {
          if (toolLimit + mcpToolPageSize >= item.tools.length) {
            event.currentTarget.closest('details')?.querySelector('summary')?.focus({ preventScroll: true });
          }
          setToolLimit(limit => limit + mcpToolPageSize);
        }}>显示更多工具</button>}
      </div>}
    </details> : <div className="extension-heading">{summary}</div>}
  </li>;
}

function ExtensionList({ panel, search }) {
  const [listing, setListing] = useState({ items: [], cursor: null, loading: true, error: '' });
  const [query, setQuery] = useState(panel.query ?? '');
  const [skillLimit, setSkillLimit] = useState(skillPageSize);
  const pending = useRef(null);
  const loadPage = useCallback(async (cursor = null) => {
    if (pending.current) return;
    const request = {};
    pending.current = request;
    setListing(previous => ({ ...previous, loading: true }));
    try {
      const page = await panel.load(cursor ?? undefined);
      if (pending.current !== request || !page) return;
      setListing(previous => ({
        items: cursor === null ? page.items : [...new Map([...previous.items, ...page.items].map(item => [item.id, item])).values()],
        cursor: cursor === page.cursor ? null : page.cursor, loading: false, error: '',
      }));
    } catch (error) {
      if (pending.current === request) setListing(previous => ({ ...previous, loading: false, error: error.message }));
    } finally {
      if (pending.current === request) pending.current = null;
    }
  }, [panel.load]);
  useEffect(() => {
    loadPage();
    return () => { pending.current = null; };
  }, [loadPage]);
  const pageButton = useCallback(button => {
    if (!button) return;
    return () => {
      if (button === document.activeElement) button.closest('.agent-panel-content')?.focus({ preventScroll: true });
    };
  }, []);
  const skills = panel.extension === 'skill';
  const term = query.trim().toLocaleLowerCase();
  const matches = skills && term ? listing.items.filter(item => item.kind === 'skill' &&
    [item.label, item.name, item.description].some(text => text?.toLocaleLowerCase().includes(term))) : listing.items;
  const visible = skills ? matches.slice(0, skillLimit) : matches;
  const moreSkills = skills && matches.length > skillLimit;
  return <>
    {skills && (listing.items.length > 8 || panel.query) && <input ref={search} type="search" className="skill-search" aria-label="搜索技能"
      placeholder="搜索技能" value={query} onChange={event => { setQuery(event.target.value); setSkillLimit(skillPageSize); }} />}
    {visible.length > 0 && <ul className="extensions">{visible.map(item => item.kind === 'mcp'
      ? <McpServerRow key={item.id} item={item} verbose={panel.verbose} /> : item.kind === 'skill'
        ? <li key={item.id} className="extension-skill">
          <div className="extension-heading"><strong title={item.path}>{item.label}</strong>
            <small>{[skillScopes[item.scope], item.enabled === false ? '已停用' : undefined].filter(Boolean).join(' · ')}</small>
          </div>
          {item.description && <p>{item.description}</p>}
        </li> : <li key={item.id}>
        <strong>{item.label}</strong><small>{item.status ?? (item.enabled == null ? item.source : item.enabled ? '已启用' : '已停用')}</small>
        {item.description && <p>{item.description}</p>}
      </li>)}</ul>}
    {listing.loading && <p className="extension-note" role="status">正在读取…</p>}
    {listing.error && !listing.loading && <p className="extension-note extension-error" role="alert">{listing.error}</p>}
    {!listing.items.length && !listing.loading && !listing.error && <p className="extension-note">没有可显示的{extensionLabels[panel.extension]}。</p>}
    {term && listing.items.length > 0 && !visible.length && <p role="status" className="extension-note">没有匹配的技能。</p>}
    {(moreSkills || listing.cursor !== null || listing.error) && <button ref={pageButton} type="button" className="panel-link extension-more"
      aria-disabled={listing.loading || undefined}
      onClick={() => moreSkills && !listing.error ? setSkillLimit(limit => limit + skillPageSize) : loadPage(listing.cursor)}>
      {listing.error ? '重试' : '加载更多'}
    </button>}
  </>;
}

export function AgentMenu({ work, onSelect }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef(null);
  useEffect(() => {
    if (!open) return;
    const dismiss = event => {
      if (!trigger.current?.parentElement.contains(event.target)) setOpen(false);
    };
    window.addEventListener('pointerdown', dismiss);
    return () => window.removeEventListener('pointerdown', dismiss);
  }, [open]);
  const { api, goal, models, options } = work;
  const entries = [
    ...(models.length || api?.modes?.length || api?.permissions?.length ? [['settings', SlidersHorizontal]] : []),
    ...(api?.goal && !goal ? [['goal', Goal]] : []),
    ...(api?.usage ? [['usage', ChartNoAxesColumnIncreasing]] : []),
    ...(api?.delegation ? [['agents', Users]] : []),
    ...(api?.extensions?.kinds.includes('skill') ? [['skill', BookOpen]] : []),
  ];
  if (!entries.length) return null;
  const selectedModel = models.find(model => model.id === options.model);
  const label = [selectedModel?.label, api?.modes?.find(mode => mode.id === options.mode && mode.id !== 'default')?.label].filter(Boolean).join(' · ');
  return <div className="agent-menu"
    onBlur={event => {
      if (open && !event.currentTarget.contains(event.relatedTarget)) setOpen(false);
    }}
    onKeyDown={event => {
      if (!open || event.key !== 'Escape' || event.nativeEvent.isComposing) return;
      event.preventDefault();
      event.stopPropagation();
      trigger.current?.focus({ preventScroll: true });
      setOpen(false);
    }}>
    <button ref={trigger} className="composer-control" type="button" aria-label="Agent 控件" aria-expanded={open}
      onClick={() => setOpen(value => !value)}>
      {label ? <><span>{label}</span><ChevronDown className="agent-menu-chevron" size={12} /></> : <Ellipsis size={17} />}
    </button>
    {open && <div className="agent-menu-entries popup-surface" aria-label="Agent 控件">
      {entries.map(([kind, Icon]) => <button key={kind} type="button" onClick={() => {
        setOpen(false);
        onSelect(kind, trigger.current);
      }}><Icon size={15} />{kind === 'skill' ? extensionLabels.skill : titles[kind]}</button>)}
    </div>}
  </div>;
}

export function GoalStrip({ goal, capability, expanded, toggle }) {
  if (!goal) return null;
  const status = goal.status === 'active' && capability?.activeWithoutTurn ? '已启用' : statuses[goal.status];
  return <button type="button" className="goal-strip" title={goal.objective} aria-expanded={expanded}
    aria-controls={expanded ? 'goal-panel' : undefined} data-status={goal.status} onClick={toggle}>
    <Goal size={16} className="goal-icon" /><span>{goal.objective}</span><small>{status}</small>
    <ChevronDown size={13} className="goal-chevron" />
  </button>;
}
