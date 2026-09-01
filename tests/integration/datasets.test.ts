import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadDataset } from "../../src/datasets/loader.js";
import { getDataset } from "../../src/datasets/registry.js";
import { DittoSession } from "../../src/ditto/session.js";
import { loadIdentity } from "../../src/identity/token.js";
import { extractRows } from "../../src/query/execute.js";
import { hasDevCredentials, NO_CREDENTIALS, rmrf, tmpDataDir } from "../helpers/credentials.js";

describe.skipIf(!hasDevCredentials)(`integration: datasets (${NO_CREDENTIALS})`, () => {
  let dataDir: string;
  let session: DittoSession;

  beforeAll(async () => {
    dataDir = tmpDataDir("ditto-datasets-");
    session = await DittoSession.open(loadIdentity(), dataDir);
  });

  afterAll(async () => {
    await session?.close();
    rmrf(dataDir);
  });

  it("loads movies (100 docs) and runs catalog queries against it", async () => {
    const suite = getDataset("movies")!;
    const result = await loadDataset(session, suite, { docs: 100, seed: 42, batchSize: 50 });
    expect(result.totalDocs).toBe(100);

    const count = extractRows(await session.execute("SELECT count(*) AS n FROM movies"));
    expect(count[0]!.n).toBe(100);

    // Catalog queries with hard invariants
    const single = extractRows(
      await session.execute("SELECT * FROM movies WHERE _id.year = '1893'"),
    );
    expect(single).toHaveLength(1);
    expect((single[0]!._id as Record<string, unknown>).title).toBe("Blacksmith Scene");

    const empty = extractRows(
      await session.execute("SELECT * FROM movies WHERE _id.year = '1800'"),
    );
    expect(empty).toHaveLength(0);

    const starred = extractRows(
      await session.execute("SELECT * FROM movies WHERE _id.title LIKE '%Star%'"),
    );
    expect(starred.length).toBeGreaterThan(0);
  });

  it("loads retail (1,000 orders) with working catalog literals", async () => {
    const suite = getDataset("retail")!;
    await loadDataset(session, suite, { docs: 1_000, seed: 42, batchSize: 500 });

    const stores = extractRows(
      await session.execute(
        "SELECT * FROM stores WHERE location.city = 'Seattle' AND deleted = false",
      ),
    );
    expect(stores.length).toBeGreaterThanOrEqual(1);

    const orders = extractRows(await session.execute("SELECT count(*) AS n FROM orders"));
    expect(orders[0]!.n).toBeGreaterThanOrEqual(1_000);

    // Anchors
    const anchorOrder = extractRows(
      await session.execute("SELECT * FROM orders WHERE _id = 'order_20250115_0001'"),
    );
    expect(anchorOrder).toHaveLength(1);
    const anchorCustomer = extractRows(
      await session.execute("SELECT * FROM customers WHERE email = 'john21@example.net'"),
    );
    expect(anchorCustomer).toHaveLength(1);
    const anchorItems = extractRows(
      await session.execute("SELECT * FROM order_items WHERE order_id = 'order_20250115_0001'"),
    );
    expect(anchorItems.length).toBeGreaterThanOrEqual(1);
  });

  it("loads retail-joins and JOINs work", async () => {
    await loadDataset(session, getDataset("retail-joins")!, {
      docs: 500,
      seed: 42,
      batchSize: 500,
    });
    const rows = extractRows(
      await session.execute(
        "SELECT o._id, o.total, s.store_name, s.location.city FROM orders AS o INNER JOIN stores AS s ON o.store_id = s._id WHERE o._id = 'order_20221209_0001'",
      ),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.store_name).toBe("Zava Retail Seattle");
  });

  it("loads pos (500 orders) with queryable anchors", async () => {
    await loadDataset(session, getDataset("pos")!, { docs: 500, seed: 42, batchSize: 500 });
    const count = extractRows(await session.execute("SELECT count(*) AS n FROM pos_orders"));
    expect(count[0]!.n).toBe(502);
    const anchor = extractRows(
      await session.execute(
        "SELECT * FROM pos_orders WHERE _id.id = 'ce5a37a2-deaf-4254-b9da-d80505801d75' AND _id.locationId = '00001'",
      ),
    );
    expect(anchor).toHaveLength(1);
  });

  it("reset evicts a dataset's collections (EVICT … WHERE true)", async () => {
    for (const c of getDataset("movies")!.collections) {
      await session.execute(`EVICT FROM ${c.name} WHERE true`);
    }
    const count = extractRows(await session.execute("SELECT count(*) AS n FROM movies"));
    expect(count[0]!.n).toBe(0);
    // other datasets untouched (retail + retail-joins share collection names
    // by design, so orders reflects both loads — just assert non-empty)
    const orders = extractRows(await session.execute("SELECT count(*) AS n FROM orders"));
    expect(Number(orders[0]!.n)).toBeGreaterThan(0);
  });

  it("write-category catalog entries mutate AND clean up after themselves (no --setup needed)", async () => {
    // movies update_single: preQueries INSERT the fixture, UPDATE mutates it, postQueries EVICT it
    const { resolveQuery } = await import("../../src/datasets/registry.js");
    const entry = resolveQuery("update_single", "movies")!.entry;
    for (const q of entry.preQueries ?? []) await session.execute(q);
    await session.execute(entry.query);
    for (const q of entry.postQueries ?? []) await session.execute(q);
    // no residue
    const residue = extractRows(
      await session.execute("SELECT _id FROM movies WHERE plot = 'update-test-benchmark-uuid'"),
    );
    expect(residue).toHaveLength(0);
  });
});
