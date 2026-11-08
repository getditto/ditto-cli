import chalk from "chalk";
import { Command, CommanderError } from "commander";
import { sdkDebugLevel } from "../ditto/session.js";
import { isDiagnosticCommand, recordLastError, startStderrTail } from "../support/last-error.js";
import { makeRedactor, SECRET_ENV } from "../support/redact.js";
import { rewriteDefaultSubcommand } from "./default-command.js";
import { configureDoctorCommand } from "./groups/doctor.js";
import { openSession, registerDqlGroup } from "./groups/dql/index.js";
import { registerSkillsGroup } from "./groups/skills/index.js";
import { registerSystemGroup } from "./groups/system/index.js";
import { defaultTutorialDeps, registerTutorialCommand } from "./groups/tutorial.js";
import { startTutorialShell } from "./groups/tutorial-repl.js";
import { installStdoutGuard } from "./streams.js";
import { maybeShowUpdateBanner } from "./update-banner.js";
import { CLI_VERSION } from "./version.js";

installStdoutGuard(); // quiet exit(0) on EPIPE — `| head` is a first-class flow
// Remember what a failing command printed, for `dittosh doctor --report`.
const stderrTail = startStderrTail();

const program = new Command();

// Commander's own usage errors (unknown option, missing argument, …) are
// usage errors: exit 2, not commander's default 1. Help/version exit 0.
// NOTE: must be installed BEFORE registering subcommands — commander only
// honors the override for groups registered after it (verified empirically).
program.exitOverride();

program
  .name("dittosh")
  .description("The Ditto CLI — run DQL, load sample datasets, install AI agent skills")
  .version(CLI_VERSION)
  .option("--no-color", "disable colored output (also: NO_COLOR, CI, non-TTY)")
  .option("--quiet", "suppress informational notes on stderr")
  .option("--no-update-check", "skip the update banner")
  .option(
    "--debug",
    "show Ditto SDK debug logs and stack traces on stderr (also: DITTOSH_DEBUG=1)",
  );

const dql = program.command("dql");
registerDqlGroup(dql);

const skills = program.command("skills");
registerSkillsGroup(skills);

registerSystemGroup(program);

// `dittosh doctor` is the same command as `dittosh dql doctor`.
configureDoctorCommand(program.command("doctor"));

registerTutorialCommand(program, {
  ...defaultTutorialDeps,
  startInteractive: (opts) => startTutorialShell(openSession, opts),
});

// Global flags take effect before any subcommand action runs.
program.hook("preSubcommand", () => {
  // NOTE: `--no-color` is a negation flag → commander sets opts.color === false.
  // chalk 5.x does NOT read NO_COLOR itself — honor it here. The SDK never sees
  // NO_COLOR (scrubbed before load — its native layer panics on it).
  const opts = program.opts<{ color?: boolean; quiet?: boolean; debug?: boolean }>();
  if (opts.color === false || process.env.CI || "NO_COLOR" in process.env) chalk.level = 0;
  if (opts.quiet) process.env.DITTOSH_QUIET = "1";
  if (opts.debug && !process.env.DITTOSH_DEBUG) process.env.DITTOSH_DEBUG = "1";
});

// After a successful command: the update banner (cached, non-blocking, stderr).
// Opt-outs: --no-update-check, DITTOSH_NO_UPDATE_CHECK, CI, --quiet, piped/JSON.
// Skipped for system-group commands (version/update handle updates themselves)
// and for help/version exits.
let commandErrored = false;
let errorStack: string | undefined;
let usedSystemCommand = false;
try {
  const argv = process.argv.slice(2);
  usedSystemCommand = argv.some((a) => a === "version" || a === "update" || a === "help");
  await program.parseAsync([
    ...process.argv.slice(0, 2),
    ...rewriteDefaultSubcommand(process.argv.slice(2)),
  ]);
} catch (err) {
  commandErrored = true;
  if (err instanceof CommanderError) {
    // commander sets exitCode 0 for help/version (both the --help option AND
    // the `help` command), 1 for usage errors — map usage to 2.
    process.exitCode = err.exitCode === 0 ? 0 : 2;
  } else {
    console.error(chalk.red(err instanceof Error ? err.message : String(err)));
    errorStack = err instanceof Error ? err.stack : undefined;
    if (errorStack && sdkDebugLevel(process.env.DITTOSH_DEBUG))
      console.error(chalk.dim(errorStack));
    process.exitCode = 1;
  }
}

// Save the failure (not usage errors or help) so `doctor --report` can show it.
const argv = process.argv.slice(2);
const exitCode = Number(process.exitCode ?? 0);
if (exitCode !== 0 && exitCode !== 2 && !isDiagnosticCommand(argv)) {
  const redact = makeRedactor({ secrets: SECRET_ENV.map((k) => process.env[k]) });
  recordLastError({
    time: new Date().toISOString(),
    version: CLI_VERSION,
    command: argv.map(redact),
    exitCode,
    stderr: stderrTail.lines().map(redact),
    ...(errorStack ? { stack: redact(errorStack) } : {}),
  });
}
stderrTail.stop();

if (!process.exitCode && !commandErrored && !usedSystemCommand) {
  await maybeShowUpdateBanner(CLI_VERSION, {
    // commander stores --no-update-check under the POSITIVE name (updateCheck === false)
    noCheckFlag: program.opts<{ updateCheck?: boolean }>().updateCheck === false,
    quiet: program.opts<{ quiet?: boolean }>().quiet,
  });
}
