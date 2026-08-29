import fs from "node:fs";
import chalk from "chalk";
import type { Command } from "commander";
import { resolveDataDir } from "../../../config/paths.js";
import { IdentityError, loadIdentity } from "../../../identity/token.js";
import { DittoSession, LockError } from "../../../ditto/session.js";
import { ParamError, parseParams } from "../../../query/params.js";
import { splitStatements } from "../../../query/split.js";
import { runBatch } from "./batch.js";
import { collectDoctorChecks } from "./doctor.js";
import { startRepl } from "./repl.js";
import { runStatement } from "./run.js";

interface ExecOpts {
  dataDir?: string;
  format?: string;
  maxRows: string;
  out?: string;
  file?: string;
  param?: string[];
  args?: string;
  continueOnError?: boolean;
}

async function openSession(opts: ExecOpts): Promise<DittoSession | null> {
  try {
    return await DittoSession.open(loadIdentity(), resolveDataDir(opts.dataDir));
  } catch (err) {
    if (err instanceof LockError || err instanceof IdentityError) {
      console.error(chalk.red(err.message));
      process.exitCode = err.exitCode;
      return null;
    }
    throw err;
  }
}

function execRunOpts(opts: ExecOpts) {
  return {
    format: opts.format,
    maxRows: Number.parseInt(opts.maxRows, 10),
    maxRowsExplicit: opts.maxRows !== "10000",
    out: opts.out,
    params: parseParams(opts.param, opts.args),
  };
}

/** Run statements from a file or piped stdin; maps failures to exit codes. */
async function batchFromText(session: DittoSession, source: string, text: string, opts: ExecOpts): Promise<void> {
  const statements = splitStatements(text);
  if (statements.length === 0) {
    console.error(`No statements in ${source}.`);
    process.exitCode = 2;
    return;
  }
  const { failed } = await runBatch(session, statements, {
    ...execRunOpts(opts),
    continueOnError: opts.continueOnError,
  });
  if (failed > 0) process.exitCode = 1;
}

export function registerDqlGroup(dql: ReturnType<Command["command"]>): void {
  dql.description("Run DQL statements against a local Ditto store");

  dql
    .command("doctor")
    .description("Check platform, SDK, token, and data directory health")
    .option("-d, --data-dir <path>", "override the data directory")
    .action(async (opts: { dataDir?: string }) => {
      const checks = await collectDoctorChecks(opts);
      for (const c of checks) {
        console.log(`${c.ok ? chalk.green("✓") : chalk.red("✗")} ${c.label} — ${c.detail}`);
      }
      const failures = checks.filter((c) => !c.ok).length;
      process.exitCode = failures > 0 ? 3 : 0;
    });

  dql
    .command("collections")
    .description("List collections (system:collections)")
    .option("-d, --data-dir <path>", "override the data directory")
    .action(async (opts: ExecOpts) => {
      const session = await openSession(opts);
      if (!session) return;
      try {
        await runStatement(session, "SELECT * FROM system:collections", {
          maxRows: 10_000,
          maxRowsExplicit: false,
        });
      } finally {
        await session.close();
      }
    });

  dql
    .command("indexes")
    .description("List indexes (system:indexes), optionally for one collection")
    .argument("[collection]", "collection name")
    .option("-d, --data-dir <path>", "override the data directory")
    .action(async (collection: string | undefined, opts: ExecOpts) => {
      const session = await openSession(opts);
      if (!session) return;
      try {
        await runStatement(
          session,
          collection
            ? "SELECT * FROM system:indexes WHERE collection = :collection"
            : "SELECT * FROM system:indexes",
          {
            maxRows: 10_000,
            maxRowsExplicit: false,
            params: collection ? { collection } : undefined,
          },
        );
      } finally {
        await session.close();
      }
    });

  // Default action: one-shot / -f file / piped stdin / REPL
  dql
    .argument("[statement]", "DQL statement to run")
    .option("-f, --file <path>", "run statements from a file")
    .option("-p, --param <name=value...>", "bind :name parameters (values JSON-parsed, string fallback)")
    .option("--args <json>", "bind parameters from a JSON object")
    .option("-d, --data-dir <path>", "override the data directory")
    .option("-o, --out <path>", "write results to a file (format from extension or --format)")
    .option("--format <format>", "table | json | csv")
    .option("--max-rows <n>", "maximum rows to display", "10000")
    .option("--continue-on-error", "keep running statements after a failure (-f/stdin)", false)
    .action(async (statement: string | undefined, opts: ExecOpts) => {
      let params: ReturnType<typeof parseParams>;
      try {
        params = parseParams(opts.param, opts.args);
      } catch (err) {
        if (err instanceof ParamError) {
          console.error(chalk.red(err.message));
          process.exitCode = err.exitCode;
          return;
        }
        throw err;
      }

      const stdinPiped = !process.stdin.isTTY;

      // REPL: no statement, no file, interactive terminal
      if (!statement && !opts.file && !stdinPiped) {
        if (!process.stdout.isTTY) {
          console.error('No statement given. Usage: ditto dql "SELECT ..." (see --help)');
          process.exitCode = 2;
          return;
        }
        const session = await openSession(opts);
        if (!session) return;
        try {
          await startRepl(session);
        } finally {
          await session.close();
        }
        return;
      }

      const session = await openSession(opts);
      if (!session) return;
      try {
        if (opts.file) {
          let text: string;
          try {
            text = fs.readFileSync(opts.file, "utf8");
          } catch {
            console.error(chalk.red(`Cannot read file: ${opts.file}`));
            process.exitCode = 2;
            return;
          }
          await batchFromText(session, opts.file, text, opts);
          return;
        }
        if (!statement) {
          // piped stdin
          const chunks: Buffer[] = [];
          for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
          await batchFromText(session, "stdin", Buffer.concat(chunks).toString("utf8"), opts);
          return;
        }
        // one-shot
        const r = await runStatement(session, statement, { ...execRunOpts(opts), params });
        if (!r.ok) process.exitCode = 1;
      } finally {
        await session.close();
      }
    });
}
