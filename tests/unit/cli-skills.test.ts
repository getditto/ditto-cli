import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import * as tar from "tar";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerSkillsGroup } from "../../src/cli/groups/skills/index.js";
import type { ReleaseInfo } from "../../src/skills/github.js";
import { rmrf, tmpDataDir } from "../helpers/credentials.js";

/**
 * Build a real codeload-shaped tarball holding three skills (write-dql with a
 * nested examples/ dir, swift-sdk, kotlin-sdk) plus a skills/ dir without a
 * SKILL.md to prove it isn't treated as a skill.
 */
async function skillTarball(): Promise<Buffer> {
  const src = tmpDataDir("ditto-tar-src-");
  const root = "getditto-agent-skills-abc123";
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
  writeSkill("write-dql", { "examples/movies.md": "# movies\n" });
  writeSkill("swift-sdk", { "references/lifetimes.md": "# lifetimes\n" });
  writeSkill("kotlin-sdk");
  fs.mkdirSync(path.join(src, root, "skills", "no-skillmd"), { recursive: true });
  fs.writeFileSync(path.join(src, root, "skills", "no-skillmd", "README.md"), "# not a skill\n");
  const tgz = path.join(tmpDataDir("ditto-tar-"), "repo.tar.gz");
  await tar.c({ file: tgz, cwd: src }, [root]);
  const buf = fs.readFileSync(tgz);
  rmrf(src);
  rmrf(path.dirname(tgz));
  return buf;
}

let outSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;
let home: string;

beforeEach(() => {
  outSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  home = tmpDataDir("ditto-home-");
  process.exitCode = undefined;
});

afterEach(() => {
  outSpy.mockRestore();
  errSpy.mockRestore();
  rmrf(home);
});

interface FakeDeps {
  tarball: Buffer;
  ref?: string;
  releases?: ReleaseInfo[];
}

async function buildCli({ tarball, ref = "v9.9.9", releases = [] }: FakeDeps) {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  const skills = program.command("skills");
  const calls = { resolveRef: 0, fetchTarball: 0, fetchRefs: [] as string[] };
  registerSkillsGroup(skills, {
    resolveRef: async () => {
      calls.resolveRef++;
      return ref;
    },
    fetchTarball: async (r: string) => {
      calls.fetchTarball++;
      calls.fetchRefs.push(r);
      return tarball;
    },
    listReleases: async () => releases,
    home,
  });
  return { program, calls };
}

const stdout = () => outSpy.mock.calls.flat().join("\n");
const stderr = () => errSpy.mock.calls.flat().join("\n");

describe("ditto skills add (injected deps)", () => {
  it("installs the default skill (write-dql) into every detected agent", async () => {
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
    const { program } = await buildCli({ tarball: await skillTarball() });
    await program.parseAsync(["node", "ditto", "skills", "add"]);
    expect(process.exitCode).toBeUndefined();
    const claudeTarget = path.join(home, ".claude", "skills", "write-dql");
    const codexTarget = path.join(home, ".codex", "skills", "write-dql");
    expect(fs.existsSync(path.join(claudeTarget, "SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(codexTarget, "examples", "movies.md"))).toBe(true);
    // markers record provenance
    expect(
      JSON.parse(fs.readFileSync(path.join(claudeTarget, ".dql-skill.json"), "utf8")).ref,
    ).toBe("v9.9.9");
    expect(stdout()).toContain("installed");
    expect(stdout()).toContain("write-dql");
    expect(stderr()).toContain("v9.9.9");
  });

  it("positional name installs that skill", async () => {
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    const { program } = await buildCli({ tarball: await skillTarball() });
    await program.parseAsync(["node", "ditto", "skills", "add", "swift-sdk", "--agent", "claude"]);
    const target = path.join(home, ".claude", "skills", "swift-sdk");
    expect(fs.existsSync(path.join(target, "SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(target, "references", "lifetimes.md"))).toBe(true);
    expect(process.exitCode).toBeUndefined();
  });

  it("--skill still works as a deprecated alias of the positional", async () => {
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    const { program } = await buildCli({ tarball: await skillTarball() });
    await program.parseAsync([
      "node",
      "ditto",
      "skills",
      "add",
      "--skill",
      "kotlin-sdk",
      "--agent",
      "claude",
    ]);
    expect(fs.existsSync(path.join(home, ".claude", "skills", "kotlin-sdk", "SKILL.md"))).toBe(
      true,
    );
    expect(process.exitCode).toBeUndefined();
  });

  it("conflicting positional and --skill exit 2", async () => {
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    const { program } = await buildCli({ tarball: await skillTarball() });
    await program.parseAsync([
      "node",
      "ditto",
      "skills",
      "add",
      "swift-sdk",
      "--skill",
      "kotlin-sdk",
      "--agent",
      "claude",
    ]);
    expect(process.exitCode).toBe(2);
    expect(stderr()).toContain("conflicting");
  });

  it("the dql alias installs write-dql with a rename note", async () => {
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    const { program } = await buildCli({ tarball: await skillTarball() });
    await program.parseAsync(["node", "ditto", "skills", "add", "dql", "--agent", "claude"]);
    expect(process.exitCode).toBeUndefined();
    expect(fs.existsSync(path.join(home, ".claude", "skills", "write-dql", "SKILL.md"))).toBe(true);
    expect(stderr()).toContain("now 'write-dql'");
  });

  it("unknown skill → exit 2 with the available list", async () => {
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    const { program } = await buildCli({ tarball: await skillTarball() });
    await program.parseAsync(["node", "ditto", "skills", "add", "nope", "--agent", "claude"]);
    expect(process.exitCode).toBe(2);
    expect(stderr()).toContain("unknown skill 'nope'");
    expect(stderr()).toContain("swift-sdk");
    expect(stdout()).toBe("");
  });

  it("--all installs every skill in the archive with a single fetch", async () => {
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    const { program, calls } = await buildCli({ tarball: await skillTarball() });
    await program.parseAsync(["node", "ditto", "skills", "add", "--all", "--agent", "claude"]);
    expect(process.exitCode).toBeUndefined();
    for (const name of ["write-dql", "swift-sdk", "kotlin-sdk"]) {
      expect(fs.existsSync(path.join(home, ".claude", "skills", name, "SKILL.md"))).toBe(true);
    }
    // the no-SKILL.md dir is not a skill
    expect(fs.existsSync(path.join(home, ".claude", "skills", "no-skillmd"))).toBe(false);
    expect(calls.resolveRef).toBe(1);
    expect(calls.fetchTarball).toBe(1);
    expect(stdout().match(/kotlin-sdk/g)?.length).toBeGreaterThan(0);
  });

  it("--ref pins the version and skips latest-release resolution", async () => {
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    const { program, calls } = await buildCli({ tarball: await skillTarball() });
    await program.parseAsync([
      "node",
      "ditto",
      "skills",
      "add",
      "swift-sdk",
      "--agent",
      "claude",
      "--ref",
      "v1.2.3",
    ]);
    expect(process.exitCode).toBeUndefined();
    expect(calls.resolveRef).toBe(0);
    expect(calls.fetchRefs).toEqual(["v1.2.3"]);
    const marker = JSON.parse(
      fs.readFileSync(path.join(home, ".claude", "skills", "swift-sdk", ".dql-skill.json"), "utf8"),
    );
    expect(marker.ref).toBe("v1.2.3");
  });

  it("--agent narrows to the named agents only", async () => {
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
    const { program } = await buildCli({ tarball: await skillTarball() });
    await program.parseAsync(["node", "ditto", "skills", "add", "--agent", "claude"]);
    expect(fs.existsSync(path.join(home, ".claude", "skills", "write-dql", "SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(home, ".codex", "skills", "write-dql"))).toBe(false);
  });

  it("--project installs project-locally", async () => {
    const proj = tmpDataDir("ditto-proj-");
    try {
      const { program } = await buildCli({ tarball: await skillTarball() });
      await program.parseAsync([
        "node",
        "ditto",
        "skills",
        "add",
        "--agent",
        "claude",
        "--project",
        proj,
      ]);
      expect(fs.existsSync(path.join(proj, ".claude", "skills", "write-dql", "SKILL.md"))).toBe(
        true,
      );
      expect(fs.existsSync(path.join(home, ".claude"))).toBe(false);
    } finally {
      rmrf(proj);
    }
  });

  it("unknown agent names are skipped with a detail, not a crash", async () => {
    const { program } = await buildCli({ tarball: await skillTarball() });
    await program.parseAsync(["node", "ditto", "skills", "add", "--agent", "claude,nope"]);
    expect(stdout()).toContain("nope");
    expect(stdout()).toContain("unknown agent"); // detail column is in the results table (stdout)
    expect(stderr()).toContain("skipped");
    expect(process.exitCode).toBeUndefined(); // partial success is fine
  });

  it("re-install without --force is skipped; with --force overwrites", async () => {
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    const { program } = await buildCli({ tarball: await skillTarball() });
    await program.parseAsync(["node", "ditto", "skills", "add", "--agent", "claude"]);
    await (await buildCli({ tarball: await skillTarball() })).program.parseAsync([
      "node",
      "ditto",
      "skills",
      "add",
      "--agent",
      "claude",
    ]);
    expect(stdout()).toContain("already installed");
    expect(process.exitCode).toBe(2); // nothing to do anywhere
    process.exitCode = undefined;
    await (await buildCli({ tarball: await skillTarball() })).program.parseAsync([
      "node",
      "ditto",
      "skills",
      "add",
      "--agent",
      "claude",
      "--force",
    ]);
    expect(process.exitCode).toBeUndefined();
  });

  it("no agents detected → exit 2 with guidance", async () => {
    const emptyProj = tmpDataDir("ditto-empty-");
    try {
      const { program } = await buildCli({ tarball: await skillTarball() });
      await program.parseAsync(["node", "ditto", "skills", "add", "--project", emptyProj]);
      expect(process.exitCode).toBe(2);
      expect(stderr()).toContain("No agents detected");
    } finally {
      rmrf(emptyProj);
    }
  });
});

describe("ditto skills list", () => {
  it("shows installed skills with ref + channel", async () => {
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    const { program } = await buildCli({ tarball: await skillTarball() });
    await program.parseAsync(["node", "ditto", "skills", "add", "--agent", "claude"]);
    outSpy.mockClear();
    await (await buildCli({ tarball: await skillTarball() })).program.parseAsync([
      "node",
      "ditto",
      "skills",
      "list",
    ]);
    expect(stdout()).toContain("write-dql");
    expect(stdout()).toContain("v9.9.9");
    expect(stdout()).toContain("global");
  });

  it("empty machine shows (no skills installed)", async () => {
    const { program } = await buildCli({ tarball: await skillTarball() });
    await program.parseAsync(["node", "ditto", "skills", "list"]);
    // non-TTY → JSON: empty result on stdout, human note on stderr
    expect(stdout()).toContain("[]");
    expect(stderr()).toContain("no skills installed");
  });
});

describe("ditto skills update", () => {
  it("no installs → prints guidance, exit 0", async () => {
    const { program } = await buildCli({ tarball: await skillTarball() });
    await program.parseAsync(["node", "ditto", "skills", "update"]);
    expect(stdout()).toContain("[]");
    expect(stderr()).toContain("nothing to update");
    expect(process.exitCode).toBeUndefined();
  });

  it("updates installed skills to the new ref", async () => {
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    await (await buildCli({ tarball: await skillTarball() })).program.parseAsync([
      "node",
      "ditto",
      "skills",
      "add",
      "--agent",
      "claude",
    ]);
    const target = path.join(home, ".claude", "skills", "write-dql");
    expect(JSON.parse(fs.readFileSync(path.join(target, ".dql-skill.json"), "utf8")).ref).toBe(
      "v9.9.9",
    );

    outSpy.mockClear();
    const { program } = await buildCli({ tarball: await skillTarball() });
    await program.parseAsync(["node", "ditto", "skills", "update"]);
    expect(stdout()).toContain("already on v9.9.9"); // same ref → no-op
    // simulate a new upstream ref
    outSpy.mockClear();
    const next = await buildCli({ tarball: await skillTarball(), ref: "v10.0.0" });
    await next.program.parseAsync(["node", "ditto", "skills", "update"]);
    expect(stdout()).toContain("updated");
    expect(stdout()).toContain("v9.9.9 → v10.0.0");
    expect(JSON.parse(fs.readFileSync(path.join(target, ".dql-skill.json"), "utf8")).ref).toBe(
      "v10.0.0",
    );
  });

  it("update --all refreshes every installed skill, not just the default", async () => {
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    await (await buildCli({ tarball: await skillTarball() })).program.parseAsync([
      "node",
      "ditto",
      "skills",
      "add",
      "--all",
      "--agent",
      "claude",
    ]);
    outSpy.mockClear();
    const next = await buildCli({ tarball: await skillTarball(), ref: "v10.0.0" });
    await next.program.parseAsync(["node", "ditto", "skills", "update", "--all"]);
    expect(process.exitCode).toBeUndefined();
    for (const name of ["write-dql", "swift-sdk", "kotlin-sdk"]) {
      const marker = JSON.parse(
        fs.readFileSync(path.join(home, ".claude", "skills", name, ".dql-skill.json"), "utf8"),
      );
      expect(marker.ref).toBe("v10.0.0");
    }
    expect(stdout()).toContain("v9.9.9 → v10.0.0");
  });

  it("update --all is a no-op when everything is current (no download)", async () => {
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    await (await buildCli({ tarball: await skillTarball() })).program.parseAsync([
      "node",
      "ditto",
      "skills",
      "add",
      "--all",
      "--agent",
      "claude",
    ]);
    outSpy.mockClear();
    const same = await buildCli({ tarball: await skillTarball() });
    await same.program.parseAsync(["node", "ditto", "skills", "update", "--all"]);
    expect(stdout()).toContain("already on v9.9.9");
    expect(same.calls.fetchTarball).toBe(0);
  });

  it("migrates a dql-era install to write-dql and removes the old dir", async () => {
    // Simulate an install from before the rename: dir + marker both say dql.
    const oldDir = path.join(home, ".claude", "skills", "dql");
    fs.mkdirSync(oldDir, { recursive: true });
    fs.writeFileSync(path.join(oldDir, "SKILL.md"), "# old dql\n", "utf8");
    fs.writeFileSync(
      path.join(oldDir, ".dql-skill.json"),
      JSON.stringify({ skill: "dql", ref: "v9.0.0", installedAt: "2026-01-01", channel: "global" }),
      "utf8",
    );
    const next = await buildCli({ tarball: await skillTarball(), ref: "v10.0.0" });
    await next.program.parseAsync(["node", "ditto", "skills", "update"]);
    expect(process.exitCode).toBeUndefined();
    expect(fs.existsSync(oldDir)).toBe(false);
    const newDir = path.join(home, ".claude", "skills", "write-dql");
    const marker = JSON.parse(fs.readFileSync(path.join(newDir, ".dql-skill.json"), "utf8"));
    expect(marker.skill).toBe("write-dql");
    expect(marker.ref).toBe("v10.0.0");
    expect(stdout()).toContain("v9.0.0 → v10.0.0");
  });

  it("update --ref downgrades/pins to the requested release", async () => {
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    await (await buildCli({ tarball: await skillTarball(), ref: "v10.0.0" })).program.parseAsync([
      "node",
      "ditto",
      "skills",
      "add",
      "--agent",
      "claude",
    ]);
    const pin = await buildCli({ tarball: await skillTarball() });
    await pin.program.parseAsync(["node", "ditto", "skills", "update", "--ref", "v9.0.0"]);
    expect(process.exitCode).toBeUndefined();
    expect(pin.calls.resolveRef).toBe(0);
    expect(pin.calls.fetchRefs).toEqual(["v9.0.0"]);
    const marker = JSON.parse(
      fs.readFileSync(path.join(home, ".claude", "skills", "write-dql", ".dql-skill.json"), "utf8"),
    );
    expect(marker.ref).toBe("v9.0.0");
  });
});

describe("ditto skills versions", () => {
  it("lists releases newest-first with the latest marked", async () => {
    const { program } = await buildCli({
      tarball: await skillTarball(),
      releases: [
        { tag: "v1.1.0", name: "", publishedAt: "2026-11-01T00:00:00Z", hasAsset: true },
        { tag: "v1.0.0", name: "", publishedAt: "2026-10-01T00:00:00Z", hasAsset: false },
      ],
    });
    await program.parseAsync(["node", "ditto", "skills", "versions"]);
    expect(process.exitCode).toBeUndefined();
    expect(stdout()).toContain("v1.1.0");
    expect(stdout()).toContain("latest");
    expect(stdout()).toContain("no (full repo)");
    expect(stderr()).toContain("--ref");
  });

  it("no releases → note that installs track main", async () => {
    const { program } = await buildCli({ tarball: await skillTarball(), releases: [] });
    await program.parseAsync(["node", "ditto", "skills", "versions"]);
    expect(stdout()).toContain("[]"); // non-TTY → JSON
    expect(stderr()).toContain("main");
  });
});

describe("ditto skills — branch matrix", () => {
  it("--format bogus on add exits 2 (FormatError mapped)", async () => {
    const { program } = await buildCli({ tarball: await skillTarball() });
    await program.parseAsync(["node", "ditto", "skills", "add", "--format", "yaml"]);
    expect(process.exitCode).toBe(2);
    expect(stderr()).toContain("--format");
  });

  it("fetch failure mid-add exits 1 with guidance (no state change)", async () => {
    const program = new Command();
    program.exitOverride();
    program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
    const skills = program.command("skills");
    const { SkillsFetchError } = await import("../../src/skills/github.js");
    registerSkillsGroup(skills, {
      resolveRef: async () => {
        throw new SkillsFetchError("private repo guidance");
      },
      fetchTarball: async () => Buffer.from("x"),
      listReleases: async () => [],
      home,
    });
    await program.parseAsync(["node", "ditto", "skills", "add"]);
    expect(process.exitCode).toBe(1);
    expect(stderr()).toContain("private repo guidance");
    expect(stdout()).toBe("");
  });

  it("list --project scans project-local installs", async () => {
    const proj = tmpDataDir("ditto-proj-");
    try {
      const dir = path.join(proj, ".claude", "skills", "write-dql");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "SKILL.md"), "# dql\n", "utf8");
      fs.writeFileSync(
        path.join(dir, ".dql-skill.json"),
        JSON.stringify({
          skill: "write-dql",
          ref: "main",
          installedAt: "2026-01-01",
          channel: "project",
        }),
        "utf8",
      );
      const { program } = await buildCli({ tarball: await skillTarball() });
      await program.parseAsync(["node", "ditto", "skills", "list", "--project", proj]);
      expect(stdout()).toContain("project");
      expect(stdout()).toContain("main");
    } finally {
      rmrf(proj);
    }
  });

  // chmod-based read-only enforcement is posix-only
  it.skipIf(process.platform === "win32")("update exits 2 when every reinstall fails", async () => {
    // install, then make the parent read+execute-only (555: listing/traversal OK, write blocked)
    fs.mkdirSync(path.join(home, ".claude", "skills"), { recursive: true });
    await (await buildCli({ tarball: await skillTarball() })).program.parseAsync([
      "node",
      "ditto",
      "skills",
      "add",
      "--agent",
      "claude",
    ]);
    const parent = path.join(home, ".claude", "skills");
    fs.chmodSync(parent, 0o555);
    try {
      // update with a different ref so it tries to reinstall
      const next = await buildCli({ tarball: await skillTarball(), ref: "v10.0.0" });
      await next.program.parseAsync(["node", "ditto", "skills", "update"]);
      expect(process.exitCode).toBe(2);
      expect(stdout()).toContain("skipped");
    } finally {
      fs.chmodSync(parent, 0o755);
    }
  });
});
