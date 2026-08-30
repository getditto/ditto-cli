import chalk from "chalk";
import type { Command } from "commander";
import { DATASETS, getDataset, resolveQuery } from "../../../datasets/registry.js";
import { loadDataset } from "../../../datasets/loader.js";
import type { DatasetSuite } from "../../../datasets/types.js";
import { renderRows, resolveFormat } from "../../../render/output.js";
import { renderTable } from "../../../render/table.js";
import { runStatement } from "./run.js";
import type { DittoSession } from "../../../ditto/session.js";

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

export function registerDatasetCommands(dql: ReturnType<Command["command"]>, deps: DatasetDeps): void {
  const dataset = dql.command("dataset").description("Load and explore built-in sample datasets");

  dataset
    .command("list")
    .description("List available sample datasets")
    .option("--format <format>", "table | json | csv")
    .action((opts: { format?: string }) => {
      const rows = DATASETS.map((d) => ({
        dataset: d.name,
        collections: d.collections.length,
        queries: Object.keys(d.catalog).length,
        default_docs: d.defaultDocs,
        scales_on: d.scalingDimension,
      }));
      console.log(renderRows(rows, resolveFormat(opts.format)));
      console.error(chalk.dim("\n ditto dql dataset show <name> for details · ditto dql dataset load <name> to load"));
    });

  dataset
    .command("show")
    .description("Show a dataset's shape, setup indexes, and query catalog")
    .argument("<name>", "dataset name")
    .action((name: string) => {
      const suite = getDataset(name);
      if (!suite) {
        console.error(chalk.red(`Unknown dataset: ${name}. Available: ${DATASETS.map((d) => d.name).join(", ")}`));
        process.exitCode = 2;
        return;
      }
      console.log(chalk.bold(`${suite.name}`) + ` — ${suite.description}`);
      console.log(`\nScaling: --docs sets ${suite.scalingDimension} (default ${suite.defaultDocs})`);
      console.log(chalk.bold("\nCollections:"));
      for (const c of suite.collections) console.log(`  ${chalk.cyan(c.name)} — ${c.shape}`);
      console.log(chalk.bold("\nSetup indexes (applied with `dataset run --setup` or load-time DDL):"));
      for (const s of suite.setupStatements) console.log(`  ${s}`);
      console.log(chalk.bold("\nQuery catalog:"));
      printQueryCatalog(suite);
      console.error(chalk.dim(`\nRun one with: ditto dql dataset run <query-name> --dataset ${suite.name}`));
    });

  dataset
    .command("load")
    .description("Generate and load a sample dataset into the store")
    .argument("<name>", "dataset name")
    .option("--docs <n>", `documents for the scaling dimension`, undefined)
    .option("--seed <n>", "generator seed (deterministic)", "42")
    .option("--batch-size <n>", "documents per INSERT batch", "500")
    .option("-d, --data-dir <path>", "override the data directory")
    .action(async (name: string, opts: { docs?: string; seed: string; batchSize: string; dataDir?: string }) => {
      const suite = getDataset(name);
      if (!suite) {
        console.error(chalk.red(`Unknown dataset: ${name}. Available: ${DATASETS.map((d) => d.name).join(", ")}`));
        process.exitCode = 2;
        return;
      }
      const docs = opts.docs ? Number.parseInt(opts.docs, 10) : suite.defaultDocs;
      if (!Number.isFinite(docs) || docs < 1) {
        console.error(chalk.red(`--docs must be a positive integer, got "${opts.docs}"`));
        process.exitCode = 2;
        return;
      }
      const seed = Number.parseInt(opts.seed, 10);

      const session = await deps.openSession({ dataDir: opts.dataDir });
      if (!session) return;
      try {
        const started = performance.now();
        console.error(chalk.dim(`Loading ${name} (${docs} ${suite.scalingDimension}, seed ${seed})…`));
        const result = await loadDataset(session, suite, {
          docs,
          seed,
          batchSize: Number.parseInt(opts.batchSize, 10),
          onProgress: (collection, inserted, total) => {
            console.error(chalk.dim(`  ${collection}: ${inserted}/${total}`));
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
    });

  dataset
    .command("run")
    .description("Run a query from a dataset's catalog by name")
    .argument("<query-name>", "catalog query name, e.g. stores__select__by_location_city")
    .option("--dataset <name>", "restrict lookup to one dataset")
    .option("--setup", "run the query's index DDL (preQueries) first", false)
    .option("-y, --yes", "confirm write-category queries without prompting", false)
    .option("-d, --data-dir <path>", "override the data directory")
    .option("--format <format>", "table | json | csv")
    .option("--max-rows <n>", "maximum rows to display", "10000")
    .action(async (queryName: string, opts: { dataset?: string; setup: boolean; yes: boolean; dataDir?: string; format?: string; maxRows: string }) => {
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
        console.error(chalk.red(`Unknown query: ${queryName}${hint}. See: ditto dql dataset show <name>`));
        process.exitCode = 2;
        return;
      }
      const { dataset: suite, entry } = resolved;

      if (WRITE_CATEGORIES.has(entry.category) && !opts.yes) {
        console.error(
          chalk.red(`"${queryName}" is a ${entry.category} query and mutates the store. Re-run with --yes to confirm.`),
        );
        console.error(chalk.dim(`  statement: ${entry.query}`));
        process.exitCode = 2;
        return;
      }

      console.error(chalk.dim(`Running ${chalk.bold(queryName)} (${suite.name}):`));
      console.error(chalk.cyan(`  ${entry.query}`));

      const session = await deps.openSession({ dataDir: opts.dataDir });
      if (!session) return;
      try {
        const base = {
          format: opts.format,
          maxRows: Number.parseInt(opts.maxRows, 10),
          maxRowsExplicit: opts.maxRows !== "10000",
          suppressNoLimitWarning: true,
        };
        if (opts.setup && entry.preQueries?.length) {
          for (const ddl of entry.preQueries) {
            console.error(chalk.dim(`  setup: ${ddl}`));
            const r = await runStatement(session, ddl, base);
            if (!r.ok) {
              process.exitCode = 1;
              return;
            }
          }
        }
        for (const reset of entry.resetQueries ?? []) {
          const r = await runStatement(session, reset, base);
          if (!r.ok) {
            process.exitCode = 1;
            return;
          }
        }
        const r = await runStatement(session, entry.query, base);
        if (!r.ok) {
          if (entry.negative) console.error(chalk.dim("(this query is expected to fail — negative test case)"));
          process.exitCode = 1;
          return;
        }
        console.error(chalk.dim(`(${r.elapsedMs.toFixed(1)} ms)`));
        for (const post of entry.postQueries ?? []) {
          await runStatement(session, post, { ...base, format: "json" });
        }
      } finally {
        await session.close();
      }
    });

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
        console.error(chalk.red(`This evicts all documents in: ${suite.collections.map((c) => c.name).join(", ")}. Re-run with --yes to confirm.`));
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
        console.log(`Reset ${suite.name}: evicted all documents from ${suite.collections.length} collections.`);
      } finally {
        await session.close();
      }
    });
}
