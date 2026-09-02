import { spawnSync } from "node:child_process";
import chalk from "chalk";
import type { Command } from "commander";
import { resolveDataDir } from "../../../config/paths.js";
import { daysUntilExpiry, loadIdentity } from "../../../identity/token.js";
import { detectChannel } from "../../../update/channel.js";
import { checkForUpdate, isNewer, readCachedUpdate } from "../../../update/check.js";
import { CLI_VERSION } from "../../version.js";

/** Injectable so tests don't hit the registry or spawn anything. */
export interface SystemDeps {
  checkForUpdate: typeof checkForUpdate;
  detectChannel: typeof detectChannel;
  readCachedUpdate: typeof readCachedUpdate;
  run: (cmdline: string) => number; // returns the child's exit code
  env?: NodeJS.ProcessEnv;
}

const realDeps: SystemDeps = {
  checkForUpdate,
  detectChannel,
  readCachedUpdate,
  // Runs a full command line through the shell (brew's `update && upgrade` form).
  run: (cmdline) => spawnSync(cmdline, { stdio: "inherit", shell: true }).status ?? 1,
};

export function registerSystemGroup(program: Command, deps: SystemDeps = realDeps): void {
  program
    .command("version")
    .description("Show version, install channel, token expiry, and paths")
    .option("--format <format>", "text | json")
    .action(async (opts: { format?: string }) => {
      if (opts.format !== undefined && opts.format !== "text" && opts.format !== "json") {
        console.error(chalk.red(`--format must be one of text, json — got "${opts.format}"`));
        process.exitCode = 2;
        return;
      }
      const channel = deps.detectChannel();
      // Version never hits the network — the update line comes from the cache.
      let updateLine = "unknown (never checked)";
      const cached = deps.readCachedUpdate();
      if (cached) {
        updateLine = isNewer(CLI_VERSION, cached.latest)
          ? `${cached.latest} available (current ${CLI_VERSION}) — run: ditto update`
          : `up to date (${CLI_VERSION})`;
      }

      let expiry = "unknown";
      try {
        const identity = loadIdentity(deps.env);
        const days = daysUntilExpiry(identity.expiresOn);
        expiry = identity.expiresOn
          ? days !== null && days < 0
            ? `expired ${identity.expiresOn}`
            : `${identity.expiresOn} (${days}d)`
          : "unknown";
      } catch {
        expiry = "unavailable";
      }

      const info = {
        version: CLI_VERSION,
        channel: channel.detail,
        update: updateLine,
        token_expires: expiry,
        data_dir: resolveDataDir(undefined, deps.env),
        platform: `${process.platform}/${process.arch}`,
        node: process.version,
      };
      if (opts.format === "json") {
        console.log(JSON.stringify(info, null, 2));
        return;
      }
      for (const [k, v] of Object.entries(info)) {
        console.log(`${chalk.dim(k.padEnd(14))} ${v}`);
      }
    });

  program
    .command("update")
    .description("Update the CLI to the latest version (detects npm vs Homebrew)")
    .option("--check", "check only — don't upgrade", false)
    .action(async (opts: { check: boolean }) => {
      let status: Awaited<ReturnType<SystemDeps["checkForUpdate"]>>;
      try {
        status = await deps.checkForUpdate(CLI_VERSION, { force: true });
      } catch (err) {
        console.error(chalk.red(`Update check failed: ${(err as Error).message}`));
        process.exitCode = 1;
        return;
      }
      if (!status) return;
      if (!status.updateAvailable) {
        console.log(`Already up to date (${status.current}).`);
        return;
      }
      console.log(`Update available: ${status.current} → ${status.latest}`);

      const channel = deps.detectChannel();
      if (opts.check) {
        if (channel.updateCommand)
          console.error(chalk.dim(`upgrade with: ${channel.updateCommand}`));
        else
          console.error(
            chalk.dim("upgrade manually: brew upgrade ditto  ·  npm i -g @dittolive/cli@latest"),
          );
        return;
      }
      if (!channel.updateCommand) {
        console.error(
          chalk.yellow(
            "Can't tell how this install was made. Upgrade manually:\n" +
              "  brew update && brew upgrade ditto     # Homebrew\n" +
              "  npm i -g @dittolive/cli@latest        # npm",
          ),
        );
        process.exitCode = 1;
        return;
      }
      console.error(chalk.dim(`running: ${channel.updateCommand}`));
      const code = deps.run(channel.updateCommand);
      if (code === 0) {
        console.log(chalk.green(`Updated to ${status.latest}.`));
      } else {
        console.error(
          chalk.red(
            `Upgrade command failed (exit ${code}). Try manually: ${channel.updateCommand}`,
          ),
        );
        process.exitCode = 1;
      }
    });
}
