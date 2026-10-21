import { AlertTriangle, Code2, FlaskConical, Plug, PlugZap } from 'lucide-react';
import { useEffect, useRef } from 'react';
import type { AgentState, AgentStatus } from '../../shared/types';

const STATUS: Record<AgentStatus, { label: string; cls: string }> = {
  offline: { label: 'Sin conexión', cls: 'bg-coal-700 text-ink-400' },
  idle: { label: 'Esperando', cls: 'bg-coal-700 text-ink-300' },
  working: { label: 'Trabajando', cls: 'bg-amber-400/15 text-amber-300' },
  done: { label: 'Terminado', cls: 'bg-emerald-400/15 text-emerald-300' },
  error: { label: 'Error', cls: 'bg-red-400/15 text-red-300' },
};

const ERROR_KIND: Record<string, string> = {
  auth: 'Autenticación',
  rate_limit: 'Límite de uso',
  not_found: 'No encontrado',
  execution: 'Fallo de ejecución',
  timeout: 'Tiempo agotado',
  cancelled: 'Cancelado',
  invalid_output: 'Respuesta inválida',
  test_failure: 'Defectos detectados',
  policy: 'Seguridad',
};

export function AgentPanel({ agent }: { agent: AgentState }) {
  const accent = agent.id === 'claude' ? 'text-claude' : 'text-opencode';
  const ring = agent.id === 'claude' ? 'ring-claude/30 bg-claude/10' : 'ring-opencode/30 bg-opencode/10';
  const Icon = agent.id === 'claude' ? Code2 : FlaskConical;
  const st = STATUS[agent.status];
  const feedRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = feedRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [agent.activity.length]);

  return (
    <section className="panel flex min-h-0 flex-col p-4" aria-label={`Agente ${agent.name}`} data-testid={`agent-${agent.id}`}>
      <header className="flex items-center gap-3">
        <div className={`flex h-11 w-11 items-center justify-center rounded-xl ring-1 ${ring}`}>
          <Icon size={22} className={accent} />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-[15px] font-semibold tracking-wide">{agent.name.toUpperCase()}</h2>
          <p className="text-xs text-ink-400">{agent.role}</p>
        </div>
        <span className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${st.cls}`} data-testid={`status-${agent.id}`}>
          <span className="status-dot h-1.5 w-1.5 rounded-full bg-current" data-status={agent.status} />
          {st.label}
        </span>
      </header>

      <dl className="mt-3 grid grid-cols-[104px_1fr] gap-x-3 gap-y-1 text-[13px]">
        <dt className="text-ink-500">Conexión</dt>
        <dd className="flex items-center gap-1.5">
          {agent.connected ? <PlugZap size={13} className="text-emerald-400" /> : <Plug size={13} className="text-ink-500" />}
          <span className={agent.connected ? 'text-ink-100' : 'text-ink-400'}>
            {agent.connected ? `Conectado · v${agent.version?.replace(/\s*\(.*\)/, '')}` : 'No disponible'}
          </span>
        </dd>
        <dt className="text-ink-500">Autenticación</dt>
        <dd className={agent.auth.ok === false ? 'text-red-300' : 'text-ink-300'} title={agent.auth.detail}>
          <span className="line-clamp-1">{agent.auth.detail}</span>
        </dd>
        <dt className="text-ink-500">Modelo</dt>
        <dd className="truncate font-mono text-[12px] text-ink-300">{agent.model ?? 'predeterminado de la CLI (se muestra al ejecutar)'}</dd>
        <dt className="text-ink-500">Tarea actual</dt>
        <dd className="truncate text-ink-100">{agent.currentTask ?? '—'}</dd>
        <dt className="text-ink-500">Última acción</dt>
        <dd className="truncate text-ink-300" title={agent.lastAction ?? ''}>{agent.lastAction ?? '—'}</dd>
      </dl>

      <div className="mt-3 flex min-h-0 flex-1 flex-col">
        <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-ink-500">Actividad en tiempo real</div>
        <div ref={feedRef} className="min-h-[72px] flex-1 overflow-y-auto rounded-xl bg-coal-950/60 p-3 font-mono text-[11.5px] leading-relaxed ring-1 ring-white/[0.04]">
          {agent.activity.length === 0 ? (
            <p className="text-ink-500">Sin actividad.</p>
          ) : (
            agent.activity.map((l, i) => (
              <p key={`${l.ts}-${i}`} className={`fade-in break-words ${lineColor(l.level)}`}>
                <span className="text-ink-500">{time(l.ts)} </span>
                {l.text}
              </p>
            ))
          )}
        </div>
      </div>

      {agent.lastError && (
        <div className="mt-3 flex items-start gap-2 rounded-xl bg-red-500/10 px-3 py-2 text-[12.5px] text-red-200 ring-1 ring-red-400/20" role="alert">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <span className="line-clamp-3">
            <strong className="font-semibold">{ERROR_KIND[agent.lastError.kind] ?? agent.lastError.kind}:</strong> {agent.lastError.message}
          </span>
        </div>
      )}
    </section>
  );
}

function lineColor(level: string) {
  return level === 'error' ? 'text-red-300' : level === 'warn' ? 'text-amber-200' : level === 'success' ? 'text-emerald-300' : 'text-ink-300';
}

export function time(ts: number) {
  return new Date(ts).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
