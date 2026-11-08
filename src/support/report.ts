import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DoctorCheck } from "../cli/groups/dql/doctor.js";
import type { LastError } from "./last-error.js";
import { isSecretEnv, SECRET_ENV } from "./redact.js";
import type { BundleSession, SavedBundle } from "./sdk-bundle.js";

/** Everything `doctor --report` gathers. Plain data: rendered to Markdown and JSON. */
export interface Report {
  generated: string;
  environment: Record<string, string>;
  checks: DoctorCheck[];
  settings: Record<string, string>;
  paths: Record<string, string>;
  store: StoreSummary;
  sdkBundle: { file?: string; detail: string };
  lastError: LastError | null;
}

export interface StoreSummary {
  /** Why there's no summary (no store yet, opted out, failed to open…). */
  skipped?: string;
  collections?: { name: string; documents: number | string }[];
  indexes?: { id: string; collection: string; fields: string }[];
}

export type StoreSession = BundleSession & { close(): Promise<void> };

export interface ReportInputs {
  dataDir: string;
  configDir: string;
  /** Include collection names, counts, and indexes. */
  includeStore: boolean;
  /** Request a Ditto SDK support bundle into `workDir`. */
  includeSdkBundle: boolean;
  /** Where the SDK bundle is saved before archiving. */
  workDir: string;
  checks: DoctorCheck[];
  environment: Record<string, string>;
  lastError: LastError | null;
  env?: NodeJS.ProcessEnv;
  /** Opens the store; throws if it can't. */
  openStore: () => Promise<StoreSession>;
  saveBundle: (session: StoreSession, filePath: string) => Promise<SavedBundle>;
  now?: () => Date;
}

/** Bytes as a short human string. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 10 ? 0 : 1)} ${units[i]}`;
}

/** Total size of a directory tree (best-effort; unreadable entries are skipped). */
export function dirSize(dir: string): number {
  let total = 0;
  const walk = (p: string) => {
    let st: fs.Stats;
    try {
      st = fs.lstatSync(p);
    } catch {
      return;
    }
    if (st.isDirectory()) {
      let entries: string[] = [];
      try {
        entries = fs.readdirSync(p);
      } catch {
        return;
      }
      for (const e of entries) walk(path.join(p, e));
    } else {
      total += st.size;
    }
  };
  walk(dir);
  return total;
}

/** Free space on the volume holding `p` (or its nearest existing ancestor). */
export function freeSpace(p: string): number | null {
  let probe = p;
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  try {
    const s = fs.statfsSync(probe);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}

const SETTINGS_ENV = [
  "NO_COLOR",
  "FORCE_COLOR",
  "CI",
  "PAGER",
  "LESS",
  "TERM",
  "TERM_PROGRAM",
  "COLORTERM",
  "LANG",
  "LC_ALL",
  "SHELL",
];

/** Settings that change dittosh's behavior. Credentials show only as set/not set. */
export function collectSettings(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  const names = [
    ...Object.keys(env)
      .filter((k) => k.startsWith("DITTOSH_"))
      .sort(),
    ...SETTINGS_ENV,
  ];
  for (const k of names) {
    if (env[k] === undefined) continue;
    out[k] = isSecretEnv(k) ? "set (value hidden)" : (env[k] ?? "");
  }
  for (const k of SECRET_ENV) out[k] = env[k] ? "set (value hidden)" : "not set";
  return out;
}

/** Machine and terminal facts that commonly explain "works for me" bugs. */
export function collectMachine(): Record<string, string> {
  const cpus = os.cpus();
  const intl = Intl.DateTimeFormat().resolvedOptions();
  return {
    os: `${os.type()} ${os.release()}${typeof os.version === "function" ? ` (${os.version()})` : ""}`,
    platform: `${process.platform}/${process.arch}`,
    cpu: cpus.length > 0 ? `${cpus[0]?.model ?? "unknown"} × ${cpus.length}` : "unknown",
    memory: `${formatBytes(os.totalmem())} total, ${formatBytes(os.freemem())} free`,
    node: `${process.version} (${process.execPath})`,
    terminal: [
      `stdout ${process.stdout.isTTY ? "TTY" : "not a TTY"}`,
      `stderr ${process.stderr.isTTY ? "TTY" : "not a TTY"}`,
      process.stdout.columns ? `${process.stdout.columns}×${process.stdout.rows}` : "size unknown",
    ].join(", "),
    locale: `${intl.locale}, ${intl.timeZone}`,
  };
}

async function summarizeStore(session: StoreSession): Promise<StoreSummary> {
  const cols = await session.execute("SELECT * FROM system:collections");
  const names = cols.items
    .map((i) => String((i.value as { name?: unknown }).name ?? ""))
    .filter((n) => n && !n.startsWith("__"))
    .sort();
  const collections: StoreSummary["collections"] = [];
  for (const name of names) {
    try {
      const r = await session.execute(`SELECT COUNT(*) AS n FROM \`${name.replace(/`/g, "``")}\``);
      collections.push({ name, documents: Number((r.items[0]?.value as { n?: unknown })?.n ?? 0) });
    } catch (err) {
      collections.push({ name, documents: `count failed: ${(err as Error).message}` });
    }
  }
  const idx = await session.execute("SELECT * FROM system:indexes");
  const indexes = idx.items.map((i) => {
    const v = i.value as { _id?: unknown; collection?: unknown; fields?: unknown };
    const fields = Array.isArray(v.fields)
      ? v.fields
          .map((f: { key?: unknown; direction?: unknown }) => {
            const key = Array.isArray(f.key) ? f.key.join(".") : String(f.key ?? "?");
            return f.direction && f.direction !== "asc" ? `${key} ${String(f.direction)}` : key;
          })
          .join(", ")
      : "";
    return { id: String(v._id ?? ""), collection: String(v.collection ?? ""), fields };
  });
  return { collections, indexes };
}

/**
 * Gather the report. Every section is best-effort: a failure is written into
 * the report as text rather than stopping it, since a broken install is
 * exactly when people need the report.
 */
export async function collectReport(inputs: ReportInputs): Promise<Report> {
  const env = inputs.env ?? process.env;
  const now = inputs.now ?? (() => new Date());

  const storeExists = fs.existsSync(path.join(inputs.dataDir, "__ditto_lock_file"));
  const free = freeSpace(inputs.dataDir);
  const paths: Record<string, string> = {
    "data directory": inputs.dataDir,
    "store size": storeExists ? formatBytes(dirSize(inputs.dataDir)) : "no store yet",
    "free disk space": free === null ? "unknown" : formatBytes(free),
    "config directory": inputs.configDir,
    "config files": (() => {
      try {
        return fs.readdirSync(inputs.configDir).sort().join(", ") || "(empty)";
      } catch {
        return "(none)";
      }
    })(),
    executable: process.argv[1] ?? "unknown",
  };

  let store: StoreSummary = {};
  let sdkBundle: Report["sdkBundle"] = { detail: "" };
  if (!inputs.includeStore) store = { skipped: "left out (--no-store)" };
  if (!inputs.includeSdkBundle) sdkBundle = { detail: "left out (--no-sdk-bundle)" };

  if (!storeExists) {
    const why = `no store at the data directory yet`;
    if (inputs.includeStore) store = { skipped: why };
    if (inputs.includeSdkBundle) sdkBundle = { detail: `not created: ${why}` };
  } else if (inputs.includeStore || inputs.includeSdkBundle) {
    let session: StoreSession | null = null;
    try {
      session = await inputs.openStore();
    } catch (err) {
      const why = `the store didn't open: ${(err as Error).message.split("\n")[0]}`;
      if (inputs.includeStore) store = { skipped: why };
      if (inputs.includeSdkBundle) sdkBundle = { detail: `not created: ${why}` };
    }
    if (session) {
      try {
        if (inputs.includeStore) {
          try {
            store = await summarizeStore(session);
          } catch (err) {
            store = { skipped: `summary failed: ${(err as Error).message}` };
          }
        }
        if (inputs.includeSdkBundle) {
          const file = path.join(inputs.workDir, "ditto-support-bundle.tar");
          try {
            const saved = await inputs.saveBundle(session, file);
            sdkBundle = {
              file: path.basename(file),
              detail: `${formatBytes(saved.bytes)}, created ${saved.createdAt}${
                saved.reusedBecause
                  ? ` (an existing bundle: a new one wasn't allowed: ${saved.reusedBecause})`
                  : ""
              }`,
            };
          } catch (err) {
            sdkBundle = { detail: `failed: ${(err as Error).message}` };
          }
        }
      } finally {
        await session.close().catch(() => {});
      }
    }
  }

  return {
    generated: now().toISOString(),
    environment: { ...inputs.environment, ...collectMachine() },
    checks: inputs.checks,
    settings: collectSettings(env),
    paths,
    store,
    sdkBundle,
    lastError: inputs.lastError,
  };
}

// `|` as an HTML entity: Markdown renders it as a pipe, it can't end a cell,
// and backslashes (Windows paths) stay readable in the raw file.
const cell = (s: string) => s.replace(/\|/g, "&#124;").replace(/\r?\n/g, " ");

function table(rows: Record<string, string>): string {
  const lines = ["| | |", "|---|---|"];
  for (const [k, v] of Object.entries(rows)) lines.push(`| ${cell(k)} | ${cell(v)} |`);
  return lines.join("\n");
}

/** The Markdown report (also readable as plain text). */
export function renderReport(r: Report): string {
  const out: string[] = [];
  out.push("# dittosh diagnostic report", "");
  out.push(`Generated ${r.generated}. Review it before attaching it to an issue.`, "");

  out.push("## Environment", "", table(r.environment), "");

  out.push("## Checks", "");
  for (const c of r.checks) out.push(`- ${c.ok ? "✓" : "✗"} **${c.label}**: ${c.detail}`);
  out.push("");

  out.push("## Paths and disk", "", table(r.paths), "");
  out.push("## Settings", "", table(r.settings), "");

  out.push("## Store", "");
  if (r.store.skipped) {
    out.push(`Not included: ${r.store.skipped}.`, "");
  } else {
    const cols = r.store.collections ?? [];
    if (cols.length === 0) out.push("No collections.", "");
    else {
      out.push("| collection | documents |", "|---|---|");
      for (const c of cols) out.push(`| ${cell(c.name)} | ${c.documents} |`);
      out.push("");
    }
    const idx = r.store.indexes ?? [];
    if (idx.length === 0) out.push("No indexes.", "");
    else {
      out.push("| index | collection | fields |", "|---|---|---|");
      for (const i of idx)
        out.push(`| ${cell(i.id)} | ${cell(i.collection)} | ${cell(i.fields)} |`);
      out.push("");
    }
  }

  out.push("## Ditto SDK support bundle", "");
  out.push(
    r.sdkBundle.file ? `\`${r.sdkBundle.file}\`: ${r.sdkBundle.detail}` : r.sdkBundle.detail,
    "",
  );

  out.push("## Last error", "");
  if (!r.lastError) out.push("No failed command recorded.", "");
  else {
    const e = r.lastError;
    out.push(
      `\`dittosh ${e.command.join(" ")}\` exited ${e.exitCode} at ${e.time} (v${e.version}).`,
      "",
    );
    if (e.stderr.length > 0) out.push("```", ...e.stderr, "```", "");
    if (e.stack) out.push("Stack trace:", "", "```", e.stack, "```", "");
  }
  return `${out.join("\n").trimEnd()}\n`;
}

/**
 * report.json, redacted string by string before encoding: JSON doubles
 * backslashes, so a Windows home path wouldn't match once encoded.
 */
export function renderReportJson(r: Report, redact: (s: string) => string): string {
  return `${JSON.stringify(r, (_key, value) => (typeof value === "string" ? redact(value) : value), 2)}\n`;
}

/** What the bundle contains, for the note printed after writing it. */
export function describeContents(r: Report): string[] {
  const items = [
    "report.md / report.json: versions, OS, terminal, doctor checks, paths, dittosh settings (credentials only as set/not set)",
  ];
  if (r.store.collections)
    items.push("store summary: collection names, document counts, indexes (no document contents)");
  if (r.lastError)
    items.push(`last error: the failed command line and its error output (${r.lastError.time})`);
  if (r.sdkBundle.file)
    items.push(
      `${r.sdkBundle.file}: Ditto's support bundle, included as is (SDK debug logs and store config; holds the database ID, full file paths, and peer keys)`,
    );
  return items;
}
