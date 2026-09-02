import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import chalk from "chalk";
import type { Command } from "commander";
import { FormatError, renderRows, resolveFormat } from "../../../render/output.js";
import { AGENTS, type AgentSpec, detectAgents, getAgent } from "../../../skills/agents.js";
import { cleanupStaging, extractSkill } from "../../../skills/fetch.js";
import { fetchTarball, resolveRef, SkillsFetchError } from "../../../skills/github.js";
import { findInstalled, installSkill } from "../../../skills/install.js";
import { note } from "../dql/run.js";

/** Injectable so tests never hit the network. */
export interface SkillsDeps {
  resolveRef: typeof resolveRef;
  fetchTarball: typeof fetchTarball;
  home?: string;
}

const realDeps: SkillsDeps = { resolveRef, fetchTarball };

const DEFAULT_SKILL = "dql";

/** Which skills to install: explicit --skill, --all (everything in the tarball), or the default. */
function selectedSkills(opts: { skill: string; all: boolean }): string[] {
  void opts; // --all is currently a single-skill repo; when upstream ships more, list them from the tarball
  return [opts.skill];
}

function mapFormatError(err: unknown): boolean {
  if (err instanceof FormatError) {
    console.error(chalk.red(err.message));
    process.exitCode = err.exitCode;
    return true;
  }
  return false;
}

/** Fetch + extract once; shared by add/update. Returns null on a handled failure. */
async function fetchSkill(
  deps: SkillsDeps,
  skill: string,
): Promise<{ ref: string; skillDir: string } | null> {
  let ref: string;
  let tarball: Buffer;
  try {
    note("Resolving getditto/agent-skills…");
    ref = await deps.resolveRef();
    note(`Fetching ${ref}…`);
    tarball = await deps.fetchTarball(ref);
  } catch (err) {
    if (err instanceof SkillsFetchError) {
      console.error(chalk.red(err.message));
      process.exitCode = err.exitCode;
      return null;
    }
    throw err;
  }
  try {
    return { ref, skillDir: await extractSkill(tarball, skill) };
  } catch (err) {
    if (err instanceof SkillsFetchError) {
      console.error(chalk.red(err.message));
      process.exitCode = err.exitCode;
      return null;
    }
    throw err;
  }
}

export function registerSkillsGroup(
  skills: ReturnType<Command["command"]>,
  deps: SkillsDeps = realDeps,
): void {
  skills.description("Install Ditto's DQL skill into AI coding agents");

  skills
    .command("add")
    .description("Install the DQL skill into AI agents (global by default)")
    .option("--skill <name>", "skill to install", DEFAULT_SKILL)
    .option("--all", "install all skills from the repo", false)
    .option("--agent <list>", "comma-separated agents (default: all detected)")
    .option("--project <path>", "install into a project instead of globally")
    .option("--force", "overwrite an existing install", false)
    .option("--format <format>", "table | json | csv")
    .action(
      async (opts: {
        skill: string;
        all: boolean;
        agent?: string;
        project?: string;
        force: boolean;
        format?: string;
      }) => {
        // Usage validation first.
        let format: ReturnType<typeof resolveFormat>;
        try {
          format = resolveFormat(opts.format);
        } catch (err) {
          if (mapFormatError(err)) return;
          throw err;
        }
        if (opts.project && !fs.existsSync(path.resolve(opts.project))) {
          console.error(chalk.red(`--project path does not exist: ${opts.project}`));
          process.exitCode = 2;
          return;
        }

        // Agent selection: explicit list wins; otherwise all detected.
        const scope = { home: deps.home, project: opts.project };
        const selected = opts.agent
          ? opts.agent
              .split(",")
              .map((n) => n.trim())
              .filter(Boolean)
          : detectAgents(scope).map((a) => a.name);
        if (selected.length === 0) {
          console.error(
            chalk.yellow(
              "No agents detected — pass --agent explicitly (e.g. --agent claude,opencode).",
            ),
          );
          process.exitCode = 2;
          return;
        }

        for (const skillName of selectedSkills(opts)) {
          const fetched = await fetchSkill(deps, skillName);
          if (!fetched) return;
          try {
            const results = selected.map((name) => {
              const agent = getAgent(name);
              if (!agent) {
                return {
                  agent: name,
                  target: "",
                  ok: false,
                  detail: `unknown agent (known: ${AGENTS.map((a) => a.name).join(", ")})`,
                };
              }
              return installSkill(fetched.skillDir, skillName, agent, fetched.ref, {
                ...scope,
                force: opts.force,
              });
            });

            const rows = results.map((r) => ({
              skill: skillName,
              agent: r.agent,
              status: r.ok ? "installed" : "skipped",
              ref: fetched.ref,
              where: r.target || "—",
              detail: r.detail ?? "",
            }));
            console.log(renderRows(rows, format));
            const failures = results.filter((r) => !r.ok).length;
            if (failures > 0) {
              console.error(
                chalk.yellow(
                  `${failures} agent${failures === 1 ? "" : "s"} skipped — see detail column`,
                ),
              );
            }
            if (results.every((r) => !r.ok)) process.exitCode = 2;
          } finally {
            cleanupStaging(fetched.skillDir);
          }
        }
      },
    );

  skills
    .command("list")
    .description("List installed skills per agent (global; pass --project for project-local)")
    .option("--project <path>", "scan a project instead of global agent dirs")
    .option("--format <format>", "table | json | csv")
    .action((opts: { project?: string; format?: string }) => {
      let format: ReturnType<typeof resolveFormat>;
      try {
        format = resolveFormat(opts.format);
      } catch (err) {
        if (mapFormatError(err)) return;
        throw err;
      }
      const rows: Record<string, unknown>[] = [];
      for (const agent of AGENTS) {
        const dirs = opts.project
          ? agent.projectDir
            ? [path.join(opts.project, agent.projectDir)]
            : []
          : agent.globalDir
            ? [agent.globalDir(deps.home ?? os.homedir())]
            : [];
        for (const dir of dirs) {
          for (const found of findInstalled(dir)) {
            rows.push({
              agent: agent.name,
              skill: found.skill,
              ref: found.marker?.ref ?? "unknown",
              installed: found.marker?.installedAt ?? "—",
              channel: opts.project ? "project" : "global",
              path: found.path,
            });
          }
        }
      }
      // stdout purity: an empty result is `[]` in JSON mode; the human message goes to stderr.
      if (rows.length === 0) {
        if (format === "json") console.log("[]");
        else console.log("(no skills installed)");
        note("no skills installed — install with `ditto skills add`");
        return;
      }
      console.log(renderRows(rows, format));
    });

  skills
    .command("update")
    .description("Refresh installed skills from the latest upstream release")
    .option("--skill <name>", "skill to update", DEFAULT_SKILL)
    .option("--project <path>", "update project-local installs instead of global")
    .option("--format <format>", "table | json | csv")
    .action(async (opts: { skill: string; project?: string; format?: string }) => {
      let format: ReturnType<typeof resolveFormat>;
      try {
        format = resolveFormat(opts.format);
      } catch (err) {
        if (mapFormatError(err)) return;
        throw err;
      }

      // Find installed copies (global or project).
      const found: { agent: AgentSpec; target: string; ref?: string }[] = [];
      for (const agent of AGENTS) {
        const dir = opts.project
          ? agent.projectDir
            ? path.join(opts.project, agent.projectDir)
            : null
          : agent.globalDir
            ? agent.globalDir(deps.home ?? os.homedir())
            : null;
        if (!dir) continue;
        for (const f of findInstalled(dir)) {
          if (f.skill === opts.skill) {
            found.push({ agent, target: f.path, ref: f.marker?.ref });
          }
        }
      }
      if (found.length === 0) {
        if (format === "json") console.log("[]");
        else console.log(`(no ${opts.skill} skill installed — use \`ditto skills add\`)`);
        note(`no ${opts.skill} skill installed — nothing to update`);
        return;
      }

      // Resolve the upstream ref BEFORE fetching — if everything is current, skip the download.
      let ref: string;
      try {
        note("Resolving getditto/agent-skills…");
        ref = await deps.resolveRef();
      } catch (err) {
        if (err instanceof SkillsFetchError) {
          console.error(chalk.red(err.message));
          process.exitCode = err.exitCode;
          return;
        }
        throw err;
      }
      const stale = found.filter((f) => f.ref !== ref);
      if (stale.length === 0) {
        console.log(`all ${opts.skill} installs already on ${ref}`);
        return;
      }

      let tarball: Buffer;
      try {
        note(`Fetching ${ref}…`);
        tarball = await deps.fetchTarball(ref);
      } catch (err) {
        if (err instanceof SkillsFetchError) {
          console.error(chalk.red(err.message));
          process.exitCode = err.exitCode;
          return;
        }
        throw err;
      }

      const fetched = await (async () => {
        try {
          return await extractSkill(tarball, opts.skill);
        } catch (err) {
          if (err instanceof SkillsFetchError) {
            console.error(chalk.red(err.message));
            process.exitCode = err.exitCode;
            return null;
          }
          throw err;
        }
      })();
      if (!fetched) return;
      try {
        const rows = stale.map(({ agent, target, ref: current }) => {
          const r = installSkill(fetched, opts.skill, agent, ref, {
            home: deps.home,
            project: opts.project,
            force: true,
          });
          return {
            agent: agent.name,
            status: r.ok ? "updated" : "skipped",
            where: target,
            detail: r.ok ? `${current ?? "unknown"} → ${ref}` : (r.detail ?? ""),
          };
        });
        console.log(renderRows(rows, format));
        const failures = rows.filter((r) => r.status !== "updated").length;
        if (failures === rows.length) process.exitCode = 2;
      } finally {
        cleanupStaging(fetched);
      }
    });
}
