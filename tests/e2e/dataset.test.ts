import { describe, expect, it } from "vitest";
import { execa } from "execa";
import path from "node:path";
import { hasDevCredentials, NO_CREDENTIALS, rmrf, tmpDataDir } from "../helpers/credentials.js";

const ROOT = path.resolve(import.meta.dirname, "../..");
const ENV_FILE = path.join(ROOT, ".env");

function cli(args: string[]) {
  return execa(
    process.execPath,
    ["--import", "tsx", `--env-file=${ENV_FILE}`, "src/cli/index.ts", ...args],
    { cwd: ROOT, reject: false, all: true, input: "" },
  );
}

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

describe.skipIf(!hasDevCredentials)(`e2e: ditto dql dataset (${NO_CREDENTIALS})`, () => {
  it("dataset list shows all four suites", async () => {
    const r = (await cli(["dql", "dataset", "list", "--format", "json"])) as unknown as RunResult;
    expect(r.exitCode).toBe(0);
    const rows = JSON.parse(r.stdout.slice(r.stdout.indexOf("[")));
    expect(rows.map((d: { dataset: string }) => d.dataset)).toEqual(["movies", "retail", "retail-joins", "pos"]);
  });

  it("dataset show prints shape, indexes, and query catalog", async () => {
    const r = (await cli(["dql", "dataset", "show", "retail"])) as unknown as RunResult;
    expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("Zava Retail");
      expect(r.stdout).toContain("stores__select__by_location_city");
      expect(r.stdout).toContain("CREATE INDEX customers_email");
  });

  it("dataset show rejects unknown datasets (exit 2)", async () => {
    const r = (await cli(["dql", "dataset", "show", "nope"])) as unknown as RunResult;
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("Unknown dataset");
  });

  it("load + run + reset round-trip", async () => {
    const dir = tmpDataDir("ditto-e2e-ds-");
    try {
      const load = (await cli(["dql", "dataset", "load", "movies", "--docs", "50", "-d", dir])) as unknown as RunResult;
      expect(load.exitCode).toBe(0);
      expect(load.stdout).toContain("Loaded 50 documents");

      const run = (await cli(["dql", "dataset", "run", "single_result", "--dataset", "movies", "-d", dir])) as unknown as RunResult;
      expect(run.exitCode).toBe(0);
      // statement echoed for confirmation (on stderr, stdout stays clean)
      expect(run.stderr).toContain("SELECT * FROM movies WHERE _id.year = '1893'");
      const rows = JSON.parse(run.stdout.slice(run.stdout.indexOf("[")));
      expect(rows).toHaveLength(1);
      expect(rows[0]._id.title).toBe("Blacksmith Scene");

      const reset = (await cli(["dql", "dataset", "reset", "movies", "--yes", "-d", dir])) as unknown as RunResult;
      expect(reset.exitCode).toBe(0);
      const count = (await cli(["dql", "SELECT count(*) AS n FROM movies", "-d", dir])) as unknown as RunResult;
      expect(JSON.parse(count.stdout)[0].n).toBe(0);
    } finally {
      rmrf(dir);
    }
  });

  it("run echoes the statement and refuses unknown queries", async () => {
    const dir = tmpDataDir("ditto-e2e-ds-");
    try {
      const bad = (await cli(["dql", "dataset", "run", "nope__nope", "-d", dir])) as unknown as RunResult;
      expect(bad.exitCode).toBe(2);
      expect(bad.stderr).toContain("Unknown query");
    } finally {
      rmrf(dir);
    }
  });

  it("ambiguous names require --dataset", async () => {
    const dir = tmpDataDir("ditto-e2e-ds-");
    try {
      const r = (await cli(["dql", "dataset", "run", "stores__select__all", "-d", dir])) as unknown as RunResult;
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toContain("multiple datasets");
    } finally {
      rmrf(dir);
    }
  });

  it("write-category catalog queries require --yes", async () => {
    const dir = tmpDataDir("ditto-e2e-ds-");
    try {
      const r = (await cli(["dql", "dataset", "run", "insert", "--dataset", "movies", "-d", dir])) as unknown as RunResult;
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toContain("mutates the store");
    } finally {
      rmrf(dir);
    }
  });
});
