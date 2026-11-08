import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { exampleBenchFile } from "../../src/bench/example.js";
import { runBenchmark } from "../../src/bench/runner.js";
import { parseBenchFile } from "../../src/bench/spec.js";
import { loadDataset } from "../../src/datasets/loader.js";
import { DATASETS } from "../../src/datasets/registry.js";
import { DittoSession } from "../../src/ditto/session.js";
import { loadIdentity } from "../../src/identity/token.js";
import { extractRows } from "../../src/query/execute.js";
import { hasDevCredentials, NO_CREDENTIALS, rmrf, tmpDataDir } from "../helpers/credentials.js";

describe.skipIf(!hasDevCredentials)(`integration: bench (${NO_CREDENTIALS})`, () => {
  let dataDir: string;
  let session: DittoSession;

  beforeAll(async () => {
    dataDir = tmpDataDir("ditto-bench-");
    session = await DittoSession.open(loadIdentity(), dataDir);
  });

  afterAll(async () => {
    await session?.close();
    rmrf(dataDir);
  });

  /** Document counts per collection plus the index list: the state a benchmark must restore. */
  async function snapshot(collections: string[]) {
    const counts: Record<string, unknown> = {};
    for (const c of collections) {
      counts[c] = extractRows(await session.execute(`SELECT count(*) AS n FROM ${c}`))[0]!.n;
    }
    const indexes = extractRows(await session.execute("SELECT _id FROM system:indexes"))
      .map((r) => JSON.stringify(r._id))
      .sort();
    return { counts, indexes };
  }

  it.each(DATASETS.map((d) => d.name))(
    "the %s sample file runs cleanly and leaves the store as it found it",
    async (name) => {
      const suite = DATASETS.find((d) => d.name === name)!;
      await loadDataset(session, suite, { docs: 60, seed: 42, batchSize: 500 });
      const collections = suite.collections.map((c) => c.name);
      const before = await snapshot(collections);

      const specs = parseBenchFile(JSON.stringify(exampleBenchFile(suite)), name);
      for (const spec of specs) {
        const r = await runBenchmark(session, spec, { runs: 3, warmup: 2 });
        expect(r.failure, `${spec.name}: ${r.failure?.error}`).toBeUndefined();
        expect(r.cleanupFailures, spec.name).toEqual([]);
        expect(r.runs).toBe(3);
        expect(r.stats!.p99).toBeGreaterThan(0);
      }

      expect(await snapshot(collections)).toEqual(before);
    },
    60_000,
  );

  it("afterEachQueries undo an INSERT so every run inserts again", async () => {
    const r = await runBenchmark(
      session,
      {
        name: "insert",
        query: "INSERT INTO bench_after VALUES ({'_id': 'doc', 'n': 1})",
        preQueries: [],
        resetQueries: [],
        afterEachQueries: ["EVICT FROM bench_after WHERE _id = 'doc'"],
        postQueries: [],
      },
      { runs: 3, warmup: 2 },
    );
    expect(r.failure, r.failure?.error).toBeUndefined();
    expect(r.runs).toBe(3);
    const left = extractRows(await session.execute("SELECT count(*) AS n FROM bench_after"));
    expect(left[0]!.n).toBe(0);
  });

  it("auto warmup runs at least once against a real store", async () => {
    const r = await runBenchmark(
      session,
      {
        name: "n",
        query: "SELECT count(*) FROM movies",
        preQueries: [],
        resetQueries: [],
        afterEachQueries: [],
        postQueries: [],
      },
      { runs: 2, warmup: "auto" },
    );
    expect(r.ok).toBe(true);
    expect(r.warmup).toBeGreaterThanOrEqual(1);
    expect(r.rows).toBe(1);
  });
});
