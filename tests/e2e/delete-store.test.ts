import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import { describe, expect, it } from "vitest";
import { hasDevCredentials, NO_CREDENTIALS, rmrf, tmpDataDir } from "../helpers/credentials.js";

const ROOT = path.resolve(import.meta.dirname, "../..");

function cli(args: string[]) {
  return execa(process.execPath, ["--import", "tsx", "src/cli/index.ts", ...args], {
    cwd: ROOT,
    reject: false,
    all: true,
  });
}

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

describe.skipIf(!hasDevCredentials)(`e2e: dql delete-store (${NO_CREDENTIALS})`, () => {
  it("deletes an initialized store with -y (dir and lock file gone)", async () => {
    const dir = tmpDataDir("ditto-e2e-");
    try {
      await cli([
        "dql",
        "INSERT INTO movies DOCUMENTS ({'_id':'d1','title':'Doomed'}) ON ID CONFLICT DO UPDATE",
        "-d",
        dir,
      ]);
      expect(fs.existsSync(path.join(dir, "__ditto_lock_file"))).toBe(true);

      const r = (await cli(["dql", "delete-store", "-y", "-d", dir])) as unknown as RunResult;
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("Deleted the store");
      expect(fs.existsSync(dir)).toBe(false);
    } finally {
      rmrf(dir);
    }
  });

  it("without -y it refuses (exit 2) and the store is untouched", async () => {
    const dir = tmpDataDir("ditto-e2e-");
    try {
      await cli([
        "dql",
        "INSERT INTO movies DOCUMENTS ({'_id':'d1'}) ON ID CONFLICT DO UPDATE",
        "-d",
        dir,
      ]);
      const r = (await cli(["dql", "delete-store", "-d", dir])) as unknown as RunResult;
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toContain("--yes");
      expect(fs.existsSync(path.join(dir, "__ditto_lock_file"))).toBe(true);
    } finally {
      rmrf(dir);
    }
  });

  it("a missing dir is a no-op (exit 0)", async () => {
    const dir = path.join(tmpDataDir("ditto-e2e-"), "never-created");
    const r = (await cli(["dql", "delete-store", "-y", "-d", dir])) as unknown as RunResult;
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("nothing to delete");
    rmrf(path.dirname(dir));
  });

  it("refuses to delete the home directory (exit 2)", async () => {
    const r = (await cli([
      "dql",
      "delete-store",
      "-y",
      "-d",
      os.homedir(),
    ])) as unknown as RunResult;
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("Refusing");
    expect(fs.existsSync(os.homedir())).toBe(true);
  });
});
