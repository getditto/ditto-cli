import fs from "node:fs";
import type { DQLQueryArguments } from "@dittolive/ditto";
import chalk from "chalk";
import { readState, writeState } from "../../../config/state.js";
import type { QueryExecutor } from "../../../ditto/session.js";
import { formatNs } from "../../../profile/format.js";
import { extractProfile, type QueryProfile } from "../../../profile/parse.js";
import { capRows, classify, extractRows } from "../../../query/execute.js";
import { renderExplain } from "../../../render/explain.js";
import {
  formatForOutFile,
  type OutputFormat,
  renderRows,
  resolveFormat,
} from "../../../render/output.js";
import { renderProfile } from "../../../render/profile.js";

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
  /** --time: timing footer. */
  time?: boolean;
  /** --explain: EXPLAIN side-trip for SELECT statements. */
  explain?: boolean;
  /** --profile: PROFILE prefix for bare SELECTs, rendered profile view. */
  profile?: boolean;
}

export interface RunResult {
  ok: boolean;
  rows: number;
  elapsedMs: number;
  profile?: QueryProfile;
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
 *
 * Diagnostics (Edge Studio gating rules):
 *  - --profile prefixes PROFILE onto bare SELECTs only (never doubles a
 *    user-typed PROFILE; ADVISE/EXPLAIN/DDL/mutations are not profilable)
 *  - --explain runs an EXPLAIN side-trip for SELECTs (never for ADVISE —
 *    `EXPLAIN ADVISE` is invalid syntax upstream)
 */
export async function runStatement(
  session: QueryExecutor,
  statement: string,
  opts: RunOptions,
): Promise<RunResult> {
  maybeWarnNoLimit(statement, opts);

  const kind = classify(statement);
  const profilable = opts.profile === true && kind === "select";
  if (opts.profile && !profilable && kind !== "profile") {
    console.error(chalk.dim("note: only SELECT statements are profilable — running without PROFILE"));
  }
  const effectiveStatement = profilable ? `PROFILE ${statement}` : statement;

  const started = performance.now();
  let rows: Record<string, unknown>[];
  try {
    rows = extractRows(await session.execute(effectiveStatement, opts.params));
  } catch (err) {
    const e = err as { message?: string; code?: string };
    console.error(chalk.red(`Query error${e.code ? ` [${e.code}]` : ""}: ${e.message ?? err}`));
    console.error(chalk.dim(`  in: ${statement}`));
    return { ok: false, rows: 0, elapsedMs: performance.now() - started };
  }
  const elapsedMs = performance.now() - started;

  // A PROFILE run appends a ~request_profile envelope to the result set.
  let profile: QueryProfile | undefined;
  if (profilable || kind === "profile") {
    const extracted = extractProfile(rows);
    rows = extracted.rows;
    profile = extracted.profile;
  }

  // Mutations/DDL return no rows: acknowledge briefly.
  if (rows.length === 0 && kind !== "select" && kind !== "profile") {
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

  if (opts.explain && kind === "select") {
    try {
      const explainRows = extractRows(await session.execute(`EXPLAIN ${statement}`, opts.params));
      console.log(renderExplain(explainRows[0]));
    } catch (err) {
      console.error(chalk.dim(`(explain unavailable: ${(err as Error).message})`));
    }
  }

  if ((profilable || kind === "profile") && opts.profile !== false) {
    if (profile) {
      console.log(renderProfile(profile, statement));
    } else if (opts.profile) {
      console.error(chalk.dim("note: no profile envelope in the result (non-SELECT or unsupported)"));
    }
  }

  if (opts.time) {
    const server = profile?.times;
    const serverPart = server?.elapsedNs
      ? ` — server: elapsed ${formatNs(server.elapsedNs)} · parse ${formatNs(server.parseNs)} · plan ${formatNs(server.planNs)}`
      : "";
    console.error(chalk.dim(`Time: ${elapsedMs.toFixed(1)} ms${serverPart}`));
  }

  return { ok: true, rows: shown.length, elapsedMs, profile };
}
