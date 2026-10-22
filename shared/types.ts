// Tipos compartidos entre el proceso principal (Electron) y la interfaz (React).
// Este archivo no debe importar nada de Node ni del DOM.

export type AgentId = 'claude' | 'opencode';

/** Estado visible de un agente en su panel. */
export type AgentStatus = 'offline' | 'idle' | 'working' | 'done' | 'error';

export type StageId = 'review' | 'develop' | 'test' | 'document' | 'done';

/** Color del foco LED: gris, amarillo, verde, rojo. */
export type LightState = 'pending' | 'active' | 'done' | 'error';

export const STAGES: { id: StageId; label: string }[] = [
  { id: 'review', label: 'REVISANDO' },
  { id: 'develop', label: 'DESARROLLANDO' },
  { id: 'test', label: 'PROBANDO' },
  { id: 'document', label: 'DOCUMENTANDO' },
  { id: 'done', label: 'FINALIZADO' },
];

export type ErrorKind =
  | 'auth'
  | 'rate_limit'
  | 'not_found'
  | 'execution'
  | 'timeout'
  | 'cancelled'
  | 'invalid_output'
  | 'test_failure'
  | 'policy';

export type Level = 'info' | 'success' | 'warn' | 'error';

export interface ActivityLine {
  ts: number;
  level: Level;
  text: string;
}

export interface AgentState {
  id: AgentId;
  name: string;
  role: string;
  executable: string | null;
  version: string | null;
  model: string | null;
  connected: boolean;
  auth: { ok: boolean | null; detail: string };
  status: AgentStatus;
  currentTask: string | null;
  lastAction: string | null;
  lastError: { kind: ErrorKind; message: string; ts: number } | null;
  activity: ActivityLine[];
}

export interface WorkspaceStatus {
  path: string;
  exists: boolean;
  readable: boolean;
  writable: boolean;
  isGitRepo: boolean;
  gitBranch: string | null;
  preexistingChanges: number;
  tools: { name: string; ok: boolean; detail: string }[];
  checkedAt: number;
}

export interface TaskEvent {
  ts: number;
  level: Level;
  stage: StageId | null;
  agent: AgentId | 'orchestrator' | 'tests';
  message: string;
}

export type ChangeKind = 'added' | 'modified' | 'deleted';

export interface ChangedFile {
  path: string;
  kind: ChangeKind;
  /** true si el archivo ya tenía cambios sin commitear del usuario antes de la tarea. */
  preexisting: boolean;
  /** true si cae dentro de las rutas que la tarea podía modificar. */
  inScope: boolean;
}

export interface TestRun {
  attempt: number;
  ts: number;
  status: 'passed' | 'failed' | 'none' | 'error';
  command: string | null;
  exitCode: number | null;
  durationMs: number;
  outputTail: string;
}

export interface QaIssue {
  severity: 'critical' | 'major' | 'minor';
  file?: string;
  description: string;
  suggestion?: string;
}

export interface QaCriterion {
  criterion: string;
  met: boolean;
  evidence: string;
}

export interface QaVerdict {
  verdict: 'approved' | 'rejected';
  summary: string;
  criteria: QaCriterion[];
  issues: QaIssue[];
  suggested_tests: string[];
  documentation: { needs_update: boolean; targets: string[]; notes?: string };
}

export interface QaReport {
  attempt: number;
  ts: number;
  /** Veredicto tal como lo emitió OpenCode. */
  reported: QaVerdict | null;
  /** Veredicto final tras validarlo el orquestador contra las pruebas reales. */
  accepted: boolean;
  orchestratorNotes: string[];
}

export type TaskStatus = 'running' | 'completed' | 'failed' | 'cancelled';

export interface TaskRecord {
  id: string;
  instruction: string;
  createdAt: number;
  updatedAt: number;
  status: TaskStatus;
  responsible: AgentId | 'orchestrator' | null;
  currentStage: StageId | null;
  stages: Record<StageId, LightState>;
  attempts: number;
  maxAttempts: number;
  projectPath: string | null;
  acceptanceCriteria: string[];
  plan: string[];
  events: TaskEvent[];
  changedFiles: ChangedFile[];
  testRuns: TestRun[];
  qaReports: QaReport[];
  violations: string[];
  sessions: { claude: string | null; opencode: string | null };
  backupDir: string | null;
  summary: string | null;
  finalResult: string | null;
}

export interface Settings {
  workspace: string;
  /** Carpetas de trabajo usadas antes (la más reciente primero), para cambiar rápido. */
  recentWorkspaces: string[];
  maxAttempts: number;
  requireTests: boolean;
  claudeModel: string;
  opencodeModel: string;
  /** Rutas (relativas al workspace) donde Claude puede escribir además del proyecto objetivo. */
  extraWritablePaths: string[];
  timeouts: { reviewMin: number; developMin: number; testMin: number; qaMin: number; documentMin: number };
}

export interface AppSnapshot {
  workspace: WorkspaceStatus | null;
  agents: Record<AgentId, AgentState>;
  task: TaskRecord | null;
  settings: Settings;
  busy: boolean;
}

export interface TaskSummaryItem {
  id: string;
  instruction: string;
  status: TaskStatus;
  createdAt: number;
  attempts: number;
  projectPath: string | null;
}

/** API expuesta por el preload en window.dad */
export interface DadApi {
  getSnapshot(): Promise<AppSnapshot>;
  submit(instruction: string): Promise<{ ok: boolean; error?: string; taskId?: string }>;
  cancel(): Promise<{ ok: boolean }>;
  refreshEnvironment(): Promise<AppSnapshot>;
  listHistory(): Promise<TaskSummaryItem[]>;
  getTask(id: string): Promise<TaskRecord | null>;
  updateSettings(patch: Partial<Settings>): Promise<Settings>;
  openPath(target: 'workspace' | 'data' | 'backups'): Promise<void>;
  /** Abre el selector de carpetas nativo; null si el usuario cancela. */
  chooseWorkspace(): Promise<{ ok: boolean; error?: string } | null>;
  /** Cambia a una carpeta de la lista de recientes. */
  setWorkspace(path: string): Promise<{ ok: boolean; error?: string }>;
  onSnapshot(cb: (s: AppSnapshot) => void): () => void;
}
