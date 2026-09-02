import fs from "node:fs";
import path from "node:path";
import type { AgentSpec } from "./agents.js";
import { targetDir, targetFile } from "./agents.js";

export interface InstallResult {
  agent: string;
  target: string;
  ok: boolean;
  detail?: string;
}

/** The marker file recording provenance for `skills update`/`list`. */
export const MARKER = ".dql-skill.json";

export interface Marker {
  skill: string;
  ref: string;
  installedAt: string;
  channel: "global" | "project";
}

/**
 * Install a skill for an agent — directory copy for skill-dir agents
 * (claude/opencode/codex/gemini/cursor), single instruction-file emit for
 * copilot/windsurf. Per-agent failures are captured (never thrown) so one bad
 * target can't crash the batch. Updates are atomic: content is staged in a
 * temp sibling and swapped in, so a stale file never survives an update.
 */
export function installSkill(
  skillDir: string,
  skillName: string,
  agent: AgentSpec,
  ref: string,
  opts: { home?: string; project?: string; force?: boolean },
): InstallResult {
  try {
    // Single-file agents (copilot/windsurf): emit one flattened markdown file.
    const file = targetFile(agent, skillName, opts);
    if (file !== null) {
      return installToFile(skillDir, skillName, agent, ref, file, opts);
    }

    const target = targetDir(agent, skillName, opts);
    if (!target) {
      return {
        agent: agent.name,
        target: "",
        ok: false,
        detail: `${agent.name} has no ${opts.project ? "project" : "global"} skills directory`,
      };
    }
    if (opts.project && !fs.existsSync(path.resolve(opts.project))) {
      return {
        agent: agent.name,
        target,
        ok: false,
        detail: `project path does not exist: ${opts.project}`,
      };
    }
    if (fs.existsSync(target) && !opts.force) {
      const existing = readMarker(target);
      return {
        agent: agent.name,
        target,
        ok: false,
        detail: `already installed${existing ? ` (${existing.ref})` : ""} — pass --force to overwrite`,
      };
    }

    // Atomic swap: stage into a temp sibling, then replace the target.
    const parent = path.dirname(target);
    fs.mkdirSync(parent, { recursive: true });
    const staged = fs.mkdtempSync(path.join(parent, `.dql-staging-`));
    try {
      fs.cpSync(skillDir, staged, { recursive: true, verbatimSymlinks: false });
      const marker: Marker = {
        skill: skillName,
        ref,
        installedAt: new Date().toISOString(),
        channel: opts.project ? "project" : "global",
      };
      fs.writeFileSync(path.join(staged, MARKER), `${JSON.stringify(marker, null, 2)}\n`, "utf8");
      fs.rmSync(target, { recursive: true, force: true });
      fs.renameSync(staged, target);
    } finally {
      fs.rmSync(staged, { recursive: true, force: true });
    }
    return { agent: agent.name, target, ok: true };
  } catch (err) {
    return {
      agent: agent.name,
      target: "",
      ok: false,
      detail: (err as NodeJS.ErrnoException).message,
    };
  }
}

/** Single-file install for instruction-file agents (copilot/windsurf). */
function installToFile(
  skillDir: string,
  skillName: string,
  agent: AgentSpec,
  ref: string,
  file: string,
  opts: { project?: string; force?: boolean },
): InstallResult {
  try {
    if (fs.existsSync(file) && !opts.force) {
      const existing = readFileMarker(file);
      return {
        agent: agent.name,
        target: file,
        ok: false,
        detail: `already installed${existing ? ` (${existing.ref})` : ""} — pass --force to overwrite`,
      };
    }
    if (opts.project && !fs.existsSync(path.resolve(opts.project))) {
      return {
        agent: agent.name,
        target: file,
        ok: false,
        detail: `project path does not exist: ${opts.project}`,
      };
    }
    const skillMd = fs.readFileSync(path.join(skillDir, "SKILL.md"), "utf8");
    const marker = `<!-- dql-skill {"skill":"${skillName}","ref":"${ref}","installedAt":"${new Date().toISOString()}","channel":"${opts.project ? "project" : "global"}"} -->\n`;
    const body = `${marker}${skillMd}\n\n> Full skill resources (references/, examples/) are available in the agent-skills repo (skills/${skillName}/).\n`;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const staged = `${file}.dql-tmp`;
    try {
      fs.writeFileSync(staged, body, "utf8");
      fs.renameSync(staged, file);
    } finally {
      fs.rmSync(staged, { force: true });
    }
    return { agent: agent.name, target: file, ok: true };
  } catch (err) {
    return {
      agent: agent.name,
      target: file,
      ok: false,
      detail: (err as NodeJS.ErrnoException).message,
    };
  }
}

export function readMarker(target: string): Marker | undefined {
  try {
    return JSON.parse(fs.readFileSync(path.join(target, MARKER), "utf8")) as Marker;
  } catch {
    return undefined;
  }
}

/** Marker for single-file installs: an HTML comment on line 1. */
function readFileMarker(file: string): Marker | undefined {
  try {
    const head = fs.readFileSync(file, "utf8").slice(0, 400);
    const m = head.match(/<!-- dql-skill (\{.*?\}) -->/);
    if (!m) return undefined;
    return JSON.parse(m[1]!) as Marker;
  } catch {
    return undefined;
  }
}

/** Find installed skills under a base dir (global or project scan). Unreadable dirs are skipped with a note. */
export function findInstalled(baseDir: string): { skill: string; path: string; marker?: Marker }[] {
  if (!fs.existsSync(baseDir)) return [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(baseDir, { withFileTypes: true });
  } catch (err) {
    console.error(`warning: can't read ${baseDir}: ${(err as NodeJS.ErrnoException).message}`);
    return [];
  }
  const out: { skill: string; path: string; marker?: Marker }[] = [];
  for (const entry of entries) {
    const full = path.join(baseDir, entry.name);
    if (entry.isDirectory()) {
      if (fs.existsSync(path.join(full, "SKILL.md"))) {
        out.push({ skill: entry.name, path: full, marker: readMarker(full) });
      }
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      const marker = readFileMarker(full);
      if (marker) out.push({ skill: marker.skill, path: full, marker });
    }
  }
  return out;
}
