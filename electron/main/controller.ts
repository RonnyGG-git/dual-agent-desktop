import fs from 'node:fs';
import path from 'node:path';
import type { AgentId, AgentState, AppSnapshot, Level, Settings, WorkspaceStatus } from '../../shared/types';
import type { AgentAdapter } from '../adapters/agent-adapter';
import { ClaudeAdapter } from '../adapters/claude-adapter';
import { OpenCodeAdapter } from '../adapters/opencode-adapter';
import { Orchestrator, type AgentStatusUpdate } from '../orchestrator/orchestrator';
import { WriteLock } from '../security/locks';
import { guardHookPath } from '../security/policy';
import { ConfigStore } from '../services/config';
import { gitInfo } from '../services/git';
import { HistoryStore } from '../services/history';
import { subDir } from '../services/paths';
import { PidRegistry } from '../services/process-runner';
import { runTests } from '../services/test-runner';
import { resolveExecutable } from '../services/executables';

const MAX_ACTIVITY = 60;

/** Estado de la aplicación en el proceso principal; la interfaz solo lo refleja. */
export class AppController {
  readonly config = new ConfigStore();
  readonly history = new HistoryStore();
  readonly orchestrator: Orchestrator;
  private agents: Record<AgentId, AgentState>;
  private workspace: WorkspaceStatus | null = null;
  private listeners = new Set<(s: AppSnapshot) => void>();
  private pending: NodeJS.Timeout | null = null;
  private adapters: Record<AgentId, AgentAdapter>;

  constructor(appRoot: string, nodeRuntime: string) {
    const lock = new WriteLock();
    this.adapters = {
      claude: new ClaudeAdapter({
        guardHook: guardHookPath(appRoot),
        nodeRuntime,
        guardLog: path.join(subDir('logs'), 'guard.log'),
        model: () => this.config.get().claudeModel,
      }),
      opencode: new OpenCodeAdapter({ model: () => this.config.get().opencodeModel }),
    };
    this.agents = {
      claude: blankAgent('claude', 'Claude Code', 'DESARROLLADOR'),
      opencode: blankAgent('opencode', 'OpenCode', 'QA / TESTER'),
    };
    this.orchestrator = new Orchestrator({
      claude: this.adapters.claude,
      opencode: this.adapters.opencode,
      settings: () => this.config.get(),
      save: (t) => this.history.save(t),
      runTests,
      lock,
    });
    this.orchestrator.on('task', () => this.changed());
    this.orchestrator.on('agent', (id: AgentId, u: AgentStatusUpdate) => this.applyAgentUpdate(id, u));
    this.orchestrator.on('activity', (id: AgentId, level: Level, text: string) => {
      const a = this.agents[id];
      a.activity.push({ ts: Date.now(), level, text });
      if (a.activity.length > MAX_ACTIVITY) a.activity.splice(0, a.activity.length - MAX_ACTIVITY);
      this.changed();
    });
  }

  /** Limpieza de arranque: procesos huérfanos de una ejecución anterior y tareas interrumpidas. */
  startup(): void {
    const killed = PidRegistry.cleanupOrphans();
    const recovered = this.history.recoverInterrupted();
    if (killed || recovered) console.log(`[startup] huérfanos eliminados: ${killed}, tareas interrumpidas: ${recovered}`);
  }

  async checkEnvironment(): Promise<AppSnapshot> {
    const s = this.config.get();
    this.workspace = checkWorkspace(s);
    this.changed();
    await Promise.all(
      (['claude', 'opencode'] as AgentId[]).map(async (id) => {
        const a = this.agents[id];
        try {
          const p = await this.adapters[id].detect();
          a.executable = p.executable;
          a.version = p.version;
          a.model = a.model ?? p.model;
          a.auth = p.auth;
          a.connected = Boolean(p.executable && p.version);
          if (!this.orchestrator.busy) a.status = a.connected ? 'idle' : 'offline';
          if (!a.connected) a.lastError = { kind: 'not_found', message: p.auth.detail, ts: Date.now() };
          else if (p.auth.ok === false) a.lastError = { kind: 'auth', message: p.auth.detail, ts: Date.now() };
        } catch (err) {
          a.connected = false;
          a.status = 'offline';
          a.lastError = { kind: 'execution', message: String((err as Error).message), ts: Date.now() };
        }
      }),
    );
    this.workspace.tools = [
      ...this.workspace.tools,
      { name: 'Claude Code', ok: this.agents.claude.connected, detail: this.agents.claude.version ?? this.agents.claude.auth.detail },
      { name: 'OpenCode', ok: this.agents.opencode.connected, detail: this.agents.opencode.version ?? this.agents.opencode.auth.detail },
    ];
    this.changed();
    return this.snapshot();
  }

  submit(instruction: string) {
    const offline = (['claude', 'opencode'] as AgentId[]).filter((id) => !this.agents[id].connected);
    if (offline.length) return { ok: false, error: `Agente(s) no disponible(s): ${offline.join(', ')}. Revisa la instalación.` };
    if (this.agents.claude.auth.ok === false) return { ok: false, error: this.agents.claude.auth.detail };
    for (const a of Object.values(this.agents)) {
      a.activity = [];
      a.lastError = null;
    }
    const r = this.orchestrator.submit(instruction);
    this.changed();
    return r;
  }

  cancel() {
    return { ok: this.orchestrator.cancel() };
  }

  updateSettings(patch: Partial<Settings>): Settings {
    if (this.orchestrator.busy) throw new Error('No se puede cambiar la configuración con una tarea en curso.');
    const s = this.config.update(patch);
    this.changed();
    return s;
  }

  snapshot(): AppSnapshot {
    return {
      workspace: this.workspace,
      agents: structuredClone(this.agents),
      task: this.orchestrator.current ? structuredClone(this.orchestrator.current) : null,
      settings: this.config.get(),
      busy: this.orchestrator.busy,
    };
  }

  subscribe(cb: (s: AppSnapshot) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  shutdown(): void {
    this.orchestrator.cancel();
    PidRegistry.killAll();
  }

  private applyAgentUpdate(id: AgentId, u: AgentStatusUpdate): void {
    const a = this.agents[id];
    if (u.status !== undefined) a.status = u.status;
    if (u.currentTask !== undefined) a.currentTask = u.currentTask;
    if (u.lastAction !== undefined) a.lastAction = u.lastAction;
    if (u.model) a.model = u.model;
    if (u.error !== undefined) a.lastError = u.error ? { ...u.error, ts: Date.now() } : null;
    this.changed();
  }

  /** Agrupa cambios rápidos (streaming) en una sola notificación cada ~80 ms. */
  private changed(): void {
    if (this.pending) return;
    this.pending = setTimeout(() => {
      this.pending = null;
      const snap = this.snapshot();
      for (const l of this.listeners) l(snap);
    }, 80);
  }
}

function blankAgent(id: AgentId, name: string, role: string): AgentState {
  return {
    id,
    name,
    role,
    executable: null,
    version: null,
    model: null,
    connected: false,
    auth: { ok: null, detail: 'Comprobando…' },
    status: 'offline',
    currentTask: null,
    lastAction: null,
    lastError: null,
    activity: [],
  };
}

export function checkWorkspace(s: Settings): WorkspaceStatus {
  const p = s.workspace;
  const exists = fs.existsSync(p) && fs.statSync(p).isDirectory();
  let readable = false;
  let writable = false;
  if (exists) {
    try {
      fs.accessSync(p, fs.constants.R_OK);
      readable = true;
    } catch {}
    try {
      fs.accessSync(p, fs.constants.W_OK);
      writable = true;
    } catch {}
  }
  const g = exists ? gitInfo(p) : { isRepo: false, branch: null, dirtyCount: 0 };
  const tools = [
    { name: 'Git', ok: Boolean(resolveExecutable('git')), detail: resolveExecutable('git') ?? 'no encontrado' },
    { name: 'Node.js', ok: Boolean(resolveExecutable('node')), detail: resolveExecutable('node') ?? 'no encontrado (opcional)' },
  ];
  return { path: p, exists, readable, writable, isGitRepo: g.isRepo, gitBranch: g.branch, preexistingChanges: g.dirtyCount, tools, checkedAt: Date.now() };
}
