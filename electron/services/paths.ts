import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Todos los datos internos de la app viven fuera del workspace del usuario:
 * %LOCALAPPDATA%\DualAgentDesktop (sobrescribible con DAD_DATA_DIR para pruebas).
 */
export function dataDir(): string {
  const base =
    process.env.DAD_DATA_DIR ||
    path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'DualAgentDesktop');
  fs.mkdirSync(base, { recursive: true });
  return base;
}

export function subDir(name: 'tasks' | 'backups' | 'policies' | 'logs' | 'reports' | 'run'): string {
  const dir = path.join(dataDir(), name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Escritura atómica: se escribe a un temporal y se renombra, para no dejar JSON corrupto. */
export function writeJsonAtomic(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

export function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

/** true si `child` está dentro de `parent` (o es el mismo). Comparación insensible a mayúsculas en Windows. */
export function isInside(parent: string, child: string): boolean {
  const norm = (p: string) => {
    const r = path.resolve(p);
    return process.platform === 'win32' ? r.toLowerCase() : r;
  };
  const rel = path.relative(norm(parent), norm(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
