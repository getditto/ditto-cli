import fs from "node:fs";
import path from "node:path";
import stringWidth from "string-width";
import { describe, expect, it } from "vitest";
import {
  METRICS_USAGE,
  makeMetricsCommand,
  parseMetricsArgs,
} from "../../src/cli/groups/dql/metrics.js";
import { dotHelp } from "../../src/cli/groups/dql/repl-core.js";
import type { QueryExecutor } from "../../src/ditto/session.js";
import {
  buildSections,
  isExporterDisabled,
  parseMetricRow,
  SECTION_IDS,
  sectionOf,
} from "../../src/metrics/system-metrics.js";
import {
  formatBytes,
  formatSeconds,
  formatValue,
  renderMetrics,
} from "../../src/render/metrics.js";

// Real `SELECT * FROM system:metrics` rows from SDK 5.2.0 (see the fixture's note).
const fixture = JSON.parse(
  fs.readFileSync(path.join(import.meta.dirname, "fixtures", "system-metrics.json"), "utf8"),
) as Record<"afterActivity" | "idle" | "disabled", Record<string, unknown>[]>;

const rowsOf = (rows: Record<string, unknown>[]) =>
  ({ items: rows.map((value) => ({ value })) }) as unknown as Awaited<
    ReturnType<QueryExecutor["execute"]>
  >;

const fakeSession = (next: () => Record<string, unknown>[] | Error): QueryExecutor => ({
  execute: async () => {
    const r = next();
    if (r instanceof Error) throw r;
    return rowsOf(r);
  },
});

describe("parseMetricRow", () => {
  it("parses a counter: current is the total, delta the change since the last read", () => {
    const s = parseMetricRow({
      key: "ditto.query.requests",
      labels: {},
      current: 323,
      delta: 322,
      unit: "count",
      description: "Number of DQL requests processed",
    })!;
    expect(s).toMatchObject({ kind: "counter", total: 323, delta: 322, unit: "count" });
    expect(s.description).toContain("DQL requests");
  });

  it("parses a histogram: running count/sum/abs_max plus since-last-read window stats", () => {
    const s = parseMetricRow({
      key: "ditto.query.parse_time",
      count: 4,
      sum: 0.2,
      abs_max: 0.1,
      dcount: 1,
      p50: 0.01,
      p90: 0.02,
      p99: 0.03,
      max: 0.04,
      unit: "seconds",
      labels: { a: "x", ignored: 3 },
    })!;
    expect(s).toMatchObject({
      kind: "histogram",
      total: 4,
      delta: 1,
      sum: 0.2,
      avg: 0.05,
      peak: 0.1,
      p50: 0.01,
      p90: 0.02,
      p99: 0.03,
      max: 0.04,
      labels: { a: "x" },
    });
  });

  it("omits window stats that weren't reported and avg when count is zero", () => {
    const s = parseMetricRow({ key: "k", count: 0, dcount: 0, sum: 0 })!;
    expect(s.avg).toBeUndefined();
    expect(s.p50).toBeUndefined();
    expect(s.max).toBeUndefined();
  });

  it("rejects placeholder and keyless rows", () => {
    expect(parseMetricRow(fixture.disabled[0]!)).toBeUndefined();
    expect(parseMetricRow({ key: "" })).toBeUndefined();
  });
});

describe("isExporterDisabled", () => {
  it("detects the real disabled placeholder", () => {
    expect(isExporterDisabled(fixture.disabled)).toBe(true);
  });
  it("is false for real metric rows and for an empty result", () => {
    expect(isExporterDisabled(fixture.afterActivity)).toBe(false);
    expect(isExporterDisabled([])).toBe(false);
  });
});

describe("buildSections", () => {
  const sections = buildSections(fixture.afterActivity);
  const byId = Object.fromEntries(sections.map((s) => [s.id, s]));

  it("routes keys to sections in display order", () => {
    expect(sections.map((s) => s.id)).toEqual(
      SECTION_IDS.filter((id) => sections.some((s) => s.id === id)),
    );
    expect(sectionOf("ditto.backend.sqlite3.fsync_total")).toBe("store");
    expect(sectionOf("ditto.storage.total_bytes")).toBe("store");
    expect(sectionOf("dql.requests")).toBe("query");
    expect(sectionOf("ditto.multicast.x")).toBe("transport");
    expect(sectionOf("ditto.metrics.self")).toBe("other");
  });

  it("drops dql.* aliases of ditto.query.* series", () => {
    const keys = [...byId.query!.counters, ...byId.query!.histograms].map((g) => g.key);
    expect(keys).toContain("ditto.query.requests");
    expect(keys.some((k) => k.startsWith("dql."))).toBe(false);
  });

  it("keeps a dql.* series that has no ditto.query.* twin", () => {
    const [query] = buildSections([{ key: "dql.only_legacy", current: 1, delta: 1 }]);
    expect(query?.counters.map((g) => g.key)).toEqual(["dql.only_legacy"]);
  });

  it("groups labelled series under their aggregate, sorted by label", () => {
    const fsync = byId.store!.counters.find((g) => g.key === "ditto.backend.sqlite3.fsync_total")!;
    expect(fsync.series?.total).toBe(9);
    expect(fsync.children.map((c) => c.labels.db)).toEqual(["attachment", "main"]);
  });

  it("splits counters from histograms", () => {
    expect(byId.store!.histograms.some((g) => g.key.endsWith("txn_duration_secs"))).toBe(true);
    expect(byId.store!.counters.some((g) => g.key.endsWith("txn_duration_secs"))).toBe(false);
  });

  it("keeps labelled-only metrics (no aggregate parent)", () => {
    const [section] = buildSections([
      { key: "ditto.store.x", labels: { db: "b" }, current: 2, delta: 0 },
      { key: "ditto.store.x", labels: { db: "a" }, current: 1, delta: 0 },
    ]);
    const g = section!.counters[0]!;
    expect(g.series).toBeUndefined();
    expect(g.children.map((c) => c.labels.db)).toEqual(["a", "b"]);
  });
});

describe("value formatting", () => {
  it("scales seconds to three significant digits", () => {
    expect(formatSeconds(0)).toBe("0");
    expect(formatSeconds(4.2e-7)).toBe("420 ns");
    expect(formatSeconds(0.0001486)).toBe("149 µs");
    expect(formatSeconds(0.00002243)).toBe("22.4 µs");
    expect(formatSeconds(0.001094)).toBe("1.09 ms");
    expect(formatSeconds(2.5)).toBe("2.50 s");
  });

  it("scales bytes", () => {
    expect(formatBytes(799)).toBe("799 B");
    expect(formatBytes(6_750)).toBe("6.59 KB");
    expect(formatBytes(10_312_392)).toBe("9.83 MB");
    expect(formatBytes(5 * 1024 ** 4)).toBe("5.00 TB");
  });

  it("groups counts and trims fractions", () => {
    expect(formatValue(1279, "count")).toBe("1,279");
    expect(formatValue(2.07, "count")).toBe("2.07");
    expect(formatValue(26.33, "count")).toBe("26.3");
    expect(formatValue(1242.1, "count")).toBe("1,242");
  });
});

describe("renderMetrics", () => {
  const storeAndQuery = buildSections(fixture.afterActivity).filter(
    (s) => s.id === "store" || s.id === "query",
  );

  it("renders counter and timing tables with two-level headers and namespace rows", () => {
    const out = renderMetrics(storeAndQuery, {
      firstRead: true,
      readAt: new Date("2026-11-06T10:45:12"),
    });
    expect(out).toContain("System metrics");
    expect(out).toContain("Store, Query (DQL)");
    expect(out).toContain("read 10:45:12");
    expect(out).toContain("first read this session");
    for (const title of [
      "Store · counters",
      "Store · timings & distributions",
      "Query (DQL) · counters",
      "Query (DQL) · timings & distributions",
    ]) {
      expect(out).toContain(title);
    }
    expect(out).toContain("since session opened");
    expect(out).toContain("since last .metrics");
    expect(out).toMatch(/│ backend\.sqlite3 +│/); // namespace header row
    expect(out).toMatch(/│ {3}fsync_total +│ +9 │/); // leaf under it
    expect(out).toMatch(/│ {5}└ db=main +│ +3 │/); // labelled breakdown
    expect(out).toMatch(/│ {3}requests +│ +323 │ +\+322 │/);
    expect(out).toMatch(/execution_time +│ +321 │ +128 µs │/);
    expect(out).toContain("9.83 MB");
    expect(out).toContain("—"); // window stats absent for fsync (no new samples)
  });

  it("gives every table the same width for the name column", () => {
    const out = renderMetrics(storeAndQuery);
    const nameCols = out
      .split("\n")
      .filter((l) => l.startsWith("┌"))
      .map((l) => l.indexOf("┬"));
    expect(new Set(nameCols).size).toBe(1);
  });

  it("fits the terminal width by ellipsizing metric names", () => {
    const out = renderMetrics(storeAndQuery, { maxWidth: 110 });
    const tableLines = out.split("\n").filter((l) => /^[┌├│└]/.test(l));
    expect(Math.max(...tableLines.map((l) => stringWidth(l)))).toBeLessThanOrEqual(110);
    expect(out).toContain("…");
  });

  it("never shrinks names below the floor on very narrow terminals", () => {
    const out = renderMetrics(storeAndQuery, { maxWidth: 40 });
    expect(out).toMatch(/│ backend\.sqlite3 +│/);
  });

  it("shows negative changes and leaves labelled-only parents blank", () => {
    const out = renderMetrics(
      buildSections([
        { key: "ditto.store.size", current: 10, delta: -4, unit: "bytes" },
        { key: "ditto.store.x", labels: { db: "a" }, current: 1, delta: 0 },
      ]),
    );
    expect(out).toContain("−4 B");
    expect(out).toMatch(/│ {3}x +│ +│ +│/);
  });

  it("says so when the selection has no metrics", () => {
    expect(renderMetrics([])).toContain("no metrics reported");
  });
});

describe(".metrics command", () => {
  it("parses section arguments", () => {
    expect(parseMetricsArgs(undefined)).toEqual(["store", "query"]);
    expect(parseMetricsArgs("  ")).toEqual(["store", "query"]);
    expect(parseMetricsArgs("QUERY")).toEqual(["query"]);
    expect(parseMetricsArgs("query, store")).toEqual(["store", "query"]);
    expect(parseMetricsArgs("all")).toEqual(SECTION_IDS);
    expect(parseMetricsArgs("bogus")).toBeUndefined();
    expect(METRICS_USAGE).toContain("all");
  });

  it("notes the first read only once and renders the selected sections", async () => {
    const reads = [fixture.afterActivity, fixture.idle];
    const cmd = makeMetricsCommand(
      fakeSession(() => reads.shift()!),
      { maxWidth: () => undefined },
    );
    const first = await cmd();
    expect(first.ok).toBe(true);
    expect(first.text).toContain("first read this session");
    expect(first.text).toContain("Store · counters");
    const second = await cmd("query");
    expect(second.text).not.toContain("first read this session");
    expect(second.text).not.toContain("Store ·");
    expect(second.text).toContain("Query (DQL) · counters");
  });

  it("uses the terminal width by default", async () => {
    const cmd = makeMetricsCommand(fakeSession(() => fixture.afterActivity));
    expect((await cmd()).ok).toBe(true);
  });

  it("rejects unknown sections without querying", async () => {
    let calls = 0;
    const cmd = makeMetricsCommand(
      fakeSession(() => {
        calls++;
        return [];
      }),
    );
    const r = await cmd("bogus");
    expect(r.ok).toBe(false);
    expect(r.text).toContain("unknown metrics section: bogus");
    expect(r.text).toContain("usage: .metrics");
    expect(calls).toBe(0);
  });

  it("explains a disabled exporter", async () => {
    const r = await makeMetricsCommand(fakeSession(() => fixture.disabled))();
    expect(r.ok).toBe(false);
    expect(r.text).toContain("System metrics are disabled");
  });

  it("reports query failures", async () => {
    const r = await makeMetricsCommand(fakeSession(() => new Error("boom")))();
    expect(r.ok).toBe(false);
    expect(r.text).toContain("Cannot read system metrics: boom");
  });

  it("is listed in .help", () => {
    expect(dotHelp()).toContain(".metrics");
  });
});
