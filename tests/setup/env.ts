/**
 * Global test setup: stable, colorless output for snapshots; repo-root `.env`
 * loaded (if present) so integration/e2e suites inherit DATABASE_ID /
 * OFFLINE_TOKEN. Integration suites skip themselves when credentials are absent.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.FORCE_COLOR = "0";

// Every failing CLI run now saves last-error.json to the config dir. Give
// tests (and the CLI processes they spawn) a throwaway one, so test failures
// never land in the developer's real config.
if (!process.env.DITTOSH_CONFIG_DIR) {
  process.env.DITTOSH_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "dittosh-test-config-"));
}

const envFile = path.resolve(import.meta.dirname, "../../.env");
if (fs.existsSync(envFile) && typeof process.loadEnvFile === "function") {
  try {
    process.loadEnvFile(envFile);
  } catch {
    // Malformed .env — integration suites will skip on missing credentials.
  }
}
