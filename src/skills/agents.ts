import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Agent registry — where each AI agent looks for skills, global vs project.
 * Mirrors the android-cli `skills add` behavior; paths follow each agent's
 * conventions (see the agent-skills repo README "Installation by tool").
 */
export interface AgentSpec {
  name: string;
  /** Global (user-level) install dir, or null if the agent is project-only. */
  globalDir: ((home: string) => string) | null;
  /** Project-local install dir (skill root = <project>/<projectDir>/<skill>), relative to the project root. */
  projectDir: string | null;
  /** Single-file install target for instruction-file agents (copilot/windsurf). Overrides projectDir when set. */
  projectFile: ((skillName: string) => string) | null;
  /** Detection markers: any existing global dir or project file/dir. */
  globalMarkers: ((home: string) => string)[];
  projectMarkers: string[];
}

export const AGENTS: AgentSpec[] = [
  {
    name: "claude",
    globalDir: (home) => path.join(home, ".claude", "skills"),
    projectDir: path.join(".claude", "skills"),
    globalMarkers: [(home) => path.join(home, ".claude")],
    projectMarkers: [".claude"],
    projectFile: null,
  },
  {
    name: "opencode",
    globalDir: (home) => path.join(home, ".agents", "skills"),
    projectDir: path.join(".agents", "skills"),
    globalMarkers: [
      (home) => path.join(home, ".agents"),
      (home) => path.join(home, ".config", "opencode"),
    ],
    projectMarkers: [".agents", ".opencode"],
    projectFile: null,
  },
  {
    name: "codex",
    globalDir: (home) => path.join(home, ".codex", "skills"),
    projectDir: path.join(".codex", "skills"),
    globalMarkers: [(home) => path.join(home, ".codex")],
    projectMarkers: [".codex"],
    projectFile: null,
  },
  {
    name: "gemini",
    globalDir: (home) => path.join(home, ".gemini", "skills"),
    projectDir: path.join(".gemini", "skills"),
    globalMarkers: [(home) => path.join(home, ".gemini")],
    projectMarkers: [".gemini"],
    projectFile: null,
  },
  {
    name: "cursor",
    globalDir: null, // Cursor has no global skills dir — project rules only
    projectDir: path.join(".cursor", "rules"),
    globalMarkers: [],
    projectMarkers: [".cursor"],
    projectFile: null,
  },
  {
    name: "copilot",
    globalDir: null,
    // Copilot reads instruction FILES, not skill dirs — see projectFile.
    projectDir: path.join(".github", "instructions"),
    projectFile: (skill) => path.join(".github", "instructions", `${skill}.instructions.md`),
    globalMarkers: [],
    projectMarkers: [".github"],
  },
  {
    name: "windsurf",
    globalDir: null,
    // Windsurf reads rule FILES — see projectFile.
    projectDir: path.join(".windsurf", "rules"),
    projectFile: (skill) => path.join(".windsurf", "rules", `${skill}.md`),
    globalMarkers: [],
    projectMarkers: [".windsurf"],
  },
];

export function getAgent(name: string): AgentSpec | undefined {
  return AGENTS.find((a) => a.name === name);
}

/**
 * Detect agents present on this machine (global scope) or in a project.
 * `home`/`project` are injectable for tests.
 */
export function detectAgents(opts: { home?: string; project?: string } = {}): AgentSpec[] {
  const home = opts.home ?? os.homedir();
  const root = opts.project ?? process.cwd();
  return AGENTS.filter((a) => {
    const globalHit = a.globalMarkers.some((m) => fs.existsSync(m(home)));
    const projectHit = a.projectMarkers.some((m) => fs.existsSync(path.join(root, m)));
    return globalHit || projectHit;
  });
}

/** Where a skill installs for an agent: global home dir or project dir. */
export function targetDir(
  agent: AgentSpec,
  skillName: string,
  opts: { home?: string; project?: string },
): string | null {
  if (opts.project) {
    if (agent.projectFile) return null; // single-file agents use targetFile
    if (!agent.projectDir) return null;
    return path.join(opts.project, agent.projectDir, skillName);
  }
  if (!agent.globalDir) return null;
  const home = opts.home ?? os.homedir();
  return path.join(agent.globalDir(home), skillName);
}

/** Single-file install target for instruction-file agents (copilot/windsurf), project scope only. */
export function targetFile(
  agent: AgentSpec,
  skillName: string,
  opts: { project?: string },
): string | null {
  if (!opts.project || !agent.projectFile) return null;
  return path.join(opts.project, agent.projectFile(skillName));
}
