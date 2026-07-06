import { defineConfig } from 'vitest/config';
import path from 'node:path';

// Minimal vitest config. Keep deliberately small — adding test infra is
// only worth its weight if the tests stay easy to run.
//
// `node` env (no jsdom) because our test surface is currently pure
// functions (lib/lockedOdds.ts, lib/payout.ts, lib/displayMultiplier.ts);
// any future component test that needs a DOM can opt in per-file.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['lib/**/*.test.ts', 'app/**/*.test.ts', 'components/**/*.test.ts'],
  },
  // Mirror the tsconfig path alias so test files can import via @/.
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
});
