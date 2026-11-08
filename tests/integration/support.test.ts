import fs from "node:fs";
import path from "node:path";
import * as tar from "tar";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DittoSession } from "../../src/ditto/session.js";
import { loadIdentity } from "../../src/identity/token.js";
import { collectReport, renderReport } from "../../src/support/report.js";
import { listSupportBundles, saveSupportBundle } from "../../src/support/sdk-bundle.js";
import { hasDevCredentials, NO_CREDENTIALS, rmrf, tmpDataDir } from "../helpers/credentials.js";

async function tarEntries(file: string): Promise<string[]> {
  const names: string[] = [];
  await tar.t({ file, onReadEntry: (e) => names.push(e.path) });
  return names;
}

describe.skipIf(!hasDevCredentials)(`integration: support bundles (${NO_CREDENTIALS})`, () => {
  let dataDir: string;
  let work: string;

  beforeAll(async () => {
    dataDir = tmpDataDir("ditto-support-int-");
    work = tmpDataDir("ditto-support-work-");
    const session = await DittoSession.open(loadIdentity(), dataDir);
    try {
      await session.execute("INSERT INTO cars DOCUMENTS ({'_id': 'a', 'make': 'Ford'})");
      await session.execute("INSERT INTO cars DOCUMENTS ({'_id': 'b', 'make': 'Kia'})");
      await session.execute("CREATE INDEX cars_make ON cars (make)");
    } finally {
      await session.close();
    }
  });

  afterAll(() => {
    rmrf(dataDir);
    rmrf(work);
  });

  it("requests an SDK support bundle, saves the .tar, and lists it", async () => {
    const identity = loadIdentity();
    const session = await DittoSession.open(identity, dataDir);
    try {
      const out = path.join(work, "bundle.tar");
      const saved = await saveSupportBundle(session, out, { source: "integration test" });
      expect(saved.reusedBecause).toBeUndefined();
      expect(fs.statSync(out).size).toBe(saved.bytes);
      const names = await tarEntries(out);
      expect(names).toEqual(
        expect.arrayContaining([
          "ditto-logs.log.gz",
          "device_logs_METADATA.json",
          "config_snapshot.json",
        ]),
      );
      // The license token never ends up in the bundle.
      expect(fs.readFileSync(out).includes(Buffer.from(identity.token))).toBe(false);

      const list = await listSupportBundles(session);
      expect(list[0]).toMatchObject({ created_at: saved.createdAt, reason: "USER_INITIATED" });
    } finally {
      await session.close();
    }
  }, 60_000);

  it("collects a full report from a real store", async () => {
    const identity = loadIdentity();
    const report = await collectReport({
      dataDir,
      configDir: work,
      includeStore: true,
      includeSdkBundle: true,
      workDir: work,
      checks: [],
      environment: {},
      lastError: null,
      openStore: () => DittoSession.open(identity, dataDir),
      saveBundle: (s, f) => saveSupportBundle(s, f),
    });
    expect(report.store.collections).toEqual([{ name: "cars", documents: 2 }]);
    expect(report.store.indexes).toEqual([
      { id: "cars.cars_make", collection: "cars", fields: "make" },
    ]);
    expect(report.sdkBundle.file).toBe("ditto-support-bundle.tar");
    expect(fs.existsSync(path.join(work, "ditto-support-bundle.tar"))).toBe(true);
    expect(renderReport(report)).toContain("| cars | 2 |");

    // The store was closed: it opens again (no lock left behind).
    const again = await DittoSession.open(identity, dataDir);
    await again.close();
  }, 60_000);
});
