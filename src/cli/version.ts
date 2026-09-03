import { createRequire } from "node:module";

// Injected by tsup at build time (see tsup.config.ts). Dev (tsx) falls back to
// reading package.json from either src/ (dev) or dist/ (built) locations.
declare const __CLI_VERSION__: string | undefined;
declare const __DITTO_SDK_VERSION__: string | undefined;

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

// The SDK has no runtime version export, so read its package.json. The SDK is
// external in the bundle (native .node binaries), so node_modules is always
// present at runtime — this resolves in dev, built, and installed forms alike.
function devSdkVersion(): string {
  const req = createRequire(import.meta.url);
  try {
    return (req("@dittolive/ditto/package.json") as { version: string }).version;
  } catch {
    return "unknown";
  }
}

export const CLI_VERSION: string =
  typeof __CLI_VERSION__ !== "undefined" ? __CLI_VERSION__ : devVersion();

export const DITTO_SDK_VERSION: string =
  typeof __DITTO_SDK_VERSION__ !== "undefined" ? __DITTO_SDK_VERSION__ : devSdkVersion();
