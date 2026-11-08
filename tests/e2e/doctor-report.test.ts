import fs from "node:fs";
import path from "node:path";
import { execa } from "execa";
import * as tar from "tar";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hasDevCredentials, NO_CREDENTIALS, rmrf, tmpDataDir } from "../helpers/credentials.js";

const ROOT = path.resolve(import.meta.dirname, "../..");

describe.skipIf(!hasDevCredentials)(`e2e: doctor --report (${NO_CREDENTIALS})`, () => {
  let dir: string;
  let store: string;
  let cfg: string;

  const cli = (args: string[], env: Record<string, string> = {}) =>
    execa(process.execPath, ["--import", "tsx", "src/cli/index.ts", ...args], {
      cwd: ROOT,
      reject: false,
      input: "",
      env: { DITTOSH_CONFIG_DIR: cfg, ...env },
    });

  beforeAll(async () => {
    dir = tmpDataDir("ditto-report-e2e-");
    store = path.join(dir, "store");
    cfg = path.join(dir, "cfg");
    const r = await cli(["dql", "INSERT INTO cars DOCUMENTS ({'_id': 'a'})", "-d", store]);
    expect(r.exitCode).toBe(0);
  }, 120_000);
  afterAll(() => rmrf(dir));

  it("a failed command is saved, and doctor --report bundles it with the SDK bundle", async () => {
    const bad = await cli(["dql", "SELEC oops FROM cars", "-d", store]);
    expect(bad.exitCode).toBe(1);
    const last = JSON.parse(fs.readFileSync(path.join(cfg, "last-error.json"), "utf8"));
    expect(last.command).toContain("SELEC oops FROM cars");
    expect(last.stderr.join("\n")).toContain("Query error");

    const out = path.join(dir, "report.tar.gz");
    const r = await cli(["doctor", "-d", store, "--report", out]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("✓ platform");
    expect(r.stdout).not.toContain("Wrote");
    expect(r.stderr).toContain("Wrote");
    expect(r.stderr).toContain("issues/new");

    const names: string[] = [];
    await tar.t({ file: out, onReadEntry: (e) => names.push(e.path) });
    expect(names.sort()).toEqual([
      "report/",
      "report/ditto-support-bundle.tar",
      "report/report.json",
      "report/report.md",
    ]);
    const x = path.join(dir, "x");
    fs.mkdirSync(x);
    await tar.x({ file: out, cwd: x });
    const md = fs.readFileSync(path.join(x, "report", "report.md"), "utf8");
    expect(md).toContain("| cars | 1 |");
    expect(md).toContain("SELEC oops FROM cars");

    // Running doctor didn't replace the saved error.
    expect(
      JSON.parse(fs.readFileSync(path.join(cfg, "last-error.json"), "utf8")).command,
    ).toContain("SELEC oops FROM cars");
  }, 120_000);

  it("dql support-bundle saves the SDK bundle; --list shows it as JSON when piped", async () => {
    const out = path.join(dir, "sb.tar");
    const r = await cli(["dql", "support-bundle", "-d", store, "-o", out]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("");
    expect(fs.statSync(out).size).toBeGreaterThan(0);
    const list = await cli(["dql", "support-bundle", "-d", store, "--list"]);
    expect(list.exitCode).toBe(0);
    expect(JSON.parse(list.stdout).length).toBeGreaterThanOrEqual(1);
  }, 120_000);

  it("--debug sends SDK logs to stderr and leaves stdout as clean JSON", async () => {
    const r = await cli(["--debug", "dql", "SELECT count(*) AS n FROM cars", "-d", store]);
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual([{ n: 1 }]);
    expect(r.stderr).toContain("DEBUG");
    const quiet = await cli(["dql", "SELECT count(*) AS n FROM cars", "-d", store]);
    expect(quiet.stderr).not.toContain("DEBUG");
  }, 120_000);
});
