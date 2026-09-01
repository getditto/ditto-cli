import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { renderExplain } from "../../src/render/explain.js";

const fixture = JSON.parse(
  fs.readFileSync(path.join(import.meta.dirname, "fixtures", "profile-envelope.json"), "utf8"),
) as { explain: Record<string, unknown> };

describe("renderExplain", () => {
  it("renders the operator tree from a real EXPLAIN doc (SDK 5.1.0)", () => {
    const out = renderExplain(fixture.explain);
    expect(out).toContain("Query plan");
    expect(out).toContain("sequence");
    expect(out).toContain("scan");
    expect(out).toContain("filter");
    expect(out).toContain("collection=movies");
  });

  it("falls back to pretty JSON for unrecognized shapes", () => {
    const out = renderExplain({ plan: { totally: { different: 42 } } });
    expect(out).toContain('"totally"');
    expect(out).toContain("42");
  });

  it("handles null/undefined", () => {
    expect(renderExplain(undefined)).toBe("(plan unavailable)");
    expect(renderExplain(null)).toBe("(plan unavailable)");
  });
});
