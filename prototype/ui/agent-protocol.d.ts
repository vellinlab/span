/** Span's renderer protocol. Adapters own transport, storage and vendor-specific payloads. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type AgentLocation = { kind: 'local' } | { kind: 'ssh'; host: string };
export type SessionRef = { backend: string; location: AgentLocation; id: string };
export type Page<T> = { items: T[]; cursor: string | null };
export type Session = {
  ref: SessionRef; title?: string; preview?: string; cwd?: string; branch?: string;
  parent?: SessionRef; updatedAt?: number; archived?: boolean;
};
export type RunStatus = 'running' | 'completed' | 'failed' | 'cancelled';
export type Run = { id: string; status: RunStatus; error?: string };
export type Choice = { id: string; label: string; description?: string };
export type Input =
  | { kind: 'text'; text: string }
  | { kind: 'image'; url?: string; path?: string }
  | { kind: 'file' | 'skill' | 'mention'; path: string; name: string };
export type Artifact = {
  id: string; name: string; path?: string; url?: string; mime?: string;
  kind: 'file' | 'image' | 'link' | 'diff';
};
export type Model = Choice & {
  isDefault?: boolean; inputs: Input['kind'][]; efforts: Choice[]; defaultEffort?: string;
  tiers: Choice[]; defaultTier?: string;
};
export type RunOptions = { model?: string; effort?: string; tier?: string; mode?: string; permissions?: string };
export type Turn = { id: string; run: Run; rows: TimelineItem[] };
export type OpenSession = { session: Session; options?: RunOptions; history?: Page<Turn> };
export type Goal = {
  objective: string; status: 'active' | 'paused' | 'complete' | 'blocked' | 'limited' | 'unknown';
  budget?: number; tokens?: number; seconds?: number;
};
export type GoalAction =
  | { kind: 'set'; objective: string; budget?: number }
  | { kind: 'pause' | 'resume' | 'clear' };
export type Usage = {
  tokens?: { total?: number; input?: number; output?: number; cached?: number; reasoning?: number;
    contextUsed?: number; contextLimit?: number };
  limits?: { id: string; label: string; used: number; windowMinutes?: number; resetsAt?: number }[];
  cost?: { amount: number; currency: string };
};
export type Checkpoint = { id: string; label: string; turnId?: string; createdAt?: number };
export type AgentStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown';
export type AgentMember = {
  id: string; name?: string; role?: string; status?: AgentStatus; detail?: string;
  session?: SessionRef; parent?: SessionRef; teamId?: string; model?: string;
};
export type TeamTask = {
  id: string; title: string; detail?: string; status: AgentStatus; assigneeId?: string; blockedBy?: string[];
};
export type Team = { id: string; name: string; members: AgentMember[]; tasks?: TeamTask[] };
export type TeamAction =
  | { kind: 'create'; name: string }
  | { kind: 'assign'; teamId: string; taskId: string; memberId: string }
  | { kind: 'completeTask'; teamId: string; taskId: string }
  | { kind: 'close'; teamId: string };
export type DelegationAction =
  | { kind: 'start'; prompt: string; agent?: string; teamId?: string }
  | { kind: 'message'; memberId: string; text: string }
  | { kind: 'cancel'; memberId: string };
export type PlanStep = { text: string; status: 'pending' | 'running' | 'completed' };
type ItemBase = { id: string; turnId: string; status?: AgentStatus; depth?: number; actor?: AgentMember };
export type TimelineItem = ItemBase & (
  | { kind: 'user'; clientId?: string; text: string; attachments?: Artifact[] }
  | { kind: 'message'; text: string; phase?: 'commentary' | 'partial' | 'final' }
  | { kind: 'reasoning'; sections: string[] }
  | { kind: 'plan'; text?: string; steps?: PlanStep[] }
  | { kind: 'command'; command?: string; cwd?: string; text?: string; exitCode?: number }
  | { kind: 'patch'; files: { path: string; action?: string; diff?: string }[]; text?: string }
  | { kind: 'tool'; name: string; source?: string; text?: string }
  | { kind: 'delegation'; action: string; members: AgentMember[]; text?: string }
  | { kind: 'search'; query: string; url?: string; text?: string }
  | { kind: 'artifact'; artifacts: Artifact[]; text?: string }
  | { kind: 'notice'; title: string; text?: string }
);
export type ItemDelta = { id: string; turnId: string } & (
  | { kind: 'reasoning'; section: number; text: string }
  | { kind: 'message' | 'plan' | 'command' | 'patch'; text: string }
);
export type InteractionField = {
  id: string; label: string; description?: string; secret?: boolean;
  options?: Choice[]; allowOther?: boolean; required?: boolean;
};
export type Interaction = { id: string; title: string; detail?: string } & (
  | { kind: 'approval'; choices: Choice[] }
  | { kind: 'input'; fields: InteractionField[] }
);
export type InteractionReply = { choice: string } | { values: Record<string, string> };
export type ExtensionKind = 'tool' | 'mcp' | 'skill' | 'plugin' | 'connector';
export type Extension = Choice & {
  kind: ExtensionKind; status?: string; enabled?: boolean; source?: string;
};
export type ExtensionAction = 'enable' | 'disable' | 'install' | 'uninstall' | 'authorize' | 'refresh';
export type Event =
  | { kind: 'connection'; route: 'shared' | 'stdio' | 'fixture' | 'remote' }
  | { kind: 'disconnected'; error?: string }
  | { kind: 'quota'; limits: NonNullable<Usage['limits']> }
  | ({ session: SessionRef } & (
      | { kind: 'item'; item: TimelineItem; final: boolean }
      | { kind: 'delta'; delta: ItemDelta }
      | { kind: 'run'; run: Run }
      | { kind: 'goal'; goal: Goal | null }
      | { kind: 'usage'; usage: Usage }
      | { kind: 'interaction'; request: Interaction }
      | { kind: 'interactionResolved'; id: string }
      | { kind: 'session'; info: Partial<Session> }
      | { kind: 'team'; team: Team }
      | { kind: 'member'; member: AgentMember }
      | { kind: 'queuedInput'; clientId: string; delivery: 'steer' | 'followUp'; state: 'queued' | 'delivered' | 'cancelled' }
      | { kind: 'extension'; name: `${string}:${string}`; data: Json }
    ));
export type AdapterContext = {
  generation: number; cwd: string; location: AgentLocation;
  onEvent(event: Event): void;
};
export type AdapterDefinition = {
  id: string; label: string; locations: AgentLocation['kind'][];
  create(context: AdapterContext): AgentAdapter;
};

/** Only advertised operations are exposed by the UI. Cursors and IDs are opaque. */
export interface AgentAdapter {
  open(): Promise<void>;
  close(): void;
  sessions: {
    list(options: { cursor?: string; archived?: boolean }): Promise<Page<Session>>;
    search?(options: { query: string; cursor?: string; archived?: boolean }): Promise<Page<Session>>;
    start(options: { cwd?: string }): Promise<OpenSession>;
    resume(ref: SessionRef, limit: number): Promise<OpenSession>;
    history(ref: SessionRef, options: { cursor?: string; limit: number }): Promise<Page<Turn>>;
    release?(ref: SessionRef): Promise<void>;
    fork?(ref: SessionRef, from?: { turnId?: string; checkpointId?: string }): Promise<OpenSession>;
    checkpoints?(ref: SessionRef): Promise<Checkpoint[]>;
    rewind?(ref: SessionRef, checkpointId: string, mode: 'messages' | 'files' | 'both'): Promise<OpenSession>;
    rename?(ref: SessionRef, title: string): Promise<void>;
    archive?(ref: SessionRef, archived: boolean): Promise<void>;
  };
  turns: {
    start(ref: SessionRef, input: Input[], options: RunOptions, clientId: string): Promise<Run>;
    stop?(ref: SessionRef, runId: string): Promise<void>;
    steer?(ref: SessionRef, runId: string, input: Input[], clientId: string): Promise<void>;
    followUp?(ref: SessionRef, input: Input[], clientId: string): Promise<void>;
    compact?(ref: SessionRef): Promise<void>;
    review?(ref: SessionRef, target: { kind: 'worktree' } | { kind: 'branch' | 'commit' | 'custom'; value: string }): Promise<Run>;
  };
  models?(): Promise<Model[]>;
  modes?: Choice[];
  permissions?: Choice[];
  goal?: {
    read(ref: SessionRef): Promise<Goal | null>;
    update(ref: SessionRef, action: GoalAction): Promise<Goal | null>;
  };
  usage?(ref?: SessionRef): Promise<Usage>;
  interactions?: { respond(id: string, reply: InteractionReply): Promise<void> };
  delegation?: {
    observe: boolean;
    actions?: DelegationAction['kind'][];
    teamActions?: TeamAction['kind'][];
    members?(ref: SessionRef): Promise<AgentMember[]>;
    teams?(ref: SessionRef): Promise<Team[]>;
    act?(ref: SessionRef, action: DelegationAction): Promise<AgentMember | void>;
    manageTeam?(ref: SessionRef, action: TeamAction): Promise<Team | void>;
  };
  extensions?: {
    kinds: ExtensionKind[];
    list(kind: ExtensionKind, ref: SessionRef): Promise<Extension[]>;
    act?(kind: ExtensionKind, ref: SessionRef, id: string, action: ExtensionAction): Promise<void>;
  };
  artifacts?: {
    list?(ref: SessionRef, cursor?: string): Promise<Page<Artifact>>;
    read?(ref: SessionRef, artifact: Artifact): Promise<{ mime: string; text?: string; base64?: string }>;
  };
  commands?: Choice[];
  execute?(name: `${string}:${string}`, ref: SessionRef | null, argument: string): Promise<{ title: string; text: string }>;
}

declare global {
  interface Window {
    span: {
      request(method: string, params?: Record<string, unknown>): Promise<any>;
      workspace(choose?: boolean): Promise<any>;
      openLink(url: string): Promise<void>;
      onEvent(listener: (packet: { event: string; generation: number; data: any }) => void): () => void;
    };
  }
}
