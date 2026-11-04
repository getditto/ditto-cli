/** Credential-free PR check: exercise stamping and npm packaging without publishing. */
import fs from "node:fs";
import path from "node:path";
import { execa } from "execa";
import { digest, packRelease, validateRelease } from "./release.js";
import { smoke } from "./release-smoke.js";

const { version } = JSON.parse(fs.readFileSync("package.json", "utf8"));
const tag = `v${version}`;
validateRelease(tag);
const token = Buffer.from("release-check-fixture expiry 2099-01-01T00:00:00Z").toString("base64");
const env = {
  ...process.env,
  OFFLINE_TOKEN: token,
  DATABASE_ID: "00000000-0000-0000-0000-000000000000",
};
await execa(process.execPath, ["--import", "tsx", "scripts/stamp-token.ts"], {
  env,
  stdio: "inherit",
});
await execa("npm", ["run", "build"], { env: { ...env, RELEASE: "true" }, stdio: "inherit" });
const commit = (await execa("git", ["rev-parse", "HEAD"])).stdout;
const archive = await packRelease(version, commit, token);
fs.writeFileSync(
  path.join(path.dirname(archive), "SHA256SUMS"),
  `${digest(fs.readFileSync(archive))}  ${path.basename(archive)}\n`,
);
await smoke("npm", tag, false);
console.log(
  "Release packaging check passed with an intentionally invalid test license; nothing published",
);
