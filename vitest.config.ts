import { defineConfig } from 'vitest/config';

// Match Cloudflare Workers' UTC environment for date-fns parse compatibility
process.env.TZ = 'UTC';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    // Use forks pool so each test file runs in a separate child process.
    // This prevents better-sqlite3 native module teardown crashes on Windows
    // from poisoning the parent process exit code.
    pool: 'forks',
    fileParallelism: false,
    coverage: {
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/register-commands.ts']
    }
  }
});