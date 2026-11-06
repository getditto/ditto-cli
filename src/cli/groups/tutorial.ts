import fs from "node:fs";
import path from "node:path";
import chalk from "chalk";
import type { Command } from "commander";
import { expandTilde } from "../../config/paths.js";
import { renderTutorial, type TutorialContext } from "../../tutorial/content.js";
import { detectChannel } from "../../update/channel.js";
import { CLI_VERSION, DITTO_SDK_VERSION } from "../version.js";

export const DEFAULT_TUTORIAL_FILE = "dittosh-tutorial.md";

export interface TutorialDeps {
  detectChannel: () => Pick<ReturnType<typeof detectChannel>, "channel">;
  now: () => Date;
  platform: string;
  /** Launch the interactive DQL lessons (wired in by the CLI entry). */
  startInteractive?: (opts: { dataDir?: string; level?: string }) => Promise<void>;
}

export const defaultTutorialDeps: TutorialDeps = {
  detectChannel,
  now: () => new Date(),
  platform: `${process.platform}/${process.arch}`,
};

export function tutorialContext(deps: TutorialDeps): TutorialContext {
  return {
    cliVersion: CLI_VERSION,
    sdkVersion: DITTO_SDK_VERSION,
    channel: deps.detectChannel().channel,
    platform: deps.platform,
    generatedOn: deps.now().toISOString().slice(0, 10),
  };
}

export interface WriteTutorialOptions {
  out?: string;
  stdout?: boolean;
  force?: boolean;
}

/** Generate the Markdown tutorial to a file (default) or stdout. Returns the exit code. */
export function writeTutorial(
  opts: WriteTutorialOptions,
  deps: TutorialDeps = defaultTutorialDeps,
): number {
  const markdown = renderTutorial(tutorialContext(deps));
  if (opts.stdout) {
    if (opts.out) {
      console.error(chalk.red("--stdout and --out can't be used together"));
      return 2;
    }
    process.stdout.write(markdown);
    return 0;
  }
  const target = path.resolve(expandTilde(opts.out ?? DEFAULT_TUTORIAL_FILE));
  if (fs.existsSync(target) && !opts.force) {
    console.error(
      chalk.red(`${target} already exists — pass --force to overwrite, or --out <file>`),
    );
    return 2;
  }
  try {
    fs.writeFileSync(target, markdown, "utf8");
  } catch (err) {
    console.error(chalk.red(`Cannot write ${target}: ${(err as NodeJS.ErrnoException).message}`));
    return 1;
  }
  console.error(`Wrote the tutorial to ${target}`);
  console.error(
    chalk.dim("Open it in a Markdown viewer and follow along in a terminal. Prefer learning DQL"),
  );
  console.error(chalk.dim("step by step? Run: dittosh tutorial --interactive"));
  return 0;
}

export function registerTutorialCommand(
  program: Command,
  deps: TutorialDeps = defaultTutorialDeps,
): void {
  program
    .command("tutorial")
    .description(
      "Generate a hands-on Markdown tutorial for this install, or learn DQL interactively (--interactive)",
    )
    .option("-o, --out <file>", `write the tutorial here (default: ./${DEFAULT_TUTORIAL_FILE})`)
    .option("--stdout", "print the Markdown to stdout instead of writing a file", false)
    .option("--force", "overwrite an existing file", false)
    .option("-i, --interactive", "learn DQL with guided lessons in an interactive shell", false)
    .option("--level <level>", "with --interactive: start at beginner, intermediate, or advanced")
    .option(
      "-d, --data-dir <path>",
      "with --interactive: practice store (default: a separate store in the config dir)",
    )
    .action(
      async (
        opts: WriteTutorialOptions & { interactive: boolean; dataDir?: string; level?: string },
      ) => {
        if (opts.interactive) {
          if (!deps.startInteractive) {
            console.error(chalk.red("interactive lessons are unavailable in this build"));
            process.exitCode = 1;
            return;
          }
          await deps.startInteractive({ dataDir: opts.dataDir, level: opts.level });
          return;
        }
        if (opts.level || opts.dataDir) {
          console.error(chalk.red("--level and --data-dir only apply with --interactive"));
          process.exitCode = 2;
          return;
        }
        const code = writeTutorial(opts, deps);
        if (code !== 0) process.exitCode = code;
      },
    );
}
