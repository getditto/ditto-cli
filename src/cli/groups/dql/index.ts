import fs from "node:fs";
import chalk from "chalk";
import type { Command } from "commander";
import { expandTilde, isBogusDataDir, resolveDataDir } from "../../../config/paths.js";
import {
  DataDirError,
  DittoSession,
  LockError,
  PlatformError,
  TokenError,
} from "../../../ditto/session.js";
import { daysUntilExpiry, IdentityError, loadIdentity } from "../../../identity/token.js";
import { classify } from "../../../query/execute.js";
import {
  ParamError,
  parseParams,
  parsePositiveInt,
  resolveArgsSource,
} from "../../../query/params.js";
import { isBlankOrComments, splitComplete, splitStatements } from "../../../query/split.js";
import { FormatError, resolveFormat } from "../../../render/output.js";
import { runBatch, stripDotCommandLines } from "./batch.js";
import { registerDatasetCommands } from "./dataset.js";
import { deleteStore } from "./delete-store.js";
import { collectDoctorChecks } from "./doctor.js";
import { ImportError, importDocuments, isValidCollectionName, parseImportFile } from "./import.js";
import { startRepl } from "./repl.js";
import { note, runStatement, validateOutPath } from "./run.js";

interface ExecOpts {
  dataDir?: string;
  format?: string;
  maxRows?: string;
  out?: string;
  file?: string;
  param?: string[];
  args?: string;
  continueOnError?: boolean;
  pager?: boolean;
  time?: boolean;
  explain?: boolean;
  profile?: boolean;
  advise?: boolean;
  apply?: boolean;
  yes?: boolean;
  execute?: string;
}

/** days until expiry at which the user gets a heads-up on every run. */
const EXPIRY_NAG_DAYS = 14;

async function openSession(opts: ExecOpts): Promise<DittoSession | null> {
  // Bogus data-dir values (commander artifacts like `-d --`) fail fast for
  // EVERY store-opening command. Mirror resolveDataDir's fallthrough: an
  // empty/whitespace flag means the env var wins — check the EFFECTIVE value.
  const rawDir = opts.dataDir?.trim() ? opts.dataDir : process.env.DITTOSH_DATA_DIR;
  if (isBogusDataDir(rawDir)) {
    console.error(chalk.red("-d/--data-dir requires a directory path"));
    process.exitCode = 2;
    return null;
  }
  try {
    const identity = loadIdentity();
    // Expiry UX is for the embedded release token (spec §6); dev tokens from
    // .env may carry stale EXPIRE_ON dates the SDK accepts — never block on those.
    if (identity.source === "embedded") {
      const days = daysUntilExpiry(identity.expiresOn);
      if (days !== null && days < 0) {
        console.error(
          chalk.red(
            `The embedded license token expired on ${identity.expiresOn}.\nUpdate the CLI: dittosh update (or brew upgrade dittosh / npm i -g @dittolive/cli@latest).`,
          ),
        );
        process.exitCode = 3;
        return null;
      }
      if (days !== null && days < EXPIRY_NAG_DAYS) {
        console.error(
          chalk.yellow(
            `note: the embedded license token expires ${identity.expiresOn} (${days}d left) — update soon: dittosh update`,
          ),
        );
      }
    }
    return await DittoSession.open(identity, resolveDataDir(opts.dataDir));
  } catch (err) {
    if (
      err instanceof LockError ||
      err instanceof IdentityError ||
      err instanceof TokenError ||
      err instanceof DataDirError ||
      err instanceof PlatformError
    ) {
      console.error(chalk.red(err.message));
      process.exitCode = err.exitCode;
      return null;
    }
    throw err;
  }
}

/** Validate --format / --max-rows and compute run options; usage errors throw ParamError/FormatError (exit 2). */
function execRunOpts(opts: ExecOpts, maxRowsExplicit: boolean) {
  const format = opts.format === undefined ? undefined : resolveFormat(opts.format); // throws on bad value
  return {
    format,
    maxRows: parsePositiveInt(opts.maxRows, "--max-rows", 10_000),
    maxRowsExplicit,
    out: opts.out,
    params: parseParams(opts.param, opts.args),
    pager: opts.pager,
    time: opts.time,
    explain: opts.explain,
    profile: opts.profile,
    advise: opts.advise,
    apply: opts.apply,
    yes: opts.yes,
  };
}

/** Commander collector for repeatable -p/--param (non-variadic — a variadic would swallow the positional statement). */
function collectParam(value: string, previous: string[]): string[] {
  return [...previous, value];
}

/** Fully consume stdin as text (statement batches, `--args -`). */
async function readStdinText(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/** Run statements from a file or piped stdin (validation already done by the caller). */
/** Run a batch of statements (validation + dot-command stripping already done by the caller). */
async function batchFromText(
  session: DittoSession,
  text: string,
  runOpts: ReturnType<typeof execRunOpts>,
  continueOnError?: boolean,
): Promise<void> {
  const { failed } = await runBatch(session, splitStatements(text), {
    ...runOpts,
    continueOnError,
  });
  if (failed > 0) process.exitCode = 1;
}

export function registerDqlGroup(dql: ReturnType<Command["command"]>): void {
  dql.description("Run DQL statements against a local Ditto store");

  registerDatasetCommands(dql, { openSession });

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
      // Spec: lock failures are their own exit code (4), everything else 3.
      const lockFailed = checks.some((c) => c.label === "lock" && !c.ok);
      process.exitCode = failures === 0 ? 0 : lockFailed ? 4 : 3;
    });

  dql
    .command("collections")
    .description("List collections (system:collections)")
    .option("-d, --data-dir <path>", "override the data directory")
    .action(async (opts: ExecOpts) => {
      const session = await openSession(opts);
      if (!session) return;
      try {
        const r = await runStatement(session, "SELECT * FROM system:collections", {
          maxRows: 10_000,
          maxRowsExplicit: false,
          suppressNoLimitWarning: true,
        });
        if (!r.ok) process.exitCode = 1;
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
        const r = await runStatement(
          session,
          collection
            ? "SELECT * FROM system:indexes WHERE collection = :collection"
            : "SELECT * FROM system:indexes",
          {
            maxRows: 10_000,
            maxRowsExplicit: false,
            params: collection ? { collection } : undefined,
            suppressNoLimitWarning: true,
          },
        );
        if (!r.ok) process.exitCode = 1;
      } finally {
        await session.close();
      }
    });

  dql
    .command("delete-store")
    .description("Permanently delete the local store — all collections, indexes, and files")
    .option("-y, --yes", "confirm without prompting", false)
    .option("-d, --data-dir <path>", "override the data directory")
    .action(async (opts: { yes: boolean; dataDir?: string }) => {
      const r = await deleteStore(opts);
      if (r.code === 0) console.log(r.message);
      else console.error(chalk.red(r.message));
      process.exitCode = r.code;
    });

  dql
    .command("import")
    .description("Import documents from a JSON file into a collection")
    .argument("<file>", "JSON file: an array of objects, or NDJSON (one object per line)")
    .argument("<collection>", "target collection (created on first insert)")
    .option("-d, --data-dir <path>", "override the data directory")
    .option("--batch-size <n>", "documents per INSERT batch", "500")
    .action(
      async (file: string, collection: string, opts: { dataDir?: string; batchSize: string }) => {
        // Validate everything before opening the store (usage beats lock).
        let docs: Record<string, unknown>[];
        let batchSize: number;
        try {
          if (!isValidCollectionName(collection)) {
            throw new ImportError(
              `invalid collection name "${collection}" — letters, digits, and underscores only (must not start with a digit)`,
            );
          }
          let text: string;
          try {
            text = fs.readFileSync(expandTilde(file), "utf8");
          } catch (err) {
            throw new ImportError(`Cannot read file: ${file} (${(err as Error).message})`);
          }
          docs = parseImportFile(text, file);
          batchSize = parsePositiveInt(opts.batchSize, "--batch-size", 500);
        } catch (err) {
          if (err instanceof ImportError || err instanceof ParamError) {
            console.error(chalk.red(err.message));
            process.exitCode = err.exitCode;
            return;
          }
          throw err;
        }

        const session = await openSession(opts);
        if (!session) return;
        try {
          const started = performance.now();
          note(`Importing ${docs.length.toLocaleString()} documents into ${collection}…`);
          const inserted = await importDocuments(session, docs, collection, {
            batchSize,
            onProgress: (ins, total) =>
              note(`  ${collection}: ${ins.toLocaleString()}/${total.toLocaleString()}`),
          });
          const elapsed = ((performance.now() - started) / 1000).toFixed(1);
          console.log(
            `Imported ${inserted.toLocaleString()} document${inserted === 1 ? "" : "s"} into ${collection} (${elapsed}s)`,
          );
        } catch (err) {
          const e = err as { message?: string; code?: string };
          console.error(
            chalk.red(`Import failed${e.code ? ` [${e.code}]` : ""}: ${e.message ?? err}`),
          );
          process.exitCode = 1;
        } finally {
          await session.close();
        }
      },
    );

  // Execution subcommand (also the default — see rewriteDefaultSubcommand in
  // the CLI entry, which maps `dittosh dql <stmt>` → `dittosh dql exec <stmt>`;
  // an action directly on `dql` would swallow same-named child options).
  dql
    .command("exec")
    .description("Run a DQL statement, file, or piped input (default command)")
    .argument("[statement]", "DQL statement to run")
    .option("-e, --execute <stmt>", "explicit statement form (alternative to the positional)")
    .option("-f, --file <path>", "run statements from a file")
    .option(
      "-p, --param <name=value>",
      "bind :name parameters (repeatable; values JSON-parsed, string fallback)",
      collectParam,
      [] as string[],
    )
    .option(
      "--args <json>",
      "bind parameters from a JSON object ('-' reads stdin, '@file' reads a file)",
    )
    .option("-d, --data-dir <path>", "override the data directory")
    .option("-o, --out <path>", "write results to a file (format from extension or --format)")
    .option("--format <format>", "table | json | csv | markdown | html | vertical")
    .option("--max-rows <n>", "maximum rows to display", "10000")
    .option("--no-pager", "never pipe results through $PAGER/less")
    .option("--continue-on-error", "keep running statements after a failure (-f/stdin)", false)
    .option("--time", "print timing after the results", false)
    .option("--explain", "run EXPLAIN on the statement and print the plan", false)
    .option("--profile", "run PROFILE on SELECT statements and print the execution profile", false)
    .option("--advise", "run ADVISE on SELECT statements and print index advice", false)
    .option("--apply", "apply suggested CREATE INDEX statements (prompts; -y skips)", false)
    .option("-y, --yes", "skip confirmation prompts", false)
    .action(async (positional: string | undefined, opts: ExecOpts, command: Command) => {
      // Commander keeps "=" in short-option inline values (-e=SELECT → "=SELECT") — strip it.
      const stripEq = (v?: string) => v?.replace(/^=/, "");
      opts = {
        ...opts,
        file: stripEq(opts.file),
        execute: stripEq(opts.execute),
        out: stripEq(opts.out),
        format: stripEq(opts.format),
        maxRows: stripEq(opts.maxRows),
        args: stripEq(opts.args),
        dataDir: stripEq(opts.dataDir),
        param: opts.param?.map((p) => p.replace(/^=/, "")),
      };

      // Usage validation (exit 2) before touching the store.
      let runOpts: ReturnType<typeof execRunOpts>;
      try {
        if (positional && opts.execute) {
          throw new ParamError(
            "pass the statement either positionally or via -e/--execute, not both",
          );
        }
        if (opts.file && (positional || opts.execute)) {
          throw new ParamError("-f/--file cannot be combined with a statement argument");
        }
        if (opts.advise && opts.out) {
          throw new ParamError(
            "--advise renders a report, not rows — it can't be combined with -o/--out",
          );
        }
        // `--args -` reads the JSON params object from stdin — which requires
        // piped stdin AND a statement from argv/-e/-f (else stdin IS the batch).
        if (opts.args === "-") {
          if (process.stdin.isTTY) {
            throw new ParamError(
              "--args - reads a JSON object from stdin, but stdin is a terminal",
            );
          }
          if (!positional && !opts.execute && !opts.file) {
            throw new ParamError(
              "--args - consumes stdin — pass the statement positionally, via -e, or via -f",
            );
          }
        }
        const argsJson = await resolveArgsSource(opts.args, readStdinText);
        runOpts = execRunOpts(
          { ...opts, args: argsJson },
          command.getOptionValueSource("maxRows") === "cli",
        );
      } catch (err) {
        if (err instanceof ParamError || err instanceof FormatError) {
          console.error(chalk.red(err.message));
          process.exitCode = err.exitCode;
          return;
        }
        throw err;
      }

      let statement = positional ?? opts.execute;
      if (statement !== undefined) {
        // Strip a trailing ";" (the SDK rejects it) and refuse multi-statement argv.
        const { statements, rest } = splitComplete(statement);
        if (statements.length > 1) {
          console.error(
            chalk.red("multiple statements in one invocation — use -f or pipe via stdin"),
          );
          process.exitCode = 2;
          return;
        }
        if (statements.length === 1) {
          if (!isBlankOrComments(rest)) {
            console.error(
              chalk.red(
                `trailing text after the statement is not executable: "${rest.trim()}" — use -f for multiple statements`,
              ),
            );
            process.exitCode = 2;
            return;
          }
          statement = statements[0]!;
        } else if (isBlankOrComments(statement)) {
          console.error(
            chalk.red(
              'No statement given (input was only whitespace/comments). Usage: dittosh dql "SELECT ..."',
            ),
          );
          process.exitCode = 2;
          return;
        }
        // otherwise: unterminated single statement — the SDK accepts it.

        // A user-typed ADVISE is a report too — no -o (same rule as --advise).
        if (opts.out && classify(statement) === "advise") {
          console.error(
            chalk.red("--advise renders a report, not rows — it can't be combined with -o/--out"),
          );
          process.exitCode = 2;
          return;
        }
        // -o writes row data — mutations/DDL produce none (nothing to write).
        if (opts.out && ["mutation", "ddl", "other"].includes(classify(statement))) {
          console.error(
            chalk.red("-o/--out only applies to row-producing statements (SELECT/EXPLAIN/PROFILE)"),
          );
          process.exitCode = 2;
          return;
        }
      }
      if (runOpts.out) {
        // Validate the target before running anything (usage beats lock).
        const outError = validateOutPath(runOpts.out);
        if (outError) {
          console.error(chalk.red(outError));
          process.exitCode = 2;
          return;
        }
      }
      if (isBogusDataDir(opts.dataDir)) {
        console.error(chalk.red("-d/--data-dir requires a directory path"));
        process.exitCode = 2;
        return;
      }

      // -f "" is a usage error, ALWAYS — even on a TTY (else it silently opens the REPL).
      if (opts.file !== undefined && opts.file.trim() === "") {
        console.error(chalk.red("-f/--file requires a path"));
        process.exitCode = 2;
        return;
      }

      const stdinPiped = !process.stdin.isTTY;

      // REPL: no statement, no file, interactive terminal
      if (!statement && !opts.file && !stdinPiped) {
        if (!process.stdout.isTTY) {
          console.error('No statement given. Usage: dittosh dql "SELECT ..." (see --help)');
          process.exitCode = 2;
          return;
        }
        if (opts.out) {
          console.error(chalk.red("-o/--out is not supported in the interactive REPL"));
          process.exitCode = 2;
          return;
        }
        // An --apply prompt would race node:repl's readline on stdin (wedges
        // the session). -y is safe (no prompt). --advise without --apply is fine.
        if (opts.apply && !opts.yes) {
          console.error(
            chalk.red(
              "--apply prompts for confirmation — not supported in the REPL (use -y, or run one-shot)",
            ),
          );
          process.exitCode = 2;
          return;
        }
        const session = await openSession(opts);
        if (!session) return;
        try {
          await startRepl(session, runOpts);
        } finally {
          await session.close();
        }
        return;
      }

      // Read the -f file before opening the store (no lock churn on bad paths).
      let batchText: string | undefined;
      let batchSource = "stdin";
      if (opts.file) {
        try {
          batchText = fs.readFileSync(opts.file, "utf8");
        } catch {
          console.error(chalk.red(`Cannot read file: ${opts.file}`));
          process.exitCode = 2;
          return;
        }
        batchSource = opts.file;
      } else if (!statement) {
        // piped stdin — fully consume before opening (usage beats lock)
        batchText = await readStdinText();
      }

      // Batch usage validation before touching the store.
      if (batchText !== undefined) {
        batchText = stripDotCommandLines(batchText); // dot-commands are REPL-only
        const statements = splitStatements(batchText);
        if (statements.length === 0) {
          console.error(`No statements in ${batchSource}.`);
          process.exitCode = 2;
          return;
        }
        if (runOpts.out && statements.length > 1) {
          console.error(
            chalk.red(
              "--out is only supported for a single statement (batch results would overwrite each other).",
            ),
          );
          process.exitCode = 2;
          return;
        }
      }

      const session = await openSession(opts);
      if (!session) return;
      try {
        if (batchText !== undefined) {
          await batchFromText(session, batchText, runOpts, opts.continueOnError); // already stripped
          return;
        }
        // one-shot
        const r = await runStatement(session, statement!, runOpts);
        if (!r.ok) process.exitCode = 1;
      } finally {
        await session.close();
      }
    });
}
