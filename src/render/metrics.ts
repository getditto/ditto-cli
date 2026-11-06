import chalk from "chalk";
import stringWidth from "string-width";
import {
  labelText,
  type MetricGroup,
  type MetricSection,
  type MetricSeries,
} from "../metrics/system-metrics.js";
import { stripControlChars } from "./sanitize.js";

/** The metric-name column never shrinks below this when fitting the terminal. */
const MIN_NAME_WIDTH = 24;

const SINCE_OPEN = "since session opened";
const SINCE_LAST = "since last .metrics";

export interface RenderMetricsOptions {
  /** Terminal width to fit; undefined = never truncate names. */
  maxWidth?: number;
  /** First read of the session: "since last .metrics" covers the whole session. */
  firstRead?: boolean;
  /** Wall-clock time of the read (header). */
  readAt?: Date;
}

interface Column {
  header: string;
  /** Spanning header above contiguous columns sharing the same group. */
  group?: string;
}

interface Row {
  name: string;
  /** namespace header · metric leaf · labelled breakdown */
  kind: "ns" | "metric" | "child";
  cells: string[];
}

interface Table {
  title: string;
  columns: Column[];
  rows: Row[];
}

/**
 * System metrics as boxed tables. Per section: a counters table (total since
 * the session opened, change since the last read) and a timings table for
 * histograms, whose two header groups keep the SDK's two windows apart —
 * Count/Avg/Peak run since the session opened, while New/p50/p90/p99/Max
 * cover only the samples since the previous read. Labelled breakdowns render
 * as indented `└ label=value` rows under their aggregate. Every table shares
 * one name-column width so the sections line up.
 */
export function renderMetrics(sections: MetricSection[], opts: RenderMetricsOptions = {}): string {
  const out: string[] = [];
  const readAt = (opts.readAt ?? new Date()).toLocaleTimeString("en-US", { hour12: false });
  const names = sections.map((s) => s.label).join(", ") || "none";
  out.push(`${chalk.bold("System metrics")} ${chalk.dim(`· ${names} · read ${readAt}`)}`);
  if (opts.firstRead) {
    out.push(chalk.dim(`first read this session — "${SINCE_LAST}" covers the whole session`));
  }
  if (sections.length === 0) {
    out.push("", chalk.dim("(no metrics reported for this selection yet)"));
    return out.join("\n");
  }

  const tables: Table[] = sections.flatMap((section) => [
    ...(section.counters.length > 0 ? [counterTable(section)] : []),
    ...(section.histograms.length > 0 ? [histogramTable(section)] : []),
  ]);

  const valueWidths = tables.map((t) => columnWidths(t).slice(1));
  let nameWidth = Math.max(
    ...tables.flatMap((t) => t.rows.map((r) => stringWidth(nameText(r)))),
    6,
  );
  if (opts.maxWidth !== undefined) {
    const room = Math.min(...valueWidths.map((w) => opts.maxWidth! - tableChrome(w)));
    nameWidth = Math.max(MIN_NAME_WIDTH, Math.min(nameWidth, room));
  }

  tables.forEach((t, i) => {
    out.push("", chalk.bold.cyan(t.title), box(t, [nameWidth, ...valueWidths[i]!]));
  });

  out.push(
    "",
    chalk.dim(
      `Total, Count, Avg, Peak = ${SINCE_OPEN} · Change, New, p50–p99, Max = ${SINCE_LAST}`,
    ),
  );
  return out.join("\n");
}

function counterTable(section: MetricSection): Table {
  return {
    title: `${section.label} · counters`,
    columns: [
      { header: "Metric" },
      { header: "Total", group: SINCE_OPEN },
      { header: "Change", group: SINCE_LAST },
    ],
    rows: groupRows(section.counters, (s) => [formatValue(s.total, s.unit), formatChange(s)]),
  };
}

function histogramTable(section: MetricSection): Table {
  const value = (s: MetricSeries, v: number | undefined) =>
    v === undefined ? chalk.dim("—") : formatValue(v, s.unit);
  return {
    title: `${section.label} · timings & distributions`,
    columns: [
      { header: "Metric" },
      { header: "Count", group: SINCE_OPEN },
      { header: "Avg", group: SINCE_OPEN },
      { header: "Peak", group: SINCE_OPEN },
      { header: "New", group: SINCE_LAST },
      { header: "p50", group: SINCE_LAST },
      { header: "p90", group: SINCE_LAST },
      { header: "p99", group: SINCE_LAST },
      { header: "Max", group: SINCE_LAST },
    ],
    rows: groupRows(section.histograms, (s) => [
      formatValue(s.total, "count"),
      value(s, s.avg),
      value(s, s.peak),
      formatChange(s),
      value(s, s.p50),
      value(s, s.p90),
      value(s, s.p99),
      value(s, s.max),
    ]),
  };
}

/**
 * Rows grouped by namespace: a `backend.sqlite3` header, then indented leaf
 * metrics (`fsync_total`), then their labelled breakdowns (`└ db=main`).
 */
function groupRows(groups: MetricGroup[], cells: (s: MetricSeries) => string[]): Row[] {
  const rows: Row[] = [];
  let currentNs: string | undefined;
  for (const g of groups) {
    const first = g.series ?? g.children[0];
    if (!first) continue;
    const blank = cells(first).map(() => "");
    const { ns, leaf } = splitKey(g.key);
    if (ns !== currentNs) {
      rows.push({ name: ns, kind: "ns", cells: blank });
      currentNs = ns;
    }
    rows.push({ name: leaf, kind: "metric", cells: g.series ? cells(g.series) : blank });
    for (const c of g.children) {
      rows.push({
        name: `└ ${stripControlChars(labelText(c.labels))}`,
        kind: "child",
        cells: cells(c),
      });
    }
  }
  return rows;
}

/** `ditto.backend.sqlite3.fsync_total` → ns `backend.sqlite3`, leaf `fsync_total`. */
function splitKey(key: string): { ns: string; leaf: string } {
  const name = stripControlChars(key.startsWith("ditto.") ? key.slice("ditto.".length) : key);
  const dot = name.lastIndexOf(".");
  return dot === -1
    ? { ns: name, leaf: name }
    : { ns: name.slice(0, dot), leaf: name.slice(dot + 1) };
}

function nameText(r: Row): string {
  return (r.kind === "ns" ? "" : r.kind === "metric" ? "  " : "    ") + r.name;
}

/** Natural widths: each column fits its header, its rows, and its share of the group label. */
function columnWidths(t: Table): number[] {
  const widths = t.columns.map((c, i) =>
    Math.max(
      stringWidth(c.header),
      ...t.rows.map((r) => stringWidth(i === 0 ? nameText(r) : (r.cells[i - 1] ?? ""))),
    ),
  );
  // Widen the last column of a group until the spanning label fits.
  for (const span of groupSpans(t.columns)) {
    const inner = span.indexes.reduce((a, i) => a + widths[i]!, 0) + 3 * (span.indexes.length - 1);
    const need = stringWidth(span.label) - inner;
    const last = span.indexes[span.indexes.length - 1]!;
    if (need > 0) widths[last]! += need;
  }
  return widths;
}

/** Border/padding columns around `valueWidths` plus the name column. */
function tableChrome(valueWidths: number[]): number {
  return valueWidths.reduce((a, b) => a + b, 0) + 3 * (valueWidths.length + 1) + 1;
}

function groupSpans(columns: Column[]): { label: string; indexes: number[] }[] {
  const spans: { label: string; indexes: number[] }[] = [];
  columns.forEach((c, i) => {
    const prev = spans[spans.length - 1];
    if (c.group && prev?.label === c.group && prev.indexes.at(-1) === i - 1) prev.indexes.push(i);
    else if (c.group) spans.push({ label: c.group, indexes: [i] });
  });
  return spans;
}

function box(t: Table, widths: number[]): string {
  const bar = chalk.dim("│");
  const pad = (text: string, w: number, right: boolean) => {
    const gap = Math.max(0, w - stringWidth(text));
    return right ? " ".repeat(gap) + text : text + " ".repeat(gap);
  };
  const row = (cells: string[]) =>
    `${bar} ${cells.map((c, i) => pad(c, widths[i]!, i > 0)).join(` ${bar} `)} ${bar}`;

  // Group header: the name cell is blank; each span is centered over its columns.
  const spans = groupSpans(t.columns);
  const groupCells: string[] = [];
  const joins: string[] = []; // separator after each emitted cell: "┬" between spans, "─" inside
  let i = 0;
  while (i < widths.length) {
    const span = spans.find((s) => s.indexes[0] === i);
    if (span) {
      const w = span.indexes.reduce((a, j) => a + widths[j]!, 0) + 3 * (span.indexes.length - 1);
      const label = span.label;
      const left = Math.floor((w - stringWidth(label)) / 2);
      groupCells.push(
        chalk.dim(" ".repeat(left) + label + " ".repeat(w - left - stringWidth(label))),
      );
      i += span.indexes.length;
    } else {
      groupCells.push(" ".repeat(widths[i]!));
      i++;
    }
    joins.push("┬");
  }
  const spanWidths: number[] = [];
  i = 0;
  while (i < widths.length) {
    const span = spans.find((s) => s.indexes[0] === i);
    const n = span ? span.indexes.length : 1;
    spanWidths.push(widths.slice(i, i + n).reduce((a, b) => a + b, 0) + 3 * (n - 1));
    i += n;
  }

  const out: string[] = [];
  out.push(chalk.dim(`┌${spanWidths.map((w) => "─".repeat(w + 2)).join("┬")}┐`));
  out.push(`${bar} ${groupCells.join(` ${bar} `)} ${bar}`);
  // Under the group row: "┼" where a span boundary continues, "┬" where a span splits.
  const boundaries = new Set<number>();
  let acc = 0;
  for (const w of spanWidths.slice(0, -1)) {
    acc += w + 3;
    boundaries.add(acc);
  }
  let mid = "├";
  let pos = 0;
  widths.forEach((w, j) => {
    mid += "─".repeat(w + 2);
    pos += w + 3;
    if (j < widths.length - 1) mid += boundaries.has(pos) ? "┼" : "┬";
  });
  out.push(chalk.dim(`${mid}┤`));
  out.push(row(t.columns.map((c) => chalk.bold(c.header))));
  out.push(chalk.dim(`├${widths.map((w) => "─".repeat(w + 2)).join("┼")}┤`));
  for (const r of t.rows) {
    const name = ellipsize(nameText(r), widths[0]!);
    const styled = r.kind === "ns" ? chalk.bold(name) : r.kind === "child" ? chalk.dim(name) : name;
    out.push(row([styled, ...r.cells]));
  }
  out.push(chalk.dim(`└${widths.map((w) => "─".repeat(w + 2)).join("┴")}┘`));
  return out.join("\n");
}

function ellipsize(s: string, w: number): string {
  if (stringWidth(s) <= w) return s;
  let out = "";
  for (const ch of s) {
    if (stringWidth(out + ch) > w - 1) break;
    out += ch;
  }
  return `${out}…`;
}

function formatChange(s: MetricSeries): string {
  if (s.delta === 0) return chalk.dim("0");
  const unit = s.kind === "histogram" ? "count" : s.unit;
  const value = formatValue(Math.abs(s.delta), unit);
  return s.delta > 0 ? chalk.green(`+${value}`) : chalk.yellow(`−${value}`);
}

/** Unit-aware value: seconds → ns/µs/ms/s, bytes → B/KB/MB/GB, else grouped numbers. */
export function formatValue(n: number, unit: string): string {
  if (unit === "seconds") return formatSeconds(n);
  if (unit === "bytes") return formatBytes(n);
  if (Number.isInteger(n)) return n.toLocaleString("en-US");
  const a = Math.abs(n);
  if (a < 10) return n.toFixed(2);
  return n.toLocaleString("en-US", { maximumFractionDigits: a < 100 ? 1 : 0 });
}

export function formatSeconds(s: number): string {
  const a = Math.abs(s);
  if (a === 0) return "0";
  if (a < 1e-6) return `${(s * 1e9).toFixed(0)} ns`;
  if (a < 1e-3) return `${sig3(s * 1e6)} µs`;
  if (a < 1) return `${sig3(s * 1e3)} ms`;
  return `${sig3(s)} s`;
}

/** Three significant digits: 148.6 → "149", 22.43 → "22.4", 1.094 → "1.09". */
function sig3(v: number): string {
  const a = Math.abs(v);
  return v.toFixed(a >= 99.95 ? 0 : a >= 9.995 ? 1 : 2);
}

export function formatBytes(b: number): string {
  const a = Math.abs(b);
  if (a < 1024) return `${Math.round(b)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = b / 1024;
  let i = 0;
  while (Math.abs(v) >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${sig3(v)} ${units[i]}`;
}
