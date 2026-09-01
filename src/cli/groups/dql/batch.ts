import chalk from "chalk";
import type { QueryExecutor } from "../../../ditto/session.js";
import { stdoutBroken } from "../../streams.js";
import { note, type RunOptions, runStatement } from "./run.js";

/**
 * Remove line-oriented REPL dot-commands from batch text (before statement
 * splitting — a dot-command line has no `;` and would otherwise glue itself
 * onto the following statement). STRING-AWARE: a `.exit`-looking line inside
 * a multi-line string literal is data, not a command.
 * Only KNOWN REPL commands match — a leading `.5` float literal is data.
 */
const DOT_COMMAND_LINE = /^\s*\.(help|exit|break|clear|collections|indexes|editor|load|save)\b/;

export function stripDotCommandLines(text: string): string {
  // Split keeping the delimiters — removed lines take their line ending with
  // them; everything else (incl. CRLF inside string literals) is byte-exact.
  const pieces = text.split(/(\r\n|\r|\n)/);
  const kept: string[] = [];
  let inString: string | null = null; // the quote char we're inside, or null
  let inBlockComment = false;

  for (let i = 0; i < pieces.length; i += 2) {
    const line = pieces[i]!;
    const eol = pieces[i + 1] ?? "";
    // Only consider a dot-command when the line starts OUTSIDE a string/comment.
    if (!inString && !inBlockComment && DOT_COMMAND_LINE.test(line)) {
      note(`skipping REPL command in batch input: ${line.trim()}`);
      continue; // drop the line AND its line ending
    }
    kept.push(line, eol);

    // Track string/comment state across lines (DQL backslash-aware).
    let j = 0;
    while (j < line.length) {
      const ch = line[j]!;
      const next = line[j + 1];
      if (inBlockComment) {
        if (ch === "*" && next === "/") {
          inBlockComment = false;
          j += 2;
          continue;
        }
        j++;
        continue;
      }
      if (inString) {
        if (ch === "\\" && inString !== "`") {
          j += 2;
          continue;
        }
        if (ch === inString) inString = null;
        j++;
        continue;
      }
      if (ch === "-" && next === "-") break; // rest of the line is a comment
      if (ch === "/" && next === "*") {
        inBlockComment = true;
        j += 2;
        continue;
      }
      if (ch === "'" || ch === '"' || ch === "`") {
        inString = ch;
        j++;
        continue;
      }
      j++;
    }
  }
  return kept.join("");
}

export interface BatchResult {
  ok: number;
  failed: number;
  total: number;
}

/**
 * Execute a batch of statements (from -f file or piped stdin), in order.
 * Stops at the first failure unless `continueOnError`.
 * Dot-commands are REPL-only: stripped line-wise BEFORE splitting (a `.exit`
 * line without a `;` would otherwise glue itself onto the next statement).
 */
export async function runBatch(
  session: QueryExecutor,
  statements: string[],
  opts: RunOptions & { continueOnError?: boolean },
): Promise<BatchResult> {
  let ok = 0;
  let failed = 0;
  for (const statement of statements) {
    if (stdoutBroken()) break; // reader went away mid-batch (| head) — stop quietly
    const r = await runStatement(session, statement, { ...opts, suppressNoLimitWarning: true });
    if (r.ok) ok++;
    else {
      failed++;
      if (!opts.continueOnError) break;
    }
  }
  if (statements.length > 1) {
    const attempted = ok + failed;
    const skipped = statements.length - attempted;
    console.error(
      chalk.dim(
        `${ok} ok, ${failed} failed${skipped > 0 ? `, ${skipped} skipped` : ""} (of ${statements.length})`,
      ),
    );
  }
  return { ok, failed, total: statements.length };
}
