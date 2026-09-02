import fs from "node:fs";
import path from "node:path";
import { execa } from "execa";
import { describe, expect, it } from "vitest";
import { hasDevCredentials, NO_CREDENTIALS, rmrf, tmpDataDir } from "../helpers/credentials.js";

const ROOT = path.resolve(import.meta.dirname, "../..");

function cli(args: string[], env: Record<string, string> = {}) {
  return execa(process.execPath, ["--import", "tsx", "src/cli/index.ts", ...args], {
    cwd: ROOT,
    reject: false,
    all: true,
    input: "",
    env,
  });
}

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

describe("e2e: ditto version / update / banner", () => {
  it("version prints all fields and works in JSON mode", async () => {
    const r = (await cli(["version"])) as unknown as RunResult;
    expect(r.exitCode).toBe(0);
    for (const key of [
      "version",
      "channel",
      "update",
      "token_expires",
      "data_dir",
      "platform",
      "node",
    ]) {
      expect(r.stdout).toContain(key);
    }

    const j = (await cli(["version", "--format", "json"])) as unknown as RunResult;
    expect(j.exitCode).toBe(0);
    const parsed = JSON.parse(j.stdout);
    expect(parsed).toHaveProperty("version");
    expect(parsed).toHaveProperty("channel");

    const bad = (await cli(["version", "--format", "yaml"])) as unknown as RunResult;
    expect(bad.exitCode).toBe(2);
  });

  it("update --check degrades gracefully pre-publish (registry 404 → exit 1, clean message)", async () => {
    const r = (await cli(["update", "--check"])) as unknown as RunResult;
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("Update check failed");
    expect(r.stdout).not.toContain("update available");
  });

  // Query-touching tests need the dev token (CI without secrets skips).
  it.skipIf(!hasDevCredentials)(
    `--no-update-check parses in every position and never breaks the command (${NO_CREDENTIALS})`,
    async () => {
      const dir = tmpDataDir("ditto-e2e-");
      try {
        for (const args of [
          ["--no-update-check", "dql", "SELECT 1 FROM system:collections", "-d", dir],
          ["dql", "--no-update-check", "SELECT 1 FROM system:collections", "-d", dir],
          ["dql", "SELECT 1 FROM system:collections", "-d", dir, "--no-update-check"],
        ]) {
          const r = (await cli(args)) as unknown as RunResult;
          expect(r.exitCode, JSON.stringify(args)).toBe(0);
          expect(r.stderr).not.toContain("update available");
        }
      } finally {
        rmrf(dir);
      }
    },
  );

  it.skipIf(!hasDevCredentials)(
    `the banner never appears on stdout, even with a poisoned fresh cache (${NO_CREDENTIALS})`,
    async () => {
      const dir = tmpDataDir("ditto-e2e-");
      const cfg = tmpDataDir("ditto-e2e-cfg-");
      try {
        fs.writeFileSync(
          path.join(cfg, "state.json"),
          JSON.stringify({ updateCheck: { checkedAt: Date.now(), latest: "99.99.99" } }),
          "utf8",
        );
        const r = (await cli(["dql", "SELECT 1 FROM system:collections", "-d", dir], {
          DITTO_CONFIG_DIR: cfg,
        })) as unknown as RunResult;
        expect(r.exitCode).toBe(0);
        // piped (non-TTY) → banner suppressed entirely; stdout is pure JSON
        expect(JSON.parse(r.stdout)).toBeDefined();
        expect(r.stderr).not.toContain("update available");
      } finally {
        rmrf(dir);
        rmrf(cfg);
      }
    },
  );
});
