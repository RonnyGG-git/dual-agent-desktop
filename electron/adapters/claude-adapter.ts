import { resolveExecutable } from '../services/executables';
import { runProcess } from '../services/process-runner';
import { DENY_COMMANDS } from '../security/policy';
import {
  classifyError,
  redact,
  truncate,
  type AgentActivity,
  type AgentAdapter,
  type AgentProbe,
  type AgentRunRequest,
  type AgentRunResult,
} from './agent-adapter';

export interface ClaudeAdapterOptions {
  /** Ruta del script guardián (PreToolUse). */
  guardHook: string;
  /** Ejecutable con el que correr el guardián como Node (en Electron: el propio electron.exe). */
  nodeRuntime: string;
  guardLog: string;
  model: () => string;
  executable?: string | null;
  /** Argumentos previos al comando (pruebas: ejecutable=node, prefixArgs=[script simulado]). */
  prefixArgs?: string[];
}

const ROLE_PROMPT = [
  'Estás siendo orquestado por "Dual Agent Desktop" como agente DESARROLLADOR.',
  'Un agente QA independiente (OpenCode) revisará tu trabajo y el orquestador ejecutará las pruebas reales.',
  'Reglas: nunca borres, muevas ni renombres archivos existentes; nunca ejecutes git commit, push, reset, checkout, clean ni stash;',
  'no instales dependencias nuevas; trabaja solo dentro de la ruta del proyecto indicada.',
  'Tus permisos los impone el sistema: si una acción es bloqueada, no intentes rodearla; menciónalo en tu respuesta.',
  'Responde siempre en español.',
].join(' ');

/** Comandos de verificación que el desarrollador puede ejecutar sin preguntar (el resto se deniega). */
const SAFE_COMMANDS = [
  'git status', 'git diff', 'git log', 'git show',
  'npm test', 'npm run test', 'npm run build', 'npm run lint', 'npm run typecheck',
  'npx vitest', 'npx jest', 'npx tsc',
  'mvn test', 'mvn -q test', 'mvn compile', 'mvn -q compile',
  'gradlew test', 'gradle test', 'python -m pytest', 'pytest', 'node --test', 'cargo test', 'go test',
];

export class ClaudeAdapter implements AgentAdapter {
  readonly id = 'claude' as const;
  private exe: string | null;

  constructor(private opts: ClaudeAdapterOptions) {
    this.exe = opts.executable === undefined ? resolveExecutable('claude') : opts.executable;
  }

  async detect(): Promise<AgentProbe> {
    this.exe = this.opts.executable === undefined ? resolveExecutable('claude') : this.opts.executable;
    if (!this.exe) return { executable: null, version: null, model: null, auth: { ok: false, detail: 'No se encontró el ejecutable "claude".' } };
    const env = cleanEnv();
    const v = await runProcess(this.exe, { cwd: process.cwd(), args: [...(this.opts.prefixArgs ?? []), ...['--version']], env, timeoutMs: 30_000 });
    const version = v.exitCode === 0 ? v.stdout.trim().split(/\r?\n/)[0] : null;
    const a = await runProcess(this.exe, { cwd: process.cwd(), args: [...(this.opts.prefixArgs ?? []), ...['auth', 'status']], env, timeoutMs: 30_000 });
    let auth: AgentProbe['auth'] = { ok: null, detail: 'No se pudo verificar la autenticación.' };
    try {
      const j = JSON.parse(a.stdout);
      auth = j.loggedIn
        ? { ok: true, detail: `Sesión iniciada (${j.authMethod ?? 'desconocido'}${j.subscriptionType ? ` · plan ${j.subscriptionType}` : ''})` }
        : { ok: false, detail: 'Claude Code no tiene sesión iniciada. Ejecuta "claude auth login" en una terminal.' };
    } catch {
      if (a.exitCode !== 0) auth = { ok: false, detail: truncate(redact(a.stderr || a.stdout), 160) || 'auth status falló' };
    }
    return { executable: this.exe, version, model: this.opts.model() || null, auth };
  }

  buildArgs(req: AgentRunRequest): string[] {
    const settings = {
      hooks: {
        PreToolUse: [
          {
            matcher: 'Write|Edit|MultiEdit|NotebookEdit|Bash|PowerShell',
            hooks: [{ type: 'command', command: this.opts.nodeRuntime, args: [this.opts.guardHook], timeout: 20 }],
          },
        ],
      },
    };
    const args = [
      '-p',
      '--output-format', 'stream-json',
      '--verbose',
      '--permission-mode', req.mode === 'readonly' ? 'plan' : 'acceptEdits',
      // Todo lo que pediría confirmación se deniega automáticamente (nunca se omiten las confirmaciones).
      '--permission-prompts', 'none',
      '--settings', JSON.stringify(settings),
      '--append-system-prompt', ROLE_PROMPT,
    ];
    if (req.mode !== 'readonly') {
      const allowed = ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'TodoWrite', 'Skill'];
      for (const c of SAFE_COMMANDS) allowed.push(`Bash(${c}:*)`, `PowerShell(${c}:*)`);
      args.push('--allowedTools', allowed.join(','));
    }
    args.push('--disallowedTools', ['Bash(rm:*)', 'Bash(git push:*)', 'Bash(git reset:*)', 'Bash(git clean:*)', 'PowerShell(Remove-Item:*)', 'PowerShell(git push:*)', 'PowerShell(git reset:*)'].join(','));
    if (req.jsonSchema) args.push('--json-schema', req.jsonSchema);
    const model = this.opts.model();
    if (model) args.push('--model', model);
    if (req.resumeSessionId) args.push('--resume', req.resumeSessionId);
    return args;
  }

  async run(req: AgentRunRequest, onActivity: (a: AgentActivity) => void): Promise<AgentRunResult> {
    if (!this.exe) {
      return fail('not_found', 'No se encontró el ejecutable "claude".');
    }
    let sessionId: string | null = null;
    let model: string | null = null;
    let result: Record<string, any> | null = null;
    let rateRejected = false;
    const texts: string[] = [];

    const r = await runProcess(this.exe, {
      cwd: req.cwd,
      args: [...(this.opts.prefixArgs ?? []), ...this.buildArgs(req)],
      stdin: req.prompt,
      env: {
        ...cleanEnv(),
        DAD_POLICY_FILE: req.policyFile ?? '',
        DAD_GUARD_LOG: this.opts.guardLog,
        // Permite usar electron.exe como Node para ejecutar el guardián.
        ELECTRON_RUN_AS_NODE: '1',
      },
      timeoutMs: req.timeoutMs,
      signal: req.signal,
      onStdoutLine: (line) => {
        let ev: any;
        try {
          ev = JSON.parse(line);
        } catch {
          onActivity({ level: 'info', text: truncate(redact(line), 200) });
          return;
        }
        if (ev.session_id) sessionId = ev.session_id;
        switch (ev.type) {
          case 'system':
            if (ev.subtype === 'init') {
              model = ev.model ?? null;
              onActivity({ level: 'info', text: `Sesión iniciada · modelo ${model ?? '?'} · permisos ${ev.permissionMode ?? '?'}`, model: model ?? undefined, sessionId: ev.session_id });
            }
            break;
          case 'assistant':
            for (const c of ev.message?.content ?? []) {
              if (c.type === 'text' && c.text?.trim()) {
                texts.push(c.text);
                onActivity({ level: 'info', text: truncate(redact(c.text), 240) });
              } else if (c.type === 'tool_use') {
                const action = describeTool(c.name, c.input);
                onActivity({ level: 'info', text: action, action });
              }
            }
            break;
          case 'user':
            for (const c of Array.isArray(ev.message?.content) ? ev.message.content : []) {
              if (c.type === 'tool_result' && c.is_error) {
                const content = typeof c.content === 'string' ? c.content : JSON.stringify(c.content);
                onActivity({ level: 'warn', text: truncate(redact(content), 240) });
              }
            }
            break;
          case 'rate_limit_event':
            if (ev.rate_limit_info?.status === 'rejected') {
              rateRejected = true;
              onActivity({ level: 'error', text: 'Límite de uso de Claude alcanzado.' });
            }
            break;
          case 'result':
            result = ev;
            onActivity({
              level: ev.is_error ? 'error' : 'success',
              text: ev.is_error
                ? `Terminó con error: ${truncate(redact(String(ev.result ?? ev.subtype)), 200)}`
                : `Etapa completada · ${ev.num_turns ?? '?'} turnos · ${Math.round((ev.duration_ms ?? 0) / 1000)} s`,
            });
            break;
        }
      },
    });

    const res = result as Record<string, any> | null;
    const base = {
      exitCode: r.exitCode,
      sessionId,
      model,
      text: res?.result != null ? String(res.result) : texts.join('\n'),
      structured: res?.structured_output ?? null,
      permissionDenials: (res?.permission_denials ?? []).map((d: any) => `${d.tool_name}: ${truncate(JSON.stringify(d.tool_input ?? {}), 120)}`),
      durationMs: r.durationMs,
    };
    if (r.spawnError) return { ...base, ok: false, errorKind: r.spawnError.code === 'ENOENT' ? 'not_found' : 'execution', errorMessage: r.spawnError.message };
    if (r.cancelled) return { ...base, ok: false, errorKind: 'cancelled', errorMessage: 'Ejecución cancelada por el usuario.' };
    if (r.timedOut) return { ...base, ok: false, errorKind: 'timeout', errorMessage: `Se superó el tiempo máximo (${Math.round(req.timeoutMs / 60000)} min).` };
    if (rateRejected) return { ...base, ok: false, errorKind: 'rate_limit', errorMessage: 'Límite de uso de Claude alcanzado. Espera a que se restablezca.' };
    if (!res || res.is_error || r.exitCode !== 0) {
      const detail = redact(`${res?.result ?? ''} ${res?.api_error_status ?? ''} ${r.stderr}`.trim()) || `código de salida ${r.exitCode}`;
      const kind = res?.api_error_status === 401 || res?.api_error_status === 403 ? 'auth' : classifyError(detail);
      return { ...base, ok: false, errorKind: kind, errorMessage: truncate(detail, 400) };
    }
    if (req.jsonSchema && base.structured == null) {
      return { ...base, ok: false, errorKind: 'invalid_output', errorMessage: 'Claude no entregó la respuesta estructurada requerida.' };
    }
    return { ...base, ok: true, errorKind: null, errorMessage: null };
  }
}

function fail(kind: AgentRunResult['errorKind'], msg: string): AgentRunResult {
  return { ok: false, exitCode: null, sessionId: null, model: null, text: '', structured: null, errorKind: kind, errorMessage: msg, permissionDenials: [], durationMs: 0 };
}

/** Entorno limpio: evita que una sesión de Claude Code padre se confunda con la hija. */
function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  delete env.CLAUDE_CODE_SSE_PORT;
  return env;
}

export function describeTool(name: string, input: any): string {
  const i = input ?? {};
  const file = i.file_path || i.notebook_path || i.path;
  switch (name) {
    case 'Read': return `Leyendo ${short(file)}`;
    case 'Write': return `Creando ${short(file)}`;
    case 'Edit':
    case 'MultiEdit': return `Editando ${short(file)}`;
    case 'NotebookEdit': return `Editando notebook ${short(file)}`;
    case 'Glob': return `Buscando archivos ${i.pattern ?? ''}`;
    case 'Grep': return `Buscando "${truncate(String(i.pattern ?? ''), 60)}"`;
    case 'Bash':
    case 'PowerShell': return `Ejecutando: ${truncate(redact(String(i.command ?? '')), 120)}`;
    case 'TodoWrite': return 'Actualizando lista de tareas';
    case 'StructuredOutput': return 'Entregando resultado estructurado';
    case 'Task':
    case 'Agent': return `Subagente: ${truncate(String(i.description ?? ''), 80)}`;
    default: return `Herramienta ${name}`;
  }
}

function short(p: unknown): string {
  const s = String(p ?? '');
  const parts = s.split(/[\\/]/);
  return parts.length > 3 ? `…/${parts.slice(-3).join('/')}` : s;
}
