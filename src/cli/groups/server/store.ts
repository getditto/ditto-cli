import fs from "node:fs";
import chalk from "chalk";
import type { Command } from "commander";
import { classify } from "../../../query/execute.js";
import {
  ParamError,
  parseParams,
  parsePositiveInt,
  resolveArgsSource,
} from "../../../query/params.js";
import { isBlankOrComments, splitComplete, splitStatements } from "../../../query/split.js";
import { FormatError, resolveFormat } from "../../../render/output.js";
import { PortalApiError, PortalConnectionError } from "../../../server/client.js";
import type { ServerRunOptions } from "../../../server/run.js";
import { runServerExecute, runServerRemoteExecute } from "../../../server/run.js";
import { validateOutPath } from "../dql/run.js";
import {
  addServerOpts,
  connect,
  reportServerError,
  type ServerDeps,
  stripEq,
  withServerErrors,
} from "./common.js";

/**
 * Store data plane: DQL execute against Ditto Server, plus remote_execute for
 * connected edge peers. Mirrors `dittosh dql exec` semantics where they make
 * sense over HTTP (batch, params, formats, -o, pager).
 */

interface ExecOpts {
  url?: string;
  apiKey?: string;
  apiVersion?: string;
  txnId?: string;
  format?: string;
  maxRows?: string;
  out?: string;
  file?: string;
  param?: string[];
  args?: string;
  continueOnError?: boolean;
  pager?: boolean;
  time?: boolean;
  execute?: string;
}

function collectParam(value: string, previous: string[]): string[] {
  return [...previous, value];
}

async function readStdinText(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function parseTxnId(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  return parsePositiveInt(raw, "--txn-id", 0, { min: 0 }); // 0 is a valid txn id
}

/** Validate flags and build run options; throws ParamError/FormatError (exit 2). */
function execRunOpts(
  opts: ExecOpts,
  maxRowsExplicit: boolean,
): ServerRunOptions & {
  apiVersion?: "v4" | "v5";
  txnId?: number;
} {
  const format = opts.format === undefined ? undefined : resolveFormat(opts.format);
  return {
    format,
    maxRows: parsePositiveInt(opts.maxRows, "--max-rows", 10_000),
    maxRowsExplicit,
    out: opts.out,
    params: parseParams(opts.param, opts.args),
    pager: opts.pager,
    time: opts.time,
    txnId: parseTxnId(opts.txnId),
  };
}

const EXECUTE_HELP = `
Request body (POST {url}/api/v5/store/execute):
  { "statement": "<DQL>", "args": { "name": value } }

Connection is resolved from --url/--api-key, then DITTOSH_SERVER_URL /
DITTOSH_SERVER_API_KEY from the shell environment, then a .env file in the
current directory (shell always wins over .env).

Any DQL works, including EXPLAIN / PROFILE / ADVISE as statements:
  dittosh server execute "SELECT * FROM customers LIMIT 5"
  dittosh server execute "EXPLAIN SELECT * FROM customers WHERE tier = :t" -p t=gold
  dittosh server execute "INSERT INTO customers DOCUMENTS (:doc)" \\
    --args '{"doc":{"_id":"c1","name":"Ada"}}'
  dittosh server execute --api-version v4 "SELECT * FROM customers"  # strict mode
  cat batch.sql | dittosh server execute                 # one HTTP call per statement
  dittosh server execute -f batch.sql --continue-on-error

Notes:
  - -o/--out is for row-producing statements (SELECT/EXPLAIN/PROFILE).
    INSERT/UPDATE/DELETE … RETURNING does emit rows but is refused anyway
    (classified by its first keyword) — run it without -o.
  - In batch mode, auth/connection failures stop the batch with exit 3 even
    under --continue-on-error (a dead server won't heal mid-file).

Exit codes: 0 ok · 1 DQL/API error · 2 usage · 3 config/auth/connection.`;

export function registerStoreCommands(server: Command, deps: ServerDeps = {}): void {
  addServerOpts(
    server
      .command("execute")
      .alias("exec")
      .description("Run a DQL statement, file, or piped input against Ditto Server")
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
      .option("--api-version <version>", "v5 (default) or v4 (legacy strict mode)")
      .option("--txn-id <n>", "X-DITTO-TXN-ID: wait until the server reaches this transaction")
      .option("-o, --out <path>", "write results to a file (format from extension or --format)")
      .option("--format <format>", "table | json | csv | markdown | html | vertical")
      .option("--max-rows <n>", "maximum rows to display", "10000")
      .option("--no-pager", "never pipe results through $PAGER/less")
      .option("--continue-on-error", "keep running statements after a failure (-f/stdin)", false)
      .option("--time", "print timing after the results", false),
  )
    .addHelpText("after", EXECUTE_HELP)
    .action(
      withServerErrors(async (positional: string | undefined, opts: ExecOpts, command: Command) => {
        // stripEq only for SHORT-form options — commander keeps "=" in `-e=x`
        // artifacts; long options never carry it, and stripping would corrupt
        // legit values that start with "=" (e.g. --api-key "=abc").
        opts = {
          ...opts,
          file: stripEq(opts.file),
          execute: stripEq(opts.execute),
          out: stripEq(opts.out),
          param: opts.param?.map((p) => p.replace(/^=/, "")),
        };

        // ---- usage validation (exit 2) before any network I/O ----
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
                'No statement given (input was only whitespace/comments). Usage: dittosh server execute "SELECT ..."',
              ),
            );
            process.exitCode = 2;
            return;
          }
        }
        if (runOpts.out) {
          const outError = validateOutPath(runOpts.out);
          if (outError) {
            console.error(chalk.red(outError));
            process.exitCode = 2;
            return;
          }
          // -o writes row data — mutations/DDL produce none (nothing to write).
          if (statement && ["mutation", "ddl", "other"].includes(classify(statement))) {
            console.error(
              chalk.red(
                "-o/--out only applies to row-producing statements (SELECT/EXPLAIN/PROFILE)",
              ),
            );
            process.exitCode = 2;
            return;
          }
        }

        if (opts.file !== undefined && opts.file.trim() === "") {
          console.error(chalk.red("-f/--file requires a path"));
          process.exitCode = 2;
          return;
        }

        const stdinPiped = !process.stdin.isTTY;

        // Read the batch source before connecting (usage beats network).
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
          if (!stdinPiped) {
            console.error(
              'No statement given. Usage: dittosh server execute "SELECT ..." (see --help)',
            );
            process.exitCode = 2;
            return;
          }
          batchText = await readStdinText();
        }

        if (batchText !== undefined) {
          const statements = splitStatements(batchText);
          if (statements.length === 0) {
            console.error(`No statements in ${batchSource}.`);
            process.exitCode = 2;
            return;
          }
          if (runOpts.out) {
            if (statements.length > 1) {
              console.error(
                chalk.red(
                  "--out is only supported for a single statement (batch results would overwrite each other).",
                ),
              );
              process.exitCode = 2;
              return;
            }
            // A one-statement -f batch is still subject to the -o row-data rule.
            if (["mutation", "ddl", "other"].includes(classify(statements[0]!))) {
              console.error(
                chalk.red(
                  "-o/--out only applies to row-producing statements (SELECT/EXPLAIN/PROFILE)",
                ),
              );
              process.exitCode = 2;
              return;
            }
          }
        }

        const conn = connect(opts, deps);
        if (!conn) return;

        if (batchText !== undefined) {
          let okCount = 0;
          let failed = 0;
          let fatal = false; // auth/connection: won't heal mid-batch — stop regardless of --continue-on-error
          const statements = splitStatements(batchText);
          for (const stmt of statements) {
            try {
              const r = await runServerExecute(conn.client, stmt, {
                ...runOpts,
                apiVersion: conn.config.apiVersion,
              });
              if (r.ok) okCount++;
              else failed++;
            } catch (err) {
              failed++;
              // Auth/connection failures (exit-3 class) won't heal mid-batch:
              // report once and stop, keeping exit 3 (even with --continue-on-error).
              if (
                err instanceof PortalConnectionError ||
                (err instanceof PortalApiError && err.exitCode === 3)
              ) {
                reportServerError(err);
                fatal = true;
                break;
              }
              // Query-class failures (400, 500, …) print and follow --continue-on-error.
              console.error(chalk.red(err instanceof Error ? err.message : String(err)));
            }
            if (failed > 0 && !opts.continueOnError) break;
          }
          if (statements.length > 1) {
            console.error(chalk.dim(`${okCount} ok, ${failed} failed (of ${statements.length})`));
          }
          if (fatal) process.exitCode = 3;
          else if (failed > 0) process.exitCode = 1;
          return;
        }

        const r = await runServerExecute(conn.client, statement!, {
          ...runOpts,
          apiVersion: conn.config.apiVersion,
        });
        if (!r.ok) process.exitCode = 1;
      }),
    );

  // ---- remote-execute ------------------------------------------------------

  addServerOpts(
    server
      .command("remote-execute")
      .description("Run a DQL statement on connected edge peers (POST /api/v5/sync/remote_execute)")
      .argument("<statement>", "DQL statement; must include a SYNC CONTEXT clause selecting peers")
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
      .option("--time", "print timing after the results", false)
      .option("--no-pager", "never pipe results through $PAGER/less"),
  )
    .addHelpText(
      "after",
      `
The statement MUST start with a SYNC CONTEXT clause naming the target peers
(undocumented in the public API reference — taken from the portal client):
  SYNC CONTEXT ( PEERS WHERE peerKeyString = '<peer-key>' ) SELECT * FROM cars

Output is always a JSON array, one entry per responding peer:
  [ { "peer": …, "elapsedMilliseconds": n, "items": [ …rows… ] } ]

Example:
  dittosh server remote-execute "SYNC CONTEXT ( PEERS WHERE peerKeyString = 'pkAg' ) SELECT * FROM cars LIMIT 5"
`,
    )
    .action(
      withServerErrors(async (statement: string, opts: ExecOpts) => {
        opts = {
          ...opts,
          param: opts.param?.map((p) => p.replace(/^=/, "")),
        };
        let params: Record<string, unknown> | undefined;
        try {
          if (!/^\s*SYNC\s+CONTEXT/i.test(statement)) {
            throw new ParamError(
              "remote-execute statements must start with a SYNC CONTEXT clause, e.g.\n" +
                "  SYNC CONTEXT ( PEERS WHERE peerKeyString = '<peer-key>' ) SELECT ...",
            );
          }
          if (opts.args === "-" && process.stdin.isTTY) {
            throw new ParamError(
              "--args - reads a JSON object from stdin, but stdin is a terminal",
            );
          }
          const argsJson = await resolveArgsSource(opts.args, readStdinText);
          params = parseParams(opts.param, argsJson);
        } catch (err) {
          if (err instanceof ParamError) {
            console.error(chalk.red(err.message));
            process.exitCode = err.exitCode;
            return;
          }
          throw err;
        }
        const conn = connect(opts, deps);
        if (!conn) return;
        const r = await runServerRemoteExecute(conn.client, statement, {
          maxRows: 10_000,
          maxRowsExplicit: false,
          params,
          pager: opts.pager,
          time: opts.time,
        });
        if (!r.ok) process.exitCode = 1;
      }),
    );
}
