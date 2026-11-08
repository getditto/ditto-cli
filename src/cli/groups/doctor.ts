import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import chalk from "chalk";
import type { Command } from "commander";
import { configDir, expandTilde, resolveDataDir } from "../../config/paths.js";
import type { Identity } from "../../identity/token.js";
import { daysUntilExpiry, loadIdentity } from "../../identity/token.js";
import { writeArchive } from "../../support/archive.js";
import { readLastError } from "../../support/last-error.js";
import { makeRedactor, SECRET_ENV } from "../../support/redact.js";
import {
  collectReport,
  describeContents,
  formatBytes,
  renderReport,
  type StoreSession,
} from "../../support/report.js";
import { saveSupportBundle } from "../../support/sdk-bundle.js";
import { detectChannel } from "../../update/channel.js";
import { isNewer, readCachedUpdate } from "../../update/check.js";
import { CLI_VERSION, DITTO_SDK_VERSION } from "../version.js";
import { collectDoctorChecks, type DoctorCheck } from "./dql/doctor.js";

export const ISSUE_URL = "https://github.com/getditto/ditto-cli/issues/new?template=bug_report.yml";

/** Injectable pieces (tests replace the SDK-touching ones). */
export interface DoctorDeps {
  collectChecks: (opts: { dataDir?: string }) => Promise<DoctorCheck[]>;
  openStore: (identity: Identity, dataDir: string) => Promise<StoreSession>;
  channelDetail: () => string;
  now: () => Date;
}

export const realDoctorDeps: DoctorDeps = {
  collectChecks: (opts) => collectDoctorChecks(opts),
  openStore: async (identity, dataDir) => {
    const { DittoSession } = await import("../../ditto/session.js");
    return DittoSession.open(identity, dataDir);
  },
  channelDetail: () => detectChannel().detail,
  now: () => new Date(),
};

/** `dittosh-report-20261107-153012.tar.gz` (local time). */
export function defaultReportName(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `dittosh-report-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.tar.gz`;
}

interface DoctorOpts {
  dataDir?: string;
  report?: string | boolean;
  store: boolean;
  sdkBundle: boolean;
}

function versionFacts(deps: DoctorDeps): { facts: Record<string, string>; identity?: Identity } {
  const facts: Record<string, string> = {
    dittosh: CLI_VERSION,
    "ditto sdk": DITTO_SDK_VERSION,
  };
  let identity: Identity | undefined;
  try {
    identity = loadIdentity();
    facts.build = identity.source === "embedded" ? "release" : "dev (.env credentials)";
    const days = daysUntilExpiry(identity.expiresOn);
    facts["token expires"] = identity.expiresOn
      ? `${identity.expiresOn}${days !== null ? ` (${days < 0 ? "expired" : `${days}d`})` : ""}`
      : "unknown";
  } catch (err) {
    facts.build = "unknown";
    facts["token expires"] = `unavailable: ${(err as Error).message.split("\n")[0]}`;
  }
  try {
    facts.installed = deps.channelDetail();
  } catch {
    facts.installed = "unknown";
  }
  const cached = readCachedUpdate();
  facts.update = cached
    ? isNewer(CLI_VERSION, cached.latest)
      ? `${cached.latest} available`
      : "up to date"
    : "never checked";
  return { facts, ...(identity ? { identity } : {}) };
}

/** Write the report bundle; returns its path. Status lines go to stderr. */
export async function writeReport(
  opts: DoctorOpts,
  checks: DoctorCheck[],
  deps: DoctorDeps,
): Promise<string> {
  const now = deps.now();
  const out = path.resolve(
    expandTilde(
      typeof opts.report === "string" && opts.report.trim() ? opts.report : defaultReportName(now),
    ),
  );
  const dataDir = resolveDataDir(opts.dataDir);
  const { facts, identity } = versionFacts(deps);
  const redact = makeRedactor({
    secrets: [identity?.token, ...SECRET_ENV.map((k) => process.env[k])],
  });

  const work = fs.mkdtempSync(path.join(os.tmpdir(), "dittosh-report-"));
  try {
    if (opts.store || opts.sdkBundle) {
      console.error(chalk.dim("Collecting diagnostics (this can take a few seconds)…"));
    }
    const report = await collectReport({
      dataDir,
      configDir: configDir(),
      includeStore: opts.store,
      includeSdkBundle: opts.sdkBundle,
      workDir: work,
      checks,
      environment: facts,
      lastError: readLastError(),
      openStore: () => {
        if (!identity) throw new Error("no license token loaded");
        return deps.openStore(identity, dataDir);
      },
      saveBundle: (session, file) =>
        saveSupportBundle(session, file, {
          source: "dittosh doctor --report",
          dittosh: CLI_VERSION,
        }),
      now: () => now,
    });
    fs.writeFileSync(path.join(work, "report.md"), redact(renderReport(report)), "utf8");
    fs.writeFileSync(
      path.join(work, "report.json"),
      `${redact(JSON.stringify(report, null, 2))}\n`,
      "utf8",
    );
    const files = ["report.md", "report.json"];
    if (report.sdkBundle.file) files.push(report.sdkBundle.file);
    const folder = path.basename(out).replace(/\.tar\.gz$|\.tgz$/, "") || "dittosh-report";
    const size = await writeArchive(out, work, folder, files);

    const shown = redact(out);
    console.error(chalk.green(`Wrote ${shown} (${formatBytes(size)})`));
    console.error("It contains:");
    for (const item of describeContents(report)) console.error(`  - ${item}`);
    if (!report.sdkBundle.file)
      console.error(chalk.dim(`  (no SDK support bundle: ${report.sdkBundle.detail})`));
    console.error(`Look inside before sharing: tar -xzf ${JSON.stringify(shown)}`);
    console.error(`Attach it to an issue: ${ISSUE_URL}`);
    return out;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

/** Add doctor's options and action to `cmd` (used for `dittosh doctor` and `dittosh dql doctor`). */
export function configureDoctorCommand(cmd: Command, deps: DoctorDeps = realDoctorDeps): Command {
  return cmd
    .description(
      "Check platform, SDK, token, and data directory health; --report writes a file for bug reports",
    )
    .option("-d, --data-dir <path>", "override the data directory")
    .option(
      "--report [file]",
      "also write a diagnostic bundle (.tar.gz) to attach to a GitHub issue (default: ./dittosh-report-<time>.tar.gz)",
    )
    .option("--no-store", "with --report: leave out collection names, counts, and indexes")
    .option("--no-sdk-bundle", "with --report: leave out the Ditto SDK support bundle (SDK logs)")
    .addHelpText(
      "after",
      `
The report bundle holds versions, OS and terminal details, these checks, paths
and free space, dittosh settings (credentials only as set/not set), a store
summary (no document contents), the last failed command, and a Ditto SDK
support bundle with the SDK's debug logs. Your home folder is shown as ~.

Examples:
  dittosh doctor
  dittosh doctor --report
  dittosh doctor --report ~/Desktop/report.tar.gz --no-store
  dittosh dql support-bundle          # only the Ditto SDK support bundle`,
    )
    .action(async (opts: DoctorOpts) => {
      const checks = await deps.collectChecks({ dataDir: opts.dataDir });
      for (const c of checks) {
        console.log(`${c.ok ? chalk.green("✓") : chalk.red("✗")} ${c.label} — ${c.detail}`);
      }
      const failures = checks.filter((c) => !c.ok).length;
      // Spec: lock failures are their own exit code (4), everything else 3.
      const lockFailed = checks.some((c) => c.label === "lock" && !c.ok);
      process.exitCode = failures === 0 ? 0 : lockFailed ? 4 : 3;

      if (opts.report !== undefined) {
        try {
          await writeReport(opts, checks, deps);
        } catch (err) {
          console.error(chalk.red(`Could not write the report: ${(err as Error).message}`));
          process.exitCode = 1;
        }
      }
    });
}
