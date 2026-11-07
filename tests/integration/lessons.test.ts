import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DittoSession } from "../../src/ditto/session.js";
import { loadIdentity } from "../../src/identity/token.js";
import { LESSONS, LEVELS } from "../../src/tutorial/lessons.js";
import { LessonRunner } from "../../src/tutorial/runner.js";
import { hasDevCredentials, NO_CREDENTIALS, rmrf, tmpDataDir } from "../helpers/credentials.js";

describe.skipIf(!hasDevCredentials)(`integration: tutorial lessons (${NO_CREDENTIALS})`, () => {
  let dataDir: string;
  let session: DittoSession;
  let output: string[];
  let runner: LessonRunner;

  beforeAll(async () => {
    dataDir = tmpDataDir();
    session = await DittoSession.open(loadIdentity(), dataDir);
    output = [];
    runner = new LessonRunner(session, {
      io: { print: (t) => output.push(t), width: () => 100 },
    });
    await runner.start();
  });

  afterAll(async () => {
    await session?.close();
    rmrf(dataDir);
  });

  it("covers all three levels, in order", () => {
    const levels = LESSONS.map((l) => l.level);
    for (const level of LEVELS) expect(levels).toContain(level);
    expect([...levels]).toEqual([...levels].sort((a, b) => LEVELS.indexOf(a) - LEVELS.indexOf(b)));
  });

  it("every lesson's sample answer passes its own check, in sequence", async () => {
    for (const [i, lesson] of LESSONS.entries()) {
      expect(runner.current, `lesson ${i + 1}`).toBe(i);
      output.length = 0;
      const ok = await runner.submit(lesson.answer);
      expect(ok, `lesson ${i + 1} "${lesson.title}":\n${output.join("\n")}`).toBe(true);
    }
    expect(runner.completedCount).toBe(LESSONS.length);
    expect(output.join("\n")).toContain(`finished all ${LESSONS.length} lessons`);
  });

  it("each lesson's sample answer also passes when started directly (setup is self-contained)", async () => {
    await runner.resetData();
    for (const [i, lesson] of LESSONS.entries()) {
      await runner.goto(String(i + 1));
      output.length = 0;
      const ok = await runner.submit(lesson.answer);
      expect(ok, `lesson ${i + 1} "${lesson.title}":\n${output.join("\n")}`).toBe(true);
    }
  });

  it("every complete syntax example is valid DQL against the practice data", async () => {
    const runnable = /^(SELECT|INSERT|UPDATE|EVICT|EXPLAIN|PROFILE|CREATE)\b/i;
    const placeholder = /…|\bcollection(_a|_b)?\b|\bfield(_a|_b)?\b|\bidx_name\b|</;
    let ran = 0;
    for (const [i, lesson] of LESSONS.entries()) {
      for (const line of lesson.syntax) {
        const statement = line.replace(/\s+--.*$/, "").trim();
        if (!runnable.test(statement) || placeholder.test(statement)) continue;
        await runner.resetData();
        for (const s of lesson.setup ?? []) await session.execute(s);
        await expect(
          session.execute(statement),
          `lesson ${i + 1} example: ${statement}`,
        ).resolves.toBeDefined();
        ran++;
      }
    }
    expect(ran).toBeGreaterThan(15);
    await runner.resetData();
  });

  it("the data view reads every lesson's collections from the real store", async () => {
    await runner.resetData();
    for (const [i] of LESSONS.entries()) {
      await runner.goto(String(i + 1));
      const schemas = await runner.schema();
      expect(schemas.length, `lesson ${i + 1}`).toBeGreaterThan(0);
      for (const s of schemas) {
        expect(s.fields.length, `lesson ${i + 1} ${s.collection}`).toBeGreaterThan(0);
      }
    }
    await runner.goto(String(LESSONS.findIndex((l) => l.title === "Joining collections") + 1));
    const [products, suppliers] = await runner.schema();
    expect(products?.fields.map((f) => f.path)).toContain("supplier_id");
    expect(suppliers?.fields.map((f) => f.path)).toContain("country");
  });

  it("a wrong-case collection name is explained, not just 'no rows'", async () => {
    await runner.goto("1");
    output.length = 0;
    expect(await runner.submit("SELECT * FROM Products")).toBe(false);
    expect(output.join("\n")).toContain("Collection names are case-sensitive");
  });

  it("skipping a lesson can't leave data behind that breaks a later answer", async () => {
    const at = (title: string) => LESSONS.findIndex((l) => l.title === title);
    // Insert p7, then skip the lesson that evicts it, plus a stray write.
    await runner.goto(String(at("Inserting documents") + 1));
    expect(await runner.submit(LESSONS[at("Inserting documents")]!.answer)).toBe(true);
    await session.execute(
      "INSERT INTO products VALUES ({'_id': 'p9', 'name': 'Kettle', 'price': 30})",
    );
    for (const title of ["Expressions and functions", "Aggregate functions", "Outer joins"]) {
      await runner.goto(String(at(title) + 1));
      output.length = 0;
      const ok = await runner.submit(LESSONS[at(title)]!.answer);
      expect(ok, `${title}:\n${output.join("\n")}`).toBe(true);
    }
  });

  it("a command while a statement is being checked can't mark the wrong lesson", async () => {
    const fresh = new LessonRunner(session, { io: { print: () => {}, width: () => 100 } });
    await fresh.start();
    const submitted = fresh.submit(LESSONS[0]!.answer);
    const moved = fresh.goto("5"); // concurrently, as a plain-shell command could
    await Promise.all([submitted, moved]);
    expect(fresh.isCompleted(0)).toBe(true);
    expect(fresh.isCompleted(4)).toBe(false);
    expect(fresh.current).toBe(4); // the jump wins; no extra advance
  });

  it("wrong answers are rejected with a reason and don't advance", async () => {
    await runner.resetData();
    await runner.goto("3"); // Filtering: coffee products
    output.length = 0;
    expect(await runner.submit("SELECT name FROM products WHERE category = 'tea'")).toBe(false);
    expect(output.join("\n")).toContain("Not quite");
    expect(runner.current).toBe(2);
  });

  it("query errors are reported without advancing", async () => {
    output.length = 0;
    expect(await runner.submit("SELEKT * FROM products")).toBe(false);
    expect(output.join("\n")).toContain("Query error");
    expect(runner.current).toBe(2);
  });
});
