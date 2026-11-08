import type { QueryExecutor } from "../ditto/session.js";
import { classify } from "../query/execute.js";
import type { BenchSpec } from "./spec.js";
import { computeStats, decideWarmup, type Stats } from "./stats.js";

/** Warmup iterations: a fixed count (0 = none), or "auto" to fill ~250 ms. */
export type WarmupSetting = number | "auto";

export interface BenchOptions {
  runs: number;
  warmup: WarmupSetting;
  /** Progress notes (stderr, quiet-able). */
  note?: (message: string) => void;
  /** Warnings that change how to read the numbers (stderr, always shown). */
  warn?: (message: string) => void;
  /** Clock in ms (injectable for tests). */
  now?: () => number;
}

export type BenchStage = "pre" | "warmup" | "reset" | "query" | "post";

export interface BenchResult {
  name: string;
  ok: boolean;
  /** Where it failed, and the statement and error that stopped it. */
  failure?: { stage: BenchStage; statement: string; error: string };
  /** postQueries that failed (the store may not be back to its starting state). */
  cleanupFailures: { statement: string; error: string }[];
  /** Completed timed runs and warmup iterations. */
  runs: number;
  warmup: number;
  /** Rows returned by the last timed run. */
  rows: number;
  /** Timed run durations, in ms. */
  samples: number[];
  stats?: Stats;
}

class StageError extends Error {
  constructor(
    readonly stage: BenchStage,
    readonly statement: string,
    cause: unknown,
  ) {
    const e = cause as { message?: string; code?: string };
    super(`${e.code ? `[${e.code}] ` : ""}${e.message ?? String(cause)}`);
  }
}

async function exec(session: QueryExecutor, stage: BenchStage, statement: string) {
  try {
    return await session.execute(statement);
  } catch (err) {
    throw new StageError(stage, statement, err);
  }
}

/**
 * Time one benchmark, following the dql-metrics-benchmark runner:
 *   preQueries once → warmup (untimed) → `runs` timed executions → postQueries.
 * resetQueries run untimed before every warmup and timed execution, so a
 * write measures a real mutation each time. postQueries always run, even
 * after a failure, so indexes and fixtures don't leak into the next run.
 */
export async function runBenchmark(
  session: QueryExecutor,
  spec: BenchSpec,
  opts: BenchOptions,
): Promise<BenchResult> {
  const now = opts.now ?? (() => performance.now());
  const result: BenchResult = {
    name: spec.name,
    ok: false,
    cleanupFailures: [],
    runs: 0,
    warmup: 0,
    rows: 0,
    samples: [],
  };

  const executions = opts.runs + (opts.warmup === "auto" ? 1 : opts.warmup);
  if (classify(spec.query) === "mutation" && spec.resetQueries.length === 0 && executions > 1) {
    opts.warn?.(
      `${spec.name}: this write has no resetQueries, so runs after the first may change nothing (or fail). Put the data back before each run with resetQueries (--before-each on the command line).`,
    );
  }

  const reset = async () => {
    for (const s of spec.resetQueries) await exec(session, "reset", s);
  };
  const timed = async (stage: BenchStage) => {
    await reset();
    const started = now();
    const r = await exec(session, stage, spec.query);
    return { ms: now() - started, rows: r.items.length };
  };

  try {
    for (const s of spec.preQueries) await exec(session, "pre", s);

    if (opts.warmup === "auto") {
      const pilot = await timed("warmup");
      result.warmup = 1;
      const target = decideWarmup(pilot.ms);
      while (result.warmup < target) {
        await timed("warmup");
        result.warmup++;
      }
    } else {
      while (result.warmup < opts.warmup) {
        await timed("warmup");
        result.warmup++;
      }
    }
    if (result.warmup > 0) opts.note?.(`  ${spec.name}: ${result.warmup} warmup runs`);

    for (let i = 0; i < opts.runs; i++) {
      const r = await timed("query");
      result.samples.push(r.ms);
      result.rows = r.rows;
      result.runs++;
    }
    result.ok = true;
  } catch (err) {
    if (!(err instanceof StageError)) throw err;
    result.failure = { stage: err.stage, statement: err.statement, error: err.message };
  } finally {
    for (const s of spec.postQueries) {
      try {
        await session.execute(s);
      } catch (err) {
        result.cleanupFailures.push({ statement: s, error: (err as Error).message ?? String(err) });
      }
    }
  }
  if (result.cleanupFailures.length > 0) result.ok = false;
  if (result.samples.length > 0) result.stats = computeStats(result.samples);
  return result;
}

const ms = (n: number) => Number(n.toFixed(3));

/**
 * Result rows for rendering (table, JSON, CSV…). One timed run per benchmark
 * shows just its time; more runs show the distribution.
 */
export function resultRows(results: BenchResult[]): Record<string, unknown>[] {
  const anyFailed = results.some((r) => !r.ok);
  const distribution = results.some((r) => r.runs > 1);
  return results.map((r) => {
    const row: Record<string, unknown> = { benchmark: r.name };
    if (anyFailed) {
      row.status = r.failure
        ? `failed (${r.failure.stage})`
        : r.cleanupFailures.length > 0
          ? "cleanup failed"
          : "ok";
    }
    const s = r.stats;
    if (!distribution) {
      row.rows = r.rows;
      row.time_ms = s ? ms(s.mean) : null;
      return row;
    }
    Object.assign(row, {
      runs: r.runs,
      warmup: r.warmup,
      rows: r.rows,
      mean_ms: s ? ms(s.mean) : null,
      p50_ms: s ? ms(s.p50) : null,
      p95_ms: s ? ms(s.p95) : null,
      p99_ms: s ? ms(s.p99) : null,
      min_ms: s ? ms(s.min) : null,
      max_ms: s ? ms(s.max) : null,
      stddev_ms: s ? ms(s.stdDev) : null,
    });
    return row;
  });
}
