import fs from "node:fs";
import path from "node:path";
import type { DQLQueryArguments } from "@dittolive/ditto";
import chalk from "chalk";
import { expandTilde } from "../../../config/paths.js";
import { readState, writeState } from "../../../config/state.js";
import type { QueryExecutor } from "../../../ditto/session.js";
import { formatNs } from "../../../profile/format.js";
import { extractProfile, type QueryProfile } from "../../../profile/parse.js";
import { extractQueryAdvice } from "../../../query/advise.js";
import { capRows, classify, extractRows } from "../../../query/execute.js";
import { hasLimitClause } from "../../../query/split.js";
import { renderAdvice } from "../../../render/advise.js";
import { renderExplain } from "../../../render/explain.js";
import { formatForOutFile, renderRows, resolveFormat } from "../../../render/output.js";
import { type PageOptions, pageIfLong } from "../../../render/pager.js";
import { renderProfile } from "../../../render/profile.js";

export interface RunOptions {
  format?: string;
  maxRows: number;
  maxRowsExplicit: boolean;
  out?: string;
  params?: DQLQueryArguments;
  /** Suppress the one-time no-LIMIT warning (batch contexts, built-in commands). */
  suppressNoLimitWarning?: boolean;
  /** Whether stderr is an interactive terminal (default: process.stderr.isTTY). Injectable for tests. */
  interactive?: boolean;
  /** --time: timing footer (stderr). */
  time?: boolean;
  /** --explain: EXPLAIN side-trip for SELECT statements. */
  explain?: boolean;
  /** --profile: PROFILE prefix for bare SELECTs, rendered profile view. */
  profile?: boolean;
  /** --advise: wrap the statement in ADVISE and render index advice. */
  advise?: boolean;
  /** --apply (with --advise): execute suggested CREATE INDEX statements. */
  apply?: boolean;
  /** -y: skip apply confirmation prompts. */
  yes?: boolean;
  /** Injectable confirmation prompt (defaults to @inquirer/prompts on TTY). */
  confirm?: (message: string) => Promise<boolean>;
  /** Injectable "is stdout a TTY" (diagnostic sections go to stderr when piped). */
  stdoutIsTTY?: boolean;
  /** --no-pager sets this false; undefined = page long TTY output automatically. */
  pager?: boolean;
  /** Injectable pager (defaults to pageIfLong) for tests. */
  page?: (text: string, opts?: PageOptions) => boolean;
}

export interface RunResult {
  ok: boolean;
  rows: number;
  elapsedMs: number;
  profile?: QueryProfile;
}

/** Validate an -o target BEFORE opening the store (usage beats lock). Returns an error message or null. */
export function validateOutPath(out: string): string | null {
  const target = path.resolve(expandTilde(out));
  if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
    return `Cannot write ${out}: that's a directory`;
  }
  const parent = path.dirname(target);
  if (!fs.existsSync(parent) || !fs.statSync(parent).isDirectory()) {
    return `Cannot write ${out}: no such directory: ${parent}`;
  }
  return null;
}

/** Informational notes on stderr; suppressed by --quiet (DITTOSH_QUIET=1/true/yes). */
export function note(message: string): void {
  const v = process.env.DITTOSH_QUIET?.toLowerCase();
  if (v === "1" || v === "true" || v === "yes") return;
  console.error(chalk.dim(message));
}

function warnNoLimit(statement: string, opts: RunOptions): void {
  if (opts.suppressNoLimitWarning) return;
  if (classify(statement) !== "select") return;
  if (hasLimitClause(statement) || opts.maxRowsExplicit) return;
  if (opts.out) return; // -o exports the full result — it IS the remedy
  if (!(opts.interactive ?? process.stderr.isTTY)) return;
  if (readState().noLimitWarned) return;
  console.error(
    chalk.yellow("heads up:") +
      " this SELECT has no LIMIT — unbounded queries can return very large result sets.\n" +
      "  Add LIMIT, use --max-rows, or write to a file with -o. (shown once)",
  );
  writeState({ noLimitWarned: true });
}

/** --profile/--explain/--advise render as rich UI on a TTY, stderr when piped. */
function diagOut(opts: RunOptions, text: string): void {
  if (opts.stdoutIsTTY ?? process.stdout.isTTY) console.log(text);
  else console.error(text);
}

/** --apply confirmation: -y skips, injected prompt wins, prompt needs stdin+stderr TTY. */
async function confirmApply(opts: RunOptions, message: string): Promise<boolean> {
  if (opts.yes) return true;
  if (opts.confirm) return opts.confirm(message);
  if (!(process.stdin.isTTY && (opts.interactive ?? process.stderr.isTTY))) {
    console.error(chalk.dim(`  skipped (non-interactive — pass -y to apply): ${message}`));
    return false;
  }
  const { confirm } = await import("@inquirer/prompts");
  return confirm({ message, default: false }, { input: process.stdin, output: process.stderr });
}

/**
 * Execute a single statement, render results, and report. Never throws for
 * query errors — returns { ok: false } instead (callers map to exit codes).
 *
 * Gating (Edge Studio rules):
 *  - --profile prefixes PROFILE onto bare SELECTs only (never doubles a
 *    user-typed PROFILE; ADVISE/EXPLAIN/DDL/mutations are not profilable)
 *  - --explain runs an EXPLAIN side-trip for SELECTs (never for ADVISE —
 *    `EXPLAIN ADVISE` is invalid syntax upstream)
 *  - --advise wins over --profile/--explain with a one-line note
 */
export async function runStatement(
  session: QueryExecutor,
  statement: string,
  opts: RunOptions,
): Promise<RunResult> {
  warnNoLimit(statement, opts);

  const kind = classify(statement);

  let wantExplain = opts.explain;
  let wantProfile = opts.profile;
  if (opts.advise && (wantExplain || wantProfile)) {
    note("note: --advise takes precedence over --profile/--explain");
    wantExplain = false;
    wantProfile = false;
  }
  if (opts.advise && kind !== "select" && kind !== "advise") {
    note("note: ADVISE applies to SELECT statements only — running without ADVISE");
  }
  if (wantExplain && kind !== "select" && kind !== "explain") {
    note("note: only SELECT statements can be EXPLAINed — running without EXPLAIN");
  }
  const adviseMode = (opts.advise && kind === "select") || kind === "advise";
  if (opts.apply && !adviseMode) {
    note("note: --apply only does something with --advise — ignoring it");
  }

  const profilable = wantProfile === true && kind === "select";
  if (wantProfile && !profilable && kind !== "profile") {
    note("note: only SELECT statements are profilable — running without PROFILE");
  }
  const effectiveStatement =
    adviseMode && kind === "select"
      ? `ADVISE ${statement}`
      : profilable
        ? `PROFILE ${statement}`
        : statement;

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

  const timeFooter = (profile?: QueryProfile) => {
    if (!opts.time) return;
    const server = profile?.times;
    const serverPart = server?.elapsedNs
      ? ` — server: elapsed ${formatNs(server.elapsedNs)} · parse ${formatNs(server.parseNs)} · plan ${formatNs(server.planNs)}`
      : "";
    console.error(chalk.dim(`Time: ${elapsedMs.toFixed(1)} ms${serverPart}`));
  };

  // ADVISE mode: render the advice card instead of rows, optionally applying.
  if (adviseMode) {
    const advice = extractQueryAdvice(rows);
    if (!advice) {
      diagOut(opts, chalk.dim("(no advice in the result)"));
      timeFooter();
      return { ok: true, rows: 0, elapsedMs };
    }
    let applied: Map<string, "created" | "failed"> | undefined;
    if (opts.apply && advice.suggestedIndexes.length > 0) {
      applied = new Map();
      for (const s of advice.suggestedIndexes) {
        const confirmed = await confirmApply(opts, `Create index: ${s.statement}?`);
        if (!confirmed) continue;
        try {
          await session.execute(s.statement);
          applied.set(s.statement, "created");
        } catch (err) {
          console.error(chalk.red(`  failed: ${(err as Error).message}`));
          applied.set(s.statement, "failed");
        }
      }
    }
    diagOut(opts, renderAdvice(advice, applied));
    timeFooter();
    return { ok: true, rows: advice.suggestedIndexes.length, elapsedMs };
  }

  // A PROFILE run appends a ~request_profile envelope to the result set.
  let profile: QueryProfile | undefined;
  if (profilable || kind === "profile") {
    const extracted = extractProfile(rows);
    rows = extracted.rows;
    profile = extracted.profile;
  }

  // Mutations/DDL return no rows: acknowledge briefly (stderr when piped).
  if (rows.length === 0 && kind !== "select" && kind !== "profile") {
    if (opts.stdoutIsTTY ?? process.stdout.isTTY) console.log("OK");
    else console.error("OK");
    timeFooter();
    return { ok: true, rows: 0, elapsedMs };
  }

  const { rows: shown, truncated, total } = capRows(rows, opts.maxRows);

  // -o file exports are uncapped by default (the file IS the remedy for large
  // result sets); an explicit --max-rows still caps them.
  const rowsForFile = opts.maxRowsExplicit ? shown : rows;
  const format = opts.out ? formatForOutFile(opts.out, opts.format) : resolveFormat(opts.format);
  if (format === "json") process.env.DITTOSH_JSON_OUT = "1"; // the update banner never appears in JSON mode
  if (format === "json") process.env.DITTOSH_JSON_OUT = "1"; // the update banner never appears in JSON mode

  if (opts.out) {
    // Files never get ANSI escapes, even when the terminal is colored.
    let rendered: string;
    const prevLevel = chalk.level;
    chalk.level = 0;
    try {
      rendered = `${renderRows(rowsForFile, format)}\n`;
    } finally {
      chalk.level = prevLevel;
    }
    try {
      fs.writeFileSync(expandTilde(opts.out), rendered, "utf8");
    } catch (err) {
      console.error(
        chalk.red(`Cannot write ${opts.out}: ${(err as NodeJS.ErrnoException).message}`),
      );
      return { ok: false, rows: 0, elapsedMs };
    }
    const cappedNote =
      opts.maxRowsExplicit && rowsForFile.length < rows.length
        ? ` (first ${rowsForFile.length} of ${rows.length} — --max-rows)`
        : "";
    console.log(
      `Wrote ${rowsForFile.length.toLocaleString()} row${rowsForFile.length === 1 ? "" : "s"} to ${opts.out} in ${elapsedMs.toFixed(0)} ms (${format})${cappedNote}`,
    );
  } else {
    // Tables fit the terminal width on a TTY; pipes/files keep full fidelity.
    // (A 0-column terminal is degenerate — some ptys report 0x0 — treat as unknown.)
    const tty = opts.stdoutIsTTY ?? process.stdout.isTTY;
    const rendered = renderRows(shown, format, {
      maxWidth: tty ? process.stdout.columns || undefined : undefined,
    });
    const page = opts.page ?? pageIfLong;
    if (!page(rendered, { disabled: opts.pager === false })) console.log(rendered);
  }
  if (truncated && !opts.out) {
    console.error(
      chalk.yellow(`showing first ${shown.length} of ${total} rows — add a LIMIT clause`),
    );
  }

  if (wantExplain && kind === "select") {
    try {
      const explainRows = extractRows(await session.execute(`EXPLAIN ${statement}`, opts.params));
      diagOut(opts, renderExplain(explainRows[0]));
    } catch (err) {
      note(`(explain unavailable: ${(err as Error).message})`);
    }
  }

  if (profilable || kind === "profile") {
    if (profile) {
      diagOut(opts, renderProfile(profile, statement));
    } else if (wantProfile) {
      note("note: no profile envelope in the result (non-SELECT or unsupported)");
    }
  }

  timeFooter(profile);
  return { ok: true, rows: shown.length, elapsedMs, profile };
}
