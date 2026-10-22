import { History, RefreshCw, Settings as SettingsIcon, X } from 'lucide-react';
import { useState } from 'react';
import type { LightState, StageId } from '../shared/types';
import { ActivityFeed } from './components/ActivityFeed';
import { AgentPanel } from './components/AgentPanel';
import { HistoryDrawer } from './components/HistoryDrawer';
import { InstructionBar } from './components/InstructionBar';
import { SettingsDialog } from './components/SettingsDialog';
import { StageLights } from './components/StageLights';
import { WorkspaceMenu } from './components/WorkspaceMenu';
import { useDualAgent } from './hooks/useDualAgent';

const IDLE_STAGES: Record<StageId, LightState> = { review: 'pending', develop: 'pending', test: 'pending', document: 'pending', done: 'pending' };

export default function App() {
  const { snapshot, error, setError, submit, cancel, refresh } = useDualAgent();
  const [showHistory, setShowHistory] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  if (!snapshot) {
    return <div className="flex h-full items-center justify-center text-sm text-ink-500">Iniciando Dual Agent Desktop…</div>;
  }

  const ws = snapshot.workspace;
  const wsOk = Boolean(ws?.exists && ws.readable && ws.writable);
  const agentsReady = snapshot.agents.claude.connected && snapshot.agents.opencode.connected;

  return (
    <div className="mx-auto flex h-full max-w-[1500px] flex-col gap-3 overflow-y-auto px-5 pb-4 pt-3">
      <header className="flex items-center gap-3 text-[13px]">
        <div className="flex items-center gap-2">
          <span className="flex h-6 w-6 items-center justify-center rounded-md bg-gradient-to-br from-claude to-opencode text-[11px] font-bold text-coal-950">DA</span>
          <span className="font-semibold tracking-wide">Dual Agent Desktop</span>
        </div>
        <WorkspaceMenu ws={ws} recent={snapshot.settings.recentWorkspaces} busy={snapshot.busy} onError={setError} />
        <div className="ml-auto flex items-center gap-1">
          <IconButton
            label="Volver a comprobar herramientas"
            onClick={async () => {
              setRefreshing(true);
              await refresh().finally(() => setRefreshing(false));
            }}
          >
            <RefreshCw size={15} className={refreshing ? 'animate-spin' : ''} />
          </IconButton>
          <IconButton label="Historial" onClick={() => setShowHistory(true)}>
            <History size={15} />
          </IconButton>
          <IconButton label="Configuración" onClick={() => setShowSettings(true)}>
            <SettingsIcon size={15} />
          </IconButton>
        </div>
      </header>

      <InstructionBar busy={snapshot.busy} disabled={!wsOk || !agentsReady} onSubmit={submit} onCancel={() => void cancel()} />

      {error && (
        <div className="fade-in -mt-2 flex items-center gap-2 rounded-xl bg-red-500/10 px-4 py-2 text-[13px] text-red-200 ring-1 ring-red-400/20" role="alert">
          <span className="flex-1">{error}</span>
          <button onClick={() => setError(null)} aria-label="Cerrar aviso" className="text-red-300 hover:text-red-100">
            <X size={14} />
          </button>
        </div>
      )}

      <div className="grid min-h-[330px] flex-1 grid-cols-1 gap-3 md:grid-cols-2">
        <AgentPanel agent={snapshot.agents.claude} />
        <AgentPanel agent={snapshot.agents.opencode} />
      </div>

      <StageLights stages={snapshot.task?.stages ?? IDLE_STAGES} />

      <ActivityFeed task={snapshot.task} />

      {showHistory && <HistoryDrawer onClose={() => setShowHistory(false)} />}
      {showSettings && <SettingsDialog settings={snapshot.settings} busy={snapshot.busy} onClose={() => setShowSettings(false)} />}
    </div>
  );
}

function IconButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} title={label} aria-label={label} className="rounded-lg p-2 text-ink-400 transition hover:bg-coal-800 hover:text-ink-100">
      {children}
    </button>
  );
}
