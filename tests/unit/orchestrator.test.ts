import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AgentActivity, AgentAdapter, AgentRunRequest, AgentRunResult } from '../../electron/adapters/agent-adapter';
import { Orchestrator, validateVerdict } from '../../electron/orchestrator/orchestrator';
import { WriteLock } from '../../electron/security/locks';
import { DEFAULT_SETTINGS } from '../../electron/services/config';
import { HistoryStore } from '../../electron/services/history';
import type { LightState, QaVerdict, Settings, StageId, TaskRecord, TestRun } from '../../shared/types';

type Step = (req: AgentRunRequest) => Promise<Partial<AgentRunResult>> | Partial<AgentRunResult>;

/** Agente simulado: ejecuta en orden las respuestas programadas y registra cada petición. */
class FakeAgent implements AgentAdapter {
  calls: AgentRunRequest[] = [];
  constructor(readonly id: 'claude' | 'opencode', private steps: Step[]) {}
  async detect() {
    return { executable: 'fake', version: '1', model: 'fake-model', auth: { ok: true, detail: 'ok' } };
  }
  async run(req: AgentRunRequest, onActivity: (a: AgentActivity) => void): Promise<AgentRunResult> {
    this.calls.push(req);
    const step = this.steps.shift();
    if (!step) throw new Error(`${this.id}: sin respuesta programada`);
    onActivity({ level: 'info', text: `${this.id} trabajando`, action: 'acción simulada' });
    const r = await step(req);
    return { ok: true, exitCode: 0, sessionId: `${this.id}-s`, model: 'fake-model', text: '', structured: null, errorKind: null, errorMessage: null, permissionDenials: [], durationMs: 1, ...r };
  }
}

const review = (projectPath = 'app') => () => ({
  structured: { project_path: projectPath, project_exists: true, summary: 's', acceptance_criteria: ['c1', 'c2'], plan: ['p'], risks: [] },
});
const develop = (fn?: (ws: string) => void) => (req: AgentRunRequest) => {
  fn?.(req.cwd);
  return { structured: { summary: 'hecho', files_touched: [], tests_added: [], notes: '' } };
};
const verdict = (v: Partial<QaVerdict> = {}): QaVerdict => ({
  verdict: 'approved',
  summary: 'ok',
  criteria: [
    { criterion: 'c1', met: true, evidence: 'e' },
    { criterion: 'c2', met: true, evidence: 'e' },
  ],
  issues: [],
  suggested_tests: [],
  documentation: { needs_update: false, targets: [] },
  ...v,
});
const qa = (v: QaVerdict) => () => ({ text: '```json\n' + JSON.stringify(v) + '\n```', structured: v });
const rejected = () => qa(verdict({ verdict: 'rejected', summary: 'falla X', criteria: [{ criterion: 'c1', met: false, evidence: '' }, { criterion: 'c2', met: true, evidence: '' }], issues: [{ severity: 'major', description: 'bug' }] }));

const testRun = (status: TestRun['status']): TestRun => ({ attempt: 1, ts: Date.now(), status, command: status === 'none' ? null : 'npm test', exitCode: status === 'passed' ? 0 : 1, durationMs: 5, outputTail: '' });

let ws: string;

function setup(claudeSteps: Step[], qaSteps: Step[], tests: TestRun['status'][] = ['passed', 'passed', 'passed'], over: Partial<Settings> = {}) {
  const claude = new FakeAgent('claude', claudeSteps);
  const opencode = new FakeAgent('opencode', qaSteps);
  const history = new HistoryStore();
  const settings: Settings = { ...DEFAULT_SETTINGS, workspace: ws, extraWritablePaths: [], ...over };
  const orch = new Orchestrator({
    claude,
    opencode,
    settings: () => settings,
    save: (t) => history.save(t),
    runTests: async () => testRun(tests.shift() ?? 'passed'),
    lock: new WriteLock(),
  });
  // Secuencia de estados de los focos, tal como la recibe la interfaz.
  const lights: string[] = [];
  orch.on('task', (t: TaskRecord) => {
    const sig = (Object.entries(t.stages) as [StageId, LightState][]).map(([k, v]) => `${k}:${v}`).join(' ');
    if (lights.at(-1) !== sig) lights.push(sig);
  });
  return { orch, claude, opencode, history, lights };
}

beforeEach(() => {
  process.env.DAD_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dad-data-'));
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'dad-ws-'));
  fs.mkdirSync(path.join(ws, 'app'));
  fs.writeFileSync(path.join(ws, 'app', 'index.js'), 'module.exports = 1;\n');
  fs.writeFileSync(path.join(ws, 'nota-usuario.md'), 'no tocar\n');
});

describe('Orquestador — flujo completo', () => {
  it('recorre REVISANDO → DESARROLLANDO → PROBANDO → DOCUMENTANDO → FINALIZADO con eventos reales', async () => {
    const { orch, lights, history } = setup([review(), develop((w) => fs.writeFileSync(path.join(w, 'app', 'nuevo.js'), 'x'))], [qa(verdict())]);
    const r = orch.submit('Agrega nuevo.js');
    expect(r.ok).toBe(true);
    await orch.idle();
    const t = orch.current!;
    expect(t.status).toBe('completed');
    expect(t.stages).toEqual({ review: 'done', develop: 'done', test: 'done', document: 'done', done: 'done' });
    expect(t.changedFiles).toEqual([{ path: 'app/nuevo.js', kind: 'added', preexisting: false, inScope: true }]);
    // Orden real de transiciones de los focos
    expect(lights).toContain('review:active develop:pending test:pending document:pending done:pending');
    expect(lights).toContain('review:done develop:active test:pending document:pending done:pending');
    expect(lights).toContain('review:done develop:done test:active document:pending done:pending');
    expect(lights.at(-1)).toBe('review:done develop:done test:done document:done done:done');
    // Historial persistido en disco
    expect(history.get(t.id)?.status).toBe('completed');
    expect(history.list()[0].id).toBe(t.id);
  });

  it('un rechazo de QA pone PROBANDO en rojo, vuelve a DESARROLLANDO y repite las pruebas', async () => {
    const { orch, claude, lights } = setup([review(), develop(), develop()], [rejected(), qa(verdict())], ['failed', 'passed']);
    orch.submit('arregla');
    await orch.idle();
    const t = orch.current!;
    expect(t.status).toBe('completed');
    expect(t.attempts).toBe(2);
    expect(t.testRuns.map((r) => r.status)).toEqual(['failed', 'passed']);
    expect(lights).toContain('review:done develop:done test:error document:pending done:pending');
    expect(lights).toContain('review:done develop:active test:error document:pending done:pending');
    // El reporte estructurado de QA llega a Claude en la corrección
    const fixPrompt = claude.calls[2].prompt;
    expect(fixPrompt).toContain('CORRECCIÓN');
    expect(fixPrompt).toContain('"severity": "major"');
    expect(claude.calls[2].resumeSessionId).toBe('claude-s');
  });

  it('respeta el máximo de intentos y nunca repite indefinidamente', async () => {
    const { orch, claude, opencode } = setup([review(), develop(), develop(), develop()], [rejected(), rejected(), rejected()], ['failed', 'failed', 'failed'], { maxAttempts: 3 });
    orch.submit('imposible');
    await orch.idle();
    const t = orch.current!;
    expect(t.status).toBe('failed');
    expect(t.attempts).toBe(3);
    expect(claude.calls).toHaveLength(4); // 1 revisión + 3 desarrollos
    expect(opencode.calls).toHaveLength(3);
    expect(t.stages.test).toBe('error');
    expect(t.stages.done).toBe('error');
  });

  it('invalida un "approved" de QA si las pruebas reales fallan', async () => {
    const { orch } = setup([review(), develop(), develop()], [qa(verdict()), qa(verdict())], ['failed', 'passed'], { maxAttempts: 2 });
    orch.submit('x');
    await orch.idle();
    const t = orch.current!;
    expect(t.qaReports[0].accepted).toBe(false);
    expect(t.qaReports[0].orchestratorNotes.join(' ')).toMatch(/pruebas automáticas reales fallaron/);
    expect(t.status).toBe('completed');
    expect(t.attempts).toBe(2);
  });

  it('pide de nuevo el veredicto si QA no entrega JSON válido, y falla si sigue sin entregarlo', async () => {
    const bad = () => ({ text: 'todo bien', structured: null });
    const { orch, opencode } = setup([review(), develop()], [bad, bad]);
    orch.submit('x');
    await orch.idle();
    expect(opencode.calls).toHaveLength(2);
    expect(opencode.calls[1].prompt).toMatch(/no contenía un bloque JSON válido/);
    expect(orch.current!.status).toBe('failed');
    expect(orch.current!.finalResult).toMatch(/veredicto estructurado válido/);
  });

  it('cancelar detiene la ejecución en curso', async () => {
    const hang: Step = (req) =>
      new Promise((resolve) => req.signal.addEventListener('abort', () => resolve({ ok: false, errorKind: 'cancelled', errorMessage: 'cancelado' })));
    const { orch, lights } = setup([review(), hang], []);
    orch.submit('x');
    await new Promise((r) => setTimeout(r, 100));
    expect(orch.current!.stages.develop).toBe('active');
    expect(orch.cancel()).toBe(true);
    await orch.idle();
    expect(orch.current!.status).toBe('cancelled');
    expect(orch.current!.stages.develop).toBe('pending');
    expect(orch.busy).toBe(false);
    expect(lights.at(-1)).not.toContain('done:done');
  });

  it('detiene la tarea si el desarrollador borra un archivo preexistente', async () => {
    const { orch } = setup([review(), develop((w) => fs.unlinkSync(path.join(w, 'app', 'index.js')))], [qa(verdict())]);
    orch.submit('x');
    await orch.idle();
    const t = orch.current!;
    expect(t.status).toBe('failed');
    expect(t.violations[0]).toMatch(/app\/index\.js/);
    expect(t.stages.develop).toBe('error');
  });

  it('distingue cambios previos del usuario y no los atribuye a la tarea si no cambian', async () => {
    fs.writeFileSync(path.join(ws, 'app', 'index.js'), 'module.exports = 2; // edición del usuario sin commitear\n');
    const { orch } = setup([review(), develop((w) => fs.writeFileSync(path.join(w, 'app', 'otro.js'), 'y'))], [qa(verdict())]);
    orch.submit('x');
    await orch.idle();
    expect(orch.current!.changedFiles.map((c) => c.path)).toEqual(['app/otro.js']);
  });

  it('rechaza rutas de proyecto fuera del workspace', async () => {
    const { orch } = setup([review('../fuera')], []);
    orch.submit('x');
    await orch.idle();
    expect(orch.current!.status).toBe('failed');
    expect(orch.current!.stages.review).toBe('error');
    expect(orch.current!.finalResult).toMatch(/fuera del directorio de trabajo/);
  });

  it('solo admite una tarea a la vez y valida la instrucción', async () => {
    const { orch } = setup([review(), develop()], [qa(verdict())]);
    expect(orch.submit('   ').ok).toBe(false);
    expect(orch.submit('a').ok).toBe(true);
    expect(orch.submit('b')).toMatchObject({ ok: false });
    await orch.idle();
  });

  it('errores de autenticación de un agente detienen la tarea con el tipo correcto', async () => {
    const { orch } = setup([() => ({ ok: false, errorKind: 'auth', errorMessage: 'Not logged in' })], []);
    orch.submit('x');
    await orch.idle();
    const last = orch.current!.events.at(-1)!;
    expect(last.message).toMatch(/\(auth\)/);
    expect(orch.current!.stages.review).toBe('error');
  });

  it('cuando QA pide documentación, Claude documenta en modo "docs" y QA la valida', async () => {
    const withDocs = verdict({ documentation: { needs_update: true, targets: ['app/README.md'] } });
    const { orch, claude, opencode } = setup(
      [review(), develop(), (req) => (fs.writeFileSync(path.join(req.cwd, 'app', 'README.md'), '# doc'), { structured: { summary: 'doc', files_touched: ['app/README.md'], skipped_reason: '' } })],
      [qa(withDocs), () => ({ structured: { verdict: 'approved', summary: 'doc ok', issues: [] } })],
    );
    orch.submit('x');
    await orch.idle();
    expect(orch.current!.status).toBe('completed');
    expect(claude.calls[2].mode).toBe('docs');
    expect(opencode.calls).toHaveLength(2);
  });
});

describe('validateVerdict', () => {
  const base = verdict();
  it('acepta solo con criterios cumplidos, sin problemas graves y pruebas en verde', () => {
    expect(validateVerdict(base, testRun('passed'), ['c1', 'c2'], false, 1).accepted).toBe(true);
    expect(validateVerdict(base, testRun('none'), ['c1', 'c2'], false, 1).accepted).toBe(true);
  });
  it('rechaza si faltan pruebas obligatorias', () => {
    expect(validateVerdict(base, testRun('none'), ['c1', 'c2'], true, 1).accepted).toBe(false);
  });
  it('rechaza si QA evaluó menos criterios de los definidos', () => {
    expect(validateVerdict(base, testRun('passed'), ['c1', 'c2', 'c3'], false, 1).accepted).toBe(false);
  });
  it('rechaza approved con issues major', () => {
    const r = validateVerdict(verdict({ issues: [{ severity: 'critical', description: 'x' }] }), testRun('passed'), ['c1', 'c2'], false, 1);
    expect(r.accepted).toBe(false);
    expect(r.orchestratorNotes[0]).toMatch(/critical\/major/);
  });
  it('permite issues minor', () => {
    expect(validateVerdict(verdict({ issues: [{ severity: 'minor', description: 'x' }] }), testRun('passed'), ['c1', 'c2'], false, 1).accepted).toBe(true);
  });
});
