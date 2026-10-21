import type { AgentId, ErrorKind, Level } from '../../shared/types';
import type { PolicyMode } from '../security/policy';

export interface AgentProbe {
  executable: string | null;
  version: string | null;
  model: string | null;
  auth: { ok: boolean | null; detail: string };
}

export interface AgentActivity {
  level: Level;
  text: string;
  /** Acción concreta (herramienta usada, archivo editado...) para "última acción". */
  action?: string;
  model?: string;
  sessionId?: string;
}

export interface AgentRunRequest {
  taskId: string;
  prompt: string;
  cwd: string;
  mode: PolicyMode;
  /** JSON Schema de la respuesta estructurada esperada (si la CLI lo soporta). */
  jsonSchema?: string;
  resumeSessionId?: string | null;
  policyFile?: string;
  timeoutMs: number;
  signal: AbortSignal;
}

export interface AgentRunResult {
  ok: boolean;
  exitCode: number | null;
  sessionId: string | null;
  model: string | null;
  /** Texto final de la respuesta del agente. */
  text: string;
  /** Salida estructurada ya parseada (si la CLI la entregó). */
  structured: unknown | null;
  errorKind: ErrorKind | null;
  errorMessage: string | null;
  permissionDenials: string[];
  durationMs: number;
}

export interface AgentAdapter {
  readonly id: AgentId;
  detect(): Promise<AgentProbe>;
  run(req: AgentRunRequest, onActivity: (a: AgentActivity) => void): Promise<AgentRunResult>;
}

const AUTH_RE = /not logged in|please run \/login|\/login|invalid api key|authentication[_ ]?(error|failed)|unauthori[sz]ed|\b401\b|ProviderAuthError|no credentials|oauth token (has )?expired|credit balance is too low/i;
const RATE_RE = /rate[ _-]?limit|usage limit|\b429\b|quota|overloaded|too many requests|limit reached|resets at/i;

/** Distingue errores de autenticación, límites de uso y fallos de ejecución. */
export function classifyError(text: string, fallback: ErrorKind = 'execution'): ErrorKind {
  if (AUTH_RE.test(text)) return 'auth';
  if (RATE_RE.test(text)) return 'rate_limit';
  return fallback;
}

/** Elimina cualquier cosa parecida a un token o clave antes de mostrar o registrar texto. */
export function redact(text: string): string {
  return text
    .replace(/sk-[a-zA-Z0-9_-]{16,}/g, 'sk-***')
    .replace(/(bearer\s+)[\w.-]{16,}/gi, '$1***')
    .replace(/("?(?:api[_-]?key|token|password|secret|authorization)"?\s*[:=]\s*"?)[^"\s,}]{6,}/gi, '$1***');
}

export function truncate(s: string, n: number): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}
