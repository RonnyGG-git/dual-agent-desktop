import fs from 'node:fs';
import path from 'node:path';
import type { TaskRecord, TaskSummaryItem } from '../../shared/types';
import { readJson, subDir, writeJsonAtomic } from './paths';

/** Historial persistente: un JSON por tarea en %LOCALAPPDATA%\DualAgentDesktop\tasks. */
export class HistoryStore {
  private dir = subDir('tasks');

  save(task: TaskRecord): void {
    writeJsonAtomic(path.join(this.dir, `${task.id}.json`), task);
  }

  get(id: string): TaskRecord | null {
    if (!/^[\w-]+$/.test(id)) return null;
    return readJson<TaskRecord | null>(path.join(this.dir, `${id}.json`), null);
  }

  list(limit = 50): TaskSummaryItem[] {
    const files = fs.readdirSync(this.dir).filter((f) => f.endsWith('.json'));
    const items: TaskSummaryItem[] = [];
    for (const f of files) {
      const t = readJson<TaskRecord | null>(path.join(this.dir, f), null);
      if (!t) continue;
      items.push({
        id: t.id,
        instruction: t.instruction,
        status: t.status,
        createdAt: t.createdAt,
        attempts: t.attempts,
        projectPath: t.projectPath,
      });
    }
    return items.sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
  }

  /** Tareas que quedaron "running" porque la app se cerró a mitad: se marcan como canceladas. */
  recoverInterrupted(): number {
    let n = 0;
    for (const item of this.list(1000)) {
      if (item.status !== 'running') continue;
      const t = this.get(item.id);
      if (!t) continue;
      t.status = 'cancelled';
      t.finalResult = 'Interrumpida: la aplicación se cerró mientras la tarea estaba en curso.';
      t.events.push({ ts: Date.now(), level: 'warn', stage: t.currentStage, agent: 'orchestrator', message: t.finalResult });
      this.save(t);
      n++;
    }
    return n;
  }
}
