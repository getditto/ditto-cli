import { Recoverable } from "node:repl";
import chalk from "chalk";
import type { QueryExecutor } from "../../../ditto/session.js";
import { endsInsideStringLiteral, isBlankOrComments, splitComplete } from "../../../query/split.js";
import { note, type RunOptions, runStatement } from "./run.js";

/**
 * Accumulates REPL input lines and drains complete statements.
 * Kept separate from node:repl wiring so it's unit-testable.
 */
export class StatementBuffer {
  private buffer = "";

  /**
   * Feed a line. Returns the statements that became complete (terminator
   * stripped). A trailing comment-only tail is discarded; a partial statement
   * stays buffered (exposed as `rest` for lockstep checks).
   */
  feed(line: string): { statements: string[]; pending: boolean; rest: string } {
    this.buffer += (this.buffer ? "\n" : "") + line;
    const { statements, rest } = splitComplete(this.buffer);
    this.buffer = isBlankOrComments(rest) ? "" : rest;
    return { statements, pending: this.buffer !== "", rest };
  }

  reset(): void {
    this.buffer = "";
  }
}

const DOT_HELP = `Available commands:
  .help                 show this help
  .collections          list collections (system:collections)
  .indexes [name]       list indexes (system:indexes), optionally for one collection
  .break / .clear       discard the current multi-line statement
  .exit                 quit (also: Ctrl-D, Ctrl-C)

Enter DQL statements terminated with a semicolon. Multi-line input is supported.`;

export function dotHelp(): string {
  return DOT_HELP;
}

type ReplCallback = (err: Error | null, result?: unknown) => void;
type ReplEval = (cmd: string, ctx: unknown, file: string, cb: ReplCallback) => void;

export interface ReplEvaluator {
  eval: ReplEval;
  /** Clear buffered input (for .break/.clear). */
  reset: () => void;
  /** No-op all further evals (exit requested). */
  close: () => void;
  /** Resolve when all statements accepted before close() have finished. */
  drain: () => Promise<void>;
}

const DOT_COMMAND = /(?:^|[\r\n])\s*(\.(?:break|clear|exit))\s*$/;

/**
 * The node:repl eval handler, extracted from the wiring for testability.
 *
 * node:repl semantics (verified against Node 24):
 *  - After a Recoverable response, node:repl RE-SENDS the entire accumulated
 *    input on the next eval call — so our buffer is reset before feeding
 *    continuation input, never appended to.
 *  - After a successful eval, node:repl clears its own buffer. A drain tail
 *    held by us would corrupt the next continuation (node re-sends without
 *    it), so a non-blank tail is reported and dropped (lockstep).
 *  - node:repl never pauses input for custom async evals: lines can arrive
 *    while a query is in flight (serialized via a promise chain) or after
 *    `.exit` (closed flag → no-op; post-exit input must not execute).
 *  - Dot-commands only dispatch at a FRESH prompt; at a continuation, a
 *    trailing `.break`/`.clear`/`.exit` line arrives inside cmd — intercept.
 */
export function makeReplEval(
  session: QueryExecutor,
  hooks?: { onExit?: () => void; runOpts?: Omit<RunOptions, "suppressNoLimitWarning"> },
): ReplEvaluator {
  const input = new StatementBuffer();
  let awaitingContinuation = false;
  let closed = false;
  let chain: Promise<void> = Promise.resolve(); // serialize in-flight evals

  const runAll = async (statements: string[]) => {
    // Statements that reached eval before .exit still run to completion —
    // only input arriving after .exit is dropped (see eval's closed check).
    for (const statement of statements) {
      const r = await runStatement(session, statement, {
        maxRows: 10_000,
        maxRowsExplicit: false,
        ...hooks?.runOpts,
        suppressNoLimitWarning: true,
      });
      // The REPL's own timing note; run.ts's --time footer covers it when set.
      if (!hooks?.runOpts?.time) note(`(${r.elapsedMs.toFixed(1)} ms)`);
      if (!r.ok) note("statement failed — the store is unchanged for that statement");
    }
  };

  // Unexpected errors (e.g. render crashes) surface but must never wedge the chain.
  const reportUnexpected = (err: unknown) => {
    console.error(chalk.red(`Error: ${err instanceof Error ? err.message : String(err)}`));
  };

  return {
    reset: () => {
      input.reset();
      awaitingContinuation = false;
    },
    close: () => {
      closed = true;
      input.reset();
    },
    drain: () => chain,
    eval: (cmd, _ctx, _file, cb) => {
      if (closed) {
        cb(null);
        return;
      }
      // Dot-command typed at a continuation prompt arrives inside cmd — but
      // only when we're not inside a string literal (a `.exit` LINE within a
      // multi-line text value is data, not a command).
      const dot = DOT_COMMAND.exec(cmd);
      if (dot && !endsInsideStringLiteral(cmd.slice(0, dot.index))) {
        closed = dot[1] === ".exit";
        input.reset();
        awaitingContinuation = false;
        if (closed) chain.then(() => hooks?.onExit?.());
        cb(null);
        return;
      }

      if (awaitingContinuation) {
        // node:repl re-sent the whole accumulation — replace, don't append.
        input.reset();
        awaitingContinuation = false;
      }
      const { statements, rest } = input.feed(cmd.replace(/\n$/, ""));
      if (statements.length === 0) {
        if (!isBlankOrComments(rest)) {
          awaitingContinuation = true;
          cb(new Recoverable(new Error("incomplete statement")));
        } else {
          cb(null); // comment-only line — back to the prompt
        }
        return;
      }
      // A non-blank tail after a drain corrupts the next continuation (node
      // re-sends without it) — report + drop it, staying in lockstep.
      if (!isBlankOrComments(rest)) {
        input.reset();
        chain = chain
          .then(async () => {
            await runAll(statements);
            console.error(
              chalk.yellow(
                `discarding incomplete trailing text: "${rest.trim()}" (finish it with a ';' on the next line)`,
              ),
            );
          })
          .catch(reportUnexpected);
        chain.then(() => cb(null));
        return;
      }
      chain = chain.then(() => runAll(statements)).catch(reportUnexpected);
      chain.then(() => cb(null));
    },
  };
}
