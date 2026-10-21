import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['tests/integration/real-cli.test.ts'], environment: 'node', testTimeout: 600_000, hookTimeout: 120_000 },
});
