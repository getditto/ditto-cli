// Spike A: verify Ditto Node SDK v5.1 init + offline license + DQL execution.
// Run: node --env-file=.env scripts/spike-a.mjs
import * as sdk from "@dittolive/ditto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const appId = process.env.DATABASE_ID;
const token = process.env.OFFLINE_TOKEN;
if (!appId || !token) {
  console.error("missing DATABASE_ID / OFFLINE_TOKEN in env");
  process.exit(1);
}

const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "ditto-spike-a-"));
console.log("store dir:", storeDir);
console.log("sdk keys:", Object.keys(sdk).filter((k) => /Ditto|Config|init/i.test(k)).join(", "));

try {
  if (typeof sdk.init === "function") await sdk.init();
  else if (typeof sdk.Ditto?.init === "function") await sdk.Ditto.init();
  console.log("init ok");

  const config = new sdk.DittoConfig(appId, { mode: "smallPeersOnly" }, storeDir);
  const ditto = await sdk.Ditto.open(config);
  console.log("open ok");

  await ditto.setOfflineOnlyLicenseToken(token);
  console.log("license ok");

  // NOTE: deliberately NOT calling startSync() — offline-only.

  const insert = await ditto.store.execute(
    "INSERT INTO COLLECTION movies (director MAP, ratings MAP, watch_count COUNTER) DOCUMENTS ({ '_id': 'tt0111161', 'title': 'The Shawshank Redemption', 'year': 1994, 'genres': ['Drama'], 'director': {'name': 'Frank Darabont', 'born': 1959}, 'ratings': {'imdb': 9.3, 'rotten_tomatoes': 91, 'metacritic': 80}, 'watch_count': 0, 'is_classic': true, 'released': '1994-09-23' }), ({ '_id': 'tt1375666', 'title': 'Inception', 'year': 2010, 'genres': ['Action','Sci-Fi'], 'director': {'name': 'Christopher Nolan', 'born': 1970}, 'ratings': {'imdb': 8.8}, 'watch_count': 0, 'is_classic': false }) ON ID CONFLICT DO UPDATE"
  );
  console.log("insert ok, mutated:", insert.mutatedDocumentIDs?.length ?? "n/a");

  const result = await ditto.store.execute("SELECT * FROM movies WHERE year >= :minYear ORDER BY year", { minYear: 1990 });
  const items = result.items ?? result.documents ?? [];
  const rows = items.map((it) => (typeof it.value === "function" ? it.value() : it.value));
  console.log("select rows:", rows.length);
  console.log(JSON.stringify(rows, null, 2));

  // EXPLAIN check
  try {
    const explain = await ditto.store.execute("EXPLAIN SELECT * FROM movies WHERE year = 1994");
    const exItems = (explain.items ?? []).map((it) => (typeof it.value === "function" ? it.value() : it.value));
    console.log("explain first item keys:", exItems[0] ? Object.keys(exItems[0]).join(",") : "none");
  } catch (e) {
    console.log("EXPLAIN failed:", e.message);
  }

  // PROFILE check
  try {
    const prof = await ditto.store.execute("PROFILE SELECT * FROM movies WHERE year = 1994");
    const pItems = (prof.items ?? []).map((it) => (typeof it.value === "function" ? it.value() : it.value));
    const last = pItems[pItems.length - 1];
    console.log("profile trailing item keys:", last ? Object.keys(last).join(",") : "none");
  } catch (e) {
    console.log("PROFILE failed:", e.message);
  }

  await ditto.close();
  console.log("SPIKE A: PASS");
} catch (err) {
  console.error("SPIKE A: FAIL —", err?.code ?? "", err?.message ?? err);
  process.exit(1);
} finally {
  fs.rmSync(storeDir, { recursive: true, force: true });
}
