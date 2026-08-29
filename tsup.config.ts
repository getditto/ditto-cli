import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as {
  version: string;
};

// `RELEASE=true npm run build` stamps a release build (env credentials ignored).
const release = process.env.RELEASE === "true";

export default defineConfig({
  entry: { cli: "src/cli/index.ts" },
  outDir: "dist",
  format: ["esm"],
  target: "node20",
  platform: "node",
  banner: {
    // Shebang must stay on line 1; the shim lets bundled CJS deps
    // (e.g. commander) call require() inside the ESM bundle.
    js: [
      "#!/usr/bin/env node",
      "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
    ].join("\n"),
  },
  // Bundle all JS deps; only the Ditto SDK stays external (native .node binaries).
  noExternal: ["commander", "chalk", "env-paths", "tar", "@inquirer/prompts"],
  external: ["@dittolive/ditto"],
  define: {
    __CLI_VERSION__: JSON.stringify(pkg.version),
    RELEASE: JSON.stringify(release ? "true" : "false"),
  },
  clean: true,
  sourcemap: false,
  minify: false,
});
