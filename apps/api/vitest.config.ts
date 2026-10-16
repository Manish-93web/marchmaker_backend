import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    testTimeout: 60_000,
    hookTimeout: 120_000,
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'json-summary'],
      // The domain: every service, route, job and library. Scripts and the app wiring are excluded.
      include: ['src/services/**', 'src/routes/**', 'src/jobs/**', 'src/lib/**', 'src/middleware/**'],
      exclude: ['src/lib/jobsAdmin.ts', 'src/lib/storage.ts', 'src/lib/channels.ts', 'src/lib/telephony.ts', 'src/lib/transcription.ts', 'src/lib/narrativeRewriter.ts'],
      // Enforced in CI with `pnpm --filter @marchmaker/api test:coverage`.
      thresholds: { lines: 80, functions: 75, statements: 80, branches: 65 },
    },
  },
});
