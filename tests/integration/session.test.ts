import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DittoSession, LockError } from "../../src/ditto/session.js";
import { loadIdentity } from "../../src/identity/token.js";
import { classify, extractRows } from "../../src/query/execute.js";
import { hasDevCredentials, NO_CREDENTIALS, rmrf, tmpDataDir } from "../helpers/credentials.js";

describe.skipIf(!hasDevCredentials)(`integration: DittoSession (${NO_CREDENTIALS})`, () => {
  let dataDir: string;
  let session: DittoSession;

  beforeAll(async () => {
    dataDir = tmpDataDir();
    session = await DittoSession.open(loadIdentity(), dataDir);
  });

  afterAll(async () => {
    await session?.close();
    rmrf(dataDir);
  });

  it("inserts and selects documents round-trip", async () => {
    await session.execute(
      "INSERT INTO movies DOCUMENTS ({'_id':'m1','title':'Alien','year':1979,'rated':'R'}), ({'_id':'m2','title':'Blade Runner','year':1982,'rated':'R'}), ({'_id':'m3','title':'Toy Story','year':1995,'rated':'G'}) ON ID CONFLICT DO UPDATE",
    );
    const result = await session.execute("SELECT * FROM movies ORDER BY year");
    const rows = extractRows(result);
    expect(rows.map((r) => r.title)).toEqual(["Alien", "Blade Runner", "Toy Story"]);
  });

  it("persists data across sessions in the same data dir", async () => {
    await session.close();
    session = await DittoSession.open(loadIdentity(), dataDir);
    const rows = extractRows(await session.execute("SELECT * FROM movies"));
    expect(rows.length).toBe(3);
  });

  it("binds :name parameters", async () => {
    const rows = extractRows(
      await session.execute("SELECT * FROM movies WHERE rated = :rated ORDER BY year", {
        rated: "R",
      }),
    );
    expect(rows.map((r) => r.title)).toEqual(["Alien", "Blade Runner"]);
  });

  it("classifies statements the way the SDK treats them", async () => {
    for (const stmt of [
      "SELECT * FROM movies",
      "INSERT INTO movies DOCUMENTS ({'_id':'tmp1'}) ON ID CONFLICT DO UPDATE",
      "UPDATE movies SET rated = 'R' WHERE _id = 'tmp1'",
      "EVICT FROM movies WHERE _id = 'tmp1'",
    ]) {
      const result = await session.execute(stmt);
      expect(result).toBeDefined();
      expect(classify(stmt)).not.toBe("other");
    }
  });

  it("EXPLAIN returns a plan structure as the first item", async () => {
    const rows = extractRows(await session.execute("EXPLAIN SELECT * FROM movies WHERE year = 1979"));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]).toHaveProperty("plan");
  });

  it("PROFILE appends a trailing ~request_profile envelope", async () => {
    const rows = extractRows(await session.execute("PROFILE SELECT * FROM movies WHERE year = 1979"));
    const envelope = rows.findLast((r) => "~request_profile" in r);
    expect(envelope).toBeDefined();
    const profile = envelope?.["~request_profile"] as Record<string, unknown>;
    expect(profile).toHaveProperty("times");
    expect(profile).toHaveProperty("plan");
  });

  it("a second session on the same data dir throws LockError (exit 4)", async () => {
    await expect(DittoSession.open(loadIdentity(), dataDir)).rejects.toSatisfy(
      (err) => err instanceof LockError && err.exitCode === 4 && err.message.includes(dataDir),
    );
  });

  it("surfaces DQL parse errors with an SDK error code", async () => {
    await expect(session.execute("SELEC broken")).rejects.toMatchObject({
      message: expect.stringContaining("SELEC"),
    });
  });
});
