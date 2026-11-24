import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createAgent, mergeSessions, sessionKey } from './agent.js';
import { applyTimeline, historyRows, mergeHistory } from './timeline.js';

const PAGE_SIZE = 20;

export function useAgent(config, { report, clearError, jumpToLatest, suspendTimeline }) {
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
  const [loading, setLoading] = useState(false);
  const [run, setRun] = useState(null);
  const [requests, setRequests] = useState([]);
  const [goal, setGoal] = useState(null);
  const [usage, setUsage] = useState({});
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
  const callbacks = useRef({ goal: 0, run: 0, catalog: 0 });
  const pendingPage = useRef(null);
  const pendingSend = useRef(null);
  const queue = useRef([]);
  const frame = useRef(0);
  const bufferedRows = useRef(rows);
  const publicationPaused = useRef(false);
  const updateRows = useCallback(update => {
    bufferedRows.current = update(bufferedRows.current);
    if (!publicationPaused.current) publishRows(bufferedRows.current);
  }, []);
  const flushTimeline = useCallback(() => {
    frame.current = 0;
    const events = queue.current;
    queue.current = [];
    updateRows(previous => applyTimeline(previous, events));
  }, [updateRows]);

  const pausePublication = suspendTimeline && requests.length === 0;
  useLayoutEffect(() => {
    publicationPaused.current = pausePublication;
    if (pausePublication) return;
    // Include the current batch when an approval or file dismissal reveals the conversation.
    if (frame.current) {
      cancelAnimationFrame(frame.current);
      flushTimeline();
    } else publishRows(bufferedRows.current);
  }, [pausePublication, flushTimeline]);

  function clearTimeline() {
    layer.current++;
    active.current = null;
    currentRun.current = null;
    busy.current = false;
    pendingPage.current = null;
    pendingSend.current = null;
    jumpToLatest.current = true;
    cancelAnimationFrame(frame.current);
    frame.current = 0;
    queue.current = [];
    updateRows(() => []);
    setCursor(null);
    setSession(null);
    setRequests([]);
    setGoal(null);
    setUsage(previous => ({ limits: previous.limits }));
    setTeams([]);
    setMembers([]);
    setRun(null);
    setOptions({});
    setLoading(false);
    return layer.current;
  }

  function changeRun(next) {
    callbacks.current.run++;
    currentRun.current = next?.status === 'running' ? next : null;
    setRun(currentRun.current);
  }

  function receive(event) {
    if (event.kind === 'connection') {
      setRoute(event.route);
      return;
    }
    if (event.kind === 'disconnected') {
      changeRun(null);
      busy.current = false;
      setRequests([]);
      setConnection('offline');
      if (event.error) report(new Error(event.error));
      return;
    }
    if (event.kind === 'quota') {
      setUsage(previous => ({ ...previous, limits: event.limits }));
      return;
    }
    if (sessionKey(event.session) !== active.current?.key) return;
    switch (event.kind) {
      case 'item':
      case 'delta':
        queue.current.push(event);
        if (!frame.current) frame.current = requestAnimationFrame(flushTimeline);
        break;
      case 'run':
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
        setUsage(previous => ({ ...previous, ...event.usage }));
        break;
      case 'session':
        setSession(previous => previous ? { ...previous, ...event.info } : previous);
        setSessions(previous => previous.map(entry => sessionKey(entry.ref) === sessionKey(event.session)
          ? { ...entry, ...event.info } : entry));
        break;
      case 'team':
        setTeams(previous => [...previous.filter(team => team.id !== event.team.id), event.team]);
        break;
      case 'member':
        setMembers(previous => [...previous.filter(member => member.id !== event.member.id), event.member]);
        break;
      case 'queuedInput':
        updateRows(previous => previous.map(row => row.clientId === event.clientId ? { ...row, queued: event.state } : row));
        break;
    }
  }

  function readPage(history, runVersion) {
    updateRows(previous => mergeHistory(previous, historyRows(history.items)));
    setCursor(history.cursor);
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

  async function loadSession(client, entry, opening) {
    const previous = active.current?.ref;
    const scope = clearTimeline();
    clearError();
    setLoading(true);
    let selected = entry;
    if (!opening) {
      active.current = { ref: entry.ref, key: sessionKey(entry.ref) };
      setSession(entry);
    }
    const runVersion = callbacks.current.run;
    try {
      if (previous && sessionKey(previous) !== sessionKey(entry.ref) && !opening) {
        client.sessions.release?.(previous).catch(() => {});
      }
      const state = await (opening ?? client.sessions.resume(entry.ref, PAGE_SIZE));
      if (scope !== layer.current) return;
      selected = { ...entry, ...Object.fromEntries(Object.entries(state.session).filter(([, value]) => value != null)) };
      active.current = { ref: selected.ref, key: sessionKey(selected.ref) };
      setSession(selected);
      putSession(selected, Boolean(opening) && !archived);
      setOptions(state.options ?? {});
      if (previous && opening && sessionKey(previous) !== active.current.key) {
        client.sessions.release?.(previous).catch(() => {});
      }

      const goalVersion = callbacks.current.goal;
      client.goal?.read(selected.ref).then(value => {
        if (scope === layer.current && goalVersion === callbacks.current.goal) setGoal(value);
      }).catch(() => {});

      const history = state.history ?? await client.sessions.history(selected.ref, { limit: PAGE_SIZE });
      if (scope === layer.current) readPage(history, runVersion);
    } catch (error) {
      if (scope === layer.current) report(error);
    } finally {
      if (scope === layer.current) setLoading(false);
    }
  }

  async function list(client, showArchived, next) {
    const version = ++callbacks.current.catalog;
    const page = await client.sessions.list({ cursor: next ?? undefined, archived: showArchived });
    if (version !== callbacks.current.catalog || client !== agent.current) return [];
    setSessions(previous => next ? mergeSessions(previous, page.items) : page.items);
    setSessionCursor(page.cursor);
    setArchived(showArchived);
    return page.items;
  }

  useEffect(() => {
    if (!config) return;
    clearTimeline();
    clearError();
    setConnection('connecting');
    setRoute('');
    setSessions([]);
    setSessionCursor(null);
    setArchived(false);
    setModels([]);
    setUsage({});
    let disposed = false;
    const location = config.ssh ? { kind: 'ssh', host: config.ssh } : { kind: 'local' };
    const client = createAgent(config.backend, {
      generation: ++generation.current, cwd: config.cwd, location,
      onEvent: event => { if (!disposed) receive(event); },
    });
    agent.current = client;
    setApi(client);
    async function start() {
      await client.open();
      if (disposed) return;
      client.models?.().then(value => {
        if (!disposed) setModels(value);
      }).catch(() => {});
      try {
        const items = await list(client, false);
        if (disposed) return;
        setConnection('ready');
        if (config.demo && items.length && !active.current && !busy.current) await loadSession(client, items[0]);
      } catch (error) {
        if (!disposed) {
          setConnection('ready');
          report(error);
        }
      }
    }
    start().catch(error => {
      if (disposed) return;
      setConnection('offline');
      report(error);
      client.close();
    });
    return () => {
      disposed = true;
      agent.current = null;
      client.close();
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

  function open(entry) {
    if (!guard() || sessionKey(entry.ref) === active.current?.key) return;
    if (entry.ref.backend !== config.backend || (entry.ref.location.host ?? '') !== config.ssh) {
      report(new Error('请先连接此会话所在的 Agent 和主机。'));
      return;
    }
    return loadSession(agent.current, entry);
  }

  function reset() {
    if (busy.current || currentRun.current || loading) return false;
    const previous = active.current?.ref;
    clearTimeline();
    if (previous) agent.current?.sessions.release?.(previous).catch(() => {});
    if (connection === 'ready') clearError();
    return true;
  }

  async function ensureSession(client, title, scope) {
    if (active.current) return active.current.ref;
    const started = await client.sessions.start({ cwd: config.ssh ? undefined : config.cwd });
    if (scope !== layer.current) return null;
    const entry = { ...started.session, preview: started.session.preview || title };
    active.current = { ref: entry.ref, key: sessionKey(entry.ref) };
    setSession(entry);
    if (!archived) putSession(entry, true);
    return entry.ref;
  }

  async function send(text, selectedOptions, delivery = 'steer') {
    const client = agent.current;
    const steering = currentRun.current;
    if (!client || connection !== 'ready' || loading || busy.current ||
      (steering && !(delivery === 'followUp' ? client.turns.followUp : client.turns.steer))) return false;
    const scope = layer.current;
    clearError();
    busy.current = true;
    const clientId = crypto.randomUUID();
    pendingSend.current = clientId;
    setRun(steering ?? { status: 'running' });
    jumpToLatest.current = true;
    let added = false;
    try {
      const ref = await ensureSession(client, text.slice(0, 48), scope);
      if (!ref) return false;
      const input = [{ kind: 'text', text }];
      updateRows(previous => [...previous, { kind: 'user', text, clientId, key: clientId,
        turnId: steering?.id, optimistic: true, queued: steering && delivery === 'followUp' ? 'queued' : undefined }]);
      added = true;
      if (steering && delivery === 'followUp') {
        await client.turns.followUp(ref, input, clientId);
      } else if (steering) {
        await client.turns.steer(ref, steering.id, input, clientId);
      } else {
        const runVersion = callbacks.current.run;
        const result = await client.turns.start(ref, input, selectedOptions, clientId);
        if (scope === layer.current && runVersion === callbacks.current.run) changeRun(result);
      }
      return scope === layer.current;
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

  async function withSession(action, { create = false, idle = false, title = '' } = {}) {
    const client = agent.current;
    if (!client || connection !== 'ready' || loading || (idle && (currentRun.current || busy.current))) {
      throw new Error('请等当前任务或连接完成。');
    }
    const scope = layer.current;
    if (!active.current && !create) throw new Error('请先打开一个会话。');
    if (!active.current && busy.current) throw new Error('请等当前会话启动完成。');
    if (!active.current) busy.current = true;
    try {
      const ref = create ? await ensureSession(client, title, scope) : active.current.ref;
      if (!ref || scope !== layer.current) return;
      const result = await action(client, ref);
      if (scope === layer.current) return result;
    } finally {
      if (create && scope === layer.current) busy.current = false;
    }
  }

  async function goalAction(action) {
    const version = ++callbacks.current.goal;
    const value = await withSession((client, ref) => action ? client.goal.update(ref, action) : client.goal.read(ref),
      { create: action?.kind === 'set', title: action?.objective?.slice(0, 48) });
    if (version === callbacks.current.goal && value !== undefined) setGoal(value);
    return value;
  }

  async function refreshUsage() {
    const client = agent.current;
    if (!client?.usage) return;
    const value = await client.usage(active.current?.ref);
    if (client === agent.current) setUsage(previous => ({ ...previous, ...value }));
  }

  async function refreshDelegation() {
    if (!active.current || (!agent.current?.delegation?.members && !agent.current?.delegation?.teams)) return;
    await withSession(async (client, ref) => {
      const scope = layer.current;
      const [newMembers, newTeams] = await Promise.all([
        client.delegation.members?.(ref), client.delegation.teams?.(ref),
      ]);
      if (scope !== layer.current) return;
      if (newMembers) setMembers(previous => [...new Map([...newMembers, ...previous].map(member => [member.id, member])).values()]);
      if (newTeams) setTeams(previous => [...new Map([...newTeams, ...previous].map(team => [team.id, team])).values()]);
    });
  }

  async function delegate(action) {
    const member = await withSession((client, ref) => client.delegation.act(ref, action));
    if (member) setMembers(previous => [...previous.filter(entry => entry.id !== member.id), member]);
  }

  async function manageTeam(action) {
    const scope = layer.current;
    const team = await withSession((client, ref) => client.delegation.manageTeam(ref, action));
    if (scope !== layer.current) return;
    if (team) setTeams(previous => [...previous.filter(entry => entry.id !== team.id), team]);
    else if (action.kind === 'close') setTeams(previous => previous.filter(entry => entry.id !== action.teamId));
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
    api, connection, route, sessions, sessionCursor, catalogRevision, archived, session, rows, cursor, loading, run, requests,
    goal, usage, teams, members, models, options, setOptions, loadOlder, open, reset, send, goalAction, refreshUsage, special,
    refreshDelegation, delegate, manageTeam,
    list: (showArchived = archived, more = false) => list(agent.current, showArchived, more ? sessionCursor : null),
    stop: () => withSession((client, ref) => {
      if (currentRun.current) return client.turns.stop(ref, currentRun.current.id);
    }),
    respond: (id, reply) => {
      if (!api || api !== agent.current || sessionKey(session?.ref) !== active.current?.key) {
        throw new Error('此请求已经结束。');
      }
      return api.interactions.respond(id, reply);
    },
    withSession,
    fork() {
      if (!guard() || !session) return;
      return loadSession(agent.current, { ...session, archived: false }, agent.current.sessions.fork(session.ref));
    },
    rename: title => withSession(async (client, ref) => {
      await client.sessions.rename(ref, title);
      setCatalogRevision(value => value + 1);
      if (sessionKey(ref) !== active.current?.key) return;
      setSession(previous => ({ ...previous, title }));
      putSession({ ref, title });
    }),
    archive: () => withSession(async (client, ref) => {
      await client.sessions.archive(ref, !session?.archived);
      setCatalogRevision(value => value + 1);
      if (sessionKey(ref) === active.current?.key) reset();
      await list(client, archived);
    }, { idle: true }),
  };
}
