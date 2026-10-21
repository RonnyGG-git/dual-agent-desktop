import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { ChangedFile } from '../../shared/types';
import { isInside } from './paths';

/** Huella de un archivo: tamaño + mtime, o 'missing'. */
type Fingerprint = string;

export interface Snapshot {
  takenAt: number;
  /** ruta relativa (con /) -> huella */
  files: Map<string, Fingerprint>;
  /** rutas con cambios sin commitear según git al tomar la foto */
  dirty: Set<string>;
}

/** Ruido que no producen los agentes (Obsidian abierto, marcadores de hooks del vault). */
const NOISE = [/^\.obsidian\//, /^\.claude\/\.diario-pendiente\.json$/, /^\.trash\//, /(^|\/)\.DS_Store$/];
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'dist-electron', 'release', 'target', 'build', '.venv', '__pycache__', '.gradle', '.idea']);
const WALK_LIMIT = 50_000;

export function git(cwd: string, args: string[]): { ok: boolean; out: string } {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0, out: r.stdout || '' };
}

export function gitInfo(workspace: string): { isRepo: boolean; branch: string | null; dirtyCount: number } {
  const inside = git(workspace, ['rev-parse', '--is-inside-work-tree']);
  if (!inside.ok || inside.out.trim() !== 'true') return { isRepo: false, branch: null, dirtyCount: 0 };
  const branch = git(workspace, ['rev-parse', '--abbrev-ref', 'HEAD']).out.trim() || null;
  return { isRepo: true, branch, dirtyCount: gitDirty(workspace).size };
}

/** Rutas con cambios sin commitear (incluye no rastreados, sin ignorados). */
export function gitDirty(workspace: string): Set<string> {
  const r = git(workspace, ['-c', 'core.quotepath=false', 'status', '--porcelain=v1', '-z', '-uall']);
  const set = new Set<string>();
  if (!r.ok) return set;
  const tokens = r.out.split('\0');
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.length < 4) continue;
    set.add(t.slice(3));
    if (t[0] === 'R' || t[0] === 'C') i++; // el siguiente token es la ruta original
  }
  return set;
}

function fingerprint(abs: string): Fingerprint {
  try {
    const st = fs.statSync(abs);
    return st.isFile() ? `${st.size}:${Math.round(st.mtimeMs)}` : 'dir';
  } catch {
    return 'missing';
  }
}

function walk(workspace: string, rootAbs: string, out: Map<string, Fingerprint>): void {
  const stack = [rootAbs];
  while (stack.length && out.size < WALK_LIMIT) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) stack.push(abs);
      } else if (e.isFile()) {
        out.set(toRel(workspace, abs), fingerprint(abs));
      }
    }
  }
}

export function toRel(workspace: string, abs: string): string {
  return path.relative(workspace, abs).split(path.sep).join('/');
}

/**
 * Foto del estado: todos los archivos dentro de las rutas escribibles (recorrido
 * directo, fiable aunque haya repos anidados) + todo lo que git marque como sucio
 * en el workspace (para detectar cambios fuera del alcance).
 */
export function takeSnapshot(workspace: string, roots: string[]): Snapshot {
  const files = new Map<string, Fingerprint>();
  for (const r of roots) {
    const abs = path.resolve(workspace, r);
    if (fs.existsSync(abs) && isInside(workspace, abs)) walk(workspace, abs, files);
  }
  const dirty = gitDirty(workspace);
  for (const rel of dirty) if (!files.has(rel)) files.set(rel, fingerprint(path.join(workspace, rel)));
  return { takenAt: Date.now(), files, dirty };
}

/** Compara dos fotos y devuelve los archivos que cambiaron entre ambas. */
export function diffSnapshots(workspace: string, before: Snapshot, after: Snapshot, roots: string[], baseline: Snapshot = before): ChangedFile[] {
  const keys = new Set([...before.files.keys(), ...after.files.keys()]);
  const rootsAbs = roots.map((r) => path.resolve(workspace, r));
  const changes: ChangedFile[] = [];
  for (const rel of keys) {
    if (NOISE.some((re) => re.test(rel))) continue;
    const prev = before.files.get(rel) ?? (before.dirty.has(rel) ? 'missing' : undefined);
    const next = after.files.get(rel) ?? fingerprint(path.join(workspace, rel));
    if (prev === next) continue;
    let kind: ChangedFile['kind'];
    if (next === 'missing') {
      if (prev === undefined || prev === 'missing') continue;
      kind = 'deleted';
    } else if (prev === undefined) {
      // No estaba en la foto previa: o es nuevo, o era un archivo rastreado y limpio que ahora cambió.
      kind = git(workspace, ['ls-files', '--error-unmatch', '--', rel]).ok ? 'modified' : 'added';
    } else if (prev === 'missing') {
      kind = 'added';
    } else {
      kind = 'modified';
    }
    const abs = path.join(workspace, rel);
    changes.push({
      path: rel,
      kind,
      preexisting: baseline.dirty.has(rel),
      inScope: rootsAbs.some((r) => isInside(r, abs)),
    });
  }
  return changes.sort((a, b) => a.path.localeCompare(b.path));
}

/** Fusiona listas de cambios de varias etapas en una lista acumulada de la tarea. */
export function mergeChanges(acc: ChangedFile[], next: ChangedFile[]): ChangedFile[] {
  const map = new Map(acc.map((c) => [c.path, c]));
  for (const c of next) {
    const prev = map.get(c.path);
    if (!prev) map.set(c.path, c);
    else if (prev.kind === 'added' && c.kind === 'deleted') map.delete(c.path);
    else map.set(c.path, { ...c, kind: prev.kind === 'added' && c.kind === 'modified' ? 'added' : c.kind });
  }
  return [...map.values()].sort((a, b) => a.path.localeCompare(b.path));
}
