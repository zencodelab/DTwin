import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * Unit tests, alongside the smoke suites rather than instead of them.
 *
 * The four smoke suites run end to end against a real migrated database, a real
 * socket and a real uvicorn, and they stay that way: most of what can go wrong
 * in this system is a TimescaleDB behaviour, a PostGIS predicate or a frame
 * ordering, and mocking those would test the assumption rather than the thing.
 *
 * What they are bad at is localisation. A failing smoke check says the heatmap
 * is wrong; it does not say the least-squares fit divides by a zero variance.
 * These tests cover the pure functions where the logic is subtle and the inputs
 * are awkward to reach from end to end — and they need no database, so they run
 * in CI before anything is started.
 */
export default defineConfig({
  resolve: {
    // apps/web's tsconfig maps `@/*` to its own root, and its route handlers
    // import through it. The same mapping here lets a test load a route file
    // (apps/web/lib/copilot/route.test.ts) instead of only reviewing it. A
    // regex, anchored on `@/`, so `@dtwin/…` and `@langchain/…` never match.
    alias: [{ find: /^@\//, replacement: fileURLToPath(new URL('./apps/web/', import.meta.url)) }],
  },
  test: {
    include: ['{apps,packages}/*/src/**/*.test.ts', 'apps/web/lib/**/*.test.ts'],
    // The smoke suites are executables, not test files; they exit the process
    // and expect a live stack.
    exclude: ['**/node_modules/**', '**/smoke-test.ts', '**/.next/**'],
    environment: 'node',
  },
});
