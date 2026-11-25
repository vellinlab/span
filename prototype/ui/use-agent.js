import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createAgent, mergeSessions, sessionKey } from './agent.js';
import { reconcileRoster, recordRosterUpdate, updateRoster } from './delegation.js';
import { attachmentArtifacts } from './file-references.js';
import { rememberWorkspace, savedSession } from './recent-workspaces.js';
import { applyTimeline, historyRows, mergeHistory } from './timeline.js';
import { observeWindowHidden } from './window-visibility.js';

const PAGE_SIZE = 20;
const HIDDEN_DELTA_LIMIT = 128;
const HIDDEN_TEXT_LIMIT = 64 * 1024;

export function useAgent(config, { report, clearError, adoptDraft, jumpToLatest, suspendTimeline }) {
  const [api, setApi] = useState(null);
  const [connection, setConnection] = useState('connecting');
  const [route, setRoute] = useState('');
  const [sessions, setSessions] = useState([]);
  const [sessionCursor, setSessionCursor] = useState(null);
  const [catalogRevision, setCatalogRevision] = useState(0);
  const [archived, setArchived] = useState(false);
  const [session, setSession] = useState(null);
  const [rows, publishRows] = useState([]);
  const [cursor, setCursor] = useState(null);
  const [historyPages, setHistoryPages] = useState(0);
  const [loading, setLoading] = useState(false);
  const [run, setRun] = useState(null);
  const [stopping, setStopping] = useState(false);
  const [requests, setRequests] = useState([]);
  const [goal, setGoal] = useState(null);
  const [usage, setUsage] = useState({});
  const [usageRefreshing, setUsageRefreshing] = useState(false);
  const [teams, setTeams] = useState([]);
  const [members, setMembers] = useState([]);
  const [models, setModels] = useState([]);
  const [options, setOptions] = useState({});

  const layer = useRef(0);
  // Different renderer loads must never reuse transport generations.
  const generation = useRef(Math.trunc(performance.timeOrigin * 1000));
  const active = useRef(null);
  const agent = useRef(null);
  const busy = useRef(false);
  const currentRun = useRef(null);
  const stopRequest = useRef(null);
  const callbacks = useRef({ goal: 0, run: 0, catalog: 0 });
  const requestedArchiveView = useRef(false);
  const pendingPage = useRef(null);
  const pendingSend = useRef(null);
  const usageRefresh = useRef(null);
  const rosterRefresh = useRef(null);
  const queue = useRef({ events: [], characters: 0 });
  const frame = useRef(0);
  const bufferedRows = useRef(rows);
  const publicationPaused = useRef(false);
  const updateRows = useCallback(update => {
    if (frame.current) {
      cancelAnimationFrame(frame.current);
      frame.current = 0;
    }
    const pending = queue.current;
    if (pending.events.length) {
      queue.current = { events: [], characters: 0 };
      bufferedRows.current = applyTimeline(bufferedRows.current, pending.events);
    }
    if (update) bufferedRows.current = update(bufferedRows.current);
    if (!publicationPaused.current) publishRows(bufferedRows.current);
  }, []);
  const flushFrame = useCallback(() => {
    frame.current = 0;
    updateRows();
  }, [updateRows]);

  const covered = suspendTimeline && requests.length === 0;
  useLayoutEffect(() => {
    function syncPublication(windowHidden) {
      const paused = covered || windowHidden;
      if (paused === publicationPaused.current) return;
      publicationPaused.current = paused;
      // Commit the previous batch. Revealing the conversation also publishes it.
      updateRows();
    }
    return observeWindowHidden(syncPublication);
  }, [covered, updateRows]);

  function clearTimeline() {
    layer.current++;
    active.current = null;
    currentRun.current = null;
    clearStop();
    busy.current = false;
    pendingPage.current = null;
    pendingSend.current = null;
    usageRefresh.current = null;
    rosterRefresh.current = null;
    jumpToLatest.current = true;
    cancelAnimationFrame(frame.current);
    frame.current = 0;
    queue.current = { events: [], characters: 0 };
    updateRows(() => []);
    setCursor(null);
    setHistoryPages(0);
    setSession(null);
    setRequests([]);
    setGoal(null);
    setUsage(previous => ({ limits: previous.limits }));
    setUsageRefreshing(false);
    setTeams([]);
    setMembers([]);
    setRun(null);
    if (agent.current?.sessionModels) setModels([]);
    setOptions({});
    setLoading(false);
    return layer.current;
  }

  function changeRun(next) {
    callbacks.current.run++;
    currentRun.current = next?.status === 'running' ? next : null;
    if (stopRequest.current?.turnId !== currentRun.current?.id) clearStop();
    setRun(currentRun.current);
  }

  function clearStop() {
    if (!stopRequest.current) return;
    stopRequest.current = null;
    setStopping(false);
  }

  function changeRoster(kind, id, entry) {
    const updates = rosterRefresh.current?.[kind];
    if (updates) recordRosterUpdate(updates, id, entry);
    const update = kind === 'members' ? setMembers : setTeams;
    update(previous => updateRoster(previous, id, entry));
  }

  function updateUsage(value) {
    const received = usageRefresh.current?.received;
    if (received) for (const field of Object.keys(value)) received.add(field);
    setUsage(previous => ({ ...previous, ...value }));
  }

  function receive(event) {
    if (event.kind === 'connection') {
      setRoute(event.route);
      return;
    }
    if (event.kind === 'disconnected') {
      if (queue.current.events.length) updateRows();
      changeRun(null);
      rosterRefresh.current = null;
      usageRefresh.current = null;
      setUsageRefreshing(false);
      busy.current = false;
      setRequests([]);
      setConnection('offline');
      if (event.error) report(new Error(event.error));
      return;
    }
    if (event.kind === 'quota') {
      updateUsage({ limits: event.limits });
      return;
    }
    if (event.kind === 'connectionInteraction' || event.kind === 'connectionInteractionResolved') {
      const id = event.request?.id ?? event.id;
      setRequests(previous => {
        const remaining = previous.filter(request => request.id !== id);
        return event.kind === 'connectionInteraction' ? [...remaining, event.request] : remaining;
      });
      return;
    }
    if (sessionKey(event.session) !== active.current?.key) return;
    switch (event.kind) {
      case 'item':
      case 'delta': {
        const pending = queue.current;
        pending.events.push(event);
        if (!publicationPaused.current) {
          if (!frame.current) frame.current = requestAnimationFrame(flushFrame);
          break;
        }
        // Full items can carry large diffs or output. Drain them in arrival order,
        // and cap the delta backlog without waking a covered or minimized window per frame.
        if (event.kind === 'delta' && typeof event.delta.text === 'string') pending.characters += event.delta.text.length;
        if (event.kind === 'item' || pending.events.length >= HIDDEN_DELTA_LIMIT ||
          pending.characters >= HIDDEN_TEXT_LIMIT) updateRows();
        break;
      }
      case 'run':
        if (publicationPaused.current && event.run.status !== 'running' && queue.current.events.length) updateRows();
        changeRun(event.run);
        if (event.run.error) report(new Error(event.run.error));
        break;
      case 'interaction':
        setRequests(previous => [...previous.filter(request => request.id !== event.request.id), event.request]);
        break;
      case 'interactionResolved':
        setRequests(previous => previous.filter(request => request.id !== event.id));
        break;
      case 'goal':
        callbacks.current.goal++;
        setGoal(event.goal);
        break;
      case 'usage':
        updateUsage(event.usage);
        break;
      case 'models':
        setModels(event.models);
        break;
      case 'session':
        setSession(previous => previous ? { ...previous, ...event.info } : previous);
        setSessions(previous => previous.map(entry => sessionKey(entry.ref) === sessionKey(event.session)
          ? { ...entry, ...event.info } : entry));
        break;
      case 'team':
        changeRoster('teams', event.team.id, event.team);
        break;
      case 'member':
        changeRoster('members', event.member.id, event.member);
        break;
      case 'queuedInput':
        updateRows(previous => previous.map(row => row.clientId === event.clientId ? { ...row, queued: event.state } : row));
        break;
    }
  }

  function readPage(history, runVersion, pageCount) {
    updateRows(previous => mergeHistory(previous, historyRows(history.items)));
    setCursor(history.cursor);
    setHistoryPages(pageCount);
    const restored = history.items.findLast(item => item.run.status === 'running');
    if (restored && runVersion === callbacks.current.run) changeRun(restored.run);
  }

  function putSession(entry, front = false) {
    const key = sessionKey(entry.ref);
    setSessions(previous => {
      const exists = previous.some(item => sessionKey(item.ref) === key);
      if (exists) return previous.map(item => sessionKey(item.ref) === key ? { ...item, ...entry } : item);
      return front ? [entry, ...previous] : previous;
    });
  }

  async function loadSession(client, entry, { opened, view, restoring } = {}) {
    const previous = active.current?.ref;
    const scope = clearTimeline();
    clearError();
    setLoading(true);
    let selected = entry;
    active.current = { ref: entry.ref, key: sessionKey(entry.ref) };
    setSession(entry);
    const runVersion = callbacks.current.run;
    try {
      if (previous && sessionKey(previous) !== active.current.key) {
        client.sessions.release?.(previous).catch(() => {});
      }
      const state = opened ?? await client.sessions.resume(entry.ref, PAGE_SIZE);
      if (scope !== layer.current) return;
      selected = { ...entry, ...Object.fromEntries(Object.entries(state.session).filter(([, value]) => value != null)) };
      active.current = { ref: selected.ref, key: sessionKey(selected.ref) };
      setSession(selected);
      putSession(selected, Boolean(opened) && !archived);
      setOptions(state.options ?? {});
      if (state.models) setModels(state.models);

      const goalVersion = callbacks.current.goal;
      client.goal?.read(selected.ref).then(value => {
        if (scope === layer.current && goalVersion === callbacks.current.goal) setGoal(value);
      }).catch(() => {});

      let page = state.history ?? await client.sessions.history(selected.ref, { limit: PAGE_SIZE });
      const pages = [page.items];
      const seen = new Set();
      const target = view?.anchor?.turnId;
      // Restore the part of history already read, with one extra page for new turns.
      while (scope === layer.current && target && pages.length <= view.pages && page.cursor && !seen.has(page.cursor)
        && !page.items.some(turn => turn.id === target)) {
        seen.add(page.cursor);
        try {
          page = await client.sessions.history(selected.ref, { limit: PAGE_SIZE, cursor: page.cursor });
          pages.push(page.items);
        } catch (error) {
          if (scope === layer.current) report(error);
          break;
        }
      }
      if (scope === layer.current) {
        readPage({ items: pages.reverse().flat(), cursor: page.cursor }, runVersion, pages.length);
        rememberWorkspace(config, selected.ref.id);
      }
    } catch (error) {
      if (scope !== layer.current) return;
      if (restoring) {
        client.sessions.release?.(selected.ref).catch(() => {});
        clearTimeline();
        if (restoring()) {
          rememberWorkspace(config, null);
          report(new Error(`无法恢复上次会话。 ${error.message}`));
        }
      } else report(error);
    } finally {
      if (scope === layer.current) setLoading(false);
    }
  }

  async function list(client, showArchived, next) {
    requestedArchiveView.current = showArchived;
    const version = ++callbacks.current.catalog;
    const page = await client.sessions.list({ cursor: next ?? undefined, archived: showArchived });
    if (version !== callbacks.current.catalog || client !== agent.current) return [];
    setSessions(previous => next ? mergeSessions(previous, page.items) : page.items);
    setSessionCursor(page.cursor);
    setArchived(showArchived);
    return page.items;
  }

  function prepareConnection() {
    agent.current = null;
    clearTimeline();
    clearError();
    setApi(null);
    setConnection('connecting');
    setRoute('');
    setSessions([]);
    setSessionCursor(null);
    setArchived(false);
    setModels([]);
    setUsage({});
  }

  useEffect(() => {
    if (!config) return;
    const controller = new AbortController();
    let disconnected = false;
    let client;
    const location = config.ssh ? { kind: 'ssh', host: config.ssh } : { kind: 'local' };
    const isCurrent = () => !controller.signal.aborted && !disconnected && agent.current === client;
    async function start() {
      const loaded = await createAgent(config.backend, {
        generation: ++generation.current, cwd: config.cwd, location,
        onEvent: event => {
          if (!isCurrent()) return;
          if (event.kind === 'disconnected') disconnected = true;
          receive(event);
        },
      }, controller.signal);
      if (controller.signal.aborted) {
        loaded?.close();
        return;
      }
      client = loaded;
      agent.current = client;
      setApi(client);
      await client.open();
      if (!isCurrent()) return;
      const previousId = savedSession(config);
      rememberWorkspace(config);
      client.models?.().then(value => {
        if (isCurrent()) setModels(value);
      }).catch(() => {});
      const items = await list(client, false).catch(error => {
        if (isCurrent()) report(error);
        return [];
      });
      if (!isCurrent()) return;
      const selected = config.demo ? items[0] : previousId && (items.find(item => item.ref.id === previousId) ??
        { ref: { backend: config.backend, location, id: previousId } });
      if (selected && !active.current && !busy.current) {
        const opening = loadSession(client, selected, { restoring: config.demo ? undefined : isCurrent });
        setConnection('ready');
        await opening;
      } else setConnection('ready');
    }
    start().catch(error => {
      if (controller.signal.aborted || disconnected || (client && !isCurrent())) return;
      setConnection('offline');
      report(error);
      client?.close();
    });
    return () => {
      controller.abort();
      if (agent.current === client) {
        agent.current = null;
        rosterRefresh.current = null;
      }
      client?.close();
      cancelAnimationFrame(frame.current);
    };
  }, [config, report, clearError]);

  const loadOlder = useCallback(async () => {
    const client = agent.current;
    const ref = active.current?.ref;
    if (!cursor || !client || !ref || pendingPage.current) return;
    const scope = layer.current;
    const request = client.sessions.history(ref, { limit: PAGE_SIZE, cursor });
    pendingPage.current = request;
    setLoading(true);
    try {
      const history = await request;
      if (scope !== layer.current) return;
      updateRows(previous => mergeHistory(previous, historyRows(history.items)));
      setCursor(history.cursor);
      setHistoryPages(previous => previous + 1);
    } catch (error) {
      if (scope === layer.current) report(error);
    } finally {
      if (pendingPage.current === request) {
        pendingPage.current = null;
        setLoading(false);
      }
    }
  }, [cursor, report, updateRows]);

  function guard() {
    return connection === 'ready' && agent.current && !loading && !busy.current && !currentRun.current;
  }

  function open(entry, view) {
    if (!guard() || sessionKey(entry.ref) === active.current?.key) return;
    if (entry.ref.backend !== config.backend || (entry.ref.location.host ?? '') !== config.ssh) {
      report(new Error('请先连接此会话所在的 Agent 和主机。'));
      return;
    }
    return loadSession(agent.current, entry, { view });
  }

  function reset() {
    if (busy.current || currentRun.current || loading) return false;
    clearSession();
    return true;
  }

  function clearSession() {
    const previous = active.current?.ref;
    clearTimeline();
    if (previous) agent.current?.sessions.release?.(previous).catch(() => {});
    if (connection === 'ready') {
      rememberWorkspace(config, null);
      clearError();
    }
  }

  async function forkSession() {
    const client = agent.current;
    const ref = active.current?.ref;
    if (!ref || !session) throw new Error('请先打开一个会话。');
    if (!client?.sessions.fork) throw new Error('当前 Agent 不支持复制会话。');
    if (!guard()) throw new Error('请等当前任务或连接完成。');
    const scope = layer.current;
    busy.current = true;
    try {
      const opened = await client.sessions.fork(ref);
      if (scope !== layer.current) return false;
      const loadingCopy = loadSession(client, { ...session, ref: opened.session.ref, archived: false }, { opened });
      const copyScope = layer.current;
      setCatalogRevision(value => value + 1);
      await loadingCopy;
      return copyScope === layer.current;
    } finally {
      if (scope === layer.current) busy.current = false;
    }
  }

  async function archiveSession() {
    const client = agent.current;
    const ref = active.current?.ref;
    if (!ref) throw new Error('请先打开一个会话。');
    if (!guard()) throw new Error('请等当前任务或连接完成。');
    const scope = layer.current;
    const archived = !session?.archived;
    busy.current = true;
    try {
      await client.sessions.archive(ref, archived);
      if (scope !== layer.current || client !== agent.current) return false;
      clearSession();
      const key = sessionKey(ref);
      setSessions(previous => previous.filter(entry => sessionKey(entry.ref) !== key || Boolean(entry.archived) === archived));
      setCatalogRevision(value => value + 1);
      list(client, requestedArchiveView.current).catch(error => {
        if (client === agent.current) report(error);
      });
      return true;
    } finally {
      if (scope === layer.current) busy.current = false;
    }
  }

  async function ensureSession(client, title, scope) {
    if (active.current) return active.current.ref;
    const started = await client.sessions.start({ cwd: config.ssh ? undefined : config.cwd });
    if (scope !== layer.current) return null;
    const entry = { ...started.session, preview: started.session.preview || title };
    active.current = { ref: entry.ref, key: sessionKey(entry.ref) };
    adoptDraft(config, entry.ref);
    setSession(entry);
    if (started.models) {
      setModels(started.models);
      if (started.options) setOptions(previous => ({ ...started.options, ...previous }));
    }
    if (!archived) putSession(entry, true);
    return entry.ref;
  }

  async function send(text, selectedOptions, delivery = 'steer', { onDispatch, files = [], followLatest = true } = {}) {
    const client = agent.current;
    const steering = currentRun.current;
    const steer = client?.turns.steer;
    if (!client || connection !== 'ready' || loading || busy.current || (files.length && !client.localFileReferences) ||
      (!client.localImageInputs && files.some(file => file.kind === 'image')) ||
      (steering && !(delivery === 'followUp' ? client.turns.followUp : steer))) return false;
    const scope = layer.current;
    clearError();
    busy.current = true;
    const clientId = crypto.randomUUID();
    pendingSend.current = clientId;
    setRun(steering ?? { status: 'running' });
    if (!steering || followLatest) jumpToLatest.current = true;
    let added = false;
    try {
      const ref = await ensureSession(client, (text || files[0]?.name || '').slice(0, 48), scope);
      if (!ref) return false;
      const input = text ? [{ kind: 'text', text }] : [];
      for (const file of files) input.push(file.kind === 'image'
        ? { kind: 'image', path: file.path }
        : { kind: 'file', path: file.path, name: file.name });
      updateRows(previous => [...previous, { kind: 'user', text, clientId, key: clientId,
        ...(files.length && { attachments: attachmentArtifacts(files) }),
        turnId: steering?.id, optimistic: true, queued: steering && delivery === 'followUp' ? 'queued' : undefined }]);
      added = true;
      onDispatch?.();
      if (steering && delivery === 'followUp') {
        await client.turns.followUp(ref, input, clientId);
      } else if (steering) {
        await steer.call(client.turns, ref, steering.id, input, clientId);
      } else {
        const runVersion = callbacks.current.run;
        const result = await client.turns.start(ref, input, selectedOptions, clientId);
        if (scope === layer.current) {
          rememberWorkspace(config, ref.id);
          if (runVersion === callbacks.current.run) changeRun(result);
        }
      }
      return true;
    } catch (error) {
      if (scope !== layer.current) return false;
      if (added) updateRows(previous => previous.filter(row => row.key !== clientId || !row.optimistic));
      setRun(currentRun.current);
      report(error);
      return false;
    } finally {
      if (pendingSend.current === clientId) {
        pendingSend.current = null;
        busy.current = false;
      }
    }
  }

  async function withSession(action, { create = false, idle = false, title = '', allowEmpty = false } = {}) {
    const client = agent.current;
    if (!client || connection !== 'ready' || loading || (idle && (currentRun.current || busy.current))) {
      throw new Error('请等当前任务或连接完成。');
    }
    const scope = layer.current;
    if (!active.current && !create && !allowEmpty) throw new Error('请先打开一个会话。');
    if (!active.current && busy.current) throw new Error('请等当前会话启动完成。');
    const starting = !active.current && create;
    if (starting) busy.current = true;
    try {
      const ref = create ? await ensureSession(client, title, scope) : active.current?.ref ?? null;
      if ((!ref && !allowEmpty) || scope !== layer.current) return;
      const result = await action(client, ref);
      if (scope === layer.current) {
        if (create) rememberWorkspace(config, ref.id);
        return result;
      }
    } finally {
      if (starting && scope === layer.current) busy.current = false;
    }
  }

  async function stop() {
    const turnId = currentRun.current?.id;
    if (!turnId || stopRequest.current?.turnId === turnId) return;
    const request = { turnId };
    stopRequest.current = request;
    clearError();
    setStopping(true);
    try {
      await withSession((client, ref) => client.turns.stop(ref, turnId));
    } catch (error) {
      if (stopRequest.current !== request) return;
      clearStop();
      throw error;
    }
  }

  async function goalAction(action) {
    const version = ++callbacks.current.goal;
    const capability = agent.current?.goal;
    if (!capability || (action && capability.actions && !capability.actions.includes(action.kind))) {
      throw new Error('当前 Agent 不支持这个目标操作。');
    }
    const value = await withSession((client, ref) => action ? client.goal.update(ref, action, options) : client.goal.read(ref),
      { create: action?.kind === 'set', title: action?.objective?.slice(0, 48) });
    if (version === callbacks.current.goal && value !== undefined) setGoal(value);
    return value;
  }

  async function refreshUsage() {
    const client = agent.current;
    if (!client?.usage || usageRefresh.current) return;
    const target = active.current;
    const request = { received: new Set() };
    usageRefresh.current = request;
    const current = () => client === agent.current && usageRefresh.current === request;
    setUsageRefreshing(true);
    try {
      const value = await client.usage(target?.ref);
      if (!current()) return;
      const sameSession = target?.key === active.current?.key;
      // Notifications supersede the requested snapshot only for the fields they update.
      const fields = Object.entries(value).filter(([field]) => (sameSession || field === 'limits') && !request.received.has(field));
      if (fields.length) {
        const snapshot = Object.fromEntries(fields);
        setUsage(previous => ({ ...previous, ...snapshot }));
      }
    } catch (error) {
      if (current()) throw error;
    } finally {
      if (usageRefresh.current === request) {
        usageRefresh.current = null;
        setUsageRefreshing(false);
      }
    }
  }

  async function refreshDelegation() {
    if (!active.current || (!agent.current?.delegation?.members && !agent.current?.delegation?.teams)) return;
    await withSession(async (client, ref) => {
      const refresh = { members: new Map(), teams: new Map() };
      rosterRefresh.current = refresh;
      try {
        const [newMembers, newTeams] = await Promise.all([
          client.delegation.members?.(ref), client.delegation.teams?.(ref),
        ]);
        if (rosterRefresh.current !== refresh) return;
        // Replay only changes that arrived after this request began.
        if (newMembers) setMembers(previous => reconcileRoster(previous, newMembers, refresh.members));
        if (newTeams) setTeams(previous => {
          const next = reconcileRoster(previous, newTeams, refresh.teams);
          return client.delegation.teamRefreshMs && JSON.stringify(previous) === JSON.stringify(next) ? previous : next;
        });
      } catch (error) {
        if (rosterRefresh.current === refresh) throw error;
      } finally {
        if (rosterRefresh.current === refresh) rosterRefresh.current = null;
      }
    });
  }

  async function delegate(action) {
    const member = await withSession((client, ref) => client.delegation.act(ref, action));
    if (member) changeRoster('members', member.id, member);
  }

  async function manageTeam(action) {
    const scope = layer.current;
    const team = await withSession((client, ref) => client.delegation.manageTeam(ref, action));
    if (scope !== layer.current) return;
    if (team) changeRoster('teams', team.id, team);
    else if (action.kind === 'close') changeRoster('teams', action.teamId, null);
  }

  async function special(action) {
    await withSession(async (client, ref) => {
      const scope = layer.current;
      const version = callbacks.current.run;
      busy.current = true;
      jumpToLatest.current = true;
      setRun({ status: 'running' });
      try {
        const started = await action(client, ref);
        if (started && scope === layer.current && version === callbacks.current.run) changeRun(started);
      } catch (error) {
        if (scope === layer.current) setRun(currentRun.current);
        throw error;
      } finally {
        if (scope === layer.current) busy.current = false;
      }
    }, { idle: true });
  }

  return {
    api, connection, route, sessions, sessionCursor, catalogRevision, archived, session, rows, cursor, historyPages, loading, run, stopping, requests,
    goal, usage, usageRefreshing, teams, members, models, options, setOptions, loadOlder, open, reset, send, goalAction, refreshUsage, special,
    prepareConnection, timelineScope: () => layer.current,
    refreshDelegation, delegate, manageTeam,
    list: (showArchived = archived, more = false) => list(agent.current, showArchived, more ? sessionCursor : null),
    stop,
    respond: (id, reply) => {
      const request = requests.find(entry => entry.id === id);
      if (!api || api !== agent.current || !request ||
        (request.scope !== 'connection' && sessionKey(session?.ref) !== active.current?.key)) {
        throw new Error('此请求已经结束。');
      }
      return api.interactions.respond(id, reply);
    },
    withSession,
    fork: forkSession,
    rename: title => withSession(async (client, ref) => {
      await client.sessions.rename(ref, title);
      if (client !== agent.current) return;
      setCatalogRevision(value => value + 1);
      if (sessionKey(ref) === active.current?.key) setSession(previous => ({ ...previous, title }));
      putSession({ ref, title });
    }),
    archive: archiveSession,
  };
}
