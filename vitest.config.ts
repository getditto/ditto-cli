import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
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
