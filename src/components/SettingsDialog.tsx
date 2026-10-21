import { X } from 'lucide-react';
import { useState } from 'react';
import type { Settings } from '../../shared/types';

export function SettingsDialog({ settings, busy, onClose }: { settings: Settings; busy: boolean; onClose: () => void }) {
  const [s, setS] = useState<Settings>(settings);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    try {
      await window.dad.updateSettings({
        maxAttempts: s.maxAttempts,
        requireTests: s.requireTests,
        claudeModel: s.claudeModel.trim(),
        opencodeModel: s.opencodeModel.trim(),
        extraWritablePaths: s.extraWritablePaths,
        timeouts: s.timeouts,
      });
      onClose();
    } catch (e) {
      setError(String((e as Error).message ?? e));
    }
  };

  const num = (k: keyof Settings['timeouts'], label: string) => (
    <label className="flex items-center justify-between gap-3">
      <span className="text-ink-300">{label}</span>
      <input
        type="number"
        min={1}
        max={240}
        value={s.timeouts[k]}
        onChange={(e) => setS({ ...s, timeouts: { ...s.timeouts, [k]: Number(e.target.value) } })}
        className="w-20 rounded-lg bg-coal-950 px-2 py-1 text-right ring-1 ring-white/[0.08] outline-none focus:ring-white/20"
      />
    </label>
  );

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/50 backdrop-blur-[2px]" onClick={onClose}>
      <div className="panel fade-in w-[min(520px,92vw)] p-6 text-[13px]" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Configuración">
        <header className="mb-4 flex items-center">
          <h2 className="flex-1 text-sm font-semibold">Configuración</h2>
          <button onClick={onClose} className="rounded-lg p-1.5 text-ink-400 hover:bg-coal-700" aria-label="Cerrar">
            <X size={16} />
          </button>
        </header>
        <div className="space-y-3">
          <p className="text-ink-400">
            Directorio de trabajo fijo: <code className="text-ink-100">{s.workspace}</code>
          </p>
          <label className="flex items-center justify-between gap-3">
            <span className="text-ink-300">Máximo de intentos de corrección</span>
            <input
              type="number"
              min={1}
              max={10}
              value={s.maxAttempts}
              onChange={(e) => setS({ ...s, maxAttempts: Number(e.target.value) })}
              className="w-20 rounded-lg bg-coal-950 px-2 py-1 text-right ring-1 ring-white/[0.08] outline-none focus:ring-white/20"
            />
          </label>
          <label className="flex items-center justify-between gap-3">
            <span className="text-ink-300">Exigir suite de pruebas automatizadas para finalizar</span>
            <input type="checkbox" checked={s.requireTests} onChange={(e) => setS({ ...s, requireTests: e.target.checked })} className="h-4 w-4 accent-emerald-400" />
          </label>
          <label className="flex items-center justify-between gap-3">
            <span className="text-ink-300">Modelo de Claude (vacío = predeterminado)</span>
            <input value={s.claudeModel} placeholder="p. ej. sonnet" onChange={(e) => setS({ ...s, claudeModel: e.target.value })} className="w-44 rounded-lg bg-coal-950 px-2 py-1 font-mono ring-1 ring-white/[0.08] outline-none focus:ring-white/20" />
          </label>
          <label className="flex items-center justify-between gap-3">
            <span className="text-ink-300">Modelo de OpenCode (proveedor/modelo)</span>
            <input value={s.opencodeModel} placeholder="predeterminado" onChange={(e) => setS({ ...s, opencodeModel: e.target.value })} className="w-44 rounded-lg bg-coal-950 px-2 py-1 font-mono ring-1 ring-white/[0.08] outline-none focus:ring-white/20" />
          </label>
          <label className="block">
            <span className="text-ink-300">Rutas extra donde Claude puede escribir (relativas, una por línea)</span>
            <textarea
              rows={2}
              value={s.extraWritablePaths.join('\n')}
              onChange={(e) => setS({ ...s, extraWritablePaths: e.target.value.split('\n').map((x) => x.trim()).filter(Boolean) })}
              className="mt-1 w-full resize-none rounded-lg bg-coal-950 px-2 py-1 font-mono ring-1 ring-white/[0.08] outline-none focus:ring-white/20"
            />
          </label>
          <div className="space-y-2 rounded-xl bg-coal-800 p-3">
            <p className="text-xs uppercase tracking-wider text-ink-500">Tiempo máximo por etapa (minutos)</p>
            {num('reviewMin', 'Revisión')}
            {num('developMin', 'Desarrollo')}
            {num('testMin', 'Pruebas')}
            {num('qaMin', 'QA')}
            {num('documentMin', 'Documentación')}
          </div>
          {error && <p className="text-red-300">{error}</p>}
          <div className="flex justify-end gap-2 pt-1">
            <button onClick={() => void window.dad.openPath('data')} className="mr-auto rounded-lg px-3 py-1.5 text-ink-400 hover:bg-coal-700">
              Abrir datos de la app
            </button>
            <button onClick={onClose} className="rounded-lg px-3 py-1.5 text-ink-300 hover:bg-coal-700">
              Cancelar
            </button>
            <button onClick={() => void save()} disabled={busy} className="rounded-lg bg-ink-100 px-3 py-1.5 font-medium text-coal-900 hover:bg-white disabled:opacity-40">
              Guardar
            </button>
          </div>
          {busy && <p className="text-xs text-amber-200">No se puede cambiar la configuración con una tarea en curso.</p>}
        </div>
      </div>
    </div>
  );
}
