import { Recoverable } from "node:repl";
import chalk from "chalk";
import {
  endsInsideStringLiteral,
  isBlankOrComments,
  splitComplete,
  splitStatements,
  stripLiteralsAndComments,
} from "../query/split.js";
import type { LessonRunner } from "./runner.js";

type ReplCallback = (err: Error | null, result?: unknown) => void;

/** Words a statement can't end on — Enter after one continues to the next line. */
const CONTINUATION_WORDS = new Set([
  "select",
  "from",
  "where",
  "and",
  "or",
  "not",
  "by",
  "order",
  "group",
  "having",
  "on",
  "join",
  "set",
  "into",
  "documents",
  "values",
  "as",
  "in",
  "like",
  "between",
  "limit",
  "offset",
  "use",
  "ids",
  "update",
  "evict",
  "delete",
  "insert",
  "explain",
  "profile",
  "distinct",
  "with",
  "is",
  "any",
  "every",
  "satisfies",
  "case",
  "when",
  "then",
  "else",
]);

/**
 * True when the text is obviously unfinished: inside a string, unbalanced
 * brackets, or ending on a comma, an operator, or a keyword like WHERE.
 */
export function looksUnfinished(text: string): boolean {
  if (endsInsideStringLiteral(text)) return true;
  const code = stripLiteralsAndComments(text);
  let depth = 0;
  for (const ch of code) {
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth--;
  }
  if (depth > 0) return true;
  const tail = code.trimEnd();
  if (/[,=<>+\-*/%|.:]$/.test(tail)) return true;
  const lastWord = /([A-Za-z_]+)$/.exec(tail)?.[1]?.toLowerCase();
  return lastWord !== undefined && CONTINUATION_WORDS.has(lastWord);
}

/** The statements in one submitted input (`;`-separated; the last `;` is optional). */
export function splitInput(text: string): string[] {
  const { statements, rest } = splitComplete(text);
  return [...statements, ...splitStatements(rest)];
}

/**
 * node:repl eval for the lesson shell. Enter runs the statement — a `;` is
 * optional. Input continues on a `|` prompt only while it looks unfinished
 * (open quote/bracket, trailing comma, operator, or keyword).
 *
 * After a Recoverable, node re-sends the whole accumulated input, so each
 * call sees the full text. Statements are serialized through a promise chain
 * because node:repl doesn't pause input for async evals.
 */
export function makeLessonEval(runner: Pick<LessonRunner, "submit">) {
  let chain: Promise<void> = Promise.resolve();

  const report = (err: unknown) => {
    console.error(chalk.red(`Error: ${err instanceof Error ? err.message : String(err)}`));
  };

  return {
    reset: () => {},
    drain: () => chain,
    eval: (cmd: string, _ctx: unknown, _file: string, cb: ReplCallback) => {
      const text = cmd.replace(/\n$/, "");
      if (isBlankOrComments(text)) {
        cb(null);
        return;
      }
      if (looksUnfinished(text)) {
        cb(new Recoverable(new Error("incomplete statement")));
        return;
      }
      const all = splitInput(text);
      chain = chain
        .then(async () => {
          for (const s of all) await runner.submit(s);
        })
        .catch(report);
      chain.then(() => cb(null));
    },
  };
}
