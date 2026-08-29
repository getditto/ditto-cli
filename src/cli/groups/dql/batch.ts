import chalk from "chalk";
import type { QueryExecutor } from "../../../ditto/session.js";
import { runStatement, type RunOptions } from "./run.js";

export interface BatchResult {
  ok: number;
  failed: number;
  total: number;
}

/**
 * Execute a batch of statements (from -f file or piped stdin), in order.
 * Stops at the first failure unless `continueOnError`.
 */
export async function runBatch(
  session: QueryExecutor,
  statements: string[],
  opts: RunOptions & { continueOnError?: boolean },
): Promise<BatchResult> {
  let ok = 0;
  let failed = 0;
  for (const statement of statements) {
    const r = await runStatement(session, statement, { ...opts, suppressNoLimitWarning: true });
    if (r.ok) ok++;
    else {
      failed++;
      if (!opts.continueOnError) break;
    }
  }
  if (statements.length > 1) {
    console.error(chalk.dim(`${ok} ok, ${failed} failed (of ${statements.length})`));
  }
  return { ok, failed, total: statements.length };
}
