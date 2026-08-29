/**
 * Global test setup: stable, colorless output for snapshots; repo-root `.env`
 * loaded (if present) so integration/e2e suites inherit DATABASE_ID /
 * OFFLINE_TOKEN. Integration suites skip themselves when credentials are absent.
 */
import fs from "node:fs";
import path from "node:path";

process.env.FORCE_COLOR = "0";

const envFile = path.resolve(import.meta.dirname, "../../.env");
if (fs.existsSync(envFile) && typeof process.loadEnvFile === "function") {
  try {
    process.loadEnvFile(envFile);
  } catch {
    // Malformed .env — integration suites will skip on missing credentials.
  }
}
