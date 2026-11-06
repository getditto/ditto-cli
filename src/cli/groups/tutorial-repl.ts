import path from "node:path";
import { start } from "node:repl";
import chalk from "chalk";
import { configDir } from "../../config/paths.js";
import { readState, writeState } from "../../config/state.js";
import type { DittoSession } from "../../ditto/session.js";
import { makeLessonEval } from "../../tutorial/lesson-eval.js";
import { LEVELS, type Level } from "../../tutorial/lessons.js";
import { LESSON_HELP, LessonRunner, type Progress } from "../../tutorial/runner.js";

/** The lessons' own store, separate from the user's default data directory. */
export function tutorialDataDir(): string {
  return path.join(configDir(), "tutorial-store");
}

function readProgress(): Progress | undefined {
  const p = readState().tutorialProgress as Progress | undefined;
  return p && typeof p.lesson === "number" && Array.isArray(p.completed) ? p : undefined;
}

/**
 * `dittosh tutorial --interactive`: the lesson shell. Logic lives in
 * LessonRunner / makeLessonEval (unit-tested); this is node:repl wiring.
 */
export async function startTutorialShell(
  openSession: (opts: { dataDir?: string }) => Promise<DittoSession | null>,
  opts: { dataDir?: string; level?: string },
): Promise<void> {
  if (!process.stdin.isTTY) {
    console.error(chalk.red("Interactive lessons need a terminal (stdin is not a TTY)."));
    process.exitCode = 2;
    return;
  }
  let level: Level | undefined;
  if (opts.level !== undefined) {
    const l = opts.level.toLowerCase() as Level;
    if (!LEVELS.includes(l)) {
      console.error(chalk.red(`--level must be one of ${LEVELS.join(", ")} — got "${opts.level}"`));
      process.exitCode = 2;
      return;
    }
    level = l;
  }

  const session = await openSession({ dataDir: opts.dataDir ?? tutorialDataDir() });
  if (!session) return;
  try {
    const runner = new LessonRunner(session, {
      io: { print: (t) => console.log(t), width: () => process.stdout.columns },
      progress: readProgress(),
      saveProgress: (p) => writeState({ tutorialProgress: p }),
    });
    await runner.start({ level });

    const evaluator = makeLessonEval(runner);
    const server = start({
      prompt: chalk.cyan("learn> "),
      ignoreUndefined: true,
      eval: evaluator.eval,
    });
    const isClosed = () => (server as unknown as { closed: boolean }).closed === true;
    const prompt = () => {
      if (!isClosed()) server.displayPrompt();
    };
    const command = (name: string, help: string, action: (arg?: string) => unknown) => {
      server.defineCommand(name, {
        help,
        async action(arg?: string) {
          try {
            await action(arg);
          } catch (err) {
            console.error(chalk.red(`Error: ${(err as Error).message}`));
          }
          prompt();
        },
      });
    };

    command("hint", "A nudge toward the answer", () => runner.hint());
    command("answer", "Show one correct statement", () => runner.answer());
    command("next", "Skip to the next lesson", () => runner.next());
    command("back", "Go back one lesson", () => runner.back());
    command("lessons", "List lessons by level", () => runner.list());
    command("level", `Jump to a level: ${LEVELS.join(", ")}`, (a) => runner.level(a));
    command("goto", "Jump to lesson n", (a) => runner.goto(a));
    command("reset", "Restore the practice data", () => runner.reset());
    command("help", "Show lesson commands", () => console.log(LESSON_HELP));
    const resettable = () => {
      evaluator.reset();
      server.clearBufferedCommand();
    };
    command("break", "Discard the current multi-line statement", resettable);
    command("clear", "Discard the current multi-line statement", resettable);
    const unsupported = () => console.error(chalk.dim("not available in the lessons"));
    command("editor", "Not available", unsupported);
    command("load", "Not available", unsupported);
    command("save", "Not available", unsupported);

    await new Promise<void>((resolve) => server.on("exit", () => resolve()));
    await evaluator.drain();
    console.log(
      chalk.dim(
        `Progress saved (${runner.completedCount}/${runner.lessons.length} lessons). Run dittosh tutorial --interactive to continue.`,
      ),
    );
  } finally {
    await session.close();
  }
}
