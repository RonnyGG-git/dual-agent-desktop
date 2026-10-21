import { useEffect, useRef } from 'react';
import type { TaskRecord } from '../../shared/types';
import { time } from './AgentPanel';

const AGENT_TAG: Record<string, string> = {
  claude: 'text-claude',
  opencode: 'text-opencode',
  orchestrator: 'text-ink-300',
  tests: 'text-violet-300',
};
const AGENT_NAME: Record<string, string> = { claude: 'Claude', opencode: 'OpenCode', orchestrator: 'Orquestador', tests: 'Pruebas' };

const STATUS: Record<TaskRecord['status'], { label: string; cls: string }> = {
  running: { label: 'En curso', cls: 'text-amber-300' },
  completed: { label: 'Completada', cls: 'text-emerald-300' },
  failed: { label: 'Fallida', cls: 'text-red-300' },
  cancelled: { label: 'Cancelada', cls: 'text-ink-400' },
};

export function ActivityFeed({ task }: { task: TaskRecord | null }) {
  const ref = useRef<HTMLDivElement>(null);
  const events = task?.events.slice(-80) ?? [];

  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [events.length]);

  return (
    <section className="panel flex shrink-0 flex-col px-5 py-3" aria-label="Actividad reciente">
      <header className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
        <span className="font-medium uppercase tracking-wider text-ink-500">Actividad reciente</span>
        {task && (
          <>
            <span className={STATUS[task.status].cls} data-testid="task-status">{STATUS[task.status].label}</span>
            <span className="text-ink-400">Intento {Math.max(task.attempts, 1)}/{task.maxAttempts}</span>
            {task.projectPath && <span className="truncate font-mono text-ink-400">{task.projectPath}</span>}
            <span className="ml-auto font-mono text-ink-500">{task.id}</span>
          </>
        )}
      </header>
      <div ref={ref} className="h-[104px] overflow-y-auto pr-1 text-[12.5px] leading-[1.6]">
        {events.length === 0 ? (
          <p className="text-ink-500">Escribe una instrucción para empezar. Claude revisará y desarrollará; OpenCode probará y validará.</p>
        ) : (
          events.map((e, i) => (
            <p key={`${e.ts}-${i}`} className="fade-in flex gap-2">
              <span className="shrink-0 font-mono text-[11.5px] text-ink-500">{time(e.ts)}</span>
              <span className={`w-[78px] shrink-0 font-medium ${AGENT_TAG[e.agent]}`}>{AGENT_NAME[e.agent]}</span>
              <span className={e.level === 'error' ? 'text-red-300' : e.level === 'warn' ? 'text-amber-200' : e.level === 'success' ? 'text-emerald-300' : 'text-ink-300'}>{e.message}</span>
            </p>
          ))
        )}
      </div>
    </section>
  );
}
