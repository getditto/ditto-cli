import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DittoSession } from "../../src/ditto/session.js";
import { loadIdentity } from "../../src/identity/token.js";
import { extractRows } from "../../src/query/execute.js";
import { hasDevCredentials, NO_CREDENTIALS, rmrf, tmpDataDir } from "../helpers/credentials.js";

describe.skipIf(!hasDevCredentials)(`integration: system collections (${NO_CREDENTIALS})`, () => {
  let dataDir: string;
  let session: DittoSession;

  beforeAll(async () => {
    dataDir = tmpDataDir();
    session = await DittoSession.open(loadIdentity(), dataDir);
    await session.execute(
      "INSERT INTO movies DOCUMENTS ({'_id':'m1','title':'Alien','year':1979}) ON ID CONFLICT DO UPDATE",
    );
  });

  afterAll(async () => {
    await session?.close();
    rmrf(dataDir);
  });

  it("system:collections lists the seeded collection", async () => {
    const rows = extractRows(await session.execute("SELECT * FROM system:collections"));
    const names = rows.map((r) => r.name);
    expect(names).toContain("movies");
  });

  it("system:indexes lists a created index", async () => {
    await session.execute("CREATE INDEX IF NOT EXISTS movies_year ON movies (year)");
    const rows = extractRows(await session.execute("SELECT * FROM system:indexes"));
    expect(JSON.stringify(rows)).toContain("movies_year");
  });

  it("system:indexes filters by collection via :param", async () => {
    const rows = extractRows(
      await session.execute("SELECT * FROM system:indexes WHERE collection = :collection", {
        collection: "movies",
      }),
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(JSON.stringify(rows)).toContain("movies");
  });
});
