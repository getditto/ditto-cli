import fs from "node:fs";
import path from "node:path";
import { execa } from "execa";
import { describe, expect, it } from "vitest";
import { hasDevCredentials, NO_CREDENTIALS, rmrf, tmpDataDir } from "../helpers/credentials.js";

const ROOT = path.resolve(import.meta.dirname, "../..");

function cli(args: string[], opts: { input?: string } = {}) {
  return execa(process.execPath, ["--import", "tsx", "src/cli/index.ts", ...args], {
    cwd: ROOT,
    reject: false,
    all: true,
    input: opts.input,
  });
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
      expect(r.stderr).toContain("OK");
      const rows = JSON.parse(r.stdout.trim());
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
    fs.writeFileSync(
      file,
      "SELECT * FROM system:collections;\nSELEC broken;\nSELECT * FROM system:collections;\n",
      "utf8",
    );
    try {
      const bail = (await cli(["dql", "-f", file, "-d", dir])) as unknown as RunResult;
      expect(bail.exitCode).toBe(1);
      expect(bail.stderr).toContain("1 ok, 1 failed, 1 skipped (of 3)");

      const cont = (await cli([
        "dql",
        "-f",
        file,
        "-d",
        dir,
        "--continue-on-error",
      ])) as unknown as RunResult;
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
        input:
          "INSERT INTO movies DOCUMENTS ({'_id':'p1','title':'Piped'}) ON ID CONFLICT DO UPDATE;\nSELECT title FROM movies;\n",
      })) as unknown as RunResult;
      expect(r.exitCode).toBe(0);
      expect(r.stderr).toContain("OK");
      expect(r.stdout).toContain('"Piped"');
    } finally {
      rmrf(dir);
    }
  });

  it("binds -p params and --args JSON", async () => {
    const dir = tmpDataDir("ditto-e2e-");
    try {
      await cli([
        "dql",
        "INSERT INTO movies DOCUMENTS ({'_id':'p1','title':'Alien','year':1979}), ({'_id':'p2','title':'Toy Story','year':1995}) ON ID CONFLICT DO UPDATE",
        "-d",
        dir,
      ]);
      const r = (await cli([
        "dql",
        "SELECT title FROM movies WHERE year > :minYear",
        "-d",
        dir,
        "-p",
        "minYear=1980",
      ])) as unknown as RunResult;
      expect(r.exitCode).toBe(0);
      expect(JSON.parse(r.stdout)).toEqual([{ title: "Toy Story" }]);

      // params BEFORE the positional also work (non-variadic collector)
      const before = (await cli([
        "dql",
        "-p",
        "maxYear=1990",
        "SELECT title FROM movies WHERE year < :maxYear",
        "-d",
        dir,
      ])) as unknown as RunResult;
      expect(before.exitCode).toBe(0);
      expect(JSON.parse(before.stdout)).toEqual([{ title: "Alien" }]);

      const r2 = (await cli([
        "dql",
        "SELECT title FROM movies WHERE year < :maxYear",
        "-d",
        dir,
        "--args",
        '{"maxYear":1990}',
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
      await cli([
        "dql",
        "INSERT INTO movies DOCUMENTS ({'_id':'o1','title':'Out','year':2001}) ON ID CONFLICT DO UPDATE",
        "-d",
        dir,
      ]);
      const r = (await cli([
        "dql",
        "SELECT * FROM movies",
        "-d",
        dir,
        "-o",
        out,
      ])) as unknown as RunResult;
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("Wrote 1 row to");
      const csv = fs.readFileSync(out, "utf8");
      expect(csv).toContain("_id,title,year");
      expect(csv).toContain("o1,Out,2001");
    } finally {
      rmrf(dir);
    }
  });

  it("a dot-command line mid-batch is skipped via the exec batch path (call-site pin)", async () => {
    const dir = tmpDataDir("ditto-e2e-");
    const file = path.join(dir, "batch.dql");
    fs.writeFileSync(
      file,
      "INSERT INTO movies DOCUMENTS ({'_id':'b1'}) ON ID CONFLICT DO UPDATE;\n.exit\nINSERT INTO movies DOCUMENTS ({'_id':'b2'}) ON ID CONFLICT DO UPDATE;\n",
      "utf8",
    );
    try {
      const r = (await cli(["dql", "-f", file, "-d", dir])) as unknown as RunResult;
      expect(r.exitCode).toBe(0);
      expect(r.stderr).toContain("skipping REPL command");
      const sel = (await cli([
        "dql",
        "SELECT count(*) AS n FROM movies",
        "-d",
        dir,
      ])) as unknown as RunResult;
      expect(JSON.parse(sel.stdout)[0].n).toBe(2); // BOTH statements ran
    } finally {
      rmrf(dir);
    }
  });

  it("usage errors exit 2", async () => {
    const dir = tmpDataDir("ditto-e2e-");
    try {
      const bad = (await cli([
        "dql",
        "SELECT 1",
        "-d",
        dir,
        "-p",
        "noequals",
      ])) as unknown as RunResult;
      expect(bad.exitCode).toBe(2);
      expect(bad.stderr).toContain("--param must be name=value");

      const badArgs = (await cli([
        "dql",
        "SELECT 1",
        "-d",
        dir,
        "--args",
        "[1,2]",
      ])) as unknown as RunResult;
      expect(badArgs.exitCode).toBe(2);

      const missing = (await cli([
        "dql",
        "-f",
        "/nonexistent/file.dql",
        "-d",
        dir,
      ])) as unknown as RunResult;
      expect(missing.exitCode).toBe(2);
    } finally {
      rmrf(dir);
    }
  });

  it("commander-level usage errors also exit 2 (not 1)", async () => {
    const dir = tmpDataDir("ditto-e2e-");
    try {
      const unknownFlag = (await cli([
        "dql",
        "SELECT 1",
        "-d",
        dir,
        "--bogus",
      ])) as unknown as RunResult;
      expect(unknownFlag.exitCode).toBe(2);
      expect(unknownFlag.stderr).toContain("unknown option");

      const missingValue = (await cli([
        "dql",
        "SELECT 1",
        "-d",
        dir,
        "--max-rows",
      ])) as unknown as RunResult;
      expect(missingValue.exitCode).toBe(2);

      const badFormat = (await cli([
        "dql",
        "SELECT 1",
        "-d",
        dir,
        "--format",
        "yaml",
      ])) as unknown as RunResult;
      expect(badFormat.exitCode).toBe(2);

      const badRows = (await cli([
        "dql",
        "SELECT 1",
        "-d",
        dir,
        "--max-rows",
        "abc",
      ])) as unknown as RunResult;
      expect(badRows.exitCode).toBe(2);
    } finally {
      rmrf(dir);
    }
  });

  it("DITTOSH_DATA_DIR is honored when -d is absent", async () => {
    const dir = tmpDataDir("ditto-e2e-env-");
    try {
      const r = (await execa(
        process.execPath,
        [
          "--import",
          "tsx",
          "src/cli/index.ts",
          "dql",
          "INSERT INTO t DOCUMENTS ({'_id':'1'}) ON ID CONFLICT DO UPDATE",
        ],
        { cwd: ROOT, reject: false, all: true, env: { DITTOSH_DATA_DIR: dir } },
      )) as unknown as RunResult;
      expect(r.exitCode).toBe(0);
      expect(fs.existsSync(path.join(dir, "__ditto_lock_file"))).toBe(true);
    } finally {
      rmrf(dir);
    }
  });

  it("a trailing semicolon on a one-shot is accepted", async () => {
    const dir = tmpDataDir("ditto-e2e-");
    try {
      await cli([
        "dql",
        "INSERT INTO movies DOCUMENTS ({'_id':'s1'}) ON ID CONFLICT DO UPDATE",
        "-d",
        dir,
      ]);
      const r = (await cli(["dql", "SELECT * FROM movies;", "-d", dir])) as unknown as RunResult;
      expect(r.exitCode).toBe(0);
      expect(JSON.parse(r.stdout)).toEqual([{ _id: "s1" }]);
    } finally {
      rmrf(dir);
    }
  });

  it("--no-color and --quiet are accepted without breaking output", async () => {
    const dir = tmpDataDir("ditto-e2e-");
    try {
      await cli([
        "dql",
        "INSERT INTO movies DOCUMENTS ({'_id':'s1','title':'A'}) ON ID CONFLICT DO UPDATE",
        "-d",
        dir,
      ]);
      const r = (await cli([
        "--no-color",
        "--quiet",
        "dql",
        "SELECT title FROM movies",
        "-d",
        dir,
      ])) as unknown as RunResult;
      expect(r.exitCode).toBe(0);
      expect(JSON.parse(r.stdout)).toEqual([{ title: "A" }]);
    } finally {
      rmrf(dir);
    }
  });

  it("--format markdown/html/vertical render on stdout", async () => {
    const dir = tmpDataDir("ditto-e2e-");
    try {
      await cli([
        "dql",
        "INSERT INTO movies DOCUMENTS ({'_id':'f1','title':'Alien','year':1979}) ON ID CONFLICT DO UPDATE",
        "-d",
        dir,
      ]);
      const md = (await cli([
        "dql",
        "SELECT * FROM movies",
        "-d",
        dir,
        "--format",
        "markdown",
      ])) as unknown as RunResult;
      expect(md.exitCode).toBe(0);
      expect(md.stdout).toContain("| _id | title | year |");
      expect(md.stdout).toContain("| --- | --- | --- |");
      expect(md.stdout).toContain("| f1 | Alien | 1979 |");

      const html = (await cli([
        "dql",
        "SELECT * FROM movies",
        "-d",
        dir,
        "--format",
        "html",
      ])) as unknown as RunResult;
      expect(html.exitCode).toBe(0);
      expect(html.stdout).toContain("<table>");
      expect(html.stdout).toContain("<td>Alien</td>");

      const vert = (await cli([
        "dql",
        "SELECT * FROM movies",
        "-d",
        dir,
        "--format",
        "vertical",
      ])) as unknown as RunResult;
      expect(vert.exitCode).toBe(0);
      expect(vert.stdout).toContain("row 1");
      expect(vert.stdout).toContain("title │ Alien");
    } finally {
      rmrf(dir);
    }
  });

  it("-o infers markdown/html from the file extension", async () => {
    const dir = tmpDataDir("ditto-e2e-");
    try {
      await cli([
        "dql",
        "INSERT INTO movies DOCUMENTS ({'_id':'o1','title':'Out','year':2001}) ON ID CONFLICT DO UPDATE",
        "-d",
        dir,
      ]);
      const mdPath = path.join(dir, "results.md");
      const md = (await cli([
        "dql",
        "SELECT * FROM movies",
        "-d",
        dir,
        "-o",
        mdPath,
      ])) as unknown as RunResult;
      expect(md.exitCode).toBe(0);
      expect(md.stdout).toContain("(markdown)");
      expect(fs.readFileSync(mdPath, "utf8")).toContain("| _id | title | year |");

      const htmlPath = path.join(dir, "results.html");
      const html = (await cli([
        "dql",
        "SELECT * FROM movies",
        "-d",
        dir,
        "-o",
        htmlPath,
      ])) as unknown as RunResult;
      expect(html.exitCode).toBe(0);
      expect(html.stdout).toContain("(html)");
      expect(fs.readFileSync(htmlPath, "utf8")).toContain("<td>Out</td>");
    } finally {
      rmrf(dir);
    }
  });

  it("--args - reads params from stdin (the jq pipeline form)", async () => {
    const dir = tmpDataDir("ditto-e2e-");
    try {
      await cli([
        "dql",
        "INSERT INTO movies DOCUMENTS ({'_id':'p1','title':'Alien','year':1979}), ({'_id':'p2','title':'Toy Story','year':1995}) ON ID CONFLICT DO UPDATE",
        "-d",
        dir,
      ]);
      const r = (await cli(
        ["dql", "SELECT title FROM movies WHERE year > :minYear", "-d", dir, "--args", "-"],
        { input: '{"minYear":1980}' },
      )) as unknown as RunResult;
      expect(r.exitCode).toBe(0);
      expect(JSON.parse(r.stdout)).toEqual([{ title: "Toy Story" }]);
    } finally {
      rmrf(dir);
    }
  });

  it("--args @file reads params from a file", async () => {
    const dir = tmpDataDir("ditto-e2e-");
    try {
      await cli([
        "dql",
        "INSERT INTO movies DOCUMENTS ({'_id':'p1','title':'Alien','year':1979}) ON ID CONFLICT DO UPDATE",
        "-d",
        dir,
      ]);
      const paramsFile = path.join(dir, "params.json");
      fs.writeFileSync(paramsFile, '{"maxYear":1990}', "utf8");
      const r = (await cli([
        "dql",
        "SELECT title FROM movies WHERE year < :maxYear",
        "-d",
        dir,
        "--args",
        `@${paramsFile}`,
      ])) as unknown as RunResult;
      expect(r.exitCode).toBe(0);
      expect(JSON.parse(r.stdout)).toEqual([{ title: "Alien" }]);
    } finally {
      rmrf(dir);
    }
  });

  it("--args source errors are usage errors (exit 2)", async () => {
    const dir = tmpDataDir("ditto-e2e-");
    try {
      // stdin is the statement batch — --args - has nothing to read from
      const conflict = (await cli(["dql", "-d", dir, "--args", "-"], {
        input: "SELECT 1;",
      })) as unknown as RunResult;
      expect(conflict.exitCode).toBe(2);
      expect(conflict.stderr).toContain("consumes stdin");

      const badJson = (await cli(["dql", "SELECT 1", "-d", dir, "--args", "-"], {
        input: "not json",
      })) as unknown as RunResult;
      expect(badJson.exitCode).toBe(2);

      const array = (await cli(["dql", "SELECT 1", "-d", dir, "--args", "-"], {
        input: "[1,2]",
      })) as unknown as RunResult;
      expect(array.exitCode).toBe(2);

      const missing = (await cli([
        "dql",
        "SELECT 1",
        "-d",
        dir,
        "--args",
        "@/no/such/file.json",
      ])) as unknown as RunResult;
      expect(missing.exitCode).toBe(2);
      expect(missing.stderr).toContain("cannot read");
    } finally {
      rmrf(dir);
    }
  });

  it("--no-pager is accepted", async () => {
    const dir = tmpDataDir("ditto-e2e-");
    try {
      await cli([
        "dql",
        "INSERT INTO movies DOCUMENTS ({'_id':'np1','title':'Alien'}) ON ID CONFLICT DO UPDATE",
        "-d",
        dir,
      ]);
      const r = (await cli([
        "dql",
        "SELECT title FROM movies",
        "-d",
        dir,
        "--no-pager",
      ])) as unknown as RunResult;
      expect(r.exitCode).toBe(0);
      expect(JSON.parse(r.stdout)).toEqual([{ title: "Alien" }]);
    } finally {
      rmrf(dir);
    }
  });
});
