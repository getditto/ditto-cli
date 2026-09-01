import chalk from "chalk";
import type { Command } from "commander";
import { loadDataset } from "../../../datasets/loader.js";
import { DATASETS, getDataset, resolveQuery } from "../../../datasets/registry.js";
import type { DatasetSuite } from "../../../datasets/types.js";
import type { DittoSession } from "../../../ditto/session.js";
import { ParamError, parsePositiveInt } from "../../../query/params.js";
import { FormatError, renderRows, resolveFormat } from "../../../render/output.js";
import { renderTable } from "../../../render/table.js";
import { note, runStatement, validateOutPath } from "./run.js";

const WRITE_CATEGORIES = new Set(["INSERT", "UPDATE", "DELETE", "EVICT", "UPSERT"]);

export interface DatasetDeps {
  /** Opens a session (injected so tests can mock the SDK boundary). */
  openSession: (opts: { dataDir?: string }) => Promise<DittoSession | null>;
}

function printQueryCatalog(suite: DatasetSuite): void {
  const byCat = new Map<string, string[]>();
  for (const [name, entry] of Object.entries(suite.catalog)) {
    if (!byCat.has(entry.category)) byCat.set(entry.category, []);
    byCat.get(entry.category)!.push(name);
  }
  for (const [category, names] of byCat) {
    console.log(`  ${chalk.bold(category)} (${names.length})`);
    for (const n of names) console.log(`    ${n}`);
  }
}

export function registerDatasetCommands(
  dql: ReturnType<Command["command"]>,
  deps: DatasetDeps,
): void {
  const dataset = dql.command("dataset").description("Load and explore built-in sample datasets");

  dataset
    .command("list")
    .description("List available sample datasets")
    .option("--format <format>", "table | json | csv")
    .option("-d, --data-dir <path>", "accepted for symmetry (no store is opened)")
    .action((opts: { format?: string; dataDir?: string }) => {
      let format: ReturnType<typeof resolveFormat>;
      try {
        format = resolveFormat(opts.format);
      } catch (err) {
        if (err instanceof FormatError) {
          console.error(chalk.red(err.message));
          process.exitCode = err.exitCode;
          return;
        }
        throw err;
      }
      const rows = DATASETS.map((d) => ({
        dataset: d.name,
        collections: d.collections.length,
        queries: Object.keys(d.catalog).length,
        default_docs: d.defaultDocs,
        scales_on: d.scalingDimension,
      }));
      console.log(renderRows(rows, format));
      note("\n ditto dql dataset show <name> for details · ditto dql dataset load <name> to load");
    });

  dataset
    .command("show")
    .description("Show a dataset's shape, setup indexes, and query catalog")
    .argument("<name>", "dataset name")
    .option("-d, --data-dir <path>", "accepted for symmetry (no store is opened)")
    .action((name: string) => {
      const suite = getDataset(name);
      if (!suite) {
        console.error(
          chalk.red(
            `Unknown dataset: ${name}. Available: ${DATASETS.map((d) => d.name).join(", ")}`,
          ),
        );
        process.exitCode = 2;
        return;
      }
      console.log(`${chalk.bold(suite.name)} — ${suite.description}`);
      console.log(
        `\nScaling: --docs sets ${suite.scalingDimension} (default ${suite.defaultDocs})`,
      );
      console.log(chalk.bold("\nCollections:"));
      for (const c of suite.collections) console.log(`  ${chalk.cyan(c.name)} — ${c.shape}`);
      // Setup indexes are derived from the actual catalog's preQueries (single
      // source of truth) — the old static list drifted from it.
      const setupDdl = new Set<string>();
      for (const entry of Object.values(suite.catalog)) {
        for (const q of entry.preQueries ?? []) {
          if (q.startsWith("CREATE INDEX")) setupDdl.add(q);
        }
      }
      console.log(chalk.bold("\nSetup indexes (applied per query with `dataset run --setup`):"));
      for (const s of setupDdl) console.log(`  ${s}`);
      const issues = suite.knownIssues;
      if (issues && Object.keys(issues).length > 0) {
        console.log(chalk.bold(chalk.yellow("\nKnown issues:")));
        for (const [q, text] of Object.entries(issues)) console.log(`  ${q} — ${text}`);
      }
      console.log(chalk.bold("\nQuery catalog:"));
      printQueryCatalog(suite);
      note(`\nRun one with: ditto dql dataset run <query-name> --dataset ${suite.name}`);
    });

  dataset
    .command("load")
    .description("Generate and load a sample dataset into the store")
    .argument("<name>", "dataset name")
    .option("--docs <n>", `documents for the scaling dimension`, undefined)
    .option("--seed <n>", "generator seed (deterministic)", "42")
    .option("--batch-size <n>", "documents per INSERT batch", "500")
    .option("-d, --data-dir <path>", "override the data directory")
    .action(
      async (
        name: string,
        opts: { docs?: string; seed: string; batchSize: string; dataDir?: string },
      ) => {
        const suite = getDataset(name);
        if (!suite) {
          console.error(
            chalk.red(
              `Unknown dataset: ${name}. Available: ${DATASETS.map((d) => d.name).join(", ")}`,
            ),
          );
          process.exitCode = 2;
          return;
        }
        let docs: number;
        let seed: number;
        let batchSize: number;
        try {
          docs = parsePositiveInt(opts.docs, "--docs", suite.defaultDocs, { max: 1_000_000 });
          seed = parsePositiveInt(opts.seed, "--seed", 42, { min: 0, max: 4_294_967_295 });
          batchSize = parsePositiveInt(opts.batchSize, "--batch-size", 500);
        } catch (err) {
          if (err instanceof ParamError) {
            console.error(chalk.red(err.message));
            process.exitCode = err.exitCode;
            return;
          }
          throw err;
        }

        const session = await deps.openSession({ dataDir: opts.dataDir });
        if (!session) return;
        try {
          const started = performance.now();
          note(`Loading ${name} (${docs} ${suite.scalingDimension}, seed ${seed})…`);
          const result = await loadDataset(session, suite, {
            docs,
            seed,
            batchSize,
            onProgress: (collection, inserted, total) => {
              note(`  ${collection}: ${inserted}/${total}`);
            },
          });
          const elapsed = ((performance.now() - started) / 1000).toFixed(1);
          console.log(
            `Loaded ${result.totalDocs} documents into ${Object.keys(result.collections).length} collections (${elapsed}s):`,
          );
          console.log(renderTable([{ dataset: suite.name, ...result.collections }]));
        } finally {
          await session.close();
        }
      },
    );

  dataset
    .command("run")
    .description("Run a query from a dataset's catalog by name")
    .argument("<query-name>", "catalog query name, e.g. stores__select__by_location_city")
    .option("--dataset <name>", "restrict lookup to one dataset")
    .option("--setup", "run the query's index DDL (preQueries) first", false)
    .option("-y, --yes", "confirm write-category queries without prompting", false)
    .option("-d, --data-dir <path>", "override the data directory")
    .option("-o, --out <path>", "write results to a file (format from extension or --format)")
    .option("--format <format>", "table | json | csv")
    .option("--max-rows <n>", "maximum rows to display", "10000")
    .option("--time", "print timing after the results", false)
    .option("--explain", "run EXPLAIN on the query and print the plan", false)
    .option("--profile", "run PROFILE on the query and print the execution profile", false)
    .action(
      async (
        queryName: string,
        opts: {
          dataset?: string;
          setup: boolean;
          yes: boolean;
          dataDir?: string;
          out?: string;
          format?: string;
          maxRows: string;
          time?: boolean;
          explain?: boolean;
          profile?: boolean;
        },
        command: Command,
      ) => {
        // Commander keeps "=" in short-option inline values (-o=/tmp/x → "=/tmp/x") — strip it.
        opts = {
          ...opts,
          out: opts.out?.replace(/^=/, ""),
          dataset: opts.dataset?.replace(/^=/, ""),
          format: opts.format?.replace(/^=/, ""),
          maxRows: opts.maxRows.replace(/^=/, ""),
        };
        let resolved: ReturnType<typeof resolveQuery>;
        try {
          resolved = resolveQuery(queryName, opts.dataset);
        } catch (err) {
          console.error(chalk.red(err instanceof Error ? err.message : String(err)));
          process.exitCode = 2;
          return;
        }
        if (!resolved) {
          const hint = opts.dataset ? ` in dataset "${opts.dataset}"` : "";
          console.error(
            chalk.red(`Unknown query: ${queryName}${hint}. See: ditto dql dataset show <name>`),
          );
          process.exitCode = 2;
          return;
        }
        const { dataset: suite, entry } = resolved;

        if (WRITE_CATEGORIES.has(entry.category) && !opts.yes) {
          console.error(
            chalk.red(
              `"${queryName}" is a ${entry.category} query and mutates the store. Re-run with --yes to confirm.`,
            ),
          );
          console.error(chalk.dim(`  statement: ${entry.query}`));
          process.exitCode = 2;
          return;
        }

        // Validate usage flags before the banner or the store (usage beats lock).
        let base: import("./run.js").RunOptions;
        try {
          if (opts.out && WRITE_CATEGORIES.has(entry.category)) {
            throw new ParamError("-o/--out only applies to row-producing (read) catalog queries");
          }
          base = {
            format: opts.format === undefined ? undefined : resolveFormat(opts.format),
            maxRows: parsePositiveInt(opts.maxRows, "--max-rows", 10_000),
            maxRowsExplicit: command.getOptionValueSource("maxRows") === "cli",
            out: opts.out,
            suppressNoLimitWarning: true,
            time: opts.time,
            explain: opts.explain,
            profile: opts.profile,
          };
        } catch (err) {
          if (err instanceof ParamError || err instanceof FormatError) {
            console.error(chalk.red(err.message));
            process.exitCode = err.exitCode;
            return;
          }
          throw err;
        }

        // -o target validation too (usage beats lock; same behavior as exec).
        if (opts.out) {
          const outError = validateOutPath(opts.out);
          if (outError) {
            console.error(chalk.red(outError));
            process.exitCode = 2;
            return;
          }
        }

        note(`Running ${chalk.bold(queryName)} (${suite.name}):`);
        note(chalk.cyan(`  ${entry.query}`));
        // Known-issue warnings (e.g. SDK hangs) are the ONLY mitigation — never silenced by --quiet.
        const knownIssue = suite.knownIssues?.[queryName];
        if (knownIssue) console.error(chalk.yellow(`  ⚠ known issue: ${knownIssue}`));

        const session = await deps.openSession({ dataDir: opts.dataDir });
        if (!session) return;
        const isWrite = WRITE_CATEGORIES.has(entry.category);
        try {
          // Write-category entries carry their fixture INSERTs in preQueries and
          // per-iteration reseeds in resetQueries — they must ALWAYS run, or the
          // mutation silently no-ops. Read entries: preQueries (index DDL) only
          // with --setup; postQueries (index teardown) never (we keep indexes).
          const pre = isWrite
            ? (entry.preQueries ?? [])
            : opts.setup
              ? (entry.preQueries ?? [])
              : [];
          // Write entries clean up their fixtures even when pre/reset/query fail.
          let mainOk = false;
          let cleanupFailed = false;
          // Fixture/cleanup statements never carry the user's diagnostics flags
          // (no 3× "only SELECT statements are profilable" notes, no -o writes).
          const clean = {
            ...base,
            profile: undefined,
            explain: undefined,
            time: undefined,
            format: "json" as const,
            out: undefined,
          };
          try {
            for (const ddl of pre) {
              if (opts.setup || isWrite) note(`  setup: ${ddl}`);
              const r = await runStatement(session, ddl, clean);
              if (!r.ok) {
                process.exitCode = 1;
                return;
              }
            }
            for (const reset of entry.resetQueries ?? []) {
              const r = await runStatement(session, reset, clean);
              if (!r.ok) {
                process.exitCode = 1;
                return;
              }
            }
            const r = await runStatement(session, entry.query, base);
            if (!r.ok) {
              if (entry.negative)
                console.error(chalk.dim("(this query is expected to fail — negative test case)"));
              process.exitCode = 1;
              return;
            }
            mainOk = true;
            if (!opts.time) note(`(${r.elapsedMs.toFixed(1)} ms)`);
          } finally {
            if (isWrite) {
              for (const post of entry.postQueries ?? []) {
                const pr = await runStatement(session, post, clean);
                if (!pr.ok) {
                  console.error(chalk.red(`cleanup failed: ${post}`));
                  cleanupFailed = true;
                }
              }
            }
          }
          if (cleanupFailed || !mainOk) process.exitCode = 1;
        } finally {
          await session.close();
        }
      },
    );

  dataset
    .command("reset")
    .description("EVICT all documents belonging to a dataset's collections")
    .argument("<name>", "dataset name")
    .option("-y, --yes", "confirm without prompting", false)
    .option("-d, --data-dir <path>", "override the data directory")
    .action(async (name: string, opts: { yes: boolean; dataDir?: string }) => {
      const suite = getDataset(name);
      if (!suite) {
        console.error(chalk.red(`Unknown dataset: ${name}.`));
        process.exitCode = 2;
        return;
      }
      if (!opts.yes) {
        console.error(
          chalk.red(
            `This evicts all documents in: ${suite.collections.map((c) => c.name).join(", ")}. Re-run with --yes to confirm.`,
          ),
        );
        process.exitCode = 2;
        return;
      }
      const session = await deps.openSession({ dataDir: opts.dataDir });
      if (!session) return;
      try {
        for (const c of suite.collections) {
          const r = await runStatement(session, `EVICT FROM ${c.name} WHERE true`, {
            maxRows: 10_000,
            maxRowsExplicit: false,
            suppressNoLimitWarning: true,
          });
          if (!r.ok) {
            process.exitCode = 1;
            return;
          }
        }
        console.log(
          `Reset ${suite.name}: evicted all documents from ${suite.collections.length} collections.`,
        );
      } finally {
        await session.close();
      }
    });
}
