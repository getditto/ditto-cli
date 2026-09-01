import chalk from "chalk";
import { Command, CommanderError } from "commander";
import { rewriteDefaultSubcommand } from "./default-command.js";
import { registerDqlGroup } from "./groups/dql/index.js";
import { installStdoutGuard } from "./streams.js";
import { CLI_VERSION } from "./version.js";

installStdoutGuard(); // quiet exit(0) on EPIPE — `| head` is a first-class flow

const program = new Command();

// Commander's own usage errors (unknown option, missing argument, …) are
// usage errors: exit 2, not commander's default 1. Help/version exit 0.
// NOTE: must be installed BEFORE registering subcommands — commander only
// honors the override for groups registered after it (verified empirically).
program.exitOverride();

program
  .name("ditto")
  .description("The Ditto CLI — run DQL, load sample datasets, install AI agent skills")
  .version(CLI_VERSION)
  .option("--no-color", "disable colored output (also: NO_COLOR, CI, non-TTY)")
  .option("--quiet", "suppress informational notes on stderr");

const dql = program.command("dql");
registerDqlGroup(dql);

// Global flags take effect before any subcommand action runs.
program.hook("preSubcommand", () => {
  // NOTE: `--no-color` is a negation flag → commander sets opts.color === false.
  // chalk 5.x does NOT read NO_COLOR itself — honor it here. The SDK never sees
  // NO_COLOR (scrubbed before load — its native layer panics on it).
  const opts = program.opts<{ color?: boolean; quiet?: boolean }>();
  if (opts.color === false || process.env.CI || "NO_COLOR" in process.env) chalk.level = 0;
  if (opts.quiet) process.env.DITTO_QUIET = "1";
});

try {
  await program.parseAsync([
    ...process.argv.slice(0, 2),
    ...rewriteDefaultSubcommand(process.argv.slice(2)),
  ]);
} catch (err) {
  if (err instanceof CommanderError) {
    // commander sets exitCode 0 for help/version (both the --help option AND
    // the `help` command), 1 for usage errors — map usage to 2.
    process.exitCode = err.exitCode === 0 ? 0 : 2;
  } else {
    console.error(chalk.red(err instanceof Error ? err.message : String(err)));
    process.exitCode = 1;
  }
}
