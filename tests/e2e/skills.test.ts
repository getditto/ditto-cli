import fs from "node:fs";
import path from "node:path";
import { execa } from "execa";
import * as tar from "tar";
import { describe, expect, it } from "vitest";
import { rmrf, tmpDataDir } from "../helpers/credentials.js";

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

/** Build a real codeload-shaped fixture tarball with a minimal dql skill. */
async function makeFixture(): Promise<string> {
  const src = tmpDataDir("ditto-e2e-tar-src-");
  const root = "getditto-agent-skills-fixture";
  const skillDir = path.join(src, root, "skills", "dql");
  fs.mkdirSync(path.join(skillDir, "references"), { recursive: true });
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), "# dql skill\nUse DQL like a pro.\n", "utf8");
  fs.writeFileSync(path.join(skillDir, "references", "indexing.md"), "# indexing\n", "utf8");
  const tgz = path.join(tmpDataDir("ditto-e2e-tar-"), "fixture.tar.gz");
  await tar.c({ file: tgz, cwd: src }, [root]);
  rmrf(src);
  return tgz;
}

describe("e2e: ditto skills (fixture tarball seam)", () => {
  it("add --project installs the skill and list shows it", async () => {
    const tgz = await makeFixture();
    const proj = tmpDataDir("ditto-e2e-proj-");
    const home = tmpDataDir("ditto-e2e-home-");
    try {
      const add = (await cli(["skills", "add", "--agent", "claude", "--project", proj], {
        DITTOSH_SKILLS_TARBALL: tgz,
        HOME: home,
      })) as unknown as RunResult;
      expect(add.exitCode).toBe(0);
      expect(add.stdout).toContain("installed");
      expect(add.stdout).toContain("fixture");
      expect(fs.existsSync(path.join(proj, ".claude", "skills", "dql", "SKILL.md"))).toBe(true);
      expect(
        fs.existsSync(path.join(proj, ".claude", "skills", "dql", "references", "indexing.md")),
      ).toBe(true);

      const list = (await cli(["skills", "list", "--project", proj], {
        DITTOSH_SKILLS_TARBALL: tgz,
        HOME: home,
      })) as unknown as RunResult;
      expect(list.exitCode).toBe(0);
      expect(list.stdout).toContain("dql");
      expect(list.stdout).toContain("fixture");
      expect(list.stdout).toContain("project");
    } finally {
      rmrf(proj);
      rmrf(home);
      rmrf(path.dirname(tgz));
    }
  });

  it("update is a no-op when already current", async () => {
    const tgz = await makeFixture();
    const proj = tmpDataDir("ditto-e2e-proj-");
    const home = tmpDataDir("ditto-e2e-home-");
    try {
      await cli(["skills", "add", "--agent", "claude", "--project", proj], {
        DITTOSH_SKILLS_TARBALL: tgz,
        HOME: home,
      });
      const upd = (await cli(["skills", "update", "--project", proj], {
        DITTOSH_SKILLS_TARBALL: tgz,
        HOME: home,
      })) as unknown as RunResult;
      expect(upd.exitCode).toBe(0);
      expect(upd.stdout).toContain("already on fixture");
    } finally {
      rmrf(proj);
      rmrf(home);
      rmrf(path.dirname(tgz));
    }
  });

  it("usage errors: bogus --format exits 2, missing --project path exits 2", async () => {
    const tgz = await makeFixture();
    const proj = tmpDataDir("ditto-e2e-proj-");
    const home = tmpDataDir("ditto-e2e-home-");
    try {
      const badFormat = (await cli(["skills", "list", "--format", "yaml"], {
        DITTOSH_SKILLS_TARBALL: tgz,
        HOME: home,
      })) as unknown as RunResult;
      expect(badFormat.exitCode).toBe(2);

      const badProject = (await cli(
        ["skills", "add", "--agent", "claude", "--project", "/nonexistent-xyz"],
        { DITTOSH_SKILLS_TARBALL: tgz, HOME: home },
      )) as unknown as RunResult;
      expect(badProject.exitCode).toBe(2);
      expect(badProject.stderr).toContain("does not exist");
    } finally {
      rmrf(proj);
      rmrf(home);
      rmrf(path.dirname(tgz));
    }
  });

  it("private-repo guidance when the seam is absent and no token (real network path)", async () => {
    const home = tmpDataDir("ditto-e2e-home-");
    try {
      const r = (await cli(["skills", "add", "--agent", "claude"], {
        HOME: home,
      })) as unknown as RunResult;
      // Private repo without a token: actionable guidance, stdout stays empty
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("GITHUB_TOKEN");
      expect(r.stdout).toBe("");
    } finally {
      rmrf(home);
    }
  });
});
