import chalk from "chalk";
import type { QueryExecutor } from "../../../ditto/session.js";
import {
  buildSections,
  isExporterDisabled,
  SECTION_IDS,
  type SectionId,
} from "../../../metrics/system-metrics.js";
import { extractRows } from "../../../query/execute.js";
import { renderMetrics } from "../../../render/metrics.js";

export const METRICS_USAGE = `.metrics [store|query|all|${SECTION_IDS.filter((id) => id !== "store" && id !== "query").join("|")}]`;

const DEFAULT_SECTIONS: readonly SectionId[] = ["store", "query"];

/** Parse `.metrics` arguments into sections; undefined on an unknown word. */
export function parseMetricsArgs(arg: string | undefined): readonly SectionId[] | undefined {
  const words = (arg ?? "")
    .trim()
    .toLowerCase()
    .split(/[\s,]+/)
    .filter(Boolean);
  if (words.length === 0) return DEFAULT_SECTIONS;
  if (words.includes("all")) return SECTION_IDS;
  const known = new Set<string>(SECTION_IDS);
  if (!words.every((w) => known.has(w))) return undefined;
  return SECTION_IDS.filter((id) => words.includes(id));
}

export interface MetricsCommandOptions {
  /** Terminal width to fit (default: stdout columns on a TTY). */
  maxWidth?: () => number | undefined;
  now?: () => Date;
}

/**
 * The REPL's `.metrics` command: reads `system:metrics` and renders the
 * selected sections. Stateful only to know the first read of the session
 * (each read flushes the SDK's deltas, so "Change" is since the last read).
 */
export function makeMetricsCommand(session: QueryExecutor, opts: MetricsCommandOptions = {}) {
  let reads = 0;
  const maxWidth =
    opts.maxWidth ?? (() => (process.stdout.isTTY ? process.stdout.columns : undefined));

  return async (arg?: string): Promise<{ ok: boolean; text: string }> => {
    const sections = parseMetricsArgs(arg);
    if (!sections) {
      return {
        ok: false,
        text: chalk.red(`unknown metrics section: ${arg?.trim()}\nusage: ${METRICS_USAGE}`),
      };
    }
    let rows: Record<string, unknown>[];
    try {
      rows = extractRows(await session.execute("SELECT * FROM system:metrics"));
    } catch (err) {
      return {
        ok: false,
        text: chalk.red(`Cannot read system metrics: ${(err as Error).message}`),
      };
    }
    if (isExporterDisabled(rows)) {
      return {
        ok: false,
        text: chalk.yellow(
          "System metrics are disabled for this session (the SDK's metrics exporter was not enabled at startup).",
        ),
      };
    }
    const firstRead = reads === 0;
    reads++;
    const selected = buildSections(rows).filter((s) => sections.includes(s.id));
    return {
      ok: true,
      text: renderMetrics(selected, { maxWidth: maxWidth(), firstRead, readAt: opts.now?.() }),
    };
  };
}
