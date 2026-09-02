import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      all: true,
      include: ["src/**"],
      // The process entry point and the node:repl wiring are exercised by e2e
      // subprocess / pty tests, which v8 coverage cannot see — excluded deliberately.
      exclude: ["src/cli/index.ts", "src/cli/groups/dql/repl.ts"],
      // Hard gate (PM decision): coverage must stay at or above 85%.
      thresholds: { statements: 85, branches: 85, functions: 85, lines: 85 },
    },
    projects: [
      {
        test: {
          name: "unit",
          include: ["tests/unit/**/*.test.ts"],
          setupFiles: ["tests/setup/env.ts"],
        },
      },
      {
        test: {
          name: "integration",
          include: ["tests/integration/**/*.test.ts"],
          setupFiles: ["tests/setup/env.ts"],
          testTimeout: 120_000,
          hookTimeout: 120_000,
          // The Ditto native module holds process-wide state (sdk.init(),
          // file locks) — keep integration files serial.
          fileParallelism: false,
        },
      },
      {
        test: {
          name: "e2e",
          include: ["tests/e2e/**/*.test.ts"],
          setupFiles: ["tests/setup/env.ts"],
          testTimeout: 120_000,
        },
      },
    ],
  },
});
