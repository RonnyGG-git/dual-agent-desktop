import fs from 'node:fs';
import path from 'node:path';
import type { AgentId } from '../../shared/types';
import { readJson, subDir, writeJsonAtomic } from '../services/paths';

interface LockInfo {
  taskId: string;
  agent: AgentId;
  pid: number;
  acquiredAt: number;
}

/**
 * Bloqueo de escritura del workspace. Solo un agente de una tarea puede
 * escribir a la vez; el hook guardián lo comprueba antes de cada escritura,
 * así que no depende de que el agente "obedezca".
 */
export class WriteLock {
  readonly file = path.join(subDir('run'), 'workspace.lock');

  current(): LockInfo | null {
    const l = readJson<LockInfo | null>(this.file, null);
    if (!l) return null;
    // Bloqueo de un proceso de la app que ya no existe: se considera libre.
    if (l.pid !== process.pid && !pidAlive(l.pid)) return null;
    return l;
  }

  acquire(taskId: string, agent: AgentId): boolean {
    const cur = this.current();
    if (cur && !(cur.taskId === taskId && cur.agent === agent)) return false;
    writeJsonAtomic(this.file, { taskId, agent, pid: process.pid, acquiredAt: Date.now() } satisfies LockInfo);
    return true;
  }

  release(taskId: string): void {
    const cur = this.current();
    if (!cur || cur.taskId === taskId) {
      try {
        fs.unlinkSync(this.file);
      } catch {
        /* ya no existía */
      }
    }
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
