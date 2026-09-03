import { describe, expect, it } from "vitest";
import { extractQueryAdvice } from "../../src/query/advise.js";
import { renderAdvice } from "../../src/render/advise.js";

const ADVICE_ROW = {
  advice: {
    statement: "SELECT * FROM movies WHERE rated = 'PG'",
    suggestedIndexes: [
      {
        collection: "movies",
        reason: "equality predicates on `rated`",
        statement: "CREATE INDEX IF NOT EXISTS adv_movies_rated ON default:`movies` (`rated` ASC)",
      },
    ],
  },
};

describe("extractQueryAdvice", () => {
  it("extracts the standard shape", () => {
    const advice = extractQueryAdvice([ADVICE_ROW])!;
    expect(advice.statement).toBe("SELECT * FROM movies WHERE rated = 'PG'");
    expect(advice.suggestedIndexes).toHaveLength(1);
    expect(advice.suggestedIndexes[0]!.collection).toBe("movies");
    expect(advice.suggestedIndexes[0]!.reason).toContain("rated");
  });

  it("handles the no-suggestions outcome", () => {
    const advice = extractQueryAdvice([
      { advice: { statement: "SELECT 1", outcome: "no keys to advise on" } },
    ])!;
    expect(advice.suggestedIndexes).toHaveLength(0);
    expect(advice.outcome).toBe("no keys to advise on");
  });

  it("merges suggestions across multiple rows and drops partials", () => {
    const advice = extractQueryAdvice([
      {
        advice: { suggestedIndexes: [{ collection: "a", statement: "CREATE INDEX i1 ON a (x)" }] },
      },
      {
        advice: {
          suggestedIndexes: [
            { statement: "missing collection" },
            { collection: "b", statement: "CREATE INDEX i2 ON b (y)", reason: "r" },
          ],
        },
      },
      { unrelated: true },
    ])!;
    expect(advice.suggestedIndexes.map((s) => s.collection)).toEqual(["a", "b"]);
  });

  it("returns undefined when no advice rows exist", () => {
    expect(extractQueryAdvice([{ a: 1 }])).toBeUndefined();
    expect(extractQueryAdvice([])).toBeUndefined();
  });
});

describe("renderAdvice", () => {
  it("renders suggestions with collection, reason, and statement", () => {
    const out = renderAdvice(extractQueryAdvice([ADVICE_ROW])!);
    expect(out).toContain("Index advice");
    expect(out).toContain("analyzed: SELECT * FROM movies WHERE rated = 'PG'");
    expect(out).toContain("movies");
    expect(out).toContain("equality predicates");
    expect(out).toContain("CREATE INDEX IF NOT EXISTS adv_movies_rated");
    expect(out).toContain("--apply");
  });

  it("prints a copy-pasteable apply command with the analyzed statement", () => {
    const out = renderAdvice(extractQueryAdvice([ADVICE_ROW])!);
    expect(out).toContain(
      `apply with: dittosh dql --advise --apply "SELECT * FROM movies WHERE rated = 'PG'"`,
    );
  });

  it("shell-escapes the analyzed statement in the apply command", () => {
    const out = renderAdvice({
      statement: 'SELECT * FROM m WHERE t = "x" AND p = $1',
      suggestedIndexes: [{ collection: "m", statement: "CREATE INDEX i ON m (t)" }],
    });
    expect(out).toContain('--apply "SELECT * FROM m WHERE t = \\"x\\" AND p = \\$1"');
  });

  it("falls back to the <statement> placeholder when no statement was echoed", () => {
    const out = renderAdvice({
      suggestedIndexes: [{ collection: "m", statement: "CREATE INDEX i ON m (t)" }],
    });
    expect(out).toContain('"<statement>"');
  });

  it("renders the empty state with outcome text", () => {
    const out = renderAdvice({ suggestedIndexes: [], outcome: "no keys to advise on" });
    expect(out).toContain("no index suggestions");
    expect(out).toContain("no keys to advise on");
  });

  it("shows applied badges", () => {
    const advice = extractQueryAdvice([ADVICE_ROW])!;
    const stmt = advice.suggestedIndexes[0]!.statement;
    const out = renderAdvice(advice, new Map([[stmt, "created"]]));
    expect(out).toContain("✓ created");
    const outFailed = renderAdvice(advice, new Map([[stmt, "failed"]]));
    expect(outFailed).toContain("✗ failed");
  });
});
