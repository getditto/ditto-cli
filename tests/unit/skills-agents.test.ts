import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AGENTS, detectAgents, getAgent, targetDir, targetFile } from "../../src/skills/agents.js";
import { findInstalled, installSkill, MARKER, readMarker } from "../../src/skills/install.js";
import { rmrf, tmpDataDir } from "../helpers/credentials.js";

describe("agent registry", () => {
  it("has the seven spec'd agents", () => {
    expect(AGENTS.map((a) => a.name)).toEqual([
      "claude",
      "opencode",
      "codex",
      "gemini",
      "cursor",
      "copilot",
      "windsurf",
    ]);
  });

  it("claude/opencode/codex/gemini have global + project dirs; cursor/copilot/windsurf are project-only", () => {
    expect(getAgent("claude")!.globalDir).not.toBeNull();
    expect(getAgent("cursor")!.globalDir).toBeNull();
    expect(getAgent("copilot")!.globalDir).toBeNull();
    expect(getAgent("windsurf")!.globalDir).toBeNull();
    expect(getAgent("nope")).toBeUndefined();
  });
});

describe("detectAgents", () => {
  it("detects by global markers", () => {
    const home = tmpDataDir("ditto-home-");
    try {
      fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
      fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
      const found = detectAgents({ home, project: tmpDataDir("ditto-proj-") });
      expect(found.map((a) => a.name)).toEqual(["claude", "codex"]);
    } finally {
      rmrf(home);
    }
  });

  it("detects by project markers", () => {
    const home = tmpDataDir("ditto-home-");
    const root = tmpDataDir("ditto-proj-");
    try {
      fs.mkdirSync(path.join(root, ".agents"), { recursive: true });
      const found = detectAgents({ home, project: root });
      expect(found.map((a) => a.name)).toEqual(["opencode"]);
    } finally {
      rmrf(home);
      rmrf(root);
    }
  });

  it("empty machine detects nothing", () => {
    const found = detectAgents({
      home: tmpDataDir("ditto-home-"),
      project: tmpDataDir("ditto-proj-"),
    });
    expect(found).toEqual([]);
  });
});

describe("targetDir", () => {
  const claude = getAgent("claude")!;
  const cursor = getAgent("cursor")!;

  it("global: <home>/.claude/skills/dql", () => {
    expect(targetDir(claude, "dql", { home: "/home/u" })).toBe(
      path.join("/home/u", ".claude", "skills", "dql"),
    );
  });

  it("project: <project>/.claude/skills/dql", () => {
    expect(targetDir(claude, "dql", { project: "/repo" })).toBe(
      path.join("/repo", ".claude", "skills", "dql"),
    );
  });

  it("project-only agents return null for global", () => {
    expect(targetDir(cursor, "dql", { home: "/home/u" })).toBeNull();
    expect(targetDir(cursor, "dql", { project: "/repo" })).toBe(
      path.join("/repo", ".cursor", "rules", "dql"),
    );
  });
});

describe("installSkill + markers", () => {
  it("installs the tree, writes the marker, refuses re-install without --force", () => {
    const skill = tmpDataDir("ditto-skill-src-");
    const home = tmpDataDir("ditto-home-");
    try {
      fs.writeFileSync(path.join(skill, "SKILL.md"), "# dql\n", "utf8");
      fs.mkdirSync(path.join(skill, "examples"), { recursive: true });
      fs.writeFileSync(path.join(skill, "examples", "x.md"), "ex\n", "utf8");

      const claude = getAgent("claude")!;
      const r1 = installSkill(skill, "dql", claude, "v1.2.3", { home });
      expect(r1.ok).toBe(true);
      const target = r1.target;
      expect(fs.existsSync(path.join(target, "SKILL.md"))).toBe(true);
      expect(fs.existsSync(path.join(target, "examples", "x.md"))).toBe(true);
      const marker = readMarker(target)!;
      expect(marker.skill).toBe("dql");
      expect(marker.ref).toBe("v1.2.3");
      expect(marker.channel).toBe("global");

      const r2 = installSkill(skill, "dql", claude, "v1.2.4", { home });
      expect(r2.ok).toBe(false);
      expect(r2.detail).toContain("already installed");
      expect(readMarker(target)!.ref).toBe("v1.2.3"); // unchanged

      const r3 = installSkill(skill, "dql", claude, "v1.2.4", { home, force: true });
      expect(r3.ok).toBe(true);
      expect(readMarker(target)!.ref).toBe("v1.2.4");
    } finally {
      rmrf(skill);
      rmrf(home);
    }
  });

  it("project channel marks the marker accordingly", () => {
    const skill = tmpDataDir("ditto-skill-src-");
    const proj = tmpDataDir("ditto-proj-");
    try {
      fs.writeFileSync(path.join(skill, "SKILL.md"), "# dql\n", "utf8");
      const r = installSkill(skill, "dql", getAgent("opencode")!, "main", { project: proj });
      expect(r.ok).toBe(true);
      expect(readMarker(r.target)!.channel).toBe("project");
    } finally {
      rmrf(skill);
      rmrf(proj);
    }
  });

  it("findInstalled discovers skills with markers", () => {
    const base = tmpDataDir("ditto-base-");
    try {
      const dir = path.join(base, "dql");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "SKILL.md"), "# dql\n", "utf8");
      fs.writeFileSync(
        path.join(dir, MARKER),
        JSON.stringify({ skill: "dql", ref: "main", installedAt: "2026-01-01", channel: "global" }),
        "utf8",
      );
      const found = findInstalled(base);
      expect(found).toHaveLength(1);
      expect(found[0]!.skill).toBe("dql");
      expect(found[0]!.marker?.ref).toBe("main");
    } finally {
      rmrf(base);
    }
  });

  it("unknown agent / no-project-dir returns ok:false", () => {
    const r = installSkill(tmpDataDir("ditto-skill-src-"), "dql", getAgent("cursor")!, "main", {
      home: "/home/u",
    });
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("no global skills directory");
  });
});

describe("single-file agents (copilot/windsurf)", () => {
  it("targetFile returns the instruction-file path (project scope only)", () => {
    expect(targetFile(getAgent("copilot")!, "dql", { project: "/repo" })).toBe(
      path.join("/repo", ".github", "instructions", "dql.instructions.md"),
    );
    expect(targetFile(getAgent("windsurf")!, "dql", { project: "/repo" })).toBe(
      path.join("/repo", ".windsurf", "rules", "dql.md"),
    );
    expect(targetFile(getAgent("copilot")!, "dql", {})).toBeNull(); // no global form
    expect(targetDir(getAgent("copilot")!, "dql", { project: "/repo" })).toBeNull(); // uses targetFile instead
  });
});

describe("installSkill — failure isolation and single-file emitters", () => {
  it("a read-only target returns ok:false with the error (no crash)", () => {
    const skill = tmpDataDir("ditto-skill-src-");
    const home = tmpDataDir("ditto-home-");
    try {
      fs.writeFileSync(path.join(skill, "SKILL.md"), "# dql\n", "utf8");
      const parent = path.join(home, ".claude", "skills");
      fs.mkdirSync(parent, { recursive: true });
      fs.chmodSync(parent, 0o444); // read-only
      const r = installSkill(skill, "dql", getAgent("claude")!, "v1", { home });
      expect(r.ok).toBe(false);
      expect(r.detail).toBeTruthy();
    } finally {
      fs.chmodSync(path.join(home, ".claude", "skills"), 0o755);
      rmrf(skill);
      rmrf(home);
    }
  });

  it("copilot gets a single flattened instruction file with a marker comment", () => {
    const skill = tmpDataDir("ditto-skill-src-");
    const proj = tmpDataDir("ditto-proj-");
    try {
      fs.writeFileSync(path.join(skill, "SKILL.md"), "# dql\nDo DQL things.\n", "utf8");
      const r = installSkill(skill, "dql", getAgent("copilot")!, "v2.0.0", { project: proj });
      expect(r.ok).toBe(true);
      const file = path.join(proj, ".github", "instructions", "dql.instructions.md");
      const content = fs.readFileSync(file, "utf8");
      expect(content).toContain("Do DQL things.");
      expect(content).toContain('<!-- dql-skill {"skill":"dql","ref":"v2.0.0"');
    } finally {
      rmrf(skill);
      rmrf(proj);
    }
  });

  it("update swap never leaves stale files (target is replaced, not merged)", () => {
    const skillV1 = tmpDataDir("ditto-skill-v1-");
    const skillV2 = tmpDataDir("ditto-skill-v2-");
    const home = tmpDataDir("ditto-home-");
    try {
      fs.mkdirSync(path.join(skillV1, "examples"), { recursive: true });
      fs.writeFileSync(path.join(skillV1, "SKILL.md"), "# dql v1\n", "utf8");
      fs.writeFileSync(path.join(skillV1, "examples", "OLD.md"), "old\n", "utf8");
      fs.writeFileSync(path.join(skillV2, "SKILL.md"), "# dql v2\n", "utf8");
      // v2 dropped examples/
      const claude = getAgent("claude")!;
      installSkill(skillV1, "dql", claude, "v1", { home });
      const r = installSkill(skillV2, "dql", claude, "v2", { home, force: true });
      expect(r.ok).toBe(true);
      expect(fs.existsSync(path.join(r.target, "examples", "OLD.md"))).toBe(false); // stale file gone
      expect(fs.readFileSync(path.join(r.target, "SKILL.md"), "utf8")).toContain("v2");
    } finally {
      rmrf(skillV1);
      rmrf(skillV2);
      rmrf(home);
    }
  });

  it("--project into a nonexistent path returns ok:false with a clear detail", () => {
    const skill = tmpDataDir("ditto-skill-src-");
    try {
      fs.writeFileSync(path.join(skill, "SKILL.md"), "# dql\n", "utf8");
      const r = installSkill(skill, "dql", getAgent("claude")!, "v1", {
        project: "/nonexistent-xyz-abc",
      });
      expect(r.ok).toBe(false);
      expect(r.detail).toContain("does not exist");
    } finally {
      rmrf(skill);
    }
  });
});

describe("installSkill — remaining branches", () => {
  it("single-file agents: already-installed skips without --force", () => {
    const skill = tmpDataDir("ditto-skill-src-");
    const proj = tmpDataDir("ditto-proj-");
    try {
      fs.writeFileSync(path.join(skill, "SKILL.md"), "# dql\n", "utf8");
      const copilot = getAgent("copilot")!;
      const r1 = installSkill(skill, "dql", copilot, "v1", { project: proj });
      expect(r1.ok).toBe(true);
      const r2 = installSkill(skill, "dql", copilot, "v2", { project: proj });
      expect(r2.ok).toBe(false);
      expect(r2.detail).toContain("already installed");
      expect(r2.detail).toContain("v1");
      // with force: overwrites, marker comment advances
      const r3 = installSkill(skill, "dql", copilot, "v2", { project: proj, force: true });
      expect(r3.ok).toBe(true);
      const content = fs.readFileSync(r3.target, "utf8");
      expect(content).toContain('"ref":"v2"');
    } finally {
      rmrf(skill);
      rmrf(proj);
    }
  });

  it("single-file agents: project-missing is ok:false", () => {
    const skill = tmpDataDir("ditto-skill-src-");
    try {
      fs.writeFileSync(path.join(skill, "SKILL.md"), "# dql\n", "utf8");
      const r = installSkill(skill, "dql", getAgent("windsurf")!, "v1", {
        project: "/nonexistent-qrs",
      });
      expect(r.ok).toBe(false);
      expect(r.detail).toContain("does not exist");
    } finally {
      rmrf(skill);
    }
  });

  it("findInstalled skips unreadable dirs with a stderr warning (no crash)", () => {
    const base = tmpDataDir("ditto-base-");
    try {
      const dir = path.join(base, "dql");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "SKILL.md"), "# dql\n", "utf8");
      fs.chmodSync(base, 0o000); // nothing readable
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const found = findInstalled(base);
        expect(found).toEqual([]);
        expect(errSpy.mock.calls.flat().join(" ")).toContain("can't read");
      } finally {
        errSpy.mockRestore();
        fs.chmodSync(base, 0o755);
      }
    } finally {
      rmrf(base);
    }
  });

  it("findInstalled discovers single-file installs via their marker comment", () => {
    const base = tmpDataDir("ditto-base-");
    try {
      const file = path.join(base, "dql.instructions.md");
      fs.writeFileSync(
        file,
        '<!-- dql-skill {"skill":"dql","ref":"v3","installedAt":"2026-01-01","channel":"project"} -->\n# dql\n',
        "utf8",
      );
      const found = findInstalled(base);
      expect(found).toHaveLength(1);
      expect(found[0]!.marker?.ref).toBe("v3");
      expect(found[0]!.marker?.channel).toBe("project");
    } finally {
      rmrf(base);
    }
  });
});
