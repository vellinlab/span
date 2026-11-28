import { useCallback, useEffect, useEffectEvent, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { AgentMemberList, AgentStatus, memberName } from './agent-members.jsx';
import { sessionKey } from './agent.js';
import { mergeAgentMember } from './delegation.js';
import { PathText } from './file-reference-name.jsx';
import { PatchView } from './patch-view.jsx';
import { TextReader } from './text-reader.jsx';
import { delegatedMembers } from './timeline.js';
import { Transcript } from './transcript.jsx';
import { observeWindowHidden } from './window-visibility.js';

const number = new Intl.NumberFormat('zh-CN');

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
  const [expandedTask, setExpandedTask] = useState(null);
  const titles = new Map(tasks.map(task => [task.id, task.title]));
  return <ul className="agent-member-list" aria-label="团队任务">{tasks.map(task => {
    const expanded = expandedTask === task.id;
    const assignee = task.assigneeId && members.get(task.assigneeId);
    const dependencies = (task.dependsOn ?? task.blockedBy)?.map(id => titles.get(id) || id).join('、');
    const metadata = [task.assigneeId && `负责人 ${assignee ? memberName(assignee) : task.assigneeId}`,
      dependencies && `依赖 ${dependencies}`].filter(Boolean).join(' · ');
    const title = <span className="agent-member-label">{task.title}</span>;
    return <li key={task.id} className="agent-member-row">
      {task.detail ? <button type="button" className="agent-member-name agent-task-title" aria-expanded={expanded}
        onClick={() => setExpandedTask(expanded ? null : task.id)}>
        <ChevronRight size={13} aria-hidden="true" />{title}
      </button> : title}
      <AgentStatus status={task.status} />
      {metadata && <small className="agent-member-meta">{metadata}</small>}
      {expanded && task.detail && <p className="agent-member-detail">{task.detail}</p>}
    </li>;
  })}</ul>;
}

const teamStatuses = { active: '运行中', closed: '已关闭', orphaned: '主会话已断开' };

function AgentsPanel({ work, openSession, openTrace, report }) {
  const [windowHidden, setWindowHidden] = useState(null);
  const hiddenNow = useRef(true);
  const { teams, members: liveMembers } = work;
  const teamSession = work.session?.ref;
  const activeKey = sessionKey(teamSession);
  const delegation = work.api?.delegation;
  const cadence = delegation?.teamRefreshMs;
  const ready = Boolean(activeKey && work.connection === 'ready' && !work.loading);
  const running = Boolean(cadence && work.run?.status === 'running');
  const observing = running || teams.some(team => team.status === 'active');
  const refresh = useEffectEvent(async reportError => {
    try { await work.refreshDelegation(); }
    catch (error) { if (reportError) report(error); }
  });
  useEffect(() => {
    if (!ready) return;
    const release = () => cadence && delegation.releaseTeamView?.(teamSession);
    const stop = observeWindowHidden(hidden => {
      hiddenNow.current = hidden;
      setWindowHidden(hidden);
      if (hidden) release();
    });
    return () => {
      stop();
      release();
    };
  }, [ready, cadence, delegation, teamSession]);
  useEffect(() => {
    if (ready && windowHidden === false && !hiddenNow.current) refresh(true);
  }, [activeKey, ready, running, windowHidden]);
  useEffect(() => {
    if (!ready || !cadence || !observing || windowHidden !== false) return;
    let disposed = false;
    let inFlight = false;
    let timer;
    function schedule() {
      clearTimeout(timer);
      if (disposed || hiddenNow.current || inFlight) return;
      timer = setTimeout(async () => {
        if (hiddenNow.current) return;
        inFlight = true;
        await refresh(false);
        inFlight = false;
        schedule();
      }, cadence);
    }
    schedule();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [activeKey, ready, cadence, observing, windowHidden]);
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

function SubagentTranscript({ panel, delegation, scroll, showLatest, onScrollPosition,
  openSession, canOpenSession, openTrace, openArtifact, openImage }) {
  const [view, setView] = useState();
  const [error, setError] = useState('');
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
    <Transcript rows={view.rows} viewKey={sessionKey(member.session) || JSON.stringify([sessionKey(session), member.id])}
      scroll={scroll} jumpToLatest={jumpToLatest}
      label="子代理会话记录" testId="subagent-transcript" activeTurnId={view.run?.status === 'running' ? view.run.id : undefined}
      cursor={view.cursor} loadOlder={view.loadOlder} loading={view.loading}
      showLatest={showLatest} onScrollPosition={onScrollPosition} openTrace={openTrace}
      openSession={openSession} canOpenSession={canOpenSession} openArtifact={openArtifact} openImage={openImage} />
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

function ExtensionList({ panel, search, close, label }) {
  const [listing, setListing] = useState({ items: [], cursor: null, loading: true, error: '' });
  const [query, setQuery] = useState(panel.query ?? '');
  const [skillLimit, setSkillLimit] = useState(skillPageSize);
  const pending = useRef(null);
  useLayoutEffect(() => {
    // A search with an initial query used to take focus on open. During a cold
    // load, the close button keeps that focus until the search field is ready.
    const field = search.current;
    if (panel.focus && panel.query && field && close.current === field.ownerDocument.activeElement) {
      field.focus({ preventScroll: true });
    }
  }, [panel.focus, panel.query, search, close]);
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
    {!listing.items.length && !listing.loading && !listing.error && <p className="extension-note">没有可显示的{label}。</p>}
    {term && listing.items.length > 0 && !visible.length && <p role="status" className="extension-note">没有匹配的技能。</p>}
    {(moreSkills || listing.cursor !== null || listing.error) && <button ref={pageButton} type="button" className="panel-link extension-more"
      aria-disabled={listing.loading || undefined}
      onClick={() => moreSkills && !listing.error ? setSkillLimit(limit => limit + skillPageSize) : loadPage(listing.cursor)}>
      {listing.error ? '重试' : '加载更多'}
    </button>}
  </>;
}

export default function AgentInspector({ panel, work, close, extensionSearch, extensionLabel, memberScroll,
  readingMemberHistory, onMemberScroll, canResumeMember, report, openSession, openTrace, openArtifact, openImage }) {
  switch (panel.kind) {
    case 'usage':
      return <UsagePanel usage={work.usage} refreshing={work.usageRefreshing} />;
    case 'agents':
      return <AgentsPanel work={work} openSession={openSession} openTrace={openTrace} report={report} />;
    case 'subagent':
      return <SubagentTranscript key={panel.id} panel={panel} delegation={work.api?.delegation}
        scroll={memberScroll} showLatest={readingMemberHistory} onScrollPosition={onMemberScroll}
        openSession={openSession} canOpenSession={canResumeMember} openTrace={openTrace}
        openArtifact={openArtifact} openImage={openImage} />;
    case 'diff':
      return <DiffPanel key={panel.id} panel={panel} />;
    case 'extensions':
      return <ExtensionList key={panel.id} panel={panel} search={extensionSearch} close={close} label={extensionLabel} />;
  }
}
