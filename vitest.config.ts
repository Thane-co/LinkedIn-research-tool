import { defineConfig } from 'vitest/config'
import path from 'node:path'

// Per-module 100% coverage is required on the pure logic modules (CLAUDE.md / PRD §13):
// a silent failure in any of these corrupts stored data.
const PURE_MODULES = [
  'lib/pure/x-factor.ts',
  'lib/pure/dedup.ts',
  'lib/pure/mappers.ts',
  'lib/pure/similarity.ts',
  'lib/pure/image-groups.ts',
  'lib/pure/content-clusters.ts',
  'lib/pure/vector-blob.ts',
]

const pureThresholds = Object.fromEntries(
  PURE_MODULES.map((m) => [m, { lines: 100, functions: 100, branches: 100, statements: 100 }]),
)

export default defineConfig({
  resolve: {
    alias: { '@': path.resolve(__dirname, '.') },
  },
  // Automatic JSX runtime so component tests don't need `React` in scope (matches Next's transform).
  esbuild: { jsx: 'automatic' },
  test: {
    environment: 'node',
    globals: true,
    setupFiles: ['tests/setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['lib/**', 'jobs/**', 'app/api/**'],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
        ...pureThresholds,
      },
    },
  },
})
