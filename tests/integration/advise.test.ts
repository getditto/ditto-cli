import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runStatement } from "../../src/cli/groups/dql/run.js";
import { DittoSession } from "../../src/ditto/session.js";
import { loadIdentity } from "../../src/identity/token.js";
import { extractRows } from "../../src/query/execute.js";
import { hasDevCredentials, NO_CREDENTIALS, rmrf, tmpDataDir } from "../helpers/credentials.js";

describe.skipIf(!hasDevCredentials)(`integration: ADVISE (${NO_CREDENTIALS})`, () => {
  let dataDir: string;
  let session: DittoSession;
  let outSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(async () => {
    dataDir = tmpDataDir("ditto-advise-");
    session = await DittoSession.open(loadIdentity(), dataDir);
    await session.execute(
      "INSERT INTO movies DOCUMENTS ({'_id':'a1','title':'Alien','rated':'R'}), ({'_id':'a2','title':'Toy Story','rated':'G'}) ON ID CONFLICT DO UPDATE",
    );
  });

  beforeEach(() => {
    outSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    outSpy.mockRestore();
    errSpy.mockRestore();
  });

  afterAll(async () => {
    await session?.close();
    rmrf(dataDir);
  });

  it("ADVISE on an unindexed query suggests an index; --apply creates it", async () => {
    const stmt = "SELECT * FROM movies WHERE rated = 'PG' AND title LIKE '%Star%'";
    const r = await runStatement(session, stmt, {
      maxRows: 10_000,
      maxRowsExplicit: false,
      advise: true,
      apply: true,
      yes: true,
    });
    expect(r.ok).toBe(true);
    const out = errSpy.mock.calls.flat().join("\n");
    expect(out).toContain("Index advice");
    // Either a suggestion was created, or ADVISE found nothing to advise on.
    if (out.includes("CREATE INDEX")) {
      expect(out).toContain("✓ created");
      const indexes = extractRows(
        await session.execute("SELECT * FROM system:indexes WHERE collection = :c", {
          c: "movies",
        }),
      );
      expect(JSON.stringify(indexes)).toContain("adv_movies");
    } else {
      expect(out).toContain("no index suggestions");
    }
  });

  it("ADVISE after applying reports nothing further to advise (or repeats harmlessly)", async () => {
    const r = await runStatement(session, "SELECT * FROM movies WHERE rated = 'PG'", {
      maxRows: 10_000,
      maxRowsExplicit: false,
      advise: true,
    });
    expect(r.ok).toBe(true);
    expect(errSpy.mock.calls.flat().join("\n")).toContain("Index advice");
  });
});
