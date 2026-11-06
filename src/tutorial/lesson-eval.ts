import { Recoverable } from "node:repl";
import chalk from "chalk";
import { StatementBuffer } from "../cli/groups/dql/repl-core.js";
import { isBlankOrComments } from "../query/split.js";
import type { LessonRunner } from "./runner.js";

type ReplCallback = (err: Error | null, result?: unknown) => void;

/**
 * node:repl eval for the lesson shell. Same continuation rules as the dql
 * REPL (repl-core.ts): after a Recoverable, node re-sends the whole
 * accumulated input, so the buffer is reset before feeding; statements are
 * serialized through a promise chain because node:repl doesn't pause input
 * for async evals.
 */
export function makeLessonEval(runner: Pick<LessonRunner, "submit">) {
  const input = new StatementBuffer();
  let awaitingContinuation = false;
  let chain: Promise<void> = Promise.resolve();

  const report = (err: unknown) => {
    console.error(chalk.red(`Error: ${err instanceof Error ? err.message : String(err)}`));
  };

  return {
    reset: () => {
      input.reset();
      awaitingContinuation = false;
    },
    drain: () => chain,
    eval: (cmd: string, _ctx: unknown, _file: string, cb: ReplCallback) => {
      if (awaitingContinuation) {
        input.reset();
        awaitingContinuation = false;
      }
      const { statements, rest } = input.feed(cmd.replace(/\n$/, ""));
      if (statements.length === 0) {
        if (!isBlankOrComments(rest)) {
          awaitingContinuation = true;
          cb(new Recoverable(new Error("incomplete statement")));
        } else {
          cb(null);
        }
        return;
      }
      input.reset();
      chain = chain
        .then(async () => {
          for (const s of statements) await runner.submit(s);
          if (!isBlankOrComments(rest)) {
            console.error(chalk.yellow(`discarding incomplete trailing text: "${rest.trim()}"`));
          }
        })
        .catch(report);
      chain.then(() => cb(null));
    },
  };
}
