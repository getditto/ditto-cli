import fs from "node:fs";
import chalk from "chalk";
import type { Command } from "commander";
import { exampleBenchFile } from "../../../bench/example.js";
import {
  type BenchResult,
  resultRows,
  runBenchmark,
  type WarmupSetting,
} from "../../../bench/runner.js";
import {
  type BenchSpec,
  BenchSpecError,
  cleanStatement,
  parseBenchFile,
  selectBenchmarks,
} from "../../../bench/spec.js";
import { expandTilde } from "../../../config/paths.js";
import { DATASETS, getDataset } from "../../../datasets/registry.js";
import type { DittoSession, QueryExecutor } from "../../../ditto/session.js";
import { ParamError, parsePositiveInt } from "../../../query/params.js";
import {
  FormatError,
  formatForOutFile,
  type OutputFormat,
  renderRows,
  resolveFormat,
} from "../../../render/output.js";
import { note, validateOutPath } from "./run.js";

export const MAX_RUNS = 10_000;

export interface BenchDeps {
  openSession: (opts: { dataDir?: string }) => Promise<DittoSession | null>;
}

/** `--runs <n>`: 1..10,000. */
export function parseRuns(raw: string | undefined, fallback: number): number {
  return parsePositiveInt(raw?.replace(/^=/, ""), "--runs", fallback, { max: MAX_RUNS });
}

/**
 * `--warmup [n]`: bare (or `auto`) fills ~250 ms like the benchmark runners;
 * a number is an exact count (0 = none). Undefined when the flag is absent.
 */
export function parseWarmup(raw: string | boolean | undefined): WarmupSetting | undefined {
  if (raw === undefined || raw === false) return undefined;
  if (raw === true) return "auto";
  const v = raw.replace(/^=/, "").trim();
  if (v === "auto") return "auto";
  if (!/^\d+$/.test(v)) {
    throw new ParamError(
      `--warmup takes a number of runs or "auto", got "${raw}". (If that's your statement, put it before --warmup.)`,
    );
  }
  return parsePositiveInt(v, "--warmup", 0, { min: 0, max: MAX_RUNS });
}

export interface BenchOutput {
  format?: string;
  out?: string;
}

/** Validate --format / -o before the store opens (usage beats lock). */
export function resolveBenchOutput(o: BenchOutput): OutputFormat {
  if (o.out) {
    const err = validateOutPath(o.out);
    if (err) throw new ParamError(err);
    return formatForOutFile(o.out, o.format);
  }
  return resolveFormat(o.format);
}

function describeWarmup(w: WarmupSetting): string {
  if (w === "auto") return "warmup to ~250 ms";
  return w === 0 ? "no warmup" : `${w} warmup run${w === 1 ? "" : "s"}`;
}

/** Run benchmarks, print progress (stderr) and the results table (stdout or -o). */
export async function runBenchmarks(
  session: QueryExecutor,
  specs: BenchSpec[],
  opts: { runs: number; warmup: WarmupSetting; format: OutputFormat; out?: string },
): Promise<{ ok: boolean; results: BenchResult[] }> {
  const count = specs.length === 1 ? "1 benchmark" : `${specs.length} benchmarks`;
  note(
    `Benchmarking ${count}: ${opts.runs} timed run${opts.runs === 1 ? "" : "s"} each, ${describeWarmup(opts.warmup)}.`,
  );
  const results: BenchResult[] = [];
  for (const spec of specs) {
    note(`▸ ${spec.name}`);
    const r = await runBenchmark(session, spec, {
      runs: opts.runs,
      warmup: opts.warmup,
      note,
      warn: (m) => console.error(chalk.yellow(`  ⚠ ${m}`)),
    });
    if (r.failure) {
      console.error(chalk.red(`  ${spec.name} failed in ${r.failure.stage}: ${r.failure.error}`));
      console.error(chalk.dim(`    in: ${r.failure.statement}`));
    }
    for (const c of r.cleanupFailures) {
      console.error(chalk.red(`  cleanup failed: ${c.error}`));
      console.error(chalk.dim(`    in: ${c.statement}`));
    }
    results.push(r);
  }

  const rows = resultRows(results, opts.runs);
  if (opts.format === "json") process.env.DITTOSH_JSON_OUT = "1";
  if (opts.out) {
    const prev = chalk.level;
    chalk.level = 0;
    try {
      fs.writeFileSync(expandTilde(opts.out), `${renderRows(rows, opts.format)}\n`, "utf8");
    } catch (err) {
      console.error(chalk.red(`Cannot write ${opts.out}: ${(err as Error).message}`));
      return { ok: false, results };
    } finally {
      chalk.level = prev;
    }
    console.log(
      `Wrote ${rows.length} benchmark result${rows.length === 1 ? "" : "s"} to ${opts.out} (${opts.format})`,
    );
  } else {
    console.log(renderRows(rows, opts.format, { maxWidth: process.stdout.columns }));
  }
  if (opts.runs === 1 && results.some((r) => r.ok)) {
    note("Use --runs <n> to time several runs and see p50/p95/p99.");
  }
  return { ok: results.every((r) => r.ok), results };
}

function collect(value: string, previous: string[] | undefined): string[] {
  return [...(previous ?? []), value];
}

interface BenchCliOptions {
  file?: string;
  only?: string;
  runs?: string;
  warmup?: string | boolean;
  pre?: string[];
  reset?: string[];
  afterEach?: string[];
  post?: string[];
  example?: string;
  dataDir?: string;
  out?: string;
  format?: string;
}

function usage(message: string): void {
  console.error(chalk.red(message));
  process.exitCode = 2;
}

/** `--example <dataset>`: print or save a sample benchmark file. */
function writeExample(name: string, opts: BenchCliOptions): void {
  const suite = getDataset(name.replace(/^=/, ""));
  if (!suite) {
    usage(`Unknown dataset: ${name}. Available: ${DATASETS.map((d) => d.name).join(", ")}`);
    return;
  }
  const text = `${JSON.stringify(exampleBenchFile(suite), null, 2)}\n`;
  const out = opts.out?.replace(/^=/, "");
  if (!out) {
    process.stdout.write(text);
    return;
  }
  const err = validateOutPath(out);
  if (err) {
    usage(err);
    return;
  }
  fs.writeFileSync(expandTilde(out), text, "utf8");
  console.log(`Wrote a sample benchmark file for ${suite.name} to ${out}`);
  note(`Load the data:   dittosh dql dataset load ${suite.name}`);
  note(`Run it:          dittosh dql bench -f ${out} --runs 50 --warmup`);
}

export function registerBenchCommand(dql: ReturnType<Command["command"]>, deps: BenchDeps): void {
  dql
    .command("bench")
    .description("Time DQL statements: warmup, repeated runs, p50/p95/p99")
    .argument("[statement]", "the statement to time (or use -f for a benchmark file)")
    .option("-f, --file <path>", "JSON benchmark file (see --example for a sample)")
    .option("--only <names>", "with -f: run only these benchmarks (comma-separated)")
    .option("--runs <n>", "timed runs per benchmark (default 50)")
    .option("--warmup [n]", "untimed runs before timing; with no number, enough to fill ~250 ms")
    .option("--pre <statement>", "run once before timing, e.g. CREATE INDEX (repeatable)", collect)
    .option(
      "--before-each <statement>",
      "run untimed before every run, e.g. re-insert what a write removes (repeatable)",
    )
    .option("--reset <statement>", "same as --before-each (resetQueries in a file)", collect)
    .option(
      "--after-each <statement>",
      "run untimed after every successful run, e.g. remove what a write added (repeatable)",
      collect,
    )
    .option("--post <statement>", "run once at the end, even after a failure (repeatable)", collect)
    .option(
      "--example <dataset>",
      "print a sample benchmark file for a sample dataset (save it with -o)",
    )
    .option("-d, --data-dir <path>", "override the data directory")
    .option("-o, --out <path>", "write the results to a file (format from extension or --format)")
    .option("--format <format>", "table | json | csv | markdown | html | vertical")
    .addHelpText(
      "after",
      `
Examples:
  dittosh dql bench "SELECT * FROM movies WHERE rated = 'PG'" --runs 100 --warmup
  dittosh dql bench "SELECT * FROM movies WHERE rated = 'PG'" \\
    --pre "CREATE INDEX IF NOT EXISTS movies_rated ON movies (rated)" \\
    --post "DROP INDEX IF EXISTS movies_rated ON movies"
  dittosh dql bench "EVICT FROM movies WHERE _id = 'bench-doc'" \\
    --before-each "INSERT INTO movies VALUES ({'_id': 'bench-doc'})"
  dittosh dql bench "INSERT INTO movies VALUES ({'_id': 'bench-doc'})" \\
    --pre "EVICT FROM movies WHERE _id = 'bench-doc'" \\
    --after-each "EVICT FROM movies WHERE _id = 'bench-doc'"
  dittosh dql bench --example retail -o retail-bench.json
  dittosh dql bench -f retail-bench.json --runs 50 --warmup`,
    )
    .on("option:before-each", function (this: Command, value: string) {
      this.setOptionValue("reset", collect(value, this.getOptionValue("reset")));
    })
    .action(async (statement: string | undefined, opts: BenchCliOptions) => {
      if (opts.example !== undefined) {
        if (statement || opts.file || opts.pre || opts.reset || opts.afterEach || opts.post) {
          usage(
            "--example only writes a sample file; leave out the statement, -f, and --pre/--before-each/--after-each/--post.",
          );
          return;
        }
        writeExample(opts.example, opts);
        return;
      }

      // `--warmup "SELECT …"`: the optional value swallowed the statement.
      if (
        !statement &&
        typeof opts.warmup === "string" &&
        !/^=?\s*(\d+|auto)\s*$/.test(opts.warmup)
      ) {
        statement = opts.warmup;
        opts.warmup = true;
      }
      const file = opts.file?.replace(/^=/, "");
      if (!statement && !file) {
        usage(
          "Give a statement to time, or -f <file>. For a sample file: dittosh dql bench --example <dataset>",
        );
        return;
      }
      if (statement && file) {
        usage("Give either a statement or -f <file>, not both.");
        return;
      }
      if (opts.only && !file) {
        usage("--only picks benchmarks from a file; use it with -f.");
        return;
      }

      let specs: BenchSpec[];
      let runs: number;
      let warmup: WarmupSetting;
      let format: OutputFormat;
      const out = opts.out?.replace(/^=/, "");
      try {
        runs = parseRuns(opts.runs, 50);
        warmup = parseWarmup(opts.warmup) ?? 0;
        format = resolveBenchOutput({ format: opts.format?.replace(/^=/, ""), out });
        const pre = (opts.pre ?? []).map(cleanStatement).filter(Boolean);
        const reset = (opts.reset ?? []).map(cleanStatement).filter(Boolean);
        const afterEach = (opts.afterEach ?? []).map(cleanStatement).filter(Boolean);
        const post = (opts.post ?? []).map(cleanStatement).filter(Boolean);
        if (file) {
          let text: string;
          try {
            text = fs.readFileSync(expandTilde(file), "utf8");
          } catch (err) {
            throw new BenchSpecError(
              `Cannot read ${file}: ${(err as NodeJS.ErrnoException).message}`,
            );
          }
          const names = (opts.only ?? "")
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
          specs = selectBenchmarks(parseBenchFile(text, file), names).map((s) => ({
            ...s,
            preQueries: [...pre, ...s.preQueries],
            resetQueries: [...reset, ...s.resetQueries],
            afterEachQueries: [...s.afterEachQueries, ...afterEach],
            postQueries: [...s.postQueries, ...post],
          }));
        } else {
          const query = cleanStatement(statement!);
          if (!query) throw new BenchSpecError("The statement is empty.");
          const name = query.length > 60 ? `${query.slice(0, 59)}…` : query;
          specs = [
            {
              name,
              query,
              preQueries: pre,
              resetQueries: reset,
              afterEachQueries: afterEach,
              postQueries: post,
            },
          ];
        }
      } catch (err) {
        if (
          err instanceof ParamError ||
          err instanceof FormatError ||
          err instanceof BenchSpecError
        ) {
          usage(err.message);
          return;
        }
        throw err;
      }

      const session = await deps.openSession({ dataDir: opts.dataDir });
      if (!session) return;
      try {
        const { ok } = await runBenchmarks(session, specs, { runs, warmup, format, out });
        if (!ok) process.exitCode = 1;
      } finally {
        await session.close();
      }
    });
}
