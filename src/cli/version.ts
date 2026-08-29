import { createRequire } from "node:module";

// Injected by tsup at build time (see tsup.config.ts). Dev (tsx) falls back to
// reading package.json from either src/ (dev) or dist/ (built) locations.
declare const __CLI_VERSION__: string | undefined;

function devVersion(): string {
  const req = createRequire(import.meta.url);
  for (const rel of ["../../package.json", "../package.json"]) {
    try {
      return (req(rel) as { version: string }).version;
    } catch {
      // try next location
    }
  }
  return "0.0.0-dev";
}

export const CLI_VERSION: string =
  typeof __CLI_VERSION__ !== "undefined" ? __CLI_VERSION__ : devVersion();
