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
  /**
   * Other names accepted by `--agent`. Matches the agent ids used by the
   * `npx skills` CLI (vercel-labs/skills) so users can reuse the name they know.
   */
  aliases: string[];
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
    aliases: ["claude-code"],
    globalDir: (home) => path.join(home, ".claude", "skills"),
    projectDir: path.join(".claude", "skills"),
    globalMarkers: [(home) => path.join(home, ".claude")],
    projectMarkers: [".claude"],
    projectFile: null,
  },
  {
    name: "opencode",
    aliases: [],
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
    aliases: [],
    globalDir: (home) => path.join(home, ".codex", "skills"),
    projectDir: path.join(".codex", "skills"),
    globalMarkers: [(home) => path.join(home, ".codex")],
    projectMarkers: [".codex"],
    projectFile: null,
  },
  {
    name: "gemini",
    aliases: ["gemini-cli"],
    globalDir: (home) => path.join(home, ".gemini", "skills"),
    projectDir: path.join(".gemini", "skills"),
    globalMarkers: [(home) => path.join(home, ".gemini")],
    projectMarkers: [".gemini"],
    projectFile: null,
  },
  {
    // Antigravity (Google): global skills live under ~/.gemini/config/skills
    // (legacy ~/.gemini/antigravity/skills is still read by the IDE — both are
    // detection markers). Project scope is the shared .agents/skills convention
    // (already covered by the opencode target, but Antigravity users get an
    // explicit target so `--agent antigravity` works and detection isn't tied
    // to another agent's config).
    name: "antigravity",
    aliases: ["antigravity-cli"],
    globalDir: (home) => path.join(home, ".gemini", "config", "skills"),
    projectDir: path.join(".agents", "skills"),
    globalMarkers: [
      (home) => path.join(home, ".gemini", "antigravity"),
      (home) => path.join(home, ".gemini", "config"),
    ],
    projectMarkers: [".agents"],
    projectFile: null,
  },
  {
    name: "cursor",
    aliases: [],
    globalDir: null, // Cursor has no global skills dir — project rules only
    projectDir: path.join(".cursor", "rules"),
    globalMarkers: [],
    projectMarkers: [".cursor"],
    projectFile: null,
  },
  {
    name: "copilot",
    aliases: ["github-copilot"],
    globalDir: null,
    // Copilot reads instruction FILES, not skill dirs — see projectFile.
    projectDir: path.join(".github", "instructions"),
    projectFile: (skill) => path.join(".github", "instructions", `${skill}.instructions.md`),
    globalMarkers: [],
    projectMarkers: [".github"],
  },
  {
    name: "windsurf",
    aliases: [],
    globalDir: null,
    // Windsurf reads rule FILES — see projectFile.
    projectDir: path.join(".windsurf", "rules"),
    projectFile: (skill) => path.join(".windsurf", "rules", `${skill}.md`),
    globalMarkers: [],
    projectMarkers: [".windsurf"],
  },
];

/** Looks up an agent by its name or one of its aliases (e.g. `claude-code` → claude). */
export function getAgent(name: string): AgentSpec | undefined {
  return AGENTS.find((a) => a.name === name || a.aliases.includes(name));
}

/**
 * Turns a user's `--agent` list into canonical agent names: aliases map to the
 * agent's name and duplicates are dropped. Unknown names pass through unchanged
 * so the caller can report them.
 */
export function resolveAgentNames(names: string[]): string[] {
  return [...new Set(names.map((n) => getAgent(n)?.name ?? n))];
}

/** "claude (claude-code), opencode, …" for help text and error details. */
export function describeAgents(): string {
  return AGENTS.map((a) =>
    a.aliases.length ? `${a.name} (${a.aliases.join(", ")})` : a.name,
  ).join(", ");
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

/**
 * Whether this agent gets one flattened file per skill (copilot/windsurf in a
 * project). Links to other skills' files can't resolve there, so companion
 * skills are not installed for these agents.
 */
export function isSingleFile(agent: AgentSpec, opts: { project?: string }): boolean {
  return Boolean(opts.project && agent.projectFile);
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
