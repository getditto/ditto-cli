import fs from "node:fs";
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
    const rows = extractRows(
      await session.execute("EXPLAIN SELECT * FROM movies WHERE year = 1979"),
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]).toHaveProperty("plan");
  });

  it("PROFILE appends a trailing ~request_profile envelope", async () => {
    const rows = extractRows(
      await session.execute("PROFILE SELECT * FROM movies WHERE year = 1979"),
    );
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

  it("doctor reports a held lock on the real data dir (exit 3)", async () => {
    const { collectDoctorChecks } = await import("../../src/cli/groups/dql/doctor.js");
    // session holds the lock on dataDir (opened in beforeAll)
    const checks = await collectDoctorChecks({ dataDir });
    const lock = checks.find((c) => c.label === "lock")!;
    expect(lock).toBeDefined();
    expect(lock.ok).toBe(false);
    expect(lock.detail).toContain("locked by another process");
  });

  it("deleteStore refuses a store this process holds open (exit 4), real probe", async () => {
    const { deleteStore } = await import("../../src/cli/groups/dql/delete-store.js");
    // session holds the lock on dataDir (opened in beforeAll)
    const r = await deleteStore({ dataDir, yes: true });
    expect(r.code).toBe(4);
    expect(fs.existsSync(dataDir)).toBe(true);
  });

  it("deleteStore deletes an unlocked store end to end (real probe)", async () => {
    const { deleteStore } = await import("../../src/cli/groups/dql/delete-store.js");
    const dir = tmpDataDir("ditto-delete-");
    const s = await DittoSession.open(loadIdentity(), dir);
    await s.close();
    const r = await deleteStore({ dataDir: dir, yes: true });
    expect(r.code).toBe(0);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it("a read-only data dir maps to DataDirError (exit 3)", async () => {
    const roDir = tmpDataDir("ditto-ro-");
    fs.chmodSync(roDir, 0o555);
    try {
      await expect(DittoSession.open(loadIdentity(), roDir)).rejects.toMatchObject({
        name: "DataDirError",
        exitCode: 3,
      });
    } finally {
      fs.chmodSync(roDir, 0o755);
      rmrf(roDir);
    }
  });

  it("surfaces DQL parse errors with an SDK error code", async () => {
    await expect(session.execute("SELEC broken")).rejects.toMatchObject({
      message: expect.stringContaining("SELEC"),
    });
  });
});
