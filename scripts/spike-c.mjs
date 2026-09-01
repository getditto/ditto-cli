// Spike C: capture a real ~request_profile envelope from the SDK as a test fixture.
// Run: node --env-file=.env scripts/spike-c.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as sdk from "@dittolive/ditto";

const appId = process.env.DATABASE_ID;
const token = process.env.OFFLINE_TOKEN;
if (!appId || !token) {
  console.error("missing DATABASE_ID / OFFLINE_TOKEN");
  process.exit(1);
}

const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "ditto-spike-c-"));
sdk.Logger.enabled = false;
await sdk.init();
const ditto = await sdk.Ditto.open(
  new sdk.DittoConfig(appId, { mode: "smallPeersOnly" }, storeDir),
);
await ditto.setOfflineOnlyLicenseToken(token);

// Seed some movies so the plan has real scans
const docs = Array.from({ length: 200 }, (_, i) => ({
  _id: `m${i}`,
  title: i % 7 === 0 ? `Star Movie ${i}` : `Movie ${i}`,
  year: String(1950 + (i % 75)),
  rated: ["G", "PG", "PG-13", "R"][i % 4],
  runtime: 60 + (i % 180),
}));
for (const d of docs) {
  await ditto.store.execute("INSERT INTO movies DOCUMENTS (:doc) ON ID CONFLICT DO UPDATE", {
    doc: d,
  });
}

const queries = [
  "PROFILE SELECT * FROM movies WHERE rated = 'PG'",
  "PROFILE SELECT * FROM movies WHERE year > '2000' AND rated = 'R' ORDER BY year DESC LIMIT 10",
];
const out = [];
for (const q of queries) {
  const result = await ditto.store.execute(q);
  const items = (result.items ?? []).map((it) =>
    typeof it.value === "function" ? it.value() : it.value,
  );
  const envelope = items.findLast((v) => v && typeof v === "object" && "~request_profile" in v);
  out.push({ query: q, itemCount: items.length, envelope });
}

// Also capture an EXPLAIN plan
const explain = await ditto.store.execute("EXPLAIN SELECT * FROM movies WHERE rated = 'PG'");
const explainItems = (explain.items ?? []).map((it) =>
  typeof it.value === "function" ? it.value() : it.value,
);

await ditto.close();
fs.rmSync(storeDir, { recursive: true, force: true });

const fixture = {
  capturedAt: new Date().toISOString(),
  sdkVersion: "5.1.0",
  profiles: out,
  explain: explainItems[0] ?? null,
};
fs.writeFileSync("tests/unit/fixtures/profile-envelope.json", JSON.stringify(fixture, null, 2));
console.log("fixture written: tests/unit/fixtures/profile-envelope.json");
console.log(
  "envelope top-level keys:",
  out[0]?.envelope ? Object.keys(out[0].envelope["~request_profile"]) : "NONE",
);
console.log(
  "plan root:",
  JSON.stringify(out[0]?.envelope?.["~request_profile"]?.plan).slice(0, 400),
);
