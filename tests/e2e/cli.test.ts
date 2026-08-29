import { describe, expect, it } from "vitest";
import { execa, ExecaError } from "execa";
import path from "node:path";
import { hasDevCredentials, NO_CREDENTIALS, rmrf, tmpDataDir } from "../helpers/credentials.js";

const ROOT = path.resolve(import.meta.dirname, "../..");
const ENV_FILE = path.join(ROOT, ".env");

function cli(args: string[], opts: { cwd?: string } = {}) {
  // Run the CLI exactly like a user would in dev: node + tsx loader + .env.
  return execa(
    process.execPath,
    ["--import", "tsx", `--env-file=${ENV_FILE}`, "src/cli/index.ts", ...args],
    { cwd: opts.cwd ?? ROOT, reject: false, all: true },
  );
}

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  all: string;
}

describe.skipIf(!hasDevCredentials)(`e2e: ditto dql (${NO_CREDENTIALS})`, () => {
  it("doctor passes all checks (exit 0)", async () => {
    const r = (await cli(["dql", "doctor"])) as unknown as RunResult;
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("platform");
    expect(r.stdout).toContain("data directory");
    expect(r.stdout).toContain("token");
    expect(r.stdout).not.toContain("✗");
  });

  it("inserts then queries documents end-to-end", async () => {
    const dir = tmpDataDir("ditto-e2e-");
    try {
      const ins = (await cli([
        "dql",
        "INSERT INTO movies DOCUMENTS ({'_id':'e1','title':'Alien','year':1979}), ({'_id':'e2','title':'Toy Story','year':1995}) ON ID CONFLICT DO UPDATE",
        "-d", dir,
      ])) as unknown as RunResult;
      expect(ins.exitCode).toBe(0);
      expect(ins.stdout.trim()).toBe("OK");

      const sel = (await cli(["dql", "SELECT * FROM movies ORDER BY year", "-d", dir])) as unknown as RunResult;
      expect(sel.exitCode).toBe(0);
      // Non-TTY (captured) output defaults to JSON
      const rows = JSON.parse(sel.stdout) as Array<{ _id: string; title: string }>;
      expect(rows.map((r) => r.title)).toEqual(["Alien", "Toy Story"]);
    } finally {
      rmrf(dir);
    }
  });

  it("renders a box table with --format table", async () => {
    const dir = tmpDataDir("ditto-e2e-");
    try {
      await cli(["dql", "INSERT INTO movies DOCUMENTS ({'_id':'e1','title':'Alien','year':1979}) ON ID CONFLICT DO UPDATE", "-d", dir]);
      const r = (await cli(["dql", "SELECT * FROM movies", "-d", dir, "--format", "table"])) as unknown as RunResult;
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("┌");
      expect(r.stdout).toContain("│ _id ");
      expect(r.stdout).toContain("Alien");
      expect(r.stdout).toMatch(/1 row$/m);
    } finally {
      rmrf(dir);
    }
  });

  it("pipes clean JSON to stdout (SDK logs stay off stdout)", async () => {
    const dir = tmpDataDir("ditto-e2e-");
    try {
      await cli(["dql", "INSERT INTO movies DOCUMENTS ({'_id':'e1','title':'Alien'}) ON ID CONFLICT DO UPDATE", "-d", dir]);
      const r = (await cli(["dql", "SELECT title FROM movies", "-d", dir])) as unknown as RunResult;
      expect(r.exitCode).toBe(0);
      expect(JSON.parse(r.stdout)).toEqual([{ title: "Alien" }]);
      expect(r.stdout).not.toContain("INFO");
      expect(r.stdout).not.toContain("warning:");
    } finally {
      rmrf(dir);
    }
  });

  it("--max-rows truncates with a stderr banner", async () => {
    const dir = tmpDataDir("ditto-e2e-");
    try {
      await cli([
        "dql",
        "INSERT INTO movies DOCUMENTS ({'_id':'e1','title':'A'}), ({'_id':'e2','title':'B'}), ({'_id':'e3','title':'C'}) ON ID CONFLICT DO UPDATE",
        "-d", dir,
      ]);
      const r = (await cli(["dql", "SELECT * FROM movies", "-d", dir, "--max-rows", "2"])) as unknown as RunResult;
      expect(r.exitCode).toBe(0);
      expect(JSON.parse(r.stdout)).toHaveLength(2);
      expect(r.stderr).toContain("showing first 2 of 3");
    } finally {
      rmrf(dir);
    }
  });

  it("a malformed statement exits 1 with the statement excerpt", async () => {
    const dir = tmpDataDir("ditto-e2e-");
    try {
      const r = (await cli(["dql", "SELEC broken", "-d", dir])) as unknown as RunResult;
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("Query error");
      expect(r.stderr).toContain("SELEC broken");
    } finally {
      rmrf(dir);
    }
  });

  it("no statement exits 2 (usage) until the REPL lands", async () => {
    const r = (await cli(["dql"])) as unknown as RunResult;
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("REPL");
  });
});
