import fs from "node:fs";
import path from "node:path";
import chalk from "chalk";
import type { Command } from "commander";
import { expandTilde } from "../../../config/paths.js";
import type { DittoSession } from "../../../ditto/session.js";
import { FormatError, renderRows, resolveFormat } from "../../../render/output.js";
import { formatBytes } from "../../../support/report.js";
import {
  bundleErrorMessage,
  listSupportBundles,
  saveSupportBundle,
} from "../../../support/sdk-bundle.js";
import { CLI_VERSION } from "../../version.js";
import { note } from "./run.js";

/** `ditto-support-bundle-20261107-153012.tar` (local time). */
export function defaultBundleName(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `ditto-support-bundle-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.tar`;
}

interface SupportBundleOpts {
  dataDir?: string;
  out?: string;
  list?: boolean;
  format?: string;
}

export function registerSupportBundleCommand(
  dql: Command,
  deps: {
    openSession: (opts: { dataDir?: string }) => Promise<DittoSession | null>;
    now?: () => Date;
  },
): void {
  dql
    .command("support-bundle")
    .description("Save a Ditto SDK support bundle (SDK debug logs and config) for Ditto support")
    .option("-d, --data-dir <path>", "override the data directory")
    .option(
      "-o, --out <file>",
      "where to save the .tar (default: ./ditto-support-bundle-<time>.tar)",
    )
    .option("--list", "list the bundles kept in the store instead of making one")
    .option("--format <fmt>", "with --list: table, json, csv, markdown, html, vertical")
    .addHelpText(
      "after",
      `
Ditto builds the bundle on this machine, offline: a .tar with the SDK's debug
logs (ditto-logs.log.gz), their time range, and the store configuration with
secrets removed. The logs include file paths and peer keys; look inside before
sharing. Ditto allows 3 new bundles per 10 minutes per store; past that, the
newest existing bundle is saved instead.

For a GitHub issue, prefer: dittosh doctor --report (includes this bundle).`,
    )
    .action(async (opts: SupportBundleOpts) => {
      let format: ReturnType<typeof resolveFormat> | undefined;
      if (opts.list) {
        try {
          format = resolveFormat(opts.format?.replace(/^=/, ""));
        } catch (err) {
          if (!(err instanceof FormatError)) throw err;
          console.error(chalk.red(err.message));
          process.exitCode = 2;
          return;
        }
      } else if (opts.format !== undefined) {
        console.error(chalk.red("--format only applies with --list"));
        process.exitCode = 2;
        return;
      }

      const session = await deps.openSession(opts);
      if (!session) return;
      try {
        if (opts.list) {
          const rows = await listSupportBundles(session);
          if (rows.length === 0) note("No support bundles in this store yet.");
          else console.log(renderRows(rows, format!, { maxWidth: process.stdout.columns }));
          return;
        }
        const now = (deps.now ?? (() => new Date()))();
        const out = path.resolve(expandTilde(opts.out ?? defaultBundleName(now)));
        if (fs.existsSync(out)) {
          console.error(chalk.red(`${out} already exists; choose another name with -o`));
          process.exitCode = 2;
          return;
        }
        fs.mkdirSync(path.dirname(out), { recursive: true });
        const saved = await saveSupportBundle(session, out, {
          source: "dittosh dql support-bundle",
          dittosh: CLI_VERSION,
        });
        if (saved.reusedBecause) {
          console.error(
            chalk.yellow(
              `A new bundle wasn't allowed (${saved.reusedBecause}); saved the newest existing one.`,
            ),
          );
        }
        console.error(
          chalk.green(`Saved ${out} (${formatBytes(saved.bytes)}, created ${saved.createdAt})`),
        );
        note(`Look inside: tar -tf ${JSON.stringify(out)}`);
      } catch (err) {
        console.error(chalk.red(`Could not save a support bundle: ${bundleErrorMessage(err)}`));
        process.exitCode = 1;
      } finally {
        await session.close();
      }
    });
}
