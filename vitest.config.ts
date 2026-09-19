import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 300_000,
    hookTimeout: 60_000,
    // Live/acceptance suites talk to real services; keep them serial for readable logs.
    fileParallelism: false,
    reporters: ['default'],
    env: {
      NODE_ENV: 'test',
      // Deterministic upstream for unit tests; live/acceptance suites override this.
      AGNES_BASE_URL: 'https://upstream.test/v1'
    }
  }
})
