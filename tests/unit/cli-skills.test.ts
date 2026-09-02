import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import * as tar from "tar";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerSkillsGroup } from "../../src/cli/groups/skills/index.js";
import { rmrf, tmpDataDir } from "../helpers/credentials.js";

/** Build a real codeload-shaped tarball containing a minimal dql skill. */
async function skillTarball(): Promise<Buffer> {
  const src = tmpDataDir("ditto-tar-src-");
  const root = "getditto-agent-skills-abc123";
  const skillDir = path.join(src, root, "skills", "dql");
  fs.mkdirSync(path.join(skillDir, "examples"), { recursive: true });
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), "# dql skill\n", "utf8");
  fs.writeFileSync(path.join(skillDir, "examples", "movies.md"), "# movies\n", "utf8");
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

async function buildCli(tarball: Buffer) {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  const skills = program.command("skills");
  registerSkillsGroup(skills, {
    resolveRef: async () => "v9.9.9",
    fetchTarball: async () => tarball,
    home,
  });
  return program;
}

const stdout = () => outSpy.mock.calls.flat().join("\n");
const stderr = () => errSpy.mock.calls.flat().join("\n");

describe("ditto skills add (injected deps)", () => {
  it("installs the skill into every detected agent and reports", async () => {
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
    const program = await buildCli(await skillTarball());
    await program.parseAsync(["node", "ditto", "skills", "add"]);
    expect(process.exitCode).toBeUndefined();
    const claudeTarget = path.join(home, ".claude", "skills", "dql");
    const codexTarget = path.join(home, ".codex", "skills", "dql");
    expect(fs.existsSync(path.join(claudeTarget, "SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(codexTarget, "examples", "movies.md"))).toBe(true);
    // markers record provenance
    expect(
      JSON.parse(fs.readFileSync(path.join(claudeTarget, ".dql-skill.json"), "utf8")).ref,
    ).toBe("v9.9.9");
    expect(stdout()).toContain("installed");
    expect(stderr()).toContain("v9.9.9");
  });

  it("--agent narrows to the named agents only", async () => {
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
    const program = await buildCli(await skillTarball());
    await program.parseAsync(["node", "ditto", "skills", "add", "--agent", "claude"]);
    expect(fs.existsSync(path.join(home, ".claude", "skills", "dql", "SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(home, ".codex", "skills", "dql"))).toBe(false);
  });

  it("--project installs project-locally", async () => {
    const proj = tmpDataDir("ditto-proj-");
    try {
      const program = await buildCli(await skillTarball());
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
      expect(fs.existsSync(path.join(proj, ".claude", "skills", "dql", "SKILL.md"))).toBe(true);
      expect(fs.existsSync(path.join(home, ".claude"))).toBe(false);
    } finally {
      rmrf(proj);
    }
  });

  it("unknown agent names are skipped with a detail, not a crash", async () => {
    const program = await buildCli(await skillTarball());
    await program.parseAsync(["node", "ditto", "skills", "add", "--agent", "claude,nope"]);
    expect(stdout()).toContain("nope");
    expect(stdout()).toContain("unknown agent"); // detail column is in the results table (stdout)
    expect(stderr()).toContain("skipped");
    expect(process.exitCode).toBeUndefined(); // partial success is fine
  });

  it("re-install without --force is skipped; with --force overwrites", async () => {
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    const program = await buildCli(await skillTarball());
    await program.parseAsync(["node", "ditto", "skills", "add", "--agent", "claude"]);
    await (await buildCli(await skillTarball())).parseAsync([
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
    await (await buildCli(await skillTarball())).parseAsync([
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
      const program = await buildCli(await skillTarball());
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
    const program = await buildCli(await skillTarball());
    await program.parseAsync(["node", "ditto", "skills", "add", "--agent", "claude"]);
    outSpy.mockClear();
    await (await buildCli(await skillTarball())).parseAsync(["node", "ditto", "skills", "list"]);
    expect(stdout()).toContain("dql");
    expect(stdout()).toContain("v9.9.9");
    expect(stdout()).toContain("global");
  });

  it("empty machine shows (no skills installed)", async () => {
    const program = await buildCli(await skillTarball());
    await program.parseAsync(["node", "ditto", "skills", "list"]);
    // non-TTY → JSON: empty result on stdout, human note on stderr
    expect(stdout()).toContain("[]");
    expect(stderr()).toContain("no skills installed");
  });
});

describe("ditto skills update", () => {
  it("no installs → prints guidance, exit 0", async () => {
    const program = await buildCli(await skillTarball());
    await program.parseAsync(["node", "ditto", "skills", "update"]);
    expect(stdout()).toContain("[]");
    expect(stderr()).toContain("nothing to update");
    expect(process.exitCode).toBeUndefined();
  });

  it("updates installed skills to the new ref", async () => {
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    await (await buildCli(await skillTarball())).parseAsync([
      "node",
      "ditto",
      "skills",
      "add",
      "--agent",
      "claude",
    ]);
    const target = path.join(home, ".claude", "skills", "dql");
    expect(JSON.parse(fs.readFileSync(path.join(target, ".dql-skill.json"), "utf8")).ref).toBe(
      "v9.9.9",
    );

    outSpy.mockClear();
    const program = await buildCli(await skillTarball());
    await program.parseAsync(["node", "ditto", "skills", "update"]);
    expect(stdout()).toContain("already on v9.9.9"); // same ref → no-op
    // simulate a new upstream ref
    const program2 = new Command();
    program2.exitOverride();
    program2.configureOutput({ writeOut: () => {}, writeErr: () => {} });
    const skills2 = program2.command("skills");
    registerSkillsGroup(skills2, {
      resolveRef: async () => "v10.0.0",
      fetchTarball: async () => await skillTarball(),
      home,
    });
    outSpy.mockClear();
    await program2.parseAsync(["node", "ditto", "skills", "update"]);
    expect(stdout()).toContain("updated");
    expect(stdout()).toContain("v9.9.9 → v10.0.0");
    expect(JSON.parse(fs.readFileSync(path.join(target, ".dql-skill.json"), "utf8")).ref).toBe(
      "v10.0.0",
    );
  });
});

describe("ditto skills — branch matrix", () => {
  it("--format bogus on add exits 2 (FormatError mapped)", async () => {
    const program = await buildCli(await skillTarball());
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
      home,
    });
    await program.parseAsync(["node", "ditto", "skills", "add"]);
    expect(process.exitCode).toBe(1);
    expect(stderr()).toContain("private repo guidance");
    expect(stdout()).toBe("");
  });

  it("--skill and --all forms are accepted", async () => {
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    const program = await buildCli(await skillTarball());
    await program.parseAsync([
      "node",
      "ditto",
      "skills",
      "add",
      "--skill",
      "dql",
      "--agent",
      "claude",
    ]);
    expect(process.exitCode).toBeUndefined();
  });

  it("list --project scans project-local installs", async () => {
    const proj = tmpDataDir("ditto-proj-");
    try {
      const dir = path.join(proj, ".claude", "skills", "dql");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "SKILL.md"), "# dql\n", "utf8");
      fs.writeFileSync(
        path.join(dir, ".dql-skill.json"),
        JSON.stringify({
          skill: "dql",
          ref: "main",
          installedAt: "2026-01-01",
          channel: "project",
        }),
        "utf8",
      );
      const program = await buildCli(await skillTarball());
      await program.parseAsync(["node", "ditto", "skills", "list", "--project", proj]);
      expect(stdout()).toContain("project");
      expect(stdout()).toContain("main");
    } finally {
      rmrf(proj);
    }
  });

  it("update exits 2 when every reinstall fails", async () => {
    // install, then make the parent read+execute-only (555: listing/traversal OK, write blocked)
    fs.mkdirSync(path.join(home, ".claude", "skills"), { recursive: true });
    await (await buildCli(await skillTarball())).parseAsync([
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
      const program = new Command();
      program.exitOverride();
      program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
      const skills = program.command("skills");
      registerSkillsGroup(skills, {
        resolveRef: async () => "v10.0.0",
        fetchTarball: async () => await skillTarball(),
        home,
      });
      await program.parseAsync(["node", "ditto", "skills", "update"]);
      expect(process.exitCode).toBe(2);
      expect(stdout()).toContain("skipped");
    } finally {
      fs.chmodSync(parent, 0o755);
    }
  });
});
