import fs from 'node:fs';
import path from 'node:path';
import type { TestRun } from '../../shared/types';
import { findOnPath } from './executables';
import { runProcess } from './process-runner';

export interface TestCommand {
  label: string;
  executable: string;
  args: string[];
}

/**
 * Detecta la suite de pruebas del proyecto a partir de sus archivos de
 * manifiesto. El comando lo decide el orquestador, nunca un agente.
 */
export function detectTestCommand(projectAbs: string): TestCommand | null {
  const has = (f: string) => fs.existsSync(path.join(projectAbs, f));
  const cmd = process.env.ComSpec || 'cmd.exe';
  const viaCmd = (label: string): TestCommand => ({ label, executable: cmd, args: ['/d', '/s', '/c', label] });

  if (has('package.json')) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(projectAbs, 'package.json'), 'utf8'));
      const script: string | undefined = pkg?.scripts?.test;
      if (script && !/no test specified/i.test(script)) {
        return process.platform === 'win32' ? viaCmd('npm test') : { label: 'npm test', executable: 'npm', args: ['test'] };
      }
    } catch {
      /* package.json inválido: se ignora */
    }
  }
  if (has('mvnw.cmd')) return viaCmd('mvnw.cmd -q test');
  if (has('pom.xml') && findOnPath('mvn')) return viaCmd('mvn -q test');
  if (has('gradlew.bat')) return viaCmd('gradlew.bat test');
  if (has('build.gradle') || has('build.gradle.kts')) {
    if (findOnPath('gradle')) return viaCmd('gradle test');
  }
  if (has('Cargo.toml')) return viaCmd('cargo test');
  if (has('go.mod')) return viaCmd('go test ./...');
  if (has('pytest.ini') || has('pyproject.toml') || has('setup.cfg') || has('tests')) {
    const pyFiles = has('pytest.ini') || has('pyproject.toml') || hasPythonTests(projectAbs);
    if (pyFiles) return viaCmd('python -m pytest -q');
  }
  return null;
}

function hasPythonTests(projectAbs: string): boolean {
  try {
    return fs.readdirSync(path.join(projectAbs, 'tests')).some((f) => /^test_.*\.py$/.test(f));
  } catch {
    return false;
  }
}

export async function runTests(projectAbs: string, attempt: number, timeoutMs: number, signal: AbortSignal, onLine: (l: string) => void): Promise<TestRun> {
  const command = detectTestCommand(projectAbs);
  if (!command) {
    return { attempt, ts: Date.now(), status: 'none', command: null, exitCode: null, durationMs: 0, outputTail: 'No se detectó una suite de pruebas automatizadas en el proyecto.' };
  }
  const env = { ...process.env, CI: 'true', FORCE_COLOR: '0' };
  const r = await runProcess(command.executable, {
    cwd: projectAbs,
    args: command.args,
    env,
    timeoutMs,
    signal,
    onStdoutLine: onLine,
    onStderr: (c) => c.split(/\r?\n/).filter(Boolean).forEach(onLine),
  });
  const output = `${r.stdout}\n${r.stderr}`.replace(/\x1b\[[0-9;]*m/g, '');
  const tail = output.split(/\r?\n/).filter((l) => l.trim()).slice(-60).join('\n');
  let status: TestRun['status'];
  if (r.spawnError || r.timedOut || r.cancelled) status = 'error';
  else status = r.exitCode === 0 ? 'passed' : 'failed';
  const note = r.timedOut ? '\n[tiempo máximo agotado]' : r.cancelled ? '\n[cancelado]' : r.spawnError ? `\n[${r.spawnError.message}]` : '';
  return { attempt, ts: Date.now(), status, command: command.label, exitCode: r.exitCode, durationMs: r.durationMs, outputTail: tail + note };
}
