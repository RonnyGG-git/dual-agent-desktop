import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { classifyError, redact } from '../../electron/adapters/agent-adapter';
import { ConfigStore } from '../../electron/services/config';
import { unwrapShim } from '../../electron/services/executables';
import { diffSnapshots, gitInfo, mergeChanges, takeSnapshot } from '../../electron/services/git';
import { HistoryStore } from '../../electron/services/history';
import { isInside } from '../../electron/services/paths';
import { runProcess } from '../../electron/services/process-runner';
import { detectTestCommand, runTests } from '../../electron/services/test-runner';
import { extractLastJson, QaVerdictSchema, ReviewOutputSchema, toJsonSchema } from '../../shared/schemas';

beforeEach(() => {
  process.env.DAD_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dad-data-'));
});
const tmp = (p = 'dad-') => fs.mkdtempSync(path.join(os.tmpdir(), p));
const git = (cwd: string, ...args: string[]) => spawnSync('git', args, { cwd, encoding: 'utf8' });

describe('Git: detección de cambios', () => {
  it('distingue cambios previos del usuario de los nuevos y detecta borrados', () => {
    const ws = tmp();
    git(ws, 'init', '-q');
    git(ws, 'config', 'user.email', 't@t');
    git(ws, 'config', 'user.name', 't');
    fs.mkdirSync(path.join(ws, 'p'));
    for (const f of ['p/limpio.js', 'p/sucio.js', 'p/borrar.js', 'fuera.md']) fs.writeFileSync(path.join(ws, f), 'v1');
    git(ws, 'add', '.');
    git(ws, 'commit', '-qm', 'init');
    fs.writeFileSync(path.join(ws, 'p/sucio.js'), 'cambio del usuario'); // cambio previo sin commitear

    expect(gitInfo(ws)).toMatchObject({ isRepo: true, dirtyCount: 1 });
    const before = takeSnapshot(ws, ['p']);
    expect([...before.dirty]).toEqual(['p/sucio.js']);

    fs.writeFileSync(path.join(ws, 'p/limpio.js'), 'v2-agente-largo');
    fs.writeFileSync(path.join(ws, 'p/nuevo.js'), 'nuevo');
    fs.unlinkSync(path.join(ws, 'p/borrar.js'));
    fs.writeFileSync(path.join(ws, 'fuera.md'), 'externo-modificado');
    const after = takeSnapshot(ws, ['p']);
    const changes = diffSnapshots(ws, before, after, ['p']);
    expect(changes).toEqual([
      { path: 'fuera.md', kind: 'modified', preexisting: false, inScope: false },
      { path: 'p/borrar.js', kind: 'deleted', preexisting: false, inScope: true },
      { path: 'p/limpio.js', kind: 'modified', preexisting: false, inScope: true },
      { path: 'p/nuevo.js', kind: 'added', preexisting: false, inScope: true },
    ]);
    // el archivo con cambios previos del usuario no aparece porque el agente no lo tocó
    expect(changes.find((c) => c.path === 'p/sucio.js')).toBeUndefined();
  });

  it('ignora el ruido de Obsidian', () => {
    const ws = tmp();
    fs.mkdirSync(path.join(ws, '.obsidian'));
    const before = takeSnapshot(ws, ['.']);
    fs.writeFileSync(path.join(ws, '.obsidian', 'workspace.json'), '{}');
    expect(diffSnapshots(ws, before, takeSnapshot(ws, ['.']), ['.'])).toEqual([]);
  });

  it('mergeChanges acumula etapas (añadido y luego modificado sigue siendo añadido)', () => {
    const a = [{ path: 'x', kind: 'added' as const, preexisting: false, inScope: true }];
    expect(mergeChanges(a, [{ path: 'x', kind: 'modified', preexisting: false, inScope: true }])[0].kind).toBe('added');
    expect(mergeChanges(a, [{ path: 'x', kind: 'deleted', preexisting: false, inScope: true }])).toEqual([]);
  });
});

describe('Detección y ejecución de pruebas', () => {
  it('detecta npm test y omite el script por defecto de npm', () => {
    const d = tmp();
    fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }));
    expect(detectTestCommand(d)).toBeNull();
    fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
    expect(detectTestCommand(d)?.label).toBe('npm test');
  });

  it('detecta mvnw, gradlew y pytest', () => {
    const d = tmp();
    fs.writeFileSync(path.join(d, 'mvnw.cmd'), '');
    expect(detectTestCommand(d)?.label).toMatch(/mvnw/);
    const g = tmp();
    fs.writeFileSync(path.join(g, 'gradlew.bat'), '');
    expect(detectTestCommand(g)?.label).toMatch(/gradlew/);
    const p = tmp();
    fs.writeFileSync(path.join(p, 'pytest.ini'), '');
    expect(detectTestCommand(p)?.label).toMatch(/pytest/);
  });

  it('ejecuta pruebas reales y distingue aprobado/fallido', async () => {
    const d = tmp();
    fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
    fs.writeFileSync(path.join(d, 'ok.test.js'), "const t=require('node:test');const a=require('node:assert');t('ok',()=>a.equal(1,1));");
    const ac = new AbortController();
    const pass = await runTests(d, 1, 60_000, ac.signal, () => {});
    expect(pass.status).toBe('passed');
    fs.writeFileSync(path.join(d, 'bad.test.js'), "const t=require('node:test');const a=require('node:assert');t('bad',()=>a.equal(1,2));");
    const fail = await runTests(d, 2, 60_000, ac.signal, () => {});
    expect(fail.status).toBe('failed');
    expect(fail.exitCode).not.toBe(0);
    expect(await runTests(tmp(), 1, 1000, ac.signal, () => {})).toMatchObject({ status: 'none' });
  }, 60_000);
});

describe('Ejecutor de procesos', () => {
  it('aplica el tiempo máximo y mata el proceso', async () => {
    const r = await runProcess(process.execPath, { cwd: os.tmpdir(), args: ['-e', 'setInterval(()=>{},1000)'], timeoutMs: 800 });
    expect(r.timedOut).toBe(true);
  });
  it('cancela con AbortSignal y mata el árbol de procesos', async () => {
    const ac = new AbortController();
    const marker = path.join(tmp(), 'child.pid');
    const script = `const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)']);require('fs').writeFileSync(${JSON.stringify(marker)},String(c.pid));setInterval(()=>{},1000)`;
    const p = runProcess(process.execPath, { cwd: os.tmpdir(), args: ['-e', script], timeoutMs: 30_000, signal: ac.signal });
    while (!fs.existsSync(marker)) await new Promise((r) => setTimeout(r, 50));
    ac.abort();
    const r = await p;
    expect(r.cancelled).toBe(true);
    const childPid = Number(fs.readFileSync(marker, 'utf8'));
    await new Promise((r) => setTimeout(r, 300));
    expect(() => process.kill(childPid, 0)).toThrow(); // el nieto también murió: no quedan huérfanos
  });
  it('separa stdout en líneas y no usa shell (los argumentos no se interpretan)', async () => {
    const lines: string[] = [];
    const r = await runProcess(process.execPath, { cwd: os.tmpdir(), args: ['-e', 'console.log(process.argv[1]);console.log("b")', '& echo inyectado'], timeoutMs: 10_000, onStdoutLine: (l) => lines.push(l) });
    expect(r.exitCode).toBe(0);
    expect(lines).toEqual(['& echo inyectado', 'b']);
  });
});

describe('Utilidades', () => {
  it('extractLastJson toma el último bloque JSON válido', () => {
    expect(extractLastJson('bla ```json\n{"a":1}\n``` y luego ```json\n{"a":2}\n```')).toEqual({ a: 2 });
    expect(extractLastJson('texto {"x":{"y":"}"}} fin')).toEqual({ x: { y: '}' } });
    expect(extractLastJson('sin json')).toBeNull();
  });
  it('toJsonSchema no incluye "$schema" (Claude Code rechaza draft 2020-12)', () => {
    const s = JSON.parse(toJsonSchema(ReviewOutputSchema));
    expect(s.$schema).toBeUndefined();
    expect(s.type).toBe('object');
    expect(s.required).toContain('project_path');
  });
  it('QaVerdictSchema rechaza veredictos mal formados', () => {
    expect(QaVerdictSchema.safeParse({ verdict: 'ok', summary: '' }).success).toBe(false);
    expect(QaVerdictSchema.safeParse({ verdict: 'approved', summary: '' }).success).toBe(true);
  });
  it('clasifica errores de autenticación y límites de uso', () => {
    expect(classifyError('Not logged in · Please run /login')).toBe('auth');
    expect(classifyError('API Error: 429 rate_limit_error')).toBe('rate_limit');
    expect(classifyError("You've hit your usage limit")).toBe('rate_limit');
    expect(classifyError('ENOSPC')).toBe('execution');
  });
  it('redact oculta tokens', () => {
    expect(redact('key sk-ant-abcdefghijklmnopqrstuvwxyz')).not.toMatch(/abcdefghijklmnop/);
    expect(redact('"api_key": "supersecreto123"')).not.toMatch(/supersecreto/);
    expect(redact('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc')).not.toMatch(/eyJhbGci/);
  });
  it('isInside no se deja engañar por prefijos ni "..', () => {
    expect(isInside('C:\\a\\b', 'C:\\a\\b\\c')).toBe(true);
    expect(isInside('C:\\a\\b', 'C:\\a\\bc')).toBe(false);
    expect(isInside('C:\\a\\b', 'C:\\a\\b\\..\\x')).toBe(false);
  });
  it('unwrapShim obtiene el .exe real de un shim de npm', () => {
    const d = tmp();
    fs.mkdirSync(path.join(d, 'node_modules', 'pkg', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(d, 'node_modules', 'pkg', 'bin', 'tool.exe'), '');
    fs.writeFileSync(path.join(d, 'tool.cmd'), '@ECHO off\r\n"%dp0%\\node_modules\\pkg\\bin\\tool.exe"   %*\r\n');
    expect(unwrapShim(path.join(d, 'tool.cmd'))).toBe(path.join(d, 'node_modules', 'pkg', 'bin', 'tool.exe'));
  });
});

describe('Persistencia', () => {
  it('la configuración y el historial sobreviven a un "reinicio"', () => {
    new ConfigStore().update({ maxAttempts: 5, claudeModel: 'sonnet' });
    expect(new ConfigStore().get()).toMatchObject({ maxAttempts: 5, claudeModel: 'sonnet', workspace: 'C:\\RONNY\\MIND\\CEREBRO' });
    const h = new HistoryStore();
    h.save({ id: 'abc', status: 'running', events: [], createdAt: 1, instruction: 'i', attempts: 0, projectPath: null, currentStage: 'develop' } as never);
    expect(new HistoryStore().recoverInterrupted()).toBe(1);
    expect(new HistoryStore().get('abc')?.status).toBe('cancelled');
  });
  it('sanea configuración peligrosa', () => {
    const s = new ConfigStore().update({ maxAttempts: 999, claudeModel: 'x; rm -rf /', extraWritablePaths: ['..\\fuera', 'C:\\abs', 'ok'] });
    expect(s.maxAttempts).toBe(10);
    expect(s.claudeModel).toBe('');
    expect(s.extraWritablePaths).toEqual(['ok']);
  });
});
