import { extractLastJson } from '../../shared/schemas';
import { resolveExecutable } from '../services/executables';
import { runProcess } from '../services/process-runner';
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

export const QA_AGENT = 'dadqa';

/**
 * Agente QA inyectado con OPENCODE_CONFIG_CONTENT (se fusiona con la config del
 * usuario, que no se modifica). Los permisos los impone OpenCode por herramienta:
 * no puede editar archivos, ni lanzar subagentes (que tendrían otros permisos),
 * ni salir del directorio, ni ejecutar comandos salvo consultas de git.
 */
export const QA_AGENT_CONFIG = {
  agent: {
    [QA_AGENT]: {
      description: 'Dual Agent Desktop — QA / tester de solo lectura',
      mode: 'primary',
      permission: {
        edit: 'deny',
        webfetch: 'deny',
        task: 'deny',
        external_directory: 'deny',
        doom_loop: 'deny',
        question: 'deny',
        bash: {
          '*': 'deny',
          'git status*': 'allow',
          'git diff*': 'allow',
          'git log*': 'allow',
          'git show*': 'allow',
        },
      },
    },
  },
};

const MAX_PROMPT = 24_000; // límite seguro de línea de comandos en Windows (32k)

export interface OpenCodeAdapterOptions {
  model: () => string;
  executable?: string | null;
  /** Argumentos previos al comando (pruebas: ejecutable=node, prefixArgs=[script simulado]). */
  prefixArgs?: string[];
}

export class OpenCodeAdapter implements AgentAdapter {
  readonly id = 'opencode' as const;
  private exe: string | null;
  private lastModel: string | null = null;

  constructor(private opts: OpenCodeAdapterOptions) {
    this.exe = opts.executable === undefined ? resolveExecutable('opencode') : opts.executable;
  }

  async detect(): Promise<AgentProbe> {
    this.exe = this.opts.executable === undefined ? resolveExecutable('opencode') : this.opts.executable;
    if (!this.exe) return { executable: null, version: null, model: null, auth: { ok: false, detail: 'No se encontró el ejecutable "opencode".' } };
    const v = await runProcess(this.exe, { cwd: process.cwd(), args: [...(this.opts.prefixArgs ?? []), ...['--version']], timeoutMs: 30_000 });
    const version = v.exitCode === 0 ? v.stdout.trim().split(/\r?\n/).pop() ?? null : null;
    const p = await runProcess(this.exe, { cwd: process.cwd(), args: [...(this.opts.prefixArgs ?? []), ...['providers', 'list']], timeoutMs: 30_000 });
    const plain = (p.stdout + p.stderr).replace(/\x1b\[[0-9;]*m/g, '');
    const m = /(\d+)\s+credentials?/i.exec(plain);
    const creds = m ? Number(m[1]) : null;
    // Los modelos gratuitos "opencode/*" no requieren credenciales, así que 0 credenciales no es un error.
    const auth: AgentProbe['auth'] =
      p.exitCode === 0
        ? { ok: true, detail: creds != null ? `${creds} credencial(es) configurada(s) · proveedor opencode disponible` : 'CLI operativa' }
        : { ok: null, detail: 'No se pudieron consultar los proveedores.' };
    return { executable: this.exe, version, model: this.opts.model() || this.lastModel, auth };
  }

  buildArgs(req: AgentRunRequest): string[] {
    const args = ['run', '--format', 'json', '--dir', req.cwd, '--agent', QA_AGENT, '--title', `Dual Agent Desktop ${req.taskId}`];
    const model = this.opts.model();
    if (model) args.push('--model', model);
    if (req.resumeSessionId) args.push('--session', req.resumeSessionId);
    let prompt = req.prompt;
    if (prompt.length > MAX_PROMPT) prompt = `${prompt.slice(0, MAX_PROMPT)}\n[...contenido truncado por longitud...]`;
    args.push('--', prompt);
    return args;
  }

  async run(req: AgentRunRequest, onActivity: (a: AgentActivity) => void): Promise<AgentRunResult> {
    if (!this.exe) {
      return { ok: false, exitCode: null, sessionId: null, model: null, text: '', structured: null, errorKind: 'not_found', errorMessage: 'No se encontró el ejecutable "opencode".', permissionDenials: [], durationMs: 0 };
    }
    let sessionId: string | null = null;
    const texts: string[] = [];
    const errors: string[] = [];
    const denials: string[] = [];

    const r = await runProcess(this.exe, {
      cwd: req.cwd,
      args: [...(this.opts.prefixArgs ?? []), ...this.buildArgs(req)],
      env: { ...process.env, OPENCODE_CONFIG_CONTENT: JSON.stringify(mergeUserConfig(process.env.OPENCODE_CONFIG_CONTENT)) },
      timeoutMs: req.timeoutMs,
      signal: req.signal,
      onStdoutLine: (line) => {
        let ev: any;
        try {
          ev = JSON.parse(line);
        } catch {
          if (line.trim()) onActivity({ level: 'info', text: truncate(redact(line), 200) });
          return;
        }
        if (ev.sessionID && !sessionId) {
          sessionId = ev.sessionID;
          onActivity({ level: 'info', text: `Sesión ${ev.sessionID} iniciada (agente ${QA_AGENT}, solo lectura)`, sessionId: ev.sessionID });
        }
        const part = ev.part ?? {};
        switch (ev.type) {
          case 'text':
            if (part.text?.trim()) {
              texts.push(part.text);
              onActivity({ level: 'info', text: truncate(redact(part.text), 240) });
            }
            break;
          case 'tool_use': {
            const action = describeOpenCodeTool(part.tool, part.state?.input);
            if (part.state?.status === 'error') {
              const err = String(part.state?.error ?? '');
              if (/rule which prevents|denied|not allowed/i.test(err)) denials.push(action);
              onActivity({ level: 'warn', text: `${action} → bloqueado/error: ${truncate(redact(err), 160)}` });
            } else {
              onActivity({ level: 'info', text: action, action });
            }
            break;
          }
          case 'step_finish':
            if (part.reason === 'stop') onActivity({ level: 'success', text: `Respuesta completa · ${part.tokens?.total ?? '?'} tokens` });
            break;
          case 'error': {
            const msg = String(ev.error?.data?.message ?? ev.error?.message ?? ev.error?.name ?? JSON.stringify(ev.error ?? ev));
            errors.push(msg);
            onActivity({ level: 'error', text: truncate(redact(msg), 240) });
            break;
          }
        }
      },
    });

    let model: string | null = null;
    if (sessionId) model = await this.readSessionModel(sessionId);
    if (model) this.lastModel = model;

    const text = texts.join('\n');
    const base = { exitCode: r.exitCode, sessionId, model, text, structured: extractLastJson(text), permissionDenials: denials, durationMs: r.durationMs };
    if (r.spawnError) return { ...base, ok: false, errorKind: r.spawnError.code === 'ENOENT' ? 'not_found' : 'execution', errorMessage: r.spawnError.message };
    if (r.cancelled) return { ...base, ok: false, errorKind: 'cancelled', errorMessage: 'Ejecución cancelada por el usuario.' };
    if (r.timedOut) return { ...base, ok: false, errorKind: 'timeout', errorMessage: `Se superó el tiempo máximo (${Math.round(req.timeoutMs / 60000)} min).` };
    if (r.exitCode !== 0 || errors.length || !text.trim()) {
      const detail = redact([...errors, r.stderr.replace(/\x1b\[[0-9;]*m/g, '')].join(' ').trim()) || (text.trim() ? `código de salida ${r.exitCode}` : 'OpenCode no devolvió respuesta');
      return { ...base, ok: false, errorKind: classifyError(detail), errorMessage: truncate(detail, 400) };
    }
    return { ...base, ok: true, errorKind: null, errorMessage: null };
  }

  /** Modelo real usado por la sesión (OpenCode no lo emite en los eventos de `run`). */
  private async readSessionModel(sessionId: string): Promise<string | null> {
    if (!this.exe) return null;
    const r = await runProcess(this.exe, { cwd: process.cwd(), args: [...(this.opts.prefixArgs ?? []), ...['export', sessionId]], timeoutMs: 20_000 });
    try {
      const j = JSON.parse(r.stdout.slice(r.stdout.indexOf('{')));
      const m = j?.info?.model;
      if (m?.id) return m.providerID ? `${m.providerID}/${m.id}` : m.id;
    } catch {
      /* formato desconocido: se ignora */
    }
    return null;
  }
}

/** Si el usuario ya usa OPENCODE_CONFIG_CONTENT, se fusiona en vez de reemplazarlo. */
function mergeUserConfig(existing: string | undefined): Record<string, any> {
  let base: Record<string, any> = {};
  try {
    if (existing) base = JSON.parse(existing);
  } catch {
    base = {};
  }
  return { ...base, agent: { ...(base.agent ?? {}), ...QA_AGENT_CONFIG.agent } };
}

function describeOpenCodeTool(tool: string, input: any): string {
  const i = input ?? {};
  const file = i.filePath || i.path;
  switch (tool) {
    case 'read': return `Revisando ${short(file)}`;
    case 'glob': return `Buscando archivos ${i.pattern ?? ''}`;
    case 'grep': return `Buscando "${truncate(String(i.pattern ?? ''), 60)}"`;
    case 'bash': return `Ejecutando: ${truncate(redact(String(i.command ?? '')), 120)}`;
    case 'list': return `Listando ${short(i.path ?? '.')}`;
    case 'todowrite': return 'Actualizando checklist de QA';
    case 'invalid': return `Herramienta no disponible (${i.tool ?? '?'})`;
    default: return `Herramienta ${tool}`;
  }
}

function short(p: unknown): string {
  const s = String(p ?? '');
  const parts = s.split(/[\\/]/);
  return parts.length > 3 ? `…/${parts.slice(-3).join('/')}` : s;
}
