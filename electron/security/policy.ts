import path from 'node:path';
import { subDir, writeJsonAtomic } from '../services/paths';

export type PolicyMode = 'readonly' | 'write' | 'docs';

export interface TaskPolicy {
  taskId: string;
  workspace: string;
  mode: PolicyMode;
  writableRoots: string[];
  backupDir: string;
  lockFile: string;
  denyCommands: string[];
}

/**
 * Comandos que el desarrollador nunca puede ejecutar sin intervención humana.
 * Se aplican en el hook guardián (impuesto por Claude Code) y además como
 * `--disallowedTools`. Son regex insensibles a mayúsculas.
 */
export const DENY_COMMANDS: string[] = [
  String.raw`(^|[\s;&|(])(rm|rmdir|rd|del|erase|unlink|shred)(\s|$)`,
  String.raw`\b(Remove-Item|ri|Clear-Content|Clear-Item|Move-Item|Rename-Item)\b`,
  String.raw`(^|[\s;&|(])(mv|move|ren|rename)\s`,
  String.raw`\bgit\s+(reset|clean|push|rebase|restore|rm|mv|filter-branch|filter-repo|update-ref|gc|prune|reflog|commit|merge|cherry-pick|revert|tag|switch|worktree)\b`,
  String.raw`\bgit\s+checkout\b`,
  String.raw`\bgit\s+branch\s+-(d|D|m|M)\b`,
  String.raw`\bgit\s+stash\b`,
  String.raw`\b(format|diskpart|mkfs|fdisk|bcdedit|cipher\s+/w)\b`,
  String.raw`\b(shutdown|Stop-Computer|Restart-Computer|taskkill|Stop-Process)\b`,
  String.raw`\breg(\.exe)?\s+(delete|add|import)\b`,
  String.raw`\b(Invoke-Expression|iex|Invoke-WebRequest|iwr|Start-BitsTransfer)\b`,
  String.raw`\b(curl|wget)\b[^\n]*\|\s*(sh|bash|pwsh|powershell|iex)`,
  String.raw`\bSet-ExecutionPolicy\b`,
  String.raw`\bnpm\s+(publish|unpublish|login|adduser|token)\b`,
  String.raw`\b(drop\s+(database|table|schema)|truncate\s+table)\b`,
  String.raw`--force\b|\s-f\s+origin\b`,
];

export function writePolicy(p: TaskPolicy): string {
  const file = path.join(subDir('policies'), `${p.taskId}.json`);
  writeJsonAtomic(file, p);
  return file;
}

/** Ruta del hook guardián (dentro del asar no se puede ejecutar: se usa la copia desempaquetada). */
export function guardHookPath(appRoot: string): string {
  return path.join(appRoot, 'electron', 'security', 'guard-hook.cjs').replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
}
