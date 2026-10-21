import path from 'node:path';
import type { Settings } from '../../shared/types';
import { dataDir, readJson, writeJsonAtomic } from './paths';

export const DEFAULT_WORKSPACE = 'C:\\RONNY\\MIND\\CEREBRO';

export const DEFAULT_SETTINGS: Settings = {
  workspace: DEFAULT_WORKSPACE,
  maxAttempts: 3,
  requireTests: false,
  claudeModel: '',
  opencodeModel: '',
  // CEREBRO tiene un hook que pide actualizar el diario al terminar: se permite escribir ahí.
  extraWritablePaths: ['01 Diario'],
  timeouts: { reviewMin: 10, developMin: 30, testMin: 15, qaMin: 15, documentMin: 15 },
};

export class ConfigStore {
  private file = path.join(dataDir(), 'settings.json');
  private settings: Settings;

  constructor() {
    const saved = readJson<Partial<Settings>>(this.file, {});
    this.settings = sanitize({ ...DEFAULT_SETTINGS, ...saved, timeouts: { ...DEFAULT_SETTINGS.timeouts, ...saved.timeouts } });
  }

  get(): Settings {
    return structuredClone(this.settings);
  }

  update(patch: Partial<Settings>): Settings {
    this.settings = sanitize({
      ...this.settings,
      ...patch,
      timeouts: { ...this.settings.timeouts, ...patch.timeouts },
    });
    writeJsonAtomic(this.file, this.settings);
    return this.get();
  }
}

function sanitize(s: Settings): Settings {
  const clampInt = (v: unknown, min: number, max: number, def: number) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
  };
  return {
    ...s,
    workspace: String(s.workspace || DEFAULT_WORKSPACE),
    maxAttempts: clampInt(s.maxAttempts, 1, 10, 3),
    requireTests: Boolean(s.requireTests),
    // Los modelos se pasan como argumento a las CLI: solo caracteres de identificador.
    claudeModel: /^[\w./:@-]*$/.test(s.claudeModel) ? s.claudeModel : '',
    opencodeModel: /^[\w./:@-]*$/.test(s.opencodeModel) ? s.opencodeModel : '',
    extraWritablePaths: (s.extraWritablePaths || []).filter((p) => typeof p === 'string' && p && !path.isAbsolute(p) && !p.includes('..')),
    timeouts: {
      reviewMin: clampInt(s.timeouts.reviewMin, 1, 240, 10),
      developMin: clampInt(s.timeouts.developMin, 1, 240, 30),
      testMin: clampInt(s.timeouts.testMin, 1, 240, 15),
      qaMin: clampInt(s.timeouts.qaMin, 1, 240, 15),
      documentMin: clampInt(s.timeouts.documentMin, 1, 240, 15),
    },
  };
}
