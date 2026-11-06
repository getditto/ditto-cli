import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { formatNs, percentOfTotal } from "../../src/profile/format.js";
import {
  annotatePlan,
  HOTSPOT_THRESHOLD,
  keyAttribute,
  subtreeExecNs,
} from "../../src/profile/hotspots.js";
import { extractProfile, type PlanNode, parseProfileItem } from "../../src/profile/parse.js";
import { renderProfile } from "../../src/render/profile.js";

// Real envelopes captured from SDK 5.2.0 (scripts/spike-c.mjs): [0] filtered
// SELECT, [1] sorted SELECT, [2] JOIN with an `nlJoin.inner` subplan. `envelope` is
// the result-row object: `{ "~request_profile": { … } }`.
const fixture = JSON.parse(
  fs.readFileSync(path.join(import.meta.dirname, "fixtures", "profile-envelope.json"), "utf8"),
) as {
  profiles: { query: string; itemCount: number; envelope: Record<string, unknown> | null }[];
  explain: Record<string, unknown>;
};

const wrappedRow = fixture.profiles[0]!.envelope!;
const bareEnvelope = wrappedRow["~request_profile"] as Record<string, unknown>;
const joinRow = fixture.profiles[2]!.envelope!;

describe("parseProfileItem (real SDK 5.2.0 envelope)", () => {
  it("parses the wrapped form", () => {
    const p = parseProfileItem(wrappedRow)!;
    expect(p.id).toBeTruthy();
    expect(p.appId).toBeTruthy();
    expect(p.queryType).toBe("select");
    expect(p.state).toBe("completed");
    expect(p.resultCount).toBeGreaterThan(0);
    expect(p.times.elapsedNs).toBeGreaterThan(0);
    expect(p.times.parseNs).toBeGreaterThan(0);
    expect(p.times.planNs).toBeGreaterThan(0);
    expect(p.plan?.name).toBe("sequence");
    expect(p.plan?.children.length).toBeGreaterThan(0);
  });

  it("parses the bare form via marker keys", () => {
    const p = parseProfileItem(bareEnvelope)!;
    expect(p.id).toBeTruthy();
  });

  it("does not false-positive on user docs with only `text`", () => {
    expect(parseProfileItem({ text: "PROFILE SELECT * FROM movies" })).toBeUndefined();
    expect(parseProfileItem({ _id: "1", title: "Alien" })).toBeUndefined();
    expect(parseProfileItem(null)).toBeUndefined();
    expect(parseProfileItem("string")).toBeUndefined();
  });

  it("bare form requires a times object + another marker (state-only rows are user data)", () => {
    expect(parseProfileItem({ _id: "b", state: "done" })).toBeUndefined();
    expect(parseProfileItem({ times: { elapsed: 100 }, state: "completed" })).toBeDefined();
  });

  it("tolerates null children in the plan tree", () => {
    const p = parseProfileItem({
      "~request_profile": {
        times: { elapsed: 1 },
        state: "completed",
        plan: { "#operator": "sequence", children: [null, { "#operator": "scan" }] },
      },
    })!;
    expect(p.plan?.children).toHaveLength(1);
    expect(p.plan?.children[0]?.name).toBe("scan");
  });

  it("parses operator stats and attributes", () => {
    const p = parseProfileItem(wrappedRow)!;
    const scan = p.plan!.children.find((c) => c.name === "scan")!;
    expect(scan.stats?.documentsOut).toBeGreaterThan(0);
    expect(scan.attributes.find(([k]) => k === "collection")).toEqual(["collection", "movies"]);
    // reserved keys never leak into attributes
    expect(scan.attributes.map(([k]) => k)).not.toContain("#stats");
    expect(scan.attributes.map(([k]) => k)).not.toContain("children");
  });
});

describe("parseProfileItem (SDK 5.1+ stats: stor, yields, skipped, subplans)", () => {
  const withStats = (stats: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    parseProfileItem({
      "~request_profile": {
        times: { elapsed: 1 },
        state: "completed",
        plan: { "#operator": "fetch", "#stats": stats, ...extra },
      },
    })!.plan!;

  it("parses stor phase time and documentsSkipped", () => {
    const node = withStats({ documentsSkipped: 3, phaseTimes: { exec: 1, stor: 42 } });
    expect(node.stats?.phaseTimes?.stor).toBe(42);
    expect(node.stats?.documentsSkipped).toBe(3);
  });

  it("keeps non-zero yield counters (including unknown reasons) and drops zeros", () => {
    const node = withStats({ yields: { budget: 61, sender: 0, receiver: 1, future: 2, bad: "x" } });
    expect(node.stats?.yields).toEqual({ budget: 61, receiver: 1, future: 2 });
  });

  it("leaves yields undefined when every counter is zero or missing", () => {
    expect(withStats({ yields: { budget: 0 } }).stats?.yields).toBeUndefined();
    expect(withStats({ yields: null }).stats?.yields).toBeUndefined();
    expect(withStats({ documentsOut: 1 }).stats?.yields).toBeUndefined();
  });

  it("treats object-valued fields with #operator as labeled subplans, not attributes", () => {
    const node = withStats({}, { inner: { "#operator": "scan" }, desc: { index: "i" } });
    expect(node.subplans).toEqual([
      { key: "inner", plan: expect.objectContaining({ name: "scan" }) },
    ]);
    expect(node.attributes.map(([k]) => k)).toEqual(["desc"]);
  });

  it("parses envelope directives", () => {
    expect(parseProfileItem(wrappedRow)!.directives).toEqual({ "#profile": true });
  });

  it("parses the real nlJoin.inner subplan with stor + yields from SDK 5.2.0", () => {
    const p = parseProfileItem(joinRow)!;
    const join = p.plan!.children.find((c) => c.name === "nlJoin")!;
    expect(join.subplans?.[0]?.key).toBe("inner");
    expect(join.attributes.map(([k]) => k)).not.toContain("inner");
    const inner = join.subplans![0]!.plan;
    const fetch = inner.children.find((c) => c.name === "fetch")!;
    expect(fetch.stats?.phaseTimes?.stor).toBeGreaterThan(0);
    const yielded = annotatePlan(p.plan!).filter((n) => n.node.stats?.yields);
    expect(yielded.length).toBeGreaterThan(0);
  });
});

describe("extractProfile", () => {
  it("strips the envelope from the row set", () => {
    const rows = [{ _id: "1" }, wrappedRow];
    const { rows: stripped, profile } = extractProfile(rows);
    expect(stripped).toEqual([{ _id: "1" }]);
    expect(profile?.queryType).toBe("select");
  });

  it("passes through when no envelope present", () => {
    const rows = [{ _id: "1" }];
    expect(extractProfile(rows).profile).toBeUndefined();
    expect(extractProfile(rows).rows).toHaveLength(1);
  });
});

describe("formatNs (Edge Studio rules)", () => {
  it.each([
    [undefined, "—"],
    [209, "209 ns"],
    [55_555, "55.55 µs"], // 55.55499… in binary — toFixed(2) rounds down, same as Edge Studio
    [55_560, "55.56 µs"],
    [1_670_000, "1.67 ms"],
    [1_000, "1.00 µs"],
    [999, "999 ns"],
  ])("formats %s as %s", (input, expected) => {
    expect(formatNs(input)).toBe(expected);
  });
});

describe("percentOfTotal", () => {
  it("returns null below the 5% threshold", () => {
    expect(percentOfTotal(4, 100)).toBeNull();
    expect(percentOfTotal(5, 100)).toBe("5.0%");
  });
  it("null on zero/undefined inputs", () => {
    expect(percentOfTotal(undefined, 100)).toBeNull();
    expect(percentOfTotal(10, 0)).toBeNull();
  });
});

describe("hotspots", () => {
  const tree: PlanNode = {
    name: "sequence",
    attributes: [],
    stats: { phaseTimes: { exec: 0 } },
    children: [
      {
        name: "scan",
        attributes: [["collection", "movies"]],
        stats: { phaseTimes: { exec: 100 }, documentsOut: 50 },
        children: [],
      },
      {
        name: "filter",
        attributes: [["condition", "rated = PG"]],
        stats: { phaseTimes: { exec: 900 }, documentsIn: 50, documentsOut: 10 },
        children: [],
      },
    ],
  };

  it("computes subtree exec", () => {
    expect(subtreeExecNs(tree)).toBe(1000);
  });

  it("flags operators ≥ 50% of total exec as hotspots", () => {
    const annotated = annotatePlan(tree);
    expect(annotated.find((n) => n.node.name === "filter")?.isHotspot).toBe(true);
    expect(annotated.find((n) => n.node.name === "scan")?.isHotspot).toBe(false);
    expect(HOTSPOT_THRESHOLD).toBe(0.5);
  });

  it("includes subplans in subtree exec and labels them in the walk", () => {
    const join: PlanNode = {
      name: "nlJoin",
      attributes: [],
      stats: { phaseTimes: { exec: 10 } },
      children: [],
      subplans: [
        {
          key: "inner",
          plan: { name: "scan", attributes: [], stats: { phaseTimes: { exec: 90 } }, children: [] },
        },
      ],
    };
    expect(subtreeExecNs(join)).toBe(100);
    const annotated = annotatePlan(join);
    expect(annotated.map((n) => [n.node.name, n.depth, n.label])).toEqual([
      ["nlJoin", 0, undefined],
      ["scan", 1, "inner"],
    ]);
    expect(annotated[1]?.isHotspot).toBe(true);
  });

  it("keyAttribute prefers collection over condition", () => {
    expect(keyAttribute(tree.children[0]!)).toBe("collection=movies");
    expect(keyAttribute(tree.children[1]!)).toBe("condition=rated = PG");
    expect(keyAttribute({ name: "x", attributes: [], children: [] })).toBeUndefined();
  });
});

describe("renderProfile", () => {
  it("renders header, summary strip, plan tree, and legend from the real envelope", () => {
    const profile = parseProfileItem(wrappedRow)!;
    const out = renderProfile(profile, "SELECT * FROM movies WHERE rated = 'PG'");
    expect(out).toContain("Execution Profile");
    expect(out).toContain("Elapsed");
    expect(out).toContain("Parse");
    expect(out).toContain("Results");
    expect(out).toContain("Execution plan");
    expect(out).toContain("sequence");
    expect(out).toContain("filter");
    expect(out).toContain("collection=movies");
    expect(out).toContain("legend");
    expect(out).toContain("▲ HOT"); // filter dominates exec in this fixture
  });

  it("renders SDK 5.2.0 detail: phase times, yields, attributes, inner subplan, totals", () => {
    const profile = parseProfileItem(joinRow)!;
    const out = renderProfile(profile, "SELECT …");
    expect(out).toMatch(/directives #profile/);
    expect(out).toMatch(/request \S+/);
    expect(out).toMatch(/flags 0x/);
    expect(out).toMatch(/Stor \d/);
    expect(out).toMatch(/Yields \d/);
    expect(out).toContain("inner: sequence");
    expect(out).toMatch(/stor \d/);
    expect(out).toMatch(/recv \d/);
    expect(out).toMatch(/yields: \w+ \d/);
    expect(out).toContain("alias=y");
    expect(out).toContain("legend");
    expect(out).toContain("yields = scheduler yields");
  });

  it("renders skipped docs, sorts yields by count, and truncates long attributes", () => {
    const out = renderProfile(
      {
        times: { elapsedNs: 1 },
        plan: {
          name: "fetch",
          attributes: [
            ["collection", "c"],
            ["desc", { spans: "x".repeat(200) }],
          ],
          stats: {
            documentsIn: 5,
            documentsOut: 2,
            documentsSkipped: 3,
            phaseTimes: { exec: 1, stor: 2_000 },
            yields: { receiver: 1, budget: 1_500 },
          },
          children: [],
        },
      },
      "SELECT 1",
    );
    expect(out).toContain("5 in / 2 out / 3 skipped");
    expect(out).toContain("yields: budget 1,500 · receiver 1");
    expect(out).toContain("stor 2.00 µs");
    expect(out).toContain("Stor 2.00 µs");
    expect(out).toContain("Yields 1,501");
    expect(out).toMatch(/desc=\{"spans":"x+…/);
    expect(out).not.toContain("x".repeat(100));
    expect(out).not.toContain("collection=c collection"); // key attribute isn't repeated
  });

  it("omits the metadata line, totals, and detail lines when the envelope lacks them", () => {
    const out = renderProfile(
      { times: {}, plan: { name: "scan", attributes: [], children: [] } },
      "SELECT 1",
    );
    expect(out).not.toContain("directives");
    expect(out).not.toContain("Stor ");
    expect(out).not.toContain("Yields ");
    expect(out).not.toContain("yields:");
  });

  it("handles a profile with no plan gracefully", () => {
    const out = renderProfile({ times: {} }, "SELECT 1");
    expect(out).toContain("(plan unavailable)");
  });
});
