import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { AppController } from '../../electron/main/controller';
import { DEFAULT_WORKSPACE } from '../../electron/services/config';

beforeEach(() => {
  process.env.DAD_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dad-data-'));
});

describe('Cambio de carpeta de trabajo', () => {
  it('acepta otra carpeta existente, la guarda y la añade a recientes', () => {
    const c = new AppController(process.cwd(), process.execPath);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dad-ws-'));
    expect(c.setWorkspace(dir)).toEqual({ ok: true });
    const snap = c.snapshot();
    expect(snap.settings.workspace).toBe(dir);
    expect(snap.settings.recentWorkspaces[0]).toBe(dir);
    expect(snap.workspace).toMatchObject({ path: dir, exists: true, isGitRepo: false });
    // persiste tras un "reinicio"
    expect(new AppController(process.cwd(), process.execPath).config.get().workspace).toBe(dir);
  });

  it('rechaza rutas inexistentes, relativas, raíces de unidad y los datos de la app', () => {
    const c = new AppController(process.cwd(), process.execPath);
    expect(c.setWorkspace(path.join(os.tmpdir(), 'no-existe-xyz')).ok).toBe(false);
    expect(c.setWorkspace('relativa').ok).toBe(false);
    expect(c.setWorkspace(path.parse(os.tmpdir()).root).ok).toBe(false);
    expect(c.setWorkspace(process.env.DAD_DATA_DIR!).ok).toBe(false);
    expect(c.config.get().workspace).toBe(DEFAULT_WORKSPACE);
  });
});
