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

/** Build a real codeload-shaped fixture tarball with three skills. */
async function makeFixture(): Promise<string> {
  const src = tmpDataDir("ditto-e2e-tar-src-");
  const root = "getditto-agent-skills-fixture";
  const writeSkill = (name: string, extra: Record<string, string> = {}) => {
    const dir = path.join(src, root, "skills", name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "SKILL.md"), `# ${name} skill\n`, "utf8");
    for (const [rel, content] of Object.entries(extra)) {
      const full = path.join(dir, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content, "utf8");
    }
  };
  writeSkill("write-dql", { "references/indexing.md": "# indexing\n" });
  writeSkill("swift-sdk", { "references/lifetimes.md": "# lifetimes\n" });
  writeSkill("kotlin-sdk");
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
      expect(fs.existsSync(path.join(proj, ".claude", "skills", "write-dql", "SKILL.md"))).toBe(
        true,
      );
      expect(
        fs.existsSync(
          path.join(proj, ".claude", "skills", "write-dql", "references", "indexing.md"),
        ),
      ).toBe(true);

      const list = (await cli(["skills", "list", "--project", proj], {
        DITTOSH_SKILLS_TARBALL: tgz,
        HOME: home,
      })) as unknown as RunResult;
      expect(list.exitCode).toBe(0);
      expect(list.stdout).toContain("write-dql");
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

  it("positional name installs that skill; --all installs every skill", async () => {
    const tgz = await makeFixture();
    const proj = tmpDataDir("ditto-e2e-proj-");
    const home = tmpDataDir("ditto-e2e-home-");
    try {
      const one = (await cli(
        ["skills", "add", "swift-sdk", "--agent", "claude", "--project", proj],
        { DITTOSH_SKILLS_TARBALL: tgz, HOME: home },
      )) as unknown as RunResult;
      expect(one.exitCode).toBe(0);
      expect(fs.existsSync(path.join(proj, ".claude", "skills", "swift-sdk", "SKILL.md"))).toBe(
        true,
      );
      expect(fs.existsSync(path.join(proj, ".claude", "skills", "kotlin-sdk"))).toBe(false);

      const all = (await cli(
        ["skills", "add", "--all", "--agent", "claude", "--project", proj, "--force"],
        { DITTOSH_SKILLS_TARBALL: tgz, HOME: home },
      )) as unknown as RunResult;
      expect(all.exitCode).toBe(0);
      for (const name of ["write-dql", "swift-sdk", "kotlin-sdk"]) {
        expect(fs.existsSync(path.join(proj, ".claude", "skills", name, "SKILL.md"))).toBe(true);
      }

      // update --all is then a no-op at the same ref
      const upd = (await cli(["skills", "update", "--all", "--project", proj], {
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

  it("unknown skill exits 2 with the available list; versions reports no releases under the seam", async () => {
    const tgz = await makeFixture();
    const proj = tmpDataDir("ditto-e2e-proj-");
    const home = tmpDataDir("ditto-e2e-home-");
    try {
      const bad = (await cli(["skills", "add", "nope", "--agent", "claude", "--project", proj], {
        DITTOSH_SKILLS_TARBALL: tgz,
        HOME: home,
      })) as unknown as RunResult;
      expect(bad.exitCode).toBe(2);
      expect(bad.stderr).toContain("unknown skill 'nope'");
      expect(bad.stderr).toContain("swift-sdk");
      expect(bad.stdout).toBe("");

      const versions = (await cli(["skills", "versions"], {
        DITTOSH_SKILLS_TARBALL: tgz,
        HOME: home,
      })) as unknown as RunResult;
      expect(versions.exitCode).toBe(0);
      expect(versions.stderr).toContain("main");
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
