import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import chalk from "chalk";
import { type Command, Option } from "commander";
import { FormatError, renderRows, resolveFormat } from "../../../render/output.js";
import { AGENTS, type AgentSpec, detectAgents, getAgent } from "../../../skills/agents.js";
import { cleanupStaging, extractSkills, listSkills } from "../../../skills/fetch.js";
import {
  fetchTarball,
  listReleases,
  resolveRef,
  SkillsFetchError,
} from "../../../skills/github.js";
import { findInstalled, installSkill } from "../../../skills/install.js";
import { note } from "../dql/run.js";

/** Injectable so tests never hit the network. */
export interface SkillsDeps {
  resolveRef: typeof resolveRef;
  fetchTarball: typeof fetchTarball;
  listReleases: typeof listReleases;
  home?: string;
}

const realDeps: SkillsDeps = { resolveRef, fetchTarball, listReleases };

const DEFAULT_SKILL = "write-dql";

/**
 * Upstream renames we paper over so existing installs and scripts keep working.
 * `dql` predates the per-SDK repo layout; the DQL skill now ships as `write-dql`.
 */
const ALIASES: Record<string, string> = { dql: "write-dql" };

function canonical(name: string): string {
  const to = ALIASES[name];
  if (to) note(`skill '${name}' is now '${to}' upstream — using ${to}`);
  return to ?? name;
}

/** Resolve the requested skill name: positional beats --skill; default write-dql. */
function resolveName(positional: string | undefined, flag: string | undefined): string | null {
  if (positional && flag && canonical(positional) !== canonical(flag)) {
    console.error(chalk.red(`conflicting skill names: '${positional}' vs --skill '${flag}'`));
    process.exitCode = 2;
    return null;
  }
  return canonical(positional ?? flag ?? DEFAULT_SKILL);
}

function mapFormatError(err: unknown): boolean {
  if (err instanceof FormatError) {
    console.error(chalk.red(err.message));
    process.exitCode = err.exitCode;
    return true;
  }
  return false;
}

function mapFetchError(err: unknown): boolean {
  if (err instanceof SkillsFetchError) {
    console.error(chalk.red(err.message));
    process.exitCode = err.exitCode;
    return true;
  }
  return false;
}

/** A fetched archive: its ref, bytes, and the skills it ships. */
interface Bundle {
  ref: string;
  tarball: Buffer;
  available: string[];
}

/** Resolve the target ref (latest release, or the --ref pin). Null on a handled failure. */
async function resolveTargetRef(deps: SkillsDeps, pinnedRef?: string): Promise<string | null> {
  if (pinnedRef) {
    note(`Using pinned ref ${pinnedRef}`);
    return pinnedRef;
  }
  try {
    note("Resolving getditto/agent-skills…");
    return await deps.resolveRef();
  } catch (err) {
    if (mapFetchError(err)) return null;
    throw err;
  }
}

/** Download + enumerate the archive for a ref. Null on a handled failure. */
async function downloadBundle(deps: SkillsDeps, ref: string): Promise<Bundle | null> {
  try {
    note(`Fetching ${ref}…`);
    const tarball = await deps.fetchTarball(ref);
    return { ref, tarball, available: await listSkills(tarball) };
  } catch (err) {
    if (mapFetchError(err)) return null;
    throw err;
  }
}

interface NameOpts {
  skill?: string;
  all: boolean;
  ref?: string;
}

export function registerSkillsGroup(
  skills: ReturnType<Command["command"]>,
  deps: SkillsDeps = realDeps,
): void {
  skills.description("Install Ditto agent skills (Swift, Kotlin, DQL, …) into AI coding agents");

  skills
    .command("add [name]")
    .description(`Install a skill into AI agents, globally by default (default: ${DEFAULT_SKILL})`)
    .addOption(new Option("--skill <name>", "deprecated — use the [name] argument").hideHelp())
    .option("--all", "install every skill the upstream repo ships", false)
    .option("--agent <list>", "comma-separated agents (default: all detected)")
    .option("--project <path>", "install into a project instead of globally")
    .option("--ref <tag>", "install a specific release instead of the latest")
    .option("--force", "overwrite an existing install", false)
    .option("--format <format>", "table | json | csv")
    .action(
      async (
        name: string | undefined,
        opts: NameOpts & { agent?: string; project?: string; force: boolean; format?: string },
      ) => {
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
        const skillName = opts.all ? null : resolveName(name, opts.skill);
        if (!opts.all && !skillName) return;

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

        const bundleRef = await resolveTargetRef(deps, opts.ref);
        if (!bundleRef) return;
        const bundle = await downloadBundle(deps, bundleRef);
        if (!bundle) return;

        let names: string[];
        if (opts.all) {
          names = bundle.available;
          note(`Installing all ${names.length} skills: ${names.join(", ")}`);
        } else {
          if (!bundle.available.includes(skillName!)) {
            console.error(
              chalk.red(
                `unknown skill '${skillName}' — available: ${bundle.available.join(", ") || "(none)"}`,
              ),
            );
            process.exitCode = 2;
            return;
          }
          names = [skillName!];
        }

        let dirs: Map<string, string>;
        try {
          dirs = await extractSkills(bundle.tarball, names);
        } catch (err) {
          if (mapFetchError(err)) return;
          throw err;
        }
        const firstDir = dirs.values().next().value;
        try {
          const rows: Record<string, unknown>[] = [];
          let failures = 0;
          for (const n of names) {
            const results = selected.map((agentName) => {
              const agent = getAgent(agentName);
              if (!agent) {
                return {
                  agent: agentName,
                  target: "",
                  ok: false,
                  detail: `unknown agent (known: ${AGENTS.map((a) => a.name).join(", ")})`,
                };
              }
              return installSkill(dirs.get(n)!, n, agent, bundle.ref, {
                ...scope,
                force: opts.force,
              });
            });
            for (const r of results) {
              rows.push({
                skill: n,
                agent: r.agent,
                status: r.ok ? "installed" : "skipped",
                ref: bundle.ref,
                where: r.target || "—",
                detail: r.detail ?? "",
              });
              if (!r.ok) failures++;
            }
          }
          console.log(renderRows(rows, format));
          if (failures > 0) {
            console.error(
              chalk.yellow(
                `${failures} install${failures === 1 ? "" : "s"} skipped — see detail column`,
              ),
            );
          }
          if (failures === rows.length) process.exitCode = 2;
        } finally {
          if (firstDir) cleanupStaging(firstDir);
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
        note("no skills installed — install with `dittosh skills add`");
        return;
      }
      console.log(renderRows(rows, format));
    });

  skills
    .command("update [name]")
    .description(
      `Refresh installed skills from upstream (default: ${DEFAULT_SKILL}; --all for everything)`,
    )
    .addOption(new Option("--skill <name>", "deprecated — use the [name] argument").hideHelp())
    .option("--all", "update every installed skill", false)
    .option("--ref <tag>", "move installs to a specific release (upgrade or downgrade)")
    .option("--project <path>", "update project-local installs instead of global")
    .option("--format <format>", "table | json | csv")
    .action(
      async (name: string | undefined, opts: NameOpts & { project?: string; format?: string }) => {
        let format: ReturnType<typeof resolveFormat>;
        try {
          format = resolveFormat(opts.format);
        } catch (err) {
          if (mapFormatError(err)) return;
          throw err;
        }
        const skillName = opts.all ? null : resolveName(name, opts.skill);
        if (!opts.all && !skillName) return;

        // Find installed copies (global or project).
        const found: { agent: AgentSpec; skill: string; target: string; ref?: string }[] = [];
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
            if (opts.all || canonicalQuiet(f.skill) === skillName) {
              found.push({ agent, skill: f.skill, target: f.path, ref: f.marker?.ref });
            }
          }
        }
        const what = opts.all ? "any skill" : skillName;
        if (found.length === 0) {
          if (format === "json") console.log("[]");
          else console.log(`(no ${what} installed — use \`dittosh skills add\`)`);
          note(`no ${what} installed — nothing to update`);
          return;
        }

        // Resolve the target ref BEFORE downloading — current installs skip the fetch.
        const targetRef = await resolveTargetRef(deps, opts.ref);
        if (!targetRef) return;

        const stale = found.filter((f) => f.ref !== targetRef);
        if (stale.length === 0) {
          console.log(`all ${what} installs already on ${targetRef}`);
          return;
        }
        note(
          `${stale.length} of ${found.length} install${found.length === 1 ? "" : "s"} out of date → ${targetRef}`,
        );

        const bundle = await downloadBundle(deps, targetRef);
        if (!bundle) return;

        // Extract each stale skill once (canonical names — aliases map upstream).
        const staleNames = [...new Set(stale.map((f) => canonicalQuiet(f.skill)))];
        let dirs: Map<string, string>;
        try {
          dirs = await extractSkills(bundle.tarball, staleNames);
        } catch (err) {
          if (mapFetchError(err)) return;
          throw err;
        }
        const firstDir = dirs.values().next().value;
        try {
          const rows = stale.map(({ agent, skill, target, ref: current }) => {
            const upstream = canonicalQuiet(skill);
            const r = installSkill(dirs.get(upstream)!, upstream, agent, bundle.ref, {
              home: deps.home,
              project: opts.project,
              force: true,
            });
            // Alias migration: remove the old-name install after a successful swap.
            if (r.ok && upstream !== skill) {
              fs.rmSync(target, { recursive: true, force: true });
            }
            return {
              skill: upstream,
              agent: agent.name,
              status: r.ok ? "updated" : "skipped",
              where: r.ok ? r.target : target,
              detail: r.ok ? `${current ?? "unknown"} → ${bundle.ref}` : (r.detail ?? ""),
            };
          });
          console.log(renderRows(rows, format));
          const failures = rows.filter((r) => r.status !== "updated").length;
          if (failures === rows.length) process.exitCode = 2;
        } finally {
          if (firstDir) cleanupStaging(firstDir);
        }
      },
    );

  skills
    .command("versions")
    .description("List published skill bundle releases (newest first)")
    .option("--format <format>", "table | json | csv")
    .action(async (opts: { format?: string }) => {
      let format: ReturnType<typeof resolveFormat>;
      try {
        format = resolveFormat(opts.format);
      } catch (err) {
        if (mapFormatError(err)) return;
        throw err;
      }
      let releases: Awaited<ReturnType<typeof deps.listReleases>>;
      try {
        note("Resolving getditto/agent-skills…");
        releases = await deps.listReleases();
      } catch (err) {
        if (mapFetchError(err)) return;
        throw err;
      }
      if (releases.length === 0) {
        if (format === "json") console.log("[]");
        else console.log("(no releases yet — installs track the main branch)");
        note("no releases yet — `skills add|update` fetch the main branch snapshot");
        return;
      }
      const rows = releases.map((r, i) => ({
        version: r.tag,
        channel: i === 0 ? "latest" : "",
        published: r.publishedAt ? r.publishedAt.slice(0, 10) : "—",
        slim_asset: r.hasAsset ? "yes" : "no (full repo)",
      }));
      console.log(renderRows(rows, format));
      note("pin one with `dittosh skills add <name> --ref <version>`");
    });
}

/** Alias resolution without the rename note (scan/update internals). */
function canonicalQuiet(name: string): string {
  return ALIASES[name] ?? name;
}
