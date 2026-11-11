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

  it("installs into antigravity's global dir (current + legacy detection)", async () => {
    const tgz = await makeFixture();
    const home = tmpDataDir("ditto-e2e-home-");
    const proj = tmpDataDir("ditto-e2e-proj-");
    try {
      // Antigravity IDE present (legacy dir) → detected; explicit target.
      fs.mkdirSync(path.join(home, ".gemini", "antigravity"), { recursive: true });
      const add = (await cli(["skills", "add", "swift-sdk", "--agent", "antigravity"], {
        DITTOSH_SKILLS_TARBALL: tgz,
        HOME: home,
      })) as unknown as RunResult;
      expect(add.exitCode).toBe(0);
      expect(
        fs.existsSync(path.join(home, ".gemini", "config", "skills", "swift-sdk", "SKILL.md")),
      ).toBe(true);

      // Project scope uses the shared .agents/skills convention.
      const proj2 = tmpDataDir("ditto-e2e-proj2-");
      try {
        const addProj = (await cli(
          ["skills", "add", "swift-sdk", "--agent", "antigravity", "--project", proj2],
          { DITTOSH_SKILLS_TARBALL: tgz, HOME: home },
        )) as unknown as RunResult;
        expect(addProj.exitCode).toBe(0);
        expect(fs.existsSync(path.join(proj2, ".agents", "skills", "swift-sdk", "SKILL.md"))).toBe(
          true,
        );
      } finally {
        rmrf(proj2);
      }
    } finally {
      rmrf(proj);
      rmrf(home);
      rmrf(path.dirname(tgz));
    }
  });

  it("prints authentication guidance when GitHub rejects the request", async () => {
    const r = await execa(
      process.execPath,
      [
        "--import",
        "tsx",
        "--import",
        "./tests/helpers/deny-network.ts",
        "src/cli/index.ts",
        "skills",
        "add",
        "--agent",
        "claude",
      ],
      { cwd: ROOT, reject: false, input: "" },
    );
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("GITHUB_TOKEN");
    expect(r.stdout).toBe("");
  });
});

describe("e2e: ditto skills companions", () => {
  /** Release-asset-shaped fixture: js-node links to js-sdk. */
  async function companionFixture(): Promise<string> {
    const src = tmpDataDir("ditto-e2e-js-src-");
    const write = (rel: string, text: string) => {
      fs.mkdirSync(path.dirname(path.join(src, rel)), { recursive: true });
      fs.writeFileSync(path.join(src, rel), text, "utf8");
    };
    write("skills/js-node/SKILL.md", "See [js-sdk](../js-sdk/SKILL.md).\n");
    write("skills/js-sdk/SKILL.md", "# js-sdk\n");
    write("skills/write-dql/SKILL.md", "# write-dql\n");
    const tgz = path.join(tmpDataDir("ditto-e2e-js-"), "ditto-skills.tar.gz");
    await tar.c({ file: tgz, gzip: true, cwd: src }, ["skills"]);
    rmrf(src);
    return tgz;
  }

  it("add installs linked skills; --no-deps installs only the named one", async () => {
    const tgz = await companionFixture();
    const proj = tmpDataDir("ditto-e2e-proj-");
    const home = tmpDataDir("ditto-e2e-home-");
    const env = { DITTOSH_SKILLS_TARBALL: tgz, HOME: home };
    try {
      const add = (await cli(
        ["skills", "add", "js-node", "--agent", "claude", "--project", proj, "--format", "json"],
        env,
      )) as unknown as RunResult;
      expect(add.exitCode).toBe(0);
      const rows = JSON.parse(add.stdout) as { skill: string; status: string; detail: string }[];
      expect(rows.map((r) => [r.skill, r.status])).toEqual([
        ["js-node", "installed"],
        ["js-sdk", "installed"],
      ]);
      expect(rows[1]!.detail).toBe("companion of js-node");
      expect(add.stderr).toContain("js-node links to companion skill js-sdk");
      expect(fs.existsSync(path.join(proj, ".claude", "skills", "write-dql"))).toBe(false);

      fs.rmSync(path.join(proj, ".claude", "skills"), { recursive: true, force: true });
      const solo = (await cli(
        ["skills", "add", "js-node", "--no-deps", "--agent", "claude", "--project", proj],
        env,
      )) as unknown as RunResult;
      expect(solo.exitCode).toBe(0);
      expect(solo.stderr).not.toContain("companion");
      expect(fs.readdirSync(path.join(proj, ".claude", "skills"))).toEqual(["js-node"]);
    } finally {
      rmrf(proj);
      rmrf(home);
      rmrf(path.dirname(tgz));
    }
  });
});
