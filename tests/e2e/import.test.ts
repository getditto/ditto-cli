import fs from "node:fs";
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

describe.skipIf(!hasDevCredentials)(`e2e: dql import (${NO_CREDENTIALS})`, () => {
  it("imports a JSON array and queries it back", async () => {
    const dir = tmpDataDir("ditto-e2e-");
    const file = path.join(dir, "in.json");
    fs.writeFileSync(
      file,
      JSON.stringify([
        { _id: "imp_1", name: "Brass Hammer", price: 24.99, tags: ["hand", "clearance"] },
        { _id: "imp_2", name: "Cordless Drill", price: 129.0 },
      ]),
      "utf8",
    );
    try {
      const r = (await cli([
        "dql",
        "import",
        file,
        "imported_products",
        "-d",
        dir,
      ])) as unknown as RunResult;
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("Imported 2 documents into imported_products");

      const sel = (await cli([
        "dql",
        "SELECT name, price, tags FROM imported_products ORDER BY _id",
        "-d",
        dir,
      ])) as unknown as RunResult;
      expect(JSON.parse(sel.stdout)).toEqual([
        { name: "Brass Hammer", price: 24.99, tags: ["hand", "clearance"] },
        { name: "Cordless Drill", price: 129 },
      ]);
    } finally {
      rmrf(dir);
    }
  });

  it("re-importing the same file is idempotent (upsert)", async () => {
    const dir = tmpDataDir("ditto-e2e-");
    const file = path.join(dir, "in.json");
    fs.writeFileSync(file, JSON.stringify([{ _id: "imp_1", v: 1 }]), "utf8");
    try {
      await cli(["dql", "import", file, "things", "-d", dir]);
      const again = (await cli([
        "dql",
        "import",
        file,
        "things",
        "-d",
        dir,
      ])) as unknown as RunResult;
      expect(again.exitCode).toBe(0);
      const count = (await cli([
        "dql",
        "SELECT count(*) AS n FROM things",
        "-d",
        dir,
      ])) as unknown as RunResult;
      expect(JSON.parse(count.stdout)).toEqual([{ n: 1 }]);
    } finally {
      rmrf(dir);
    }
  });

  it("accepts NDJSON (one object per line)", async () => {
    const dir = tmpDataDir("ditto-e2e-");
    const file = path.join(dir, "in.ndjson");
    fs.writeFileSync(file, '{"_id":"n1","v":1}\n{"_id":"n2","v":2}\n', "utf8");
    try {
      const r = (await cli(["dql", "import", file, "nd", "-d", dir])) as unknown as RunResult;
      expect(r.exitCode).toBe(0);
      const count = (await cli([
        "dql",
        "SELECT count(*) AS n FROM nd",
        "-d",
        dir,
      ])) as unknown as RunResult;
      expect(JSON.parse(count.stdout)).toEqual([{ n: 2 }]);
    } finally {
      rmrf(dir);
    }
  });

  it("documents without _id get a generated UUID", async () => {
    const dir = tmpDataDir("ditto-e2e-");
    const file = path.join(dir, "in.json");
    fs.writeFileSync(file, JSON.stringify([{ name: "no id here" }]), "utf8");
    try {
      const r = (await cli(["dql", "import", file, "gen", "-d", dir])) as unknown as RunResult;
      expect(r.exitCode).toBe(0);
      const sel = (await cli([
        "dql",
        "SELECT _id, name FROM gen",
        "-d",
        dir,
      ])) as unknown as RunResult;
      const rows = JSON.parse(sel.stdout);
      expect(rows[0].name).toBe("no id here");
      expect(rows[0]._id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/);
    } finally {
      rmrf(dir);
    }
  });

  it("bad inputs are usage errors (exit 2)", async () => {
    const dir = tmpDataDir("ditto-e2e-");
    const good = path.join(dir, "ok.json");
    fs.writeFileSync(good, '[{"_id":"1"}]', "utf8");
    const bad = path.join(dir, "bad.json");
    fs.writeFileSync(bad, "not json at all", "utf8");
    try {
      const missing = (await cli([
        "dql",
        "import",
        path.join(dir, "nope.json"),
        "things",
        "-d",
        dir,
      ])) as unknown as RunResult;
      expect(missing.exitCode).toBe(2);
      expect(missing.stderr).toContain("Cannot read file");

      const invalid = (await cli([
        "dql",
        "import",
        bad,
        "things",
        "-d",
        dir,
      ])) as unknown as RunResult;
      expect(invalid.exitCode).toBe(2);

      const badName = (await cli([
        "dql",
        "import",
        good,
        "x;DROP TABLE y",
        "-d",
        dir,
      ])) as unknown as RunResult;
      expect(badName.exitCode).toBe(2);
      expect(badName.stderr).toContain("invalid collection name");

      // Nothing was written on the usage-error paths.
      const count = (await cli([
        "dql",
        "SELECT count(*) AS n FROM things",
        "-d",
        dir,
      ])) as unknown as RunResult;
      expect(JSON.parse(count.stdout)).toEqual([{ n: 0 }]);
    } finally {
      rmrf(dir);
    }
  });
});
