import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  DevelopOutputSchema,
  DocReviewSchema,
  DocumentOutputSchema,
  QaVerdictSchema,
  ReviewOutputSchema,
  toJsonSchema,
  type DevelopOutput,
} from '../../shared/schemas';
import type {
  AgentId,
  AgentStatus,
  ChangedFile,
  ErrorKind,
  Level,
  QaReport,
  QaVerdict,
  Settings,
  StageId,
  TaskRecord,
  TestRun,
} from '../../shared/types';
import type { AgentActivity, AgentAdapter, AgentRunResult } from '../adapters/agent-adapter';
import { truncate } from '../adapters/agent-adapter';
import type { WriteLock } from '../security/locks';
import { DENY_COMMANDS, writePolicy, type PolicyMode } from '../security/policy';
import { diffSnapshots, mergeChanges, takeSnapshot, type Snapshot } from '../services/git';
import { isInside, subDir } from '../services/paths';
import * as prompts from './prompts';

export interface OrchestratorDeps {
  claude: AgentAdapter;
  opencode: AgentAdapter;
  settings: () => Settings;
  save: (t: TaskRecord) => void;
  runTests: (projectAbs: string, attempt: number, timeoutMs: number, signal: AbortSignal, onLine: (l: string) => void) => Promise<TestRun>;
  lock: Pick<WriteLock, 'acquire' | 'release'> & { file: string };
}

export interface AgentStatusUpdate {
  status?: AgentStatus;
  currentTask?: string | null;
  lastAction?: string | null;
  model?: string | null;
  error?: { kind: ErrorKind; message: string } | null;
}

/** Error que detiene la tarea (lo produce el orquestador, no un agente). */
export class StageError extends Error {
  constructor(public kind: ErrorKind, message: string, public agent: AgentId | 'orchestrator' | 'tests' = 'orchestrator') {
    super(message);
  }
}

const MAX_EVENTS = 3000;

/**
 * Coordina el ciclo REVISAR → DESARROLLAR → PROBAR (pruebas + QA) → DOCUMENTAR → FINALIZAR.
 * Es la única pieza que cambia el estado global; los agentes solo producen
 * mensajes estructurados que aquí se validan.
 *
 * Eventos: 'task' (TaskRecord), 'agent' (id, AgentStatusUpdate), 'activity' (id, level, text).
 */
export class Orchestrator extends EventEmitter {
  private task: TaskRecord | null = null;
  private abort: AbortController | null = null;
  private running: Promise<void> | null = null;

  constructor(private deps: OrchestratorDeps) {
    super();
  }

  get current(): TaskRecord | null {
    return this.task;
  }

  get busy(): boolean {
    return this.running !== null;
  }

  submit(instruction: string): { ok: boolean; error?: string; taskId?: string } {
    const text = instruction.trim();
    if (!text) return { ok: false, error: 'La instrucción está vacía.' };
    if (text.length > 20_000) return { ok: false, error: 'La instrucción es demasiado larga (máx. 20 000 caracteres).' };
    if (this.running) return { ok: false, error: 'Ya hay una tarea en curso. Cancélala o espera a que termine.' };
    const s = this.deps.settings();
    if (!fs.existsSync(s.workspace)) return { ok: false, error: `No existe el directorio de trabajo ${s.workspace}.` };

    const now = Date.now();
    const id = `${new Date(now).toISOString().slice(0, 10).replace(/-/g, '')}-${randomUUID().slice(0, 8)}`;
    this.task = {
      id,
      instruction: text,
      createdAt: now,
      updatedAt: now,
      status: 'running',
      responsible: 'orchestrator',
      currentStage: null,
      stages: { review: 'pending', develop: 'pending', test: 'pending', document: 'pending', done: 'pending' },
      attempts: 0,
      maxAttempts: s.maxAttempts,
      projectPath: null,
      acceptanceCriteria: [],
      plan: [],
      events: [],
      changedFiles: [],
      testRuns: [],
      qaReports: [],
      violations: [],
      sessions: { claude: null, opencode: null },
      backupDir: path.join(subDir('backups'), id),
      summary: null,
      finalResult: null,
    };
    this.log('info', null, 'orchestrator', `Tarea ${id} registrada.`);
    for (const a of ['claude', 'opencode'] as AgentId[]) this.agent(a, { status: 'idle', currentTask: null, lastAction: null, error: null });
    this.abort = new AbortController();
    this.running = this.execute(this.task, this.abort.signal).finally(() => {
      this.running = null;
      this.abort = null;
    });
    return { ok: true, taskId: id };
  }

  cancel(): boolean {
    if (!this.abort) return false;
    this.log('warn', this.task?.currentStage ?? null, 'orchestrator', 'Cancelación solicitada por el usuario.');
    this.abort.abort();
    return true;
  }

  /** Para pruebas: espera a que termine la tarea en curso. */
  async idle(): Promise<void> {
    await this.running;
  }

  // ─────────────────────────────────────────── flujo principal

  private async execute(task: TaskRecord, signal: AbortSignal): Promise<void> {
    const s = this.deps.settings();
    const ws = s.workspace;
    let baseline: Snapshot | null = null;
    try {
      // 1. REVISAR
      this.setStage('review', 'active', 'claude');
      const review = await this.stageReview(task, ws, s, signal);
      task.projectPath = review.project_path;
      task.acceptanceCriteria = review.acceptance_criteria;
      task.plan = review.plan;
      this.log('success', 'review', 'claude', `Proyecto identificado: ${review.project_path}${review.project_exists ? '' : ' (nuevo)'} · ${review.acceptance_criteria.length} criterios de aceptación.`);
      this.setStage('review', 'done');
      this.agent('claude', { status: 'done', currentTask: null });

      const roots = this.writableRoots(task, s);
      baseline = takeSnapshot(ws, roots.map((r) => path.relative(ws, r) || '.'));
      if (baseline.dirty.size) {
        this.log('info', null, 'orchestrator', `Se registraron ${baseline.dirty.size} archivos con cambios previos del usuario (se distinguirán de los de la tarea).`);
      }

      // 2-3. DESARROLLAR → PROBAR (con reintentos)
      let accepted: QaReport | null = null;
      let devOut: DevelopOutput | null = null;
      while (!accepted) {
        task.attempts++;
        this.setStage('develop', 'active', 'claude');
        if (task.attempts > 1) this.log('warn', 'develop', 'orchestrator', `Reporte de errores entregado a Claude. Corrección ${task.attempts - 1} (intento ${task.attempts}/${task.maxAttempts}).`);
        devOut = await this.stageDevelop(task, ws, s, roots, baseline, signal);
        this.setStage('develop', 'done');

        this.setStage('test', 'active', 'orchestrator');
        const test = await this.stageTests(task, ws, s, signal);
        const report = await this.stageQa(task, ws, s, devOut, test, signal);
        if (report.accepted) {
          accepted = report;
          this.setStage('test', 'done');
          this.log('success', 'test', 'orchestrator', 'Pruebas y QA aprobados.');
        } else {
          this.setStage('test', 'error');
          if (task.attempts >= task.maxAttempts) {
            throw new StageError('test_failure', `Se alcanzó el máximo de ${task.maxAttempts} intentos sin aprobación de QA.`);
          }
          this.log('error', 'test', 'orchestrator', `Rechazado: ${report.orchestratorNotes.concat(report.reported?.summary ?? []).join(' · ') || 'ver reporte'}. Vuelve a desarrollo.`);
        }
      }

      // 4. DOCUMENTAR
      this.setStage('document', 'active', 'claude');
      await this.stageDocument(task, ws, s, roots, baseline, accepted, signal);
      this.setStage('document', 'done');

      // 5. FINALIZAR — solo con criterios cumplidos, pruebas obligatorias en verde y QA aprobado.
      this.finalCheck(task, accepted, s);
      task.status = 'completed';
      task.responsible = null;
      task.finalResult = 'Tarea completada y aprobada por QA.';
      this.setStage('done', 'done', null);
      task.summary = this.buildSummary(task);
      this.writeReport(task);
      this.log('success', 'done', 'orchestrator', 'FINALIZADO: criterios cumplidos, pruebas en verde y QA aprobado.');
      this.agent('claude', { status: 'done', currentTask: null });
      this.agent('opencode', { status: 'done', currentTask: null });
    } catch (err) {
      const e = err instanceof StageError ? err : new StageError('execution', (err as Error)?.message ?? String(err));
      const stage = task.currentStage;
      if (signal.aborted || e.kind === 'cancelled') {
        task.status = 'cancelled';
        task.finalResult = 'Cancelada por el usuario.';
        if (stage && task.stages[stage] === 'active') this.setStage(stage, 'pending');
        for (const a of ['claude', 'opencode'] as AgentId[]) this.agent(a, { status: 'idle', currentTask: null });
        this.log('warn', stage, 'orchestrator', 'Tarea cancelada. Procesos de los agentes detenidos.');
      } else {
        task.status = 'failed';
        task.finalResult = e.message;
        if (stage && task.stages[stage] === 'active') this.setStage(stage, 'error');
        task.stages.done = 'error';
        if (e.agent === 'claude' || e.agent === 'opencode') this.agent(e.agent, { status: 'error', currentTask: null, error: { kind: e.kind, message: e.message } });
        this.log('error', stage, e.agent, `Tarea detenida (${e.kind}): ${e.message}`);
      }
      task.responsible = null;
      task.summary = this.buildSummary(task);
      this.writeReport(task);
    } finally {
      this.deps.lock.release(task.id);
      task.updatedAt = Date.now();
      this.persist();
    }
  }

  // ─────────────────────────────────────────── etapas

  private async stageReview(task: TaskRecord, ws: string, s: Settings, signal: AbortSignal) {
    this.agent('claude', { status: 'working', currentTask: 'Revisando el proyecto (solo lectura)' });
    const policyFile = this.policy(task, ws, 'readonly', []);
    const res = await this.callAgent('claude', 'review', {
      taskId: task.id,
      prompt: prompts.reviewPrompt(task.instruction, ws),
      cwd: ws,
      mode: 'readonly',
      jsonSchema: toJsonSchema(ReviewOutputSchema),
      policyFile,
      timeoutMs: s.timeouts.reviewMin * 60_000,
      signal,
    });
    task.sessions.claude = res.sessionId ?? task.sessions.claude;
    const parsed = ReviewOutputSchema.safeParse(res.structured);
    if (!parsed.success) throw new StageError('invalid_output', `La revisión de Claude no cumple el esquema: ${parsed.error.issues[0]?.message}`, 'claude');
    const review = parsed.data;
    review.project_path = review.project_path.replace(/\\/g, '/').replace(/^\.\/(?=.)/, '').replace(/\/$/, '') || '.';
    const abs = path.resolve(ws, review.project_path);
    if (!isInside(ws, abs)) throw new StageError('policy', `La ruta de proyecto "${review.project_path}" está fuera del directorio de trabajo.`, 'claude');
    if (/(^|\/)\.(git|obsidian)(\/|$)/i.test(review.project_path)) throw new StageError('policy', 'La ruta de proyecto no puede estar dentro de .git ni .obsidian.', 'claude');
    if (review.project_exists && !fs.existsSync(abs)) throw new StageError('invalid_output', `Claude indicó un proyecto existente que no existe: ${review.project_path}`, 'claude');
    if (!review.project_exists && fs.existsSync(abs) && fs.statSync(abs).isFile()) throw new StageError('policy', `La ruta propuesta para el proyecto nuevo es un archivo existente: ${review.project_path}`, 'claude');
    if (review.project_path === '.') this.log('warn', 'review', 'orchestrator', 'El alcance es la raíz completa del workspace: Claude podrá escribir en cualquier ruta del vault (excepto .git y .obsidian).');
    return review;
  }

  private async stageDevelop(task: TaskRecord, ws: string, s: Settings, roots: string[], baseline: Snapshot, signal: AbortSignal): Promise<DevelopOutput> {
    if (!this.deps.lock.acquire(task.id, 'claude')) throw new StageError('policy', 'El workspace está bloqueado por otra tarea.');
    this.agent('claude', { status: 'working', currentTask: task.attempts > 1 ? `Corrigiendo (intento ${task.attempts}/${task.maxAttempts})` : 'Desarrollando' });
    this.agent('opencode', { status: 'idle', currentTask: 'Esperando a que Claude termine' });
    const relRoots = roots.map((r) => path.relative(ws, r) || '.');
    const before = takeSnapshot(ws, relRoots);
    try {
      const res = await this.callAgent('claude', 'develop', {
        taskId: task.id,
        prompt: prompts.developPrompt({
          instruction: task.instruction,
          projectPath: task.projectPath!,
          criteria: task.acceptanceCriteria,
          plan: task.plan,
          attempt: task.attempts,
          maxAttempts: task.maxAttempts,
          lastReport: task.qaReports.at(-1) ?? null,
          lastTest: task.testRuns.at(-1) ?? null,
        }),
        cwd: ws,
        mode: 'write',
        jsonSchema: toJsonSchema(DevelopOutputSchema),
        resumeSessionId: task.sessions.claude,
        policyFile: this.policy(task, ws, 'write', roots),
        timeoutMs: s.timeouts.developMin * 60_000,
        signal,
      });
      task.sessions.claude = res.sessionId ?? task.sessions.claude;
      this.recordChanges(task, ws, before, relRoots, baseline, 'develop');
      const parsed = DevelopOutputSchema.safeParse(res.structured);
      if (!parsed.success) throw new StageError('invalid_output', 'El resultado de desarrollo de Claude no cumple el esquema.', 'claude');
      this.log('success', 'develop', 'claude', `Desarrollo terminado: ${truncate(parsed.data.summary, 200)}`);
      this.agent('claude', { status: 'done', currentTask: 'Esperando revisión de QA' });
      return parsed.data;
    } finally {
      this.deps.lock.release(task.id);
    }
  }

  private async stageTests(task: TaskRecord, ws: string, s: Settings, signal: AbortSignal): Promise<TestRun> {
    const projectAbs = path.resolve(ws, task.projectPath!);
    this.log('info', 'test', 'tests', 'Ejecutando pruebas automáticas del proyecto…');
    const run = await this.deps.runTests(projectAbs, task.attempts, s.timeouts.testMin * 60_000, signal, () => {});
    if (signal.aborted) throw new StageError('cancelled', 'Cancelada.');
    task.testRuns.push(run);
    const lvl: Level = run.status === 'passed' ? 'success' : run.status === 'none' ? 'warn' : 'error';
    const msg =
      run.status === 'none'
        ? 'No se detectó suite de pruebas automatizadas en el proyecto.'
        : `Pruebas (${run.command}): ${run.status === 'passed' ? 'PASARON' : run.status === 'failed' ? 'FALLARON' : 'ERROR al ejecutar'} · código ${run.exitCode ?? '-'} · ${Math.round(run.durationMs / 1000)} s`;
    this.log(lvl, 'test', 'tests', msg);
    this.persist();
    return run;
  }

  private async stageQa(task: TaskRecord, ws: string, s: Settings, dev: DevelopOutput, test: TestRun, signal: AbortSignal): Promise<QaReport> {
    task.responsible = 'opencode';
    this.agent('opencode', { status: 'working', currentTask: `Revisando código y resultados (revisión ${task.attempts})` });
    const base = {
      taskId: task.id,
      cwd: ws,
      mode: 'readonly' as PolicyMode,
      timeoutMs: s.timeouts.qaMin * 60_000,
      signal,
    };
    let res = await this.callAgent('opencode', 'test', {
      ...base,
      prompt: prompts.qaPrompt({
        instruction: task.instruction,
        projectPath: task.projectPath!,
        criteria: task.acceptanceCriteria,
        devSummary: dev.summary,
        changed: task.changedFiles,
        test,
        attempt: task.attempts,
        requireTests: s.requireTests,
      }),
      resumeSessionId: task.sessions.opencode,
    });
    task.sessions.opencode = res.sessionId ?? task.sessions.opencode;
    let parsed = QaVerdictSchema.safeParse(res.structured);
    if (!parsed.success && res.sessionId) {
      this.log('warn', 'test', 'orchestrator', 'El veredicto de QA no tenía JSON válido: se le pide de nuevo.');
      res = await this.callAgent('opencode', 'test', { ...base, prompt: prompts.QA_JSON_RETRY, resumeSessionId: res.sessionId });
      parsed = QaVerdictSchema.safeParse(res.structured);
    }
    if (!parsed.success) throw new StageError('invalid_output', 'OpenCode no emitió un veredicto estructurado válido.', 'opencode');

    const report = validateVerdict(parsed.data as QaVerdict, test, task.acceptanceCriteria, s.requireTests, task.attempts);
    task.qaReports.push(report);
    const v = report.reported!;
    this.log(
      report.accepted ? 'success' : 'error',
      'test',
      'opencode',
      `Veredicto QA: ${v.verdict === 'approved' ? 'APROBADO' : 'RECHAZADO'} · ${v.criteria.filter((c) => c.met).length}/${v.criteria.length} criterios · ${v.issues.length} problemas`,
    );
    for (const n of report.orchestratorNotes) this.log('warn', 'test', 'orchestrator', n);
    this.agent('opencode', { status: report.accepted ? 'done' : 'error', currentTask: null, error: report.accepted ? null : { kind: 'test_failure', message: truncate(v.summary, 200) } });
    this.persist();
    return report;
  }

  private async stageDocument(task: TaskRecord, ws: string, s: Settings, roots: string[], baseline: Snapshot, accepted: QaReport, signal: AbortSignal): Promise<void> {
    const v = accepted.reported!;
    if (!v.documentation.needs_update) {
      this.log('info', 'document', 'opencode', 'QA indicó que no es necesario actualizar la documentación.');
      return;
    }
    const verified = v.criteria.filter((c) => c.met).map((c) => c.criterion);
    const relRoots = roots.map((r) => path.relative(ws, r) || '.');
    let previousIssues: string[] = [];
    for (let docAttempt = 1; docAttempt <= 2; docAttempt++) {
      if (!this.deps.lock.acquire(task.id, 'claude')) throw new StageError('policy', 'El workspace está bloqueado por otra tarea.');
      this.agent('claude', { status: 'working', currentTask: 'Actualizando documentación' });
      const before = takeSnapshot(ws, relRoots);
      let docChanges: ChangedFile[];
      try {
        const res = await this.callAgent('claude', 'document', {
          taskId: task.id,
          prompt: prompts.documentPrompt({
            instruction: task.instruction,
            projectPath: task.projectPath!,
            verified,
            changed: task.changedFiles,
            targets: v.documentation.targets,
            notes: v.documentation.notes,
            previousIssues,
          }),
          cwd: ws,
          mode: 'docs',
          jsonSchema: toJsonSchema(DocumentOutputSchema),
          resumeSessionId: task.sessions.claude,
          policyFile: this.policy(task, ws, 'docs', roots),
          timeoutMs: s.timeouts.documentMin * 60_000,
          signal,
        });
        task.sessions.claude = res.sessionId ?? task.sessions.claude;
        docChanges = this.recordChanges(task, ws, before, relRoots, baseline, 'document');
        const out = DocumentOutputSchema.safeParse(res.structured);
        if (out.success && out.data.skipped_reason) this.log('info', 'document', 'claude', `Sin cambios de documentación: ${out.data.skipped_reason}`);
      } finally {
        this.deps.lock.release(task.id);
      }
      this.agent('claude', { status: 'done', currentTask: null });
      const docFiles = docChanges.filter((c) => c.kind !== 'deleted' && c.inScope);
      if (!docFiles.length) return;

      this.agent('opencode', { status: 'working', currentTask: 'Validando la documentación' });
      const res = await this.callAgent('opencode', 'document', {
        taskId: task.id,
        prompt: prompts.docReviewPrompt({ verified, docFiles }),
        cwd: ws,
        mode: 'readonly',
        resumeSessionId: task.sessions.opencode,
        timeoutMs: s.timeouts.qaMin * 60_000,
        signal,
      });
      const review = DocReviewSchema.safeParse(res.structured);
      if (!review.success) throw new StageError('invalid_output', 'OpenCode no emitió un veredicto válido sobre la documentación.', 'opencode');
      if (review.data.verdict === 'approved') {
        this.agent('opencode', { status: 'done', currentTask: null });
        this.log('success', 'document', 'opencode', `Documentación aprobada: ${truncate(review.data.summary, 160)}`);
        return;
      }
      previousIssues = review.data.issues.length ? review.data.issues : [review.data.summary];
      this.setStage('document', 'error');
      this.log('error', 'document', 'opencode', `Documentación rechazada: ${truncate(previousIssues.join(' · '), 240)}`);
      if (docAttempt === 2) throw new StageError('test_failure', 'La documentación fue rechazada dos veces por QA.', 'opencode');
      this.setStage('document', 'active', 'claude');
    }
  }

  private finalCheck(task: TaskRecord, accepted: QaReport, s: Settings): void {
    const lastTest = task.testRuns.at(-1);
    const testsOk = lastTest?.status === 'passed' || (lastTest?.status === 'none' && !s.requireTests);
    const criteriaOk = (accepted.reported?.criteria ?? []).every((c) => c.met);
    if (!accepted.accepted || !testsOk || !criteriaOk) {
      throw new StageError('test_failure', 'No se cumplen las condiciones para finalizar (criterios, pruebas y aprobación de QA).');
    }
    if (task.violations.length) {
      throw new StageError('policy', `Se registraron violaciones de seguridad: ${task.violations.join(' · ')}`);
    }
  }

  // ─────────────────────────────────────────── utilidades

  private writableRoots(task: TaskRecord, s: Settings): string[] {
    const ws = s.workspace;
    const roots = [path.resolve(ws, task.projectPath!)];
    for (const extra of s.extraWritablePaths) {
      const abs = path.resolve(ws, extra);
      if (isInside(ws, abs) && !roots.some((r) => isInside(r, abs))) roots.push(abs);
    }
    return roots;
  }

  private policy(task: TaskRecord, ws: string, mode: PolicyMode, roots: string[]): string {
    return writePolicy({
      taskId: task.id,
      workspace: ws,
      mode,
      writableRoots: mode === 'readonly' ? [] : roots,
      backupDir: task.backupDir!,
      lockFile: this.deps.lock.file,
      denyCommands: DENY_COMMANDS,
    });
  }

  /** Calcula los cambios de una etapa, los acumula y registra violaciones (borrados de archivos previos, cambios fuera de alcance). */
  private recordChanges(task: TaskRecord, ws: string, before: Snapshot, relRoots: string[], baseline: Snapshot, stage: StageId): ChangedFile[] {
    const after = takeSnapshot(ws, relRoots);
    const changes = diffSnapshots(ws, before, after, relRoots, baseline);
    task.changedFiles = mergeChanges(task.changedFiles, changes);
    for (const c of changes) {
      if (c.kind === 'deleted' && baseline.files.has(c.path)) {
        const msg = `Se eliminó un archivo que existía antes de la tarea: ${c.path}`;
        task.violations.push(msg);
        this.log('error', stage, 'orchestrator', `${msg}. Copias de seguridad en ${task.backupDir}`);
      } else if (!c.inScope) {
        this.log('warn', stage, 'orchestrator', `Cambio fuera del alcance de la tarea (posiblemente externo): ${c.path}`);
      }
    }
    if (changes.length) this.log('info', stage, 'orchestrator', `Archivos cambiados en esta etapa: ${changes.map((c) => `${c.kind === 'added' ? '+' : c.kind === 'deleted' ? '−' : '~'}${c.path}`).join(', ')}`);
    if (task.violations.length) throw new StageError('policy', task.violations.at(-1)!);
    this.persist();
    return changes;
  }

  private async callAgent(id: AgentId, stage: StageId, req: Parameters<AgentAdapter['run']>[0]): Promise<AgentRunResult> {
    const adapter = id === 'claude' ? this.deps.claude : this.deps.opencode;
    if (this.task) this.task.responsible = id;
    const res = await adapter.run(req, (a: AgentActivity) => {
      this.emit('activity', id, a.level, a.text);
      if (a.action) this.agent(id, { lastAction: a.action });
      if (a.model) this.agent(id, { model: a.model });
      if (a.level !== 'info' || a.action) this.log(a.level, stage, id, a.text, false);
    });
    if (res.model) this.agent(id, { model: res.model });
    for (const d of res.permissionDenials) this.log('warn', stage, id, `Permiso denegado por la CLI: ${d}`);
    if (!res.ok) {
      if (res.errorKind === 'cancelled' || req.signal.aborted) throw new StageError('cancelled', 'Cancelada.', id);
      throw new StageError(res.errorKind ?? 'execution', res.errorMessage ?? 'Error desconocido.', id);
    }
    return res;
  }

  private setStage(stage: StageId, state: TaskRecord['stages'][StageId], responsible?: TaskRecord['responsible']): void {
    const t = this.task!;
    t.stages[stage] = state;
    if (state === 'active') t.currentStage = stage;
    if (responsible !== undefined) t.responsible = responsible;
    this.persist();
  }

  private log(level: Level, stage: StageId | null, agent: TaskRecord['events'][number]['agent'], message: string, persist = true): void {
    const t = this.task;
    if (!t) return;
    t.events.push({ ts: Date.now(), level, stage, agent, message });
    if (t.events.length > MAX_EVENTS) t.events.splice(0, t.events.length - MAX_EVENTS);
    if (persist) this.persist();
    else this.emit('task', t);
  }

  private agent(id: AgentId, update: AgentStatusUpdate): void {
    this.emit('agent', id, update);
  }

  private persist(): void {
    const t = this.task;
    if (!t) return;
    t.updatedAt = Date.now();
    this.deps.save(t);
    this.emit('task', t);
  }

  private buildSummary(t: TaskRecord): string {
    const lastTest = t.testRuns.at(-1);
    const lastQa = t.qaReports.at(-1)?.reported;
    const ownChanges = t.changedFiles.filter((c) => c.inScope);
    const lines = [
      `# Tarea ${t.id}`,
      '',
      `**Estado:** ${t.status} · **Intentos:** ${t.attempts}/${t.maxAttempts} · **Proyecto:** ${t.projectPath ?? '-'}`,
      '',
      '## Instrucción',
      t.instruction,
      '',
      '## Criterios de aceptación',
      ...(t.acceptanceCriteria.length ? t.acceptanceCriteria.map((c) => {
        const qa = lastQa?.criteria.find((q) => q.criterion === c);
        return `- [${qa?.met ? 'x' : ' '}] ${c}`;
      }) : ['(no definidos)']),
      '',
      '## Archivos modificados',
      ...(ownChanges.length ? ownChanges.map((c) => `- ${c.kind}: ${c.path}${c.preexisting ? ' (tenía cambios previos del usuario; respaldo en la carpeta de backups)' : ''}`) : ['(ninguno)']),
      '',
      '## Pruebas',
      lastTest ? `${lastTest.status}${lastTest.command ? ` — \`${lastTest.command}\`` : ''}` : 'no ejecutadas',
      '',
      '## QA',
      lastQa ? `${lastQa.verdict}: ${lastQa.summary}` : 'sin veredicto',
      '',
      '## Resultado',
      t.finalResult ?? '',
    ];
    if (t.violations.length) lines.push('', '## Violaciones de seguridad', ...t.violations.map((v) => `- ${v}`));
    return lines.join('\n');
  }

  private writeReport(t: TaskRecord): void {
    try {
      fs.writeFileSync(path.join(subDir('reports'), `${t.id}.md`), t.summary ?? '', 'utf8');
    } catch {
      /* el informe es auxiliar: el historial JSON ya tiene todo */
    }
  }
}

/**
 * El orquestador no se fía del veredicto de QA: lo contrasta con los resultados
 * reales de las pruebas y con la lista de criterios de aceptación.
 */
export function validateVerdict(v: QaVerdict, test: TestRun, criteria: string[], requireTests: boolean, attempt: number): QaReport {
  const notes: string[] = [];
  let accepted = v.verdict === 'approved';
  if (test.status === 'failed' || test.status === 'error') {
    if (accepted) notes.push('QA aprobó, pero las pruebas automáticas reales fallaron: el veredicto se invalida.');
    accepted = false;
  }
  if (test.status === 'none' && requireTests) {
    notes.push('La configuración exige pruebas automatizadas y el proyecto no tiene una suite detectable.');
    accepted = false;
  }
  const unmet = v.criteria.filter((c) => !c.met);
  if (unmet.length) {
    if (v.verdict === 'approved') notes.push(`QA aprobó con ${unmet.length} criterio(s) sin cumplir: se invalida.`);
    accepted = false;
  }
  if (v.criteria.length < criteria.length) {
    notes.push(`QA evaluó ${v.criteria.length} de ${criteria.length} criterios de aceptación.`);
    accepted = false;
  }
  const blocking = v.issues.filter((i) => i.severity !== 'minor');
  if (blocking.length) {
    if (v.verdict === 'approved') notes.push(`QA aprobó con ${blocking.length} problema(s) critical/major: se invalida.`);
    accepted = false;
  }
  return { attempt, ts: Date.now(), reported: v, accepted, orchestratorNotes: notes };
}
