/**
 * Parser for the SDK's `system:metrics` virtual collection (SDK 5.1+).
 *
 * Facts verified against SDK 5.2.0 (and the Ditto VS Code extension's
 * SystemMetricsService):
 *  - The exporter is startup-gated by the `metrics_exporter_virtual_collection_enabled`
 *    system parameter (see DittoSession.open). When off, the collection
 *    returns a single placeholder row `{ status: "disabled", description }`.
 *  - Counter/gauge rows carry `current` (running value since SDK start) and
 *    `delta` (change since the previous read).
 *  - Histogram rows carry running `count`/`sum` and all-time `abs_max`, plus
 *    `dcount`/`dsum` and window stats `p50/p90/p95/p99/min/max` that cover only
 *    the samples since the previous read (absent when nothing new arrived).
 *  - Every read flushes the deltas, so `delta` is "since the last read".
 *  - A labelled metric is emitted as an unlabelled aggregate parent plus one
 *    row per label set (e.g. `fsync_total` + `{db:"main"}` + `{db:"attachment"}`).
 *  - Every `dql.*` series is a legacy alias of a `ditto.query.*` series.
 */

export type MetricKind = "counter" | "histogram";

export interface MetricSeries {
  key: string;
  labels: Record<string, string>;
  description: string;
  /** `count`, `seconds`, `bytes`, … as reported by the SDK. */
  unit: string;
  kind: MetricKind;
  /** Counter: `current`. Histogram: number of observations (`count`). */
  total: number;
  /** Change since the previous read. Counter: `delta`. Histogram: `dcount`. */
  delta: number;
  /** Histogram only: running sum and mean since the session opened. */
  sum?: number;
  avg?: number;
  /** Histogram only: largest observation since the session opened (`abs_max`). */
  peak?: number;
  /** Histogram only: percentiles and max of the samples since the previous read. */
  p50?: number;
  p90?: number;
  p99?: number;
  max?: number;
}

/** One display row: an aggregate series and its labelled breakdown. */
export interface MetricGroup {
  key: string;
  /** Unlabelled aggregate; absent for labelled-only metrics. */
  series?: MetricSeries;
  /** Labelled series, sorted by label text. */
  children: MetricSeries[];
}

export interface MetricSection {
  id: SectionId;
  label: string;
  counters: MetricGroup[];
  histograms: MetricGroup[];
}

export type SectionId =
  | "store"
  | "query"
  | "network"
  | "sync"
  | "transport"
  | "discovery"
  | "peer"
  | "other";

/** Section routing by key prefix (same topics as the VS Code extension). */
const SECTION_PREFIXES: readonly (readonly [SectionId, string, readonly string[]])[] = [
  [
    "store",
    "Store",
    [
      "ditto.backend.",
      "ditto.store.",
      "ditto.small_peer_info.",
      "ditto.storage.",
      "ditto.blob_storage.",
      "ditto.blob_storage_tiered.",
    ],
  ],
  ["query", "Query (DQL)", ["ditto.query.", "dql."]],
  ["network", "Network", ["ditto.network."]],
  [
    "sync",
    "Sync",
    [
      "ditto.sync.",
      "ditto.replication.",
      "ditto.diffcaster.",
      "ditto.riblt.",
      "ditto.presence.",
      "ditto.stream.",
    ],
  ],
  [
    "transport",
    "Transport",
    [
      "ditto.transport.",
      "ditto.multiplexer.",
      "ditto.multicast.",
      "ditto.multicast_attachment.",
      "ditto._tcp.",
    ],
  ],
  ["discovery", "Discovery", ["ditto.discovery."]],
  ["peer", "Peer", ["ditto.peer."]],
];

export const SECTION_IDS: readonly SectionId[] = [...SECTION_PREFIXES.map(([id]) => id), "other"];

export function sectionOf(key: string): SectionId {
  for (const [id, , prefixes] of SECTION_PREFIXES) {
    if (prefixes.some((p) => key.startsWith(p))) return id;
  }
  return "other";
}

function sectionLabel(id: SectionId): string {
  return SECTION_PREFIXES.find(([s]) => s === id)?.[1] ?? "Other";
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** True when the exporter isn't installed: only the `{ status: "disabled" }` placeholder. */
export function isExporterDisabled(rows: Record<string, unknown>[]): boolean {
  return (
    rows.length > 0 &&
    rows.every((r) => typeof r.key !== "string") &&
    rows.some((r) => r.status === "disabled")
  );
}

/** Parse one row; undefined for placeholder/garbage rows. */
export function parseMetricRow(row: Record<string, unknown>): MetricSeries | undefined {
  if (typeof row.key !== "string" || row.key.length === 0) return undefined;
  const labels: Record<string, string> = {};
  if (row.labels && typeof row.labels === "object" && !Array.isArray(row.labels)) {
    for (const [k, v] of Object.entries(row.labels as Record<string, unknown>)) {
      if (typeof v === "string") labels[k] = v;
    }
  }
  const base = {
    key: row.key,
    labels,
    description: typeof row.description === "string" ? row.description : "",
    unit: typeof row.unit === "string" ? row.unit : "",
  };
  const isHistogram = num(row.count) !== undefined || num(row.dcount) !== undefined;
  if (!isHistogram) {
    return { ...base, kind: "counter", total: num(row.current) ?? 0, delta: num(row.delta) ?? 0 };
  }
  const count = num(row.count) ?? 0;
  const sum = num(row.sum);
  return {
    ...base,
    kind: "histogram",
    total: count,
    delta: num(row.dcount) ?? 0,
    ...(sum !== undefined ? { sum } : {}),
    ...(sum !== undefined && count > 0 ? { avg: sum / count } : {}),
    ...optional("peak", num(row.abs_max)),
    ...optional("p50", num(row.p50)),
    ...optional("p90", num(row.p90)),
    ...optional("p99", num(row.p99)),
    ...optional("max", num(row.max)),
  };
}

function optional<K extends string>(k: K, v: number | undefined): Partial<Record<K, number>> {
  return v === undefined ? {} : ({ [k]: v } as Record<K, number>);
}

export function labelText(labels: Record<string, string>): string {
  return Object.keys(labels)
    .sort()
    .map((k) => `${k}=${labels[k]}`)
    .join(" ");
}

/**
 * Parse rows into sections (in SECTION_IDS order), dropping `dql.*` aliases
 * of `ditto.query.*` series and grouping labelled children under their
 * aggregate. Empty sections are omitted.
 */
export function buildSections(rows: Record<string, unknown>[]): MetricSection[] {
  const series = rows.map(parseMetricRow).filter((s): s is MetricSeries => s !== undefined);
  const keys = new Set(series.map((s) => s.key));
  const deduped = series.filter(
    (s) => !(s.key.startsWith("dql.") && keys.has(`ditto.query.${s.key.slice(4)}`)),
  );

  const groups = new Map<string, MetricGroup & { kind: MetricKind }>();
  for (const s of deduped) {
    let g = groups.get(s.key);
    if (!g) {
      g = { key: s.key, kind: s.kind, children: [] };
      groups.set(s.key, g);
    }
    if (Object.keys(s.labels).length === 0) g.series = s;
    else g.children.push(s);
  }

  const sections = new Map<SectionId, MetricSection>();
  for (const g of [...groups.values()].sort((a, b) => a.key.localeCompare(b.key))) {
    g.children.sort((a, b) => labelText(a.labels).localeCompare(labelText(b.labels)));
    const id = sectionOf(g.key);
    let section = sections.get(id);
    if (!section) {
      section = { id, label: sectionLabel(id), counters: [], histograms: [] };
      sections.set(id, section);
    }
    const { kind, ...group } = g;
    (kind === "histogram" ? section.histograms : section.counters).push(group);
  }
  return SECTION_IDS.flatMap((id) => sections.get(id) ?? []);
}
