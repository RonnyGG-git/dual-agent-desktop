import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Resuelve el ejecutable REAL de una CLI.
 *
 * Una app gráfica no hereda el PATH de una sesión de PowerShell (p. ej. tras
 * instalar algo sin cerrar sesión), así que se combinan: PATH del proceso, PATH
 * de usuario y de sistema leídos del registro, y %APPDATA%\npm.
 * Los shims de npm (`claude.cmd`) se desenvuelven hasta el `.exe` que invocan,
 * para poder lanzarlo sin `cmd.exe` (sin problemas de escape de argumentos).
 */
export function resolveExecutable(name: string): string | null {
  const override = process.env[`DAD_${name.toUpperCase()}_PATH`];
  if (override) return fs.existsSync(override) ? override : null;

  const dirs = searchDirs();
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      if (!isFile(candidate)) continue;
      if (/\.(cmd|bat)$/i.test(candidate)) {
        const target = unwrapShim(candidate);
        if (target) return target;
        continue;
      }
      return candidate;
    }
  }
  return null;
}

function searchDirs(): string[] {
  const parts = new Set<string>();
  const add = (s: string | undefined) =>
    (s || '')
      .split(path.delimiter)
      .map((p) => p.trim().replace(/^"|"$/g, ''))
      .filter(Boolean)
      .forEach((p) => parts.add(expandEnv(p)));
  add(process.env.PATH || process.env.Path);
  if (process.platform === 'win32') {
    add(readRegistryPath('HKCU\\Environment'));
    add(readRegistryPath('HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment'));
    if (process.env.APPDATA) parts.add(path.join(process.env.APPDATA, 'npm'));
    if (process.env.USERPROFILE) parts.add(path.join(process.env.USERPROFILE, '.local', 'bin'));
  }
  return [...parts];
}

function readRegistryPath(key: string): string {
  const r = spawnSync('reg', ['query', key, '/v', 'Path'], { encoding: 'utf8', windowsHide: true });
  const m = /Path\s+REG_(?:EXPAND_)?SZ\s+(.*)/i.exec(r.stdout || '');
  return m ? m[1].trim() : '';
}

function expandEnv(p: string): string {
  return p.replace(/%([^%]+)%/g, (_, v) => process.env[v] ?? `%${v}%`);
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Lee un shim .cmd de npm y devuelve la ruta del .exe que ejecuta, si existe. */
export function unwrapShim(cmdFile: string): string | null {
  let text: string;
  try {
    text = fs.readFileSync(cmdFile, 'utf8');
  } catch {
    return null;
  }
  const m = /"%dp0%\\?([^"]+?\.exe)"/i.exec(text);
  if (!m) return null;
  const target = path.join(path.dirname(cmdFile), m[1]);
  return isFile(target) ? target : null;
}

/** Ruta de un ejecutable de Windows que se invoca mediante cmd (npm, mvn, gradlew). */
export function findOnPath(name: string): string | null {
  for (const dir of searchDirs()) {
    for (const ext of ['.cmd', '.exe', '.bat']) {
      const c = path.join(dir, name + ext);
      if (isFile(c)) return c;
    }
  }
  return null;
}
