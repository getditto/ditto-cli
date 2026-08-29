import chalk from "chalk";
import { start } from "node:repl";
import path from "node:path";
import type { QueryExecutor } from "../../../ditto/session.js";
import { configDir } from "../../../config/paths.js";
import { dotHelp, makeReplEval } from "./repl-core.js";
import { runStatement } from "./run.js";

/**
 * Interactive REPL for `ditto dql` with no statement and a TTY on stdin.
 * Logic lives in repl-core.ts (unit-tested); this is node:repl wiring.
 */
export async function startRepl(session: QueryExecutor): Promise<void> {
  const server = start({
    prompt: chalk.cyan("dql> "),
    ignoreUndefined: true,
    eval: makeReplEval(session),
  });

  server.defineCommand("collections", {
    help: "List collections",
    async action() {
      await runStatement(session, "SELECT * FROM system:collections", {
        maxRows: 10_000,
        maxRowsExplicit: false,
      });
      server.displayPrompt();
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
      });
      server.displayPrompt();
    },
  });

  server.defineCommand("help", {
    help: "Show help",
    action() {
      console.log(dotHelp());
      server.displayPrompt();
    },
  });

  server.setupHistory(path.join(configDir(), "repl-history"), () => {});

  await new Promise<void>((resolve) => server.on("exit", () => resolve()));
}
