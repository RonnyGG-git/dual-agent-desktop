#!/usr/bin/env node
// Dual Agent Desktop — hook PreToolUse de Claude Code.
//
// Lo inyecta la app con `claude --settings` solo en las sesiones que ella lanza
// (se suma a los hooks del usuario, no los reemplaza). Lee la política de la
// tarea desde DAD_POLICY_FILE y bloquea con exit 2 (Claude recibe el motivo):
//   - escrituras fuera de las rutas permitidas de la tarea o sin el bloqueo de escritura,
//   - escrituras de código durante la etapa de documentación,
//   - comandos destructivos (borrar, mover, git reset/clean/push, ...).
// Antes de permitir editar un archivo existente, guarda una copia de respaldo.
// Sin DAD_POLICY_FILE no hace nada. Si la política no se puede leer, bloquea (falla cerrado).
'use strict';
const fs = require('fs');
const path = require('path');

const policyFile = process.env.DAD_POLICY_FILE;
if (!policyFile) process.exit(0);

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => (raw += d));
process.stdin.on('end', () => {
  let policy;
  try {
    policy = JSON.parse(fs.readFileSync(policyFile, 'utf8'));
  } catch {
    return block('no se pudo leer la política de seguridad de la tarea');
  }
  let input;
  try {
    input = JSON.parse(raw || '{}');
  } catch {
    return block('entrada del hook ilegible');
  }
  const tool = String(input.tool_name || '');
  const ti = input.tool_input || {};

  try {
    if (/^(Write|Edit|MultiEdit|NotebookEdit)$/.test(tool)) return checkWrite(policy, input, ti);
    if (/^(Bash|PowerShell)$/.test(tool)) return checkCommand(policy, String(ti.command || ''));
  } catch (err) {
    return block('error interno del guardián: ' + (err && err.message));
  }
  process.exit(0);
});

function norm(p) {
  const r = path.resolve(p);
  return process.platform === 'win32' ? r.toLowerCase() : r;
}
function inside(parent, child) {
  const rel = path.relative(norm(parent), norm(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function checkWrite(policy, input, ti) {
  const target = ti.file_path || ti.notebook_path;
  if (!target) return block('herramienta de escritura sin ruta');
  const abs = path.resolve(input.cwd || policy.workspace, String(target));

  if (policy.mode === 'readonly') return block('esta etapa es de solo lectura');
  if (!lockHeld(policy)) return block('la tarea no tiene el bloqueo de escritura del workspace');
  if (!policy.writableRoots.some((r) => inside(r, abs))) {
    return block(`ruta fuera del alcance de la tarea: ${abs}. Rutas permitidas: ${policy.writableRoots.join(' | ')}`);
  }
  const relParts = path.relative(policy.workspace, abs).split(path.sep).map((s) => s.toLowerCase());
  if (relParts.some((s) => s === '.git' || s === '.obsidian')) return block('no se permite modificar .git ni .obsidian');
  if (policy.mode === 'docs' && !isDocFile(abs)) {
    return block('en la etapa de documentación solo se pueden editar archivos de documentación (.md, .txt, README, CHANGELOG, docs/)');
  }
  backup(policy, abs);
  process.exit(0);
}

function isDocFile(abs) {
  const base = path.basename(abs).toLowerCase();
  return (
    /\.(md|mdx|markdown|txt|rst|adoc)$/.test(base) ||
    /^(readme|changelog|changes|history|license)(\.|$)/.test(base) ||
    abs.toLowerCase().split(path.sep).includes('docs')
  );
}

function lockHeld(policy) {
  if (!policy.lockFile) return true;
  try {
    const lock = JSON.parse(fs.readFileSync(policy.lockFile, 'utf8'));
    return lock.taskId === policy.taskId && lock.agent === 'claude';
  } catch {
    return false;
  }
}

function backup(policy, abs) {
  if (!policy.backupDir || !fs.existsSync(abs)) return;
  const rel = path.relative(policy.workspace, abs);
  const dest = path.join(policy.backupDir, rel);
  if (fs.existsSync(dest)) return; // ya respaldado en esta tarea: se conserva la versión original
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(abs, dest);
}

function checkCommand(policy, command) {
  for (const src of policy.denyCommands || []) {
    if (new RegExp(src, 'i').test(command)) {
      return block(`comando bloqueado por la política de Dual Agent Desktop (coincide con /${src}/): ${command.slice(0, 200)}`);
    }
  }
  if (policy.mode !== 'write' && /(>|Out-File|Set-Content|Add-Content|New-Item|Copy-Item|tee\s)/i.test(command)) {
    return block('esta etapa no permite escribir archivos mediante comandos');
  }
  process.exit(0);
}

function block(reason) {
  const msg = `[Dual Agent Desktop] Acción bloqueada: ${reason}`;
  try {
    if (process.env.DAD_GUARD_LOG) {
      fs.appendFileSync(process.env.DAD_GUARD_LOG, JSON.stringify({ ts: Date.now(), reason }) + '\n');
    }
  } catch {
    /* el registro es opcional */
  }
  process.stderr.write(msg);
  process.exit(2);
}
