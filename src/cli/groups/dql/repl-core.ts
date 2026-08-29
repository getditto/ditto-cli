import chalk from "chalk";
import { Recoverable } from "node:repl";
import type { QueryExecutor } from "../../../ditto/session.js";
import { isCompleteStatement } from "../../../query/split.js";
import { runStatement } from "./run.js";

/**
 * Accumulates REPL input lines until they form complete, `;`-terminated
 * statements. Kept separate from node:repl wiring so it's unit-testable.
 */
export class StatementBuffer {
  private buffer = "";

  /** Returns the completed statement (terminator stripped) or null if incomplete. */
  feed(line: string): { complete: boolean; statement: string | null } {
    this.buffer += (this.buffer ? "\n" : "") + line;
    if (!isCompleteStatement(this.buffer)) {
      return { complete: false, statement: null };
    }
    const statement = this.buffer.replace(/;\s*$/, "");
    this.buffer = "";
    return { complete: true, statement };
  }

  reset(): void {
    this.buffer = "";
  }
}

const DOT_HELP = `Available commands:
  .help                 show this help
  .collections          list collections (system:collections)
  .indexes [name]       list indexes (system:indexes), optionally for one collection
  .exit                 quit (also: Ctrl-D, Ctrl-C)

Enter DQL statements terminated with a semicolon. Multi-line input is supported.`;

export function dotHelp(): string {
  return DOT_HELP;
}

type ReplCallback = (err: Error | null, result?: unknown) => void;
type ReplEval = (cmd: string, ctx: unknown, file: string, cb: ReplCallback) => void;

/**
 * The node:repl eval handler, extracted from the wiring for testability:
 * buffers input until a complete `;`-terminated statement exists, runs it
 * through the standard statement runner, and echoes elapsed time.
 */
export function makeReplEval(session: QueryExecutor): ReplEval {
  const input = new StatementBuffer();
  return (cmd, _ctx, _file, cb) => {
    const { complete, statement } = input.feed(cmd.replace(/\n$/, ""));
    if (!complete || statement === null) {
      // Signal node:repl to show the continuation prompt ("... ")
      cb(new Recoverable(new Error("incomplete statement")));
      return;
    }
    runStatement(session, statement, { maxRows: 10_000, maxRowsExplicit: false })
      .then((r) => {
        console.error(chalk.dim(`(${r.elapsedMs.toFixed(1)} ms)`));
        if (!r.ok) console.error(chalk.dim("statement failed — the store is unchanged for that statement"));
        cb(null);
      })
      .catch((err) => cb(null, err as Error));
  };
}
