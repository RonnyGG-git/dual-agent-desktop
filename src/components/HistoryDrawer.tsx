import { ArrowLeft, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { TaskRecord, TaskSummaryItem } from '../../shared/types';

const STATUS_CLS: Record<string, string> = {
  running: 'text-amber-300',
  completed: 'text-emerald-300',
  failed: 'text-red-300',
  cancelled: 'text-ink-400',
};
const STATUS_LABEL: Record<string, string> = { running: 'en curso', completed: 'completada', failed: 'fallida', cancelled: 'cancelada' };

export function HistoryDrawer({ onClose }: { onClose: () => void }) {
  const [items, setItems] = useState<TaskSummaryItem[] | null>(null);
  const [detail, setDetail] = useState<TaskRecord | null>(null);

  useEffect(() => {
    void window.dad.listHistory().then(setItems);
  }, []);

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/40 backdrop-blur-[2px]" onClick={onClose}>
      <aside className="fade-in flex h-full w-[min(560px,92vw)] flex-col border-l border-white/[0.06] bg-coal-850 shadow-2xl" onClick={(e) => e.stopPropagation()} aria-label="Historial">
        <header className="flex items-center gap-2 border-b border-white/[0.06] px-5 py-4">
          {detail && (
            <button onClick={() => setDetail(null)} className="rounded-lg p-1.5 text-ink-400 hover:bg-coal-700 hover:text-ink-100" aria-label="Volver">
              <ArrowLeft size={16} />
            </button>
          )}
          <h2 className="flex-1 text-sm font-semibold">{detail ? `Tarea ${detail.id}` : 'Historial de ejecuciones'}</h2>
          <button onClick={onClose} className="rounded-lg p-1.5 text-ink-400 hover:bg-coal-700 hover:text-ink-100" aria-label="Cerrar">
            <X size={16} />
          </button>
        </header>
        <div className="flex-1 overflow-y-auto p-4">
          {detail ? (
            <TaskDetail task={detail} />
          ) : items === null ? (
            <p className="text-sm text-ink-500">Cargando…</p>
          ) : items.length === 0 ? (
            <p className="text-sm text-ink-500">Todavía no hay ejecuciones.</p>
          ) : (
            <ul className="space-y-2">
              {items.map((t) => (
                <li key={t.id}>
                  <button
                    onClick={() => void window.dad.getTask(t.id).then(setDetail)}
                    className="w-full rounded-xl bg-coal-800 px-4 py-3 text-left ring-1 ring-white/[0.04] hover:bg-coal-700 transition"
                  >
                    <div className="flex items-center gap-2 text-xs">
                      <span className={STATUS_CLS[t.status]}>{STATUS_LABEL[t.status]}</span>
                      <span className="text-ink-500">{new Date(t.createdAt).toLocaleString('es')}</span>
                      <span className="ml-auto text-ink-500">{t.attempts} intento(s)</span>
                    </div>
                    <p className="mt-1 line-clamp-2 text-sm text-ink-100">{t.instruction}</p>
                    {t.projectPath && <p className="mt-0.5 truncate font-mono text-[11px] text-ink-400">{t.projectPath}</p>}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </aside>
    </div>
  );
}

function TaskDetail({ task }: { task: TaskRecord }) {
  return (
    <div className="space-y-4 text-[13px]">
      <pre className="whitespace-pre-wrap rounded-xl bg-coal-950/60 p-4 font-mono text-[12px] leading-relaxed text-ink-300 ring-1 ring-white/[0.04]">{task.summary ?? task.instruction}</pre>
      {task.testRuns.length > 0 && (
        <div>
          <h3 className="mb-1 text-xs font-medium uppercase tracking-wider text-ink-500">Ejecuciones de pruebas</h3>
          {task.testRuns.map((r, i) => (
            <p key={i} className="text-ink-300">
              Intento {r.attempt}: <span className={r.status === 'passed' ? 'text-emerald-300' : r.status === 'none' ? 'text-ink-400' : 'text-red-300'}>{r.status}</span> {r.command && <code className="text-ink-400">{r.command}</code>}
            </p>
          ))}
        </div>
      )}
      {task.qaReports.length > 0 && (
        <div>
          <h3 className="mb-1 text-xs font-medium uppercase tracking-wider text-ink-500">Reportes de QA</h3>
          {task.qaReports.map((r, i) => (
            <div key={i} className="mb-2 rounded-lg bg-coal-800 p-3">
              <p className={r.accepted ? 'text-emerald-300' : 'text-red-300'}>
                Revisión {r.attempt}: {r.accepted ? 'aceptado' : 'rechazado'}
              </p>
              <p className="text-ink-300">{r.reported?.summary}</p>
              {r.reported?.issues.map((is, j) => (
                <p key={j} className="text-ink-400">
                  · [{is.severity}] {is.file ? `${is.file}: ` : ''}
                  {is.description}
                </p>
              ))}
              {r.orchestratorNotes.map((n, j) => (
                <p key={j} className="text-amber-200">· {n}</p>
              ))}
            </div>
          ))}
        </div>
      )}
      <div>
        <h3 className="mb-1 text-xs font-medium uppercase tracking-wider text-ink-500">Eventos ({task.events.length})</h3>
        <div className="max-h-72 overflow-y-auto rounded-xl bg-coal-950/60 p-3 font-mono text-[11.5px] ring-1 ring-white/[0.04]">
          {task.events.map((e, i) => (
            <p key={i} className={e.level === 'error' ? 'text-red-300' : e.level === 'warn' ? 'text-amber-200' : 'text-ink-400'}>
              {new Date(e.ts).toLocaleTimeString('es')} [{e.agent}] {e.message}
            </p>
          ))}
        </div>
      </div>
    </div>
  );
}
