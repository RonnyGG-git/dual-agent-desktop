import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { readJson, subDir, writeJsonAtomic } from './paths';

export interface RunOptions {
  cwd: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  stdin?: string;
  timeoutMs: number;
  signal?: AbortSignal;
  onStdoutLine?: (line: string) => void;
  onStderr?: (chunk: string) => void;
}

export interface RunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cancelled: boolean;
  spawnError: NodeJS.ErrnoException | null;
  durationMs: number;
}

const MAX_CAPTURE = 2 * 1024 * 1024;

/**
 * Ejecuta un proceso SIN shell (los argumentos no se interpretan), con
 * límite de tiempo, cancelación y muerte del árbol completo de procesos.
 * Cada PID vivo queda registrado en disco para limpiar huérfanos si la app muere.
 */
export function runProcess(executable: string, opts: RunOptions): Promise<RunResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let lineBuf = '';
    let timedOut = false;
    let cancelled = false;
    let settled = false;
    let child: ChildProcess;

    try {
      child = spawn(executable, opts.args, {
        cwd: opts.cwd,
        env: opts.env ?? process.env,
        windowsHide: true,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      resolve({ exitCode: null, stdout, stderr, timedOut, cancelled, spawnError: err as NodeJS.ErrnoException, durationMs: 0 });
      return;
    }

    if (child.pid) PidRegistry.add(child.pid, path.basename(executable));

    const finish = (exitCode: number | null, spawnError: NodeJS.ErrnoException | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      if (child.pid) PidRegistry.remove(child.pid);
      if (lineBuf.trim()) opts.onStdoutLine?.(lineBuf);
      resolve({ exitCode, stdout, stderr, timedOut, cancelled, spawnError, durationMs: Date.now() - started });
    };

    const onAbort = () => {
      cancelled = true;
      killTree(child.pid);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, opts.timeoutMs);

    if (opts.signal?.aborted) onAbort();
    else opts.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => {
      if (stdout.length < MAX_CAPTURE) stdout += chunk;
      lineBuf += chunk;
      let idx: number;
      while ((idx = lineBuf.indexOf('\n')) >= 0) {
        const line = lineBuf.slice(0, idx).replace(/\r$/, '');
        lineBuf = lineBuf.slice(idx + 1);
        if (line) opts.onStdoutLine?.(line);
      }
    });
    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data', (chunk: string) => {
      if (stderr.length < MAX_CAPTURE) stderr += chunk;
      opts.onStderr?.(chunk);
    });
    child.stdin!.on('error', () => {});
    child.stdin!.end(opts.stdin ?? '');

    child.on('error', (err) => finish(null, err as NodeJS.ErrnoException));
    child.on('close', (code) => finish(code, null));
  });
}

/** Mata el proceso y todos sus hijos (en Windows, `kill()` solo mataría el padre). */
export function killTree(pid: number | undefined): void {
  if (!pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  } else {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* ya terminó */
      }
    }
  }
}

/** Registro en disco de procesos de agentes en curso, para eliminar huérfanos tras un cierre abrupto. */
export const PidRegistry = {
  file: () => path.join(subDir('run'), 'pids.json'),
  read(): Record<string, string> {
    return readJson<Record<string, string>>(this.file(), {});
  },
  add(pid: number, image: string) {
    const all = this.read();
    all[pid] = image;
    writeJsonAtomic(this.file(), all);
  },
  remove(pid: number) {
    const all = this.read();
    delete all[pid];
    writeJsonAtomic(this.file(), all);
  },
  /** Mata los PID registrados que siguen vivos y cuyo ejecutable coincide (evita matar un PID reciclado). */
  cleanupOrphans(): number {
    const all = this.read();
    let killed = 0;
    for (const [pid, image] of Object.entries(all)) {
      if (process.platform === 'win32') {
        const r = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
        if (r.stdout && r.stdout.toLowerCase().includes(`"${image.toLowerCase()}"`)) {
          killTree(Number(pid));
          killed++;
        }
      }
    }
    writeJsonAtomic(this.file(), {});
    return killed;
  },
  killAll() {
    for (const pid of Object.keys(this.read())) killTree(Number(pid));
    writeJsonAtomic(this.file(), {});
  },
};
