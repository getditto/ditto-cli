import { execFileSync } from "node:child_process";
import fs from "node:fs";

/**
 * Install-channel detection: how was this CLI installed?
 *  - Homebrew: the running binary resolves under `$(brew --prefix)/Cellar`
 *  - npm global: under `npm prefix -g` (global node_modules)
 *  - unknown: print manual instructions
 */

export type InstallChannel = "homebrew" | "npm" | "unknown";

export interface ChannelInfo {
  channel: InstallChannel;
  /** The command the user should run to update. */
  updateCommand: string | null;
  /** Human description for `ditto version`. */
  detail: string;
}

export function detectChannel(
  opts: { argv1?: string; execPath?: string; brewPrefix?: string; npmPrefix?: string } = {},
): ChannelInfo {
  const argv1 = opts.argv1 ?? process.argv[1] ?? "";
  const execPath = opts.execPath ?? process.execPath;

  // Resolve symlinks — npm/brew both link into their real homes.
  let resolved = argv1;
  try {
    resolved = fs.realpathSync(argv1);
  } catch {
    resolved = argv1;
  }

  const brewPrefix = opts.brewPrefix ?? readCmdPrefix("brew", "--prefix");
  if (
    brewPrefix &&
    (resolved.startsWith(`${brewPrefix}/Cellar/`) || resolved.startsWith(`${brewPrefix}/Caskroom/`))
  ) {
    return {
      channel: "homebrew",
      updateCommand: "brew update && brew upgrade ditto",
      detail: `homebrew (${brewPrefix})`,
    };
  }

  const npmPrefix = opts.npmPrefix ?? readCmdPrefix("npm", "prefix", "-g");
  const npmRoots = [
    npmPrefix && `${npmPrefix}/lib/node_modules`,
    npmPrefix && `${npmPrefix}/node_modules`,
  ].filter(Boolean) as string[];
  if (
    npmRoots.some((r) => resolved.startsWith(r)) ||
    // only the *global* layout counts — npx caches (_npx/<hash>/node_modules)
    // and project-local devDeps must not be claimed as "npm global"
    resolved.includes("/lib/node_modules/@dittolive/cli")
  ) {
    return {
      channel: "npm",
      updateCommand: "npm i -g @dittolive/cli@latest",
      detail: "npm global",
    };
  }

  // Dev checkout (running from a repo) — never suggest an update path.
  if (resolved.includes("/dql-cli/") || resolved.endsWith(".ts")) {
    return { channel: "unknown", updateCommand: null, detail: "dev checkout" };
  }
  return { channel: "unknown", updateCommand: null, detail: `unknown (${resolved || execPath})` };
}

/** Read `brew --prefix` / `npm prefix -g` — undefined when the tool is absent. */
function readCmdPrefix(cmd: string, ...args: string[]): string | undefined {
  try {
    return (
      execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() ||
      undefined
    );
  } catch {
    return undefined;
  }
}
