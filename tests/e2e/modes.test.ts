import { describe, expect, it } from "vitest";
import { execa } from "execa";
import fs from "node:fs";
import path from "node:path";
import { hasDevCredentials, NO_CREDENTIALS, rmrf, tmpDataDir } from "../helpers/credentials.js";

const ROOT = path.resolve(import.meta.dirname, "../..");
const ENV_FILE = path.join(ROOT, ".env");

function cli(args: string[], opts: { input?: string; home?: string } = {}) {
  return execa(
    process.execPath,
    ["--import", "tsx", `--env-file=${ENV_FILE}`, "src/cli/index.ts", ...args],
    {
      cwd: ROOT,
      reject: false,
      all: true,
      input: opts.input,
      env: opts.home ? { HOME: opts.home } : undefined,
    },
  );
}

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

describe.skipIf(!hasDevCredentials)(`e2e: ditto dql input modes (${NO_CREDENTIALS})`, () => {
  it("runs a -f file with multiple statements", async () => {
    const dir = tmpDataDir("ditto-e2e-");
    const file = path.join(dir, "script.dql");
    fs.writeFileSync(
      file,
      "-- seed\nINSERT INTO movies DOCUMENTS ({'_id':'f1','title':'From File'}), ({'_id':'f2','title':'Second; With Semicolon'}) ON ID CONFLICT DO UPDATE;\nSELECT * FROM movies ORDER BY _id;\n",
      "utf8",
    );
    try {
      const r = (await cli(["dql", "-f", file, "-d", dir])) as unknown as RunResult;
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("OK");
      const rows = JSON.parse(r.stdout.slice(r.stdout.indexOf("[")));
      expect(rows.map((r: { title: string }) => r.title)).toEqual([
        "From File",
        "Second; With Semicolon",
      ]);
      expect(r.stderr).toContain("2 ok, 0 failed");
    } finally {
      rmrf(dir);
    }
  });

  it("stops on first error by default; --continue-on-error continues", async () => {
    const dir = tmpDataDir("ditto-e2e-");
    const file = path.join(dir, "bad.dql");
      fs.writeFileSync(file, "SELECT * FROM system:collections;\nSELEC broken;\nSELECT * FROM system:collections;\n", "utf8");
    try {
      const bail = (await cli(["dql", "-f", file, "-d", dir])) as unknown as RunResult;
      expect(bail.exitCode).toBe(1);
      expect(bail.stderr).toContain("1 ok, 1 failed (of 3)");

      const cont = (await cli(["dql", "-f", file, "-d", dir, "--continue-on-error"])) as unknown as RunResult;
      expect(cont.exitCode).toBe(1);
      expect(cont.stderr).toContain("2 ok, 1 failed (of 3)");
    } finally {
      rmrf(dir);
    }
  });

  it("executes piped stdin as a statement batch", async () => {
    const dir = tmpDataDir("ditto-e2e-");
    try {
      const r = (await cli(["dql", "-d", dir], {
        input: "INSERT INTO movies DOCUMENTS ({'_id':'p1','title':'Piped'}) ON ID CONFLICT DO UPDATE;\nSELECT title FROM movies;\n",
      })) as unknown as RunResult;
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("OK");
      expect(r.stdout).toContain('"Piped"');
    } finally {
      rmrf(dir);
    }
  });

  it("binds -p params and --args JSON", async () => {
    const dir = tmpDataDir("ditto-e2e-");
    try {
      await cli(["dql", "INSERT INTO movies DOCUMENTS ({'_id':'p1','title':'Alien','year':1979}), ({'_id':'p2','title':'Toy Story','year':1995}) ON ID CONFLICT DO UPDATE", "-d", dir]);
      const r = (await cli([
        "dql", "SELECT title FROM movies WHERE year > :minYear", "-d", dir, "-p", "minYear=1980",
      ])) as unknown as RunResult;
      expect(r.exitCode).toBe(0);
      expect(JSON.parse(r.stdout)).toEqual([{ title: "Toy Story" }]);

      const r2 = (await cli([
        "dql", "SELECT title FROM movies WHERE year < :maxYear", "-d", dir, "--args", '{"maxYear":1990}',
      ])) as unknown as RunResult;
      expect(JSON.parse(r2.stdout)).toEqual([{ title: "Alien" }]);
    } finally {
      rmrf(dir);
    }
  });

  it("writes results to -o file (format from extension) and prints a summary", async () => {
    const dir = tmpDataDir("ditto-e2e-");
    const out = path.join(dir, "results.csv");
    try {
      await cli(["dql", "INSERT INTO movies DOCUMENTS ({'_id':'o1','title':'Out','year':2001}) ON ID CONFLICT DO UPDATE", "-d", dir]);
      const r = (await cli(["dql", "SELECT * FROM movies", "-d", dir, "-o", out])) as unknown as RunResult;
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("Wrote 1 row to");
      const csv = fs.readFileSync(out, "utf8");
      expect(csv).toContain("_id,title,year");
      expect(csv).toContain("o1,Out,2001");
    } finally {
      rmrf(dir);
    }
  });

  it("usage errors exit 2", async () => {
    const dir = tmpDataDir("ditto-e2e-");
    try {
      const bad = (await cli(["dql", "SELECT 1", "-d", dir, "-p", "noequals"])) as unknown as RunResult;
      expect(bad.exitCode).toBe(2);
      expect(bad.stderr).toContain("--param must be name=value");

      const badArgs = (await cli(["dql", "SELECT 1", "-d", dir, "--args", "[1,2]"])) as unknown as RunResult;
      expect(badArgs.exitCode).toBe(2);

      const missing = (await cli(["dql", "-f", "/nonexistent/file.dql", "-d", dir])) as unknown as RunResult;
      expect(missing.exitCode).toBe(2);
    } finally {
      rmrf(dir);
    }
  });
});
