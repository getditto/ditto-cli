import fs from "node:fs";
import type { DQLQueryArguments } from "@dittolive/ditto";
import chalk from "chalk";
import { readState, writeState } from "../../../config/state.js";
import type { QueryExecutor } from "../../../ditto/session.js";
import { capRows, classify, extractRows } from "../../../query/execute.js";
import {
  formatForOutFile,
  type OutputFormat,
  renderRows,
  resolveFormat,
} from "../../../render/output.js";

export interface RunOptions {
  format?: string;
  maxRows: number;
  maxRowsExplicit: boolean;
  out?: string;
  params?: DQLQueryArguments;
  /** Suppress the one-time no-LIMIT warning (used in tests / batch contexts). */
  suppressNoLimitWarning?: boolean;
  /** Whether stderr is an interactive terminal (default: process.stderr.isTTY). Injectable for tests. */
  interactive?: boolean;
}

export interface RunResult {
  ok: boolean;
  rows: number;
  elapsedMs: number;
}

const HAS_LIMIT = /\blimit\s+\d+/i;

function maybeWarnNoLimit(statement: string, opts: RunOptions): void {
  if (opts.suppressNoLimitWarning) return;
  if (classify(statement) !== "select") return;
  if (HAS_LIMIT.test(statement) || opts.maxRowsExplicit) return;
  if (!(opts.interactive ?? process.stderr.isTTY)) return;
  if (readState().noLimitWarned) return;
  console.error(
    chalk.yellow("heads up:") +
      " this SELECT has no LIMIT — unbounded queries can return very large result sets.\n" +
      "  Add LIMIT, use --max-rows, or write to a file with -o. (shown once)",
  );
  writeState({ noLimitWarned: true });
}

/**
 * Execute a single statement, render results, and report. Never throws for
 * query errors — returns { ok: false } instead (callers map to exit codes).
 */
export async function runStatement(
  session: QueryExecutor,
  statement: string,
  opts: RunOptions,
): Promise<RunResult> {
  maybeWarnNoLimit(statement, opts);

  const started = performance.now();
  let rows: Record<string, unknown>[];
  try {
    rows = extractRows(await session.execute(statement, opts.params));
  } catch (err) {
    const e = err as { message?: string; code?: string };
    console.error(chalk.red(`Query error${e.code ? ` [${e.code}]` : ""}: ${e.message ?? err}`));
    console.error(chalk.dim(`  in: ${statement}`));
    return { ok: false, rows: 0, elapsedMs: performance.now() - started };
  }
  const elapsedMs = performance.now() - started;

  // Mutations/DDL return no rows: acknowledge briefly.
  if (rows.length === 0 && classify(statement) !== "select") {
    console.log("OK");
    return { ok: true, rows: 0, elapsedMs };
  }

  const { rows: shown, truncated, total } = capRows(rows, opts.maxRows);
  const format: OutputFormat = opts.out
    ? formatForOutFile(opts.out, opts.format as OutputFormat | undefined)
    : resolveFormat(opts.format);

  if (opts.out) {
    fs.writeFileSync(opts.out, `${renderRows(shown, format)}\n`, "utf8");
    console.log(
      `Wrote ${shown.length} row${shown.length === 1 ? "" : "s"} to ${opts.out} (${format})`,
    );
  } else {
    console.log(renderRows(shown, format));
  }
  if (truncated) {
    console.error(
      chalk.yellow(`showing first ${shown.length} of ${total} rows — add a LIMIT clause`),
    );
  }
  return { ok: true, rows: shown.length, elapsedMs };
}
