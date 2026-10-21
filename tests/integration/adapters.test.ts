import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentActivity, AgentRunRequest } from '../../electron/adapters/agent-adapter';
import { ClaudeAdapter } from '../../electron/adapters/claude-adapter';
import { OpenCodeAdapter, QA_AGENT } from '../../electron/adapters/opencode-adapter';
import { ReviewOutputSchema, toJsonSchema } from '../../shared/schemas';

// Los adaptadores reales se ejecutan contra CLIs simuladas (node + script) que
// emiten el mismo protocolo NDJSON que las versiones instaladas.
const FIX = path.resolve(__dirname, '../fixtures');
let log: string;
let cwd: string;

const req = (over: Partial<AgentRunRequest> = {}): AgentRunRequest => ({
  taskId: 't1',
  prompt: 'Revisa el proyecto',
  cwd,
  mode: 'readonly',
  timeoutMs: 20_000,
  signal: new AbortController().signal,
  ...over,
});
const claude = () =>
  new ClaudeAdapter({ executable: process.execPath, prefixArgs: [path.join(FIX, 'fake-claude.cjs')], guardHook: 'guard.cjs', nodeRuntime: process.execPath, guardLog: 'g.log', model: () => '' });
const opencode = () => new OpenCodeAdapter({ executable: process.execPath, prefixArgs: [path.join(FIX, 'fake-opencode.cjs')], model: () => '' });
const calls = () => fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'dad-int-'));
  log = path.join(cwd, 'calls.jsonl');
  process.env.FAKE_LOG = log;
  process.env.FAKE_SCENARIO = 'ok';
});
afterEach(() => {
  delete process.env.FAKE_SCENARIO;
});

describe('ClaudeAdapter', () => {
  it('detecta versión y autenticación sin exponer datos personales', async () => {
    const p = await claude().detect();
    expect(p.version).toBe('9.9.9 (Claude Code)');
    expect(p.auth).toEqual({ ok: true, detail: 'Sesión iniciada (claude.ai · plan pro)' });
    expect(JSON.stringify(p)).not.toContain('secreto@x.com');
    process.env.FAKE_SCENARIO = 'logged_out';
    expect((await claude().detect()).auth.ok).toBe(false);
  });

  it('ejecuta en modo no interactivo, interpreta los eventos y devuelve la salida estructurada', async () => {
    const acts: AgentActivity[] = [];
    const schema = toJsonSchema(ReviewOutputSchema);
    const r = await claude().run(req({ jsonSchema: schema, policyFile: 'C:\\p.json' }), (a) => acts.push(a));
    expect(r.ok).toBe(true);
    expect(r.sessionId).toBe('sess-123');
    expect(r.model).toBe('claude-test-1');
    expect(ReviewOutputSchema.parse(r.structured).project_path).toBe('app');
    expect(r.permissionDenials[0]).toMatch(/^Bash: /);
    expect(acts.map((a) => a.text)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/Sesión iniciada · modelo claude-test-1 · permisos plan/),
        'Analizando el proyecto',
        expect.stringMatching(/^Leyendo /),
        expect.stringMatching(/Acción bloqueada/),
        'Ejecutando: npm test',
        expect.stringMatching(/Etapa completada · 3 turnos/),
      ]),
    );
    const [call] = calls();
    expect(call.stdin).toBe('Revisa el proyecto'); // el prompt va por stdin, no por la línea de comandos
    expect(call.args).toEqual(expect.arrayContaining(['-p', '--output-format', 'stream-json', '--permission-mode', 'plan', '--permission-prompts', 'none', '--json-schema', schema]));
    expect(call.args).not.toContain('--dangerously-skip-permissions');
    expect(call.args).not.toContain('bypassPermissions');
    expect(call.env).toEqual({ DAD_POLICY_FILE: 'C:\\p.json', ELECTRON_RUN_AS_NODE: '1' });
    // el hook guardián se inyecta vía --settings
    const settings = JSON.parse(call.args[call.args.indexOf('--settings') + 1]);
    expect(settings.hooks.PreToolUse[0].hooks[0]).toMatchObject({ type: 'command', args: ['guard.cjs'] });
  });

  it('en modo escritura usa acceptEdits con lista blanca de comandos y reanuda la sesión', async () => {
    await claude().run(req({ mode: 'write', resumeSessionId: 'sess-prev' }), () => {});
    const { args } = calls()[0];
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('acceptEdits');
    expect(args[args.indexOf('--resume') + 1]).toBe('sess-prev');
    const allowed: string = args[args.indexOf('--allowedTools') + 1];
    expect(allowed).toContain('Bash(npm test:*)');
    expect(allowed).not.toMatch(/Bash\(\*|Bash,|Bash\)/);
  });

  it('exige la salida estructurada cuando se pidió', async () => {
    process.env.FAKE_SCENARIO = 'no_structured';
    const r = await claude().run(req({ jsonSchema: '{}' }), () => {});
    expect(r).toMatchObject({ ok: false, errorKind: 'invalid_output' });
  });

  it('distingue error de autenticación y límite de uso', async () => {
    process.env.FAKE_SCENARIO = 'auth_error';
    expect(await claude().run(req(), () => {})).toMatchObject({ ok: false, errorKind: 'auth' });
    process.env.FAKE_SCENARIO = 'rate_limit';
    expect(await claude().run(req(), () => {})).toMatchObject({ ok: false, errorKind: 'rate_limit' });
  });

  it('aplica tiempo máximo y cancelación', async () => {
    process.env.FAKE_SCENARIO = 'hang';
    expect(await claude().run(req({ timeoutMs: 1500 }), () => {})).toMatchObject({ ok: false, errorKind: 'timeout' });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 800);
    expect(await claude().run(req({ signal: ac.signal }), () => {})).toMatchObject({ ok: false, errorKind: 'cancelled' });
  });

  it('informa ejecutable no encontrado', async () => {
    const a = new ClaudeAdapter({ executable: null, guardHook: '', nodeRuntime: '', guardLog: '', model: () => '' });
    expect(await a.run(req(), () => {})).toMatchObject({ ok: false, errorKind: 'not_found' });
    expect((await a.detect()).executable).toBeNull();
  });
});

describe('OpenCodeAdapter', () => {
  it('detecta versión y credenciales', async () => {
    const p = await opencode().detect();
    expect(p.version).toBe('1.2.3');
    expect(p.auth).toMatchObject({ ok: true, detail: expect.stringContaining('1 credencial') });
  });

  it('ejecuta con el agente QA de solo lectura, extrae el veredicto y el modelo real', async () => {
    const acts: AgentActivity[] = [];
    const r = await opencode().run(req({ prompt: '-empieza con guion' }), (a) => acts.push(a));
    expect(r.ok).toBe(true);
    expect(r.sessionId).toBe('ses_fake1');
    expect(r.model).toBe('opencode/fake-free');
    expect(r.structured).toMatchObject({ verdict: 'approved' });
    expect(r.permissionDenials).toHaveLength(1);
    expect(acts.some((a) => a.level === 'warn' && /bloqueado/.test(a.text))).toBe(true);
    const { args, config } = calls()[0];
    expect(args.slice(0, 6)).toEqual(['run', '--format', 'json', '--dir', cwd, '--agent']);
    expect(args[args.indexOf('--agent') + 1]).toBe(QA_AGENT);
    expect(args.at(-2)).toBe('--'); // el prompt no puede interpretarse como opción
    expect(args.at(-1)).toBe('-empieza con guion');
    const perm = JSON.parse(config).agent[QA_AGENT].permission;
    expect(perm).toMatchObject({ edit: 'deny', task: 'deny', external_directory: 'deny', bash: { '*': 'deny' } });
  });

  it('respeta la configuración del usuario existente en OPENCODE_CONFIG_CONTENT', async () => {
    process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ theme: 'x', agent: { mio: { mode: 'primary' } } });
    try {
      await opencode().run(req(), () => {});
      const cfg = JSON.parse(calls()[0].config);
      expect(cfg.theme).toBe('x');
      expect(Object.keys(cfg.agent)).toEqual(['mio', QA_AGENT]);
    } finally {
      delete process.env.OPENCODE_CONFIG_CONTENT;
    }
  });

  it('reanuda sesión y deja el JSON ausente para que el orquestador lo pida de nuevo', async () => {
    process.env.FAKE_SCENARIO = 'no_json';
    const r = await opencode().run(req({ resumeSessionId: 'ses_prev' }), () => {});
    expect(r.ok).toBe(true);
    expect(r.structured).toBeNull();
    expect(calls()[0].args).toEqual(expect.arrayContaining(['--session', 'ses_prev']));
  });

  it('clasifica errores del proveedor y aplica cancelación', async () => {
    process.env.FAKE_SCENARIO = 'error';
    expect(await opencode().run(req(), () => {})).toMatchObject({ ok: false, errorKind: 'auth' });
    process.env.FAKE_SCENARIO = 'hang';
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 800);
    expect(await opencode().run(req({ signal: ac.signal }), () => {})).toMatchObject({ ok: false, errorKind: 'cancelled' });
  });
});
