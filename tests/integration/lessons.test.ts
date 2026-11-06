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
