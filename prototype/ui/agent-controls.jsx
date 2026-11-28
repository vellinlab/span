import { memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  Archive, ArrowLeft, BookOpen, Brain, ChartNoAxesColumnIncreasing, ChevronDown, CircleGauge, ClipboardCheck,
  GitFork, Goal, ListTree, MessageSquare, Pencil, Pin, Plug, SlidersHorizontal, Trash2, Users, X, Zap,
} from 'lucide-react';
import { ReasoningText } from './reasoning.jsx';
import { LatestMessageButton } from './transcript-navigation.jsx';

let inspectorView;
let inspectorRequest;

function InspectorLoadError() {
  return <p role="alert">无法加载面板。请重新打开 Span。</p>;
}

function AgentInspector(props) {
  const [View, setView] = useState(() => inspectorView);
  useEffect(() => {
    if (View) return;
    let open = true;
    inspectorRequest ??= import('./agent-inspector.jsx')
      .then(module => module.default, () => InspectorLoadError);
    inspectorRequest.then(component => {
      inspectorView = component;
      if (open) setView(() => component);
    });
    return () => { open = false; };
  }, [View]);
  return View ? <View {...props} /> : <p role="status">正在打开面板…</p>;
}

const statuses = {
  active: '进行中', paused: '已暂停', complete: '已完成', blocked: '受阻', waiting: '等待中', limited: '达到用量上限', unknown: '状态未知',
};
const goalStatusLabel = (status, activeWithoutTurn) => status === 'active' && activeWithoutTurn ? '已启用' : statuses[status];
const titles = { settings: '运行设置', goal: '会话目标', reasoning: '任务过程', usage: '用量', agents: '代理与团队', output: '会话信息', diff: '工作区 Git 改动' };
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
    ...(api.sessions.pin ? [['/pin', '置顶或取消置顶当前会话']] : []),
    ...(api.sessions.delete ? [['/delete', '确认并永久删除当前会话及其子会话']] : []),
    ...(api.sessions.feedback ? [['/feedback', '发送关于当前会话的反馈']] : []),
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

// Put the frequently used controls before catalog and extension commands.
const commandPresentation = {
  '/model': ['模型', SlidersHorizontal], '/reasoning': ['推理强度', Brain], '/fast': ['快速', Zap],
  '/plan': ['计划模式', ListTree], '/review': ['代码审查', ClipboardCheck], '/compact': ['压缩上下文', CircleGauge],
  '/goal': ['目标', Goal], '/status': ['状态', CircleGauge], '/usage': ['用量', ChartNoAxesColumnIncreasing],
  '/mcp': ['MCP', Plug], '/agents': ['子代理与团队', Users], '/fork': ['创建会话分支', GitFork],
  '/rename': ['重命名', Pencil], '/pin': ['置顶会话', Pin], '/archive': ['归档', Archive],
  '/delete': ['永久删除会话', Trash2], '/feedback': ['反馈', MessageSquare],
};
const commandOrder = new Map(Object.keys(commandPresentation).map((name, index) => [name, index]));

export function commandSuggestions(commands, draft, details) {
  const query = draft.toLocaleLowerCase();
  const hasArguments = draft.includes(' ');
  return commands.map(([name, description]) => {
    const [title, Icon] = commandPresentation[name] ?? [];
    const detail = details[name];
    return { name, title, Icon, description, detail: name === '/reasoning' ? effortNames[detail] ?? detail : detail };
  })
    .filter(({ name, title, description }) => {
      const command = name.toLocaleLowerCase();
      const argumentStart = command.indexOf(' ');
      if (argumentStart !== -1) return hasArguments ? command.startsWith(query) : command.slice(0, argumentStart) === query;
      if (hasArguments) return false;
      return command.startsWith(query) || (draft.length > 1 &&
        `${title ?? ''} ${description}`.toLocaleLowerCase().includes(query.slice(1)));
    }).sort((a, b) => (commandOrder.get(a.name) ?? commandOrder.size) - (commandOrder.get(b.name) ?? commandOrder.size));
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

const GoalPanel = memo(function GoalPanel({ hasGoal, savedObjective, savedBudget, status, reason, capability, action, report, editOnOpen }) {
  const [editing, setEditing] = useState(() => editOnOpen || !hasGoal);
  const [draft, setDraft] = useState(null);
  const [busy, setBusy] = useState(false);
  const version = useRef(0);
  const form = useRef(null);
  const content = useRef(null);
  const readingPosition = useRef(0);
  const objectiveInput = useRef(null);
  const editButton = useRef(null);
  const moveFocus = useRef(editOnOpen);
  const showEditor = editing || !hasGoal;
  const toggleStatus = ['active', 'waiting'].includes(status) ? 'pause'
    : status === 'paused' || (capability?.canRestart && ['complete', 'blocked'].includes(status)) ? 'resume' : null;
  const supports = kind => supportsGoalAction(capability, kind);
  const saveLabel = capability?.startsOnSave ? hasGoal ? '替换并启动' : '启动目标' : '保存目标';
  const objective = draft?.objective ?? savedObjective ?? '';
  const budget = draft?.budget ?? savedBudget ?? '';
  const trimmed = useMemo(() => showEditor ? objective.trim() : '', [showEditor, objective]);
  const rememberRemovedFocus = useCallback(element => {
    if (!element) return;
    return () => {
      if (element === element.ownerDocument.activeElement) moveFocus.current = true;
    };
  }, []);
  const attachEditButton = useCallback(button => {
    editButton.current = button;
    if (!button) return;
    const rememberFocus = rememberRemovedFocus(button);
    return () => {
      rememberFocus();
      editButton.current = null;
    };
  }, [rememberRemovedFocus]);

  useLayoutEffect(() => {
    if (!showEditor) content.current.scrollTop = readingPosition.current;
  }, [showEditor]);
  useLayoutEffect(() => {
    if (!moveFocus.current) return;
    moveFocus.current = false;
    const target = showEditor ? objectiveInput.current : editButton.current ?? content.current?.firstElementChild;
    target?.focus({ preventScroll: true });
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
    setBusy(true);
    try {
      const updated = await action(value);
      const saved = (value.kind === 'set' || value.kind === 'edit') && updated;
      const cleared = value.kind === 'clear' && updated === null;
      if (submitted === version.current && (saved || cleared)) {
        setDraft(null);
        readingPosition.current = 0;
        const panel = form.current;
        changeEditor(Boolean(cleared), Boolean(panel?.contains(panel.ownerDocument.activeElement)));
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
    update(hasGoal
      ? { kind: 'edit', objective: trimmed, budget: tokenBudget }
      : { kind: 'set', objective: trimmed, budget: tokenBudget ?? undefined });
  }}>
    {showEditor ? <div className="goal-editor">
      <textarea ref={objectiveInput} aria-label="目标" dir="auto" rows={6} value={objective} required
        maxLength={capability?.objectiveLimit}
        onChange={event => edit('objective', event.target.value)} />
    </div> : <div className="agent-panel-content" ref={content}>
      <p ref={rememberRemovedFocus} className="goal-objective" dir="auto" tabIndex={0}>{savedObjective}</p>
      {reason && <p className="goal-reason" dir="auto">{reason}</p>}
    </div>}
    <div className="panel-actions goal-actions">
      {showEditor ? <>
        {capability?.budget !== false && <label className="goal-budget"><span>Token 预算</span>
          <input type="number" min={1} step={1} value={budget} placeholder="可选"
            onChange={event => edit('budget', event.target.value)} />
        </label>}
        {hasGoal && <button ref={rememberRemovedFocus} type="button" aria-disabled={busy} onClick={() => {
          if (busy) return;
          setDraft(null);
          changeEditor(false);
        }}>取消</button>}
        {/* The edit button must keep its original type when its click opens the editor. */}
        <button key="save-goal" type="submit" className="primary" disabled={!trimmed} aria-disabled={busy}>{saveLabel}</button>
      </> : <>
        {supports('clear') && <button ref={rememberRemovedFocus} type="button" className="goal-clear" aria-disabled={busy}
          onClick={() => update({ kind: 'clear' })}>清除</button>}
        {toggleStatus && supports(toggleStatus) && <button ref={rememberRemovedFocus} type="button" aria-disabled={busy}
          onClick={() => update({ kind: toggleStatus })}>{toggleStatus === 'pause' ? '暂停' : status === 'complete' ? '重新开始' : '继续'}</button>}
        {supports('edit') && <button type="button" ref={attachEditButton} aria-disabled={busy}
          onClick={() => { if (!busy) changeEditor(true); }}>编辑</button>}
      </>}
    </div>
  </form>;
});

function FeedbackPanel({ send }) {
  const [reason, setReason] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  return <form className="feedback-form" onSubmit={async event => {
    event.preventDefault();
    if (pending || !reason.trim()) return;
    setPending(true);
    setError('');
    try { await send(reason.trim()); }
    catch (failure) { setError(failure.message); }
    finally { setPending(false); }
  }}>
    <label>反馈内容<textarea rows={3} maxLength={2000} value={reason} readOnly={pending}
      onChange={event => setReason(event.target.value)} /></label>
    <small>发送会话 ID 和填写的反馈，不附加诊断日志。</small>
    {error && <p role="alert">{error}</p>}
    <div className="panel-actions"><button type="submit" disabled={pending || !reason.trim()} className="primary">
      {pending ? '正在发送…' : '发送反馈'}
    </button></div>
  </form>;
}

export function AgentPanel({ panel, work, reasoning, reasoningArchived, reasoningProgress,
  onClose, onGoalAction, report, openSession, openTrace, openArtifact, canPreviewArtifact, openImage }) {
  const close = useRef(null);
  const content = useRef(null);
  const extensionSearch = useRef(null);
  const memberScroll = useRef(null);
  const [readingMember, setReadingMember] = useState();
  const { id: panelId, focus, editGoal, rosterPosition } = panel ?? {};
  const onMemberScroll = useCallback(reading => setReadingMember(reading ? panelId : undefined), [panelId]);
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
  const inspect = usagePanel || agentsPanel || ['subagent', 'diff', 'extensions'].includes(panel.kind);
  const readingMemberHistory = panel.kind === 'subagent' && readingMember === panelId;
  const memberSession = panel.kind === 'subagent' && work.api?.delegation?.resumeMemberSession && panel.member.session;
  const canResumeMember = Boolean(memberSession && !work.loading && work.run?.status !== 'running' && work.connection === 'ready');
  const detailsLabel = reasoningPanel ? '任务过程详情' : usagePanel ? '用量明细' : agentsPanel ? '代理与团队明细'
    : panel.kind === 'diff' ? '差异明细'
      : panel.kind === 'output' || panel.kind === 'extensions' ? `${title}正文` : undefined;
  const id = panel.kind === 'goal' || reasoningPanel ? `${panel.kind}-panel` : undefined;
  const goal = panel.kind === 'goal' ? work.goal : undefined;
  const usage = goal?.tokens == null ? '' : [goal.tokens, goal.budget].filter(value => value != null)
    .map(value => value.toLocaleString('zh-CN')).join(' / ') + ' tokens';
  return <section className="agent-panel popup-surface" id={id} data-kind={panel.kind} data-archived={reasoningArchived || undefined}
    aria-label={title} onKeyDown={event => {
      if (event.key !== 'Escape' || event.nativeEvent.isComposing) return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    }}>
    <header>
      {panel.returnTo && <button ref={close} className="panel-link agent-panel-back" type="button" aria-label="返回代理与团队" onClick={() => onClose()}>
        <ArrowLeft size={15} aria-hidden="true" />返回
      </button>}
      <strong title={panel.kind === 'subagent' ? title : undefined}>{title}</strong>
      {reasoningProgress && <div className="reasoning-panel-progress" title={reasoningProgress.preview}>
        <Brain size={14} aria-hidden="true" />
        <span className="reasoning-preview"><bdi>{reasoningProgress.preview}</bdi></span>
        {reasoningProgress.final && <small className="reasoning-status">已完成</small>}
      </div>}
      {goal && <small className="goal-panel-status" data-status={goal.status}>
        {goalStatusLabel(goal.status, work.api?.goal?.activeWithoutTurn)}
      </small>}
      {usage && <small className="panel-meta" title={usage}>{usage}</small>}
      {reasoningArchived && <small className="panel-meta">已归档</small>}
      {usagePanel && <button type="button" className="panel-link usage-refresh" aria-disabled={work.usageRefreshing}
        onClick={() => { if (!work.usageRefreshing) work.refreshUsage().catch(report); }}>
        {work.usageRefreshing ? '刷新中…' : '刷新用量'}
      </button>}
      {memberSession && <button type="button" className="panel-link" disabled={!canResumeMember}
        onClick={() => openSession(memberSession)}>打开会话</button>}
      {readingMemberHistory && <LatestMessageButton className="subagent-latest" label="滚到子代理最新消息" scroll={memberScroll} />}
      {!panel.returnTo && <button ref={close} className="icon-button" type="button" aria-label="关闭面板" onClick={() => onClose()}>
        <X size={15} />
      </button>}
    </header>
    {panel.kind === 'goal' ? <GoalPanel key={panel.id} hasGoal={Boolean(goal)} savedObjective={goal?.objective} savedBudget={goal?.budget}
      status={goal?.status} reason={goal?.reason} capability={work.api?.goal} action={onGoalAction}
      report={report} editOnOpen={panel.editGoal} /> : <div className="agent-panel-content" ref={content}
      tabIndex={detailsLabel ? 0 : undefined} role={detailsLabel ? 'group' : undefined} aria-label={detailsLabel}>
      {panel.kind === 'settings' && <RuntimeSettings api={work.api} models={work.models} options={work.options} setOptions={work.setOptions} />}
      {reasoningPanel && <ReasoningText rows={reasoning} scroll={content} archived={reasoningArchived} />}
      {panel.kind === 'output' && <pre className="panel-output">{panel.text}</pre>}
      {panel.kind === 'feedback' && <FeedbackPanel key={panel.id} send={panel.send} />}
      {inspect && <AgentInspector panel={panel} work={work} close={close} extensionSearch={extensionSearch}
        extensionLabel={extensionLabels[panel.extension]} memberScroll={memberScroll} readingMemberHistory={readingMemberHistory}
        onMemberScroll={onMemberScroll} canResumeMember={canResumeMember}
        report={report} openSession={openSession} openTrace={openTrace}
        openArtifact={openArtifact} canPreviewArtifact={canPreviewArtifact} openImage={openImage} />}
    </div>}
  </section>;
}

export const AgentMenu = memo(function AgentMenu({ api, hasGoal, models, modelId, modeId, onSelect }) {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const trigger = useRef(null);
  const menu = useRef(null);
  const focusOnOpen = useRef(0);
  useLayoutEffect(() => {
    if (!open || !focusOnOpen.current) return;
    const entry = focusOnOpen.current > 0 ? menu.current?.firstElementChild : menu.current?.lastElementChild;
    focusOnOpen.current = 0;
    entry?.focus({ preventScroll: true });
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const dismiss = event => {
      if (!trigger.current?.parentElement.contains(event.target)) setOpen(false);
    };
    window.addEventListener('pointerdown', dismiss);
    return () => window.removeEventListener('pointerdown', dismiss);
  }, [open]);
  const entries = [
    ...(models.length || api?.modes?.length || api?.permissions?.length ? [['settings', SlidersHorizontal, titles.settings]] : []),
    ...(api?.goal && !hasGoal ? [['goal', Goal, titles.goal, '/goal']] : []),
    ...(api?.usage ? [['usage', ChartNoAxesColumnIncreasing, titles.usage, '/usage']] : []),
    ...(api?.delegation ? [['agents', Users, titles.agents, '/agents']] : []),
    ...(api?.extensions?.kinds.includes('skill') ? [['skill', BookOpen, extensionLabels.skill, '/skills']] : []),
  ];
  if (!entries.length) return null;
  const selectedModel = models.find(model => model.id === modelId) ?? models.find(model => model.isDefault);
  const modelLabel = selectedModel?.label ?? (models.length ? '后端默认' : undefined);
  const modeLabel = modeId === 'default' ? undefined : api?.modes?.find(mode => mode.id === modeId)?.label;
  const label = [modelLabel, modeLabel].filter(Boolean).join(' · ');
  const description = [label, entries.map(([, , name]) => name).join('、')].filter(Boolean).join(' · ');
  function onKeyDown(event) {
    if (event.nativeEvent.isComposing || event.defaultPrevented) return;
    const { key } = event;
    if (open && key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      trigger.current?.focus({ preventScroll: true });
      setOpen(false);
      return;
    }
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const arrow = key === 'ArrowUp' || key === 'ArrowDown';
    if (!arrow && (!open || (key !== 'Home' && key !== 'End'))) return;
    event.preventDefault();
    if (!open) {
      focusOnOpen.current = key === 'ArrowDown' ? 1 : -1;
      setOpen(true);
      return;
    }
    const items = Array.from(menu.current.children);
    const active = items.indexOf(event.target);
    let next;
    switch (key) {
      case 'ArrowDown': next = (active + 1) % items.length; break;
      case 'ArrowUp': next = active > 0 ? active - 1 : items.length - 1; break;
      case 'Home': next = 0; break;
      case 'End': next = items.length - 1; break;
    }
    items[next]?.focus({ preventScroll: true });
  }
  return <div className="agent-menu"
    onBlur={event => {
      if (open && !event.currentTarget.contains(event.relatedTarget)) setOpen(false);
    }}
    onKeyDown={onKeyDown}>
    <button ref={trigger} className="composer-control" type="button" aria-label="Agent 控件" aria-expanded={open}
      aria-controls={open ? menuId : undefined}
      aria-description={description} title={description}
      onClick={() => setOpen(value => !value)}>
      <SlidersHorizontal className="agent-menu-icon" size={16} aria-hidden="true" />
      <span className="agent-menu-label">Agent</span>
      {label && <span className="agent-menu-model">{label}</span>}
      <ChevronDown className="agent-menu-chevron" size={12} aria-hidden="true" />
    </button>
    {open && <div ref={menu} id={menuId} role="group" className="agent-menu-entries popup-surface" aria-label="Agent 操作">
      {entries.map(([kind, Icon, name, command]) => {
        const detail = kind === 'settings' ? label : '';
        return <button key={kind} type="button" aria-description={detail || command} onClick={() => {
          setOpen(false);
          onSelect(kind, trigger.current);
        }}>
          <Icon size={15} aria-hidden="true" />
          {detail ? <span className="agent-menu-setting">{name}<small dir="auto" aria-hidden="true">{detail}</small></span> : name}
          {command && <code aria-hidden="true">{command}</code>}
        </button>;
      })}
    </div>}
  </div>;
});

export const GoalStrip = memo(function GoalStrip({ ref, objective, status, activeWithoutTurn, expanded, toggle }) {
  const label = goalStatusLabel(status, activeWithoutTurn);
  return <button ref={ref} type="button" className="goal-strip" title={objective} aria-label="会话目标"
    aria-describedby="goal-strip-status goal-strip-objective" aria-expanded={expanded}
    aria-controls={expanded ? 'goal-panel' : undefined} data-status={status} onClick={toggle}>
    <Goal size={16} className="goal-icon" aria-hidden="true" />
    <span id="goal-strip-objective" dir="auto">{objective}</span><small id="goal-strip-status">{label}</small>
    <ChevronDown size={13} className="goal-chevron" aria-hidden="true" />
  </button>;
});
