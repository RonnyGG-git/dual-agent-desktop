// Ejecuta las pruebas de integración contra las CLI reales (consume uso de Claude/OpenCode).
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const vitest = path.join(__dirname, '..', 'node_modules', 'vitest', 'vitest.mjs');
const r = spawnSync(process.execPath, [vitest, 'run', '--config', 'vitest.real.config.mts'], {
  stdio: 'inherit',
  env: { ...process.env, DAD_REAL_CLI: '1' },
});
process.exit(r.status ?? 1);
