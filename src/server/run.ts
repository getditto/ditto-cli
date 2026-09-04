import fs from "node:fs";
import chalk from "chalk";
import { note } from "../cli/groups/dql/run.js";
import { expandTilde } from "../config/paths.js";
import { capRows, classify } from "../query/execute.js";
import { formatForOutFile, renderRows, resolveFormat } from "../render/output.js";
import { type PageOptions, pageIfLong } from "../render/pager.js";
import type { ExecuteResponse, PortalClient } from "./client.js";

/**
 * Run DQL against Ditto Server over HTTP and render with the same pipeline as
 * local execution (table on TTY, JSON when piped, -o export, pager, caps).
 */

export interface ServerRunOptions {
  format?: string;
  maxRows: number;
  maxRowsExplicit: boolean;
  out?: string;
  params?: Record<string, unknown>;
  time?: boolean;
  pager?: boolean;
  /** Per-request timeout override (ms) — DQL legitimately runs long. */
  timeoutMs?: number;
  /** Injectable "stdout is a TTY" for tests. */
  stdoutIsTTY?: boolean;
  /** Injectable pager for tests. */
  page?: (text: string, opts?: PageOptions) => boolean;
}

export interface ServerRunResult {
  ok: boolean;
  rows: number;
  elapsedMs: number;
}

/** Items arrive as plain JSON values; table/csv/etc. need objects. */
export function normalizeItems(items: unknown[]): Record<string, unknown>[] {
  return items.map((item) => {
    if (item === null || item === undefined) return {};
    if (typeof item === "object" && !Array.isArray(item)) return item as Record<string, unknown>;
    return { value: item };
  });
}

/** Print the response's warnings on stderr (never stdout). */
export function printWarnings(res: ExecuteResponse): void {
  for (const w of res.warnings ?? []) {
    // Off-contract warnings may lack `description` — never print "undefined".
    console.error(chalk.yellow(`warning: ${w.description ?? JSON.stringify(w)}`));
  }
  const extra = (res.totalWarningsCount ?? 0) - (res.warnings?.length ?? 0);
  if (extra > 0) console.error(chalk.yellow(`…and ${extra} more warning(s)`));
}

/** Shared tail of every row-producing command: render rows / write -o / page. */
export function emitRows(
  rows: Record<string, unknown>[],
  opts: ServerRunOptions,
  elapsedMs: number,
): { ok: boolean; rows: number } {
  const { rows: shown, truncated, total } = capRows(rows, opts.maxRows);
  const rowsForFile = opts.maxRowsExplicit ? shown : rows;
  const format = opts.out ? formatForOutFile(opts.out, opts.format) : resolveFormat(opts.format);
  if (format === "json") process.env.DITTOSH_JSON_OUT = "1"; // keep the update banner off JSON stdout

  if (opts.out) {
    const prevLevel = chalk.level;
    chalk.level = 0; // files never get ANSI escapes
    let rendered: string;
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
      return { ok: false, rows: 0 };
    }
    const cappedNote =
      opts.maxRowsExplicit && rowsForFile.length < rows.length
        ? ` (first ${rowsForFile.length} of ${rows.length} — --max-rows)`
        : "";
    console.log(
      `Wrote ${rowsForFile.length.toLocaleString()} row${rowsForFile.length === 1 ? "" : "s"} to ${opts.out} (${format})${cappedNote}`,
    );
  } else {
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
  if (opts.time) console.error(chalk.dim(`Time: ${elapsedMs.toFixed(1)} ms`));
  return { ok: true, rows: shown.length };
}

/**
 * Execute one DQL statement via POST /store/execute. A DQL-level error arrives
 * as HTTP 200/400 with `error.description` in the body — ok:false, exit 1.
 */
export async function runServerExecute(
  client: PortalClient,
  statement: string,
  opts: ServerRunOptions & { apiVersion?: "v4" | "v5"; txnId?: number },
): Promise<ServerRunResult> {
  // PortalApiError/PortalConnectionError/PortalTimeoutError propagate — the
  // command layer maps them to exit codes (3 auth/connection, 1 query/API/timeout).
  const started = performance.now();
  const res = await client.execute(statement, opts.params, {
    version: opts.apiVersion,
    txnId: opts.txnId,
    timeoutMs: opts.timeoutMs,
  });
  const elapsedMs = performance.now() - started;

  printWarnings(res);

  // error.description is documented, but treat ANY truthy error object as a failure.
  if (
    res.error &&
    (typeof res.error.description === "string" || Object.keys(res.error).length > 0)
  ) {
    const description =
      typeof res.error.description === "string" ? res.error.description : JSON.stringify(res.error);
    console.error(chalk.red(`Query error: ${description}`));
    console.error(chalk.dim(`  in: ${statement}`));
    return { ok: false, rows: 0, elapsedMs };
  }

  const kind = classify(statement);
  const rows = normalizeItems(res.items ?? []);

  // Mutations/DDL: acknowledge, and report what changed (stderr — stdout is data).
  if (rows.length === 0 && kind !== "select") {
    const mutated = res.mutatedDocumentIds?.length ?? 0;
    if (opts.stdoutIsTTY ?? process.stdout.isTTY) console.log("OK");
    else console.error("OK");
    const bits = [
      res.transactionId !== undefined ? `transactionId ${res.transactionId}` : undefined,
      mutated > 0 ? `${mutated} document${mutated === 1 ? "" : "s"} mutated` : undefined,
    ].filter(Boolean);
    if (bits.length) note(`(${bits.join(" · ")})`);
    if (opts.time) console.error(chalk.dim(`Time: ${elapsedMs.toFixed(1)} ms`));
    return { ok: true, rows: 0, elapsedMs };
  }

  const r = emitRows(rows, opts, elapsedMs);
  if (res.transactionId !== undefined) note(`(transactionId ${res.transactionId})`);
  return { ...r, elapsedMs };
}

/** Remote execute: per-peer sections; rows when there's exactly one peer with rows. */
export async function runServerRemoteExecute(
  client: PortalClient,
  statement: string,
  opts: ServerRunOptions,
): Promise<ServerRunResult> {
  const started = performance.now();
  const res = await client.remoteExecute(statement, opts.params, { timeoutMs: opts.timeoutMs });
  const elapsedMs = performance.now() - started;

  // Same predicate as runServerExecute: ANY non-empty error object is a failure.
  // Loose != covers both undefined and explicit JSON null (serializers emit it).
  const hasError = (e?: { description?: string } | null) =>
    e != null && (typeof e.description === "string" || Object.keys(e).length > 0);

  if (res.error && hasError(res.error)) {
    const description =
      typeof res.error.description === "string" ? res.error.description : JSON.stringify(res.error);
    console.error(chalk.red(`Remote query error: ${description}`));
    return { ok: false, rows: 0, elapsedMs };
  }

  const results = res.result ?? [];
  let failures = 0;
  const perPeer = results.map((r) => {
    if (hasError(r.error)) failures++;
    return {
      peer: r.peer,
      elapsedMilliseconds: r.elapsedMilliseconds,
      ...(hasError(r.error)
        ? {
            error:
              typeof r.error?.description === "string"
                ? r.error.description
                : JSON.stringify(r.error),
          }
        : {}),
      items: r.items ?? [],
      ...(Array.isArray(r.warnings) && r.warnings.length > 0 ? { warnings: r.warnings } : {}),
      ...(r.totalWarningsCount !== undefined ? { totalWarningsCount: r.totalWarningsCount } : {}),
    };
  });

  // Piped/JSON: the full per-peer envelope is the data. TTY: same JSON — peer
  // results don't flatten into one table without lying about provenance.
  process.env.DITTOSH_JSON_OUT = "1"; // always-JSON stdout: keep the update banner off it
  const rendered = JSON.stringify(perPeer, null, 2);
  const page = opts.page ?? pageIfLong;
  if (!page(rendered, { disabled: opts.pager === false })) console.log(rendered);
  if (failures > 0) {
    console.error(chalk.yellow(`${failures} of ${results.length} peer(s) returned an error`));
  }
  if (opts.time) console.error(chalk.dim(`Time: ${elapsedMs.toFixed(1)} ms`));
  return { ok: failures === 0, rows: results.length, elapsedMs };
}
