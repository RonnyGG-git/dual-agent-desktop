import { Check, ChevronDown, ExternalLink, FolderGit2, FolderOpen } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { WorkspaceStatus } from '../../shared/types';

interface Props {
  ws: WorkspaceStatus | null;
  recent: string[];
  busy: boolean;
  onError: (msg: string) => void;
}

/** Carpeta de trabajo actual con selector: recientes, otra carpeta o abrir en el explorador. */
export function WorkspaceMenu({ ws, recent, busy, onError }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const wsOk = Boolean(ws?.exists && ws.readable && ws.writable);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);

  const run = async (p: Promise<{ ok: boolean; error?: string } | null>) => {
    setOpen(false);
    const r = await p;
    if (r && !r.ok) onError(r.error ?? 'No se pudo cambiar la carpeta de trabajo.');
  };
  const same = (a: string, b?: string) => a.toLowerCase() === b?.toLowerCase();

  return (
    <div ref={ref} className="relative ml-3 min-w-0">
      <button
        onClick={() => setOpen((o) => !o)}
        title={ws ? `${ws.path}\nGit: ${ws.isGitRepo ? `sí (${ws.gitBranch})` : 'no'} · cambios previos del usuario: ${ws.preexistingChanges}` : ''}
        aria-haspopup="menu"
        aria-expanded={open}
        className={`flex min-w-0 max-w-full items-center gap-1.5 rounded-lg px-2.5 py-1 ring-1 transition hover:bg-coal-800 ${wsOk ? 'text-ink-300 ring-white/[0.06]' : 'text-red-300 ring-red-400/30'}`}
        data-testid="workspace"
      >
        <FolderGit2 size={14} className="shrink-0" />
        <span className="truncate font-mono text-[12px]">{ws?.path ?? '…'}</span>
        {ws && (
          <span className="shrink-0 text-ink-500">
            · {!ws.exists ? 'no existe' : !wsOk ? 'sin permisos' : ws.isGitRepo ? `git ${ws.gitBranch}` : 'sin git'}
          </span>
        )}
        <ChevronDown size={13} className="shrink-0 text-ink-500" />
      </button>

      {open && (
        <div role="menu" className="panel fade-in absolute left-0 top-full z-30 mt-1 w-[min(460px,80vw)] p-1.5 text-[12.5px] shadow-xl">
          <p className="px-2.5 pb-1 pt-1.5 text-[11px] uppercase tracking-wider text-ink-500">Carpeta de trabajo</p>
          {recent.map((p) => (
            <button
              key={p}
              role="menuitem"
              disabled={busy}
              onClick={() => void run(same(p, ws?.path) ? Promise.resolve(null) : window.dad.setWorkspace(p))}
              className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left hover:bg-coal-700 disabled:opacity-40"
            >
              <Check size={13} className={same(p, ws?.path) ? 'text-emerald-400' : 'invisible'} />
              <span className="truncate font-mono">{p}</span>
            </button>
          ))}
          <div className="my-1 h-px bg-white/[0.06]" />
          <button role="menuitem" disabled={busy} onClick={() => void run(window.dad.chooseWorkspace())} className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left hover:bg-coal-700 disabled:opacity-40">
            <FolderOpen size={13} /> Elegir otra carpeta…
          </button>
          <button
            role="menuitem"
            onClick={() => {
              setOpen(false);
              void window.dad.openPath('workspace');
            }}
            className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left hover:bg-coal-700"
          >
            <ExternalLink size={13} /> Abrir en el explorador
          </button>
          {busy && <p className="px-2.5 pb-1 pt-1 text-[11px] text-amber-200">No se puede cambiar con una tarea en curso.</p>}
        </div>
      )}
    </div>
  );
}
