// Pruebas con las CLI REALES de Claude Code y OpenCode (consumen uso real).
// Ejecutar con: npm run test:real
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { ClaudeAdapter } from '../../electron/adapters/claude-adapter';
import { OpenCodeAdapter } from '../../electron/adapters/opencode-adapter';
import { Orchestrator } from '../../electron/orchestrator/orchestrator';
import { WriteLock } from '../../electron/security/locks';
import { DEFAULT_SETTINGS } from '../../electron/services/config';
import { gitDirty, takeSnapshot } from '../../electron/services/git';
import { HistoryStore } from '../../electron/services/history';
import { runTests } from '../../electron/services/test-runner';
import { ReviewOutputSchema, toJsonSchema } from '../../shared/schemas';
import type { Settings, TaskRecord } from '../../shared/types';

const REAL = process.env.DAD_REAL_CLI === '1';
const GUARD = path.resolve(__dirname, '../../electron/security/guard-hook.cjs');
const CEREBRO = 'C:\\RONNY\\MIND\\CEREBRO';

const mkClaude = () => new ClaudeAdapter({ guardHook: GUARD, nodeRuntime: process.execPath, guardLog: path.join(os.tmpdir(), 'dad-guard.log'), model: () => '' });
const mkOpenCode = () => new OpenCodeAdapter({ model: () => '' });
const git = (cwd: string, ...a: string[]) => spawnSync('git', a, { cwd, encoding: 'utf8' });
const print = (t: TaskRecord) => t.events.forEach((e) => console.log(`[${e.agent}] ${e.level}: ${e.message}`));

beforeAll(() => {
  process.env.DAD_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dad-real-data-'));
});

describe.runIf(REAL)('CLI reales', () => {
  it('detecta ambas CLI instaladas con su autenticación real', async () => {
    const c = await mkClaude().detect();
    const o = await mkOpenCode().detect();
    console.log({ claude: c, opencode: o });
    expect(c.executable).toMatch(/claude\.exe$/i);
    expect(c.version).toMatch(/Claude Code/);
    expect(c.auth.ok).toBe(true);
    expect(o.executable).toMatch(/opencode\.exe$/i);
    expect(o.version).toMatch(/^\d+\.\d+/);
  });

  it('OpenCode QA real no puede escribir ni borrar (permisos impuestos por la CLI)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dad-qa-'));
    fs.writeFileSync(path.join(dir, 'a.txt'), 'original');
    const r = await mkOpenCode().run(
      {
        taskId: 'qa-perm',
        cwd: dir,
        mode: 'readonly',
        timeoutMs: 300_000,
        signal: new AbortController().signal,
        prompt: 'Prueba de permisos: lee a.txt, luego intenta sobrescribirlo con "hack" y crear b.txt, y ejecuta "del a.txt". Después responde con un bloque ```json {"verdict":"approved","summary":"<qué pasó>"} ```',
      },
      (a) => console.log('[opencode]', a.text),
    );
    console.log('model:', r.model, 'denials:', r.permissionDenials);
    expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe('original');
    expect(fs.existsSync(path.join(dir, 'b.txt'))).toBe(false);
    expect(r.sessionId).toMatch(/^ses_/);
  });

  it('ciclo completo real: Claude revisa y desarrolla, se ejecutan pruebas, OpenCode valida, se finaliza', async () => {
    // Workspace sandbox con varios "proyectos", cambios previos del usuario y un archivo ajeno.
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'dad-e2e-'));
    git(ws, 'init', '-q');
    git(ws, 'config', 'user.email', 'e2e@test');
    git(ws, 'config', 'user.name', 'e2e');
    fs.mkdirSync(path.join(ws, 'calc'));
    fs.mkdirSync(path.join(ws, 'notas'));
    fs.writeFileSync(path.join(ws, 'calc', 'package.json'), JSON.stringify({ name: 'calc', version: '1.0.0', scripts: { test: 'node --test' } }, null, 2));
    fs.writeFileSync(path.join(ws, 'calc', 'math.js'), 'function add(a, b) {\n  return a + b;\n}\n\nmodule.exports = { add };\n');
    fs.writeFileSync(path.join(ws, 'calc', 'math.test.js'), "const test = require('node:test');\nconst assert = require('node:assert');\nconst { add } = require('./math');\n\ntest('add', () => assert.strictEqual(add(2, 3), 5));\n");
    fs.writeFileSync(path.join(ws, 'calc', 'README.md'), '# calc\n\nFunciones: `add(a, b)`.\n');
    fs.writeFileSync(path.join(ws, 'notas', 'ideas.md'), '# Ideas\n');
    fs.writeFileSync(path.join(ws, 'nota-raiz.md'), 'versión commiteada\n');
    git(ws, 'add', '.');
    git(ws, 'commit', '-qm', 'init');
    fs.writeFileSync(path.join(ws, 'nota-raiz.md'), 'cambio del usuario sin commitear\n');
    const ajenos = takeSnapshot(ws, ['notas', '.']);
    const ajenosAntes = new Map([...ajenos.files].filter(([p]) => !p.startsWith('calc/')));

    const settings: Settings = { ...DEFAULT_SETTINGS, workspace: ws, extraWritablePaths: [], maxAttempts: 3 };
    const history = new HistoryStore();
    const lights: string[] = [];
    const orch = new Orchestrator({ claude: mkClaude(), opencode: mkOpenCode(), settings: () => settings, save: (t) => history.save(t), runTests, lock: new WriteLock() });
    orch.on('task', (t: TaskRecord) => {
      const s = Object.values(t.stages).join(',');
      if (lights.at(-1) !== s) lights.push(s);
    });
    orch.on('activity', (id, lvl, text) => console.log(`  ${id} · ${text}`));

    const r = orch.submit('En el proyecto calc agrega una función multiply(a, b) que devuelva el producto, expórtala junto a add y añade su prueba en math.test.js. Documenta la nueva función en el README del proyecto.');
    expect(r.ok).toBe(true);
    await orch.idle();
    const t = orch.current!;
    print(t);
    console.log('LEDs:', lights);
    console.log('Cambios:', t.changedFiles);

    expect(t.projectPath).toBe('calc');
    expect(t.status).toBe('completed');
    expect(t.stages).toEqual({ review: 'done', develop: 'done', test: 'done', document: 'done', done: 'done' });
    expect(t.testRuns.at(-1)?.status).toBe('passed');
    expect(t.qaReports.at(-1)?.accepted).toBe(true);
    // El código realmente funciona (lo comprobamos nosotros, no el agente)
    const mod = require(path.join(ws, 'calc', 'math.js'));
    expect(mod.multiply(4, 5)).toBe(20);
    expect(mod.add(2, 3)).toBe(5);
    // Solo cambió el proyecto objetivo; lo ajeno y el cambio previo del usuario siguen intactos
    expect(t.changedFiles.every((c) => c.path.startsWith('calc/'))).toBe(true);
    const after = takeSnapshot(ws, ['notas', '.']);
    for (const [p, fp] of ajenosAntes) expect(after.files.get(p), p).toBe(fp);
    expect(fs.readFileSync(path.join(ws, 'nota-raiz.md'), 'utf8')).toBe('cambio del usuario sin commitear\n');
    // Historial persistido
    expect(history.get(t.id)?.status).toBe('completed');
  }, 1_800_000);

  it.runIf(fs.existsSync(CEREBRO))('revisión real de solo lectura sobre CEREBRO: identifica el proyecto y no modifica nada', async () => {
    const before = gitDirty(CEREBRO);
    const snapBefore = takeSnapshot(CEREBRO, []);
    const r = await mkClaude().run(
      {
        taskId: 'cerebro-ro',
        cwd: CEREBRO,
        mode: 'readonly',
        jsonSchema: toJsonSchema(ReviewOutputSchema),
        timeoutMs: 600_000,
        signal: new AbortController().signal,
        prompt: 'ETAPA: REVISIÓN (solo lectura — no modifiques nada). Instrucción: "En el proyecto SmartBite, ¿qué documento describe los casos de uso de Pedidos?". Identifica la carpeta del proyecto relevante (ruta relativa), define 1-2 criterios de aceptación y un plan breve. Entrega la salida estructurada.',
      },
      (a) => console.log('[claude]', a.text),
    );
    console.log(r.structured);
    expect(r.ok).toBe(true);
    const out = ReviewOutputSchema.parse(r.structured);
    expect(out.project_path.toLowerCase()).toContain('smartbite');
    // Nada cambió en CEREBRO
    expect([...gitDirty(CEREBRO)].sort()).toEqual([...before].sort());
    const snapAfter = takeSnapshot(CEREBRO, []);
    const changed = [...snapAfter.files].filter(([p, fp]) => snapBefore.files.get(p) !== fp && !p.startsWith('.obsidian/'));
    expect(changed).toEqual([]);
  }, 900_000);
});
