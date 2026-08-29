#!/usr/bin/env node
import { Command } from "commander";
import chalk from "chalk";
import { resolveDataDir, defaultDataDir } from "../config/paths.js";
import { loadIdentity, daysUntilExpiry, IdentityError } from "../identity/token.js";
import { DittoSession, LockError } from "../ditto/session.js";
import { classify, extractRows, capRows } from "../query/execute.js";
import { renderTable } from "../render/table.js";
import { createRequire } from "node:module";

const pkg = createRequire(import.meta.url)("../../package.json") as { version: string };

const SUPPORTED: Record<string, string[]> = {
  darwin: ["arm64"],
  linux: ["x64", "arm64"],
  win32: ["x64"],
};

const program = new Command();
program
  .name("ditto")
  .description("The Ditto CLI — run DQL, load sample datasets, install AI agent skills")
  .version(pkg.version);

const dql = new Command("dql").description("Run DQL statements against a local Ditto store");

dql
  .command("doctor")
  .description("Check platform, SDK, token, and data directory health")
  .option("-d, --data-dir <path>", "override the data directory")
  .action(async (opts: { dataDir?: string }) => {
    let failures = 0;
    const check = (ok: boolean, label: string, detail: string) => {
      if (!ok) failures++;
      console.log(`${ok ? chalk.green("✓") : chalk.red("✗")} ${label} — ${detail}`);
    };

    const arches = SUPPORTED[process.platform];
    check(
      arches?.includes(process.arch) ?? false,
      "platform",
      arches?.includes(process.arch)
        ? `${process.platform}/${process.arch} supported`
        : `${process.platform}/${process.arch} is not supported by the Ditto Node SDK 5.1.0 (supported: macOS arm64, Linux x64/arm64, Windows x64)`,
    );

    const nodeMajor = Number(process.versions.node.split(".")[0]);
    check(nodeMajor >= 20, "node", `${process.version}${nodeMajor >= 20 ? "" : " — Node 20+ required"}`);

    const dataDir = resolveDataDir(opts.dataDir);
    let writable = false;
    try {
      const fs = await import("node:fs");
      fs.mkdirSync(dataDir, { recursive: true });
      fs.accessSync(dataDir, fs.constants.W_OK);
      writable = true;
    } catch {
      /* reported below */
    }
    check(writable, "data directory", writable ? dataDir : `not writable: ${dataDir}`);

    try {
      const identity = loadIdentity();
      const days = daysUntilExpiry(identity.expiresOn);
      check(true, "token", days === null ? "loaded" : `loaded, expires ${identity.expiresOn} (${days}d)`);
    } catch (err) {
      check(false, "token", err instanceof Error ? err.message : String(err));
    }

    process.exitCode = failures > 0 ? 3 : 0;
  });

dql
  .argument("[statement]", "DQL statement to run (omit for REPL — not yet implemented)")
  .option("-d, --data-dir <path>", "override the data directory")
  .option("--format <format>", "table | json | csv", undefined)
  .option("--max-rows <n>", "maximum rows to display", "10000")
  .action(async (statement: string | undefined, opts: { dataDir?: string; format?: string; maxRows: string }) => {
    if (!statement) {
      console.error("No statement given. The interactive REPL is coming in M2 — for now pass a statement:");
      console.error(`  ditto dql "SELECT * FROM system:collections"`);
      process.exitCode = 2;
      return;
    }

    const dataDir = resolveDataDir(opts.dataDir);
    let session: DittoSession;
    try {
      session = await DittoSession.open(loadIdentity(), dataDir);
    } catch (err) {
      if (err instanceof LockError || err instanceof IdentityError) {
        console.error(chalk.red(err.message));
        process.exitCode = err.exitCode;
        return;
      }
      throw err;
    }

    try {
      const started = performance.now();
      const result = await session.execute(statement);
      const elapsed = performance.now() - started;

      const rows = extractRows(result);
      const kind = classify(statement);

      if (kind === "mutation" && rows.length === 0) {
        console.log("OK");
        return;
      }

      const maxRows = Number.parseInt(opts.maxRows, 10);
      const { rows: shown, truncated, total } = capRows(rows, maxRows);

      const format =
        opts.format ?? (process.stdout.isTTY ? "table" : "json");
      if (format === "json") {
        console.log(JSON.stringify(shown, null, 2));
      } else {
        console.log(renderTable(shown));
      }
      if (truncated) {
        console.error(chalk.yellow(`showing first ${shown.length} of ${total} rows — add a LIMIT clause`));
      }
      if (process.env.DQL_DEBUG) {
        console.error(`(${elapsed.toFixed(1)} ms)`);
      }
    } catch (err) {
      const e = err as { message?: string; code?: string };
      console.error(chalk.red(`Query error${e.code ? ` [${e.code}]` : ""}: ${e.message ?? err}`));
      console.error(chalk.dim(`  in: ${statement}`));
      process.exitCode = 1;
    } finally {
      await session.close();
    }
  });

program.addCommand(dql);

program.parseAsync().catch((err) => {
  console.error(chalk.red(err instanceof Error ? err.message : String(err)));
  process.exitCode = 1;
});
