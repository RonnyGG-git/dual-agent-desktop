import { STAGES, type LightState, type StageId } from '../../shared/types';

const STATE_LABEL: Record<LightState, string> = {
  pending: 'pendiente',
  active: 'en proceso',
  done: 'completada',
  error: 'error',
};

export function StageLights({ stages }: { stages: Record<StageId, LightState> }) {
  return (
    <section className="panel shrink-0 px-6 py-4" aria-label="Progreso de la tarea">
      <ol className="flex items-start justify-between">
        {STAGES.map((s, i) => (
          <li key={s.id} className="relative flex flex-1 flex-col items-center gap-2.5">
            {i > 0 && (
              <span
                aria-hidden
                className={`absolute top-[11px] h-px transition-colors duration-500 ${
                  stages[STAGES[i - 1].id] === 'done' ? 'bg-emerald-400/40' : 'bg-white/[0.07]'
                }`}
                style={{ left: 'calc(-50% + 20px)', right: 'calc(50% + 20px)' }}
              />
            )}
            <span className="led relative z-10" data-state={stages[s.id]} data-testid={`led-${s.id}`} role="img" aria-label={`${s.label}: ${STATE_LABEL[stages[s.id]]}`} />
            <span className={`text-[11px] font-semibold tracking-[0.12em] ${stages[s.id] === 'pending' ? 'text-ink-500' : 'text-ink-100'}`}>{s.label}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
