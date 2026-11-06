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
  /** Human description for `dittosh version`. */
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

  resolved = comparablePath(resolved);
  const brewPrefix = opts.brewPrefix ?? readCmdPrefix("brew", "--prefix");
  const brewRoot = brewPrefix && comparablePath(brewPrefix);
  if (
    brewRoot &&
    (resolved.startsWith(`${brewRoot}/Cellar/`) || resolved.startsWith(`${brewRoot}/Caskroom/`))
  ) {
    return {
      channel: "homebrew",
      updateCommand: "brew update && brew upgrade dittosh",
      detail: `homebrew (${brewPrefix})`,
    };
  }

  const npmPrefix = opts.npmPrefix ?? readCmdPrefix("npm", "prefix", "-g");
  const npmRoot = npmPrefix && comparablePath(npmPrefix);
  const npmRoots = [
    npmRoot && `${npmRoot}/lib/node_modules/`,
    npmRoot && `${npmRoot}/node_modules/`,
  ].filter(Boolean) as string[];
  if (
    npmRoots.some((r) => resolved.startsWith(r)) ||
    // only the *global* layout counts — npx caches (_npx/<hash>/node_modules)
    // and project-local devDeps must not be claimed as "npm global"
    resolved.includes("/lib/node_modules/@dittolive/cli/")
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

/** Compare Windows separators/case and resolved prefix paths consistently. */
function comparablePath(value: string): string {
  let canonical = value;
  try {
    canonical = fs.realpathSync(value);
  } catch {
    // A missing path can still be classified (including injected test prefixes).
  }
  canonical = canonical.replaceAll("\\", "/").replace(/\/+$/, "");
  return /^[a-z]:\//i.test(canonical) ? canonical.toLowerCase() : canonical;
}

/** Read `brew --prefix` / `npm prefix -g` — undefined when the tool is absent. */
function readCmdPrefix(cmd: string, ...args: string[]): string | undefined {
  try {
    // npm is an npm.cmd shim on Windows; execFile cannot launch it directly.
    // The command string is fixed and contains no user-provided arguments.
    if (process.platform === "win32" && cmd === "npm") {
      return (
        execFileSync("cmd.exe", ["/d", "/c", "npm prefix -g"], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        }).trim() || undefined
      );
    }
    return (
      execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() ||
      undefined
    );
  } catch {
    return undefined;
  }
}
