import fs from "node:fs";
import path from "node:path";
import { start } from "node:repl";
import chalk from "chalk";
import { configDir } from "../../../config/paths.js";
import type { QueryExecutor } from "../../../ditto/session.js";
import { dotHelp, makeReplEval } from "./repl-core.js";
import { type RunOptions, runStatement } from "./run.js";

/**
 * Interactive REPL for `dittosh dql` with no statement and a TTY on stdin.
 * Logic lives in repl-core.ts (unit-tested); this is node:repl wiring.
 */
export async function startRepl(
  session: QueryExecutor,
  runOpts?: Omit<RunOptions, "suppressNoLimitWarning">,
): Promise<void> {
  let evaluator: ReturnType<typeof makeReplEval>;
  const server = start({
    prompt: chalk.cyan("dql> "),
    ignoreUndefined: true,
    eval: (cmd, ctx, file, cb) => {
      evaluator.eval(cmd, ctx, file, cb);
    },
  });
  evaluator = makeReplEval(session, {
    onExit: () => server.close(),
    runOpts,
  });
  // @types/node lacks `closed` (present at runtime on the readline interface).
  const isClosed = () => (server as unknown as { closed: boolean }).closed === true;
  // .exit/Ctrl-D/Ctrl-C from node:repl itself: stop executing queued input.
  server.on("exit", () => evaluator.close());

  server.defineCommand("collections", {
    help: "List collections",
    async action() {
      await runStatement(session, "SELECT * FROM system:collections", {
        maxRows: 10_000,
        maxRowsExplicit: false,
        suppressNoLimitWarning: true,
      });
      if (!isClosed()) server.displayPrompt();
    },
  });

  server.defineCommand("indexes", {
    help: "List indexes, optionally for one collection: .indexes movies",
    async action(name?: string) {
      const stmt = name
        ? "SELECT * FROM system:indexes WHERE collection = :collection"
        : "SELECT * FROM system:indexes";
      await runStatement(session, stmt, {
        maxRows: 10_000,
        maxRowsExplicit: false,
        params: name ? { collection: name.trim() } : undefined,
        suppressNoLimitWarning: true,
      });
      if (!isClosed()) server.displayPrompt();
    },
  });

  server.defineCommand("help", {
    help: "Show help",
    action() {
      console.log(dotHelp());
      if (!isClosed()) server.displayPrompt();
    },
  });

  // `.break`/`.clear` at a FRESH prompt (node:repl only dispatches dot-commands
  // there; at a continuation they're intercepted by the eval handler).
  const resettable = {
    help: "Discard the current multi-line statement",
    action(this: typeof server) {
      evaluator.reset();
      this.clearBufferedCommand();
      if (!isClosed()) this.displayPrompt();
    },
  };
  server.defineCommand("break", resettable);
  server.defineCommand("clear", resettable);

  // `.exit` at a FRESH prompt dispatches here (continuations are intercepted by
  // the eval handler). Close the evaluator SYNCHRONOUSLY — node defers
  // server.close() via nextTick, and input buffered in the same tick would
  // otherwise still evaluate (and mutate the store) before exit.
  server.defineCommand("exit", {
    help: "Exit the REPL",
    action(this: typeof server) {
      evaluator.close();
      this.close();
    },
  });

  // node:repl's text-editor builtins make no sense for DQL — disable cleanly.
  const unsupported = {
    help: "Not supported in the DQL REPL",
    action(this: typeof server) {
      console.error(chalk.dim("not supported in the DQL REPL (use -f to run files)"));
      if (!isClosed()) this.displayPrompt();
    },
  };
  server.defineCommand("editor", unsupported);
  server.defineCommand("load", unsupported);
  server.defineCommand("save", unsupported);

  try {
    fs.mkdirSync(configDir(), { recursive: true });
  } catch (err) {
    console.error(chalk.dim(`(config dir unavailable: ${(err as Error).message})`));
  }
  // Note: setupHistory's callback never fires on failure — node prints its own notice.
  server.setupHistory(path.join(configDir(), "repl-history"), () => {});

  await new Promise<void>((resolve) => server.on("exit", () => resolve()));
  // Let statements accepted before exit finish before the session closes.
  await evaluator.drain();
}
